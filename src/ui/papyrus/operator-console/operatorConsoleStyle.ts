import type { TerminalCapabilities } from "../../../contracts/ui.js";
import type { ResolvedTokens } from "../../../contracts/ui-tokens.js";
import { padVisibleEnd, truncateVisible } from "../../renderers/layout.js";

export type OperatorConsoleStyle = {
  readonly tokens: ResolvedTokens;
  readonly supportsColor: boolean;
  readonly supportsTrueColor: boolean;
};

export function createOperatorConsoleStyle(input: {
  readonly tokens: ResolvedTokens;
  readonly capabilities: Pick<TerminalCapabilities, "supportsColor" | "supportsTrueColor">;
}): OperatorConsoleStyle {
  return {
    tokens: input.tokens,
    supportsColor: input.capabilities.supportsColor && input.tokens.contract.behavior.allowAnsiColor,
    supportsTrueColor: input.capabilities.supportsTrueColor,
  };
}

export function styleColor(
  style: OperatorConsoleStyle | undefined,
  text: string,
  hex: string
): string {
  if (style === undefined || !style.supportsColor) return text;
  const { r, g, b } = hexToRgb(hex);
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}

export function styleBgColor(
  style: OperatorConsoleStyle | undefined,
  text: string,
  hex: string
): string {
  if (style === undefined || !style.supportsColor) return text;
  const { r, g, b } = hexToRgb(hex);
  const background = `\x1b[48;2;${r};${g};${b}m`;
  return `${background}${text.replaceAll("\x1b[0m", `\x1b[0m${background}`)}\x1b[0m`;
}

export function styleBackgroundRow(
  style: OperatorConsoleStyle | undefined,
  text: string,
  width: number,
  hex: string
): string {
  const normalizedWidth = Math.max(0, Math.floor(width));
  const padded = padVisibleEnd(truncateVisible(text, normalizedWidth, "…"), normalizedWidth);
  return styleBgColor(style, padded, hex);
}

export function styleBold(style: OperatorConsoleStyle | undefined, text: string): string {
  if (style === undefined || !style.supportsColor) return text;
  return `\x1b[1m${text}\x1b[0m`;
}

function hexToRgb(hex: string): { readonly r: number; readonly g: number; readonly b: number } {
  const clean = hex.replace("#", "");
  const bigint = Number.parseInt(clean, 16);
  return {
    r: (bigint >> 16) & 255,
    g: (bigint >> 8) & 255,
    b: bigint & 255,
  };
}
