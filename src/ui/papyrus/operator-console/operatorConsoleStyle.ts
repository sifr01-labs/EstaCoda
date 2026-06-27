import type { TerminalCapabilities } from "../../../contracts/ui.js";
import type { ResolvedTokens } from "../../../contracts/ui-tokens.js";

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
  if (style.supportsTrueColor) {
    const { r, g, b } = hexToRgb(hex);
    return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
  }
  return `\x1b[38;5;${hexToAnsi256(hex)}m${text}\x1b[0m`;
}

export function styleBgColor(
  style: OperatorConsoleStyle | undefined,
  text: string,
  hex: string
): string {
  if (style === undefined || !style.supportsColor) return text;
  if (style.supportsTrueColor) {
    const { r, g, b } = hexToRgb(hex);
    return `\x1b[48;2;${r};${g};${b}m${text}\x1b[0m`;
  }
  return `\x1b[48;5;${hexToAnsi256(hex)}m${text}\x1b[0m`;
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

function hexToAnsi256(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  const ansiR = Math.round((r / 255) * 5);
  const ansiG = Math.round((g / 255) * 5);
  const ansiB = Math.round((b / 255) * 5);
  return 16 + (36 * ansiR) + (6 * ansiG) + ansiB;
}
