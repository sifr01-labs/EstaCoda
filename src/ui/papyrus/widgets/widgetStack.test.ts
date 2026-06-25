import { describe, expect, it } from "vitest";
import {
  applyDialogKey,
  applyMultiSelectKey,
  applyOverlayEscape,
  cancelMultiSelect,
  createDialogState,
  createMultiSelectState,
  createOverlayStack,
  dispatchToTopOverlay,
  popOverlay,
  pushOverlay,
  submitMultiSelect,
  toggleFocusedMultiSelectOption,
  toggleMultiSelectValue,
  topOverlay,
  type DialogAction,
  type PapyrusOption,
} from "./index.js";

const options: Array<PapyrusOption<string>> = [
  { value: "alpha", label: "Alpha" },
  { value: "bravo", label: "Bravo", disabled: true },
  { value: "charlie", label: "Charlie" },
  { value: "custom", label: "Custom", kind: "input" },
];

describe("Papyrus multi-select model", () => {
  it("toggles focused options and returns intent data", () => {
    let state = createMultiSelectState(options, { focusedValue: "alpha" });

    const selected = toggleFocusedMultiSelectOption(state);
    state = selected.state;

    expect(state.selectedValues).toEqual(["alpha"]);
    expect(selected.intent).toEqual({
      type: "toggled",
      value: "alpha",
      selected: true,
    });

    const unselected = toggleFocusedMultiSelectOption(state);
    expect(unselected.state.selectedValues).toEqual([]);
    expect(unselected.intent).toEqual({
      type: "toggled",
      value: "alpha",
      selected: false,
    });
  });

  it("skips disabled options and prevents disabled selections", () => {
    const state = createMultiSelectState(options, {
      focusedValue: "bravo",
      selectedValues: ["bravo", "charlie"],
    });

    expect(state.navigation.focusedValue).toBe("alpha");
    expect(state.selectedValues).toEqual(["charlie"]);
    expect(toggleMultiSelectValue(state, "bravo").state.selectedValues).toEqual(["charlie"]);
    expect(toggleMultiSelectValue(state, "bravo").intent).toBeUndefined();
  });

  it("submits selected values in option order and cancels as intent data", () => {
    const state = createMultiSelectState(options, {
      selectedValues: ["charlie", "alpha"],
    });

    expect(state.selectedValues).toEqual(["alpha", "charlie"]);
    expect(submitMultiSelect(state).intent).toEqual({
      type: "submitted",
      values: ["alpha", "charlie"],
    });
    expect(cancelMultiSelect(state).intent).toEqual({
      type: "cancel",
    });
  });

  it("enforces min and max selection bounds when configured", () => {
    let state = createMultiSelectState(options, {
      selectedValues: ["alpha"],
      minSelections: 1,
      maxSelections: 2,
    });

    expect(toggleMultiSelectValue(state, "alpha").state.selectedValues).toEqual(["alpha"]);

    state = toggleMultiSelectValue(state, "charlie").state;
    expect(state.selectedValues).toEqual(["alpha", "charlie"]);
    expect(toggleMultiSelectValue(state, "custom").state.selectedValues).toEqual(["alpha", "charlie"]);
  });

  it("keeps input rows as inert selectable model data", () => {
    const state = createMultiSelectState(options, { focusedValue: "custom" });
    const result = applyMultiSelectKey(state, { key: "enter" });

    expect(result.intent).toEqual({
      type: "submitted",
      values: [],
    });

    const toggled = applyMultiSelectKey(state, { key: "digit", digit: 4 });
    expect(toggled.intent).toEqual({
      type: "toggled",
      value: "custom",
      selected: true,
    });
  });
});

