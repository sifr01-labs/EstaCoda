import createBidi, { type BidiEmbeddingLevels } from "bidi-js";
import {
  hasRtlText,
  isolateLtr,
  isolateRtl,
  isolateTechnicalTokens,
  FSI,
  LRI,
  PDI,
  RLI,
  sanitizeBidiControls,
} from "../../bidi.js";
import {
  graphemeSpans,
  moveCursorLeft,
  moveCursorRight,
  normalizeCursorIndex,
} from "../../input/cursor.js";
import { shouldUseSoftwareBidi, type BidiMode } from "../screen/bidi.js";
import { stringWidth } from "../screen/stringWidth.js";

export type EditableTextDirection = "ltr" | "rtl";

export type EditableTextVisualCluster = {
  readonly text: string;
  readonly renderText: string;
  readonly logicalStart: number;
  readonly logicalEnd: number;
  readonly visualColumn: number;
  readonly width: number;
  readonly level: number;
};

export type EditableTextRow = {
  readonly text: string;
  readonly renderText: string;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly direction: EditableTextDirection;
  readonly width: number;
  readonly leftPadding: number;
  readonly hasBidi: boolean;
  readonly visualClusters: readonly EditableTextVisualCluster[];
};

export type EditableTextLayout = {
  readonly rows: readonly EditableTextRow[];
  readonly cursorRow: number;
  readonly cursorColumn: number;
};

export type EditableTextLayoutOptions = {
  readonly maxCells: number;
  readonly cursorOffset?: number;
  readonly wrap?: boolean;
  readonly alignRtl?: boolean;
};

export type EditableTextRenderOptions = {
  readonly bidi?: BidiMode;
};

const bidi = createBidi();

export function layoutEditableText(
  text: string,
  options: EditableTextLayoutOptions
): EditableTextLayout {
  const maxCells = normalizeMaxCells(options.maxCells);
  const cursorOffset = normalizeCursorIndex(text, options.cursorOffset ?? text.length);
  const rows = buildRows(
    text,
    maxCells,
    options.wrap !== false,
    options.alignRtl !== false && Number.isFinite(options.maxCells)
  );
  const cursorRow = findCursorRow(rows, cursorOffset);
  const row = rows[cursorRow] ?? emptyRow(maxCells);
  const rowCursorOffset = Math.min(row.endOffset, Math.max(row.startOffset, cursorOffset));

  return {
    rows,
    cursorRow,
    cursorColumn: row.leftPadding + cursorColumnForOffset(row, rowCursorOffset),
  };
}

export function renderEditableTextRow(
  row: EditableTextRow,
  options: EditableTextRenderOptions = {}
): string {
  if (!row.hasBidi) return `${" ".repeat(row.leftPadding)}${row.renderText}`;
  if (shouldUseSoftwareBidi(options.bidi ?? "native")) {
    return `${" ".repeat(row.leftPadding)}${visualText(row)}`;
  }
  const isolated = row.direction === "rtl" ? isolateRtl(row.renderText) : isolateLtr(row.renderText);
  return `${" ".repeat(row.leftPadding)}${isolated}`;
}

export function moveEditableCursorVisual(
  text: string,
  cursorOffset: number,
  direction: "left" | "right",
  options: Pick<EditableTextLayoutOptions, "maxCells" | "wrap">
): number {
  if (!hasRtlText(text)) {
    return direction === "left"
      ? moveCursorLeft(text, cursorOffset)
      : moveCursorRight(text, cursorOffset);
  }
  const layout = layoutEditableText(text, {
    ...options,
    cursorOffset,
    alignRtl: true,
  });
  const row = layout.rows[layout.cursorRow];
  if (row === undefined) return normalizeCursorIndex(text, cursorOffset);

  const currentColumn = layout.cursorColumn - row.leftPadding;
  const stops = visualCaretStops(row);
  const candidate = direction === "left"
    ? [...stops].reverse().find((stop) => stop.column < currentColumn)
    : stops.find((stop) => stop.column > currentColumn);
  if (candidate !== undefined) return candidate.offset;
  return moveAcrossLogicalRowBoundary(layout, cursorOffset, direction);
}

type LogicalSegment = {
  readonly text: string;
  readonly startOffset: number;
  readonly endOffset: number;
};

type ExplicitLine = {
  readonly text: string;
  readonly startOffset: number;
};

function buildRows(
  text: string,
  maxCells: number,
  wrap: boolean,
  alignRtl: boolean
): readonly EditableTextRow[] {
  const rows: EditableTextRow[] = [];
  for (const line of splitExplicitLines(text)) {
    const sanitizedLine = sanitizeBidiControls(line.text, "untrusted");
    const levels = bidi.getEmbeddingLevels(sanitizedLine);
    const direction: EditableTextDirection = levels.paragraphs[0]?.level === 1 ? "rtl" : "ltr";
    const segments = wrap
      ? wrapLogicalLine(line.text, line.startOffset, maxCells)
      : [logicalSegment(line.text, line.startOffset, line.startOffset + line.text.length)];
    for (const segment of segments) {
      rows.push(buildVisualRow(segment, direction, maxCells, alignRtl));
    }
  }
  return rows.length === 0 ? [emptyRow(maxCells)] : rows;
}

