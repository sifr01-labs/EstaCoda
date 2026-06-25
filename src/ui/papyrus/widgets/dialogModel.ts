export type DialogAction<TValue = string> = {
  readonly value: TValue;
  readonly label: string;
  readonly description?: string;
  readonly disabled?: boolean;
};

export type DialogRow =
  | { readonly kind: "body"; readonly text: string }
  | { readonly kind: "hint"; readonly text: string };

export type DialogState<TValue = string> = {
  readonly title: string;
  readonly body?: string;
  readonly rows: readonly DialogRow[];
  readonly actions: readonly DialogAction<TValue>[];
  readonly focusedAction?: TValue;
  readonly cancelable: boolean;
};

export type DialogIntent<TValue = string> =
  | { readonly type: "action"; readonly value: TValue }
  | { readonly type: "cancel" };

export type DialogResult<TValue = string> = {
  readonly state: DialogState<TValue>;
  readonly intent?: DialogIntent<TValue>;
};

export type DialogKeyEvent = {
  readonly key: "arrowLeft" | "arrowRight" | "arrowUp" | "arrowDown" | "home" | "end" | "enter" | "escape" | "tab" | "backtab";
};

export function createDialogState<TValue = string>(input: {
  readonly title: string;
  readonly body?: string;
  readonly rows?: readonly DialogRow[];
  readonly actions: readonly DialogAction<TValue>[];
  readonly focusedAction?: TValue;
  readonly cancelable?: boolean;
}): DialogState<TValue> {
  const focusedAction = enabledAction(input.actions, input.focusedAction)?.value
    ?? firstEnabledAction(input.actions)?.value;
  return {
    title: input.title,
    body: input.body,
    rows: input.rows ?? [],
    actions: input.actions,
    focusedAction,
    cancelable: input.cancelable ?? true,
  };
}

export function applyDialogKey<TValue = string>(
  state: DialogState<TValue>,
  event: DialogKeyEvent
): DialogResult<TValue> {
  switch (event.key) {
    case "arrowRight":
    case "arrowDown":
    case "tab":
      return { state: focusDialogAction(state, "next") };
    case "arrowLeft":
    case "arrowUp":
    case "backtab":
      return { state: focusDialogAction(state, "previous") };
    case "home":
      return { state: setFocusedDialogAction(state, firstEnabledAction(state.actions)?.value) };
    case "end":
      return { state: setFocusedDialogAction(state, lastEnabledAction(state.actions)?.value) };
    case "enter":
      return submitDialogAction(state);
    case "escape":
      return state.cancelable ? { state, intent: { type: "cancel" } } : { state };
  }
}

export function setFocusedDialogAction<TValue>(
  state: DialogState<TValue>,
  value: TValue | undefined
): DialogState<TValue> {
  const action = enabledAction(state.actions, value);
  if (action === undefined) return state;
  return {
    ...state,
    focusedAction: action.value,
  };
}

function focusDialogAction<TValue>(
  state: DialogState<TValue>,
  direction: "next" | "previous"
): DialogState<TValue> {
  const enabledActions = state.actions.filter((action) => action.disabled !== true);
  if (enabledActions.length === 0) return state;
  const currentIndex = enabledActions.findIndex((action) => action.value === state.focusedAction);
  const fallbackIndex = direction === "next" ? 0 : enabledActions.length - 1;
  const nextIndex = currentIndex < 0
    ? fallbackIndex
    : direction === "next"
      ? (currentIndex + 1) % enabledActions.length
      : (currentIndex - 1 + enabledActions.length) % enabledActions.length;
  return {
    ...state,
    focusedAction: enabledActions[nextIndex]?.value,
  };
}

function submitDialogAction<TValue>(state: DialogState<TValue>): DialogResult<TValue> {
  const action = enabledAction(state.actions, state.focusedAction);
  if (action === undefined) return { state };
  return {
    state,
    intent: {
      type: "action",
      value: action.value,
    },
  };
}

function enabledAction<TValue>(
  actions: readonly DialogAction<TValue>[],
  value: TValue | undefined
): DialogAction<TValue> | undefined {
  if (value === undefined) return undefined;
  return actions.find((action) => action.value === value && action.disabled !== true);
}

function firstEnabledAction<TValue>(
  actions: readonly DialogAction<TValue>[]
): DialogAction<TValue> | undefined {
  return actions.find((action) => action.disabled !== true);
}

function lastEnabledAction<TValue>(
  actions: readonly DialogAction<TValue>[]
): DialogAction<TValue> | undefined {
  return [...actions].reverse().find((action) => action.disabled !== true);
}
