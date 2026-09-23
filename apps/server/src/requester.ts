import type { BbRequester } from "@get-bb/plugin-sdk";
import type { MiddlewareHandler } from "hono";
import { decode, verify } from "hono/jwt";
import { z } from "zod";
import { ApiError } from "./errors.js";
import type { ServerLogger } from "./types.js";

export interface RequesterConfig {
  /** Null when Access verification is off. */
  access: {
    aud: string;
    jwksUrl: string;
    teamDomain: string;
  } | null;
  /** Requester for a request with no JWT; null when unset. */
  loopbackIdentity: string | null;
}

interface RequesterContext {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

type AccessJwk = JsonWebKey & { kid: string };

const ACCESS_JWT_HEADER = "cf-access-jwt-assertion";
const JWKS_MAX_AGE_MS = 10 * 60_000;
/** A failed refresh keeps serving keys this young. */
const JWKS_STALE_MAX_AGE_MS = 60 * 60_000;
const JWKS_RETRY_MS = 30_000;
const JWKS_FETCH_TIMEOUT_MS = 5_000;
const CLOCK_SKEW_LEEWAY_SECONDS = 60;
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
/** WebSocket close code 1008: policy violation. */
const ACCESS_SESSION_CLOSE_CODE = 1008;

const bbRequesterSchema = z
  .object({
    email: z.string().min(1),
    source: z.enum(["access", "loopback"]),
  })
  .strict();

const jwksSchema = z.object({
  keys: z.array(z.object({ kid: z.string() }).passthrough()),
});

export function setBbRequester(
  context: RequesterContext,
  requester: BbRequester,
): void {
  context.set("bbRequester", requester);
}

export function getBbRequester(
  context: RequesterContext,
): BbRequester | undefined {
  const parsed = bbRequesterSchema.safeParse(context.get("bbRequester"));
  return parsed.success ? parsed.data : undefined;
}

export interface AccessSession {
  email: string;
  /** The Access JWT `exp`, in milliseconds. */
  expiresAt: number;
}

/** The verified Access session behind this request; null for loopback or none. */
export function getAccessSession(
  context: RequesterContext,
): AccessSession | null {
  const requester = getBbRequester(context);
  const expiresAt = context.get("bbAccessExpiresAt");
  return requester?.source === "access" && typeof expiresAt === "number"
    ? { email: requester.email, expiresAt }
    : null;
}

/** Hono's WSContext satisfies this. */
interface ClosableSocket {
  close(code?: number, reason?: string): void;
}

/**
 * Open /ws and /ws/* sockets by Access identity. Cloudflare's revoke blocks
 * new requests at the edge but leaves open tunnel sockets alone, so core
 * closes them: at the JWT `exp`, and on `closeSessions`.
 */
export interface AccessSessions {
  track(socket: ClosableSocket, session: AccessSession): void;
  untrack(socket: ClosableSocket): void;
  /** Closes every tracked socket of `email` (compared lowercased); returns the count. */
  closeSessions(email: string): number;
}

export function createAccessSessions(): AccessSessions {
  const sessions = new Map<
    ClosableSocket,
    { email: string; timer: ReturnType<typeof setTimeout> }
  >();

  function untrack(socket: ClosableSocket): void {
    const session = sessions.get(socket);
    if (session === undefined) return;
    clearTimeout(session.timer);
    sessions.delete(socket);
  }

  function close(socket: ClosableSocket): void {
    untrack(socket);
    socket.close(ACCESS_SESSION_CLOSE_CODE, "Cloudflare Access session ended");
  }

  function track(socket: ClosableSocket, session: AccessSession): void {
    untrack(socket);
    const delay = session.expiresAt - Date.now();
    // setTimeout fires at once past 2^31-1 ms, so a far exp re-arms.
    const timer = setTimeout(
      () =>
        Date.now() >= session.expiresAt ? close(socket) : track(socket, session),
      Math.min(Math.max(delay, 0), MAX_TIMER_DELAY_MS),
    );
    timer.unref();
    sessions.set(socket, { email: session.email, timer });
  }

  return {
    track,
    untrack,
    closeSessions(email) {
      const target = email.toLowerCase();
      const matches = [...sessions]
        .filter(([, session]) => session.email === target)
        .map(([socket]) => socket);
      for (const socket of matches) close(socket);
      return matches.length;
    },
  };
}

function invalidAccessJwt(): ApiError {
  return new ApiError(
    401,
    "access_jwt_invalid",
    "Cloudflare Access token is invalid",
  );
}

/**
 * Reads the Access keys at most every 10 minutes, and again on an unknown
 * `kid` at most once per 30 seconds. A failed refresh keeps serving keys
 * younger than 1 hour and retries 30 seconds later. With no usable keys a
 * failed fetch is a 503: the server cannot tell an Access user from a forgery.
 */
function createJwksCache(url: string, logger: ServerLogger) {
  let keys: AccessJwk[] | null = null;
  let fetchedAt = 0;
  let attemptedAt = 0;
  let pending: Promise<AccessJwk[]> | null = null;

  async function fetchKeys(): Promise<AccessJwk[]> {
    attemptedAt = Date.now();
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(JWKS_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`JWKS fetch returned ${response.status}`);
      }
      const body = jwksSchema.parse(await response.json());
      keys = body.keys as AccessJwk[];
      fetchedAt = Date.now();
      return keys;
    } catch (error) {
      logger.warn({ err: error, url }, "Cloudflare Access keys are unavailable");
      if (keys !== null && Date.now() - fetchedAt < JWKS_STALE_MAX_AGE_MS) {
        return keys;
      }
      throw new ApiError(
        503,
        "access_jwks_unavailable",
        "Cloudflare Access keys are unavailable",
      );
    } finally {
      pending = null;
    }
  }

  return async function keyFor(kid: string): Promise<AccessJwk | undefined> {
    const age = Date.now() - fetchedAt;
    const mustFetch =
      keys === null ||
      age >= JWKS_STALE_MAX_AGE_MS ||
      (age >= JWKS_MAX_AGE_MS && Date.now() - attemptedAt >= JWKS_RETRY_MS);
    let current =
      mustFetch || keys === null ? await (pending ??= fetchKeys()) : keys;
    let key = current.find((candidate) => candidate.kid === kid);
    if (key === undefined && Date.now() - attemptedAt >= JWKS_RETRY_MS) {
      current = await (pending ??= fetchKeys());
      key = current.find((candidate) => candidate.kid === kid);
    }
    return key;
  };
}

