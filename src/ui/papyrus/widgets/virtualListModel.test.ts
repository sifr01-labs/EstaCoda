import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  createVirtualListState,
  focusVirtualListFirst,
  focusVirtualListLast,
  getVirtualListRange,
  moveVirtualListFocus,
  pageVirtualListFocusDown,
  pageVirtualListFocusUp,
  reconcileVirtualListItemCount,
  resizeVirtualListViewport,
  setVirtualListFocus,
} from "./index.js";

describe("Papyrus virtual list model", () => {
  it("calculates visible ranges without row materialization", () => {
    const state = createVirtualListState({ itemCount: 1_000, viewportHeight: 10, scrollOffset: 25 });

    expect(getVirtualListRange(state)).toEqual({
      start: 25,
      end: 35,
      count: 10,
    });
  });

  it("handles empty lists safely", () => {
    const state = createVirtualListState({
      itemCount: 0,
      viewportHeight: 5,
      scrollOffset: 10,
      focusedIndex: 4,
    });

    expect(state).toEqual({
      itemCount: 0,
      viewportHeight: 5,
      scrollOffset: 0,
      focusedIndex: undefined,
    });
    expect(getVirtualListRange(state)).toEqual({ start: 0, end: 0, count: 0 });
    expect(moveVirtualListFocus(state, 1)).toEqual(state);
  });

  it("moves focus up, down, home, and end while preserving visibility", () => {
    let state = createVirtualListState({ itemCount: 20, viewportHeight: 4, focusedIndex: 0 });

    state = moveVirtualListFocus(state, 3);
    expect(state.focusedIndex).toBe(3);
    expect(state.scrollOffset).toBe(0);
    expect(getVirtualListRange(state)).toEqual({ start: 0, end: 4, count: 4 });

    state = moveVirtualListFocus(state, 1);
    expect(state.focusedIndex).toBe(4);
    expect(state.scrollOffset).toBe(1);
    expect(getVirtualListRange(state)).toEqual({ start: 1, end: 5, count: 4 });

    state = moveVirtualListFocus(state, -4);
    expect(state.focusedIndex).toBe(0);
    expect(state.scrollOffset).toBe(0);

    state = focusVirtualListLast(state);
    expect(state.focusedIndex).toBe(19);
    expect(state.scrollOffset).toBe(16);

    state = focusVirtualListFirst(state);
    expect(state.focusedIndex).toBe(0);
    expect(state.scrollOffset).toBe(0);
  });

  it("pages focus through the list with clamped boundaries", () => {
    let state = createVirtualListState({ itemCount: 12, viewportHeight: 5, focusedIndex: 2 });

    state = pageVirtualListFocusDown(state);
    expect(state.focusedIndex).toBe(7);
    expect(state.scrollOffset).toBe(3);

    state = pageVirtualListFocusDown(state);
    expect(state.focusedIndex).toBe(11);
    expect(state.scrollOffset).toBe(7);

    state = pageVirtualListFocusUp(state);
    expect(state.focusedIndex).toBe(6);
    expect(state.scrollOffset).toBe(6);

    state = pageVirtualListFocusUp(state);
    expect(state.focusedIndex).toBe(1);
    expect(state.scrollOffset).toBe(1);

    state = pageVirtualListFocusUp(state);
    expect(state.focusedIndex).toBe(0);
    expect(state.scrollOffset).toBe(0);
  });

  it("reconciles item count shrink and grow deterministically", () => {
    let state = createVirtualListState({
      itemCount: 10,
      viewportHeight: 3,
      focusedIndex: 8,
    });

    state = reconcileVirtualListItemCount(state, 5);
    expect(state.focusedIndex).toBe(4);
    expect(state.scrollOffset).toBe(2);
    expect(getVirtualListRange(state)).toEqual({ start: 2, end: 5, count: 3 });

    state = reconcileVirtualListItemCount(state, 20);
    expect(state.focusedIndex).toBe(4);
    expect(state.scrollOffset).toBe(2);
  });

  it("keeps focused item visible when viewport size changes", () => {
    let state = createVirtualListState({
      itemCount: 10,
      viewportHeight: 5,
      scrollOffset: 2,
      focusedIndex: 6,
    });

    state = resizeVirtualListViewport(state, 3);
    expect(state.focusedIndex).toBe(6);
    expect(state.scrollOffset).toBe(4);
    expect(getVirtualListRange(state)).toEqual({ start: 4, end: 7, count: 3 });

    state = resizeVirtualListViewport(state, 8);
    expect(state.focusedIndex).toBe(6);
    expect(state.scrollOffset).toBe(2);
    expect(getVirtualListRange(state)).toEqual({ start: 2, end: 10, count: 8 });
  });

  it("keeps focused item and range safe when resized to zero height", () => {
    const state = resizeVirtualListViewport(
      createVirtualListState({
        itemCount: 10,
        viewportHeight: 3,
        focusedIndex: 5,
      }),
      0
    );

    expect(state.focusedIndex).toBe(5);
    expect(state.viewportHeight).toBe(0);
    expect(state.scrollOffset).toBe(3);
    expect(getVirtualListRange(state)).toEqual({ start: 0, end: 0, count: 0 });
  });

  it("clamps explicit focus requests and non-finite movement", () => {
    let state = createVirtualListState({ itemCount: 4, viewportHeight: 2 });

    state = setVirtualListFocus(state, 99);
    expect(state.focusedIndex).toBe(3);
    expect(state.scrollOffset).toBe(2);

    const unchanged = moveVirtualListFocus(state, Number.POSITIVE_INFINITY);
    expect(unchanged.focusedIndex).toBe(3);
    expect(unchanged.scrollOffset).toBe(2);
  });

  it("keeps implementation free of external coupling and terminal writes", async () => {
    const source = await readFile(new URL("./virtualListModel.ts", import.meta.url), "utf8");

    expect(source).not.toMatch(/\bprocess\b|\bstdout\b|\bstderr\b|\bchild_process\b/u);
    expect(source).not.toMatch(/\breact\b|\bink\b|\byoga\b|\bsource-app\b/u);
    expect(source).not.toMatch(/\bsrc\/(cli|security|runtime|providers|session)\//u);
  });
});
