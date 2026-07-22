import { applyKeypress, createLineEditorState, type LineEditorState } from "../../../input/lineEditor.js";
import type { ParsedKeypress } from "../../../input/parseKeypress.js";
import {
  moveVimCursorRight,
  moveVimCursorToEnd,
  moveVimCursorToStart,
} from "./vimCursor.js";
import {
  createInitialPapyrusVimState,
  type PapyrusVimState,
} from "./vimTypes.js";
import {
  transitionPapyrusVimState,
  type PapyrusVimActionIntent,
} from "./vimStateMachine.js";

export type PapyrusVimKeymapState = {
  readonly vim: PapyrusVimState;
};

export type PapyrusVimKeymapResult = {
  readonly state: PapyrusVimKeymapState;
  readonly line: LineEditorState;
  readonly handled: boolean;
};

export function createPapyrusVimKeymapState(mode: PapyrusVimState["mode"] = "insert"): PapyrusVimKeymapState {
  return {
    vim: createInitialPapyrusVimState(mode),
  };
}

export function applyPapyrusVimKeymap(
  keymapState: PapyrusVimKeymapState,
  line: LineEditorState,
  event: ParsedKeypress
): PapyrusVimKeymapResult {
  if (shouldDeferToPromptInvariant(event)) {
    return {
      state: keymapState,
      line,
      handled: false,
    };
  }

  if (event.type === "paste" || event.type === "unknown" || event.type === "mouse") {
    if (keymapState.vim.mode === "insert") {
      const result = applyKeypress(line, event);
      return {
        state: keymapState,
        line: result.state,
        handled: true,
      };
    }
    return {
      state: keymapState,
      line,
      handled: true,
    };
  }

  if (event.type === "text") {
    return applyTextEvent(keymapState, line, event.text);
  }

  return applySpecialKeyEvent(keymapState, line, event);
}

function applyTextEvent(
  keymapState: PapyrusVimKeymapState,
  line: LineEditorState,
  text: string
): PapyrusVimKeymapResult {
  if (keymapState.vim.mode === "insert") {
    return applyTransition(keymapState, line, text);
  }

  let nextState = keymapState;
  let nextLine = line;
  for (const key of graphemes(text)) {
    const result = applyTransition(nextState, nextLine, key);
    nextState = result.state;
    nextLine = result.line;
  }

  return {
    state: nextState,
    line: nextLine,
    handled: true,
  };
}

function applySpecialKeyEvent(
  keymapState: PapyrusVimKeymapState,
  line: LineEditorState,
  event: Extract<ParsedKeypress, { type: "key" }>
): PapyrusVimKeymapResult {
  if (event.key === "escape") {
    const transition = transitionPapyrusVimState(keymapState.vim, { type: "escape" }, { line });
    return applyActions({ vim: transition.state }, line, transition.actions, true);
  }

  if (keymapState.vim.mode === "insert") {
    return {
      state: keymapState,
      line,
      handled: false,
    };
  }

  return {
    state: keymapState,
    line,
    handled: true,
  };
}

function applyTransition(
  keymapState: PapyrusVimKeymapState,
  line: LineEditorState,
  key: string
): PapyrusVimKeymapResult {
  const transition = transitionPapyrusVimState(keymapState.vim, { type: "key", key }, { line });
  return applyActions({ vim: transition.state }, line, transition.actions, true);
}

function applyActions(
  keymapState: PapyrusVimKeymapState,
  line: LineEditorState,
  actions: readonly PapyrusVimActionIntent[],
  handled: boolean
): PapyrusVimKeymapResult {
  let nextLine = line;

  for (const action of actions) {
    if (action.type === "passthrough-key") {
      nextLine = insertText(nextLine, action.key);
    } else if (action.type === "move-cursor") {
      nextLine = applyNamedCursorIntent(nextLine, action.target);
    } else if (action.type === "move-cursor-to") {
      nextLine = createLineEditorState(nextLine.text, action.cursor);
    } else if (action.type === "delete-range" || action.type === "change-range") {
      nextLine = applyEditRange(nextLine, action.range.start, action.range.end);
    }
  }

  return {
    state: keymapState,
    line: nextLine,
    handled,
  };
}

function applyNamedCursorIntent(
  line: LineEditorState,
  target: "right" | "start" | "end"
): LineEditorState {
  if (target === "right") return moveVimCursorRight(line);
  if (target === "start") return moveVimCursorToStart(line);
  return moveVimCursorToEnd(line);
}

function insertText(line: LineEditorState, text: string): LineEditorState {
  if (text.length === 0) return line;
  const normalized = createLineEditorState(line.text, line.cursor);
  return createLineEditorState(
    `${normalized.text.slice(0, normalized.cursor)}${text}${normalized.text.slice(normalized.cursor)}`,
    normalized.cursor + text.length
  );
}

function applyEditRange(line: LineEditorState, start: number, end: number): LineEditorState {
  const normalized = createLineEditorState(line.text, line.cursor);
  const boundedStart = Math.max(0, Math.min(normalized.text.length, start));
  const boundedEnd = Math.max(boundedStart, Math.min(normalized.text.length, end));
  return createLineEditorState(
    `${normalized.text.slice(0, boundedStart)}${normalized.text.slice(boundedEnd)}`,
    boundedStart
  );
}

function shouldDeferToPromptInvariant(event: ParsedKeypress): boolean {
  return event.type === "key"
    && (event.key === "enter" || (event.ctrl === true && event.key === "c"));
}

function graphemes(text: string): string[] {
  if (text.length === 0) return [];
  if (typeof Intl.Segmenter === "function") {
    return Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), (segment) => segment.segment);
  }
  return Array.from(text);
}
