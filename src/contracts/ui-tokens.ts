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
  Omit<UiTokenContract, "glyph" | "toolIcon" | "branding" | "behavior">
> & {
  glyph?: Partial<TokenGlyph>;
  toolIcon?: Readonly<Record<string, string>>;
  branding?: Partial<TokenBranding>;
  behavior?: Partial<TokenBehavior>;
};

export interface ResolvedTokens {
  readonly mode: UiMode;
  readonly theme: UiTheme;
  readonly skin: SkinName | "none";
  readonly contract: UiTokenContract;
}
