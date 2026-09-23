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
const JWKS_UNKNOWN_KID_REFETCH_MS = 30_000;
const JWKS_FETCH_TIMEOUT_MS = 5_000;

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

function invalidAccessJwt(): ApiError {
  return new ApiError(
    401,
    "access_jwt_invalid",
    "Cloudflare Access token is invalid",
  );
}

/**
 * Reads the Access keys at most every 10 minutes, and again on an unknown
 * `kid` at most once per 30 seconds. A failed fetch is a 503: without keys
 * the server cannot tell an Access user from a forgery.
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
    let current =
      keys !== null && Date.now() - fetchedAt < JWKS_MAX_AGE_MS
        ? keys
        : await (pending ??= fetchKeys());
    let key = current.find((candidate) => candidate.kid === kid);
    if (
      key === undefined &&
      Date.now() - attemptedAt >= JWKS_UNKNOWN_KID_REFETCH_MS
    ) {
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
    const payload = await verify(token, key, {
      alg: "RS256",
      iss: `https://${access.teamDomain}`,
      aud: access.aud,
    }).catch(() => {
      throw invalidAccessJwt();
    });
    // hono's verify skips a missing exp; an Access token always carries one.
    if (typeof payload.exp !== "number") throw invalidAccessJwt();
    const email = payload.email;
    if (typeof email !== "string" || email.length === 0) {
      throw invalidAccessJwt();
    }
    setBbRequester(
      context,
      Object.freeze({ email: email.toLowerCase(), source: "access" }),
    );
    return next();
  };
}
