import { describe, expect, it } from "vitest";
import { renderSelective, SAFETY_FILES } from "./selective-renderer.js";
import { MemoryStore } from "./memory-store.js";

describe("renderSelective", () => {
  it("does not include AGENTS.md in memory safety files", () => {
    expect(SAFETY_FILES).toEqual(["SHARED.md", "SOUL.md"]);
    expect(SAFETY_FILES).not.toContain("AGENTS.md");
  });

  it("renders SOUL.md as safety memory without any AGENTS.md memory path", () => {
    const store = new MemoryStore();
    store.write("SOUL.md", "identity context");
    store.write("USER.md", "- user preference");

    const rendered = renderSelective(store.snapshot(), [], { query: "no match" });

    expect(rendered.text).toContain("--- SOUL.md ---");
    expect(rendered.text).toContain("identity context");
    expect(rendered.text).not.toContain("AGENTS.md");
  });
});
