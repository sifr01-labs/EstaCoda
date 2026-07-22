// v0.95 UI Token Contract
// Defines the complete set of design tokens used by the rendering pipeline.
// Skins are overlays on top of base themes; they override specific fields
// without replacing the entire token set.

export type UiMode = "plain" | "standard";
export type UiTheme = "light" | "dark";
export type SkinName = "kemetBlue";

export interface TokenColors {
  brand: string;        // identity / live state
  accent: string;       // section/accent labels
  action: string;       // turquoise - main action/selection accent
  caution: string;      // amber - rare caution/approval accent
}

export interface TokenSeverity {
  ok: string;
  error: string;
  warn: string;
  info: string;
}

export interface TokenTrace {
  terminal: string;
  search: string;
  plan: string;
  read: string;
  edit: string;
  answer: string;
  wait: string;
  finish: string;
  failed: string;
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
  placeholder: string;
  inverse: string;
  agentMessage: string;
}

export interface TokenInteractive {
  primary: string;
  primaryHover: string;
  selected: string;
  selectedBg: string;
}

export const SEMANTIC_MOTION_TOKENS = [
  "waiting",
  "thinking",
  "routing",
  "tool",
  "worker",
  "finalizing",
  "background",
] as const;

export type SemanticMotionToken = (typeof SEMANTIC_MOTION_TOKENS)[number];

export interface TokenMotionDefinition {
  readonly frames: readonly string[];
  readonly cadenceMs: number;
  /** Theme-owned foreground color for this motion token. */
  readonly color: string;
}

export type TokenMotion = Readonly<Record<SemanticMotionToken, TokenMotionDefinition>>;

export type TokenMotionOverlay = {
  readonly [Token in SemanticMotionToken]?: Partial<TokenMotionDefinition>;
};

export interface TokenGlyph {
  prompt: string;
  toolPrefix: string;
  continuation: string;
  bullet: string;
  check: string;
  cross: string;
  arrow: string;
  progress: {
    filled: string;
    empty: string;
    thumb: string;
  };
  trace: {
    event: string;
    selected: string;
    live: string;
    earlier: string;
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
  readonly trace: TokenTrace;
  readonly surface: TokenSurface;
  readonly text: TokenText;
  readonly interactive: TokenInteractive;
  readonly motion: TokenMotion;
  readonly glyph: TokenGlyph;
  readonly toolIcon: Readonly<Record<string, string>>;
  readonly branding: TokenBranding;
  readonly behavior: TokenBehavior;
}

// A partial set of overrides that a skin or mode can apply.
export type TokenOverlay = Partial<
  Omit<UiTokenContract, "palette" | "severity" | "trace" | "surface" | "text" | "interactive" | "motion" | "glyph" | "toolIcon" | "branding" | "behavior">
> & {
  palette?: Partial<TokenColors>;
  severity?: Partial<TokenSeverity>;
  trace?: Partial<TokenTrace>;
  surface?: Partial<TokenSurface>;
  text?: Partial<TokenText>;
  interactive?: Partial<TokenInteractive>;
  motion?: TokenMotionOverlay;
  glyph?: Partial<Omit<TokenGlyph, "progress" | "trace">> & {
    progress?: Partial<TokenGlyph["progress"]>;
    trace?: Partial<TokenGlyph["trace"]>;
  };
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
