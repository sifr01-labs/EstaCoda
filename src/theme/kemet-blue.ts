import type { ThemeDefinition } from "../contracts/theme.js";

export const kemetBlueTheme: ThemeDefinition = {
  name: "kemet-blue",
  description: "EstaCoda default - Egyptian blue, copper, terracotta, and cream terminal palette.",
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
    completionMenuMetaCurrentBg: "#1E3A8A"
  },
  spinner: {
    waitingFaces: ["(⌬)", "(◈)", "(✦)", "(◉)", "(☥)"],
    thinkingFaces: ["(⌬)", "(◐)", "(◑)", "(◒)"],
    thinkingVerbs: [
      "شغّال",
      "بفكر فيها",
      "بظبطها",
      "بعجنها",
      "بطبخها",
      "بفصفصها",
      "مروقنها",
      "دايس",
      "بنبش فيها",
      "مقضيها",
      "مكركبها"
    ],
    wings: [
      ["𓂀", "𓂀"],
      ["☥", "☥"],
      ["⌬", "⌬"],
      ["◈", "◈"],
      ["‹", "›"]
    ]
  },
  branding: {
    agentName: "EstaCoda",
    responseLabel: "𓂀 EstaCoda",
    promptSymbol: "›",
    helpHeader: "𓂀 Available Commands",
    taglinePrimary: "☥ Kemet Research ☥",
    taglineSecondary: "السيادة التكنولوجية للعالم العربي"
  },
  toolPrefix: "│",
  toolSymbols: {
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
    media: "◉"
  }
};

