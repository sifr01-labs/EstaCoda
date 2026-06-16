import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalMemoryProvider } from "./local-memory-provider.js";
import { MemoryPromptContextBuilder } from "./memory-prompt-context-builder.js";
import { MemoryPromotionStore } from "./memory-promotion-store.js";
import {
  MemoryPersistenceDriftError,
  MemoryPersistenceService
} from "./memory-persistence-service.js";
import { MemoryBudgetOverflowError, MemoryStore } from "./memory-store.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "estacoda-local-memory-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("LocalMemoryProvider", () => {
  it("suppresses inactive promotions in no-query context", async () => {
    const root = await makeTempDir();
    const store = new MemoryStore();
    store.write("USER.md", "- stale preference\n- active preference");
    const promotionStore = new MemoryPromotionStore({ path: join(root, "promotions.json") });
    const applied = await promotionStore.applyUserPreference({
      id: "pref-1",
      content: "stale preference",
      confidence: 0.9,
      occurrences: 2,
      source: "test",
      sourceSessionIds: []
    });
    await promotionStore.deactivateById(applied.record.id);
    const provider = new LocalMemoryProvider({ store, promotionStore });

    const context = await provider.context();

    expect(context.text).not.toContain("stale preference");
    expect(context.text).toContain("active preference");
  });

  it("surfaces structured promotion overflow failures without mutating memory markdown", async () => {
    const root = await makeTempDir();
    const store = new MemoryStore({ budgets: [{ kind: "USER.md", maxChars: 10 }] });
    store.write("USER.md", "short");
    const promotionStore = new MemoryPromotionStore({ path: join(root, "promotions.json") });
    await promotionStore.applyUserPreference({
      id: "pref-existing",
      content: "existing",
      confidence: 0.8,
      occurrences: 1,
      source: "test",
      sourceSessionIds: []
    });
    const provider = new LocalMemoryProvider({ store, promotionStore });

    await expect(provider.conclude({
      id: "pref-overflow",
      kind: "user-preference",
      content: "this preference cannot fit",
      confidence: 0.9
    })).rejects.toThrow(MemoryBudgetOverflowError);

    expect(store.read("USER.md")).toBe("short");
    expect(await promotionStore.list()).toEqual([
      expect.objectContaining({
        id: "pref-existing",
        content: "existing",
        active: true
      })
    ]);
  });

  it("rolls back secret-looking preference metadata when scanner rejects markdown", async () => {
    const root = await makeTempDir();
    const store = new MemoryStore();
    store.write("USER.md", "- existing safe preference");
    const promotionStore = new MemoryPromotionStore({ path: join(root, "promotions.json") });
    await promotionStore.applyUserPreference({
      id: "pref-existing",
      content: "existing safe preference",
      confidence: 0.8,
      occurrences: 1,
      source: "test",
      sourceSessionIds: []
    });
    const provider = new LocalMemoryProvider({ store, promotionStore });
    const secretPreference = "Prefer OPENAI_API_KEY=secret-value by default.";

    await expect(provider.conclude({
      id: "pref-secret",
      kind: "user-preference",
      content: secretPreference,
      confidence: 0.9
    })).rejects.toThrow("Memory content rejected");

    expect(store.read("USER.md")).toBe("- existing safe preference");
    expect(await promotionStore.list()).toEqual([
      expect.objectContaining({
        id: "pref-existing",
        content: "existing safe preference",
        active: true
      })
    ]);
    const promptContext = await new MemoryPromptContextBuilder({ store, promotionStore }).build();
    expect(JSON.stringify(promptContext)).not.toContain("secret-value");
    expect((await provider.context()).text).not.toContain("secret-value");
  });

  it("rolls back superseded promotion metadata and markdown when replacement overflows", async () => {
    const root = await makeTempDir();
    const store = new MemoryStore({ budgets: [{ kind: "USER.md", maxChars: 36 }] });
    store.write("USER.md", "- concise replies");
    const promotionStore = new MemoryPromotionStore({ path: join(root, "promotions.json") });
    await promotionStore.applyUserPreference({
      id: "pref-existing",
      content: "concise replies",
      confidence: 0.8,
      occurrences: 1,
      source: "test",
      sourceSessionIds: []
    });
    const provider = new LocalMemoryProvider({ store, promotionStore });

    await expect(provider.conclude({
      id: "pref-replacement",
      kind: "user-preference",
      content: "detailed replies with careful citations",
      confidence: 0.9
    })).rejects.toThrow(MemoryBudgetOverflowError);

    expect(store.read("USER.md")).toBe("- concise replies");
    expect(await promotionStore.list()).toEqual([
      expect.objectContaining({
        id: "pref-existing",
        content: "concise replies",
        active: true
      })
    ]);
    expect((await promotionStore.list())[0]?.supersededBy).toBeUndefined();
  });

  it("rolls back superseded promotion metadata and markdown when replacement is scanner-blocked", async () => {
    const root = await makeTempDir();
    const store = new MemoryStore();
    store.write("USER.md", "- Prefer concise replies.");
    const promotionStore = new MemoryPromotionStore({ path: join(root, "promotions.json") });
    await promotionStore.applyUserPreference({
      id: "pref-existing",
      content: "Prefer concise replies.",
      confidence: 0.8,
      occurrences: 1,
      source: "test",
      sourceSessionIds: []
    });
    const provider = new LocalMemoryProvider({ store, promotionStore });

    await expect(provider.conclude({
      id: "pref-replacement",
      kind: "user-preference",
      content: "Prefer detailed replies with OPENAI_API_KEY=secret-value.",
      confidence: 0.9
    })).rejects.toThrow("Memory content rejected");

    expect(store.read("USER.md")).toBe("- Prefer concise replies.");
    const records = await promotionStore.list();
    expect(records).toEqual([
      expect.objectContaining({
        id: "pref-existing",
        content: "Prefer concise replies.",
        active: true
      })
    ]);
    expect(records[0]?.supersededBy).toBeUndefined();
  });

  it("rolls back project fact promotion metadata when MEMORY.md overflows", async () => {
    const root = await makeTempDir();
    const store = new MemoryStore({ budgets: [{ kind: "MEMORY.md", maxChars: 10 }] });
    store.write("MEMORY.md", "short");
    const promotionStore = new MemoryPromotionStore({ path: join(root, "promotions.json") });
    await promotionStore.applyProjectFact({
      id: "fact-existing",
      content: "existing fact",
      confidence: 0.8,
      occurrences: 1,
      source: "test",
      sourceSessionIds: []
    });
    const provider = new LocalMemoryProvider({ store, promotionStore });

    await expect(provider.conclude({
      id: "fact-overflow",
      kind: "project-fact",
      content: "project fact cannot fit",
      confidence: 0.9
    })).rejects.toThrow(MemoryBudgetOverflowError);

    expect(store.read("MEMORY.md")).toBe("short");
    expect(await promotionStore.list()).toEqual([
      expect.objectContaining({
        id: "fact-existing",
        content: "existing fact",
        active: true
      })
    ]);
  });

  it("detects external edits before saving provider memory changes", async () => {
    const root = await makeTempDir();
    const path = join(root, "USER.md");
    await writeFile(path, "- original preference", "utf8");
    const persistence = new MemoryPersistenceService();
    const loaded = await persistence.readFile({
      path,
      kind: "USER.md"
    });
    const store = new MemoryStore();
    store.write("USER.md", loaded ?? "");
    const provider = new LocalMemoryProvider({
      store,
      saveRoot: root,
      persistence
    });
    await writeFile(path, "- externally edited preference", "utf8");

    await expect(provider.conclude({
      id: "pref-drift",
      kind: "user-preference",
      content: "Prefer focused replies.",
      confidence: 0.9
    })).rejects.toThrow(MemoryPersistenceDriftError);

    expect(await readFile(path, "utf8")).toBe("- externally edited preference");
    expect(store.read("USER.md")).toBe("- original preference");
  });

  it("rolls back promotion markdown and metadata when markdown drift is refused", async () => {
    const root = await makeTempDir();
    const userPath = join(root, "USER.md");
    const promotionsPath = join(root, "promotions.json");
    await writeFile(userPath, "- Prefer concise replies.", "utf8");
    const persistence = new MemoryPersistenceService();
    const loaded = await persistence.readFile({
      path: userPath,
      kind: "USER.md"
    });
    const store = new MemoryStore();
    store.write("USER.md", loaded ?? "");
    const promotionStore = new MemoryPromotionStore({
      path: promotionsPath,
      persistence
    });
    await promotionStore.applyUserPreference({
      id: "pref-existing",
      content: "Prefer concise replies.",
      confidence: 0.8,
      occurrences: 1,
      source: "test",
      sourceSessionIds: []
    });
    const provider = new LocalMemoryProvider({
      store,
      saveRoot: root,
      promotionStore,
      persistence
    });
    await writeFile(userPath, "- external edit stays on disk", "utf8");

    await expect(provider.conclude({
      id: "pref-replacement",
      kind: "user-preference",
      content: "Prefer detailed replies.",
      confidence: 0.9
    })).rejects.toThrow(MemoryPersistenceDriftError);

    expect(await readFile(userPath, "utf8")).toBe("- external edit stays on disk");
    expect(store.read("USER.md")).toBe("- Prefer concise replies.");
    expect(await promotionStore.list()).toEqual([
      expect.objectContaining({
        id: "pref-existing",
        content: "Prefer concise replies.",
        active: true
      })
    ]);
    const promotionsJson = await readFile(promotionsPath, "utf8");
    expect(promotionsJson).toContain("pref-existing");
    expect(promotionsJson).not.toContain("pref-replacement");
  });

  it("rolls back promotion metadata when persisted markdown write fails", async () => {
    const root = await makeTempDir();
    const userPath = join(root, "USER.md");
    const promotionsPath = join(root, "promotions.json");
    await writeFile(userPath, "- Prefer concise replies.", "utf8");
    const persistence = new MemoryPersistenceService();
    await persistence.readFile({
      path: userPath,
      kind: "USER.md"
    });
    const store = new MemoryStore();
    store.write("USER.md", "- Prefer concise replies.");
    const promotionStore = new MemoryPromotionStore({
      path: promotionsPath,
      persistence
    });
    await promotionStore.applyUserPreference({
      id: "pref-existing",
      content: "Prefer concise replies.",
      confidence: 0.8,
      occurrences: 1,
      source: "test",
      sourceSessionIds: []
    });
    const originalWriteFile = persistence.writeFile.bind(persistence);
    vi.spyOn(persistence, "writeFile").mockImplementation(async (options) => {
      if (options.kind === "USER.md") {
        throw new Error("simulated markdown write failure");
      }
      return await originalWriteFile(options);
    });
    const provider = new LocalMemoryProvider({
      store,
      saveRoot: root,
      promotionStore,
      persistence
    });

    await expect(provider.conclude({
      id: "pref-replacement",
      kind: "user-preference",
      content: "Prefer detailed replies.",
      confidence: 0.9
    })).rejects.toThrow("simulated markdown write failure");

    expect(await readFile(userPath, "utf8")).toBe("- Prefer concise replies.");
    expect(store.read("USER.md")).toBe("- Prefer concise replies.");
    expect(await promotionStore.list()).toEqual([
      expect.objectContaining({
        id: "pref-existing",
        content: "Prefer concise replies.",
        active: true
      })
    ]);
    const promotionsJson = await readFile(promotionsPath, "utf8");
    expect(promotionsJson).toContain("pref-existing");
    expect(promotionsJson).not.toContain("pref-replacement");
  });

  it("creates memory file backups only when explicitly configured", async () => {
    const root = await makeTempDir();
    const path = join(root, "MEMORY.md");
    await writeFile(path, "- original fact", "utf8");
    const persistence = new MemoryPersistenceService();
    await persistence.readFile({
      path,
      kind: "MEMORY.md"
    });

    await persistence.writeFile({
      path,
      kind: "MEMORY.md",
      content: "- updated fact"
    });
    expect((await readdir(root)).filter((entry) => entry.includes(".bak."))).toEqual([]);

    const result = await persistence.writeFile({
      path,
      kind: "MEMORY.md",
      content: "- second update",
      policy: {
        createBackup: true,
        now: () => new Date("2026-06-01T00:00:00.000Z")
      }
    });

    expect(result.backupPath).toBe(`${path}.bak.2026-06-01T00-00-00-000Z`);
    expect(await readFile(result.backupPath!, "utf8")).toBe("- updated fact");
  });

  it("strips hidden reasoning before writing memory conclusions and skill outcomes", async () => {
    const store = new MemoryStore();
    const provider = new LocalMemoryProvider({ store });

    await provider.conclude({
      id: "pref-reasoning",
      kind: "user-preference",
      content: "<think>private chain</think>Prefer concise replies.",
      confidence: 0.9
    });
    await provider.recordSkillOutcome({
      skill: "demo",
      status: "succeeded",
      tools: ["shell"],
      memoryTargets: ["MEMORY.md"],
      summary: "<reasoning>private tool rationale</reasoning>Ran the checks."
    });

    expect(store.read("USER.md")).toContain("Prefer concise replies.");
    expect(store.read("USER.md")).not.toContain("private chain");
    expect(store.read("MEMORY.md")).toContain("Ran the checks.");
    expect(store.read("MEMORY.md")).not.toContain("private tool rationale");
  });

  it("records redacted bounded delegation outcomes in MEMORY.md", async () => {
    const store = new MemoryStore();
    const provider = new LocalMemoryProvider({ store });

    await provider.recordDelegationOutcome({
      taskPreview: "<think>private prompt</think>Inspect OPENAI_API_KEY=sk-secretsecretsecretsecretsecret",
      resultSummary: "<reasoning>private answer</reasoning>Found password=super-secret-value",
      status: "completed",
      childSessionId: "child-1",
      parentSessionId: "parent-1",
      role: "leaf",
      depth: 1,
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      createdAt: "2026-06-11T00:00:00.000Z"
    });

    const memory = store.read("MEMORY.md");
    expect(memory).toContain("- delegation | status:completed");
    expect(memory).toContain("child:child-1");
    expect(memory).toContain("usage:in:1,out:2,total:3");
    expect(memory).toContain("[REDACTED]");
    expect(memory).not.toContain("private prompt");
    expect(memory).not.toContain("private answer");
    expect(memory).not.toContain("sk-secret");
    expect(memory).not.toContain("super-secret-value");
  });

  it("search excludes SOUL.md in the legacy fallback path", async () => {
    const store = new MemoryStore();
    store.write("SOUL.md", "protected-search-token identity");
    store.write("USER.md", "visible-search-token preference");
    const provider = new LocalMemoryProvider({ store });

    const results = await provider.search("search-token");

    expect(results).toEqual([
      {
        source: "USER.md",
        content: "visible-search-token preference",
        score: 1
      }
    ]);
  });

  it("search uses the retrieval service path when available and preserves MemorySearchResult shape", async () => {
    const store = new MemoryStore();
    store.write("USER.md", "legacy content should not be used");
    const memorySearchService = {
      search: async () => ({
        results: [{
          id: "indexed-result",
          profileId: "alpha",
          mode: "lexical" as const,
          sourceType: "memory_file" as const,
          source: "MEMORY.md",
          memoryFileKind: "MEMORY.md" as const,
          authority: "canonical" as const,
          protectedClass: "none" as const,
          contentHash: "hash",
          content: "indexed search content",
          excerpt: "indexed search content",
          score: 0.5,
          updatedAt: "2030-01-01T00:00:00.000Z",
          contextLabel: "local-memory-context" as const,
          instructionBoundary: "context-not-instruction" as const,
          trusted: false as const
        }],
        diagnostics: {
          mode: "lexical" as const,
          profileId: "alpha",
          indexEnabled: true,
          indexAvailable: true,
          fallbackUsed: false,
          includeProtected: false,
          resultCount: 1,
          truncated: false,
          redactionApplied: false,
          diagnostics: []
        }
      })
    };
    const provider = new LocalMemoryProvider({
      store,
      memorySearchService,
      profileId: "alpha"
    });

    const results = await provider.search("indexed", { limit: 3 });

    expect(results).toEqual([
      {
        source: "MEMORY.md",
        content: "indexed search content",
        score: 0.5
      }
    ]);
  });
});