function buildVisualRow(
  segment: LogicalSegment,
  direction: EditableTextDirection,
  maxCells: number,
  alignRtl: boolean
): EditableTextRow {
  const sanitizedText = sanitizeBidiControls(segment.text, "untrusted");
  const renderText = isolateTechnicalTokens(sanitizedText);
  const sourceIndices = mapRenderedIndicesToSource(segment.text, renderText);
  const levels = bidi.getEmbeddingLevels(renderText, direction);
  const spans = graphemeSpans(segment.text);
  const reorderedIndices = renderText.length === 0
    ? []
    : bidi.getReorderedIndices(renderText, levels);
  const visualRank = new Map<number, number>();
  for (const [rank, renderedIndex] of reorderedIndices.entries()) {
    const sourceIndex = sourceIndices[renderedIndex];
    if (sourceIndex === undefined) continue;
    visualRank.set(sourceIndex, Math.min(visualRank.get(sourceIndex) ?? Number.POSITIVE_INFINITY, rank));
  }
  const renderedSourceIndices = new Set(
    sourceIndices.filter((sourceIndex): sourceIndex is number => sourceIndex !== undefined)
  );
  const visualSpans = [...spans].sort((left, right) => {
    return minimumVisualRank(left.start, left.end, visualRank) -
      minimumVisualRank(right.start, right.end, visualRank);
  });

  let visualColumn = 0;
  const visualClusters = visualSpans.map((span): EditableTextVisualCluster => {
    const clusterRenderText = renderableSourceText(
      segment.text,
      span.start,
      span.end,
      renderedSourceIndices
    );
    const width = stringWidth(clusterRenderText);
    const cluster = {
      text: span.text,
      renderText: clusterRenderText,
      logicalStart: segment.startOffset + span.start,
      logicalEnd: segment.startOffset + span.end,
      visualColumn,
      width,
      level: embeddingLevelForSourceIndex(span.start, sourceIndices, levels, direction),
    };
    visualColumn += width;
    return cluster;
  });
  const hasBidi = hasRtlText(sanitizedText);
  const leftPadding = alignRtl && direction === "rtl" ? Math.max(0, maxCells - visualColumn) : 0;

  return {
    ...segment,
    renderText,
    direction,
    width: visualColumn,
    leftPadding,
    hasBidi,
    visualClusters,
  };
}

function visualText(row: EditableTextRow): string {
  return row.visualClusters.map((cluster) => cluster.renderText).join("");
}

function renderableSourceText(
  source: string,
  start: number,
  end: number,
  renderedSourceIndices: ReadonlySet<number>
): string {
  let result = "";
  for (let index = start; index < end; index += 1) {
    if (!renderedSourceIndices.has(index)) continue;
    const character = source[index]!;
    if (character === LRI || character === RLI || character === FSI || character === PDI) continue;
    result += character;
  }
  return result;
}

function cursorColumnForOffset(row: EditableTextRow, cursorOffset: number): number {
  const previous = [...row.visualClusters]
    .filter((cluster) => cluster.logicalEnd <= cursorOffset)
    .sort((left, right) => right.logicalEnd - left.logicalEnd)[0];
  if (previous !== undefined) {
    return (previous.level & 1) === 1
      ? previous.visualColumn
      : previous.visualColumn + previous.width;
  }

  const next = [...row.visualClusters]
    .filter((cluster) => cluster.logicalStart >= cursorOffset)
    .sort((left, right) => left.logicalStart - right.logicalStart)[0];
  if (next !== undefined) {
    return (next.level & 1) === 1
      ? next.visualColumn + next.width
      : next.visualColumn;
  }
  return row.direction === "rtl" ? 0 : row.width;
}

function visualCaretStops(row: EditableTextRow): readonly { readonly column: number; readonly offset: number }[] {
  if (row.visualClusters.length === 0) return [{ column: 0, offset: row.startOffset }];
  const stops = new Map<number, number>();
  for (const cluster of row.visualClusters) {
    const rtl = (cluster.level & 1) === 1;
    stops.set(cluster.visualColumn, rtl ? cluster.logicalEnd : cluster.logicalStart);
    stops.set(cluster.visualColumn + cluster.width, rtl ? cluster.logicalStart : cluster.logicalEnd);
  }
  return [...stops.entries()]
    .map(([column, offset]) => ({ column, offset }))
    .sort((left, right) => left.column - right.column);
}

function moveAcrossLogicalRowBoundary(
  layout: EditableTextLayout,
  cursorOffset: number,
  direction: "left" | "right"
): number {
  const rowIndex = layout.cursorRow;
  const row = layout.rows[rowIndex];
  if (row === undefined) return cursorOffset;

  const towardLogicalStart = row.direction === "rtl" ? "right" : "left";
  if (direction === towardLogicalStart && cursorOffset <= row.startOffset) {
    return layout.rows[rowIndex - 1]?.endOffset ?? cursorOffset;
  }

  const towardLogicalEnd = row.direction === "rtl" ? "left" : "right";
  if (direction === towardLogicalEnd && cursorOffset >= row.endOffset) {
    return layout.rows[rowIndex + 1]?.startOffset ?? cursorOffset;
  }

  return cursorOffset;
}

