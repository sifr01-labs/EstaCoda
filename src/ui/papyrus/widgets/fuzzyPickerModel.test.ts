import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  applyFuzzyPickerKey,
  buildFuzzyPickerRenderRows,
  cancelFuzzyPicker,
  createFuzzyPickerState,
  focusedFuzzyPickerResult,
  moveFuzzyPickerFocus,
  pageFuzzyPickerFocusDown,
  pageFuzzyPickerFocusUp,
  reconcileFuzzyPickerItems,
  resizeFuzzyPickerViewport,
  selectFocusedFuzzyPickerItem,
  updateFuzzyPickerQuery,
  visibleFuzzyPickerResults,
  type FuzzyPickerItem,
} from "./index.js";

const items: Array<FuzzyPickerItem<string>> = [
  { value: "alpha", label: "Alpha", detail: "First item", keywords: ["primary"] },
  { value: "alphabet", label: "Alphabet", detail: "Letters" },
  { value: "betamax", label: "Betamax", detail: "Video format", keywords: ["retro"] },
  { value: "delta", label: "Delta", detail: "Greek letter" },
  { value: "disabled", label: "Disabled", disabled: true },
];

describe("Papyrus fuzzy picker model", () => {
  it("handles empty picker state safely", () => {
    const state = createFuzzyPickerState([], { query: "anything", viewportHeight: 4 });

    expect(state.results).toEqual([]);
    expect(state.focusedResultIndex).toBeUndefined();
    expect(visibleFuzzyPickerResults(state)).toEqual([]);
    expect(buildFuzzyPickerRenderRows(state)).toEqual([
      {
        kind: "empty",
        query: "anything",
        text: "No matches for anything",
      },
    ]);
    expect(selectFocusedFuzzyPickerItem(state).intent).toBeUndefined();
  });

  it("ranks exact before prefix before contains before subsequence", () => {
    const state = createFuzzyPickerState([
      { value: "contains", label: "xalpha" },
      { value: "subsequence", label: "a-l-p-h-a" },
      { value: "prefix", label: "alphabet" },
      { value: "exact", label: "alpha" },
    ], { query: "alpha" });

    expect(state.results.map((result) => [result.item.value, result.match.kind])).toEqual([
      ["exact", "exact"],
      ["prefix", "prefix"],
      ["contains", "contains"],
      ["subsequence", "subsequence"],
    ]);
  });

  it("preserves stable item order for equal scores", () => {
    const state = createFuzzyPickerState([
      { value: "first", label: "tools" },
      { value: "second", label: "tasks" },
      { value: "third", label: "turns" },
    ], { query: "t" });

    expect(state.results.map((result) => result.item.value)).toEqual(["first", "second", "third"]);
    expect(state.results.every((result) => result.match.kind === "prefix")).toBe(true);
  });

  it("searches case-insensitively over labels, details, and keywords", () => {
    expect(createFuzzyPickerState(items, { query: "ALPHA" }).results.map((result) => result.item.value))
      .toEqual(["alpha", "alphabet"]);
    expect(createFuzzyPickerState(items, { query: "video" }).results.map((result) => result.item.value))
      .toEqual(["betamax"]);
    expect(createFuzzyPickerState(items, { query: "PRIMARY" }).results.map((result) => result.item.value))
      .toEqual(["alpha"]);
  });

  it("resets focus on query updates and handles empty results", () => {
    let state = createFuzzyPickerState(items, { query: "", viewportHeight: 2, focusedResultIndex: 3 });

    state = updateFuzzyPickerQuery(state, "beta");
    expect(state.results.map((result) => result.item.value)).toEqual(["betamax"]);
    expect(state.focusedResultIndex).toBe(0);
    expect(focusedFuzzyPickerResult(state)?.item.value).toBe("betamax");

    state = updateFuzzyPickerQuery(state, "zzzz");
    expect(state.results).toEqual([]);
    expect(state.focusedResultIndex).toBeUndefined();
    expect(buildFuzzyPickerRenderRows(state)[0]).toMatchObject({ kind: "empty", query: "zzzz" });
  });

  it("restores safe focus when an empty query follows an empty result set", () => {
    let state = createFuzzyPickerState(items, { query: "zzzz", viewportHeight: 2 });
    expect(state.focusedResultIndex).toBeUndefined();

    state = updateFuzzyPickerQuery(state, "");
    expect(state.focusedResultIndex).toBe(0);
    expect(focusedFuzzyPickerResult(state)?.item.value).toBe("alpha");
    expect(state.viewport.scrollOffset).toBe(0);
  });

  it("moves focus up, down, page, home, and end while preserving viewport", () => {
    let state = createFuzzyPickerState(items, { query: "", viewportHeight: 2 });

    state = moveFuzzyPickerFocus(state, 1);
    expect(state.focusedResultIndex).toBe(1);
    expect(state.viewport.scrollOffset).toBe(0);

    state = moveFuzzyPickerFocus(state, 1);
    expect(state.focusedResultIndex).toBe(2);
    expect(state.viewport.scrollOffset).toBe(1);

    state = pageFuzzyPickerFocusDown(state);
    expect(state.focusedResultIndex).toBe(4);
    expect(state.viewport.scrollOffset).toBe(3);
    expect(visibleFuzzyPickerResults(state).map((result) => result.item.value)).toEqual(["delta", "disabled"]);

    state = applyFuzzyPickerKey(state, { key: "home" }).state;
    expect(state.focusedResultIndex).toBe(0);
    expect(state.viewport.scrollOffset).toBe(0);

    state = applyFuzzyPickerKey(state, { key: "end" }).state;
    expect(state.focusedResultIndex).toBe(4);
    expect(state.viewport.scrollOffset).toBe(3);

    state = pageFuzzyPickerFocusUp(state);
    expect(state.focusedResultIndex).toBe(2);
    expect(state.viewport.scrollOffset).toBe(2);
  });

  it("reconciles item list shrink and grow while preserving focused item when possible", () => {
    let state = createFuzzyPickerState(items, { query: "", viewportHeight: 2, focusedResultIndex: 2 });

    state = reconcileFuzzyPickerItems(state, [
      { value: "alpha", label: "Alpha" },
      { value: "betamax", label: "Betamax" },
      { value: "gamma", label: "Gamma" },
    ]);
    expect(focusedFuzzyPickerResult(state)?.item.value).toBe("betamax");

    state = reconcileFuzzyPickerItems(state, [{ value: "alpha", label: "Alpha" }]);
    expect(state.focusedResultIndex).toBe(0);
    expect(focusedFuzzyPickerResult(state)?.item.value).toBe("alpha");
  });

  it("keeps focused result visible after viewport resize", () => {
    let state = createFuzzyPickerState(items, { query: "", viewportHeight: 4, focusedResultIndex: 3 });

    state = resizeFuzzyPickerViewport(state, 2);
    expect(state.focusedResultIndex).toBe(3);
    expect(state.viewport.scrollOffset).toBe(2);
    expect(visibleFuzzyPickerResults(state).map((result) => result.item.value)).toEqual(["betamax", "delta"]);
  });

  it("returns selected and cancel intent data without side effects", () => {
    let state = createFuzzyPickerState(items, { query: "alpha" });

    expect(selectFocusedFuzzyPickerItem(state).intent).toEqual({
      type: "selected",
      value: "alpha",
    });

    state = createFuzzyPickerState(items, { query: "disabled" });
    expect(selectFocusedFuzzyPickerItem(state).intent).toBeUndefined();
    expect(applyFuzzyPickerKey(state, { key: "enter" }).intent).toBeUndefined();
    expect(cancelFuzzyPicker(state).intent).toEqual({ type: "cancel" });
    expect(applyFuzzyPickerKey(state, { key: "escape" }).intent).toEqual({ type: "cancel" });
  });

  it("builds inert render rows with focus, disabled, and match metadata", () => {
    const state = createFuzzyPickerState(items, { query: "dis", focusedResultIndex: 0 });

    expect(buildFuzzyPickerRenderRows(state)).toEqual([
      {
        kind: "item",
        value: "disabled",
        label: "Disabled",
        detail: undefined,
        focused: true,
        disabled: true,
        match: {
          kind: "prefix",
          score: 1,
          query: "dis",
          matchedText: "Disabled",
        },
      },
    ]);
  });

  it("keeps implementation dependency-free and uncoupled from external layers", async () => {
    const source = await readFile(new URL("./fuzzyPickerModel.ts", import.meta.url), "utf8");

    expect(source).not.toMatch(/\bfuse\.js\b|\blru-cache\b|\bchild_process\b/u);
    expect(source).not.toMatch(/\bprocess\b|\bstdout\b|\bstderr\b/u);
    expect(source).not.toMatch(/\breact\b|\bink\b|\byoga\b|\bsource-app\b/u);
    expect(source).not.toMatch(/\bsrc\/(cli|security|runtime|providers|session)\//u);
  });
});
