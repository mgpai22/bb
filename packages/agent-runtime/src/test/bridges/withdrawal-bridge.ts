import {
  BRIDGE_NOTIFICATION_METHODS,
  BRIDGE_REQUEST_METHODS,
  PROVIDER_BRIDGE_PROTOCOL_VERSION,
  threadStartParamsSchema,
  experimental_defineProviderBridge,
} from "@get-bb/plugin-sdk/provider-bridge";
import { z } from "zod";

export const WITHDRAWAL_UNHOSTED_THREAD_ID = "t-unhosted";

const inboundSchema = z.object({
  id: z.union([z.string(), z.number()]),
  method: z.string(),
  params: z.unknown(),
});

function writeMessage(message: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
}

/**
 * On thread/start: advertises commands for an unhosted and the hosted thread,
 * asks one approval, then withdraws it with notifications/cancelled.
 */
export function handleLine(line: string): void {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return;
  }
  const inbound = inboundSchema.safeParse(raw);
  if (!inbound.success) {
    return;
  }
  const { id, method, params } = inbound.data;

  if (method === BRIDGE_REQUEST_METHODS.initialize) {
    writeMessage({
      id,
      result: {
        protocolVersion: PROVIDER_BRIDGE_PROTOCOL_VERSION,
        capabilities: { grammarVersions: [2, 3] },
      },
    });
    return;
  }

  const threadStart = threadStartParamsSchema.safeParse(params);
  if (method !== BRIDGE_REQUEST_METHODS.threadStart || !threadStart.success) {
    writeMessage({ id, result: {} });
    return;
  }
  const { threadId } = threadStart.data;
  const providerThreadId = "prov-withdrawal";
  writeMessage({
    method: BRIDGE_NOTIFICATION_METHODS.threadIdentity,
    params: { threadId, providerThreadId },
  });
  writeMessage({ id, result: { providerThreadId } });
  for (const commandThreadId of [WITHDRAWAL_UNHOSTED_THREAD_ID, threadId]) {
    writeMessage({
      method: "thread/commands/updated",
      params: {
        threadId: commandThreadId,
        commands: [
          { name: "review", description: commandThreadId, argumentHint: null },
        ],
      },
    });
  }
  writeMessage({
    id: "withdrawn-request",
    method: "interaction/request",
    params: {
      providerThreadId,
      threadId,
      turnId: "turn-withdrawal",
      payload: {
        kind: "approval",
        subject: {
          kind: "command",
          itemId: "item-withdrawal",
          command: "git push",
          cwd: "/tmp/project",
          actions: [],
          sessionGrant: null,
        },
        reason: "Needs approval",
        availableDecisions: ["allow_once", "deny"],
      },
    },
  });
  writeMessage({
    method: "notifications/cancelled",
    params: { requestId: "withdrawn-request" },
  });
}

export const experimental_providerBridge = experimental_defineProviderBridge({
  handleLine,
});
