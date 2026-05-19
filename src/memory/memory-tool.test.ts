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
});
