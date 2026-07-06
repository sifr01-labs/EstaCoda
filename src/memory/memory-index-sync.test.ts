import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_MEMORY_CONFIG, type MemoryConfig } from "../config/memory-config.js";
import { resolveGlobalStateHome, resolveProfileStateHome } from "../config/profile-home.js";
import { createMemoryTool } from "../tools/memory-tool.js";
import { LocalMemoryProvider } from "./local-memory-provider.js";
import { MemoryIndex } from "./memory-index.js";
import { MemoryIndexStore } from "./memory-index-store.js";
import { createMemoryIndexSync, MemoryIndexSync, type MemoryIndexWriteSync } from "./memory-index-sync.js";
import { MemoryStore } from "./memory-store.js";

const tempDirs: string[] = [];

async function makeTempHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "estacoda-memory-index-sync-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("MemoryIndexSync", () => {
  it("backfill off skips automatic indexing", async () => {
    const { homeDir, index, sync, cleanup } = await createHarness({
      config: memoryConfig({ backfillOnStartup: "off" })
    });
    await writeProfileMemory(homeDir, "alpha", {
      "USER.md": "- Prefers concise replies."
    });

    try {
      const result = await sync.backfillOnStartup();

      expect(result.indexedEntries).toBe(0);
      expect(result.diagnostics.diagnostics).toContainEqual(expect.objectContaining({
        code: "memory-index-backfill-skipped"
      }));
      expect(index.searchLexical({ profileId: "alpha", query: "concise" }).results).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("bounded backfill indexes a bounded local set", async () => {
    const homeDir = await makeTempHome();
    await writeProfileMemory(homeDir, "alpha", {
      "USER.md": "- User likes terse summaries.",
      "MEMORY.md": "- Project uses pnpm.",
      "SOUL.md": "Identity guardrails stay protected."
    });
    await writeSharedMemoryFile(homeDir, "team", "- Shared deploy note.");
    const { index, sync, cleanup } = createHarnessForHome(homeDir, {
      config: memoryConfig({ backfillOnStartup: "bounded" })
    });

    try {
      const result = await sync.backfillOnStartup();

      expect(result.indexedEntries).toBe(3);
      expect(index.searchLexical({ profileId: "alpha", query: "terse" }).results).toHaveLength(1);
      expect(index.searchLexical({ profileId: "alpha", query: "shared" }).results).toEqual([]);
      expect(result.diagnostics.lastBackfillAt).toBe("2030-01-01T00:00:00.000Z");
    } finally {
      cleanup();
    }
  });

  it("full backfill indexes profile memory files and shared memory", async () => {
    const homeDir = await makeTempHome();
    await writeProfileMemory(homeDir, "alpha", {
      "USER.md": "- User likes careful notes.",
      "MEMORY.md": "- Project uses sqlite.",
      "SOUL.md": "Safety identity context."
    });
    await writeSharedMemoryFile(homeDir, "team", "- Shared launch checklist.");
    const { index, sync, cleanup } = createHarnessForHome(homeDir, {
      config: memoryConfig({ backfillOnStartup: "full" })
    });

    try {
      const result = await sync.backfillOnStartup();

      expect(result.indexedEntries).toBe(4);
      expect(index.searchLexical({ profileId: "alpha", query: "sqlite" }).results.map((entry) => entry.source)).toEqual([
        "MEMORY.md"
      ]);
      expect(index.searchLexical({ profileId: "alpha", query: "launch" }).results.map((entry) => entry.source)).toEqual([
        "team"
      ]);
    } finally {
      cleanup();
    }
  });

  it("missing memory-index.sqlite reports pending rebuild and empty diagnostics", async () => {
    const homeDir = await makeTempHome();
    const profilePaths = resolveProfileStateHome({ homeDir, profileId: "alpha" });
    const indexPath = join(profilePaths.profileRoot, "memory-index.sqlite");

    const sync = createMemoryIndexSync({
      homeDir,
      profileId: "alpha",
      config: memoryConfig({ backfillOnStartup: "off" }),
      now: fixedNow
    });

    try {
      const diagnostics = sync.diagnostics();

      expect(existsSync(indexPath)).toBe(true);
      expect(diagnostics.missingIndexFile).toBe(true);
      expect(diagnostics.pendingRebuildReason).toBe("missing memory-index.sqlite at startup");
      expect(diagnostics.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "memory-index-missing" }),
        expect.objectContaining({ code: "memory-index-empty" })
      ]));
    } finally {
      sync.dispose();
    }
  });

  it("bounded backfill may recreate missing memory-index.sqlite", async () => {
    const homeDir = await makeTempHome();
    await writeProfileMemory(homeDir, "alpha", {
      "USER.md": "- Recreated index can backfill local memory."
    });
    const profilePaths = resolveProfileStateHome({ homeDir, profileId: "alpha" });
    const indexPath = join(profilePaths.profileRoot, "memory-index.sqlite");

    const sync = createMemoryIndexSync({
      homeDir,
      profileId: "alpha",
      config: memoryConfig({ backfillOnStartup: "bounded" }),
      now: fixedNow
    });

    try {
      expect(existsSync(indexPath)).toBe(true);
      const result = await sync.backfillOnStartup();
      expect(result.indexedEntries).toBe(1);
      expect(result.diagnostics.missingIndexFile).toBe(true);
      expect(result.diagnostics.indexedEntries).toBe(1);
    } finally {
      sync.dispose();
    }
  });

  it("sync runs after successful LocalMemoryProvider save", async () => {
    const root = await makeTempHome();
    const store = new MemoryStore();
    const memoryIndexSync: MemoryIndexWriteSync = {
      syncMemoryFile: vi.fn(async () => ({
        ok: true,
        diagnostics: emptySyncDiagnostics(root)
      }))
    };
    const provider = new LocalMemoryProvider({
      store,
      saveRoot: root,
      memoryIndexSync
    });

    await provider.conclude({
      id: "pref-1",
      kind: "user-preference",
      content: "Prefer compact answers.",
      confidence: 0.9
    });

    expect(await readFile(join(root, "USER.md"), "utf8")).toContain("Prefer compact answers.");
    expect(memoryIndexSync.syncMemoryFile).toHaveBeenCalledWith(expect.objectContaining({
      file: "USER.md",
      content: expect.stringContaining("Prefer compact answers."),
      sourcePath: join(root, "USER.md")
    }));
  });

  it("sync runs after successful memory.curate write where wired", async () => {
    const root = await makeTempHome();
    const store = new MemoryStore();
    const memoryIndexSync: MemoryIndexWriteSync = {
      syncMemoryFile: vi.fn(async () => ({
        ok: true,
        diagnostics: emptySyncDiagnostics(root)
      }))
    };
    const tool = createMemoryTool(store, {
      memoryIndexSync
    });

    const result = await tool.run({
      kind: "append",
      file: "USER.md",
      content: "- Likes index sync tests."
    });

    expect(result.ok).toBe(true);
    expect(memoryIndexSync.syncMemoryFile).toHaveBeenCalledWith(expect.objectContaining({
      file: "USER.md",
      content: "- Likes index sync tests."
    }));
  });

  it("sync failure does not roll back authoritative memory write", async () => {
    const store = new MemoryStore();
    const tool = createMemoryTool(store, {
      memoryIndexSync: {
        syncMemoryFile: vi.fn(async () => {
          throw new Error("index unavailable TOKEN=secretsecretsecretsecretsecret");
        })
      }
    });

    const result = await tool.run({
      kind: "append",
      file: "MEMORY.md",
      content: "- Authoritative write survives index failure."
    });

    expect(result.ok).toBe(true);
    expect(store.read("MEMORY.md")).toContain("Authoritative write survives");
    expect(result.metadata?.warnings).toEqual([
      "memory index sync failed for MEMORY.md: index unavailable TOKEN=[REDACTED]"
    ]);
  });

  it("sync failure emits isolated warning diagnostics", async () => {
    const homeDir = await makeTempHome();
    const { sync, cleanup } = createHarnessForHome(homeDir);

    try {
      await sync.syncSharedMemory({
        sourceKey: "bad/key",
        content: "invalid shared source key"
      });

      expect(sync.diagnostics().warnings).toEqual([
        expect.stringContaining("memory index sync failed for bad/key")
      ]);
      expect(sync.diagnostics().diagnostics).toContainEqual(expect.objectContaining({
        code: "memory-index-sync-failed",
        sourceType: "shared_memory",
        sourceId: "bad/key"
      }));
    } finally {
      cleanup();
    }
  });

  it("scanner rejection does not sync rejected content", async () => {
    const store = new MemoryStore();
    const memoryIndexSync: MemoryIndexWriteSync = {
      syncMemoryFile: vi.fn(async () => ({
        ok: true,
        diagnostics: emptySyncDiagnostics("/tmp")
      }))
    };
    const tool = createMemoryTool(store, { memoryIndexSync });

    await expect(tool.run({
      kind: "append",
      file: "USER.md",
      content: "- Prefer OPENAI_API_KEY=secret-value."
    })).rejects.toThrow("Memory content rejected");

    expect(memoryIndexSync.syncMemoryFile).not.toHaveBeenCalled();
  });

  it("duplicate rejection behavior is unchanged", async () => {
    const store = new MemoryStore();
    store.write("USER.md", "- Prefer concise replies.");
    const memoryIndexSync: MemoryIndexWriteSync = {
      syncMemoryFile: vi.fn(async () => ({
        ok: true,
        diagnostics: emptySyncDiagnostics("/tmp")
      }))
    };
    const tool = createMemoryTool(store, { memoryIndexSync });

    await expect(tool.run({
      kind: "append",
      file: "USER.md",
      content: "- Prefer concise replies."
    })).rejects.toThrow("Duplicate memory entry rejected in USER.md");

    expect(store.read("USER.md")).toBe("- Prefer concise replies.");
    expect(memoryIndexSync.syncMemoryFile).not.toHaveBeenCalled();
  });

  it("budget overflow behavior is unchanged", async () => {
    const store = new MemoryStore({ budgets: [{ kind: "USER.md", maxChars: 10 }] });
    store.write("USER.md", "short");
    const memoryIndexSync: MemoryIndexWriteSync = {
      syncMemoryFile: vi.fn(async () => ({
        ok: true,
        diagnostics: emptySyncDiagnostics("/tmp")
      }))
    };
    const tool = createMemoryTool(store, { memoryIndexSync });

    const result = await tool.run({
      kind: "append",
      file: "USER.md",
      content: "too long"
    });

    expect(result.ok).toBe(false);
    expect(result.metadata).toMatchObject({ error: "memory-budget-overflow" });
    expect(store.read("USER.md")).toBe("short");
    expect(memoryIndexSync.syncMemoryFile).not.toHaveBeenCalled();
  });

  it("SOUL.md is indexed as protected during backfill", async () => {
    const homeDir = await makeTempHome();
    await writeProfileMemory(homeDir, "alpha", {
      "SOUL.md": "Identity safety guardrails."
    });
    const { index, sync, cleanup } = createHarnessForHome(homeDir, {
      config: memoryConfig({ backfillOnStartup: "bounded" })
    });

    try {
      await sync.backfillOnStartup();

      expect(index.searchLexical({ profileId: "alpha", query: "guardrails" }).results).toEqual([]);
      expect(index.searchLexical({
        profileId: "alpha",
        query: "guardrails",
        includeProtected: true
      }).results).toEqual([
        expect.objectContaining({
          source: "SOUL.md",
          protectedClass: "identity"
        })
      ]);
    } finally {
      cleanup();
    }
  });

  it("protected entry counts appear in diagnostics", async () => {
    const homeDir = await makeTempHome();
    await writeProfileMemory(homeDir, "alpha", {
      "SOUL.md": "Identity protected count."
    });
    const { sync, cleanup } = createHarnessForHome(homeDir, {
      config: memoryConfig({ backfillOnStartup: "bounded" })
    });

    try {
      const result = await sync.backfillOnStartup();
      expect(result.diagnostics.protectedEntries).toBe(1);
    } finally {
      cleanup();
    }
  });

  it("stale entries diagnostics are reported where detectable", async () => {
    const homeDir = await makeTempHome();
    const { index, sync, cleanup } = createHarnessForHome(homeDir);
    index.indexMemoryFile({
      profileId: "alpha",
      memoryFileKind: "USER.md",
      content: "- Stale source on disk is missing.",
      sourcePath: join(homeDir, ".estacoda", "profiles", "alpha", "USER.md")
    });

    try {
      const diagnostics = sync.diagnostics();

      expect(diagnostics.staleEntries).toBe(1);
      expect(diagnostics.pendingRebuildReason).toBe("stale indexed sources");
      expect(diagnostics.diagnostics).toContainEqual(expect.objectContaining({
        code: "memory-index-stale-entries"
      }));
    } finally {
      cleanup();
    }
  });

  it("persists rebuild lifecycle metadata across fresh sync instances", async () => {
    const homeDir = await makeTempHome();
    await writeProfileMemory(homeDir, "alpha", {
      "USER.md": "- Durable rebuild metadata."
    });
    const harness = createHarnessForHome(homeDir);

    try {
      const rebuild = await harness.sync.rebuild();
      expect(rebuild.diagnostics.lastRebuildAt).toBe("2030-01-01T00:00:00.000Z");
    } finally {
      harness.cleanup();
    }

    const reopened = createHarnessForHome(homeDir);
    try {
      const diagnostics = reopened.sync.diagnostics();

      expect(diagnostics.lastRebuildAt).toBe("2030-01-01T00:00:00.000Z");
      expect(diagnostics.lastBackfillAt).toBe("2030-01-01T00:00:00.000Z");
      expect(diagnostics.pendingRebuildReason).toBeUndefined();
    } finally {
      reopened.cleanup();
    }
  });
});

