// Terminal layout helpers.
// Handles Unicode width measurement, wrapping, truncation, frames, and rails.
// ANSI-aware variants strip escape codes before measuring visible width.

const ANSI_REGEX = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, "");
}

export function measureTextWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isCombiningChar(cp) || isBidiControl(cp)) {
      continue;
    }
    if (isFullWidthChar(cp) || isEmoji(cp)) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

export function measureVisibleWidth(text: string): number {
  return measureTextWidth(stripAnsi(text));
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

  let width = 0;
  let result = "";

  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    let charWidth = 1;
    if (isFullWidthChar(cp) || isEmoji(cp)) charWidth = 2;
    if (isCombiningChar(cp) || isBidiControl(cp)) charWidth = 0;

    if (width + charWidth + ellipsisWidth > maxWidth) {
      return result + ellipsis;
    }

    width += charWidth;
    result += ch;
  }

  return result;
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

  let width = 0;
  let result = "";
  let state: "normal" | "afterEsc" | "inCsi" = "normal";

  for (const ch of text) {
    if (state === "afterEsc") {
      if (ch === "[") {
        state = "inCsi";
      } else {
        state = "normal";
      }
      result += ch;
      continue;
    }

    if (state === "inCsi") {
      result += ch;
      const code = ch.charCodeAt(0);
      if (code >= 0x40 && code <= 0x7E) {
        state = "normal";
      }
      continue;
    }

    if (ch === "\x1b") {
      state = "afterEsc";
      result += ch;
      continue;
    }

    const cp = ch.codePointAt(0) ?? 0;
    let charWidth = 1;
    if (isFullWidthChar(cp) || isEmoji(cp)) charWidth = 2;
    if (isCombiningChar(cp) || isBidiControl(cp)) charWidth = 0;

    if (width + charWidth + ellipsisWidth > maxWidth) {
      return result + ellipsis;
    }

    width += charWidth;
    result += ch;
  }

  return result;
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

function isCombiningChar(cp: number): boolean {
  return (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe20 && cp <= 0xfe2f)
  );
}

function isBidiControl(cp: number): boolean {
  return (
    (cp >= 0x200e && cp <= 0x200f) ||
    (cp >= 0x202a && cp <= 0x202e) ||
    (cp >= 0x2066 && cp <= 0x2069)
  );
}

function isFullWidthChar(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x9fff) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7af) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6)
  );
}

function isEmoji(cp: number): boolean {
  return (
    (cp >= 0x1f300 && cp <= 0x1f9ff) ||
    (cp >= 0x2600 && cp <= 0x26ff) ||
    (cp >= 0x2700 && cp <= 0x27bf)
  );
}
