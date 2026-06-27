import type { ThemeAwareSkin } from "../contracts/ui-tokens.js";

// KemetBlue v0.95 skin.
// Theme-aware brand expression layer with shared, dark, and light mappings.
// Shared overrides glyphs, branding, and tool icons.
// Dark and light mappings express the Kemet brand palette per theme.

export const kemetBlueSkin: ThemeAwareSkin = {
  shared: {
    glyph: {
      prompt: "›",
      spinner: {
        waiting: ["⌦", "◈", "✦", "◉", "☥"],
        thinking: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
        tool: ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"],
        background: ["⡀", "⠄", "⠂", "⠁", "⠈", "⠐", "⠠", "⢀"],
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
      taglineSecondary: "السيادة التكنولوجية العربية",
      promptPrefix: "> ",
    },
  },
  dark: {
    palette: {
      brand: "#4C8AE0",
      action: "#40E0D0",
      caution: "#FFB454",
    },
    severity: {
      info: "#5AACFF",
    },
    text: {
      agentMessage: "#FFFFFF",
    },
  },
  light: {
    palette: {
      brand: "#0057D9",
      action: "#008C95",
      caution: "#B45309",
    },
    severity: {
      info: "#0057D9",
    },
  },
};
