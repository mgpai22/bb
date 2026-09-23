import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createDeferredPromise } from "@bb/test-helpers";
import { sign } from "hono/jwt";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import WebSocket from "ws";
import type { RequesterConfig } from "../../src/requester.js";
import { runQueuedMessageDispatch } from "../../src/services/threads/queued-message-dispatch.js";
import { textInput } from "../helpers/prompt-input.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
  seedThreadRuntimeState,
} from "../helpers/seed.js";
import {
  startTestServer,
  type RunningTestServer,
} from "../helpers/test-app.js";

const TEAM_DOMAIN = "team.example.cloudflareaccess.com";
const AUD = "a".repeat(64);
const LOOPBACK = "avi@example.com";
const KID = "test-key";
const WORKSPACE_PATH = "/tmp/access-requester-project";

interface HookSeen {
  requester: unknown;
  queued: boolean;
}

declare global {
  var __requesterHookSeen: HookSeen[] | undefined;
}

const PLUGIN_SOURCE = `
  import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
  import { z } from "zod";
  const contract = defineRpcContract({
    whoami: { input: z.null(), output: z.unknown() },
    closeSessions: {
      input: z.object({ email: z.string() }),
      output: z.object({ closed: z.number() }),
    },
  });
  const seen = globalThis as { __requesterHookSeen?: unknown[] };
  export default function plugin(bb: BbPluginApi) {
    bb.http.route("GET", "/whoami", (c) =>
      c.json({ requester: c.get("bbRequester") ?? null }));
    bb.rpc.register(contract, {
      whoami: (_input, context) => context.experimental_requester,
      closeSessions: ({ email }) => bb.experimental_access.closeSessions(email),
    });
    bb.experimental_hooks.on("message.dispatch", (context) => {
      (seen.__requesterHookSeen ??= []).push({
        requester: context.experimental_requester,
        queued: context.queuedMessage !== null,
      });
      return context.queuedMessage === null && context.input.text === "hold"
        ? { action: "wait", reason: "hold" }
        : { action: "proceed" };
    });
  }
`;

function rsaJwks(kid: string) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  return {
    privateJwk: { ...privateKey.export({ format: "jwk" }), alg: "RS256", kid },
    publicJwk: {
      ...publicKey.export({ format: "jwk" }),
      alg: "RS256",
      kid,
      use: "sig",
    },
  };
}

const trusted = rsaJwks(KID);
// Same kid, different key: a forged token that names a trusted key id.
const forger = rsaJwks(KID);

let jwksServer: http.Server;
let jwksUrl: string;
let jwksStatus = 200;

beforeAll(async () => {
  jwksServer = http.createServer((_request, response) => {
    response.statusCode = jwksStatus;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ keys: [trusted.publicJwk] }));
  });
  const listening = createDeferredPromise<void>();
  jwksServer.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const { port } = jwksServer.address() as AddressInfo;
  jwksUrl = `http://127.0.0.1:${port}/cdn-cgi/access/certs`;
});

afterAll(async () => {
  const closed = createDeferredPromise<void>();
  jwksServer.close(() => closed.resolve());
  await closed.promise;
});

let server: RunningTestServer | null = null;

afterEach(async () => {
  await server?.pluginService.stop();
  await server?.close();
  server = null;
  delete globalThis.__requesterHookSeen;
  jwksStatus = 200;
  vi.useRealTimers();
});

function accessConfig(overrides: { jwksUrl?: string } = {}): RequesterConfig {
  return {
    access: {
      aud: AUD,
      jwksUrl: overrides.jwksUrl ?? jwksUrl,
      teamDomain: TEAM_DOMAIN,
    },
    loopbackIdentity: LOOPBACK,
  };
}