/**
 * Sets `bbRequester` on /api/v1, /ws, and /ws/* requests. Reads only the
 * `Cf-Access-Jwt-Assertion` header: no other identity header or cookie is
 * trusted, because any local process can send one to the loopback port.
 */
export function requesterMiddleware(
  config: RequesterConfig | undefined,
  logger: ServerLogger,
): MiddlewareHandler {
  const access = config?.access ?? null;
  const loopback: BbRequester | null =
    config?.loopbackIdentity == null
      ? null
      : Object.freeze({ email: config.loopbackIdentity, source: "loopback" });
  const keyFor = access === null ? null : createJwksCache(access.jwksUrl, logger);

  return async (context, next) => {
    const path = context.req.path;
    const covered =
      path === "/api/v1" ||
      path.startsWith("/api/v1/") ||
      path === "/ws" ||
      path.startsWith("/ws/");
    if (!covered) return next();

    const token = context.req.header(ACCESS_JWT_HEADER);
    if (access === null || keyFor === null || token === undefined) {
      if (loopback !== null) setBbRequester(context, loopback);
      return next();
    }

    let kid: unknown;
    try {
      kid = decode(token).header.kid;
    } catch {
      throw invalidAccessJwt();
    }
    if (typeof kid !== "string") throw invalidAccessJwt();
    const key = await keyFor(kid);
    if (key === undefined) throw invalidAccessJwt();
    // Time claims are checked here, not by hono, for the skew leeway and
    // because hono skips a missing or zero exp.
    const payload = await verify(token, key, {
      alg: "RS256",
      iss: `https://${access.teamDomain}`,
      aud: access.aud,
      exp: false,
      iat: false,
      nbf: false,
    }).catch(() => {
      throw invalidAccessJwt();
    });
    const now = Date.now() / 1000;
    const latestStart = now + CLOCK_SKEW_LEEWAY_SECONDS;
    if (
      typeof payload.exp !== "number" ||
      payload.exp <= now ||
      (payload.nbf !== undefined &&
        (typeof payload.nbf !== "number" || payload.nbf > latestStart)) ||
      (payload.iat !== undefined &&
        (typeof payload.iat !== "number" || payload.iat > latestStart))
    ) {
      throw invalidAccessJwt();
    }
    const email = payload.email;
    if (typeof email !== "string" || email.length === 0) {
      throw invalidAccessJwt();
    }
    setBbRequester(
      context,
      Object.freeze({ email: email.toLowerCase(), source: "access" }),
    );
    context.set("bbAccessExpiresAt", payload.exp * 1000);
    return next();
  };
}
