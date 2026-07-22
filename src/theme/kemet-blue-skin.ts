import type { ThemeAwareSkin } from "../contracts/ui-tokens.js";

// KemetBlue v0.95 skin.
// Theme-aware brand expression layer with shared, dark, and light mappings.
// Shared overrides glyphs, branding, and tool icons.
// Dark and light mappings express the Kemet brand palette per theme.

export const kemetBlueSkin: ThemeAwareSkin = {
  shared: {
    glyph: {
      prompt: "›",
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
      taglinePrimary: "⟡ SIFR01 ⟡",
      taglineSecondary: "السيادة التكنولوجية العربية",
      promptPrefix: "> ",
    },
  },
  dark: {
    palette: {
      brand: "#4389D7",
      accent: "#4EA1FF",
      action: "#40E0D0",
      caution: "#FFB454",
    },
    severity: {
      info: "#5AACFF",
    },
    trace: {
      terminal: "#B0B0B0",
      search: "#5AACFF",
      plan: "#B899FF",
      read: "#7BBFFF",
      edit: "#40E0D0",
      answer: "#7BD88F",
      wait: "#FFB454",
      finish: "#4CAF50",
      failed: "#EF5350",
    },
    text: {
      agentMessage: "#FFFFFF",
    },
    motion: {
      waiting: { color: "#5AACFF" },
      thinking: { color: "#B899FF" },
      routing: { color: "#5ED0E6" },
      tool: { color: "#40E0D0" },
      worker: { color: "#4EA1FF" },
      finalizing: { color: "#D7A7FF" },
      background: { color: "#888888" },
    },
  },
  light: {
    palette: {
      brand: "#4389D7",
      accent: "#0057D9",
      action: "#008C95",
      caution: "#B45309",
    },
    severity: {
      info: "#0057D9",
    },
    trace: {
      terminal: "#616161",
      search: "#0057D9",
      plan: "#6D28D9",
      read: "#2563EB",
      edit: "#008C95",
      answer: "#2E7D32",
      wait: "#B45309",
      finish: "#2E7D32",
      failed: "#C62828",
    },
    motion: {
      waiting: { color: "#0057D9" },
      thinking: { color: "#6D28D9" },
      routing: { color: "#007C91" },
      tool: { color: "#008C95" },
      worker: { color: "#2563EB" },
      finalizing: { color: "#7E22CE" },
      background: { color: "#757575" },
    },
  },
};
