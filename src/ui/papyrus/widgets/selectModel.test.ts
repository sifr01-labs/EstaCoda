import { describe, expect, it } from "vitest";
import {
  applySelectEvent,
  applySelectKey,
  buildSelectRenderRows,
  createOptionMap,
  createSelectNavigationState,
  DuplicatePapyrusOptionValueError,
  focusFirstOption,
  focusLastOption,
  focusNextOption,
  focusNextPage,
  focusOption,
  focusPreviousOption,
  focusPreviousPage,
  getVisibleOptions,
  isFocusedInputRow,
  reconcileSelectNavigationState,
  type PapyrusOption,
} from "./index.js";

const options: Array<PapyrusOption<string>> = [
  { value: "alpha", label: "Alpha" },
  { value: "bravo", label: "Bravo", disabled: true },
  { value: "charlie", label: "Charlie" },
  { value: "delta", label: "Delta" },
  { value: "echo", label: "Echo", disabled: true },
  { value: "foxtrot", label: "Foxtrot" },
];

const optionsWithInput: Array<PapyrusOption<string>> = [
  { value: "alpha", label: "Alpha" },
  { value: "custom", label: "Custom", kind: "input", placeholder: "Type a value" },
  { value: "bravo", label: "Bravo", disabled: true },
  { value: "charlie", label: "Charlie" },
];

describe("Papyrus option map", () => {
  it("builds an ordered map and preserves original indexes", () => {
    const map = createOptionMap(options);

    expect(map.items.map((item) => item.value)).toEqual([
      "alpha",
      "bravo",
      "charlie",
      "delta",
      "echo",
      "foxtrot",
    ]);
    expect(map.get("charlie")).toMatchObject({ value: "charlie", index: 2 });
  });

  it("finds first and last enabled options", () => {
    const map = createOptionMap(options);

    expect(map.getFirstEnabled()?.value).toBe("alpha");
    expect(map.getLastEnabled()?.value).toBe("foxtrot");
  });

  it("moves next and previous while skipping disabled options", () => {
    const map = createOptionMap(options);

    expect(map.getNextEnabled("alpha")?.value).toBe("charlie");
    expect(map.getPreviousEnabled("charlie")?.value).toBe("alpha");
    expect(map.getNextEnabled("delta")?.value).toBe("foxtrot");
    expect(map.getPreviousEnabled("foxtrot")?.value).toBe("delta");
  });

  it("handles all-disabled options safely", () => {
    const map = createOptionMap([
      { value: "a", label: "A", disabled: true },
      { value: "b", label: "B", disabled: true },
    ]);

    expect(map.enabledSize).toBe(0);
    expect(map.getFirstEnabled()).toBeUndefined();
    expect(map.getLastEnabled()).toBeUndefined();
    expect(map.getNextEnabled("a")).toBeUndefined();
  });

  it("rejects duplicate values deterministically", () => {
    expect(() =>
      createOptionMap([
        { value: "same", label: "First" },
        { value: "same", label: "Second" },
      ])
    ).toThrow(DuplicatePapyrusOptionValueError);
  });
});

