import type { TokenOverlay } from "../contracts/ui-tokens.js";

// Plain mode overlay.
// Forces ASCII-safe symbols, disables ANSI color, disables emoji,
// disables animation, and uses minimal ASCII motion frames.
// This overlay is applied last, after base theme and skin.

export const plainOverlay: TokenOverlay = {
  motion: {
    waiting: { frames: ["|", "/", "-", "\\"] },
    thinking: { frames: ["o", "O", "o", "."] },
    routing: { frames: [">", ">>", ">", "."] },
    tool: { frames: ["|", "/", "-", "\\"] },
    worker: { frames: ["."] },
    finalizing: { frames: ["o", "O", "o", "."] },
    background: { frames: [".", "..", "...", "...."] },
  },
  glyph: {
    prompt: ">",
    toolPrefix: "|",
    continuation: "...",
    bullet: "-",
    check: "[OK]",
    cross: "[X]",
    arrow: ">>",
    progress: {
      filled: "#",
      empty: "-",
      thumb: ">",
    },
  },
  toolIcon: {
    terminal: "$",
    webSearch: "?",
    readFile: "R",
    writeFile: "W",
    searchFiles: "F",
    executeCode: "X",
    browserNavigate: "B",
    delegateTask: "D",
    mixtureOfAgents: "M",
    memory: "~",
    clarify: "?",
    cronjob: "C",
    process: "P",
    todo: "T",
    telegram: "@",
    media: "*",
  },
  branding: {
    responseLabel: "EstaCoda",
    helpHeader: "Available Commands",
    taglinePrimary: "⟡ SIFR01 ⟡",
    taglineSecondary: "",
    promptPrefix: "> ",
  },
  behavior: {
    allowEmoji: false,
    allowAnimation: false,
    allowAnsiColor: false,
  },
};
