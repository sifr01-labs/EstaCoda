import {
  createVirtualListState,
  focusVirtualListFirst,
  focusVirtualListLast,
  getVirtualListRange,
  moveVirtualListFocus,
  pageVirtualListFocusDown,
  pageVirtualListFocusUp,
  resizeVirtualListViewport,
  type VirtualListState,
} from "./virtualListModel.js";

export type FuzzyPickerItem<TValue = string, TMetadata = unknown> = {
  readonly value: TValue;
  readonly label: string;
  readonly detail?: string;
  readonly keywords?: readonly string[];
  readonly disabled?: boolean;
  readonly metadata?: TMetadata;
};

export type FuzzyPickerMatchKind = "none" | "exact" | "prefix" | "contains" | "subsequence";

export type FuzzyPickerMatch = {
  readonly kind: FuzzyPickerMatchKind;
  readonly score: number;
  readonly query: string;
  readonly matchedText?: string;
};

export type FuzzyPickerResult<TValue = string, TMetadata = unknown> = {
  readonly item: FuzzyPickerItem<TValue, TMetadata>;
  readonly itemIndex: number;
  readonly resultIndex: number;
  readonly match: FuzzyPickerMatch;
};

export type FuzzyPickerState<TValue = string, TMetadata = unknown> = {
  readonly items: readonly FuzzyPickerItem<TValue, TMetadata>[];
  readonly query: string;
  readonly results: readonly FuzzyPickerResult<TValue, TMetadata>[];
  readonly focusedResultIndex?: number;
  readonly viewport: VirtualListState;
};

export type CreateFuzzyPickerStateOptions = {
  readonly query?: string;
  readonly focusedResultIndex?: number;
  readonly viewportHeight?: number;
};

export type FuzzyPickerIntent<TValue = string> =
  | { readonly type: "selected"; readonly value: TValue }
  | { readonly type: "cancel" };

export type FuzzyPickerResultState<TValue = string, TMetadata = unknown> = {
  readonly state: FuzzyPickerState<TValue, TMetadata>;
  readonly intent?: FuzzyPickerIntent<TValue>;
};

export type FuzzyPickerKeyEvent = {
  readonly key: "arrowUp" | "arrowDown" | "pageUp" | "pageDown" | "home" | "end" | "enter" | "escape";
};

export type FuzzyPickerRenderRow<TValue = string> =
  | {
      readonly kind: "item";
      readonly value: TValue;
      readonly label: string;
      readonly detail?: string;
      readonly focused: boolean;
      readonly disabled: boolean;
      readonly match: FuzzyPickerMatch;
    }
  | {
      readonly kind: "empty";
      readonly query: string;
      readonly text: string;
    };

export function createFuzzyPickerState<TValue = string, TMetadata = unknown>(
  items: readonly FuzzyPickerItem<TValue, TMetadata>[],
  options: CreateFuzzyPickerStateOptions = {}
): FuzzyPickerState<TValue, TMetadata> {
  return buildFuzzyPickerState({
    items,
    query: options.query ?? "",
    focusedResultIndex: options.focusedResultIndex,
    viewportHeight: options.viewportHeight,
  });
}

export function updateFuzzyPickerQuery<TValue, TMetadata>(
  state: FuzzyPickerState<TValue, TMetadata>,
  query: string
): FuzzyPickerState<TValue, TMetadata> {
  return buildFuzzyPickerState({
    items: state.items,
    query,
    focusedResultIndex: 0,
    viewportHeight: state.viewport.viewportHeight,
  });
}

export function reconcileFuzzyPickerItems<TValue, TMetadata>(
  state: FuzzyPickerState<TValue, TMetadata>,
  items: readonly FuzzyPickerItem<TValue, TMetadata>[]
): FuzzyPickerState<TValue, TMetadata> {
  const focusedValue = focusedFuzzyPickerResult(state)?.item.value;
  const nextResults = rankFuzzyPickerItems(items, state.query);
  const focusedResultIndex = focusedValue === undefined
    ? state.focusedResultIndex
    : nextResults.findIndex((result) => Object.is(result.item.value, focusedValue));
  return buildFuzzyPickerState({
    items,
    query: state.query,
    focusedResultIndex: focusedResultIndex === -1 ? state.focusedResultIndex : focusedResultIndex,
    viewportHeight: state.viewport.viewportHeight,
  });
}