describe("Papyrus select navigation model", () => {
  it("sets initial focus to the requested enabled value", () => {
    const state = createSelectNavigationState(options, {
      focusedValue: "charlie",
      viewportSize: 3,
    });

    expect(state.focusedValue).toBe("charlie");
    expect(getVisibleOptions(state).map((item) => item.value)).toEqual([
      "alpha",
      "bravo",
      "charlie",
    ]);
  });

  it("falls back to the first enabled option for disabled or missing initial focus", () => {
    expect(createSelectNavigationState(options, { focusedValue: "bravo" }).focusedValue).toBe("alpha");
    expect(createSelectNavigationState(options, { focusedValue: "missing" }).focusedValue).toBe("alpha");
  });

  it("moves focus next and previous across enabled options", () => {
    let state = createSelectNavigationState(options, { viewportSize: 3 });

    state = focusNextOption(state);
    expect(state.focusedValue).toBe("charlie");

    state = focusNextOption(state);
    expect(state.focusedValue).toBe("delta");

    state = focusPreviousOption(state);
    expect(state.focusedValue).toBe("charlie");
  });

  it("wraps next and previous when wrapping is enabled", () => {
    let state = createSelectNavigationState(options, {
      focusedValue: "foxtrot",
      viewportSize: 3,
      wrap: true,
    });

    state = focusNextOption(state);
    expect(state.focusedValue).toBe("alpha");
    expect(state.viewportStart).toBe(0);

    state = focusPreviousOption(state);
    expect(state.focusedValue).toBe("foxtrot");
    expect(state.viewportStart).toBe(3);
  });

  it("does not wrap when wrapping is disabled", () => {
    let state = createSelectNavigationState(options, {
      focusedValue: "foxtrot",
      viewportSize: 3,
      wrap: false,
    });

    state = focusNextOption(state);
    expect(state.focusedValue).toBe("foxtrot");

    state = focusFirstOption(state);
    state = focusPreviousOption(state);
    expect(state.focusedValue).toBe("alpha");
  });

  it("moves by pages over enabled options", () => {
    let state = createSelectNavigationState(options, {
      viewportSize: 2,
      focusedValue: "alpha",
    });

    state = focusNextPage(state);
    expect(state.focusedValue).toBe("delta");
    expect(getVisibleOptions(state).map((item) => item.value)).toEqual(["charlie", "delta"]);

    state = focusPreviousPage(state);
    expect(state.focusedValue).toBe("alpha");
    expect(state.viewportStart).toBe(0);
  });

  it("moves to first and last enabled options", () => {
    let state = createSelectNavigationState(options, {
      focusedValue: "charlie",
      viewportSize: 3,
    });

    state = focusLastOption(state);
    expect(state.focusedValue).toBe("foxtrot");

    state = focusFirstOption(state);
    expect(state.focusedValue).toBe("alpha");
  });

  it("does not focus disabled rows", () => {
    const state = createSelectNavigationState(options, { focusedValue: "charlie" });

    expect(focusOption(state, "bravo").focusedValue).toBe("charlie");
  });

  it("preserves viewport around focused items", () => {
    let state = createSelectNavigationState(options, {
      focusedValue: "alpha",
      viewportSize: 3,
    });

    state = focusOption(state, "foxtrot");
    expect(state.focusedValue).toBe("foxtrot");
    expect(getVisibleOptions(state).map((item) => item.value)).toEqual(["delta", "echo", "foxtrot"]);

    state = focusOption(state, "charlie");
    expect(state.viewportStart).toBe(2);
  });

  it("keeps the focused row visible when the viewport shrinks", () => {
    const state = createSelectNavigationState(options, {
      focusedValue: "foxtrot",
      viewportSize: 5,
    });

    const resized = createSelectNavigationState(options, {
      focusedValue: state.focusedValue,
      selectedValue: state.selectedValue,
      inputValues: state.inputValues,
      viewportStart: state.viewportStart,
      viewportSize: 2,
      wrap: state.wrap,
    });

    expect(resized.focusedValue).toBe("foxtrot");
    expect(getVisibleOptions(resized).map((item) => item.value)).toEqual(["echo", "foxtrot"]);
  });

  it("keeps the focused row visible when the viewport grows", () => {
    const state = createSelectNavigationState(options, {
      focusedValue: "delta",
      viewportSize: 2,
    });

    const resized = createSelectNavigationState(options, {
      focusedValue: state.focusedValue,
      selectedValue: state.selectedValue,
      inputValues: state.inputValues,
      viewportStart: state.viewportStart,
      viewportSize: 5,
      wrap: state.wrap,
    });

    expect(resized.focusedValue).toBe("delta");
    expect(resized.viewportStart).toBe(1);
    expect(getVisibleOptions(resized).map((item) => item.value)).toEqual([
      "bravo",
      "charlie",
      "delta",
      "echo",
      "foxtrot",
    ]);
  });

  it("clamps viewport start when the viewport becomes larger than the option count", () => {
    const state = createSelectNavigationState(options, {
      focusedValue: "delta",
      viewportStart: 99,
      viewportSize: 99,
    });

    expect(state.viewportStart).toBe(0);
    expect(getVisibleOptions(state).map((item) => item.value)).toEqual([
      "alpha",
      "bravo",
      "charlie",
      "delta",
      "echo",
      "foxtrot",
    ]);
  });

  it("keeps disabled and all-disabled focus state safe after viewport resize", () => {
    const disabledFocused = createSelectNavigationState(options, {
      focusedValue: "bravo",
      viewportStart: 4,
      viewportSize: 2,
    });
    const resizedDisabledFocused = createSelectNavigationState(options, {
      focusedValue: disabledFocused.focusedValue,
      viewportStart: disabledFocused.viewportStart,
      viewportSize: 10,
    });

    expect(resizedDisabledFocused.focusedValue).toBe("alpha");
    expect(resizedDisabledFocused.viewportStart).toBe(0);

    const allDisabledOptions = [
      { value: "a", label: "A", disabled: true },
      { value: "b", label: "B", disabled: true },
    ];
    const allDisabled = createSelectNavigationState(allDisabledOptions, {
      focusedValue: "a",
      viewportStart: 1,
      viewportSize: 1,
    });
    const resizedAllDisabled = createSelectNavigationState(allDisabledOptions, {
      focusedValue: allDisabled.focusedValue,
      viewportStart: allDisabled.viewportStart,
      viewportSize: 5,
    });

    expect(resizedAllDisabled.focusedValue).toBeUndefined();
    expect(resizedAllDisabled.viewportStart).toBe(0);
    expect(getVisibleOptions(resizedAllDisabled).map((item) => item.value)).toEqual(["a", "b"]);
  });

  it("reconciles focus and viewport after option list changes", () => {
    const state = createSelectNavigationState(options, {
      focusedValue: "delta",
      selectedValue: "charlie",
      viewportSize: 3,
      viewportStart: 2,
    });

    const reconciled = reconcileSelectNavigationState(state, [
      { value: "alpha", label: "Alpha" },
      { value: "charlie", label: "Charlie" },
      { value: "golf", label: "Golf" },
      { value: "hotel", label: "Hotel" },
    ]);

    expect(reconciled.focusedValue).toBe("charlie");
    expect(reconciled.selectedValue).toBe("charlie");
    expect(getVisibleOptions(reconciled).map((item) => item.value)).toContain("charlie");
  });

  it("preserves input values and viewport when reconciling matching input rows", () => {
    const state = createSelectNavigationState(optionsWithInput, {
      focusedValue: "custom",
      inputValues: [["custom", "draft"]],
      viewportSize: 2,
      viewportStart: 1,
    });

    const reconciled = reconcileSelectNavigationState(state, [
      { value: "alpha", label: "Alpha" },
      { value: "custom", label: "Custom", kind: "input" },
      { value: "delta", label: "Delta" },
    ]);

    expect(reconciled.focusedValue).toBe("custom");
    expect(reconciled.inputValues.get("custom")).toBe("draft");
    expect(reconciled.viewportStart).toBe(1);
  });

  it("handles all-disabled navigation without changing focus", () => {
    const state = createSelectNavigationState([
      { value: "a", label: "A", disabled: true },
      { value: "b", label: "B", disabled: true },
    ]);

    expect(state.focusedValue).toBeUndefined();
    expect(focusNextOption(state).focusedValue).toBeUndefined();
    expect(focusPreviousPage(state).focusedValue).toBeUndefined();
  });

  it("tracks input row focus and value updates as data", () => {
    let state = createSelectNavigationState(optionsWithInput, {
      focusedValue: "custom",
      inputValues: [["custom", "initial"]],
    });

    expect(isFocusedInputRow(state)).toBe(true);

    const result = applySelectEvent(state, {
      type: "input-change",
      value: "custom",
      inputValue: "edited",
    });
    state = result.state;

    expect(result.intent).toEqual({
      type: "input-changed",
      value: "custom",
      inputValue: "edited",
    });
    expect(state.inputValues.get("custom")).toBe("edited");
  });

  it("ignores input changes for disabled or non-input rows", () => {
    const state = createSelectNavigationState(optionsWithInput);

    expect(applySelectEvent(state, {
      type: "input-change",
      value: "alpha",
      inputValue: "ignored",
    }).state).toBe(state);

    expect(applySelectEvent(state, {
      type: "input-change",
      value: "bravo",
      inputValue: "ignored",
    }).state).toBe(state);
  });
});

