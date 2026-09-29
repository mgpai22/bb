import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  hostProviderCommandSchema,
  type HostProviderCommand,
} from "@bb/host-daemon-contract";
import { isFsErrorWithCode } from "./fs-errors.js";
import { requireContainedPath } from "./command-handlers/prompt-attachments.js";
const ADVERTISED_COMMANDS_FILE_NAME = "advertised-commands.json";
const advertisedThreadCommandsFileSchema = z
  .object({
    commands: z.array(hostProviderCommandSchema),
  })
  .passthrough();

function advertisedCommandsFilePath(
  threadStorageRootPath: string,
  threadId: string,
): string {
  const threadDir = requireContainedPath(
    threadStorageRootPath,
    path.join(threadStorageRootPath, threadId),
    "Advertised commands path escapes the thread storage root",
  );
  return requireContainedPath(
    threadStorageRootPath,
    path.join(threadDir, ADVERTISED_COMMANDS_FILE_NAME),
    "Advertised commands path escapes the thread storage root",
  );
}

export async function readAdvertisedThreadCommands(args: {
  threadStorageRootPath: string;
  threadId: string;
}): Promise<HostProviderCommand[] | null> {
  let filePath: string;
  try {
    filePath = advertisedCommandsFilePath(
      args.threadStorageRootPath,
      args.threadId,
    );
  } catch {
    return null;
  }
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
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
  const validated =
    advertisedThreadCommandsFileSchema.safeParse(parsed);
  if (!validated.success) {
    return null;
  }
  return validated.data.commands;
}

export async function writeAdvertisedThreadCommands(args: {
  threadStorageRootPath: string;
  threadId: string;
  commands: readonly HostProviderCommand[];
}): Promise<void> {
  const filePath = advertisedCommandsFilePath(
    args.threadStorageRootPath,
    args.threadId,
  );
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(
      temporaryPath,
      JSON.stringify({ commands: [...args.commands] }),
      "utf8",
    );
    await fs.rename(temporaryPath, filePath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}
