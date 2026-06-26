import { cursorPosition, eraseLine } from "../termio/csi.js";
import type { TextStyle } from "../termio/types.js";
import type { Diff, Frame } from "./frame.js";
import { shouldClearScreen } from "./frame.js";
import { optimize } from "./optimizer.js";
import { CellWidth, type CellSnapshot, type Screen } from "./screen.js";

export function diffFrames(prev: Frame, next: Frame): Diff {
  const clearReason = shouldClearScreen(prev, next);
  if (clearReason) {
    return optimize([{ type: "clearTerminal", reason: clearReason }, { type: "stdout", content: serializeScreen(next.screen) }]);
  }

  const patches: Diff = [];
  for (let y = 0; y < next.screen.height; y += 1) {
    let x = 0;
    while (x < next.screen.width) {
      const nextCell = next.screen.cellAt(x, y);
      if (prev.screen.equalsCell(next.screen, x, y) || nextCell?.width === CellWidth.Spacer) {
        x += 1;
        continue;
      }

      const start = x;
      let content = "";
      let styleId = 0;
      let style: TextStyle | undefined;
      let hyperlink: string | undefined;
      while (x < next.screen.width) {
        const cell = next.screen.cellAt(x, y);
        if (prev.screen.equalsCell(next.screen, x, y) || cell?.width === CellWidth.Spacer) break;
        const cellStyle = next.screen.getStyle(cell?.styleId ?? 0);
        const cellHyperlink = next.screen.getHyperlink(cell?.hyperlinkId ?? 0);
        if (style === undefined) {
          style = cellStyle;
          styleId = cell?.styleId ?? 0;
          hyperlink = cellHyperlink;
        } else if (JSON.stringify(style) !== JSON.stringify(cellStyle) || hyperlink !== cellHyperlink) {
          break;
        }
        content += nextCellToString(cell);
        x += cell?.width === CellWidth.Wide ? 2 : 1;
      }

      patches.push({ type: "cursorTo", x: start, y });
      patches.push({ type: "cellRun", x: start, y, content, styleId, style: style!, hyperlink });
    }
  }

  return optimize(patches);
}

export function renderDiff(diff: Diff): string {
  let result = "";
  for (const patch of diff) {
    if (patch.type === "stdout") result += patch.content;
    else if (patch.type === "cellRun") result += serializeStyle(patch.style) + patch.content + (isDefaultStyle(patch.style) ? "" : "\x1b[0m");
    else if (patch.type === "cursorTo") result += cursorPosition(patch.y + 1, patch.x + 1);
    else if (patch.type === "cursorMove") result += cursorPosition(patch.y + 1, patch.x + 1);
    else if (patch.type === "clear") result += Array.from({ length: patch.count }, () => eraseLine()).join("");
    else if (patch.type === "clearTerminal") result += "\x1b[2J\x1b[H";
  }
  return result;
}

function serializeStyle(style: TextStyle): string {
  if (isDefaultStyle(style)) return "\x1b[0m";
  const codes: number[] = [];
  if (style.bold) codes.push(1);
  if (style.dim) codes.push(2);
  if (style.italic) codes.push(3);
  if (style.underline !== "none") codes.push(style.underline === "double" ? 21 : 4);
  if (style.blink) codes.push(5);
  if (style.inverse) codes.push(7);
  if (style.hidden) codes.push(8);
  if (style.strikethrough) codes.push(9);
  if (style.fg.type === "named") {
    const index = namedColorIndex(style.fg.name);
    codes.push(index < 8 ? 30 + index : 90 + index - 8);
  }
  if (style.bg.type === "named") {
    const index = namedColorIndex(style.bg.name);
    codes.push(index < 8 ? 40 + index : 100 + index - 8);
  }
  return codes.length === 0 ? "" : `\x1b[${codes.join(";")}m`;
}

function isDefaultStyle(style: TextStyle): boolean {
  return JSON.stringify(style) === JSON.stringify({
    bold: false,
    dim: false,
    italic: false,
    underline: "none",
    blink: false,
    inverse: false,
    hidden: false,
    strikethrough: false,
    overline: false,
    fg: { type: "default" },
    bg: { type: "default" },
    underlineColor: { type: "default" },
  });
}

function namedColorIndex(name: string): number {
  return [
    "black",
    "red",
    "green",
    "yellow",
    "blue",
    "magenta",
    "cyan",
    "white",
    "brightBlack",
    "brightRed",
    "brightGreen",
    "brightYellow",
    "brightBlue",
    "brightMagenta",
    "brightCyan",
    "brightWhite",
  ].indexOf(name);
}

function serializeScreen(screen: Screen): string {
  const lines: string[] = [];
  for (let y = 0; y < screen.height; y += 1) lines.push(screen.rowText(y).trimEnd());
  return lines.join("\n");
}

function nextCellToString(cell: CellSnapshot | undefined): string {
  if (!cell || cell.width === CellWidth.Spacer) return "";
  return cell.char;
}