async function startWithPlugin(
  requester: RequesterConfig,
): Promise<RunningTestServer> {
  const running = await startTestServer({ requester });
  server = running;
  const rootDir = join(running.config.dataDir, "fixtures", "requester");
  await mkdir(rootDir, { recursive: true });
  await writeFile(
    join(rootDir, "package.json"),
    JSON.stringify({
      name: "bb-plugin-requester",
      version: "0.1.0",
      bb: {
        name: "Requester fixture",
        description: "Requester fixture.",
        branding: { icon: "Zap" },
        server: "./server.ts",
      },
    }),
  );
  await writeFile(join(rootDir, "server.ts"), PLUGIN_SOURCE);
  const entry = await running.pluginService.installPath(rootDir);
  expect(entry.status).toBe("running");
  return running;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function accessJwt(
  overrides: Record<string, unknown> = {},
  key: object = trusted.privateJwk,
): Promise<string> {
  return sign(
    {
      aud: [AUD],
      email: "Colleague@Example.com",
      exp: nowSeconds() + 300,
      iat: nowSeconds() - 5,
      iss: `https://${TEAM_DOMAIN}`,
      sub: randomUUID(),
      ...overrides,
    },
    key as Parameters<typeof sign>[1],
  );
}

function jwtHeader(token: string): Record<string, string> {
  return { "cf-access-jwt-assertion": token };
}

async function whoami(
  running: RunningTestServer,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(
    `${running.baseUrl}/api/v1/plugins/requester/http/whoami`,
    { headers },
  );
  return { status: response.status, body: await response.json() };
}

function wsUpgrade(
  running: RunningTestServer,
  headers: Record<string, string>,
): Promise<number | "open"> {
  const { promise, resolve, reject } = createDeferredPromise<number | "open">();
  const socket = new WebSocket(`${running.baseUrl.replace("http", "ws")}/ws`, {
    headers,
  });
  socket.once("open", () => {
    socket.close();
    resolve("open");
  });
  socket.once("unexpected-response", (request, response) => {
    resolve(response.statusCode ?? 0);
    request.destroy();
  });
  socket.once("error", reject);
  return promise;
}

function openWs(
  running: RunningTestServer,
  headers: Record<string, string>,
): Promise<WebSocket> {
  const { promise, resolve, reject } = createDeferredPromise<WebSocket>();
  const socket = new WebSocket(`${running.baseUrl.replace("http", "ws")}/ws`, {
    headers,
  });
  socket.once("open", () => resolve(socket));
  socket.once("error", reject);
  return promise;
}

function closeCode(socket: WebSocket): Promise<number> {
  const { promise, resolve } = createDeferredPromise<number>();
  socket.once("close", (code) => resolve(code));
  return promise;
}

async function createThreadAs(
  running: RunningTestServer,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<number> {
  const { host } = seedHostSession(running.deps, { id: `host-${randomUUID()}` });
  const { project } = seedProjectWithSource(running.deps, {
    hostId: host.id,
    path: WORKSPACE_PATH,
  });
  const response = await fetch(`${running.baseUrl}/api/v1/threads`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      environment: {
        type: "host",
        hostId: host.id,
        workspace: { type: "unmanaged", path: WORKSPACE_PATH },
      },
      input: textInput("create"),
      projectId: project.id,
      providerId: "codex",
      ...body,
    }),
  });
  return response.status;
}