describe("Papyrus dialog model", () => {
  const actions: Array<DialogAction<string>> = [
    { value: "yes", label: "Yes" },
    { value: "later", label: "Later", disabled: true },
    { value: "no", label: "No" },
  ];

  it("focuses enabled action rows deterministically", () => {
    let state = createDialogState({
      title: "Confirm",
      body: "Pick one.",
      rows: [{ kind: "hint", text: "Use arrows." }],
      actions,
      focusedAction: "later",
    });

    expect(state.focusedAction).toBe("yes");

    state = applyDialogKey(state, { key: "arrowRight" }).state;
    expect(state.focusedAction).toBe("no");

    state = applyDialogKey(state, { key: "arrowRight" }).state;
    expect(state.focusedAction).toBe("yes");

    state = applyDialogKey(state, { key: "end" }).state;
    expect(state.focusedAction).toBe("no");

    state = applyDialogKey(state, { key: "home" }).state;
    expect(state.focusedAction).toBe("yes");
  });

  it("returns action and cancel intents without approval semantics", () => {
    const state = createDialogState({
      title: "Confirm",
      actions,
      focusedAction: "no",
    });

    expect(applyDialogKey(state, { key: "enter" }).intent).toEqual({
      type: "action",
      value: "no",
    });
    expect(applyDialogKey(state, { key: "escape" }).intent).toEqual({
      type: "cancel",
    });
  });

  it("does not select disabled actions and honors non-cancelable dialogs", () => {
    const state = createDialogState({
      title: "Required",
      actions,
      focusedAction: "later",
      cancelable: false,
    });

    expect(state.focusedAction).toBe("yes");
    expect(applyDialogKey(state, { key: "escape" }).intent).toBeUndefined();
  });
});

describe("Papyrus overlay stack", () => {
  it("pushes, pops, and exposes the top overlay", () => {
    let stack = createOverlayStack();

    const first = pushOverlay(stack, { id: "select", kind: "select" });
    stack = first.state;
    expect(first.intent).toEqual({
      type: "pushed",
      overlay: { id: "select", kind: "select" },
    });

    stack = pushOverlay(stack, { id: "dialog", kind: "dialog" }).state;
    expect(topOverlay(stack)).toEqual({ id: "dialog", kind: "dialog" });

    const popped = popOverlay(stack);
    expect(popped.intent).toEqual({
      type: "popped",
      overlay: { id: "dialog", kind: "dialog" },
    });
    expect(topOverlay(popped.state)).toEqual({ id: "select", kind: "select" });
  });

  it("routes events only to the topmost overlay", () => {
    const stack = createOverlayStack([
      { id: "under", kind: "select" },
      { id: "top", kind: "dialog" },
    ]);
    const seen: string[] = [];

    const result = dispatchToTopOverlay(stack, { key: "enter" }, (overlay, event) => {
      seen.push(`${overlay.id}:${event.key}`);
      return { handledBy: overlay.id };
    });

    expect(seen).toEqual(["top:enter"]);
    expect(result.intent).toEqual({
      type: "captured",
      overlay: { id: "top", kind: "dialog" },
      intent: { handledBy: "top" },
    });
  });

  it("blocks non-dismissible pop unless forced and handles escape deterministically", () => {
    const stack = createOverlayStack([
      { id: "required", kind: "dialog", dismissible: false },
    ]);

    const blocked = applyOverlayEscape(stack);
    expect(blocked.state).toBe(stack);
    expect(blocked.intent).toEqual({
      type: "blocked",
      reason: "required-overlay",
    });

    const forced = popOverlay(stack, { force: true });
    expect(forced.state.overlays).toEqual([]);
    expect(forced.intent).toEqual({
      type: "popped",
      overlay: { id: "required", kind: "dialog", dismissible: false },
    });
  });

  it("returns blocked intent for empty stacks", () => {
    const stack = createOverlayStack();

    expect(popOverlay(stack).intent).toEqual({
      type: "blocked",
      reason: "empty",
    });
    expect(dispatchToTopOverlay(stack, "event", () => "nope").intent).toEqual({
      type: "blocked",
      reason: "empty",
    });
  });
});