export function resizeFuzzyPickerViewport<TValue, TMetadata>(
  state: FuzzyPickerState<TValue, TMetadata>,
  viewportHeight: number
): FuzzyPickerState<TValue, TMetadata> {
  const viewport = resizeVirtualListViewport(state.viewport, viewportHeight);
  return {
    ...state,
    viewport,
  };
}

export function focusedFuzzyPickerResult<TValue, TMetadata>(
  state: FuzzyPickerState<TValue, TMetadata>
): FuzzyPickerResult<TValue, TMetadata> | undefined {
  return state.focusedResultIndex === undefined ? undefined : state.results[state.focusedResultIndex];
}

export function visibleFuzzyPickerResults<TValue, TMetadata>(
  state: FuzzyPickerState<TValue, TMetadata>
): readonly FuzzyPickerResult<TValue, TMetadata>[] {
  const range = getVirtualListRange(state.viewport);
  return state.results.slice(range.start, range.end);
}

export function moveFuzzyPickerFocus<TValue, TMetadata>(
  state: FuzzyPickerState<TValue, TMetadata>,
  delta: number
): FuzzyPickerState<TValue, TMetadata> {
  return withViewport(state, moveVirtualListFocus(state.viewport, delta));
}

export function pageFuzzyPickerFocusDown<TValue, TMetadata>(
  state: FuzzyPickerState<TValue, TMetadata>
): FuzzyPickerState<TValue, TMetadata> {
  return withViewport(state, pageVirtualListFocusDown(state.viewport));
}

export function pageFuzzyPickerFocusUp<TValue, TMetadata>(
  state: FuzzyPickerState<TValue, TMetadata>
): FuzzyPickerState<TValue, TMetadata> {
  return withViewport(state, pageVirtualListFocusUp(state.viewport));
}

export function focusFuzzyPickerFirst<TValue, TMetadata>(
  state: FuzzyPickerState<TValue, TMetadata>
): FuzzyPickerState<TValue, TMetadata> {
  return withViewport(state, focusVirtualListFirst(state.viewport));
}

export function focusFuzzyPickerLast<TValue, TMetadata>(
  state: FuzzyPickerState<TValue, TMetadata>
): FuzzyPickerState<TValue, TMetadata> {
  return withViewport(state, focusVirtualListLast(state.viewport));
}

export function selectFocusedFuzzyPickerItem<TValue, TMetadata>(
  state: FuzzyPickerState<TValue, TMetadata>
): FuzzyPickerResultState<TValue, TMetadata> {
  const result = focusedFuzzyPickerResult(state);
  if (result === undefined || result.item.disabled === true) return { state };
  return {
    state,
    intent: {
      type: "selected",
      value: result.item.value,
    },
  };
}

export function cancelFuzzyPicker<TValue, TMetadata>(
  state: FuzzyPickerState<TValue, TMetadata>
): FuzzyPickerResultState<TValue, TMetadata> {
  return {
    state,
    intent: { type: "cancel" },
  };
}

export function applyFuzzyPickerKey<TValue, TMetadata>(
  state: FuzzyPickerState<TValue, TMetadata>,
  event: FuzzyPickerKeyEvent
): FuzzyPickerResultState<TValue, TMetadata> {
  switch (event.key) {
    case "arrowDown":
      return { state: moveFuzzyPickerFocus(state, 1) };
    case "arrowUp":
      return { state: moveFuzzyPickerFocus(state, -1) };
    case "pageDown":
      return { state: pageFuzzyPickerFocusDown(state) };
    case "pageUp":
      return { state: pageFuzzyPickerFocusUp(state) };
    case "home":
      return { state: focusFuzzyPickerFirst(state) };
    case "end":
      return { state: focusFuzzyPickerLast(state) };
    case "enter":
      return selectFocusedFuzzyPickerItem(state);
    case "escape":
      return cancelFuzzyPicker(state);
  }
}

export function buildFuzzyPickerRenderRows<TValue, TMetadata>(
  state: FuzzyPickerState<TValue, TMetadata>
): readonly FuzzyPickerRenderRow<TValue>[] {
  const rows = visibleFuzzyPickerResults(state).map((result) => ({
    kind: "item" as const,
    value: result.item.value,
    label: result.item.label,
    detail: result.item.detail,
    focused: result.resultIndex === state.focusedResultIndex,
    disabled: result.item.disabled === true,
    match: result.match,
  }));
  if (rows.length > 0) return rows;
  return [{
    kind: "empty",
    query: state.query,
    text: state.query.trim().length === 0 ? "No items" : `No matches for ${state.query}`,
  }];
}

