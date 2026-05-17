import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listSharedMemory, readSharedMemory, writeSharedMemory } from "./shared-memory.js";

const tempDirs: string[] = [];

async function makeTempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "estacoda-shared-memory-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

describe("shared memory", () => {
  it("returns undefined for missing entries", async () => {
    const homeDir = await makeTempHome();

    await expect(readSharedMemory("missing", { homeDir })).resolves.toBeUndefined();
  });

  it("writes and reads an entry", async () => {
    const homeDir = await makeTempHome();

    await writeSharedMemory("shell-patterns", "shared note", { homeDir });

    await expect(readSharedMemory("shell-patterns", { homeDir })).resolves.toBe("shared note");
  });

  it("lists entries with metadata", async () => {
    const homeDir = await makeTempHome();
    await writeSharedMemory("beta", "second", { homeDir });
    await writeSharedMemory("alpha", "first", { homeDir });

    const entries = await listSharedMemory({ homeDir });

    expect(entries.map((entry) => entry.key)).toEqual(["alpha", "beta"]);
    expect(entries[0]).toMatchObject({ key: "alpha", content: "first" });
    expect(entries[0]?.createdAt).toBeInstanceOf(Date);
    expect(entries[0]?.updatedAt).toBeInstanceOf(Date);
  });

  it("overwrites an entry", async () => {
    const homeDir = await makeTempHome();
    await writeSharedMemory("alpha", "old", { homeDir });
    await writeSharedMemory("alpha", "new", { homeDir });

    await expect(readSharedMemory("alpha", { homeDir })).resolves.toBe("new");
    await expect(listSharedMemory({ homeDir })).resolves.toHaveLength(1);
  });
});
