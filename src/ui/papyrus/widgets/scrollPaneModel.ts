export type ScrollPaneState<TRow = string> = {
  readonly rows: readonly TRow[];
  readonly viewportHeight: number;
  readonly scrollOffset: number;
  readonly stickyBottom: boolean;
};

export type CreateScrollPaneStateOptions = {
  readonly viewportHeight?: number;
  readonly scrollOffset?: number;
  readonly stickyBottom?: boolean;
};

export function createScrollPaneState<TRow = string>(
  rows: readonly TRow[],
  options: CreateScrollPaneStateOptions = {}
): ScrollPaneState<TRow> {
  const viewportHeight = normalizeViewportHeight(options.viewportHeight);
  return {
    rows,
    viewportHeight,
    scrollOffset: clampScrollOffset(options.scrollOffset ?? 0, rows.length, viewportHeight),
    stickyBottom: options.stickyBottom ?? false,
  };
}

export function getVisibleScrollPaneRows<TRow>(
  state: ScrollPaneState<TRow>
): readonly TRow[] {
  if (state.viewportHeight <= 0) return [];
  return state.rows.slice(state.scrollOffset, state.scrollOffset + state.viewportHeight);
}

export function scrollPaneBy<TRow>(
  state: ScrollPaneState<TRow>,
  delta: number
): ScrollPaneState<TRow> {
  return setScrollPaneOffset(state, state.scrollOffset + normalizeDelta(delta));
}

export function scrollPanePageDown<TRow>(
  state: ScrollPaneState<TRow>
): ScrollPaneState<TRow> {
  return scrollPaneBy(state, state.viewportHeight);
}

export function scrollPanePageUp<TRow>(
  state: ScrollPaneState<TRow>
): ScrollPaneState<TRow> {
  return scrollPaneBy(state, -state.viewportHeight);
}

export function scrollPaneToTop<TRow>(
  state: ScrollPaneState<TRow>
): ScrollPaneState<TRow> {
  return setScrollPaneOffset(state, 0);
}

export function scrollPaneToBottom<TRow>(
  state: ScrollPaneState<TRow>
): ScrollPaneState<TRow> {
  return setScrollPaneOffset(state, maxScrollOffset(state.rows.length, state.viewportHeight));
}

export function resizeScrollPaneViewport<TRow>(
  state: ScrollPaneState<TRow>,
  viewportHeight: number
): ScrollPaneState<TRow> {
  const nextViewportHeight = normalizeViewportHeight(viewportHeight);
  return {
    ...state,
    viewportHeight: nextViewportHeight,
    scrollOffset: clampScrollOffset(state.scrollOffset, state.rows.length, nextViewportHeight),
  };
}

export function appendScrollPaneRows<TRow>(
  state: ScrollPaneState<TRow>,
  rows: readonly TRow[]
): ScrollPaneState<TRow> {
  const wasAtBottom = state.scrollOffset >= maxScrollOffset(state.rows.length, state.viewportHeight);
  const nextRows = [...state.rows, ...rows];
  const nextOffset = state.stickyBottom && wasAtBottom
    ? maxScrollOffset(nextRows.length, state.viewportHeight)
    : clampScrollOffset(state.scrollOffset, nextRows.length, state.viewportHeight);
  return {
    ...state,
    rows: nextRows,
    scrollOffset: nextOffset,
  };
}

export function reconcileScrollPaneRows<TRow>(
  state: ScrollPaneState<TRow>,
  rows: readonly TRow[]
): ScrollPaneState<TRow> {
  return {
    ...state,
    rows,
    scrollOffset: clampScrollOffset(state.scrollOffset, rows.length, state.viewportHeight),
  };
}

function setScrollPaneOffset<TRow>(
  state: ScrollPaneState<TRow>,
  scrollOffset: number
): ScrollPaneState<TRow> {
  return {
    ...state,
    scrollOffset: clampScrollOffset(scrollOffset, state.rows.length, state.viewportHeight),
  };
}

function normalizeViewportHeight(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 5;
  return Math.max(0, Math.floor(value));
}

function normalizeDelta(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.trunc(value);
}

function clampScrollOffset(value: number, rowCount: number, viewportHeight: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(0, Math.trunc(value)), maxScrollOffset(rowCount, viewportHeight));
}

function maxScrollOffset(rowCount: number, viewportHeight: number): number {
  return Math.max(0, rowCount - viewportHeight);
}
