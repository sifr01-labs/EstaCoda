export type GraphemeSpan = {
  text: string;
  start: number;
  end: number;
};

const graphemeSegmenter =
  typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : undefined;

export function graphemeSpans(text: string): GraphemeSpan[] {
  if (text.length === 0) return [];

  if (graphemeSegmenter !== undefined) {
    return Array.from(graphemeSegmenter.segment(text), (segment) => ({
      text: segment.segment,
      start: segment.index,
      end: segment.index + segment.segment.length,
    }));
  }

  const spans: GraphemeSpan[] = [];
  let index = 0;
  for (const value of Array.from(text)) {
    spans.push({ text: value, start: index, end: index + value.length });
    index += value.length;
  }
  return spans;
}

export function normalizeCursorIndex(text: string, cursor: number): number {
  const bounded = Math.max(0, Math.min(text.length, Math.trunc(cursor)));
  if (bounded === 0 || bounded === text.length) return bounded;

  for (const span of graphemeSpans(text)) {
    if (bounded === span.start || bounded === span.end) return bounded;
    if (bounded > span.start && bounded < span.end) return span.start;
  }

  return bounded;
}

export function moveCursorLeft(text: string, cursor: number): number {
  const normalized = normalizeCursorIndex(text, cursor);
  let previous = 0;
  for (const span of graphemeSpans(text)) {
    if (span.start >= normalized) return previous;
    previous = span.start;
    if (span.end >= normalized) return span.start;
  }
  return previous;
}

export function moveCursorRight(text: string, cursor: number): number {
  const normalized = normalizeCursorIndex(text, cursor);
  for (const span of graphemeSpans(text)) {
    if (span.start >= normalized) return span.end;
    if (span.start < normalized && span.end > normalized) return span.end;
  }
  return text.length;
}

export function previousGraphemeRange(text: string, cursor: number): GraphemeSpan | undefined {
  const normalized = normalizeCursorIndex(text, cursor);
  let previous: GraphemeSpan | undefined;
  for (const span of graphemeSpans(text)) {
    if (span.end > normalized) return previous;
    previous = span;
  }
  return previous;
}

export function nextGraphemeRange(text: string, cursor: number): GraphemeSpan | undefined {
  const normalized = normalizeCursorIndex(text, cursor);
  for (const span of graphemeSpans(text)) {
    if (span.start >= normalized) return span;
    if (span.start < normalized && span.end > normalized) return span;
  }
  return undefined;
}

export function isCursorAtGraphemeBoundary(text: string, cursor: number): boolean {
  const bounded = Math.max(0, Math.min(text.length, Math.trunc(cursor)));
  return normalizeCursorIndex(text, cursor) === bounded;
}
