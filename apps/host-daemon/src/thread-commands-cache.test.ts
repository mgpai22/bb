import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ThreadCommand } from "@bb/provider-bridge-protocol";
import {
  deleteAdvertisedThreadCommands,
  readAdvertisedThreadCommands,
  writeAdvertisedThreadCommands,
} from "./thread-commands-cache.js";

const tempDirs: string[] = [];

async function makeDataDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bb-thread-commands-"));
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
  overrides: Partial<ThreadCommand> = {},
): ThreadCommand {
  return {
    name,
    description: overrides.description ?? null,
    argumentHint: overrides.argumentHint ?? null,
  };
}

function hostCommand(entry: ThreadCommand) {
  return { ...entry, source: "command", origin: "project" };
}

async function writeRawCacheFile(
  dataDir: string,
  threadId: string,
  contents: string,
): Promise<void> {
  await fs.mkdir(path.join(dataDir, "thread-commands"), { recursive: true });
  await fs.writeFile(
    path.join(dataDir, "thread-commands", `${threadId}.json`),
    contents,
    "utf8",
  );
}

describe("advertised thread commands cache", () => {
  it("reports a miss when nothing was persisted", async () => {
    const dataDir = await makeDataDir();

    await expect(
      readAdvertisedThreadCommands({ dataDir, threadId: "thr_missing" }),
    ).resolves.toBeNull();
  });

  it("round-trips a persisted command set outside thread storage", async () => {
    const dataDir = await makeDataDir();
    const commands = [
      command("ui-check", {
        description: "Run UI verification checks",
        argumentHint: "<fixture>",
      }),
      command("jobs", { description: "List background jobs" }),
    ];

    await writeAdvertisedThreadCommands({
      dataDir,
      threadId: "thr_1",
      commands,
    });

    await expect(
      readAdvertisedThreadCommands({ dataDir, threadId: "thr_1" }),
    ).resolves.toEqual(commands.map(hostCommand));
    await expect(
      fs.readdir(path.join(dataDir, "thread-commands")),
    ).resolves.toEqual(["thr_1.json"]);
  });

  it("round-trips an advertised empty set as a hit", async () => {
    const dataDir = await makeDataDir();

    await writeAdvertisedThreadCommands({
      dataDir,
      threadId: "thr_1",
      commands: [],
    });

    await expect(
      readAdvertisedThreadCommands({ dataDir, threadId: "thr_1" }),
    ).resolves.toEqual([]);
  });

  it("replaces a stale set on refresh", async () => {
    const args = { dataDir: await makeDataDir(), threadId: "thr_1" };

    await writeAdvertisedThreadCommands({
      ...args,
      commands: [command("old")],
    });
    await writeAdvertisedThreadCommands({
      ...args,
      commands: [command("new")],
    });

    await expect(readAdvertisedThreadCommands(args)).resolves.toEqual([
      hostCommand(command("new")),
    ]);
  });

  it("scopes persisted sets per thread and deletes one thread's set", async () => {
    const dataDir = await makeDataDir();
    await writeAdvertisedThreadCommands({
      dataDir,
      threadId: "thr_1",
      commands: [command("ui-check")],
    });
    await writeAdvertisedThreadCommands({
      dataDir,
      threadId: "thr_2",
      commands: [command("jobs")],
    });

    await deleteAdvertisedThreadCommands({ dataDir, threadId: "thr_1" });

    await expect(
      readAdvertisedThreadCommands({ dataDir, threadId: "thr_1" }),
    ).resolves.toBeNull();
    await expect(
      readAdvertisedThreadCommands({ dataDir, threadId: "thr_2" }),
    ).resolves.toEqual([hostCommand(command("jobs"))]);
  });

  it("round-trips 200 commands with long descriptions within the read cap", async () => {
    const args = { dataDir: await makeDataDir(), threadId: "thr_1" };
    const commands = Array.from({ length: 200 }, (_, index) =>
      command(`skill:long-${index}`, {
        description: "語".repeat(2000),
        argumentHint: "語".repeat(600),
      }),
    );

    await writeAdvertisedThreadCommands({ ...args, commands });

    const cached = await readAdvertisedThreadCommands(args);
    expect(cached).toHaveLength(200);
    expect(cached?.[199]).toEqual({
      name: "skill:long-199",
      source: "command",
      origin: "project",
      description: "語".repeat(256),
      argumentHint: "語".repeat(64),
    });
  });

  it("drops the stale list when a write would exceed the read cap", async () => {
    const args = { dataDir: await makeDataDir(), threadId: "thr_1" };
    await writeAdvertisedThreadCommands({
      ...args,
      commands: [command("old")],
    });

    await expect(
      writeAdvertisedThreadCommands({
        ...args,
        commands: Array.from({ length: 200 }, (_, index) =>
          command(`${"n".repeat(2000)}-${index}`),
        ),
      }),
    ).rejects.toThrow(/exceed/);
    await expect(readAdvertisedThreadCommands(args)).resolves.toBeNull();
  });

  it("treats corrupt, schema-violating, and oversized files as a miss", async () => {
    const dataDir = await makeDataDir();
    await writeRawCacheFile(dataDir, "corrupt", "{not json");
    await writeRawCacheFile(
      dataDir,
      "invalid",
      JSON.stringify({ commands: [{ description: "Missing name" }] }),
    );
    await writeRawCacheFile(
      dataDir,
      "oversized",
      JSON.stringify({
        commands: [
          hostCommand(command("big", { description: "x".repeat(300_000) })),
        ],
      }),
    );

    for (const threadId of ["corrupt", "invalid", "oversized"]) {
      await expect(
        readAdvertisedThreadCommands({ dataDir, threadId }),
      ).resolves.toBeNull();
    }
  });

  it("caps the number of commands read from disk", async () => {
    const dataDir = await makeDataDir();
    await writeRawCacheFile(
      dataDir,
      "thr_1",
      JSON.stringify({
        commands: Array.from({ length: 250 }, (_, index) =>
          hostCommand(command(`c${index}`)),
        ),
      }),
    );

    const cached = await readAdvertisedThreadCommands({
      dataDir,
      threadId: "thr_1",
    });
    expect(cached).toHaveLength(200);
    expect(cached?.[0]?.name).toBe("c0");
  });

  it("rejects thread ids that escape the cache directory", async () => {
    const dataDir = await makeDataDir();

    await expect(
      readAdvertisedThreadCommands({ dataDir, threadId: "../escape" }),
    ).resolves.toBeNull();
    await expect(
      writeAdvertisedThreadCommands({
        dataDir,
        threadId: "../escape",
        commands: [],
      }),
    ).rejects.toThrow();
  });
});
