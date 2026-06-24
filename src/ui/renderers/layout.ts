// Terminal layout helpers.
// Handles Unicode width measurement, wrapping, truncation, frames, and rails.
// ANSI-aware variants strip escape codes before measuring visible width.

import { stringWidth, stripAnsi as stripAnsiForWidth } from "../papyrus/screen/stringWidth.js";

const graphemeSegmenter =
  typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : undefined;

export function stripAnsi(text: string): string {
  return stripAnsiForWidth(text);
}

export function measureTextWidth(text: string): number {
  return stringWidth(text);
}

export function measureVisibleWidth(text: string): number {
  return stringWidth(text);
}

export function wrapText(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [text];

  if (text.length === 0) return [""];
  const lines: string[] = [];
  const words = text.split(/\s+/);
  let currentLine = "";

  for (const word of words) {
    const wordWidth = measureTextWidth(word);
    const lineWidth = measureTextWidth(currentLine);

    if (currentLine.length === 0) {
      if (wordWidth > maxWidth) {
        lines.push(truncateText(word, maxWidth));
      } else {
        currentLine = word;
      }
    } else if (lineWidth + 1 + wordWidth <= maxWidth) {
      currentLine += " " + word;
    } else {
      lines.push(currentLine);
      if (wordWidth > maxWidth) {
        lines.push(truncateText(word, maxWidth));
        currentLine = "";
      } else {
        currentLine = word;
      }
    }
  }

  if (currentLine.length > 0) {
    lines.push(currentLine);
  }

  return lines;
}

export function truncateText(
  text: string,
  maxWidth: number,
  ellipsis: string = "..."
): string {
  const ellipsisWidth = measureTextWidth(ellipsis);
  if (maxWidth <= 0) return "";
  if (maxWidth <= ellipsisWidth) return ellipsis.slice(0, maxWidth);
  if (measureTextWidth(text) <= maxWidth) return text;

  return truncatePreservingControls(text, maxWidth, ellipsis, ellipsisWidth);
}

export function truncateVisible(
  text: string,
  maxWidth: number,
  ellipsis: string = "..."
): string {
  if (maxWidth <= 0) return "";
  const ellipsisWidth = measureTextWidth(ellipsis);
  if (maxWidth <= ellipsisWidth) return ellipsis.slice(0, maxWidth);
  if (measureVisibleWidth(text) <= maxWidth) return text;

  return truncatePreservingControls(text, maxWidth, ellipsis, ellipsisWidth);
}

export function padVisibleEnd(
  text: string,
  width: number,
  fill: string = " "
): string {
  const visibleWidth = measureVisibleWidth(text);
  const padCount = Math.max(0, width - visibleWidth);
  return text + fill.repeat(padCount);
}

export function padVisibleStart(
  text: string,
  width: number,
  fill: string = " "
): string {
  const visibleWidth = measureVisibleWidth(text);
  const padCount = Math.max(0, width - visibleWidth);
  return fill.repeat(padCount) + text;
}

export function padVisibleAlign(
  text: string,
  width: number,
  alignment: "left" | "right" | "center" = "left",
  fill: string = " "
): string {
  const visibleWidth = measureVisibleWidth(text);
  if (visibleWidth >= width) return text;

  if (alignment === "right") {
    return padVisibleStart(text, width, fill);
  }
  if (alignment === "center") {
    const totalPad = width - visibleWidth;
    const left = Math.floor(totalPad / 2);
    const right = totalPad - left;
    return fill.repeat(left) + text + fill.repeat(right);
  }
  return padVisibleEnd(text, width, fill);
}

export function centerVisibleBlock(text: string, width: number): string {
  const lines = text.split("\n");
  const blockWidth = Math.max(0, ...lines.map((line) => measureVisibleWidth(line)));
  if (blockWidth >= width) return text;

  const padding = " ".repeat(Math.floor((width - blockWidth) / 2));
  return lines.map((line) => (line === "" ? line : padding + line)).join("\n");
}

export function indentLines(
  lines: readonly string[],
  indent: number | string = 2
): string[] {
  const prefix = typeof indent === "number" ? " ".repeat(indent) : indent;
  return lines.map((line) => (line.length > 0 ? prefix + line : line));
}

export interface FrameOptions {
  width?: number;
  useUnicode?: boolean;
  title?: string;
}

