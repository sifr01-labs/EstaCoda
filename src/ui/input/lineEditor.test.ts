import { describe, expect, it } from "vitest";
import { isCursorAtGraphemeBoundary } from "./cursor.js";
import { applyKeypress, createLineEditorState, type LineEditorResult, type LineEditorState } from "./lineEditor.js";
import { parseKeypress, type ParsedKeypress } from "./parseKeypress.js";

function applyEvents(state: LineEditorState, events: readonly ParsedKeypress[]): LineEditorResult {
  let current = state;
  let result: LineEditorResult = { state };
  for (const event of events) {
    result = applyKeypress(current, event);
    current = result.state;
  }
  return result;
}

function applyInput(input: string, state = createLineEditorState()): LineEditorResult {
  return applyEvents(state, parseKeypress(input));
}

describe("raw input line editor", () => {
  it("inserts ASCII text and moves the cursor by grapheme", () => {
    const inserted = applyInput("abc").state;
    expect(inserted).toEqual({ text: "abc", cursor: 3 });

    const moved = applyKeypress(inserted, { type: "key", key: "left" }).state;
    expect(moved).toEqual({ text: "abc", cursor: 2 });

    const restored = applyKeypress(moved, { type: "key", key: "right" }).state;
    expect(restored).toEqual(inserted);
  });

  it("inserts Arabic text and moves without splitting characters", () => {
    const state = applyInput("سلام").state;
    expect(state).toEqual({ text: "سلام", cursor: "سلام".length });

    const moved = applyKeypress(state, { type: "key", key: "left" }).state;
    expect(moved.cursor).toBe("سلا".length);
    expect(isCursorAtGraphemeBoundary(moved.text, moved.cursor)).toBe(true);
  });

  it("keeps emoji cluster cursor movement and deletion on grapheme boundaries", () => {
    const state = applyInput("a👩🏽‍💻b").state;
    const afterB = applyKeypress(state, { type: "key", key: "left" }).state;
    const beforeEmoji = applyKeypress(afterB, { type: "key", key: "left" }).state;
    expect(beforeEmoji.cursor).toBe(1);
    expect(isCursorAtGraphemeBoundary(beforeEmoji.text, beforeEmoji.cursor)).toBe(true);

    const deleted = applyKeypress(afterB, { type: "key", key: "backspace" }).state;
    expect(deleted).toEqual({ text: "ab", cursor: 1 });
  });

  it("keeps combining marks attached during movement and deletion", () => {
    const state = applyInput("Cafe\u0301").state;
    const moved = applyKeypress(state, { type: "key", key: "left" }).state;
    expect(moved.cursor).toBe("Caf".length);

    const deleted = applyKeypress(state, { type: "key", key: "backspace" }).state;
    expect(deleted).toEqual({ text: "Caf", cursor: 3 });
  });

  it("inserts and deletes CJK graphemes", () => {
    const state = applyInput("表語").state;
    expect(state).toEqual({ text: "表語", cursor: "表語".length });

    const deleted = applyKeypress(state, { type: "key", key: "backspace" }).state;
    expect(deleted).toEqual({ text: "表", cursor: "表".length });
  });

  it("inserts text in the middle of the current value", () => {
    const state = createLineEditorState("ab", 1);
    expect(applyKeypress(state, { type: "text", text: "X" }).state).toEqual({ text: "aXb", cursor: 2 });
  });

  it("supports Home, End, Ctrl-A, and Ctrl-E", () => {
    const state = createLineEditorState("abc");
    expect(applyKeypress(state, { type: "key", key: "home" }).state.cursor).toBe(0);
    expect(applyKeypress(createLineEditorState("abc", 0), { type: "key", key: "end" }).state.cursor).toBe(3);
    expect(applyKeypress(state, { type: "key", key: "a", ctrl: true }).state.cursor).toBe(0);
    expect(applyKeypress(createLineEditorState("abc", 0), { type: "key", key: "e", ctrl: true }).state.cursor).toBe(3);
  });

  it("supports Backspace, Delete, and Ctrl-D deletion", () => {
    expect(applyKeypress(createLineEditorState("abc", 2), { type: "key", key: "backspace" }).state).toEqual({
      text: "ac",
      cursor: 1,
    });
    expect(applyKeypress(createLineEditorState("abc", 1), { type: "key", key: "delete" }).state).toEqual({
      text: "ac",
      cursor: 1,
    });
    expect(applyKeypress(createLineEditorState("abc", 1), { type: "key", key: "d", ctrl: true }).state).toEqual({
      text: "ac",
      cursor: 1,
    });
  });

  it("returns eof for Ctrl-D on an empty line without exiting", () => {
    expect(applyKeypress(createLineEditorState(), { type: "key", key: "d", ctrl: true })).toEqual({
      state: { text: "", cursor: 0 },
      intent: { type: "eof" },
    });
  });

  it("returns submit intent for Enter", () => {
    expect(applyKeypress(createLineEditorState("run"), { type: "key", key: "enter" })).toEqual({
      state: { text: "run", cursor: 3 },
      intent: { type: "submit", text: "run" },
    });
  });

  it("inserts a newline for Alt+Enter without submitting", () => {
    expect(applyKeypress(createLineEditorState("abc"), { type: "key", key: "enter", alt: true })).toEqual({
      state: { text: "abc\n", cursor: 4 },
    });
  });

  it("inserts Alt+Enter newlines at the start, middle, and end of text", () => {
    expect(applyKeypress(createLineEditorState("abc", 0), { type: "key", key: "enter", alt: true }).state).toEqual({
      text: "\nabc",
      cursor: 1,
    });
    expect(applyKeypress(createLineEditorState("abcd", 2), { type: "key", key: "enter", alt: true }).state).toEqual({
      text: "ab\ncd",
      cursor: 3,
    });
    expect(applyKeypress(createLineEditorState("abc", 3), { type: "key", key: "enter", alt: true }).state).toEqual({
      text: "abc\n",
      cursor: 4,
    });
  });

  it("keeps Unicode cursor math intact when inserting newlines", () => {
    const text = "a👩🏽‍💻b";
    const beforeB = applyKeypress(createLineEditorState(text), { type: "key", key: "left" }).state;
    const inserted = applyKeypress(beforeB, { type: "key", key: "enter", alt: true }).state;

    expect(inserted).toEqual({ text: "a👩🏽‍💻\nb", cursor: "a👩🏽‍💻\n".length });
    expect(isCursorAtGraphemeBoundary(inserted.text, inserted.cursor)).toBe(true);
  });

  it("returns cancel intent for Ctrl-C and leaves Escape to the active surface", () => {
    expect(applyKeypress(createLineEditorState("draft"), { type: "key", key: "c", ctrl: true }).intent).toEqual({
      type: "cancel",
    });
    expect(applyKeypress(createLineEditorState("draft"), { type: "key", key: "escape" })).toEqual({
      state: { text: "draft", cursor: 5 },
    });
  });

  it("deletes from the cursor back to the beginning of the line with Ctrl-U", () => {
    expect(applyKeypress(createLineEditorState("hello world", "hello wor".length), { type: "key", key: "u", ctrl: true })).toEqual({
      state: { text: "ld", cursor: 0 },
    });
    expect(applyKeypress(createLineEditorState("سلام عالم", "سلام ".length), { type: "key", key: "u", ctrl: true })).toEqual({
      state: { text: "عالم", cursor: 0 },
    });
    expect(applyKeypress(createLineEditorState("first\nsecond line", "first\nsecond".length), { type: "key", key: "u", ctrl: true })).toEqual({
      state: { text: "first\n line", cursor: "first\n".length },
    });
  });

  it("inserts bracketed paste multiline content without submitting", () => {
    const result = applyInput("\x1b[200~line one\nline two\x1b[201~");
    expect(result).toEqual({
      state: { text: "line one\nline two", cursor: "line one\nline two".length },
    });
  });

  it("ignores unknown events safely", () => {
    const state = createLineEditorState("abc", 1);
    expect(applyKeypress(state, { type: "unknown", sequence: "\x1b[999~" }).state).toEqual(state);
  });

  it("normalizes cursors that start inside a grapheme cluster", () => {
    const text = "a👩🏽‍💻b";
    const state = createLineEditorState(text, 3);
    expect(isCursorAtGraphemeBoundary(state.text, state.cursor)).toBe(true);
    expect(state.cursor).toBe(1);
  });
});
