// v0.95 EmailSurfaceAdapter
// Lightweight stub: plain text only, no emoji, no ANSI, no HTML, no markdown.

import type { SurfaceAdapter, SurfaceCapabilities } from "../../contracts/surface-adapter.js";
import type { ViewModel } from "../../contracts/view-model.js";
import type { RuntimeEvent } from "../../contracts/runtime-event.js";
import { renderPlain } from "../../ui/renderers/plain-renderer.js";
import { ChannelToolActivityRenderer } from "./channel-tool-activity.js";
import { renderPlainProgressLabel } from "./channel-progress-label.js";
import { renderChannelAssistantResponse } from "./channel-assistant-response.js";

const CAPABILITIES: SurfaceCapabilities = {
  supportsEmoji: false,
  supportsAnsi: false,
  supportsHtml: false,
  supportsMarkdown: false,
};

export class EmailSurfaceAdapter implements SurfaceAdapter {
  readonly kind = "email" as const;
  readonly capabilities = CAPABILITIES;

  readonly #toolRenderer: ChannelToolActivityRenderer;

  constructor(options?: {
    tools?: readonly { name: string; progressLabel?: string }[];
    now?: () => number;
  }) {
    const tools =
      options?.tools?.map((t) => ({
        name: t.name,
        description: "",
        inputSchema: {},
        riskClass: "read-only-local" as const,
        toolsets: ["core"],
        progressLabel: t.progressLabel ?? "",
        maxResultSizeChars: 0,
      })) ?? [];
    this.#toolRenderer = new ChannelToolActivityRenderer({ tools, now: options?.now });
  }

  render(viewModel: ViewModel): string {
    return renderPlain(viewModel);
  }

  renderToolActivity(
    event: Extract<RuntimeEvent, { kind: "tool-start" | "tool-result" }>
  ): string {
    return this.#toolRenderer.render(event);
  }

  renderProgressLabel(event: RuntimeEvent): string {
    return renderPlainProgressLabel(event);
  }

  renderAssistantResponse(
    label: string,
    text: string,
    options?: { matchedSkills?: readonly string[]; progress?: readonly string[] }
  ): string {
    return renderChannelAssistantResponse(label, text, options);
  }
}