describe("Papyrus select key handling", () => {
  it("moves focus with arrow keys", () => {
    let state = createSelectNavigationState(optionsWithInput, { viewportSize: 3 });

    let result = applySelectKey(state, { key: "arrowDown" });
    state = result.state;

    expect(state.focusedValue).toBe("custom");
    expect(result.intent).toEqual({
      type: "input-focused",
      value: "custom",
    });

    result = applySelectKey(state, { key: "arrowDown" });
    expect(result.state.focusedValue).toBe("charlie");
    expect(result.intent).toEqual({
      type: "focus-changed",
      value: "charlie",
      inputFocused: false,
    });
  });

  it("moves focus with page, home, and end keys", () => {
    let state = createSelectNavigationState(options, {
      viewportSize: 2,
      focusedValue: "alpha",
    });

    state = applySelectKey(state, { key: "pageDown" }).state;
    expect(state.focusedValue).toBe("delta");

    state = applySelectKey(state, { key: "pageUp" }).state;
    expect(state.focusedValue).toBe("alpha");

    state = applySelectKey(state, { key: "end" }).state;
    expect(state.focusedValue).toBe("foxtrot");

    state = applySelectKey(state, { key: "home" }).state;
    expect(state.focusedValue).toBe("alpha");
  });

  it("returns selected value intent on enter", () => {
    const state = createSelectNavigationState(options, { focusedValue: "charlie" });
    const result = applySelectKey(state, { key: "enter" });

    expect(result.state.selectedValue).toBe("charlie");
    expect(result.intent).toEqual({
      type: "selected",
      value: "charlie",
    });
  });

  it("returns selected input value intent on enter for input rows", () => {
    const state = createSelectNavigationState(optionsWithInput, {
      focusedValue: "custom",
      inputValues: [["custom", "typed"]],
    });
    const result = applySelectKey(state, { key: "enter" });

    expect(result.state.selectedValue).toBe("custom");
    expect(result.intent).toEqual({
      type: "selected",
      value: "custom",
      inputValue: "typed",
    });
  });

  it("returns cancel intent on escape", () => {
    const state = createSelectNavigationState(options);

    expect(applySelectKey(state, { key: "escape" }).intent).toEqual({
      type: "cancel",
    });
  });

  it("uses tab and shift-tab for deterministic focus movement", () => {
    let state = createSelectNavigationState(optionsWithInput, {
      focusedValue: "alpha",
    });

    state = applySelectKey(state, { key: "tab" }).state;
    expect(state.focusedValue).toBe("custom");

    state = applySelectKey(state, { key: "backtab" }).state;
    expect(state.focusedValue).toBe("alpha");
  });

  it("selects enabled rows by digit shortcut and skips disabled rows", () => {
    let state = createSelectNavigationState(optionsWithInput);

    let result = applySelectKey(state, { key: "digit", digit: 2 });
    expect(result.state.selectedValue).toBe("custom");
    expect(result.intent).toEqual({
      type: "selected",
      value: "custom",
      inputValue: "",
    });

    state = result.state;
    result = applySelectKey(state, { key: "digit", digit: 3 });
    expect(result.state.selectedValue).toBe("custom");
    expect(result.intent).toBeUndefined();
  });

  it("does not trigger digit shortcuts while an input row is focused", () => {
    const state = createSelectNavigationState(optionsWithInput, {
      focusedValue: "custom",
      inputValues: [["custom", "1"]],
    });
    const result = applySelectKey(state, { key: "digit", digit: 1 });

    expect(result.state.selectedValue).toBeUndefined();
    expect(result.state.inputValues.get("custom")).toBe("1");
    expect(result.intent).toBeUndefined();
  });
});

