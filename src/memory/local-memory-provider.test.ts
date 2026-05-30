import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalMemoryProvider } from "./local-memory-provider.js";
import { MemoryPromptContextBuilder } from "./memory-prompt-context-builder.js";
import { MemoryPromotionStore } from "./memory-promotion-store.js";
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
});
