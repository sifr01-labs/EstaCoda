export type VirtualListState = {
  readonly itemCount: number;
  readonly viewportHeight: number;
  readonly scrollOffset: number;
  readonly focusedIndex?: number;
};

export type VirtualListRange = {
  readonly start: number;
  readonly end: number;
  readonly count: number;
};

export type VirtualListOverscanOptions = {
  readonly overscan?: number;
};

export type CreateVirtualListStateOptions = {
  readonly itemCount: number;
  readonly viewportHeight?: number;
  readonly scrollOffset?: number;
  readonly focusedIndex?: number;
};

export function createVirtualListState(options: CreateVirtualListStateOptions): VirtualListState {
  const itemCount = normalizeItemCount(options.itemCount);
  const viewportHeight = normalizeViewportHeight(options.viewportHeight);
  const focusedIndex = normalizeFocusedIndex(options.focusedIndex, itemCount);
  const requestedOffset = clampScrollOffset(options.scrollOffset ?? 0, itemCount, viewportHeight);
  return {
    itemCount,
    viewportHeight,
    focusedIndex,
    scrollOffset: ensureFocusedIndexVisible({
      itemCount,
      viewportHeight,
      scrollOffset: requestedOffset,
      focusedIndex,
    }),
  };
}

export function getVirtualListRange(state: VirtualListState): VirtualListRange {
  if (state.viewportHeight <= 0 || state.itemCount <= 0) {
    return { start: 0, end: 0, count: 0 };
  }
  const start = clampScrollOffset(state.scrollOffset, state.itemCount, state.viewportHeight);
  const end = Math.min(state.itemCount, start + state.viewportHeight);
  return {
    start,
    end,
    count: end - start,
  };
}

export function getVirtualListOverscanRange(
  state: VirtualListState,
  options: VirtualListOverscanOptions = {}
): VirtualListRange {
  const range = getVirtualListRange(state);
  if (range.count === 0) return range;
  const overscan = normalizeOverscan(options.overscan);
  const start = Math.max(0, range.start - overscan);
  const end = Math.min(state.itemCount, range.end + overscan);
  return {
    start,
    end,
    count: end - start,
  };
}

export function moveVirtualListFocus(
  state: VirtualListState,
  delta: number
): VirtualListState {
  if (state.itemCount <= 0) return reconcileVirtualListState(state, { focusedIndex: undefined });
  const current = state.focusedIndex ?? 0;
  return setVirtualListFocus(state, current + normalizeDelta(delta));
}

export function pageVirtualListFocusDown(state: VirtualListState): VirtualListState {
  return moveVirtualListFocus(state, state.viewportHeight);
}

export function pageVirtualListFocusUp(state: VirtualListState): VirtualListState {
  return moveVirtualListFocus(state, -state.viewportHeight);
}

export function focusVirtualListFirst(state: VirtualListState): VirtualListState {
  return setVirtualListFocus(state, 0);
}

export function focusVirtualListLast(state: VirtualListState): VirtualListState {
  return setVirtualListFocus(state, state.itemCount - 1);
}

export function setVirtualListFocus(
  state: VirtualListState,
  focusedIndex: number | undefined
): VirtualListState {
  const nextFocusedIndex = normalizeFocusedIndex(focusedIndex, state.itemCount);
  return reconcileVirtualListState(state, { focusedIndex: nextFocusedIndex });
}

export function resizeVirtualListViewport(
  state: VirtualListState,
  viewportHeight: number
): VirtualListState {
  return reconcileVirtualListState(state, { viewportHeight });
}

export function reconcileVirtualListItemCount(
  state: VirtualListState,
  itemCount: number
): VirtualListState {
  return reconcileVirtualListState(state, { itemCount });
}

function reconcileVirtualListState(
  state: VirtualListState,
  next: Partial<Pick<VirtualListState, "itemCount" | "viewportHeight" | "focusedIndex">>
): VirtualListState {
  const itemCount = normalizeItemCount(next.itemCount ?? state.itemCount);
  const viewportHeight = normalizeViewportHeight(next.viewportHeight ?? state.viewportHeight);
  const focusedIndex = normalizeFocusedIndex(
    Object.hasOwn(next, "focusedIndex") ? next.focusedIndex : state.focusedIndex,
    itemCount
  );
  const scrollOffset = ensureFocusedIndexVisible({
    itemCount,
    viewportHeight,
    scrollOffset: clampScrollOffset(state.scrollOffset, itemCount, viewportHeight),
    focusedIndex,
  });
  return {
    itemCount,
    viewportHeight,
    focusedIndex,
    scrollOffset,
  };
}

function ensureFocusedIndexVisible(input: {
  readonly itemCount: number;
  readonly viewportHeight: number;
  readonly scrollOffset: number;
  readonly focusedIndex?: number;
}): number {
  if (input.focusedIndex === undefined || input.viewportHeight <= 0 || input.itemCount <= 0) {
    return clampScrollOffset(input.scrollOffset, input.itemCount, input.viewportHeight);
  }
  if (input.focusedIndex < input.scrollOffset) return input.focusedIndex;
  if (input.focusedIndex >= input.scrollOffset + input.viewportHeight) {
    return clampScrollOffset(input.focusedIndex - input.viewportHeight + 1, input.itemCount, input.viewportHeight);
  }
  return clampScrollOffset(input.scrollOffset, input.itemCount, input.viewportHeight);
}

function normalizeItemCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function normalizeViewportHeight(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 5;
  return Math.max(0, Math.floor(value));
}

function normalizeFocusedIndex(value: number | undefined, itemCount: number): number | undefined {
  if (itemCount <= 0 || value === undefined || !Number.isFinite(value)) return undefined;
  return Math.min(Math.max(0, Math.floor(value)), itemCount - 1);
}

function normalizeDelta(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.trunc(value);
}

function normalizeOverscan(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function clampScrollOffset(value: number, itemCount: number, viewportHeight: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(0, Math.trunc(value)), Math.max(0, itemCount - viewportHeight));
}
