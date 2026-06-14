import type { ArtifactRecord } from "./artifact.js";
import type { RuntimeEvent } from "./runtime-event.js";

export type ChannelKind =
  | "cli"
  | "telegram"
  | "whatsapp"
  | "wechat"
  | "signal"
  | "discord"
  | "slack"
  | "web"
  | "webhook"
  | "open-webui"
  | "email"
  | (string & {});

export type ChannelAttachmentKind =
  | "file"
  | "image"
  | "audio"
  | "video"
  | "voice"
  | "document"
  | "link"
  | "unknown";

export type ChannelAttachmentStatus =
  | "ready"
  | "failed"
  | "unsupported"
  | "too-large"
  | "download-failed"
  | "missing-file";

export type ChannelAttachment = {
  id: string;
  kind: ChannelAttachmentKind;
  status?: ChannelAttachmentStatus;
  failureCode?: string;
  failureMessage?: string;
  mimeType?: string;
  originalName?: string;
  name?: string;
  localPath?: string;
  path?: string;
  remoteUrl?: string;
  url?: string;
  bytes?: number;
  metadata?: Record<string, unknown>;
};

export type ChannelSessionKey = {
  platform: ChannelKind;
  chatId: string;
  accountId?: string;
  chatType?: "dm" | "group" | "channel" | "thread";
  threadId?: string;
  userId?: string;
};

export type ChannelTextAction = {
  label: string;
  value: string;
};

export type ChannelTextOptions = {
  format?: "plain" | "html";
  actions?: ChannelTextAction[][];
  replyTo?: string | null;
  editMessageId?: string | null;
};

export type ChannelSender = {
  id: string;
  displayName?: string;
  username?: string;
};

export type ChannelEvent = {
  id: string;
  channel: ChannelKind;
  conversationId: string;
  senderId: string;
  text?: string;
  attachments: ChannelAttachment[];
  receivedAt: string;
  metadata?: Record<string, unknown>;
};

export type ChannelMessage = {
  id: string;
  channel: ChannelKind;
  sessionKey: ChannelSessionKey;
  text: string;
  sender: ChannelSender;
  attachments?: ChannelAttachment[];
  receivedAt: string;
  metadata?: Record<string, unknown>;
};

export type ChannelReply = {
  conversationId: string;
  sessionKey?: ChannelSessionKey;
  text?: string;
  attachments?: ChannelAttachment[];
  artifacts?: ArtifactRecord[];
  metadata?: Record<string, unknown>;
};

export type ChannelStreamingTextResult = {
  delivered: boolean;
  fallbackRequired: boolean;
  deliveredText?: string;
};

export type ChannelStreamingTextHandle = {
  append(text: string): void;
  segmentBreak(reason?: string): void;
  providerAttemptResult(result: {
    ok: boolean;
    willFallback: boolean;
    provider: string;
    model: string;
  }): void;
  finish(finalText: string): Promise<ChannelStreamingTextResult>;
  abort(reason?: string): Promise<void>;
};

export type ChannelStreamingTextOptions = {
  signal?: AbortSignal;
  editIntervalMs?: number;
  minInitialChars?: number;
  cursor?: string;
  maxFloodStrikes?: number;
  cleanupFailedAttempts?: boolean;
};

export type ChannelDelivery = {
  sendText(sessionKey: ChannelSessionKey, text: string, options?: ChannelTextOptions): Promise<void>;
  sendProgress?(sessionKey: ChannelSessionKey, event: RuntimeEvent): Promise<void>;
  sendArtifact?(sessionKey: ChannelSessionKey, artifact: ArtifactRecord): Promise<void>;
  startStreamingText?(sessionKey: ChannelSessionKey, options?: ChannelStreamingTextOptions): ChannelStreamingTextHandle;
};

export type ChannelVoiceCommandResult = {
  ok: boolean;
  content: string;
  reason?: string;
  metadata?: Record<string, unknown>;
};

export type InboundMode = "polling" | "websocket" | "webhook" | "none";

/**
 * Static outbound delivery capability.
 * "push" = adapter can actively send outbound messages/replies through platform API
 * "pull" = outbound delivery is fetched/polled by external consumer
 * "none" = outbound delivery unsupported
 */
export type OutboundMode = "push" | "pull" | "none";

export type ImplementationStatus = "live_proven" | "present_not_live_proven" | "stub" | "unsupported";

export type AdapterCapability = {
  /** Static kind — never changes at runtime */
  kind: ChannelKind;
  /** Whether the user has enabled this channel in config */
  enabled: boolean;
  /** Whether required credentials are present */
  configured: boolean;
  /** Missing config keys, if any */
  missingConfig?: string[];
  /** How inbound messages arrive */
  inboundMode: InboundMode;
  /** How outbound messages are sent — see OutboundMode comment for semantics */
  outboundMode: OutboundMode;
  /** Can receive and send files/images/audio/video */
  supportsAttachments: boolean;
  /** Supports thread/topic/reply-chain semantics with explicit threadId preservation */
  supportsThreads: boolean;
  /** Supports interactive inline approve/reject */
  supportsApprovals: boolean;
  /** Can stream progress updates mid-turn */
  supportsProgressStreaming: boolean;
  /** Gated behind an experimental flag */
  experimental: boolean;
  /** Maturity level */
  implementationStatus: ImplementationStatus;
};

export type ChannelAdapter = {
  id?: string;
  kind: ChannelKind;
  delivery?: ChannelDelivery;
  pair?(): Promise<void>;
  start?(handler: (message: ChannelMessage) => Promise<void>): Promise<void>;
  stop?(): Promise<void>;
  receive?(event: unknown): Promise<ChannelEvent | ChannelMessage>;
  send?(reply: ChannelReply): Promise<void>;
  /** Static capability metadata. Optional so mock adapters need not implement. */
  getCapabilities?(): AdapterCapability;
  /** Optional Discord voice-channel capability. Command parsing stays in ChannelGateway. */
  joinVoiceChannelForMessage?(message: ChannelMessage): Promise<ChannelVoiceCommandResult>;
  leaveVoiceChannelForMessage?(message: ChannelMessage): Promise<ChannelVoiceCommandResult>;
  /** Poll for inbound messages. Present on polling adapters (Telegram, Email). */
  pollOnce?(): Promise<number>;
};

export type TelegramAuthPolicy = {
  allowedUserIds?: string[];
  allowedChatIds?: string[];
  deniedMessage?: string;
};

export type DiscordAuthPolicy = {
  allowedUserIds?: string[];
  allowedGuildIds?: string[];
  deniedMessage?: string;
};

export type EmailAuthPolicy = {
  allowedSenders?: string[];
  deniedMessage?: string;
};

export type WhatsAppAuthPolicy = {
  allowedNumbers?: string[];
  allowedGroups?: string[];
  dmPolicy?: "disabled" | "allowlist" | "pairing" | "open";
  groupPolicy?: "disabled" | "allowlist" | "open";
  requireMention?: boolean;
  mentionPatterns?: string[];
  freeResponseChats?: string[];
  deniedMessage?: string;
};

export type ChannelAuthPolicies = {
  telegram?: TelegramAuthPolicy;
  discord?: DiscordAuthPolicy;
  email?: EmailAuthPolicy;
  whatsapp?: WhatsAppAuthPolicy;
};

export type ChannelGatewayResult = {
  sessionId: string;
  replyText: string;
  artifactCount: number;
  progressCount: number;
};
