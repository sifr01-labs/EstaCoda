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
  type ScrollPaneState,
} from "./scrollPaneModel.js";
import {
  focusedFuzzyPickerResult,
  type FuzzyPickerState,
} from "./fuzzyPickerModel.js";

export type PreviewPaneContent = {
  readonly title?: string;
  readonly status?: string;
  readonly rows: readonly string[];
};

export type PreviewPaneState = PreviewPaneContent & {
  readonly scroll: ScrollPaneState<string>;
};

export type CreatePreviewPaneStateOptions = {
  readonly title?: string;
  readonly status?: string;
  readonly rows?: readonly string[];
  readonly viewportHeight?: number;
  readonly scrollOffset?: number;
  readonly stickyBottom?: boolean;
};

export type PreviewPaneRenderRow =
  | { readonly kind: "title"; readonly text: string }
  | { readonly kind: "status"; readonly text: string }
  | { readonly kind: "content"; readonly text: string; readonly rowIndex: number }
  | { readonly kind: "empty"; readonly text: string };

export function createPreviewPaneState(
  options: CreatePreviewPaneStateOptions = {}
): PreviewPaneState {
  const rows = options.rows ?? [];
  const scroll = createScrollPaneState(rows, {
    viewportHeight: options.viewportHeight,
    scrollOffset: options.scrollOffset,
    stickyBottom: options.stickyBottom,
  });
  return {
    title: options.title,
    status: options.status,
    rows,
    scroll,
  };
}

export function previewPaneHasContent(state: PreviewPaneState): boolean {
  return state.rows.length > 0;
}

export function getVisiblePreviewRows(state: PreviewPaneState): readonly string[] {
  return getVisibleScrollPaneRows(state.scroll);
}

export function scrollPreviewPaneBy(
  state: PreviewPaneState,
  delta: number
): PreviewPaneState {
  return withPreviewScroll(state, scrollPaneBy(state.scroll, delta));
}

export function scrollPreviewPanePageDown(state: PreviewPaneState): PreviewPaneState {
  return withPreviewScroll(state, scrollPanePageDown(state.scroll));
}

export function scrollPreviewPanePageUp(state: PreviewPaneState): PreviewPaneState {
  return withPreviewScroll(state, scrollPanePageUp(state.scroll));
}

export function scrollPreviewPaneToTop(state: PreviewPaneState): PreviewPaneState {
  return withPreviewScroll(state, scrollPaneToTop(state.scroll));
}

export function scrollPreviewPaneToBottom(state: PreviewPaneState): PreviewPaneState {
  return withPreviewScroll(state, scrollPaneToBottom(state.scroll));
}

export function resizePreviewPaneViewport(
  state: PreviewPaneState,
  viewportHeight: number
): PreviewPaneState {
  return withPreviewScroll(state, resizeScrollPaneViewport(state.scroll, viewportHeight));
}

export function appendPreviewPaneRows(
  state: PreviewPaneState,
  rows: readonly string[]
): PreviewPaneState {
  return withPreviewScrollAndRows(state, appendScrollPaneRows(state.scroll, rows));
}

export function reconcilePreviewPaneContent(
  state: PreviewPaneState,
  content: PreviewPaneContent
): PreviewPaneState {
  const scroll = reconcileScrollPaneRows(state.scroll, content.rows);
  return {
    title: content.title,
    status: content.status,
    rows: content.rows,
    scroll,
  };
}

export function previewPaneForFocusedFuzzyItem<TValue, TMetadata>(
  state: FuzzyPickerState<TValue, TMetadata>,
  previews: ReadonlyMap<TValue, PreviewPaneContent>,
  options: Omit<CreatePreviewPaneStateOptions, "title" | "status" | "rows"> = {}
): PreviewPaneState {
  const focused = focusedFuzzyPickerResult(state);
  const content = focused === undefined ? undefined : previews.get(focused.item.value);
  return createPreviewPaneState({
    ...options,
    ...(content ?? { rows: [] }),
  });
}

export function buildPreviewPaneRenderRows(state: PreviewPaneState): readonly PreviewPaneRenderRow[] {
  const contentRows = getVisiblePreviewRows(state).map((text, index) => ({
    kind: "content" as const,
    text,
    rowIndex: state.scroll.scrollOffset + index,
  }));
  return [
    ...(state.title === undefined ? [] : [{ kind: "title" as const, text: state.title }]),
    ...(state.status === undefined ? [] : [{ kind: "status" as const, text: state.status }]),
    ...(contentRows.length > 0 ? contentRows : [{ kind: "empty" as const, text: "No preview" }]),
  ];
}

function withPreviewScroll(state: PreviewPaneState, scroll: ScrollPaneState<string>): PreviewPaneState {
  return {
    ...state,
    scroll,
  };
}

function withPreviewScrollAndRows(state: PreviewPaneState, scroll: ScrollPaneState<string>): PreviewPaneState {
  return {
    ...state,
    rows: scroll.rows,
    scroll,
  };
}