describe("Cloudflare Access requester", () => {
  it("maps a valid Access JWT to the lowercased email on /api/v1 and allows /ws", async () => {
    const running = await startWithPlugin(accessConfig());
    const token = await accessJwt();

    expect(await whoami(running, jwtHeader(token))).toEqual({
      status: 200,
      body: {
        requester: { email: "colleague@example.com", source: "access" },
      },
    });
    expect(await wsUpgrade(running, jwtHeader(token))).toBe("open");
  });

  it.each([
    ["a bad signature", () => accessJwt({}, forger.privateJwk)],
    ["a wrong AUD", () => accessJwt({ aud: ["b".repeat(64)] })],
    ["an expired token", () => accessJwt({ exp: nowSeconds() - 60 })],
    ["a wrong issuer", () => accessJwt({ iss: "https://evil.example" })],
    ["no email claim", () => accessJwt({ email: undefined })],
    ["a malformed token", async () => "not.a.jwt"],
    ["exp 0", () => accessJwt({ exp: 0 })],
    ["iat 120 s in the future", () => accessJwt({ iat: nowSeconds() + 120 })],
    ["nbf 120 s in the future", () => accessJwt({ nbf: nowSeconds() + 120 })],
  ])("rejects %s with 401 on /api/v1 and /ws", async (_name, makeToken) => {
    const running = await startWithPlugin(accessConfig());
    const token = await makeToken();

    const response = await whoami(running, jwtHeader(token));
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: "access_jwt_invalid" });
    expect(await wsUpgrade(running, jwtHeader(token))).toBe(401);
  });

  it("accepts iat and nbf 30 s in the future (clock skew)", async () => {
    const running = await startWithPlugin(accessConfig());
    const token = await accessJwt({
      iat: nowSeconds() + 30,
      nbf: nowSeconds() + 30,
    });

    expect((await whoami(running, jwtHeader(token))).status).toBe(200);
  });

  it("keeps serving cached keys under 1 hour old when a refresh fails", async () => {
    const running = await startWithPlugin(accessConfig());
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    expect((await whoami(running, jwtHeader(await accessJwt()))).status).toBe(200);

    jwksStatus = 500;
    vi.setSystemTime(start + 11 * 60_000);
    expect((await whoami(running, jwtHeader(await accessJwt()))).status).toBe(200);

    vi.setSystemTime(start + 61 * 60_000);
    const stale = await whoami(running, jwtHeader(await accessJwt()));
    expect(stale.status).toBe(503);
    expect(stale.body).toMatchObject({ code: "access_jwks_unavailable" });
  });

  it("never trusts a forged Cf-Access-Authenticated-User-Email header", async () => {
    const running = await startWithPlugin(accessConfig());

    expect(
      await whoami(running, {
        "cf-access-authenticated-user-email": "mallory@example.com",
      }),
    ).toEqual({
      status: 200,
      body: { requester: { email: LOOPBACK, source: "loopback" } },
    });
  });

  it("ignores the JWT header when the check is off", async () => {
    const running = await startWithPlugin({
      access: null,
      loopbackIdentity: LOOPBACK,
    });

    expect(await whoami(running, jwtHeader("not.a.jwt"))).toEqual({
      status: 200,
      body: { requester: { email: LOOPBACK, source: "loopback" } },
    });
  });

  it("answers 503 when the Access keys cannot be fetched", async () => {
    const running = await startWithPlugin(
      accessConfig({ jwksUrl: "http://127.0.0.1:1/certs" }),
    );

    const response = await whoami(running, jwtHeader(await accessJwt()));
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ code: "access_jwks_unavailable" });
  });

  it("passes the requester to a plugin RPC handler", async () => {
    const running = await startWithPlugin(accessConfig());

    const response = await fetch(
      `${running.baseUrl}/api/v1/plugins/requester/rpc/whoami`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...jwtHeader(await accessJwt()),
        },
        body: "null",
      },
    );
    expect(await response.json()).toEqual({
      ok: true,
      result: { email: "colleague@example.com", source: "access" },
    });
  });

  it("reaches message.dispatch on create and send, and is null on a queue drain", async () => {
    const running = await startWithPlugin(accessConfig());
    const { host } = seedHostSession(running.deps, { id: "host-requester" });
    const { project } = seedProjectWithSource(running.deps, {
      hostId: host.id,
      path: WORKSPACE_PATH,
    });
    const environment = seedEnvironment(running.deps, {
      hostId: host.id,
      projectId: project.id,
      path: WORKSPACE_PATH,
    });
    const token = await accessJwt();
    const access = { email: "colleague@example.com", source: "access" };

    const created = await fetch(`${running.baseUrl}/api/v1/threads`, {
      method: "POST",
      headers: { "content-type": "application/json", ...jwtHeader(token) },
      body: JSON.stringify({
        environment: {
          type: "host",
          hostId: host.id,
          workspace: { type: "unmanaged", path: WORKSPACE_PATH },
        },
        input: textInput("create"),
        origin: "app",
        projectId: project.id,
        providerId: "codex",
      }),
    });
    expect(created.status).toBe(201);
    expect(globalThis.__requesterHookSeen).toEqual([
      { requester: access, queued: false },
    ]);

    const thread = seedThread(running.deps, {
      environmentId: environment.id,
      projectId: project.id,
      status: "idle",
    });
    seedThreadRuntimeState(running.deps, {
      environmentId: environment.id,
      providerThreadId: "provider-requester",
      threadId: thread.id,
    });
    const sent = await fetch(
      `${running.baseUrl}/api/v1/threads/${thread.id}/send`,
      {
        method: "POST",
        headers: { "content-type": "application/json", ...jwtHeader(token) },
        body: JSON.stringify({ input: textInput("hold"), mode: "auto" }),
      },
    );
    expect(await sent.json()).toMatchObject({ delivery: "queued" });

    await runQueuedMessageDispatch(running.deps, { kind: "plugin-recheck" });

    expect(globalThis.__requesterHookSeen).toEqual([
      { requester: access, queued: false },
      { requester: access, queued: false },
      { requester: null, queued: true },
    ]);
  });

  it("keeps an access requester on a create with origin plugin, and drops a loopback one", async () => {
    const running = await startWithPlugin(accessConfig());
    const pluginOrigin = { origin: "plugin", originPluginId: "requester" };

    expect(
      await createThreadAs(running, jwtHeader(await accessJwt()), pluginOrigin),
    ).toBe(201);
    expect(await createThreadAs(running, {}, pluginOrigin)).toBe(201);

    expect(globalThis.__requesterHookSeen).toEqual([
      {
        requester: { email: "colleague@example.com", source: "access" },
        queued: false,
      },
      { requester: null, queued: false },
    ]);
  });

  it("closeSessions closes that email's /ws socket and leaves another's open", async () => {
    const running = await startWithPlugin(accessConfig());
    const alice = await openWs(
      running,
      jwtHeader(await accessJwt({ email: "alice@example.com" })),
    );
    const bob = await openWs(
      running,
      jwtHeader(await accessJwt({ email: "bob@example.com" })),
    );
    const aliceClosed = closeCode(alice);

    const response = await fetch(
      `${running.baseUrl}/api/v1/plugins/requester/rpc/closeSessions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "Alice@Example.com" }),
      },
    );
    expect(await response.json()).toEqual({ ok: true, result: { closed: 1 } });
    expect(await aliceClosed).toBe(1008);
    expect(bob.readyState).toBe(WebSocket.OPEN);
    bob.close();
  });

  it("closes a /ws socket when its JWT exp passes", async () => {
    const running = await startWithPlugin(accessConfig());
    const socket = await openWs(
      running,
      jwtHeader(await accessJwt({ exp: nowSeconds() + 2 })),
    );
    const openedAt = Date.now();

    expect(await closeCode(socket)).toBe(1008);
    expect(Date.now() - openedAt).toBeLessThan(4_000);
  });
});
