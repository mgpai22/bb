import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HostProviderCommand } from "@bb/host-daemon-contract";
import {
  readAdvertisedThreadCommands,
  writeAdvertisedThreadCommands,
} from "./thread-commands-cache.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await fs.rm(dir, { force: true, recursive: true });
    }),
  );
});

function command(
  name: string,
  overrides: Partial<HostProviderCommand> = {},
): HostProviderCommand {
  return {
    name,
    source: "command",
    origin: "project",
    description: overrides.description ?? null,
    argumentHint: overrides.argumentHint ?? null,
  };
}

describe("advertised thread commands cache", () => {
  it("reports a miss when nothing was persisted", async () => {
    const root = path.join(
      await makeTempDir("bb-thread-commands-cache-"),
      "thread-storage",
    );

    await expect(
      readAdvertisedThreadCommands({
        threadStorageRootPath: root,
        threadId: "thr_missing",
      }),
    ).resolves.toBeNull();
  });

  it("round-trips a persisted command set", async () => {
    const root = path.join(
      await makeTempDir("bb-thread-commands-cache-"),
      "thread-storage",
    );
    const commands = [
      command("ui-check", {
        description: "Run UI verification checks",
        argumentHint: "<fixture>",
      }),
      command("jobs", { description: "List background jobs" }),
    ];

    await writeAdvertisedThreadCommands({
      threadStorageRootPath: root,
      threadId: "thr_1",
      commands,
    });

    await expect(
      readAdvertisedThreadCommands({
        threadStorageRootPath: root,
        threadId: "thr_1",
      }),
    ).resolves.toEqual(commands);
  });

  it("round-trips an advertised empty set as a hit", async () => {
    const root = path.join(
      await makeTempDir("bb-thread-commands-cache-"),
      "thread-storage",
    );

    await writeAdvertisedThreadCommands({
      threadStorageRootPath: root,
      threadId: "thr_1",
      commands: [],
    });

    await expect(
      readAdvertisedThreadCommands({
        threadStorageRootPath: root,
        threadId: "thr_1",
      }),
    ).resolves.toEqual([]);
  });

  it("replaces a stale set on refresh", async () => {
    const root = path.join(
      await makeTempDir("bb-thread-commands-cache-"),
      "thread-storage",
    );
    const args = {
      threadStorageRootPath: root,
      threadId: "thr_1",
    };

    await writeAdvertisedThreadCommands({ ...args, commands: [command("old")] });
    await writeAdvertisedThreadCommands({ ...args, commands: [command("new")] });

    await expect(readAdvertisedThreadCommands(args)).resolves.toEqual([
      command("new"),
    ]);
  });

  it("scopes persisted sets per thread", async () => {
    const root = path.join(
      await makeTempDir("bb-thread-commands-cache-"),
      "thread-storage",
    );

    await writeAdvertisedThreadCommands({
      threadStorageRootPath: root,
      threadId: "thr_1",
      commands: [command("ui-check")],
    });

    await expect(
      readAdvertisedThreadCommands({
        threadStorageRootPath: root,
        threadId: "thr_2",
      }),
    ).resolves.toBeNull();
  });

  it("treats a corrupt file as a miss", async () => {
    const root = path.join(
      await makeTempDir("bb-thread-commands-cache-"),
      "thread-storage",
    );
    await writeAdvertisedThreadCommands({
      threadStorageRootPath: root,
      threadId: "thr_1",
      commands: [command("ui-check")],
    });
    await fs.writeFile(
      path.join(root, "thr_1", "advertised-commands.json"),
      "{not json",
      "utf8",
    );

    await expect(
      readAdvertisedThreadCommands({
        threadStorageRootPath: root,
        threadId: "thr_1",
      }),
    ).resolves.toBeNull();
  });

  it("treats a schema-violating file as a miss", async () => {
    const root = path.join(
      await makeTempDir("bb-thread-commands-cache-"),
      "thread-storage",
    );
    await fs.mkdir(path.join(root, "thr_1"), { recursive: true });
    await fs.writeFile(
      path.join(root, "thr_1", "advertised-commands.json"),
      JSON.stringify({ commands: [{ description: "Missing name" }] }),
      "utf8",
    );

    await expect(
      readAdvertisedThreadCommands({
        threadStorageRootPath: root,
        threadId: "thr_1",
      }),
    ).resolves.toBeNull();
  });

  it("rejects thread ids that escape the storage root", async () => {
    const root = path.join(
      await makeTempDir("bb-thread-commands-cache-"),
      "thread-storage",
    );

    await expect(
      readAdvertisedThreadCommands({
        threadStorageRootPath: root,
        threadId: "../escape",
      }),
    ).resolves.toBeNull();
    await expect(
      writeAdvertisedThreadCommands({
        threadStorageRootPath: root,
        threadId: "../escape",
        commands: [],
      }),
    ).rejects.toThrow();
  });
});
