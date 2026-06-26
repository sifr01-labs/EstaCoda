import type { Output } from "./output.js";

export type BorderStyle = "single" | "double" | "round" | "ascii";

export type BorderWriter = Pick<Output, "write">;

export type BorderOptions = {
  output: BorderWriter;
  x: number;
  y: number;
  width: number;
  height: number;
  style?: BorderStyle;
};

type BorderCharacters = {
  topLeft: string;
  topRight: string;
  bottomLeft: string;
  bottomRight: string;
  horizontal: string;
  vertical: string;
};

const BORDER_CHARACTERS: Record<BorderStyle, BorderCharacters> = {
  single: {
    topLeft: "┌",
    topRight: "┐",
    bottomLeft: "└",
    bottomRight: "┘",
    horizontal: "─",
    vertical: "│",
  },
  double: {
    topLeft: "╔",
    topRight: "╗",
    bottomLeft: "╚",
    bottomRight: "╝",
    horizontal: "═",
    vertical: "║",
  },
  round: {
    topLeft: "╭",
    topRight: "╮",
    bottomLeft: "╰",
    bottomRight: "╯",
    horizontal: "─",
    vertical: "│",
  },
  ascii: {
    topLeft: "+",
    topRight: "+",
    bottomLeft: "+",
    bottomRight: "+",
    horizontal: "-",
    vertical: "|",
  },
};

export function renderBorder({ output, x, y, width, height, style = "single" }: BorderOptions): void {
  const left = Math.floor(x);
  const top = Math.floor(y);
  const borderWidth = Math.max(0, Math.floor(width));
  const borderHeight = Math.max(0, Math.floor(height));
  if (borderWidth === 0 || borderHeight === 0) return;

  const chars = BORDER_CHARACTERS[style];
  if (borderWidth === 1 && borderHeight === 1) {
    output.write(left, top, chars.topLeft);
    return;
  }

  if (borderHeight === 1) {
    output.write(left, top, horizontalLine(chars, borderWidth, chars.topLeft, chars.topRight));
    return;
  }

  if (borderWidth === 1) {
    output.write(left, top, chars.topLeft);
    for (let row = 1; row < borderHeight - 1; row += 1) output.write(left, top + row, chars.vertical);
    output.write(left, top + borderHeight - 1, chars.bottomLeft);
    return;
  }

  output.write(left, top, horizontalLine(chars, borderWidth, chars.topLeft, chars.topRight));
  for (let row = 1; row < borderHeight - 1; row += 1) {
    output.write(left, top + row, chars.vertical);
    output.write(left + borderWidth - 1, top + row, chars.vertical);
  }
  output.write(left, top + borderHeight - 1, horizontalLine(chars, borderWidth, chars.bottomLeft, chars.bottomRight));
}

function horizontalLine(chars: BorderCharacters, width: number, left: string, right: string): string {
  if (width === 1) return left;
  return left + chars.horizontal.repeat(Math.max(0, width - 2)) + right;
}
