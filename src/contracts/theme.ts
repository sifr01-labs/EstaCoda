export type ThemeColors = {
  bannerBorder: string;
  bannerTitle: string;
  bannerAccent: string;
  bannerDim: string;
  bannerText: string;
  uiAccent: string;
  uiLabel: string;
  uiOk: string;
  uiError: string;
  uiWarn: string;
  prompt: string;
  inputRule: string;
  responseBorder: string;
  sessionLabel: string;
  sessionBorder: string;
  statusBarBg: string;
  voiceStatusBg: string;
  completionMenuBg: string;
  completionMenuCurrentBg: string;
  completionMenuMetaBg: string;
  completionMenuMetaCurrentBg: string;
};

export type SpinnerDefinition = {
  waitingFaces: string[];
  thinkingFaces: string[];
  thinkingVerbs: string[];
  wings: Array<readonly [left: string, right: string]>;
};

export type BrandingDefinition = {
  agentName: string;
  responseLabel: string;
  promptSymbol: string;
  helpHeader: string;
  taglinePrimary: string;
  taglineSecondary: string;
};

export type ToolSymbolMap = Record<string, string>;

export type ThemeDefinition = {
  name: string;
  description: string;
  colors: ThemeColors;
  spinner: SpinnerDefinition;
  branding: BrandingDefinition;
  toolPrefix: string;
  toolSymbols: ToolSymbolMap;
  bannerLogo?: string;
  bannerHero?: string;
};

