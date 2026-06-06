import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryIndexStore } from "./memory-index-store.js";
import { MemoryIndex } from "./memory-index.js";

describe("MemoryIndex", () => {
  let tmpDir: string;
  let store: MemoryIndexStore;
  let index: MemoryIndex;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "estacoda-memory-index-"));
    store = new MemoryIndexStore({ path: join(tmpDir, "memory-index.sqlite") });
    index = new MemoryIndex({
      store,
      now: () => new Date("2030-01-01T00:00:00.000Z")
    });
  });

  afterEach(() => {
    store.dispose();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("indexes USER.md", () => {
    const entry = index.indexMemoryFile({
      profileId: "alpha",
      memoryFileKind: "USER.md",
      content: "- Prefers concise replies.",
      sourcePath: "/profile/USER.md"
    });

    expect(entry).toMatchObject({
      profileId: "alpha",
      sourceType: "memory_file",
      source: "USER.md",
      sourcePath: "/profile/USER.md",
      memoryFileKind: "USER.md",
      authority: "canonical",
      protectedClass: "none"
    });
  });

  it("indexes MEMORY.md", () => {
    const entry = index.indexMemoryFile({
      profileId: "alpha",
      memoryFileKind: "MEMORY.md",
      content: "- Project uses pnpm."
    });

    expect(entry).toMatchObject({
      source: "MEMORY.md",
      memoryFileKind: "MEMORY.md",
      authority: "canonical",
      protectedClass: "none"
    });
  });

  it("indexes shared memory", () => {
    const entry = index.indexSharedMemory({
      profileId: "alpha",
      sourceKey: "team/SHARED.md",
      content: "- Shared runbook uses release train.",
      sourcePath: "/shared/team/SHARED.md"
    });

    expect(entry).toMatchObject({
      sourceType: "shared_memory",
      source: "team/SHARED.md",
      sourceKey: "team/SHARED.md",
      sourcePath: "/shared/team/SHARED.md",
      authority: "canonical",
      protectedClass: "none"
    });
  });

  it("indexes SOUL.md as protected", () => {
    const entry = index.indexMemoryFile({
      profileId: "alpha",
      memoryFileKind: "SOUL.md",
      content: "Identity and safety guardrails."
    });

    expect(entry).toMatchObject({
      source: "SOUL.md",
      memoryFileKind: "SOUL.md",
      protectedClass: "identity"
    });
    expect(index.status({ profileId: "alpha" }).protectedEntries).toBe(1);
  });

  it("search excludes SOUL.md by default", () => {
    index.indexMemoryFile({
      profileId: "alpha",
      memoryFileKind: "SOUL.md",
      content: "Identity guardrail alpha."
    });
    index.indexMemoryFile({
      profileId: "alpha",
      memoryFileKind: "USER.md",
      content: "User guardrail preference."
    });

    const result = index.searchLexical({ profileId: "alpha", query: "guardrail" });

    expect(result.results.map((entry) => entry.source)).toEqual(["USER.md"]);
    expect(result.diagnostics.protectedFilteredCount).toBe(1);
    expect(result.diagnostics.diagnostics).toContainEqual(expect.objectContaining({
      code: "memory-protected-filtered"
    }));
  });

  it("includeProtected returns bounded SOUL.md excerpt", () => {
    index.indexMemoryFile({
      profileId: "alpha",
      memoryFileKind: "SOUL.md",
      content: "Identity guardrail ".repeat(20)
    });

    const result = index.searchLexical({
      profileId: "alpha",
      query: "guardrail",
      includeProtected: true,
      maxChars: 32
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      source: "SOUL.md",
      protectedClass: "identity"
    });
    expect(result.results[0].content.length).toBe(32);
    expect(result.diagnostics.truncated).toBe(true);
  });

  it("semantic search path cannot include protected entries", () => {
    index.indexMemoryFile({
      profileId: "alpha",
      memoryFileKind: "SOUL.md",
      content: "Semantic guardrail must stay protected."
    });

    const result = index.searchLexical({
      profileId: "alpha",
      query: "guardrail",
      includeProtected: true,
      retrievalAudience: "semantic"
    });

    expect(result.results).toEqual([]);
    expect(result.diagnostics.includeProtected).toBe(false);
    expect(result.diagnostics.protectedFilteredCount).toBe(1);
  });

  it("isolates profiles", () => {
    index.indexMemoryFile({
      profileId: "alpha",
      memoryFileKind: "USER.md",
      content: "Alpha sqlite memory."
    });
    index.indexMemoryFile({
      profileId: "beta",
      memoryFileKind: "USER.md",
      content: "Beta sqlite memory."
    });

    expect(index.searchLexical({ profileId: "alpha", query: "sqlite" }).results.map((entry) => entry.content)).toEqual([
      "Alpha sqlite memory."
    ]);
    expect(index.searchLexical({ profileId: "beta", query: "sqlite" }).results.map((entry) => entry.content)).toEqual([
      "Beta sqlite memory."
    ]);
  });

  it("cleans stale rows for the same source", () => {
    index.indexMemoryFile({
      profileId: "alpha",
      memoryFileKind: "USER.md",
      content: "Old parser preference."
    });
    index.indexMemoryFile({
      profileId: "alpha",
      memoryFileKind: "USER.md",
      content: "New parser preference."
    });

    expect(index.searchLexical({ profileId: "alpha", query: "old" }).results).toEqual([]);
    expect(index.searchLexical({ profileId: "alpha", query: "new" }).results).toHaveLength(1);
    expect(index.status({ profileId: "alpha" }).indexedEntries).toBe(1);
  });

  it("is idempotent when reindexing unchanged content", () => {
    const first = index.indexMemoryFile({
      profileId: "alpha",
      memoryFileKind: "MEMORY.md",
      content: "Stable project memory."
    });
    const second = index.indexMemoryFile({
      profileId: "alpha",
      memoryFileKind: "MEMORY.md",
      content: "Stable project memory."
    });

    expect(second.id).toBe(first.id);
    expect(second.contentHash).toBe(first.contentHash);
    expect(index.status({ profileId: "alpha" }).indexedEntries).toBe(1);
  });

  it("content hash prevents duplicate rows", () => {
    index.indexSharedMemory({
      profileId: "alpha",
      sourceKey: "team/SHARED.md",
      content: "Shared deployment memory."
    });
    index.indexSharedMemory({
      profileId: "alpha",
      sourceKey: "team/SHARED.md",
      content: "Shared deployment memory."
    });

    expect(index.searchLexical({ profileId: "alpha", query: "deployment" }).results).toHaveLength(1);
  });

  it("reports empty index diagnostics", () => {
    expect(index.status({ profileId: "alpha" })).toMatchObject({
      indexedEntries: 0,
      protectedEntries: 0,
      staleEntries: 0,
      empty: true,
      ftsHealthy: true,
      diagnostics: [expect.objectContaining({ code: "memory-index-pending-rebuild" })]
    });
  });

  it("vacuum updates status", () => {
    const vacuumed = index.vacuum();

    expect(vacuumed).toMatchObject({
      path: store.path,
      vacuumedAt: "2030-01-01T00:00:00.000Z"
    });
    expect(index.status().lastVacuumAt).toBe("2030-01-01T00:00:00.000Z");
  });

  it("readSource respects protected filtering", () => {
    index.indexMemoryFile({
      profileId: "alpha",
      memoryFileKind: "SOUL.md",
      content: "Identity guardrail protected read."
    });

    expect(index.readSource({
      profileId: "alpha",
      sourceType: "memory_file",
      sourceId: "SOUL.md"
    })).toBeNull();
    expect(index.readSource({
      profileId: "alpha",
      sourceType: "memory_file",
      sourceId: "SOUL.md",
      includeProtected: true,
      maxChars: 24
    })).toMatchObject({
      source: "SOUL.md",
      protectedClass: "identity",
      content: "Identity guardrail prote"
    });
  });

  it("removeBySource removes only the matching source", () => {
    index.indexMemoryFile({
      profileId: "alpha",
      memoryFileKind: "USER.md",
      content: "User release memory."
    });
    index.indexMemoryFile({
      profileId: "alpha",
      memoryFileKind: "MEMORY.md",
      content: "Project release memory."
    });

    expect(index.removeBySource({
      profileId: "alpha",
      sourceType: "memory_file",
      sourceId: "USER.md"
    })).toBe(1);

    expect(index.searchLexical({ profileId: "alpha", query: "release" }).results.map((entry) => entry.source)).toEqual([
      "MEMORY.md"
    ]);
  });

  it("removeProfile removes only the matching profile", () => {
    index.indexMemoryFile({
      profileId: "alpha",
      memoryFileKind: "USER.md",
      content: "Alpha release memory."
    });
    index.indexMemoryFile({
      profileId: "beta",
      memoryFileKind: "USER.md",
      content: "Beta release memory."
    });

    expect(index.removeProfile("alpha")).toBe(1);
    expect(index.searchLexical({ profileId: "alpha", query: "release" }).results).toEqual([]);
    expect(index.searchLexical({ profileId: "beta", query: "release" }).results).toHaveLength(1);
  });

  it("reindexProfile replaces only that profile's indexed sources", () => {
    index.indexMemoryFile({
      profileId: "alpha",
      memoryFileKind: "USER.md",
      content: "Old alpha memory."
    });
    index.indexMemoryFile({
      profileId: "beta",
      memoryFileKind: "USER.md",
      content: "Beta memory."
    });

    const entries = index.reindexProfile({
      profileId: "alpha",
      memoryFiles: [{
        profileId: "ignored-by-reindex",
        memoryFileKind: "MEMORY.md",
        content: "New alpha memory."
      }]
    });

    expect(entries).toHaveLength(1);
    expect(index.searchLexical({ profileId: "alpha", query: "old" }).results).toEqual([]);
    expect(index.searchLexical({ profileId: "alpha", query: "new" }).results.map((entry) => entry.source)).toEqual([
      "MEMORY.md"
    ]);
    expect(index.searchLexical({ profileId: "beta", query: "beta" }).results).toHaveLength(1);
  });
});
