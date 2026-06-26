import { describe, expect, it } from "vitest";
import { createCompositor } from "./compositor.js";
import { styleIdFor } from "./output.js";
import { defaultStyle } from "../termio/types.js";

describe("Papyrus Compositor", () => {
  it("creates a screen of the requested size", () => {
    const compositor = createCompositor({ width: 6, height: 2 });
    expect(compositor.getSize()).toEqual({ width: 6, height: 2 });
    expect(compositor.getScreen().width).toBe(6);
    expect(compositor.getScreen().height).toBe(2);
  });

  it("writes plain text through Output", () => {
    const compositor = createCompositor({ width: 5, height: 1 });
    compositor.write(1, 0, "abc");
    expect(compositor.getScreen().rowText(0)).toBe(" abc ");
  });

  it("preserves ANSI style behavior supported by Output", () => {
    const compositor = createCompositor({ width: 4, height: 1 });
    compositor.write(0, 0, "\x1b[31mr\x1b[0mx");
    expect(compositor.getScreen().rowText(0)).toBe("rx  ");
    expect(compositor.getScreen().cellAt(0, 0)?.styleId).not.toBe(styleIdFor(compositor.getScreen(), defaultStyle()));
    expect(compositor.getScreen().cellAt(1, 0)?.styleId).toBe(styleIdFor(compositor.getScreen(), defaultStyle()));
  });

  it("clears a region", () => {
    const compositor = createCompositor({ width: 5, height: 1 });
    compositor.write(0, 0, "abcde");
    compositor.clear(1, 0, 3, 1);
    expect(compositor.getScreen().rowText(0)).toBe("a   e");
  });

  it("resizes by replacing the backing screen predictably", () => {
    const compositor = createCompositor({ width: 5, height: 1 });
    compositor.write(0, 0, "abc");
    const frame = compositor.resize({ width: 3, height: 2 });
    expect(compositor.getSize()).toEqual({ width: 3, height: 2 });
    expect(frame.viewport).toEqual({ width: 3, height: 2 });
    expect(compositor.getScreen().rowText(0)).toBe("   ");
  });

  it("beginFrame prepares a clean inert frame", () => {
    const compositor = createCompositor({ width: 4, height: 1 });
    compositor.write(0, 0, "text");
    const frame = compositor.beginFrame();
    expect(frame.screen.rowText(0)).toBe("    ");
    expect(compositor.getScreen().rowText(0)).toBe("    ");
  });

  it("snapshots without sharing mutable screen state", () => {
    const compositor = createCompositor({ width: 4, height: 1 });
    compositor.write(0, 0, "old");
    const frame = compositor.snapshot();
    compositor.write(0, 0, "new");
    expect(frame.screen.rowText(0)).toBe("old ");
    expect(compositor.getScreen().rowText(0)).toBe("new ");
  });
});
