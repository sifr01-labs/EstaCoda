// v0.95 TelegramSurfaceAdapter
// Lightweight stub: supports emoji and HTML. Delegates ViewModel rendering to plain
// (Telegram backend handles markdown-to-HTML conversion via telegram-format.ts).

import type { SurfaceAdapter, SurfaceCapabilities } from "../../contracts/surface-adapter.js";
import type { ViewModel } from "../../contracts/view-model.js";
import type { RuntimeEvent } from "../../contracts/runtime-event.js";
import { renderPlain } from "../../ui/renderers/plain-renderer.js";
import { ToolActivityRenderer } from "../../cli/tool-activity-renderer.js";
import { renderChannelProgressLabel } from "../activity-labels.js";
import { renderChannelAssistantResponse } from "./channel-assistant-response.js";

const CAPABILITIES: SurfaceCapabilities = {
  supportsEmoji: true,
  supportsAnsi: false,
  supportsHtml: true,
  supportsMarkdown: false,
};

export class TelegramSurfaceAdapter implements SurfaceAdapter {
  readonly kind = "telegram" as const;
  readonly capabilities = CAPABILITIES;

  readonly #toolRenderer: ToolActivityRenderer;

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
    this.#toolRenderer = new ToolActivityRenderer({ tools, now: options?.now });
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
    return renderChannelProgressLabel(event);
  }

  renderAssistantResponse(
    label: string,
    text: string,
    options?: { matchedSkills?: readonly string[]; progress?: readonly string[] }
  ): string {
    return renderChannelAssistantResponse(label, text, options);
  }
}
