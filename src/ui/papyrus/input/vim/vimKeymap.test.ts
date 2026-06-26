import { describe, expect, it } from "vitest";
import { createLineEditorState } from "../../../input/lineEditor.js";
import {
  applyPapyrusVimKeymap,
  createPapyrusVimKeymapState,
  type PapyrusVimKeymapState,
} from "./vimKeymap.js";

function text(state: PapyrusVimKeymapState, lineText: string, cursor: number, value: string) {
  return applyPapyrusVimKeymap(state, createLineEditorState(lineText, cursor), {
    type: "text",
    text: value,
  });
}

function escape(state: PapyrusVimKeymapState, lineText: string, cursor: number) {
  return applyPapyrusVimKeymap(state, createLineEditorState(lineText, cursor), {
    type: "key",
    key: "escape",
  });
}

describe("Papyrus Vim keymap adapter", () => {
  it("starts in insert mode and passes through text", () => {
    const result = text(createPapyrusVimKeymapState(), "", 0, "abc");

    expect(result.handled).toBe(true);
    expect(result.state.vim.mode).toBe("insert");
    expect(result.line).toEqual({ text: "abc", cursor: 3 });
  });

  it("transitions between insert and normal modes", () => {
    const normal = escape(createPapyrusVimKeymapState(), "abc", 3);
    const insert = text(normal.state, normal.line.text, normal.line.cursor, "i");

    expect(normal.state.vim.mode).toBe("normal");
    expect(insert.state.vim.mode).toBe("insert");
    expect(insert.line).toEqual({ text: "abc", cursor: 3 });
  });

  it("applies insert transitions i, a, I, and A", () => {
    const normal = createPapyrusVimKeymapState("normal");

    expect(text(normal, "ab", 1, "i").line.cursor).toBe(1);
    expect(text(normal, "ab", 0, "a").line.cursor).toBe(1);
    expect(text(normal, "ab", 2, "I").line.cursor).toBe(0);
    expect(text(normal, "ab", 0, "A").line.cursor).toBe(2);
  });

  it("applies motions and counts without mutating input", () => {
    const normal = createPapyrusVimKeymapState("normal");
    const line = createLineEditorState("one two three", 0);
    const result = applyPapyrusVimKeymap(normal, line, { type: "text", text: "2w" });

    expect(line).toEqual({ text: "one two three", cursor: 0 });
    expect(result.line.cursor).toBe("one two ".length);
    expect(result.state.vim.mode).toBe("normal");
  });

  it("applies x, dw, and cw edit intents", () => {
    const normal = createPapyrusVimKeymapState("normal");

    expect(text(normal, "abc", 0, "x").line).toEqual({ text: "bc", cursor: 0 });
    expect(text(normal, "one two", 0, "dw").line).toEqual({ text: "two", cursor: 0 });

    const change = text(normal, "one two", 0, "cw");
    expect(change.line).toEqual({ text: " two", cursor: 0 });
    expect(change.state.vim.mode).toBe("insert");
  });

  it("keeps unsupported operator motions as reset-only no-ops", () => {
    const normal = createPapyrusVimKeymapState("normal");

    expect(text(normal, "one two", 0, "dh").line).toEqual({ text: "one two", cursor: 0 });
    expect(text(normal, "one two", 0, "c$").line).toEqual({ text: "one two", cursor: 0 });
  });

  it("keeps Unicode cursor math and ranges grapheme safe", () => {
    const family = "👨‍👩‍👧‍👦";
    const combining = "e\u0301";
    const arabic = "مرحبا عالم";
    const cjk = "東京 駅";
    const normal = createPapyrusVimKeymapState("normal");

    expect(text(normal, `${family}x`, 0, "l").line.cursor).toBe(family.length);
    expect(text(normal, `${combining}x`, 0, "x").line).toEqual({ text: "x", cursor: 0 });
    expect(text(normal, arabic, 0, "dw").line).toEqual({ text: "عالم", cursor: 0 });
    expect(text(normal, cjk, 0, "cw").line).toEqual({ text: " 駅", cursor: 0 });
  });

  it("defers Enter and Ctrl-C to prompt invariants", () => {
    const normal = createPapyrusVimKeymapState("normal");

    expect(applyPapyrusVimKeymap(normal, createLineEditorState("abc", 3), {
      type: "key",
      key: "enter",
    }).handled).toBe(false);
    expect(applyPapyrusVimKeymap(normal, createLineEditorState("abc", 3), {
      type: "key",
      key: "c",
      ctrl: true,
    }).handled).toBe(false);
  });
});
