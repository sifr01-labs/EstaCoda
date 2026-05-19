import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MEMORY_FILE_KINDS, MemoryStore } from "./memory-store.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "estacoda-memory-store-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("MemoryStore", () => {
  it("does not treat AGENTS.md as a memory file kind", () => {
    expect(MEMORY_FILE_KINDS).toEqual(["SHARED.md", "MEMORY.md", "USER.md", "SOUL.md"]);
    expect(MEMORY_FILE_KINDS).not.toContain("AGENTS.md");
  });

  it("does not load AGENTS.md from memory directories", async () => {
    const root = await makeTempDir();
    await writeFile(join(root, "AGENTS.md"), "do not load as memory", "utf8");
    await writeFile(join(root, "USER.md"), "load as memory", "utf8");
    const store = new MemoryStore();

    await store.loadFromDirectory(root);

    expect(store.snapshot().files.has("AGENTS.md" as never)).toBe(false);
    expect(store.read("USER.md")).toBe("load as memory");
  });
});
