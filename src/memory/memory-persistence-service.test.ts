import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MemoryPersistenceDriftError,
  MemoryPersistenceService
} from "./memory-persistence-service.js";

const fsMock = vi.hoisted(() => ({
  failRename: false
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: vi.fn(async (oldPath: string, newPath: string) => {
      if (fsMock.failRename) {
        const error = new Error("simulated rename failure") as NodeJS.ErrnoException;
        error.code = "EIO";
        throw error;
      }
      await actual.rename(oldPath, newPath);
    })
  };
});

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "estacoda-memory-persistence-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  fsMock.failRename = false;
  vi.clearAllMocks();
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("MemoryPersistenceService", () => {
  it("updates the persistence snapshot after a successful write", async () => {
    const root = await makeTempDir();
    const path = join(root, "USER.md");
    await writeFile(path, "- original preference", "utf8");
    const persistence = new MemoryPersistenceService();
    await persistence.readFile({ path, kind: "USER.md" });

    const result = await persistence.writeFile({
      path,
      kind: "USER.md",
      content: "- updated preference"
    });

    expect(await readFile(path, "utf8")).toBe("- updated preference");
    expect(persistence.snapshotFor(path)).toEqual(result.snapshot);
    expect(result.snapshot.size).toBe("- updated preference".length);
  });

  it("leaves the previous target file intact when atomic replace fails", async () => {
    const root = await makeTempDir();
    const path = join(root, "MEMORY.md");
    await writeFile(path, "- original fact", "utf8");
    const persistence = new MemoryPersistenceService();
    const originalSnapshot = await persistence.trackFile({ path, kind: "MEMORY.md" });
    fsMock.failRename = true;

    await expect(persistence.writeFile({
      path,
      kind: "MEMORY.md",
      content: "- partially written fact"
    })).rejects.toThrow("simulated rename failure");

    expect(await readFile(path, "utf8")).toBe("- original fact");
    expect(persistence.snapshotFor(path)).toEqual(originalSnapshot);
    expect(await readdir(root)).toEqual(["MEMORY.md"]);
  });

  it("checks drift before writing temp files", async () => {
    const root = await makeTempDir();
    const path = join(root, "USER.md");
    await writeFile(path, "- original preference", "utf8");
    const persistence = new MemoryPersistenceService();
    await persistence.readFile({ path, kind: "USER.md" });
    await writeFile(path, "- external edit", "utf8");

    await expect(persistence.writeFile({
      path,
      kind: "USER.md",
      content: "- updated preference"
    })).rejects.toThrow(MemoryPersistenceDriftError);

    expect(await readFile(path, "utf8")).toBe("- external edit");
    expect(await readdir(root)).toEqual(["USER.md"]);
  });

  it("preserves explicit backup behavior", async () => {
    const root = await makeTempDir();
    const path = join(root, "MEMORY.md");
    await writeFile(path, "- original fact", "utf8");
    const persistence = new MemoryPersistenceService();
    await persistence.trackFile({ path, kind: "MEMORY.md" });

    const result = await persistence.writeFile({
      path,
      kind: "MEMORY.md",
      content: "- updated fact",
      policy: {
        createBackup: true,
        now: () => new Date("2026-06-16T00:00:00.000Z")
      }
    });

    expect(result.backupPath).toBe(`${path}.bak.2026-06-16T00-00-00-000Z`);
    expect(await readFile(result.backupPath!, "utf8")).toBe("- original fact");
    expect(await readFile(path, "utf8")).toBe("- updated fact");
  });
});
