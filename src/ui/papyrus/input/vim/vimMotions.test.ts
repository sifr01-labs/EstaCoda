import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createLineEditorState } from "../../../input/lineEditor.js";
import {
  isPapyrusVimMotionKey,
  resolvePapyrusVimMotion,
  type PapyrusVimMotionKey,
} from "./vimMotions.js";

describe("Papyrus Vim motions", () => {
  it("resolves single-line character and line motions", () => {
    const line = createLineEditorState("  one two", 4);

    expect(resolvePapyrusVimMotion(line, "h").cursor).toBe(3);
    expect(resolvePapyrusVimMotion(line, "l").cursor).toBe(5);
    expect(resolvePapyrusVimMotion(line, "0").cursor).toBe(0);
    expect(resolvePapyrusVimMotion(line, "$").cursor).toBe("  one two".length);
    expect(resolvePapyrusVimMotion(line, "^").cursor).toBe(2);
  });

  it("applies counts to motions and clamps at bounds", () => {
    const line = createLineEditorState("abcdef", 2);

    expect(resolvePapyrusVimMotion(line, "h", 2).cursor).toBe(0);
    expect(resolvePapyrusVimMotion(line, "h", 5).cursor).toBe(0);
    expect(resolvePapyrusVimMotion(line, "l", 4).cursor).toBe(6);
    expect(resolvePapyrusVimMotion(line, "l", 20).cursor).toBe(6);
  });

  it("uses one step for invalid counts", () => {
    expect(resolvePapyrusVimMotion(createLineEditorState("abc", 1), "l", 0)).toEqual({
      type: "move-cursor-to",
      motion: "l",
      count: 1,
      cursor: 2,
    });
  });

  it("resolves ASCII word motions with counts", () => {
    const line = createLineEditorState("one two three", 0);

    expect(resolvePapyrusVimMotion(line, "w").cursor).toBe("one ".length);
    expect(resolvePapyrusVimMotion(line, "w", 2).cursor).toBe("one two ".length);
    expect(resolvePapyrusVimMotion(createLineEditorState(line.text, line.text.length), "b", 2).cursor).toBe("one ".length);
    expect(resolvePapyrusVimMotion(line, "e", 2).cursor).toBe("one two".length);
  });

  it("resolves Arabic word motions", () => {
    const text = "مرحبا عالم جميل";

    expect(resolvePapyrusVimMotion(createLineEditorState(text, 0), "w", 2).cursor).toBe("مرحبا عالم ".length);
    expect(resolvePapyrusVimMotion(createLineEditorState(text, text.length), "b", 2).cursor).toBe("مرحبا ".length);
    expect(resolvePapyrusVimMotion(createLineEditorState(text, 0), "e").cursor).toBe("مرحبا".length);
  });

  it("keeps emoji clusters, combining marks, and CJK text on grapheme boundaries", () => {
    const family = "👨‍👩‍👧‍👦";
    const combining = "e\u0301";
    const cjk = "東京";
    const text = `${family} ${combining} ${cjk}`;

    expect(resolvePapyrusVimMotion(createLineEditorState(text, 0), "l").cursor).toBe(family.length);
    expect(resolvePapyrusVimMotion(createLineEditorState(text, family.length + 1), "e").cursor).toBe(`${family} ${combining}`.length);
    expect(resolvePapyrusVimMotion(createLineEditorState(text, text.length), "b").cursor).toBe(`${family} ${combining} `.length);
  });

  it("classifies the single-line MVP motion keys", () => {
    const motions: PapyrusVimMotionKey[] = ["h", "l", "0", "$", "^", "w", "b", "e"];
    expect(motions.every((motion) => isPapyrusVimMotionKey(motion))).toBe(true);
    expect(isPapyrusVimMotionKey("j")).toBe(false);
    expect(isPapyrusVimMotionKey("d")).toBe(false);
  });

  it("keeps implementation free of upstream and live app coupling", () => {
    const source = readFileSync(fileURLToPath(new URL("./vimMotions.ts", import.meta.url)), "utf8");

    expect(source).not.toMatch(/\.\.\/ink|wrapAnsi|stringWidth|killRing|Image #|source-app|analytics/u);
    expect(source).not.toMatch(/\bsrc\/(cli|security|runtime|providers|session)\//u);
    expect(source).not.toMatch(/\bprocess\b|\bchild_process\b|\bsetRawMode\b|\bstdout\b|\bstderr\b/u);
  });
});
