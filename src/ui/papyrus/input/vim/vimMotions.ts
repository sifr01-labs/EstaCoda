import { graphemeSpans } from "../../../input/cursor.js";
import type { LineEditorState } from "../../../input/lineEditor.js";
import {
  moveVimCursorLeft,
  moveVimCursorRight,
  moveVimCursorToEnd,
  moveVimCursorToStart,
  moveVimCursorWordBackward,
  moveVimCursorWordEnd,
  moveVimCursorWordForward,
  normalizeVimCursor,
} from "./vimCursor.js";

export type PapyrusVimMotionKey = "h" | "l" | "0" | "$" | "^" | "w" | "b" | "e";

export type PapyrusVimMotionIntent = {
  readonly type: "move-cursor-to";
  readonly motion: PapyrusVimMotionKey;
  readonly count: number;
  readonly cursor: number;
};

export function isPapyrusVimMotionKey(key: string): key is PapyrusVimMotionKey {
  return key === "h" || key === "l" || key === "0" || key === "$" || key === "^" || key === "w" || key === "b" || key === "e";
}

export function resolvePapyrusVimMotion(
  state: LineEditorState,
  motion: PapyrusVimMotionKey,
  count = 1
): PapyrusVimMotionIntent {
  const normalizedCount = normalizeMotionCount(count);
  let next = normalizeVimCursor(state);

  for (let index = 0; index < normalizedCount; index += 1) {
    const moved = applySingleMotion(next, motion);
    if (moved.cursor === next.cursor) break;
    next = moved;
  }

  return {
    type: "move-cursor-to",
    motion,
    count: normalizedCount,
    cursor: next.cursor,
  };
}

function applySingleMotion(state: LineEditorState, motion: PapyrusVimMotionKey): LineEditorState {
  switch (motion) {
    case "h":
      return moveVimCursorLeft(state);
    case "l":
      return moveVimCursorRight(state);
    case "0":
      return moveVimCursorToStart(state);
    case "$":
      return moveVimCursorToEnd(state);
    case "^":
      return moveVimCursorToFirstNonBlank(state);
    case "w":
      return moveVimCursorWordForward(state);
    case "b":
      return moveVimCursorWordBackward(state);
    case "e":
      return moveVimCursorWordEnd(state);
  }
}

function moveVimCursorToFirstNonBlank(state: LineEditorState): LineEditorState {
  const normalized = normalizeVimCursor(state);
  const firstNonBlank = graphemeSpans(normalized.text).find((span) => !/^\s+$/u.test(span.text));
  return {
    ...normalized,
    cursor: firstNonBlank?.start ?? 0,
  };
}

function normalizeMotionCount(count: number): number {
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 1;
}
