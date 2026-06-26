import {
  resetPapyrusVimCommandState,
  setPapyrusVimMode,
  type PapyrusVimCommandState,
  type PapyrusVimMode,
  type PapyrusVimOperator,
  type PapyrusVimState,
} from "./vimTypes.js";
import type { LineEditorState } from "../../../input/lineEditor.js";
import {
  isPapyrusVimMotionKey,
  resolvePapyrusVimMotion,
  type PapyrusVimMotionIntent,
  type PapyrusVimMotionKey,
} from "./vimMotions.js";
import {
  resolvePapyrusVimDeleteGraphemes,
  resolvePapyrusVimOperatorMotion,
  type PapyrusVimOperatorIntent,
} from "./vimOperators.js";

export type PapyrusVimCursorIntent = "right" | "start" | "end";

export type PapyrusVimTransitionInput =
  | { readonly type: "escape" }
  | { readonly type: "key"; readonly key: string };

export type PapyrusVimActionIntent =
  | { readonly type: "set-mode"; readonly mode: PapyrusVimMode }
  | { readonly type: "move-cursor"; readonly target: PapyrusVimCursorIntent }
  | PapyrusVimMotionIntent
  | PapyrusVimOperatorIntent
  | { readonly type: "passthrough-key"; readonly key: string }
  | { readonly type: "reset-pending-command" }
  | { readonly type: "noop" };

export type PapyrusVimTransitionResult = {
  readonly state: PapyrusVimState;
  readonly actions: readonly PapyrusVimActionIntent[];
};

export type PapyrusVimTransitionOptions = {
  readonly line?: LineEditorState;
};

const operatorByKey: Readonly<Record<string, PapyrusVimOperator>> = {
  c: "change",
  d: "delete",
  y: "yank",
};

export function transitionPapyrusVimState(
  state: PapyrusVimState,
  input: PapyrusVimTransitionInput,
  options: PapyrusVimTransitionOptions = {}
): PapyrusVimTransitionResult {
  if (input.type === "escape") {
    return transitionEscape(state);
  }

  if (state.mode === "insert") {
    return {
      state,
      actions: [{ type: "passthrough-key", key: input.key }],
    };
  }

  return transitionNormalKey(state, input.key, options);
}

function transitionEscape(state: PapyrusVimState): PapyrusVimTransitionResult {
  if (state.mode === "insert") {
    return {
      state: setPapyrusVimMode(state, "normal"),
      actions: [{ type: "set-mode", mode: "normal" }],
    };
  }

  const reset = resetPapyrusVimCommandState(state);
  return {
    state: reset,
    actions: pendingChanged(state.command, reset.command)
      ? [{ type: "reset-pending-command" }]
      : [{ type: "noop" }],
  };
}

function transitionNormalKey(
  state: PapyrusVimState,
  key: string,
  options: PapyrusVimTransitionOptions
): PapyrusVimTransitionResult {
  if (key.length !== 1) return resetNormalState(state);

  if (state.command.type === "operator") {
    return transitionPendingOperator(state, state.command, key, options);
  }

  if (isCountStart(state, key)) {
    return {
      state: {
        ...state,
        command: { type: "count", digits: key },
        countBuffer: key,
      },
      actions: [{ type: "noop" }],
    };
  }

  if (state.command.type === "count" && /^[0-9]$/u.test(key)) {
    const digits = `${state.command.digits}${key}`;
    return {
      state: {
        ...state,
        command: { type: "count", digits },
        countBuffer: digits,
      },
      actions: [{ type: "noop" }],
    };
  }

  if (isPapyrusVimMotionKey(key)) {
    return transitionMotion(state, key, options);
  }

  if (key === "x") {
    return transitionDeleteGraphemes(state, options);
  }

  const operator = operatorByKey[key];
  if (operator !== undefined) {
    return {
      state: {
        ...state,
        command: {
          type: "operator",
          operator,
          count: countFromCommand(state.command),
        },
        countBuffer: "",
      },
      actions: [{ type: "noop" }],
    };
  }

  if (key === "i") return enterInsert(state);
  if (key === "a") return enterInsert(state, { type: "move-cursor", target: "right" });
  if (key === "I") return enterInsert(state, { type: "move-cursor", target: "start" });
  if (key === "A") return enterInsert(state, { type: "move-cursor", target: "end" });

  return resetNormalState(state);
}

function transitionPendingOperator(
  state: PapyrusVimState,
  command: Extract<PapyrusVimCommandState, { type: "operator" }>,
  key: string,
  options: PapyrusVimTransitionOptions
): PapyrusVimTransitionResult {
  if (key !== "w" || options.line === undefined) {
    return resetNormalState(state);
  }

  if (command.operator !== "delete" && command.operator !== "change") {
    return resetNormalState(state);
  }

  const intent = resolvePapyrusVimOperatorMotion(
    options.line,
    command.operator,
    key,
    command.count
  );
  const reset = resetPapyrusVimCommandState(state);
  if (intent === undefined) {
    return {
      state: reset,
      actions: [{ type: "reset-pending-command" }],
    };
  }

  if (intent.type === "change-range") {
    return {
      state: setPapyrusVimMode(reset, "insert"),
      actions: [intent, { type: "set-mode", mode: "insert" }],
    };
  }

  return {
    state: reset,
    actions: [intent],
  };
}

function transitionDeleteGraphemes(
  state: PapyrusVimState,
  options: PapyrusVimTransitionOptions
): PapyrusVimTransitionResult {
  const reset = resetPapyrusVimCommandState(state);
  if (options.line === undefined) {
    return {
      state: reset,
      actions: pendingChanged(state.command, reset.command)
        ? [{ type: "reset-pending-command" }]
        : [{ type: "noop" }],
    };
  }

  return {
    state: reset,
    actions: [resolvePapyrusVimDeleteGraphemes(options.line, countFromCommand(state.command))],
  };
}

function transitionMotion(
  state: PapyrusVimState,
  key: PapyrusVimMotionKey,
  options: PapyrusVimTransitionOptions
): PapyrusVimTransitionResult {
  const reset = resetPapyrusVimCommandState(state);
  if (options.line === undefined) {
    return {
      state: reset,
      actions: pendingChanged(state.command, reset.command)
        ? [{ type: "reset-pending-command" }]
        : [{ type: "noop" }],
    };
  }

  return {
    state: reset,
    actions: [resolvePapyrusVimMotion(options.line, key, countFromCommand(state.command))],
  };
}

function enterInsert(
  state: PapyrusVimState,
  cursorAction?: Extract<PapyrusVimActionIntent, { type: "move-cursor" }>
): PapyrusVimTransitionResult {
  return {
    state: setPapyrusVimMode(state, "insert"),
    actions: [
      ...(cursorAction === undefined ? [] : [cursorAction]),
      { type: "set-mode", mode: "insert" },
    ],
  };
}

function resetNormalState(state: PapyrusVimState): PapyrusVimTransitionResult {
  const reset = resetPapyrusVimCommandState(state);
  return {
    state: reset,
    actions: pendingChanged(state.command, reset.command)
      ? [{ type: "reset-pending-command" }]
      : [{ type: "noop" }],
  };
}

function isCountStart(state: PapyrusVimState, key: string): boolean {
  return state.command.type === "idle" && /^[1-9]$/u.test(key);
}

function countFromCommand(command: PapyrusVimCommandState): number {
  if (command.type !== "count") return 1;
  const parsed = Number.parseInt(command.digits, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function pendingChanged(before: PapyrusVimCommandState, after: PapyrusVimCommandState): boolean {
  return before.type !== after.type;
}