describe("Papyrus select render rows", () => {
  it("produces inert render rows with focused, selected, disabled, and input metadata", () => {
    const state = createSelectNavigationState(optionsWithInput, {
      focusedValue: "custom",
      selectedValue: "charlie",
      inputValues: [["custom", "typed"]],
      viewportSize: 4,
    });

    expect(buildSelectRenderRows(state)).toEqual([
      {
        kind: "option",
        value: "alpha",
        label: "Alpha",
        width: 5,
        description: undefined,
        focused: false,
        selected: false,
        disabled: false,
        marker: "none",
      },
      {
        kind: "input",
        value: "custom",
        label: "Custom",
        width: 6,
        inputValue: "typed",
        placeholder: "Type a value",
        description: undefined,
        focused: true,
        selected: false,
        disabled: false,
        marker: "focused",
      },
      {
        kind: "option",
        value: "bravo",
        label: "Bravo",
        width: 5,
        description: undefined,
        focused: false,
        selected: false,
        disabled: true,
        marker: "disabled",
      },
      {
        kind: "option",
        value: "charlie",
        label: "Charlie",
        width: 7,
        description: undefined,
        focused: false,
        selected: true,
        disabled: false,
        marker: "selected",
      },
    ]);
  });

  it("uses Papyrus width measurement for Unicode labels in render rows", () => {
    const state = createSelectNavigationState([
      { value: "emoji", label: "Go 👍" },
      { value: "cjk", label: "界面" },
      { value: "ansi", label: "\u001b[31mred\u001b[0m" },
    ], { viewportSize: 3 });

    expect(buildSelectRenderRows(state).map((row) => row.width)).toEqual([5, 4, 3]);
  });

  it("preserves viewport order in render rows", () => {
    const state = createSelectNavigationState(options, {
      focusedValue: "foxtrot",
      viewportSize: 3,
    });

    expect(buildSelectRenderRows(state).map((row) => row.kind === "empty" ? row.label : row.value)).toEqual([
      "delta",
      "echo",
      "foxtrot",
    ]);
  });

  it("recalculates visible render rows after viewport size changes", () => {
    const state = createSelectNavigationState(options, {
      focusedValue: "foxtrot",
      selectedValue: "foxtrot",
      viewportSize: 2,
    });

    expect(buildSelectRenderRows(state).map((row) => row.kind === "empty" ? row.label : row.value)).toEqual([
      "echo",
      "foxtrot",
    ]);

    const resized = createSelectNavigationState(options, {
      focusedValue: state.focusedValue,
      selectedValue: state.selectedValue,
      inputValues: state.inputValues,
      viewportStart: state.viewportStart,
      viewportSize: 4,
      wrap: state.wrap,
    });

    expect(buildSelectRenderRows(resized).map((row) => row.kind === "empty" ? row.label : row.value)).toEqual([
      "charlie",
      "delta",
      "echo",
      "foxtrot",
    ]);
    expect(buildSelectRenderRows(resized).at(-1)).toMatchObject({
      value: "foxtrot",
      focused: true,
      selected: true,
    });
  });

  it("returns safe empty row data for empty option lists", () => {
    const state = createSelectNavigationState([]);

    expect(buildSelectRenderRows(state, { emptyLabel: "Nothing here" })).toEqual([
      {
        kind: "empty",
        label: "Nothing here",
        width: 12,
        focused: false,
        selected: false,
        disabled: true,
        marker: "disabled",
      },
    ]);
  });

  it("returns safe render row data for all-disabled option lists", () => {
    const state = createSelectNavigationState([
      { value: "a", label: "Alpha", disabled: true },
      { value: "b", label: "Bravo", disabled: true },
    ]);

    expect(buildSelectRenderRows(state).map((row) => ({
      kind: row.kind,
      label: row.label,
      disabled: row.disabled,
      focused: row.focused,
      marker: row.marker,
    }))).toEqual([
      { kind: "option", label: "Alpha", disabled: true, focused: false, marker: "disabled" },
      { kind: "option", label: "Bravo", disabled: true, focused: false, marker: "disabled" },
    ]);
  });
});
