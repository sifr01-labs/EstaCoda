// v0.95 Session Renderer
// Creates a ViewModel renderer for the CLI session loop.
// Falls back to plain renderer when capabilities restrict color.

import type { TerminalCapabilities, UiLocale } from "../contracts/ui.js";
import type { ViewModel } from "../contracts/view-model.js";
import type { ResolvedTokens } from "../contracts/ui-tokens.js";
import { detectTerminalCapabilities } from "../ui/terminal-capabilities.js";
import { renderPlain } from "../ui/renderers/plain-renderer.js";
import { StandardRenderer } from "../ui/renderers/standard-renderer.js";
import { resolveTokens } from "../theme/token-resolver.js";

export interface SessionRenderer {
  render(viewModel: ViewModel): string;
  tokens: ResolvedTokens;
  capabilities: TerminalCapabilities;
  locale: UiLocale;
}

export interface CreateSessionRendererOptions {
  output?: NodeJS.WritableStream;
  capabilities?: TerminalCapabilities;
  theme?: "light" | "dark";
  mode?: "standard" | "plain";
  locale?: UiLocale;
}

export function createSessionRenderer(options: CreateSessionRendererOptions = {}): SessionRenderer {
  const caps = options.capabilities ?? detectTerminalCapabilities({
    stream: options.output as { isTTY?: boolean; columns?: number } | undefined
  });

  const explicitPlain = options.mode === "plain";
  const shouldUsePlain =
    explicitPlain ||
    !caps.isTTY ||
    caps.isCI ||
    caps.isDumb ||
    !caps.supportsColor;

  const tokens = resolveTokens(shouldUsePlain ? "plain" : "standard", options.theme ?? "dark", "kemetBlue");
  const locale = options.locale ?? "en";

  if (shouldUsePlain) {
    return { render: (vm) => renderPlain(vm, locale, caps.terminalWidth), tokens, capabilities: caps, locale };
  }

  const renderer = new StandardRenderer({ tokens, capabilities: caps, locale });
  return { render: (vm) => renderer.render(vm), tokens, capabilities: caps, locale };
}