function createHarnessForHome(
  homeDir: string,
  options: { config?: MemoryConfig } = {}
): { homeDir: string; index: MemoryIndex; sync: MemoryIndexSync; cleanup: () => void } {
  const store = new MemoryIndexStore({ homeDir, profileId: "alpha" });
  const index = new MemoryIndex({ store, now: fixedNow });
  const sync = new MemoryIndexSync({
    store,
    index,
    homeDir,
    profileId: "alpha",
    config: options.config,
    now: fixedNow
  });
  return {
    homeDir,
    index,
    sync,
    cleanup: () => store.dispose()
  };
}

async function createHarness(
  options: { config?: MemoryConfig } = {}
): Promise<{ homeDir: string; index: MemoryIndex; sync: MemoryIndexSync; cleanup: () => void }> {
  const homeDir = await makeTempHome();
  return createHarnessForHome(homeDir, options);
}

async function writeProfileMemory(
  homeDir: string,
  profileId: string,
  files: Partial<Record<"USER.md" | "MEMORY.md" | "SOUL.md", string>>
): Promise<void> {
  const paths = resolveProfileStateHome({ homeDir, profileId });
  await mkdir(paths.profileRoot, { recursive: true });
  for (const [file, content] of Object.entries(files)) {
    const path = file === "USER.md"
      ? paths.userMdPath
      : file === "MEMORY.md"
        ? paths.memoryMdPath
        : paths.soulMdPath;
    await writeFile(path, content, "utf8");
  }
}

async function writeSharedMemoryFile(homeDir: string, key: string, content: string): Promise<void> {
  const globalPaths = resolveGlobalStateHome({ homeDir });
  await mkdir(globalPaths.sharedMemoryPath, { recursive: true });
  await writeFile(join(globalPaths.sharedMemoryPath, `${key}.md`), content, "utf8");
}

function memoryConfig(index: Partial<MemoryConfig["index"]>): MemoryConfig {
  return {
    retrieval: DEFAULT_MEMORY_CONFIG.retrieval,
    index: {
      ...DEFAULT_MEMORY_CONFIG.index,
      ...index
    },
    curation: DEFAULT_MEMORY_CONFIG.curation
  };
}

function fixedNow(): Date {
  return new Date("2030-01-01T00:00:00.000Z");
}

function emptySyncDiagnostics(path: string) {
  return {
    path,
    profileId: "alpha",
    enabled: true,
    available: true,
    staleEntries: 0,
    protectedEntries: 0,
    indexedEntries: 0,
    indexedProfiles: 0,
    ftsHealthy: true,
    empty: true,
    missingIndexFile: false,
    warnings: [],
    diagnostics: []
  };
}