export function openHorizontalFrame(
  lines: readonly string[],
  options: FrameOptions = {}
): string {
  const useUnicode = options.useUnicode ?? true;
  const horiz = useUnicode ? "─" : "-";
  const topLeft = useUnicode ? "╭" : "+";
  const topRight = useUnicode ? "╮" : "+";
  const bottomLeft = useUnicode ? "╰" : "+";
  const bottomRight = useUnicode ? "╯" : "+";

  const contentWidth = Math.max(0, ...lines.map((l) => measureVisibleWidth(l)));
  const framedTitle = options.title ? ` ${options.title} ` : undefined;
  const titleWidth = framedTitle ? measureVisibleWidth(framedTitle) : 0;
  const minWidth = Math.max(contentWidth + 4, titleWidth + 4);
  const width = Math.max(minWidth, options.width ?? 0);

  let top = topLeft + horiz.repeat(width - 2) + topRight;
  if (framedTitle && titleWidth > 0) {
    const avail = width - 2 - titleWidth;
    const left = Math.floor(avail / 2);
    const right = avail - left;
    top = topLeft + horiz.repeat(left) + framedTitle + horiz.repeat(right) + topRight;
  }

  const bottom = bottomLeft + horiz.repeat(width - 2) + bottomRight;
  const indented = indentLines(lines, 2);

  return [top, ...indented, bottom].join("\n");
}

export function solidPromptRail(
  width: number,
  options: { cap?: string; fill?: string; useUnicode?: boolean } = {}
): string {
  const useUnicode = options.useUnicode ?? true;
  const cap = options.cap ?? (useUnicode ? "+" : "+");
  const fill = options.fill ?? (useUnicode ? "─" : "-");
  if (width <= 0) return "";
  if (width === 1) return cap;
  const innerWidth = Math.max(0, width - 2);
  return cap + fill.repeat(innerWidth) + cap;
}

export interface BeadOptions {
  filledChar?: string;
  emptyChar?: string;
}

export function renderBeads(
  filled: number,
  total: number,
  options: BeadOptions = {}
): string {
  const filledChar = options.filledChar ?? "◉";
  const emptyChar = options.emptyChar ?? "·";
  if (total <= 0) return "";
  const clampedFilled = Math.max(0, Math.min(filled, total));
  return filledChar.repeat(clampedFilled) + emptyChar.repeat(total - clampedFilled);
}

function truncatePreservingControls(
  text: string,
  maxWidth: number,
  ellipsis: string,
  ellipsisWidth: number
): string {
  let width = 0;
  let result = "";
  let index = 0;

  while (index < text.length) {
    const ansi = readAnsiSequence(text, index);
    if (ansi !== undefined) {
      result += ansi;
      index += ansi.length;
      continue;
    }

    const grapheme = readGrapheme(text, index);
    const graphemeWidth = stringWidth(grapheme);
    if (width + graphemeWidth + ellipsisWidth > maxWidth) {
      return result + ellipsis;
    }

    result += grapheme;
    width += graphemeWidth;
    index += grapheme.length;
  }

  return result;
}

function readAnsiSequence(text: string, index: number): string | undefined {
  if (text.charCodeAt(index) !== 0x1b) return undefined;
  const next = text[index + 1];
  if (next === undefined) return text[index];

  if (next === "[") {
    for (let cursor = index + 2; cursor < text.length; cursor += 1) {
      const code = text.charCodeAt(cursor);
      if (code >= 0x40 && code <= 0x7e) return text.slice(index, cursor + 1);
    }
    return text.slice(index);
  }

  if (next === "]") {
    for (let cursor = index + 2; cursor < text.length; cursor += 1) {
      if (text.charCodeAt(cursor) === 0x07) return text.slice(index, cursor + 1);
      if (text.charCodeAt(cursor) === 0x1b && text[cursor + 1] === "\\") {
        return text.slice(index, cursor + 2);
      }
    }
    return text.slice(index);
  }

  return text.slice(index, Math.min(text.length, index + 2));
}

function readGrapheme(text: string, index: number): string {
  const value = text.slice(index);
  if (graphemeSegmenter !== undefined) {
    const next = graphemeSegmenter.segment(value)[Symbol.iterator]().next();
    if (!next.done) return next.value.segment;
  }
  return Array.from(value)[0] ?? "";
}
