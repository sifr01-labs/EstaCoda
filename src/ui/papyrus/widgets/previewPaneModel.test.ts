import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  appendPreviewPaneRows,
  buildPreviewPaneRenderRows,
  createFuzzyPickerState,
  createPreviewPaneState,
  getVisiblePreviewRows,
  moveFuzzyPickerFocus,
  previewPaneForFocusedFuzzyItem,
  previewPaneHasContent,
  resizePreviewPaneViewport,
  scrollPreviewPaneBy,
  scrollPreviewPanePageDown,
  scrollPreviewPanePageUp,
  scrollPreviewPaneToBottom,
  scrollPreviewPaneToTop,
} from "./index.js";

const rows = ["one", "two", "three", "four", "five"];

describe("Papyrus preview pane model", () => {
  it("handles empty preview state as inert render rows", () => {
    const state = createPreviewPaneState({ title: "Preview", status: "No selection", viewportHeight: 4 });

    expect(previewPaneHasContent(state)).toBe(false);
    expect(getVisiblePreviewRows(state)).toEqual([]);
    expect(buildPreviewPaneRenderRows(state)).toEqual([
      { kind: "title", text: "Preview" },
      { kind: "status", text: "No selection" },
      { kind: "empty", text: "No preview" },
    ]);
  });

  it("returns visible preview rows and title/status metadata", () => {
    const state = createPreviewPaneState({
      title: "README.md",
      status: "5 rows",
      rows,
      viewportHeight: 2,
    });

    expect(previewPaneHasContent(state)).toBe(true);
    expect(getVisiblePreviewRows(state)).toEqual(["one", "two"]);
    expect(buildPreviewPaneRenderRows(state)).toEqual([
      { kind: "title", text: "README.md" },
      { kind: "status", text: "5 rows" },
      { kind: "content", text: "one", rowIndex: 0 },
      { kind: "content", text: "two", rowIndex: 1 },
    ]);
  });

  it("scrolls by row, page, top, and bottom with clamped offsets", () => {
    let state = createPreviewPaneState({ rows, viewportHeight: 2 });

    state = scrollPreviewPaneBy(state, 1);
    expect(state.scroll.scrollOffset).toBe(1);
    expect(getVisiblePreviewRows(state)).toEqual(["two", "three"]);

    state = scrollPreviewPanePageDown(state);
    expect(state.scroll.scrollOffset).toBe(3);
    expect(getVisiblePreviewRows(state)).toEqual(["four", "five"]);

    state = scrollPreviewPaneBy(state, 20);
    expect(state.scroll.scrollOffset).toBe(3);

    state = scrollPreviewPanePageUp(state);
    expect(state.scroll.scrollOffset).toBe(1);

    expect(scrollPreviewPaneToTop(state).scroll.scrollOffset).toBe(0);
    expect(scrollPreviewPaneToBottom(state).scroll.scrollOffset).toBe(3);
  });

  it("clamps preview offset when viewport changes", () => {
    let state = createPreviewPaneState({ rows, viewportHeight: 2, scrollOffset: 3 });

    state = resizePreviewPaneViewport(state, 4);
    expect(state.scroll.scrollOffset).toBe(1);
    expect(getVisiblePreviewRows(state)).toEqual(["two", "three", "four", "five"]);

    state = resizePreviewPaneViewport(state, 10);
    expect(state.scroll.scrollOffset).toBe(0);
    expect(getVisiblePreviewRows(state)).toEqual(rows);
  });

  it("supports sticky-bottom append behavior when configured", () => {
    const state = createPreviewPaneState({
      rows: ["a", "b", "c"],
      viewportHeight: 2,
      scrollOffset: 1,
      stickyBottom: true,
    });

    const appended = appendPreviewPaneRows(state, ["d", "e"]);
    expect(appended.rows).toEqual(["a", "b", "c", "d", "e"]);
    expect(appended.scroll.scrollOffset).toBe(3);
    expect(getVisiblePreviewRows(appended)).toEqual(["d", "e"]);
  });

  it("maps focused fuzzy picker item to preview content without loading side effects", () => {
    const picker = createFuzzyPickerState([
      { value: "readme", label: "README.md" },
      { value: "license", label: "LICENSE" },
    ], { focusedResultIndex: 1 });
    const previews = new Map([
      ["readme", { title: "README.md", rows: ["Read me"] }],
      ["license", { title: "LICENSE", status: "plain text", rows: ["MIT", "Copyright"] }],
    ]);

    const preview = previewPaneForFocusedFuzzyItem(picker, previews, { viewportHeight: 1 });

    expect(preview.title).toBe("LICENSE");
    expect(preview.status).toBe("plain text");
    expect(getVisiblePreviewRows(preview)).toEqual(["MIT"]);
  });

  it("returns safe empty preview when focused item has no preview data", () => {
    const picker = createFuzzyPickerState([
      { value: "readme", label: "README.md" },
      { value: "missing", label: "missing.txt" },
    ], { focusedResultIndex: 1 });
    const preview = previewPaneForFocusedFuzzyItem(
      picker,
      new Map([["readme", { title: "README.md", rows: ["Read me"] }]]),
      { viewportHeight: 2 }
    );

    expect(preview.title).toBeUndefined();
    expect(preview.rows).toEqual([]);
    expect(buildPreviewPaneRenderRows(preview)).toEqual([{ kind: "empty", text: "No preview" }]);
  });

  it("rebuilds preview content safely when fuzzy focus changes", () => {
    const picker = createFuzzyPickerState([
      { value: "short", label: "short.txt" },
      { value: "long", label: "long.txt" },
    ], { viewportHeight: 2 });
    const previews = new Map([
      ["short", { title: "short.txt", rows: ["one"] }],
      ["long", { title: "long.txt", rows: ["alpha", "bravo", "charlie"] }],
    ]);

    const shortPreview = previewPaneForFocusedFuzzyItem(picker, previews, { viewportHeight: 2 });
    const longPreview = previewPaneForFocusedFuzzyItem(moveFuzzyPickerFocus(picker, 1), previews, {
      viewportHeight: 2,
      scrollOffset: 99,
    });

    expect(shortPreview.title).toBe("short.txt");
    expect(getVisiblePreviewRows(shortPreview)).toEqual(["one"]);
    expect(longPreview.title).toBe("long.txt");
    expect(longPreview.scroll.scrollOffset).toBe(1);
    expect(getVisiblePreviewRows(longPreview)).toEqual(["bravo", "charlie"]);
  });

  it("keeps implementation free of external coupling and terminal writes", async () => {
    const source = await readFile(new URL("./previewPaneModel.ts", import.meta.url), "utf8");

    expect(source).not.toMatch(/\bprocess\b|\bstdout\b|\bstderr\b|\bchild_process\b|\bnode:fs\b/u);
    expect(source).not.toMatch(/\breact\b|\bink\b|\byoga\b|\bsource-app\b/u);
    expect(source).not.toMatch(/\bsrc\/(cli|security|runtime|providers|session)\//u);
  });
});
