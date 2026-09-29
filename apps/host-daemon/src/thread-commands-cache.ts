import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  hostProviderCommandSchema,
  type HostProviderCommand,
} from "@bb/host-daemon-contract";
import type { ThreadCommand } from "@bb/provider-bridge-protocol";
import { isFsErrorWithCode } from "./fs-errors.js";
import { requireContainedPath } from "./command-handlers/prompt-attachments.js";

const MAX_CACHE_FILE_BYTES = 256 * 1024;
const MAX_CACHED_COMMANDS = 200;
// Bound each entry so 200 of them fit under MAX_CACHE_FILE_BYTES even at three
// UTF-8 bytes per character. The serialized size check at write time covers
// the remaining case, very long names.
const MAX_DESCRIPTION_CHARS = 256;
const MAX_ARGUMENT_HINT_CHARS = 64;
const advertisedThreadCommandsFileSchema = z
  .object({
    commands: z.array(hostProviderCommandSchema),
  })
  .passthrough();

interface ThreadCommandsCacheArgs {
  dataDir: string;
  threadId: string;
}

function advertisedCommandsFilePath(args: ThreadCommandsCacheArgs): string {
  const root = path.join(args.dataDir, "thread-commands");
  return requireContainedPath(
    root,
    path.join(root, `${args.threadId}.json`),
    "Advertised commands path escapes the thread commands cache",
  );
}

export function hostThreadCommands(
  commands: readonly ThreadCommand[],
): HostProviderCommand[] {
  return commands.slice(0, MAX_CACHED_COMMANDS).map((command) => ({
    name: command.name,
    source: "command",
    origin: "project",
    description: command.description?.slice(0, MAX_DESCRIPTION_CHARS) ?? null,
    argumentHint:
      command.argumentHint?.slice(0, MAX_ARGUMENT_HINT_CHARS) ?? null,
  }));
}

export async function readAdvertisedThreadCommands(
  args: ThreadCommandsCacheArgs,
): Promise<HostProviderCommand[] | null> {
  let filePath: string;
  try {
    filePath = advertisedCommandsFilePath(args);
  } catch {
    return null;
  }
  let raw: string;
  try {
    const handle = await fs.open(filePath, "r");
    try {
      if ((await handle.stat()).size > MAX_CACHE_FILE_BYTES) {
        return null;
      }
      raw = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isFsErrorWithCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  const validated = advertisedThreadCommandsFileSchema.safeParse(parsed);
  if (!validated.success) {
    return null;
  }
  return validated.data.commands.slice(0, MAX_CACHED_COMMANDS);
}

export async function writeAdvertisedThreadCommands(
  args: ThreadCommandsCacheArgs & { commands: readonly ThreadCommand[] },
): Promise<void> {
  const filePath = advertisedCommandsFilePath(args);
  const contents = JSON.stringify({
    commands: hostThreadCommands(args.commands),
  });
  if (Buffer.byteLength(contents, "utf8") > MAX_CACHE_FILE_BYTES) {
    throw new Error(
      `Advertised commands exceed the ${MAX_CACHE_FILE_BYTES}-byte cache limit`,
    );
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, contents, "utf8");
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

export async function deleteAdvertisedThreadCommands(
  args: ThreadCommandsCacheArgs,
): Promise<void> {
  await fs.rm(advertisedCommandsFilePath(args), { force: true });
}