function buildFuzzyPickerState<TValue, TMetadata>(input: {
  readonly items: readonly FuzzyPickerItem<TValue, TMetadata>[];
  readonly query: string;
  readonly focusedResultIndex?: number;
  readonly viewportHeight?: number;
}): FuzzyPickerState<TValue, TMetadata> {
  const results = rankFuzzyPickerItems(input.items, input.query);
  const focusedResultIndex = normalizeFocusedResultIndex(input.focusedResultIndex, results);
  const viewport = createVirtualListState({
    itemCount: results.length,
    viewportHeight: input.viewportHeight,
    focusedIndex: focusedResultIndex,
  });
  return {
    items: input.items,
    query: input.query,
    results,
    focusedResultIndex,
    viewport,
  };
}

function withViewport<TValue, TMetadata>(
  state: FuzzyPickerState<TValue, TMetadata>,
  viewport: VirtualListState
): FuzzyPickerState<TValue, TMetadata> {
  return {
    ...state,
    focusedResultIndex: viewport.focusedIndex,
    viewport,
  };
}

function rankFuzzyPickerItems<TValue, TMetadata>(
  items: readonly FuzzyPickerItem<TValue, TMetadata>[],
  query: string
): readonly FuzzyPickerResult<TValue, TMetadata>[] {
  const normalizedQuery = normalizeSearchText(query);
  return items
    .map((item, itemIndex) => ({
      item,
      itemIndex,
      match: scoreFuzzyPickerItem(item, normalizedQuery),
    }))
    .filter((result) => result.match.kind !== "none")
    .sort((left, right) => left.match.score - right.match.score || left.itemIndex - right.itemIndex)
    .map((result, resultIndex) => ({
      ...result,
      resultIndex,
    }));
}

function scoreFuzzyPickerItem<TValue, TMetadata>(
  item: FuzzyPickerItem<TValue, TMetadata>,
  normalizedQuery: string
): FuzzyPickerMatch {
  if (normalizedQuery.length === 0) {
    return { kind: "prefix", score: 1, query: "" };
  }

  let best: FuzzyPickerMatch = { kind: "none", score: Number.POSITIVE_INFINITY, query: normalizedQuery };
  for (const text of searchableTexts(item)) {
    const normalizedText = normalizeSearchText(text);
    const match = scoreSearchText(normalizedText, normalizedQuery, text);
    if (match.score < best.score) best = match;
  }
  return best;
}

function scoreSearchText(normalizedText: string, normalizedQuery: string, originalText: string): FuzzyPickerMatch {
  if (normalizedText === normalizedQuery) {
    return { kind: "exact", score: 0, query: normalizedQuery, matchedText: originalText };
  }
  if (normalizedText.startsWith(normalizedQuery)) {
    return { kind: "prefix", score: 1, query: normalizedQuery, matchedText: originalText };
  }
  if (normalizedText.includes(normalizedQuery)) {
    return { kind: "contains", score: 2, query: normalizedQuery, matchedText: originalText };
  }
  if (isSubsequence(normalizedText, normalizedQuery)) {
    return { kind: "subsequence", score: 3, query: normalizedQuery, matchedText: originalText };
  }
  return { kind: "none", score: Number.POSITIVE_INFINITY, query: normalizedQuery };
}

function searchableTexts<TValue, TMetadata>(
  item: FuzzyPickerItem<TValue, TMetadata>
): readonly string[] {
  return [
    item.label,
    ...(item.detail === undefined ? [] : [item.detail]),
    ...(item.keywords ?? []),
  ];
}

function normalizeSearchText(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function isSubsequence(text: string, query: string): boolean {
  let queryIndex = 0;
  for (const char of text) {
    if (char === query[queryIndex]) queryIndex += 1;
    if (queryIndex === query.length) return true;
  }
  return false;
}

function normalizeFocusedResultIndex<TValue, TMetadata>(
  value: number | undefined,
  results: readonly FuzzyPickerResult<TValue, TMetadata>[]
): number | undefined {
  if (results.length === 0) return undefined;
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.min(Math.max(0, Math.floor(value)), results.length - 1);
}
