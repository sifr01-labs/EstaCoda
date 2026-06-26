import { describe, expect, it } from "vitest";
import { createCompositor } from "./compositor.js";
import { renderBorder } from "./renderBorder.js";

describe("Papyrus renderBorder", () => {
  it("draws single border corners and edges", () => {
    const compositor = createCompositor({ width: 6, height: 4 });
    renderBorder({ output: compositor, x: 0, y: 0, width: 6, height: 4, style: "single" });
    expect(compositor.getScreen().rowText(0)).toBe("┌────┐");
    expect(compositor.getScreen().rowText(1)).toBe("│    │");
    expect(compositor.getScreen().rowText(3)).toBe("└────┘");
  });

  it("draws double border corners and edges", () => {
    const compositor = createCompositor({ width: 5, height: 3 });
    renderBorder({ output: compositor, x: 0, y: 0, width: 5, height: 3, style: "double" });
    expect(compositor.getScreen().rowText(0)).toBe("╔═══╗");
    expect(compositor.getScreen().rowText(1)).toBe("║   ║");
    expect(compositor.getScreen().rowText(2)).toBe("╚═══╝");
  });

  it("draws round border corners and edges", () => {
    const compositor = createCompositor({ width: 5, height: 3 });
    renderBorder({ output: compositor, x: 0, y: 0, width: 5, height: 3, style: "round" });
    expect(compositor.getScreen().rowText(0)).toBe("╭───╮");
    expect(compositor.getScreen().rowText(1)).toBe("│   │");
    expect(compositor.getScreen().rowText(2)).toBe("╰───╯");
  });

  it("clips safely at screen edges", () => {
    const compositor = createCompositor({ width: 4, height: 2 });
    renderBorder({ output: compositor, x: 2, y: 0, width: 5, height: 3, style: "ascii" });
    expect(compositor.getScreen().rowText(0)).toBe("  +-");
    expect(compositor.getScreen().rowText(1)).toBe("  | ");
  });

  it("handles small dimensions without terminal writes", () => {
    const writes: Array<{ x: number; y: number; text: string }> = [];
    renderBorder({
      output: {
        write(x, y, text) {
          writes.push({ x, y, text });
          return { x: x + text.length, y };
        },
      },
      x: 1,
      y: 2,
      width: 1,
      height: 1,
    });
    expect(writes).toEqual([{ x: 1, y: 2, text: "┌" }]);
  });
});