function findCursorRow(rows: readonly EditableTextRow[], cursorOffset: number): number {
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!;
    const next = rows[index + 1];
    if (cursorOffset <= row.endOffset || next === undefined) return index;
    if (cursorOffset < next.startOffset) return index;
  }
  return Math.max(0, rows.length - 1);
}

function wrapLogicalLine(text: string, startOffset: number, maxCells: number): readonly LogicalSegment[] {
  if (text.length === 0) return [logicalSegment("", startOffset, startOffset)];
  const spans = graphemeSpans(text);
  const rows: LogicalSegment[] = [];
  let rowStartIndex = 0;

  while (rowStartIndex < spans.length) {
    let rowEndIndex = rowStartIndex;
    let width = 0;
    let lastWhitespaceIndex = -1;
    while (rowEndIndex < spans.length) {
      const span = spans[rowEndIndex]!;
      const nextWidth = width + stringWidth(span.text);
      if (rowEndIndex > rowStartIndex && nextWidth > maxCells) break;
      width = nextWidth;
      if (/\s/u.test(span.text)) lastWhitespaceIndex = rowEndIndex;
      rowEndIndex += 1;
      if (width >= maxCells) break;
    }

    let contentEndIndex = rowEndIndex;
    let nextStartIndex = rowEndIndex;
    if (rowEndIndex < spans.length && lastWhitespaceIndex >= rowStartIndex) {
      contentEndIndex = lastWhitespaceIndex;
      nextStartIndex = lastWhitespaceIndex + 1;
    }
    if (contentEndIndex <= rowStartIndex) {
      contentEndIndex = Math.max(rowStartIndex + 1, rowEndIndex);
      nextStartIndex = contentEndIndex;
    }

    const first = spans[rowStartIndex]!;
    const last = spans[contentEndIndex - 1]!;
    const segmentStart = startOffset + first.start;
    const segmentEnd = startOffset + last.end;
    rows.push({
      text: text.slice(first.start, last.end),
      startOffset: segmentStart,
      endOffset: segmentEnd,
    });
    rowStartIndex = nextStartIndex;
  }

  return rows;
}

function logicalSegment(text: string, startOffset: number, endOffset: number): LogicalSegment {
  return {
    text,
    startOffset,
    endOffset,
  };
}

function splitExplicitLines(value: string): readonly ExplicitLine[] {
  const lines: ExplicitLine[] = [];
  const newlinePattern = /\r\n|\n|\r/gu;
  let lastIndex = 0;
  for (const match of value.matchAll(newlinePattern)) {
    const index = match.index ?? lastIndex;
    lines.push({ text: value.slice(lastIndex, index), startOffset: lastIndex });
    lastIndex = index + match[0].length;
  }
  lines.push({ text: value.slice(lastIndex), startOffset: lastIndex });
  return lines;
}

function minimumVisualRank(start: number, end: number, ranks: ReadonlyMap<number, number>): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (let index = start; index < end; index += 1) {
    minimum = Math.min(minimum, ranks.get(index) ?? Number.POSITIVE_INFINITY);
  }
  return minimum;
}

function emptyRow(maxCells: number): EditableTextRow {
  return {
    text: "",
    renderText: "",
    startOffset: 0,
    endOffset: 0,
    direction: "ltr",
    width: 0,
    leftPadding: 0,
    hasBidi: false,
    visualClusters: [],
  };
}

function mapRenderedIndicesToSource(source: string, rendered: string): readonly (number | undefined)[] {
  const mapping: (number | undefined)[] = [];
  let sourceIndex = 0;
  for (let renderedIndex = 0; renderedIndex < rendered.length; renderedIndex += 1) {
    const character = rendered[renderedIndex]!;
    if ((character === LRI || character === PDI) && source[sourceIndex] !== character) {
      mapping.push(undefined);
      continue;
    }
    while (sourceIndex < source.length && source[sourceIndex] !== character) {
      sourceIndex += 1;
    }
    if (sourceIndex < source.length) {
      mapping.push(sourceIndex);
      sourceIndex += 1;
    } else {
      mapping.push(undefined);
    }
  }
  return mapping;
}

function embeddingLevelForSourceIndex(
  sourceIndex: number,
  sourceIndices: readonly (number | undefined)[],
  levels: BidiEmbeddingLevels,
  direction: EditableTextDirection
): number {
  const renderedIndex = sourceIndices.findIndex((candidate) => candidate === sourceIndex);
  return renderedIndex < 0
    ? direction === "rtl" ? 1 : 0
    : levels.levels[renderedIndex] ?? (direction === "rtl" ? 1 : 0);
}

function normalizeMaxCells(value: number): number {
  if (!Number.isFinite(value)) return Number.MAX_SAFE_INTEGER;
  return Math.max(1, Math.floor(value));
}
