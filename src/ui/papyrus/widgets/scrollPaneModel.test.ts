import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  appendScrollPaneRows,
  createScrollPaneState,
  getVisibleScrollPaneRows,
  reconcileScrollPaneRows,
  resizeScrollPaneViewport,
  scrollPaneBy,
  scrollPanePageDown,
  scrollPanePageUp,
  scrollPaneToBottom,
  scrollPaneToTop,
} from "./index.js";

const rows = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];

describe("Papyrus scroll pane model", () => {
  it("handles empty and short content safely", () => {
    const empty = createScrollPaneState([], { viewportHeight: 3, scrollOffset: 10 });
    expect(empty.scrollOffset).toBe(0);
    expect(getVisibleScrollPaneRows(empty)).toEqual([]);

    const short = createScrollPaneState(["alpha", "bravo"], { viewportHeight: 5, scrollOffset: 2 });
    expect(short.scrollOffset).toBe(0);
    expect(getVisibleScrollPaneRows(short)).toEqual(["alpha", "bravo"]);
  });

  it("scrolls long content by line, page, top, and bottom with clamped offsets", () => {
    let state = createScrollPaneState(rows, { viewportHeight: 2 });

    state = scrollPaneBy(state, 1);
    expect(state.scrollOffset).toBe(1);
    expect(getVisibleScrollPaneRows(state)).toEqual(["bravo", "charlie"]);

    state = scrollPanePageDown(state);
    expect(state.scrollOffset).toBe(3);
    expect(getVisibleScrollPaneRows(state)).toEqual(["delta", "echo"]);

    state = scrollPanePageDown(state);
    expect(state.scrollOffset).toBe(4);
    expect(getVisibleScrollPaneRows(state)).toEqual(["echo", "foxtrot"]);

    state = scrollPanePageUp(state);
    expect(state.scrollOffset).toBe(2);

    expect(scrollPaneToTop(state).scrollOffset).toBe(0);
    expect(scrollPaneToBottom(state).scrollOffset).toBe(4);
    expect(scrollPaneBy(state, -20).scrollOffset).toBe(0);
    expect(scrollPaneBy(state, Number.POSITIVE_INFINITY).scrollOffset).toBe(2);
  });

  it("clamps scroll offset when viewport size changes", () => {
    let state = createScrollPaneState(rows, { viewportHeight: 2, scrollOffset: 4 });

    state = resizeScrollPaneViewport(state, 4);
    expect(state.scrollOffset).toBe(2);
    expect(getVisibleScrollPaneRows(state)).toEqual(["charlie", "delta", "echo", "foxtrot"]);

    state = resizeScrollPaneViewport(state, 1);
    expect(state.scrollOffset).toBe(2);
    expect(getVisibleScrollPaneRows(state)).toEqual(["charlie"]);

    state = resizeScrollPaneViewport(state, 10);
    expect(state.scrollOffset).toBe(0);
    expect(getVisibleScrollPaneRows(state)).toEqual(rows);
  });

  it("sticks to bottom on append only when configured and already at bottom", () => {
    const sticky = createScrollPaneState(["a", "b", "c"], {
      viewportHeight: 2,
      scrollOffset: 1,
      stickyBottom: true,
    });

    const appendedAtBottom = appendScrollPaneRows(sticky, ["d", "e"]);
    expect(appendedAtBottom.scrollOffset).toBe(3);
    expect(getVisibleScrollPaneRows(appendedAtBottom)).toEqual(["d", "e"]);

    const scrolledAway = scrollPaneToTop(appendedAtBottom);
    const appendedAway = appendScrollPaneRows(scrolledAway, ["f"]);
    expect(appendedAway.scrollOffset).toBe(0);
    expect(getVisibleScrollPaneRows(appendedAway)).toEqual(["a", "b"]);

    const notSticky = createScrollPaneState(["a", "b", "c"], { viewportHeight: 2, scrollOffset: 1 });
    expect(appendScrollPaneRows(notSticky, ["d"]).scrollOffset).toBe(1);
  });

  it("reconciles replacement rows without leaking stale offsets", () => {
    const state = createScrollPaneState(rows, { viewportHeight: 3, scrollOffset: 3 });
    const reconciled = reconcileScrollPaneRows(state, ["one"]);

    expect(reconciled.scrollOffset).toBe(0);
    expect(getVisibleScrollPaneRows(reconciled)).toEqual(["one"]);
  });

  it("keeps implementation free of external coupling and terminal writes", async () => {
    const source = await readFile(new URL("./scrollPaneModel.ts", import.meta.url), "utf8");

    expect(source).not.toMatch(/\bprocess\b|\bstdout\b|\bstderr\b|\bchild_process\b/u);
    expect(source).not.toMatch(/\breact\b|\bink\b|\byoga\b|\bsource-app\b/u);
    expect(source).not.toMatch(/\bsrc\/(cli|security|runtime|providers|session)\//u);
  });
});
