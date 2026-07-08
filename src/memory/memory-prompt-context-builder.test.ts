import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MemoryPromotionRecord } from "../contracts/memory.js";
import { attachSessionRecallToMemoryPromptContext, MemoryPromptContextBuilder } from "./memory-prompt-context-builder.js";
import { MemoryPromotionStore } from "./memory-promotion-store.js";
import { MemoryStore } from "./memory-store.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "estacoda-memory-prompt-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("MemoryPromptContextBuilder", () => {
  it("separates learned USER.md and MEMORY.md blocks from SOUL.md safety context", async () => {
    const store = new MemoryStore();
    store.write("USER.md", "- Prefers concise replies.");
    store.write("MEMORY.md", "- Project uses pnpm.");
    store.write("SOUL.md", "identity and safety context");

    const context = await new MemoryPromptContextBuilder({ store }).build();

    expect(context.frozenCompactMemory.map((block) => block.source)).toEqual(["USER.md", "MEMORY.md"]);
    expect(context.safetyMemory.map((block) => block.source)).toEqual(["SOUL.md"]);
    expect(context.frozenCompactMemory.map((block) => block.kind)).toEqual(["learned-user", "learned-project"]);
    expect(context.safetyMemory[0]).toMatchObject({ kind: "identity", trusted: true });
  });

  it("suppresses inactive learned entries without suppressing SOUL.md", async () => {
    const store = new MemoryStore();
    store.write("USER.md", [
      "- stale preference",
      "- active preference",
      "- active preference"
    ].join("\n"));
    store.write("MEMORY.md", "- stale project fact\n- active project fact");
    store.write("SOUL.md", "stale preference");
    const promotionStore = {
      list: async () => [
        promotionRecord("pref-1", "user-preference", "stale preference", false),
        promotionRecord("fact-1", "project-fact", "stale project fact", false)
      ]
    };

    const context = await new MemoryPromptContextBuilder({ store, promotionStore }).build();
    const user = context.frozenCompactMemory.find((block) => block.source === "USER.md");
    const memory = context.frozenCompactMemory.find((block) => block.source === "MEMORY.md");

    expect(user?.content).not.toContain("stale preference");
    expect(user?.content).toContain("active preference");
    expect(user?.content.match(/active preference/gu)).toHaveLength(1);
    expect(memory?.content).not.toContain("stale project fact");
    expect(memory?.content).toContain("active project fact");
    expect(context.safetyMemory[0]?.content).toBe("stale preference");
    expect(context.diagnostics.suppressedEntries).toBe(2);
    expect(context.diagnostics.duplicateEntriesRemoved).toBe(1);
  });

  it("does not write promotion files when building dry-run diagnostics", async () => {
    const root = await makeTempDir();
    const promotionsPath = join(root, "promotions.json");
    const store = new MemoryStore();
    store.write("USER.md", "- persistent preference");
    const promotionStore = new MemoryPromotionStore({ path: promotionsPath });

    const context = await new MemoryPromptContextBuilder({ store, promotionStore }).build({ dryRun: true });

    expect(context.diagnostics.warnings).toContain("dry-run: no memory files were written");
    await expect(readFile(promotionsPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("exposes USER.md and MEMORY.md budget pressure in prompt diagnostics", async () => {
    const store = new MemoryStore({
      budgets: [
        { kind: "USER.md", maxChars: 10 },
        { kind: "MEMORY.md", maxChars: 20 }
      ]
    });
    store.write("USER.md", "12345678");
    store.write("MEMORY.md", "1234567890123456789");

    const context = await new MemoryPromptContextBuilder({ store }).build();

    expect(context.diagnostics.budgetPressure).toEqual([
      expect.objectContaining({
        kind: "USER.md",
        chars: 8,
        maxChars: 10,
        state: "warning"
      }),
      expect.objectContaining({
        kind: "MEMORY.md",
        chars: 19,
        maxChars: 20,
        state: "critical"
      })
    ]);
    expect(context.diagnostics.compactionPressure).toBe(context.diagnostics.budgetPressure);
    expect(context.diagnostics.warnings).toEqual([
      "USER.md memory budget pressure is warning: 8/10 chars",
      "MEMORY.md memory budget pressure is critical: 19/20 chars"
    ]);
  });

  it("surfaces over-budget hydrated memory as prompt diagnostics instead of crashing", async () => {
    const store = new MemoryStore({
      budgets: [{ kind: "MEMORY.md", maxChars: 10 }]
    });
    store.hydrate("MEMORY.md", "- persisted memory that needs compaction");

    const context = await new MemoryPromptContextBuilder({ store }).build();

    expect(context.frozenCompactMemory).toContainEqual(expect.objectContaining({
      source: "MEMORY.md",
      content: "- persisted memory that needs compaction"
    }));
    expect(context.diagnostics.budgetPressure).toContainEqual(expect.objectContaining({
      kind: "MEMORY.md",
      state: "overflow",
      maxChars: 10
    }));
    expect(context.diagnostics.warnings).toContainEqual(
      expect.stringMatching(/^MEMORY\.md memory budget pressure is overflow: \d+\/10 chars$/u)
    );
  });

  it("attaches session recall as untrusted prompt context with source diagnostics", async () => {
    const store = new MemoryStore();
    store.write("USER.md", "- Prefers terse summaries.");

    const context = await new MemoryPromptContextBuilder({ store }).build({
      recallTriggered: true,
      sessionRecall: [
        {
          id: "session-recall:sess-1",
          kind: "session-recall",
          scope: "session",
          source: "session:sess-1",
          content: "Session recall is historical context.",
          chars: "Session recall is historical context.".length,
          entryIds: ["sess-1"],
          trusted: false
        }
      ]
    });

    expect(context.sessionRecall).toHaveLength(1);
    expect(context.sessionRecall?.[0]).toMatchObject({
      kind: "session-recall",
      trusted: false,
      entryIds: ["sess-1"]
    });
    expect(context.diagnostics.recallTriggered).toBe(true);
    expect(context.diagnostics.includedBlocks).toContainEqual(expect.objectContaining({
      kind: "session-recall",
      source: "session:sess-1",
      entryIds: ["sess-1"]
    }));
  });

  it("can attach recall to an already prepared memory prompt context for one turn", async () => {
    const store = new MemoryStore();
    store.write("MEMORY.md", "- Project uses pnpm.");
    const base = await new MemoryPromptContextBuilder({ store }).build();

    const context = attachSessionRecallToMemoryPromptContext(base, {
      triggered: true,
      blocks: [
        {
          id: "session-recall:sess-2",
          kind: "session-recall",
          scope: "session",
          source: "session:sess-2",
          content: "Session recall is historical context.",
          chars: "Session recall is historical context.".length,
          entryIds: ["sess-2"],
          trusted: false
        }
      ]
    });

    expect(context?.frozenCompactMemory.map((block) => block.source)).toEqual(["MEMORY.md"]);
    expect(context?.sessionRecall?.map((block) => block.source)).toEqual(["session:sess-2"]);
    expect(context?.diagnostics.includedBlocks.map((block) => block.kind)).toEqual(["learned-project", "session-recall"]);
  });
});

function promotionRecord(
  id: string,
  kind: MemoryPromotionRecord["kind"],
  content: string,
  active: boolean
): MemoryPromotionRecord {
  return {
    id,
    kind,
    content,
    active,
    confidence: 0.9,
    occurrences: 1,
    source: "test",
    sourceSessionIds: [],
    updatedAt: "2026-05-19T00:00:00.000Z"
  };
}
