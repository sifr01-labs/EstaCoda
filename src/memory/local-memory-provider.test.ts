import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalMemoryProvider } from "./local-memory-provider.js";
import { MemoryPromotionStore } from "./memory-promotion-store.js";
import { MemoryStore } from "./memory-store.js";

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
});
