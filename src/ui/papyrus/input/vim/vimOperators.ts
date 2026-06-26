import { nextGraphemeRange } from "../../../input/cursor.js";
import type { LineEditorState } from "../../../input/lineEditor.js";
import { resolvePapyrusVimMotion, type PapyrusVimMotionKey } from "./vimMotions.js";
import { normalizeVimCursor, moveVimCursorWordEnd, moveVimCursorWordForward } from "./vimCursor.js";
import type { PapyrusVimOperator } from "./vimTypes.js";

export type PapyrusVimEditRange = {
  readonly start: number;
  readonly end: number;
};

export type PapyrusVimOperatorIntent =
  | {
      readonly type: "delete-range";
      readonly operator: "x" | "delete";
      readonly count: number;
      readonly range: PapyrusVimEditRange;
      readonly motion?: PapyrusVimMotionKey;
    }
  | {
      readonly type: "change-range";
      readonly operator: "change";
      readonly count: number;
      readonly range: PapyrusVimEditRange;
      readonly motion: PapyrusVimMotionKey;
      readonly enterInsert: true;
    };

export function resolvePapyrusVimDeleteGraphemes(
  state: LineEditorState,
  count = 1
): PapyrusVimOperatorIntent {
  const normalized = normalizeVimCursor(state);
  const normalizedCount = normalizeOperatorCount(count);
  return {
    type: "delete-range",
    operator: "x",
    count: normalizedCount,
    range: {
      start: normalized.cursor,
      end: advanceGraphemes(normalized.text, normalized.cursor, normalizedCount),
    },
  };
}

export function resolvePapyrusVimOperatorMotion(
  state: LineEditorState,
  operator: Extract<PapyrusVimOperator, "delete" | "change">,
  motion: PapyrusVimMotionKey,
  count = 1
): PapyrusVimOperatorIntent | undefined {
  const normalized = normalizeVimCursor(state);
  const normalizedCount = normalizeOperatorCount(count);
  const target =
    operator === "change" && motion === "w"
      ? resolveChangeWordTarget(normalized, normalizedCount)
      : resolvePapyrusVimMotion(normalized, motion, normalizedCount).cursor;
  const range = orderedRange(normalized.cursor, target);

  if (operator === "change") {
    return {
      type: "change-range",
      operator,
      count: normalizedCount,
      motion,
      range,
      enterInsert: true,
    };
  }

  return {
    type: "delete-range",
    operator,
    count: normalizedCount,
    motion,
    range,
  };
}

function resolveChangeWordTarget(state: LineEditorState, count: number): number {
  let current = state;
  for (let index = 1; index < count; index += 1) {
    current = moveVimCursorWordForward(current);
  }
  return moveVimCursorWordEnd(current).cursor;
}

function advanceGraphemes(text: string, cursor: number, count: number): number {
  let offset = cursor;
  for (let index = 0; index < count; index += 1) {
    const next = nextGraphemeRange(text, offset);
    if (next === undefined) break;
    offset = next.end;
  }
  return offset;
}

function orderedRange(start: number, end: number): PapyrusVimEditRange {
  return {
    start: Math.min(start, end),
    end: Math.max(start, end),
  };
}

function normalizeOperatorCount(count: number): number {
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 1;
}
