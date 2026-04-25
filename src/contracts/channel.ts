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

export type ChannelDelivery = {
  sendText(sessionKey: ChannelSessionKey, text: string, options?: ChannelTextOptions): Promise<void>;
  sendProgress?(sessionKey: ChannelSessionKey, event: RuntimeEvent): Promise<void>;
  sendArtifact?(sessionKey: ChannelSessionKey, artifact: ArtifactRecord): Promise<void>;
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
};

export type ChannelAuthPolicy =
  | {
      mode: "allow-all";
    }
  | {
      mode: "allowlist";
      allowedUserIds?: string[];
      allowedChatIds?: string[];
      deniedMessage?: string;
    };

export type ChannelGatewayResult = {
  sessionId: string;
  replyText: string;
  artifactCount: number;
  progressCount: number;
};
