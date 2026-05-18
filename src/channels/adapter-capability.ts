import type { ChannelKind, AdapterCapability } from "../contracts/channel.js";
import type {
  TelegramChannelConfig,
  DiscordChannelConfig,
  EmailChannelConfig,
  WhatsAppChannelConfig,
} from "../config/runtime-config.js";

export type CapabilityInput =
  | { kind: "telegram"; config: TelegramChannelConfig; missing?: string[] }
  | { kind: "discord"; config: DiscordChannelConfig; missing?: string[] }
  | { kind: "email"; config: EmailChannelConfig; missing?: string[] }
  | { kind: "whatsapp"; config: WhatsAppChannelConfig; missing?: string[] };

/**
 * Base capability definitions per kind.
 * These are the ONLY hard-coded capability values for first-party adapters.
 * Adapter classes and the registry both consume this table.
 */
export const BASE_CAPABILITIES: Record<
  "telegram" | "discord" | "email" | "whatsapp",
  Omit<AdapterCapability, "kind" | "enabled" | "configured" | "missingConfig">
> = {
  telegram: {
    inboundMode: "polling",
    outboundMode: "push",
    supportsAttachments: true,
    supportsThreads: true,
    supportsApprovals: true,
    supportsProgressStreaming: true,
    experimental: false,
    implementationStatus: "live_proven",
  },
  discord: {
    inboundMode: "websocket",
    outboundMode: "push",
    supportsAttachments: false,
    supportsThreads: false,
    supportsApprovals: true,
    supportsProgressStreaming: false,
    experimental: false,
    implementationStatus: "present_not_live_proven",
  },
  email: {
    inboundMode: "polling",
    outboundMode: "push",
    supportsAttachments: false,
    supportsThreads: true,
    supportsApprovals: false,
    supportsProgressStreaming: false,
    experimental: false,
    implementationStatus: "present_not_live_proven",
  },
  whatsapp: {
    inboundMode: "websocket",
    outboundMode: "push",
    supportsAttachments: false,
    supportsThreads: false,
    supportsApprovals: false,
    supportsProgressStreaming: false,
    experimental: true,
    implementationStatus: "present_not_live_proven",
  },
};

/**
 * Build a complete AdapterCapability from kind + config.
 * `enabled`, `configured`, and `missingConfig` are derived from config.
 * All other fields come from BASE_CAPABILITIES.
 */
export function buildAdapterCapability(input: CapabilityInput): AdapterCapability {
  const base = BASE_CAPABILITIES[input.kind];
  const enabled = input.config.enabled ?? false;
  const missingConfig = input.missing !== undefined && input.missing.length > 0 ? input.missing : undefined;
  let configured = enabled && missingConfig === undefined;
  if (base.experimental && input.kind === "whatsapp" && !input.config.experimental) {
    configured = false;
  }

  return {
    kind: input.kind as ChannelKind,
    enabled,
    configured,
    missingConfig,
    inboundMode: base.inboundMode,
    outboundMode: base.outboundMode,
    supportsAttachments: base.supportsAttachments,
    supportsThreads: base.supportsThreads,
    supportsApprovals: base.supportsApprovals,
    supportsProgressStreaming: base.supportsProgressStreaming,
    experimental: base.experimental,
    implementationStatus: base.implementationStatus,
  };
}
