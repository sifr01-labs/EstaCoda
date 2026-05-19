import { describe, expect, it } from "vitest";
import { createMemoryTool } from "./memory-tool.js";
import { MemoryStore } from "./memory-store.js";

describe("memory.curate", () => {
  it("does not accept AGENTS.md", async () => {
    const tool = createMemoryTool(new MemoryStore());

    await expect(tool.run({
      kind: "append",
      file: "AGENTS.md",
      content: "workspace instructions do not belong in memory"
    } as never)).rejects.toThrow("memory.curate does not manage AGENTS.md");
  });

  it("returns structured overflow metadata without mutating memory", async () => {
    const store = new MemoryStore({ budgets: [{ kind: "USER.md", maxChars: 10 }] });
    store.write("USER.md", "short");
    const tool = createMemoryTool(store);

    const result = await tool.run({
      kind: "append",
      file: "USER.md",
      content: "too long"
    });

    expect(result.ok).toBe(false);
    expect(result.metadata).toMatchObject({
      error: "memory-budget-overflow",
      pressure: {
        kind: "USER.md",
        state: "overflow"
      }
    });
    expect(store.read("USER.md")).toBe("short");
  });
});
