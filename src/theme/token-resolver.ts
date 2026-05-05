import type {
  UiMode,
  UiTheme,
  SkinName,
  UiTokenContract,
  TokenOverlay,
  ResolvedTokens,
} from "../contracts/ui-tokens.js";
import { lightTheme } from "./base-light.js";
import { darkTheme } from "./base-dark.js";
import { kemetBlueSkin } from "./kemet-blue-skin.js";
import { plainOverlay } from "./plain-overlay.js";

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function mergeDeep<T extends object>(
  target: T,
  source: Partial<T>
): T {
  const result = { ...(target as Record<string, unknown>) };
  for (const key of Object.keys(source)) {
    const srcVal = (source as Record<string, unknown>)[key];
    const tgtVal = result[key];
    if (
      isObject(srcVal) &&
      isObject(tgtVal) &&
      !Array.isArray(srcVal) &&
      !Array.isArray(tgtVal)
    ) {
      result[key] = mergeDeep(
        tgtVal as Record<string, unknown>,
        srcVal as Record<string, unknown>
      );
    } else if (srcVal !== undefined) {
      result[key] = srcVal;
    }
  }
  return result as T;
}

export function resolveTokens(
  mode: UiMode,
  theme: UiTheme,
  skin: SkinName | "none" = "none"
): ResolvedTokens {
  const base = theme === "light" ? lightTheme : darkTheme;

  let merged: UiTokenContract = { ...base };

  if (skin === "kemetBlue") {
    merged = applyOverlay(merged, kemetBlueSkin);
  }

  if (mode === "plain") {
    merged = applyOverlay(merged, plainOverlay);
  }

  return {
    mode,
    theme,
    skin,
    contract: merged,
  };
}

function applyOverlay(
  base: UiTokenContract,
  overlay: TokenOverlay
): UiTokenContract {
  return mergeDeep(base, overlay as Partial<UiTokenContract>);
}

export function getBaseTheme(theme: UiTheme): UiTokenContract {
  return theme === "light" ? lightTheme : darkTheme;
}
