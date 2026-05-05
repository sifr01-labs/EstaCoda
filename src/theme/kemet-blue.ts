// DEPRECATED: Temporary compatibility shim.
// Re-exports kemetBlueTheme as the legacy ThemeDefinition shape.
// New code should use resolveTokens(mode, theme, "kemetBlue") from
// ./token-resolver.js and the UiTokenContract in contracts/ui-tokens.ts.

import type { ThemeDefinition } from "../contracts/theme.js";
import { resolveTokens } from "./token-resolver.js";

const t = resolveTokens("standard", "light", "kemetBlue").contract;

export const kemetBlueTheme: ThemeDefinition = {
  name: "kemet-blue",
  description:
    "EstaCoda default - Egyptian blue, copper, terracotta, and cream terminal palette.",
  colors: {
    bannerBorder: "#1034A6",
    bannerTitle: "#4A9FD4",
    bannerAccent: "#E2725B",
    bannerDim: "#0A2269",
    bannerText: "#F5F5DC",
    uiAccent: "#B87333",
    uiLabel: "#5DB8F5",
    uiOk: "#2E8B57",
    uiError: "#C75146",
    uiWarn: "#D4741E",
    prompt: "#F5F5DC",
    inputRule: "#1034A6",
    responseBorder: "#4A6BC0",
    sessionLabel: "#B87333",
    sessionBorder: "#4A6BC0",
    statusBarBg: "#0A1F44",
    voiceStatusBg: "#0A1F44",
    completionMenuBg: "#0F2A5C",
    completionMenuCurrentBg: "#1E3A8A",
    completionMenuMetaBg: "#0F2A5C",
    completionMenuMetaCurrentBg: "#1E3A8A",
  },
  spinner: {
    waitingFaces: ["(\u2326)", "(\u25c8)", "(\u2726)", "(\u25c9)", "(\u2625)"],
    thinkingFaces: ["(\u2326)", "(\u25d0)", "(\u25d1)", "(\u25d2)"],
    thinkingVerbs: [
      "\u0634\u063a\u0651\u0627\u0644",
      "\u0628\u0641\u0643\u0631 \u0641\u064a\u0647\u0627",
      "\u0628\u0638\u0628\u0637\u0647\u0627",
      "\u0628\u0639\u062c\u0646\u0647\u0627",
      "\u0628\u0637\u0628\u062e\u0647\u0627",
      "\u0628\u0641\u0635\u0641\u0635\u0647\u0627",
      "\u0645\u0631\u0648\u0642\u0646\u0647\u0627",
      "\u062f\u0627\u064a\u0633",
      "\u0628\u0646\u0628\u0634 \u0641\u064a\u0647\u0627",
      "\u0645\u0642\u0636\u064a\u0647\u0627",
      "\u0645\u0643\u0631\u0643\u0628\u0647\u0627",
    ],
    wings: [
      ["\ud80c\udc80", "\ud80c\udc80"],
      ["\u2625", "\u2625"],
      ["\u2326", "\u2326"],
      ["\u25c8", "\u25c8"],
      ["\u2039", "\u203a"],
    ],
  },
  branding: {
    agentName: t.branding.agentName,
    responseLabel: t.branding.responseLabel,
    promptSymbol: t.glyph.prompt,
    helpHeader: t.branding.helpHeader,
    taglinePrimary: t.branding.taglinePrimary,
    taglineSecondary: t.branding.taglineSecondary,
  },
  toolPrefix: t.glyph.toolPrefix,
  toolSymbols: { ...t.toolIcon },
};
