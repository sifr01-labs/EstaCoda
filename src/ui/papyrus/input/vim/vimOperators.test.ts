import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createLineEditorState } from "../../../input/lineEditor.js";
import {
  resolvePapyrusVimDeleteGraphemes,
  resolvePapyrusVimOperatorMotion,
} from "./vimOperators.js";

describe("Papyrus Vim operators", () => {
  it("returns a delete range for x", () => {
    expect(resolvePapyrusVimDeleteGraphemes(createLineEditorState("abc", 1))).toEqual({
      type: "delete-range",
      operator: "x",
      count: 1,
      range: { start: 1, end: 2 },
    });
  });

  it("applies counts to x and clamps at the end", () => {
    expect(resolvePapyrusVimDeleteGraphemes(createLineEditorState("abc", 1), 2)).toEqual({
      type: "delete-range",
      operator: "x",
      count: 2,
      range: { start: 1, end: 3 },
    });
    expect(resolvePapyrusVimDeleteGraphemes(createLineEditorState("abc", 2), 9)).toEqual({
      type: "delete-range",
      operator: "x",
      count: 9,
      range: { start: 2, end: 3 },
    });
  });

  it("keeps empty input safe", () => {
    expect(resolvePapyrusVimDeleteGraphemes(createLineEditorState("", 0))).toEqual({
      type: "delete-range",
      operator: "x",
      count: 1,
      range: { start: 0, end: 0 },
    });
  });

  it("returns delete ranges for dw and counted dw", () => {
    expect(resolvePapyrusVimOperatorMotion(createLineEditorState("one two three", 0), "delete", "w")).toEqual({
      type: "delete-range",
      operator: "delete",
      count: 1,
      motion: "w",
      range: { start: 0, end: "one ".length },
    });
    expect(resolvePapyrusVimOperatorMotion(createLineEditorState("one two three four", 0), "delete", "w", 3)).toEqual({
      type: "delete-range",
      operator: "delete",
      count: 3,
      motion: "w",
      range: { start: 0, end: "one two three ".length },
    });
  });

  it("returns change ranges for cw and counted cw without trailing whitespace", () => {
    expect(resolvePapyrusVimOperatorMotion(createLineEditorState("one two three", 0), "change", "w")).toEqual({
      type: "change-range",
      operator: "change",
      count: 1,
      motion: "w",
      range: { start: 0, end: "one".length },
      enterInsert: true,
    });
    expect(resolvePapyrusVimOperatorMotion(createLineEditorState("one two three", 0), "change", "w", 2)).toEqual({
      type: "change-range",
      operator: "change",
      count: 2,
      motion: "w",
      range: { start: 0, end: "one two".length },
      enterInsert: true,
    });
  });

  it("keeps Arabic and CJK operator ranges on grapheme boundaries", () => {
    expect(resolvePapyrusVimOperatorMotion(createLineEditorState("مرحبا عالم جميل", 0), "delete", "w", 2)).toMatchObject({
      range: { start: 0, end: "مرحبا عالم ".length },
    });
    expect(resolvePapyrusVimOperatorMotion(createLineEditorState("東京 駅", 0), "change", "w")).toMatchObject({
      range: { start: 0, end: "東京".length },
    });
  });

  it("keeps emoji clusters and combining marks intact", () => {
    const family = "👨‍👩‍👧‍👦";
    const combining = "e\u0301";
    const text = `${family}${combining} x`;

    expect(resolvePapyrusVimDeleteGraphemes(createLineEditorState(text, 0))).toMatchObject({
      range: { start: 0, end: family.length },
    });
    expect(resolvePapyrusVimDeleteGraphemes(createLineEditorState(text, family.length))).toMatchObject({
      range: { start: family.length, end: family.length + combining.length },
    });
  });

  it("keeps implementation free of kill rings and live app coupling", () => {
    const source = readFileSync(fileURLToPath(new URL("./vimOperators.ts", import.meta.url)), "utf8");

    expect(source).not.toMatch(/killRing|register|clipboard|Image #|source-app|analytics/u);
    expect(source).not.toMatch(/\bsrc\/(cli|security|runtime|providers|session)\//u);
    expect(source).not.toMatch(/\bprocess\b|\bchild_process\b|\bsetRawMode\b|\bstdout\b|\bstderr\b/u);
  });
});
