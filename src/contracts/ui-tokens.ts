// v0.95 UI Token Contract
// Defines the complete set of design tokens used by the rendering pipeline.
// Skins are overlays on top of base themes; they override specific fields
// without replacing the entire token set.

export type UiMode = "plain" | "standard";
export type UiTheme = "light" | "dark";
export type SkinName = "kemetBlue";

export interface TokenColors {
  brand: string;        // identity / live state
  action: string;       // turquoise - main action/selection accent
  caution: string;      // amber - rare caution/approval accent
}

export interface TokenSeverity {
  ok: string;
  error: string;
  warn: string;
  info: string;
}

export interface TokenSurface {
  bg: string;
  bgElevated: string;
  bgInset: string;
  border: string;
  borderSubtle: string;
}

export interface TokenText {
  primary: string;
  secondary: string;
  muted: string;
  inverse: string;
  agentMessage: string;
}

export interface TokenInteractive {
  primary: string;
  primaryHover: string;
  selected: string;
  selectedBg: string;
}

export interface TokenSpinner {
  waiting: readonly string[];
  thinking: readonly string[];
  tool: readonly string[];
  background: readonly string[];
}

export interface TokenGlyph {
  prompt: string;
  toolPrefix: string;
  continuation: string;
  bullet: string;
  check: string;
  cross: string;
  arrow: string;
  spinner: TokenSpinner;
  progress: {
    filled: string;
    empty: string;
    thumb: string;
  };
}

export interface TokenBranding {
  agentName: string;
  responseLabel: string;
  helpHeader: string;
  taglinePrimary: string;
  taglineSecondary: string;
  promptPrefix?: string;
}

export interface TokenBehavior {
  allowEmoji: boolean;
  allowAnimation: boolean;
  allowAnsiColor: boolean;
}

export interface UiTokenContract {
  readonly palette: TokenColors;
  readonly severity: TokenSeverity;
  readonly surface: TokenSurface;
  readonly text: TokenText;
  readonly interactive: TokenInteractive;
  readonly glyph: TokenGlyph;
  readonly toolIcon: Readonly<Record<string, string>>;
  readonly branding: TokenBranding;
  readonly behavior: TokenBehavior;
}

// A partial set of overrides that a skin or mode can apply.
export type TokenOverlay = Partial<
  Omit<UiTokenContract, "palette" | "severity" | "surface" | "text" | "interactive" | "glyph" | "toolIcon" | "branding" | "behavior">
> & {
  palette?: Partial<TokenColors>;
  severity?: Partial<TokenSeverity>;
  surface?: Partial<TokenSurface>;
  text?: Partial<TokenText>;
  interactive?: Partial<TokenInteractive>;
  glyph?: Partial<TokenGlyph>;
  toolIcon?: Readonly<Record<string, string>>;
  branding?: Partial<TokenBranding>;
  behavior?: Partial<TokenBehavior>;
};

// Theme-aware skin with shared, dark, and light token sets.
// Shared applies first, then the theme-specific set overrides.
export interface ThemeAwareSkin {
  readonly shared: TokenOverlay;
  readonly dark: TokenOverlay;
  readonly light: TokenOverlay;
}

export interface ResolvedTokens {
  readonly mode: UiMode;
  readonly theme: UiTheme;
  readonly skin: SkinName;
  readonly contract: UiTokenContract;
}
