import type { TokenOverlay } from "../contracts/ui-tokens.js";

// KemetBlue v0.95 skin overlay.
// Overrides glyphs, branding, and tool icons with Egyptian-themed symbols.
// Brand and accent colors are inherited from the base theme (light/dark).
// Surfaces stay neutral.

export const kemetBlueSkin: TokenOverlay = {
  glyph: {
    prompt: "›",
    spinner: {
      waiting: ["(⌦)", "(◈)", "(✦)", "(◉)", "(☥)"],
      thinking: ["(⌦)", "(◐)", "(◑)", "(◒)"],
    },
  },
  toolIcon: {
    terminal: "⌘",
    webSearch: "◎",
    readFile: "◰",
    writeFile: "◆",
    searchFiles: "◇",
    executeCode: "⌬",
    browserNavigate: "☞",
    delegateTask: "☷",
    mixtureOfAgents: "☵",
    memory: "☥",
    clarify: "?",
    cronjob: "◷",
    process: "⌁",
    todo: "□",
    telegram: "✉",
    media: "◉",
  },
  branding: {
    agentName: "EstaCoda",
    responseLabel: "𓂀 EstaCoda",
    helpHeader: "𓂀 Available Commands",
    taglinePrimary: "☥ Kemet Research ☥",
    taglineSecondary: "السيادة التكنولوجية للعالم العربي",
  },
};
