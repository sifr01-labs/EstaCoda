import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createLineEditorState } from "../../../input/lineEditor.js";
import {
  clampVimCursor,
  moveVimCursorLeft,
  moveVimCursorRight,
  moveVimCursorToEnd,
  moveVimCursorToStart,
  moveVimCursorWordBackward,
  moveVimCursorWordEnd,
  moveVimCursorWordForward,
  normalizeVimCursor,
} from "./vimCursor.js";

describe("Papyrus Vim cursor adapter", () => {
  it("clamps cursor positions safely", () => {
    expect(clampVimCursor("abc", -10)).toBe(0);
    expect(clampVimCursor("abc", 99)).toBe(3);
    expect(normalizeVimCursor({ text: "abc", cursor: 99 })).toEqual({ text: "abc", cursor: 3 });
  });

  it("moves left and right by grapheme", () => {
    expect(moveVimCursorLeft(createLineEditorState("abc", 2))).toEqual({ text: "abc", cursor: 1 });
    expect(moveVimCursorRight(createLineEditorState("abc", 1))).toEqual({ text: "abc", cursor: 2 });
  });

  it("moves to start and end", () => {
    expect(moveVimCursorToStart(createLineEditorState("abc", 2))).toEqual({ text: "abc", cursor: 0 });
    expect(moveVimCursorToEnd(createLineEditorState("abc", 1))).toEqual({ text: "abc", cursor: 3 });
  });

  it("moves across ASCII word starts and ends", () => {
    expect(moveVimCursorWordForward(createLineEditorState("one two", 0)).cursor).toBe(4);
    expect(moveVimCursorWordBackward(createLineEditorState("one two", 7)).cursor).toBe(4);
    expect(moveVimCursorWordEnd(createLineEditorState("one two", 0)).cursor).toBe(3);
    expect(moveVimCursorWordEnd(createLineEditorState("one two", 3)).cursor).toBe(7);
  });

  it("moves across Arabic words", () => {
    const text = "مرحبا عالم";
    expect(moveVimCursorWordForward(createLineEditorState(text, 0)).cursor).toBe("مرحبا ".length);
    expect(moveVimCursorWordBackward(createLineEditorState(text, text.length)).cursor).toBe("مرحبا ".length);
    expect(moveVimCursorWordEnd(createLineEditorState(text, 0)).cursor).toBe("مرحبا".length);
  });

  it("does not split emoji clusters", () => {
    const family = "👨‍👩‍👧‍👦";
    const text = `a${family}b`;

    expect(moveVimCursorRight(createLineEditorState(text, 1)).cursor).toBe(1 + family.length);
    expect(moveVimCursorLeft(createLineEditorState(text, 1 + family.length)).cursor).toBe(1);
    expect(clampVimCursor(text, 3)).toBe(1);
  });

  it("does not split combining marks", () => {
    const accented = "e\u0301";
    const text = `${accented}clair cafe`;

    expect(moveVimCursorRight(createLineEditorState(text, 0)).cursor).toBe(accented.length);
    expect(moveVimCursorWordEnd(createLineEditorState(text, 0)).cursor).toBe("e\u0301clair".length);
    expect(clampVimCursor(text, 1)).toBe(0);
  });

  it("moves through CJK text without mid-grapheme offsets", () => {
    const text = "東京 駅";

    expect(moveVimCursorRight(createLineEditorState(text, 0)).cursor).toBe("東".length);
    expect(moveVimCursorWordForward(createLineEditorState(text, 0)).cursor).toBe("東京 ".length);
    expect(moveVimCursorWordBackward(createLineEditorState(text, text.length)).cursor).toBe("東京 ".length);
    expect(moveVimCursorWordEnd(createLineEditorState(text, 0)).cursor).toBe("東京".length);
  });

  it("keeps implementation free of upstream and live app coupling", () => {
    const source = readFileSync(fileURLToPath(new URL("./vimCursor.ts", import.meta.url)), "utf8");
    const types = readFileSync(fileURLToPath(new URL("./vimTypes.ts", import.meta.url)), "utf8");
    const combined = `${source}\n${types}`;

    expect(combined).not.toMatch(/\.\.\/ink|wrapAnsi|stringWidth|killRing|Image #|source-app|analytics/u);
    expect(combined).not.toMatch(/\bsrc\/(cli|security|runtime|providers|session)\//u);
    expect(combined).not.toMatch(/\bprocess\b|\bchild_process\b|\bsetRawMode\b|\bstdout\b|\bstderr\b/u);
  });
});
