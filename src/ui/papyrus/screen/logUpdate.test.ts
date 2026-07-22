import { describe, expect, it } from "vitest";
import { createFrame, emptyFrame } from "./frame.js";
import { diffFrames, renderDiff } from "./logUpdate.js";
import { optimize } from "./optimizer.js";
import { createScreen } from "./screen.js";
import { writeToScreen } from "./output.js";

describe("Papyrus frame helpers", () => {
  it("creates a clean empty frame of the requested size", () => {
    const frame = emptyFrame(3, 2);
    expect(frame.viewport).toEqual({ width: 3, height: 2 });
    expect(frame.screen.rowText(0)).toBe("   ");
  });
});

describe("Papyrus logUpdate diff engine", () => {
  it("diffs empty frame to text frame as returned patches", () => {
    const prev = emptyFrame(5, 1);
    const screen = createScreen(5, 1);
    writeToScreen(screen, 0, 0, "hi");
    const diff = diffFrames(prev, createFrame(screen));
    expect(diff).toContainEqual(expect.objectContaining({ type: "cellRun", content: "hi" }));
    expect(renderDiff(diff)).toContain("hi");
  });

  it("returns no patches for identical frames", () => {
    const screen = createScreen(5, 1);
    writeToScreen(screen, 0, 0, "hi");
    const frame = createFrame(screen);
    expect(diffFrames(frame, frame)).toEqual([]);
  });

  it("diffs a single-cell change minimally", () => {
    const a = createScreen(3, 1);
    const b = createScreen(3, 1);
    writeToScreen(a, 0, 0, "abc");
    writeToScreen(b, 0, 0, "axc");
    expect(diffFrames(createFrame(a), createFrame(b))).toEqual([
      { type: "cursorTo", x: 1, y: 0 },
      expect.objectContaining({ type: "cellRun", x: 1, y: 0, content: "x" }),
    ]);
  });

  it("represents style-only changes with structured style metadata and SGR serialization", () => {
    const plain = createScreen(3, 1);
    const styled = createScreen(3, 1);
    writeToScreen(plain, 0, 0, "a");
    writeToScreen(styled, 0, 0, "\x1b[31ma");
    const diff = diffFrames(createFrame(plain), createFrame(styled));
    expect(diff).toContainEqual(expect.objectContaining({ type: "cellRun", content: "a", style: expect.objectContaining({ fg: { type: "named", name: "red" } }) }));
    expect(renderDiff(diff)).toContain("\x1b[31ma\x1b[0m");
  });

  it("serializes token-ready RGB foreground and background cell styles", () => {
    const plain = createScreen(2, 1);
    const styled = createScreen(2, 1);
    writeToScreen(styled, 0, 0, "\x1b[38;2;1;2;3;48;2;4;5;6ma");

    const diff = diffFrames(createFrame(plain), createFrame(styled));

    expect(diff).toContainEqual(expect.objectContaining({
      type: "cellRun",
      content: "a",
      style: expect.objectContaining({
        fg: { type: "rgb", r: 1, g: 2, b: 3 },
        bg: { type: "rgb", r: 4, g: 5, b: 6 }
      })
    }));
    expect(renderDiff(diff)).toContain("\x1b[38;2;1;2;3;48;2;4;5;6ma\x1b[0m");
  });

  it("represents reset/default style when changing from styled to plain", () => {
    const styled = createScreen(3, 1);
    const plain = createScreen(3, 1);
    writeToScreen(styled, 0, 0, "\x1b[31ma");
    writeToScreen(plain, 0, 0, "a");
    const diff = diffFrames(createFrame(styled), createFrame(plain));
    expect(diff).toContainEqual(expect.objectContaining({ type: "cellRun", content: "a", style: expect.objectContaining({ fg: { type: "default" } }) }));
  });

  it("does not diff equivalent styled and linked cells with different allocation order", () => {
    const left = createScreen(4, 1);
    const right = createScreen(4, 1);
    writeToScreen(left, 0, 0, "\x1b]8;;https://a.test\x07\x1b[31ma\x1b[0m\x1b]8;;\x07");
    writeToScreen(right, 1, 0, "\x1b]8;;https://b.test\x07b\x1b]8;;\x07");
    right.clearRegion({ x: 1, y: 0, width: 1, height: 1 });
    writeToScreen(right, 0, 0, "\x1b]8;;https://a.test\x07\x1b[31ma\x1b[0m\x1b]8;;\x07");
    expect(diffFrames(createFrame(left), createFrame(right))).toEqual([]);
  });

  it("represents resize as a returned full reset patch", () => {
    const prev = emptyFrame(2, 1);
    const next = emptyFrame(3, 1);
    expect(diffFrames(prev, next)[0]).toEqual({ type: "clearTerminal", reason: "resize" });
  });
});

describe("Papyrus patch optimizer", () => {
  it("removes no-op patches and merges compatible patches", () => {
    expect(
      optimize([
        { type: "stdout", content: "" },
        { type: "cursorMove", x: 0, y: 0 },
        { type: "stdout", content: "a" },
        { type: "stdout", content: "b" },
        { type: "cursorMove", x: 1, y: 0 },
        { type: "cursorMove", x: 2, y: 3 },
      ]),
    ).toEqual([
      { type: "stdout", content: "ab" },
      { type: "cursorMove", x: 3, y: 3 },
    ]);
  });
});
