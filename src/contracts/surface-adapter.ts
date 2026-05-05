// v0.95 SurfaceAdapter Contract
// Abstraction layer between ViewModels and channel-specific output.
// Each surface adapter knows its channel capabilities (emoji, ANSI, HTML, markdown)
// and produces safe output accordingly.

import type { ViewModel } from "./view-model.js";
import type { RuntimeEvent } from "./runtime-event.js";

export type SurfaceKind = "cli" | "telegram" | "discord" | "whatsapp" | "email" | "plain-log";

export type SurfaceCapabilities = {
  readonly supportsEmoji: boolean;
  readonly supportsAnsi: boolean;
  readonly supportsHtml: boolean;
  readonly supportsMarkdown: boolean;
  readonly maxTextLength?: number;
};

export interface SurfaceAdapter {
  readonly kind: SurfaceKind;
  readonly capabilities: SurfaceCapabilities;

  /** Render a ViewModel to channel-safe text. */
  render(viewModel: ViewModel): string;

  /** Render a tool activity event to channel-safe text. */
  renderToolActivity(event: Extract<RuntimeEvent, { kind: "tool-start" | "tool-result" }>): string;

  /** Render a progress/runtime event label to channel-safe text. */
  renderProgressLabel(event: RuntimeEvent): string;

  /** Render an assistant response to channel-safe text. */
  renderAssistantResponse(
    label: string,
    text: string,
    options?: { matchedSkills?: readonly string[]; progress?: readonly string[] }
  ): string;
}
