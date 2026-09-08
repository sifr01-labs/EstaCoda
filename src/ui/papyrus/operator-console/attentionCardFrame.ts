import { padVisibleEnd, truncateVisible } from "../../renderers/layout.js";
import { closeOpenBidiIsolates } from "../../bidi.js";
import { stringWidth } from "../screen/stringWidth.js";
import {
  styleColor,
  type OperatorConsoleStyle,
} from "./operatorConsoleStyle.js";

const MAX_ATTENTION_CARD_WIDTH = 104;
const WIDE_TERMINAL_INSET = 2;

export type AttentionCardGeometry = {
  readonly terminalWidth: number;
  readonly frameWidth: number;
  readonly contentWidth: number;
  readonly inset: number;
};

export function resolveAttentionCardGeometry(width: number): AttentionCardGeometry {
  const terminalWidth = normalizeDimension(width);
  const availableWidth = terminalWidth >= 48
    ? terminalWidth - (WIDE_TERMINAL_INSET * 2)
    : terminalWidth;
  const frameWidth = Math.min(MAX_ATTENTION_CARD_WIDTH, Math.max(0, availableWidth));
  return {
    terminalWidth,
    frameWidth,
    contentWidth: Math.max(0, frameWidth - 4),
    inset: Math.max(0, Math.floor((terminalWidth - frameWidth) / 2)),
  };
}

export function attentionCardHeaderFitsRightLabel(
  geometry: AttentionCardGeometry,
  title: string,
  rightLabel: string | undefined
): boolean {
  if (rightLabel === undefined || rightLabel.length === 0) return false;
  return stringWidth(`─ ${title} `) + stringWidth(` ${rightLabel} ─`) + 1 <= Math.max(0, geometry.frameWidth - 2);
}

export function renderAttentionCardTopBorder(input: {
  readonly geometry: AttentionCardGeometry;
  readonly title: string;
  readonly rightLabel?: string;
  readonly style?: OperatorConsoleStyle;
  readonly titleColor?: string;
  readonly rightLabelColor?: string;
}): string {
  const { geometry } = input;
  if (geometry.frameWidth <= 0) return "";
  if (geometry.frameWidth < 3) return `${indent(geometry)}${"╭─".slice(0, geometry.frameWidth)}`;

  const borderColor = input.style?.tokens.contract.surface.borderSubtle;
  if (geometry.frameWidth < 6) {
    return `${indent(geometry)}${color(
      input.style,
      `╭${"─".repeat(Math.max(0, geometry.frameWidth - 2))}╮`,
      borderColor
    )}`;
  }
  const fittedTitle = closeOpenBidiIsolates(
    truncateVisible(input.title, Math.max(0, geometry.frameWidth - 6), "")
  );
  const title = `─ ${fittedTitle} `;
  const showRightLabel = fittedTitle === input.title && attentionCardHeaderFitsRightLabel(
    geometry,
    input.title,
    input.rightLabel
  );
  const right = showRightLabel ? ` ${input.rightLabel} ─` : "─";
  const fill = "─".repeat(Math.max(0, geometry.frameWidth - 2 - stringWidth(title) - stringWidth(right)));
  return [
    indent(geometry),
    color(input.style, "╭", borderColor),
    color(input.style, title, input.titleColor),
    color(input.style, showRightLabel ? `${fill} ` : `${fill}${right}`, borderColor),
    ...(showRightLabel ? [
      color(input.style, input.rightLabel!, input.rightLabelColor),
      color(input.style, " ─", borderColor),
    ] : []),
    color(input.style, "╮", borderColor),
  ].join("");
}

export function renderAttentionCardRow(
  content: string,
  geometry: AttentionCardGeometry,
  style?: OperatorConsoleStyle
): string {
  if (geometry.frameWidth <= 0) return "";
  if (geometry.frameWidth < 3) return `${indent(geometry)}${"│ ".slice(0, geometry.frameWidth)}`;
  const borderColor = style?.tokens.contract.surface.borderSubtle;
  return [
    indent(geometry),
    color(style, "│", borderColor),
    " ",
    padVisibleEnd(
      closeOpenBidiIsolates(truncateVisible(content, geometry.contentWidth, "")),
      geometry.contentWidth
    ),
    " ",
    color(style, "│", borderColor),
  ].join("");
}

export function renderAttentionCardBottomBorder(
  geometry: AttentionCardGeometry,
  style?: OperatorConsoleStyle
): string {
  if (geometry.frameWidth <= 0) return "";
  if (geometry.frameWidth < 3) return `${indent(geometry)}${"╰─".slice(0, geometry.frameWidth)}`;
  const borderColor = style?.tokens.contract.surface.borderSubtle;
  return `${indent(geometry)}${color(
    style,
    `╰${"─".repeat(Math.max(0, geometry.frameWidth - 2))}╯`,
    borderColor
  )}`;
}

function color(
  style: OperatorConsoleStyle | undefined,
  value: string,
  token: string | undefined
): string {
  return token === undefined ? value : styleColor(style, value, token);
}

function indent(geometry: AttentionCardGeometry): string {
  return " ".repeat(geometry.inset);
}

function normalizeDimension(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}
