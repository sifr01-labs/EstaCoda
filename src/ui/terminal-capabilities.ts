import { stdin as defaultInput } from "node:process";
import type { TerminalCapabilities } from "../contracts/ui.js";

export interface DetectOptions {
  stream?: { isTTY?: boolean; columns?: number };
  env?: Record<string, string | undefined>;
  platform?: string;
}

function normalizeEnv(
  input: Record<string, string | undefined> | undefined
): NodeJS.ProcessEnv {
  return (input ?? process.env) as NodeJS.ProcessEnv;
}

export function detectTerminalCapabilities(
  options?: DetectOptions
): TerminalCapabilities {
  const env = normalizeEnv(options?.env);
  const stream = options?.stream ?? process.stdout;
  const platform = options?.platform ?? process.platform;

  const isTTY = stream.isTTY ?? false;
  const isDumb = (env.TERM ?? "").toLowerCase() === "dumb";
  const isCI = !!(
    env.CI ||
    env.GITHUB_ACTIONS ||
    env.GITLAB_CI ||
    env.CIRCLECI ||
    env.TRAVIS ||
    env.BUILDKITE ||
    env.DRONE ||
    env.APPVEYOR ||
    env.TF_BUILD
  );

  // Color detection
  let supportsColor = false;
  let supportsTrueColor = false;

  if (env.NO_COLOR && env.NO_COLOR !== "0" && env.NO_COLOR !== "false") {
    supportsColor = false;
    supportsTrueColor = false;
  } else if (env.FORCE_COLOR === "0" || env.FORCE_COLOR === "false") {
    supportsColor = false;
    supportsTrueColor = false;
  } else if (
    env.FORCE_COLOR
  ) {
    supportsColor = true;
    supportsTrueColor =
      env.FORCE_COLOR === "3" || env.FORCE_COLOR === "true";
  } else if (isDumb) {
    supportsColor = false;
  } else if (isTTY) {
    supportsColor = true;
    const colorTerm = (env.COLORTERM ?? "").toLowerCase();
    supportsTrueColor =
      colorTerm === "truecolor" || colorTerm === "24bit";
  }

  // Unicode detection
  let supportsUnicode = false;
  const locale = (env.LC_ALL || env.LANG || "").toLowerCase();
  if (platform === "win32") {
    supportsUnicode =
      isTTY &&
      (env.WT_SESSION !== undefined ||
        env.TERMINUS_SUBLIME !== undefined ||
        env.TERM_PROGRAM === "vscode");
  } else {
    supportsUnicode =
      locale.includes("utf-8") || locale.includes("utf8") || locale === "";
  }

  // Emoji detection
  let supportsEmoji = supportsUnicode;
  if (
    env.NO_EMOJI ||
    (env.ESTACODA_NO_EMOJI && env.ESTACODA_NO_EMOJI !== "0")
  ) {
    supportsEmoji = false;
  }

  // Terminal width
  let terminalWidth = 80;
  if (typeof stream.columns === "number" && stream.columns > 0) {
    terminalWidth = stream.columns;
  } else if (env.COLUMNS) {
    const parsed = parseInt(env.COLUMNS, 10);
    if (!isNaN(parsed) && parsed > 0) {
      terminalWidth = parsed;
    }
  }

  // Animation eligibility: interactive TTY only
  const supportsAnimation =
    isTTY && !isDumb && !isCI && supportsColor;

  return {
    isTTY,
    supportsColor,
    supportsTrueColor,
    supportsUnicode,
    supportsEmoji,
    terminalWidth,
    isDumb,
    isCI,
    supportsAnimation,
  };
}

export function shouldAnimate(
  capabilities: TerminalCapabilities
): boolean {
  return capabilities.supportsAnimation;
}

export function shouldUseEmoji(
  capabilities: TerminalCapabilities,
  skinAllowsEmoji = true
): boolean {
  if (!capabilities.supportsEmoji) return false;
  if (skinAllowsEmoji === false) return false;
  return true;
}

export function canRunInteractive(input: NodeJS.ReadStream = defaultInput): boolean {
  return input.isTTY === true;
}
