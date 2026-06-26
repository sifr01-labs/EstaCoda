import {
  graphemeSpans,
  moveCursorLeft,
  moveCursorRight,
  normalizeCursorIndex,
  type GraphemeSpan,
} from "../../../input/cursor.js";
import type { LineEditorState } from "../../../input/lineEditor.js";

export type PapyrusVimCursorDirection = "left" | "right";

type VimWordKind = "word" | "punctuation" | "whitespace";

export function normalizeVimCursor(state: LineEditorState): LineEditorState {
  return {
    text: state.text,
    cursor: normalizeCursorIndex(state.text, state.cursor),
  };
}

export function clampVimCursor(text: string, cursor: number): number {
  return normalizeCursorIndex(text, cursor);
}

export function moveVimCursorLeft(state: LineEditorState): LineEditorState {
  const normalized = normalizeVimCursor(state);
  return {
    ...normalized,
    cursor: moveCursorLeft(normalized.text, normalized.cursor),
  };
}

export function moveVimCursorRight(state: LineEditorState): LineEditorState {
  const normalized = normalizeVimCursor(state);
  return {
    ...normalized,
    cursor: moveCursorRight(normalized.text, normalized.cursor),
  };
}

export function moveVimCursorToStart(state: LineEditorState): LineEditorState {
  return {
    ...normalizeVimCursor(state),
    cursor: 0,
  };
}

export function moveVimCursorToEnd(state: LineEditorState): LineEditorState {
  const normalized = normalizeVimCursor(state);
  return {
    ...normalized,
    cursor: normalized.text.length,
  };
}

export function moveVimCursorWordForward(state: LineEditorState): LineEditorState {
  const normalized = normalizeVimCursor(state);
  const spans = graphemeSpans(normalized.text);
  const currentIndex = spanIndexAtOrAfter(spans, normalized.cursor);
  if (currentIndex === undefined) return normalized;

  let index = currentIndex;
  const currentKind = kindForSpan(spans[index]!);
  if (currentKind !== "whitespace") {
    index = skipKind(spans, index, currentKind, "right");
  }
  index = skipKind(spans, index, "whitespace", "right");

  return {
    ...normalized,
    cursor: spans[index]?.start ?? normalized.text.length,
  };
}

export function moveVimCursorWordBackward(state: LineEditorState): LineEditorState {
  const normalized = normalizeVimCursor(state);
  const spans = graphemeSpans(normalized.text);
  let index = spanIndexBefore(spans, normalized.cursor);
  if (index === undefined) return normalized;

  while (index > 0 && kindForSpan(spans[index]!) === "whitespace") index -= 1;
  const targetKind = kindForSpan(spans[index]!);
  while (index > 0 && kindForSpan(spans[index - 1]!) === targetKind) index -= 1;

  return {
    ...normalized,
    cursor: spans[index]?.start ?? 0,
  };
}

export function moveVimCursorWordEnd(state: LineEditorState): LineEditorState {
  const normalized = normalizeVimCursor(state);
  const spans = graphemeSpans(normalized.text);
  let index = spanIndexAtOrAfter(spans, normalized.cursor);
  if (index === undefined) return normalized;

  if (kindForSpan(spans[index]!) !== "whitespace" && normalized.cursor < spans[index]!.end) {
    return {
      ...normalized,
      cursor: endOfKindRun(spans, index, kindForSpan(spans[index]!)),
    };
  }

  index = skipKind(spans, index, "whitespace", "right");
  const target = spans[index];
  if (target === undefined) return normalized;

  return {
    ...normalized,
    cursor: endOfKindRun(spans, index, kindForSpan(target)),
  };
}

function spanIndexAtOrAfter(spans: readonly GraphemeSpan[], cursor: number): number | undefined {
  for (const [index, span] of spans.entries()) {
    if (span.end > cursor || span.start >= cursor) return index;
  }
  return undefined;
}

function spanIndexBefore(spans: readonly GraphemeSpan[], cursor: number): number | undefined {
  let previous: number | undefined;
  for (const [index, span] of spans.entries()) {
    if (span.start >= cursor) return previous;
    previous = index;
    if (span.end >= cursor) return index;
  }
  return previous;
}

function skipKind(
  spans: readonly GraphemeSpan[],
  startIndex: number,
  kind: VimWordKind,
  direction: PapyrusVimCursorDirection
): number {
  let index = startIndex;
  while (index >= 0 && index < spans.length && kindForSpan(spans[index]!) === kind) {
    index += direction === "right" ? 1 : -1;
  }
  return index;
}

function endOfKindRun(
  spans: readonly GraphemeSpan[],
  startIndex: number,
  kind: VimWordKind
): number {
  let index = startIndex;
  while (index + 1 < spans.length && kindForSpan(spans[index + 1]!) === kind) {
    index += 1;
  }
  return spans[index]?.end ?? 0;
}

function kindForSpan(span: GraphemeSpan): VimWordKind {
  if (/^\s+$/u.test(span.text)) return "whitespace";
  if (/^[\p{L}\p{N}\p{M}_]+$/u.test(span.text)) return "word";
  return "punctuation";
}
