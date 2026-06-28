import {
  moveCursorLeft,
  moveCursorRight,
  nextGraphemeRange,
  normalizeCursorIndex,
  previousGraphemeRange,
} from "./cursor.js";
import type { ParsedKeypress } from "./parseKeypress.js";

export type LineEditorState = {
  text: string;
  cursor: number;
};

export type LineEditorIntent =
  | {
      type: "submit";
      text: string;
    }
  | {
      type: "cancel";
    }
  | {
      type: "eof";
    };

export type LineEditorResult = {
  state: LineEditorState;
  intent?: LineEditorIntent;
};

export function createLineEditorState(text = "", cursor = text.length): LineEditorState {
  return {
    text,
    cursor: normalizeCursorIndex(text, cursor),
  };
}

export function applyKeypress(state: LineEditorState, event: ParsedKeypress): LineEditorResult {
  const normalized = createLineEditorState(state.text, state.cursor);

  if (event.type === "text") {
    return { state: insertText(normalized, event.text) };
  }

  if (event.type === "paste") {
    return { state: insertText(normalized, event.text) };
  }

  if (event.type === "unknown") {
    return { state: normalized };
  }

  if (event.key === "enter" && event.alt === true) {
    return { state: insertText(normalized, "\n") };
  }

  if (event.key === "enter") {
    return { state: normalized, intent: { type: "submit", text: normalized.text } };
  }

  if (event.ctrl === true && event.key === "c") {
    return { state: normalized, intent: { type: "cancel" } };
  }

  if (event.key === "escape") {
    return { state: normalized };
  }

  if (event.ctrl === true && event.key === "a") {
    return { state: { ...normalized, cursor: 0 } };
  }

  if (event.ctrl === true && event.key === "e") {
    return { state: { ...normalized, cursor: normalized.text.length } };
  }

  if (event.ctrl === true && event.key === "d") {
    if (normalized.text.length === 0) return { state: normalized, intent: { type: "eof" } };
    return { state: deleteNext(normalized) };
  }

  if (event.ctrl === true && event.key === "u") {
    return { state: deleteToLineStart(normalized) };
  }

  if (event.key === "left") {
    return { state: { ...normalized, cursor: moveCursorLeft(normalized.text, normalized.cursor) } };
  }

  if (event.key === "right") {
    return { state: { ...normalized, cursor: moveCursorRight(normalized.text, normalized.cursor) } };
  }

  if (event.key === "home") {
    return { state: { ...normalized, cursor: 0 } };
  }

  if (event.key === "end") {
    return { state: { ...normalized, cursor: normalized.text.length } };
  }

  if (event.key === "backspace") {
    return { state: deletePrevious(normalized) };
  }

  if (event.key === "delete") {
    return { state: deleteNext(normalized) };
  }

  return { state: normalized };
}

function insertText(state: LineEditorState, value: string): LineEditorState {
  if (value.length === 0) return state;
  const cursor = normalizeCursorIndex(state.text, state.cursor);
  const text = `${state.text.slice(0, cursor)}${value}${state.text.slice(cursor)}`;
  return {
    text,
    cursor: cursor + value.length,
  };
}

function deletePrevious(state: LineEditorState): LineEditorState {
  const previous = previousGraphemeRange(state.text, state.cursor);
  if (previous === undefined) return state;
  return {
    text: `${state.text.slice(0, previous.start)}${state.text.slice(previous.end)}`,
    cursor: previous.start,
  };
}

function deleteNext(state: LineEditorState): LineEditorState {
  const next = nextGraphemeRange(state.text, state.cursor);
  if (next === undefined) return state;
  return {
    text: `${state.text.slice(0, next.start)}${state.text.slice(next.end)}`,
    cursor: next.start,
  };
}

function deleteToLineStart(state: LineEditorState): LineEditorState {
  const cursor = normalizeCursorIndex(state.text, state.cursor);
  const lineStart = state.text.lastIndexOf("\n", cursor - 1) + 1;
  if (cursor === lineStart) return state;
  return {
    text: `${state.text.slice(0, lineStart)}${state.text.slice(cursor)}`,
    cursor: lineStart,
  };
}
