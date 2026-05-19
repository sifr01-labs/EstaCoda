import { describe, expect, it } from "vitest";
import { MemoryPromotionStore } from "./memory-promotion-store.js";
import { MemoryInspector, SAFETY_FILES } from "./memory-inspector.js";
import { MemoryStore } from "./memory-store.js";

describe("MemoryInspector", () => {
  it("protects SOUL.md without classifying AGENTS.md as memory safety context", () => {
    const inspector = new MemoryInspector({
      promotionStore: new MemoryPromotionStore({ path: "/tmp/estacoda-memory-inspector-test.json" }),
      memoryStore: new MemoryStore()
    });

    expect(SAFETY_FILES).toEqual(["SOUL.md"]);
    expect(inspector.isSafetyFile("SOUL.md")).toBe(true);
    expect(inspector.isSafetyFile("AGENTS.md" as never)).toBe(false);
  });
});
