// Placeholder UI contract types for v0.95 rendering pipeline.
// Expanded in Phases 3-6.

export type { UiMode, UiTheme, SkinName } from "./ui-tokens.js";
export type { UiTokenContract, ResolvedTokens } from "./ui-tokens.js";

export interface TerminalCapabilities {
  isTTY: boolean;
  supportsColor: boolean;
  supportsTrueColor: boolean;
  supportsUnicode: boolean;
  supportsEmoji: boolean;
  terminalWidth: number;
  isDumb: boolean;
  isCI: boolean;
  supportsAnimation: boolean;
}

export interface Renderer {
  // To be defined in Phase 5-6.
  readonly capabilities: TerminalCapabilities;
  readonly tokens: import("./ui-tokens.js").ResolvedTokens;
}

export interface SurfaceAdapter {
  // To be defined in Phase 10.
  deliver(text: string): Promise<void>;
}
