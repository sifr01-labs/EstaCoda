import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { ArtifactRecord } from "../contracts/artifact.js";
import type {
  AdapterCapability,
  ChannelAdapter,
  ChannelAttachment,
  ChannelDelivery,
  ChannelMessage,
  ChannelSessionKey,
  ChannelTextOptions,
} from "../contracts/channel.js";
import type { RuntimeEvent } from "../contracts/runtime-event.js";
import type { WhatsAppChannelConfig } from "../config/runtime-config.js";
import { buildAdapterCapability } from "./adapter-capability.js";
import {
  type WhatsAppBridgeClient,
  type WhatsAppBridgeInboundMessage,
} from "./whatsapp-bridge-client.js";
import { ManagedWhatsAppBridgeClient } from "./whatsapp-bridge-lifecycle.js";
import { WhatsAppBridgeRuntimeError } from "./whatsapp-bridge-errors.js";
import {
  WHATSAPP_DEFAULT_REPLY_PREFIX,
  normalizeWhatsAppChatId,
  normalizeWhatsAppUserId,
  rememberWhatsAppAlias,
  resolveWhatsAppAlias,
  whatsappChatIdToJid,
} from "./whatsapp-identity.js";

const MAX_RECENT_SENT_IDS = 50;
const WHATSAPP_MAX_TEXT_UTF16 = 4096;
const WHATSAPP_CHUNK_DELAY_MS = 300;
const WHATSAPP_SEND_TIMEOUT_MS = 60_000;
const WHATSAPP_MAX_MEDIA_BYTES = 25 * 1024 * 1024;
const WHATSAPP_DOCUMENT_TEXT_PREVIEW_CHARS = 4000;

export type WhatsAppAdapterOptions = {
  /** Directory for WhatsApp bridge/Baileys auth state persistence */
  authDir?: string;
  /** Allowed user phone numbers or JIDs. Gateway auth owns enforcement; this is capability/config metadata only. */
  allowedUsers?: string[];
  /** Profile-local LID/phone alias map. */
  aliasStorePath?: string;
  /** Bot ignores fromMe. Self-chat treats intentional fromMe input as inbound. */
  mode?: WhatsAppChannelConfig["mode"];
  /** Prefix applied to self-chat replies and ignored when echoed back. */
  replyPrefix?: string;
  /** Max characters per message chunk. The bridge owns final chunking in the quarantined transport. */
  maxTextLength?: number;
  /** Directory to save downloaded media */
  mediaRoot?: string;
  /** Profile-local directory where the bridge stores inbound WhatsApp media. */
  inboundMediaRoot?: string;
  /** Profile-local temp root for converted WhatsApp voice notes. */
  voiceTempRoot?: string;
  /** Additional roots from which outbound media may be sent. */
  allowedMediaRoots?: string[];
  /** ffmpeg binary used by the main runtime for WhatsApp voice bubble conversion. */
  ffmpegPath?: string;
  /** Max bytes for outbound media uploads. */
  maxMediaBytes?: number;
  /** Internal delay between long message chunks. */
  chunkDelayMs?: number;
  /** Bridge operation timeout for text/media/presence requests. */
  sendTimeoutMs?: number;
  /** Fetch implementation for explicitly allowed remote media URL caching. */
  fetch?: typeof fetch;
  /** Allow HTTP(S) artifact URLs to be cached locally before sending. */
  allowRemoteMediaUrls?: boolean;
  /** Enable experimental live WhatsApp adapter */
  experimental?: boolean;
  /** Bridge state file written by the lifecycle manager in later commits */
  bridgeStatePath?: string;
  /** Profile-local bridge stdout/stderr log */
  bridgeLogPath?: string;
  /** Profile-local bridge dependency install log */
  bridgeInstallLogPath?: string;
  /** Profile-local bridge pid file */
  bridgePidPath?: string;
  /** Profile-local bridge session lock file */
  bridgeLockPath?: string;
  /** Standalone bridge package directory */
  bridgeDir?: string;
  /** Inject a fake or custom bridge client for tests */
  bridgeClient?: WhatsAppBridgeClient;
  now?: () => Date;
  missing?: string[];
};

type ConnectionStatus =
  | "connecting"
  | "open"
  | "close"
  | "error";

/**
 * WhatsApp adapter backed by the quarantined Node.js bridge.
 *
 * This root-runtime adapter intentionally imports no Baileys or Boom symbols.
 * Baileys socket lifecycle and disconnect details live under scripts/whatsapp-bridge/.
 */
export class WhatsAppAdapter implements ChannelAdapter {
  kind = "whatsapp" as const;
  running = false;
  connectionStatus: ConnectionStatus = "close";
  lastError?: string;

  private handler?: (message: ChannelMessage) => Promise<void>;
  private options: WhatsAppAdapterOptions;
  private missing: string[] | undefined;
  private seenMessageIds = new Set<string>();
  private recentSentIds: string[] = [];
  private recentSentIdSet = new Set<string>();
  private bridgeClient: WhatsAppBridgeClient;

  constructor(options: WhatsAppAdapterOptions = {}) {
    this.options = options;
    this.missing = options.missing;
    const authDir = options.authDir ?? process.cwd();
    this.bridgeClient = options.bridgeClient ?? new ManagedWhatsAppBridgeClient({
      authDir,
      statePath: options.bridgeStatePath ?? join(authDir, "bridge-state.json"),
      logPath: options.bridgeLogPath,
      installLogPath: options.bridgeInstallLogPath,
      pidPath: options.bridgePidPath,
      lockPath: options.bridgeLockPath,
      bridgeDir: options.bridgeDir,
      inboundMediaDir: this.rawInboundMediaRoot(),
      inboundMediaParentDir: options.mediaRoot,
    });
  }

  getCapabilities(): AdapterCapability {
    const config: WhatsAppChannelConfig = {
      enabled: true,
      authDir: this.options.authDir,
      allowedUsers: this.options.allowedUsers,
      experimental: this.options.experimental,
      mode: this.options.mode,
      replyPrefix: this.options.replyPrefix,
      busyPolicy: undefined,
      queueDepth: undefined,
    };
    return buildAdapterCapability({ kind: "whatsapp", config, missing: this.missing });
  }

  async start(handler: (message: ChannelMessage) => Promise<void>): Promise<void> {
    if (this.options.experimental !== true) {
      throw new Error("WhatsApp live adapter is experimental. Set experimental: true in config to enable.");
    }
    if (this.running) return;
    this.handler = handler;
    this.running = true;
    this.connectionStatus = "connecting";
    await this.bridgeClient.start?.();
    const health = await this.bridgeClient.getHealth().catch((error) => {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.connectionStatus = "error";
      throw error;
    });
    if (health.status === "logged_out") {
      throw new WhatsAppBridgeRuntimeError({
        code: "whatsapp_logged_out",
        message: health.error?.message ?? "WhatsApp bridge is logged out.",
        details: health.error?.details,
      });
    }
    if (health.error !== undefined) {
      throw new WhatsAppBridgeRuntimeError(health.error);
    }
    this.connectionStatus = health.status === "connected" ? "open" : "connecting";
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.connectionStatus = "close";
    await this.bridgeClient.stop?.();
  }

  async pollOnce(): Promise<number> {
    if (!this.running || this.handler === undefined) return 0;
    const messages = await this.bridgeClient.pollMessages();
    const batches = new Map<string, ChannelMessage[]>();
    let processed = 0;
    for (const message of messages) {
      if (this.seenMessageIds.has(message.messageId)) continue;
      this.seenMessageIds.add(message.messageId);
      if (this.shouldIgnoreInbound(message)) continue;
      const channelMessage = await bridgeMessageToChannelMessage(message, {
        now: this.options.now,
        aliasStorePath: this.options.aliasStorePath,
        inboundMediaRoot: await this.validatedInboundMediaRoot(),
      });
      if (channelMessage === undefined) continue;
      const batchKey = `${channelMessage.sessionKey.chatId}\0${channelMessage.sender.id}`;
      const batch = batches.get(batchKey) ?? [];
      batch.push(channelMessage);
      batches.set(batchKey, batch);
      processed += 1;
    }
    for (const batch of batches.values()) {
      await this.handler(batchWhatsAppMessages(batch));
    }
    return processed;
  }

  get delivery(): ChannelDelivery {
    return {
      sendText: async (sessionKey: ChannelSessionKey, text: string, _options?: ChannelTextOptions) => {
        const chatId = whatsappChatIdToJid(sessionKey.chatId, { isGroup: sessionKey.chatType === "group" });
        const message = formatWhatsAppText(this.decorateOutboundText(text));
        const chunks = chunkWhatsAppText(message, this.options.maxTextLength ?? WHATSAPP_MAX_TEXT_UTF16);

        if (chunks.length === 1 && _options?.editMessageId !== undefined && _options.editMessageId !== null) {
          const edited = await this.tryEditText(chatId, _options.editMessageId, chunks[0] ?? "");
          if (edited) return;
        }

        for (const [index, chunk] of chunks.entries()) {
          const result = await this.withBridgeTimeout(
            () => this.bridgeClient.sendText({
              chatId,
              message: chunk,
              replyTo: index === 0 ? _options?.replyTo ?? undefined : undefined,
            }),
            "WhatsApp bridge text send timed out"
          );
          if (!result.ok) {
            throw new Error(result.error?.message ?? "WhatsApp bridge text send failed");
          }
          this.rememberSentIds(result.messageIds ?? (result.messageId === undefined ? [] : [result.messageId]));
          if (index < chunks.length - 1) {
            await sleep(this.options.chunkDelayMs ?? WHATSAPP_CHUNK_DELAY_MS);
          }
        }
      },
      sendProgress: async (sessionKey: ChannelSessionKey, event: RuntimeEvent) => {
        // WhatsApp is final-only. Progress events must not create visible WhatsApp messages.
        if (event.kind !== "agent-start" && event.kind !== "provider-attempt" && event.kind !== "tool-start") {
          if (event.kind === "agent-final" || event.kind === "agent-cancelled") {
            await this.sendTyping(sessionKey, "paused");
          }
          return;
        }
        await this.sendTyping(sessionKey, "composing");
      },
      sendArtifact: async (sessionKey: ChannelSessionKey, artifact: ArtifactRecord) => {
        const caption = renderArtifactNotice(artifact);
        if (artifact.path.length === 0) {
          const result = await this.withBridgeTimeout(() => this.bridgeClient.sendText({
            chatId: whatsappChatIdToJid(sessionKey.chatId, { isGroup: sessionKey.chatType === "group" }),
            message: caption,
          }), "WhatsApp bridge artifact notice timed out");
          if (!result.ok) {
            throw new Error(result.error?.message ?? "WhatsApp bridge artifact notice failed");
          }
          this.rememberSentIds(result.messageIds ?? (result.messageId === undefined ? [] : [result.messageId]));
          return {
            status: "degraded" as const,
            method: "fallback-notice" as const,
            reasonCode: "artifact-path-unavailable"
          };
        }

        const prepared = await this.prepareOutboundMedia(artifact);
        try {
          const result = await this.withBridgeTimeout(() => this.bridgeClient.sendMedia({
            chatId: whatsappChatIdToJid(sessionKey.chatId, { isGroup: sessionKey.chatType === "group" }),
            filePath: prepared.path,
            mediaType: prepared.mediaType,
            caption: prepared.caption ?? caption,
            fileName: basename(prepared.path),
          }), "WhatsApp bridge media send timed out");
          if (!result.ok) {
            throw new Error(result.error?.message ?? "WhatsApp bridge media send failed");
          }
          this.rememberSentIds(result.messageIds ?? (result.messageId === undefined ? [] : [result.messageId]));
          return { status: "delivered" as const, method: "native-upload" as const };
        } finally {
          if (prepared.cleanupPath !== undefined) {
            await rm(prepared.cleanupPath, { recursive: true, force: true }).catch(() => undefined);
          }
        }
      },
    };
  }

  private async tryEditText(chatId: string, messageId: string, message: string): Promise<boolean> {
    try {
      const result = await this.withBridgeTimeout(
        () => this.bridgeClient.editMessage({ chatId, messageId, message }),
        "WhatsApp bridge edit timed out"
      );
      if (!result.ok) return false;
      this.rememberSentIds(result.messageIds ?? (result.messageId === undefined ? [] : [result.messageId]));
      return true;
    } catch {
      return false;
    }
  }

  private async sendTyping(sessionKey: ChannelSessionKey, state: "composing" | "paused"): Promise<void> {
    try {
      await this.withBridgeTimeout(() => this.bridgeClient.sendTyping({
        chatId: whatsappChatIdToJid(sessionKey.chatId, { isGroup: sessionKey.chatType === "group" }),
        state,
      }), "WhatsApp bridge typing timed out");
    } catch {
      // Presence is best-effort and must never become visible WhatsApp progress spam.
    }
  }

  private async prepareOutboundMedia(artifact: ArtifactRecord): Promise<{
    path: string;
    mediaType: "image" | "video" | "audio" | "voice" | "document";
    caption?: string;
    cleanupPath?: string;
  }> {
    const mediaType = mediaTypeForArtifact(artifact);
    const localPath = await this.resolveOutboundMediaPath(artifact);
    if (mediaType !== "audio") {
      return { path: localPath, mediaType };
    }

    const prepared = await this.prepareAudioMedia(localPath, artifact);
    return prepared;
  }

  private async prepareAudioMedia(localPath: string, artifact: ArtifactRecord): Promise<{
    path: string;
    mediaType: "audio" | "voice";
    caption?: string;
    cleanupPath?: string;
  }> {
    if (isWhatsAppVoiceBubbleArtifact(localPath, artifact)) {
      return { path: localPath, mediaType: "voice" };
    }
    if (artifact.metadata?.deliveryHint !== "voice") {
      return { path: localPath, mediaType: "audio" };
    }
    const converted = await this.convertToWhatsAppVoice(localPath, artifact);
    if (converted !== undefined) {
      return converted;
    }
    return {
      path: localPath,
      mediaType: "audio",
      caption: `${renderArtifactNotice(artifact)}\n\nVoice bubble unavailable; sending as audio.`,
    };
  }

  private async convertToWhatsAppVoice(localPath: string, artifact: ArtifactRecord): Promise<{
    path: string;
    mediaType: "voice";
    cleanupPath: string;
  } | undefined> {
    const root = this.options.voiceTempRoot ?? (this.options.mediaRoot === undefined ? undefined : join(this.options.mediaRoot, "whatsapp-voice-temp"));
    if (root === undefined) return undefined;
    const safeRoot = await ensureDirectoryUnderAllowedRoot(root, this.allowedVoiceConversionRoots());
    if (safeRoot === undefined) return undefined;
    const tempDir = await mkdtemp(join(safeRoot, "opus-")).catch(() => undefined);
    if (tempDir === undefined) return undefined;
    const outputPath = join(tempDir, `${sanitizePathPart(artifact.id)}.ogg`);
    const result = await runCommand(this.options.ffmpegPath ?? "ffmpeg", [
      "-y",
      "-i",
      localPath,
      "-c:a",
      "libopus",
      "-b:a",
      "24k",
      outputPath,
    ]);
    if (!result.ok) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      return undefined;
    }
    const outputStat = await stat(outputPath).catch(() => undefined);
    if (outputStat === undefined || outputStat.size === 0) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      return undefined;
    }
    return { path: outputPath, mediaType: "voice", cleanupPath: tempDir };
  }

  private async resolveOutboundMediaPath(artifact: ArtifactRecord): Promise<string> {
    const source = artifact.localPath ?? artifact.path;
    const maxBytes = this.options.maxMediaBytes ?? WHATSAPP_MAX_MEDIA_BYTES;
    const cached = isHttpUrl(source)
      ? await this.cacheRemoteMedia(artifact, source)
      : source;
    const allowedRoots = this.allowedMediaRoots();
    const resolved = await resolveAllowedMediaPath(cached, allowedRoots);
    const fileStat = await stat(resolved);
    if (fileStat.size > maxBytes) {
      throw new Error(`WhatsApp media is too large (${fileStat.size} bytes; max ${maxBytes}).`);
    }
    return resolved;
  }

  private async cacheRemoteMedia(artifact: ArtifactRecord, url: string): Promise<string> {
    if (this.options.allowRemoteMediaUrls !== true || this.options.mediaRoot === undefined) {
      throw new Error("WhatsApp remote media URLs must be cached by the main runtime before bridge delivery.");
    }
    const response = await (this.options.fetch ?? fetch)(url);
    if (!response.ok) {
      throw new Error(`WhatsApp remote media download failed: ${response.status} ${response.statusText}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const maxBytes = this.options.maxMediaBytes ?? WHATSAPP_MAX_MEDIA_BYTES;
    if (bytes.length > maxBytes) {
      throw new Error(`WhatsApp remote media is too large (${bytes.length} bytes; max ${maxBytes}).`);
    }
    const root = join(this.options.mediaRoot, "whatsapp-remote-cache");
    await mkdir(root, { recursive: true });
    const extension = extname(new URL(url).pathname) || extensionForArtifact(artifact);
    const filePath = join(root, `${sanitizePathPart(artifact.id)}${extension}`);
    await writeFile(filePath, bytes);
    return filePath;
  }

  private allowedMediaRoots(): string[] {
    return [
      this.options.mediaRoot,
      ...(this.options.allowedMediaRoots ?? []),
    ].filter((root): root is string => root !== undefined && root.length > 0);
  }

  private allowedVoiceConversionRoots(): string[] {
    return this.allowedMediaRoots();
  }

  private rawInboundMediaRoot(): string | undefined {
    if (this.options.inboundMediaRoot !== undefined) return this.options.inboundMediaRoot;
    if (this.options.mediaRoot === undefined) return undefined;
    return join(this.options.mediaRoot, "whatsapp", "inbound");
  }

  private async validatedInboundMediaRoot(): Promise<string | undefined> {
    const root = this.rawInboundMediaRoot();
    if (root === undefined || this.options.mediaRoot === undefined) return undefined;
    return ensureDirectoryUnderAllowedRoot(root, [this.options.mediaRoot]);
  }

  private async withBridgeTimeout<T>(operation: () => Promise<T>, message: string): Promise<T> {
    const timeoutMs = this.options.sendTimeoutMs ?? WHATSAPP_SEND_TIMEOUT_MS;
    return new Promise<T>((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      operation()
        .then((value) => {
          clearTimeout(timer);
          resolvePromise(value);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  private shouldIgnoreInbound(message: WhatsAppBridgeInboundMessage): boolean {
    if (message.fromMe !== true) return false;
    if (this.recentSentIdSet.has(message.messageId)) return true;
    const mode = this.options.mode ?? "bot";
    if (mode !== "self-chat") return true;
    const prefix = this.selfChatReplyPrefix();
    return prefix.length > 0 && (message.body ?? "").startsWith(prefix);
  }

  private decorateOutboundText(text: string): string {
    if ((this.options.mode ?? "bot") !== "self-chat") return text;
    return `${this.selfChatReplyPrefix()}${text}`;
  }

  private selfChatReplyPrefix(): string {
    return this.options.replyPrefix ?? WHATSAPP_DEFAULT_REPLY_PREFIX;
  }

  private rememberSentIds(ids: string[]): void {
    for (const id of ids) {
      if (id.length === 0 || this.recentSentIdSet.has(id)) continue;
      this.recentSentIds.push(id);
      this.recentSentIdSet.add(id);
      while (this.recentSentIds.length > MAX_RECENT_SENT_IDS) {
        const evicted = this.recentSentIds.shift();
        if (evicted !== undefined) this.recentSentIdSet.delete(evicted);
      }
    }
  }
}

async function bridgeMessageToChannelMessage(
  message: WhatsAppBridgeInboundMessage,
  options: {
    now: (() => Date) | undefined;
    aliasStorePath: string | undefined;
    inboundMediaRoot: string | undefined;
  }
): Promise<ChannelMessage | undefined> {
  await rememberAliasFromInbound(options.aliasStorePath, message);
  const senderId = await resolveWhatsAppAlias(options.aliasStorePath, message.senderId);
  const chatId = message.isGroup === true
    ? normalizeWhatsAppChatId(message.chatId, { isGroup: true })
    : await resolveWhatsAppAlias(options.aliasStorePath, message.chatId);
  if (senderId.length === 0 || chatId.length === 0) return undefined;
  const attachments = await normalizeInboundAttachments(message, options.inboundMediaRoot);

  return {
    id: message.messageId,
    channel: "whatsapp",
    sessionKey: {
      platform: "whatsapp",
      chatId,
      chatType: message.isGroup ? "group" : "dm",
      userId: senderId,
    },
    text: message.body ?? "",
    sender: {
      id: senderId,
      displayName: message.senderName ?? senderId,
    },
    attachments: attachments.length > 0 ? attachments : undefined,
    receivedAt: options.now?.().toISOString() ?? new Date().toISOString(),
    metadata: {
      timestamp: message.timestamp,
      rawChatId: message.chatId,
      rawSenderId: message.senderId,
      fromMe: message.fromMe,
      chatName: message.chatName,
      mentionedIds: message.mentionedIds,
      quotedMessageId: message.quotedMessageId,
      quotedParticipant: message.quotedParticipant,
      quotedRemoteJid: message.quotedRemoteJid,
      hasQuotedMessage: message.hasQuotedMessage,
      botIds: message.botIds,
      ...(message.metadata ?? {}),
    },
  };
}

async function normalizeInboundAttachments(
  message: WhatsAppBridgeInboundMessage,
  inboundMediaRoot: string | undefined
): Promise<ChannelAttachment[]> {
  const normalized: ChannelAttachment[] = [];
  for (const [index, attachment] of (message.attachments ?? []).entries()) {
    const status = attachment.status ?? "ready";
    const id = attachment.id ?? `${message.messageId}:attachment:${index}`;
    if (status === "ready") {
      if (attachment.localPath === undefined || inboundMediaRoot === undefined) continue;
      const localPath = await resolveAllowedMediaPath(attachment.localPath, [inboundMediaRoot]).catch(() => undefined);
      if (localPath === undefined) continue;
      normalized.push({
        id,
        kind: attachment.kind,
        status,
        failureCode: attachment.failureCode,
        failureMessage: attachment.failureMessage,
        mimeType: attachment.mimeType,
        originalName: attachment.originalName,
        localPath,
        bytes: attachment.bytes,
        metadata: normalizeInboundAttachmentMetadata(attachment),
      });
      continue;
    }
    normalized.push({
      id,
      kind: attachment.kind,
      status,
      failureCode: attachment.failureCode,
      failureMessage: attachment.failureMessage,
      mimeType: attachment.mimeType,
      originalName: attachment.originalName,
      bytes: attachment.bytes,
      metadata: normalizeInboundAttachmentMetadata(attachment),
    });
  }
  return normalized;
}

function batchWhatsAppMessages(messages: ChannelMessage[]): ChannelMessage {
  if (messages.length <= 1) return messages[0]!;
  const first = messages[0]!;
  return {
    ...first,
    id: first.id,
    text: messages.map((message) => message.text).filter((text) => text.length > 0).join("\n\n"),
    attachments: messages.flatMap((message) => message.attachments ?? []),
    metadata: {
      ...(first.metadata ?? {}),
      batchedMessageIds: messages.map((message) => message.id),
      batchSize: messages.length,
    },
  };
}

function normalizeInboundAttachmentMetadata(
  attachment: import("./whatsapp-bridge-client.js").WhatsAppBridgeInboundAttachment
): Record<string, unknown> | undefined {
  const metadata = attachment.metadata ?? {};
  if (attachment.kind !== "document" || attachment.status !== "ready") {
    return Object.keys(metadata).length === 0 ? undefined : metadata;
  }
  const text = firstString(metadata.textPreview, metadata.text, metadata.extractedText);
  if (text === undefined || !isTextLikeDocument(attachment)) {
    return Object.keys(metadata).length === 0 ? undefined : metadata;
  }
  return {
    ...metadata,
    textPreview: text.slice(0, WHATSAPP_DOCUMENT_TEXT_PREVIEW_CHARS),
    textPreviewTruncated: text.length > WHATSAPP_DOCUMENT_TEXT_PREVIEW_CHARS || undefined,
  };
}

async function rememberAliasFromInbound(
  aliasStorePath: string | undefined,
  message: WhatsAppBridgeInboundMessage
): Promise<void> {
  if (message.isGroup === true) return;
  const chat = normalizeWhatsAppUserId(message.chatId);
  const sender = normalizeWhatsAppUserId(message.senderId);
  if (chat.length > 0 && sender.length > 0) {
    await rememberWhatsAppAlias(aliasStorePath, chat, sender);
  }
}

function mediaTypeForArtifact(artifact: ArtifactRecord): "image" | "video" | "audio" | "document" {
  if (artifact.kind === "image" || artifact.mimeType?.startsWith("image/")) return "image";
  if (artifact.kind === "video" || artifact.mimeType?.startsWith("video/")) return "video";
  if (artifact.kind === "audio" || artifact.mimeType?.startsWith("audio/")) return "audio";
  return "document";
}

function renderArtifactNotice(artifact: ArtifactRecord): string {
  const parts: string[] = [];
  parts.push(`Artifact: ${artifact.id}`);
  if (artifact.path) parts.push(`Path: ${artifact.path}`);
  if (artifact.mimeType) parts.push(`Type: ${artifact.mimeType}`);
  if (artifact.kind) parts.push(`Kind: ${artifact.kind}`);
  return parts.join("\n");
}

export function formatWhatsAppText(text: string): string {
  const protectedBlocks: string[] = [];
  const protect = (value: string) => {
    const token = `\u0000WA_CODE_${protectedBlocks.length}\u0000`;
    protectedBlocks.push(value);
    return token;
  };

  let output = text
    .replace(/```[\s\S]*?```/gu, protect)
    .replace(/`[^`\n]+`/gu, protect);

  output = output
    .replace(/^(#{1,6})\s+(.+)$/gmu, (_match, _level, heading: string) => `*${heading.trim()}*`)
    .replace(/\*\*([^*\n][^\n]*?)\*\*/gu, "*$1*")
    .replace(/__([^_\n][^\n]*?)__/gu, "*$1*")
    .replace(/~~([^~\n][^\n]*?)~~/gu, "~$1~")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/gu, "$1 ($2)");

  return output.replace(/\u0000WA_CODE_(\d+)\u0000/gu, (_match, index: string) => protectedBlocks[Number(index)] ?? "");
}

export function chunkWhatsAppText(text: string, maxLength: number): string[] {
  if (maxLength <= 0 || text.length <= maxLength) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLength) {
    const splitAt = findWhatsAppChunkBoundary(remaining, maxLength);
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  chunks.push(remaining);
  return chunks.filter((chunk) => chunk.length > 0);
}

function findWhatsAppChunkBoundary(text: string, maxLength: number): number {
  const search = text.slice(0, maxLength + 1);
  for (const pattern of [/\n\n[^\n]*$/u, /\n[^\n]*$/u, /\s+\S*$/u]) {
    const match = search.match(pattern);
    if (match?.index !== undefined && match.index > Math.floor(maxLength * 0.5)) {
      return match.index;
    }
  }
  return maxLength;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function isWhatsAppVoiceBubbleArtifact(localPath: string, artifact: ArtifactRecord): boolean {
  const mime = artifact.mimeType?.toLowerCase();
  return artifact.metadata?.deliveryHint === "voice" &&
    (mime === "audio/ogg" || mime === "audio/opus" || localPath.toLowerCase().endsWith(".ogg"));
}

async function resolveAllowedMediaPath(path: string, roots: string[]): Promise<string> {
  if (roots.length === 0) {
    throw new Error("WhatsApp media delivery requires a configured profile-local media root.");
  }
  const candidate = await realpathSafe(path);
  if (candidate === undefined) {
    throw new Error("WhatsApp media file is missing.");
  }
  const allowed = await Promise.all(roots.map(realpathSafe));
  if (!allowed.some((root) => root !== undefined && isPathInside(candidate, root))) {
    throw new Error("WhatsApp media path is outside configured media roots.");
  }
  return candidate;
}

async function ensureDirectoryUnderAllowedRoot(path: string, roots: string[]): Promise<string | undefined> {
  const allowed = await Promise.all(roots.map(async (root) => {
    await mkdir(root, { recursive: true }).catch(() => undefined);
    return realpathSafe(root);
  }));
  const allowedRoots = allowed.filter((root): root is string => root !== undefined);
  if (allowedRoots.length === 0) return undefined;
  const candidatePath = resolve(path);
  const ancestor = await nearestExistingAncestor(candidatePath);
  if (ancestor === undefined) return undefined;
  const canonicalCandidatePath = join(ancestor.realpath, relative(ancestor.path, candidatePath));
  if (!allowedRoots.some((root) => isPathInside(canonicalCandidatePath, root) && isPathInside(ancestor.realpath, root))) {
    return undefined;
  }
  await mkdir(candidatePath, { recursive: true });
  const candidate = await realpathSafe(candidatePath);
  if (candidate === undefined) return undefined;
  return allowedRoots.some((root) => isPathInside(candidate, root)) ? candidate : undefined;
}

async function nearestExistingAncestor(path: string): Promise<{ path: string; realpath: string } | undefined> {
  let current = path;
  for (;;) {
    const resolved = await realpathSafe(current);
    if (resolved !== undefined) return { path: current, realpath: resolved };
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

async function realpathSafe(path: string): Promise<string | undefined> {
  try {
    return await realpath(path);
  } catch {
    return undefined;
  }
}

function isPathInside(candidate: string, root: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function extensionForArtifact(artifact: ArtifactRecord): string {
  if (artifact.kind === "image") return ".jpg";
  if (artifact.kind === "video") return ".mp4";
  if (artifact.kind === "audio") return ".mp3";
  return ".bin";
}

function sanitizePathPart(value: string): string {
  const sanitized = value.toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 64);
  return sanitized.length > 0 ? sanitized : "artifact";
}

function runCommand(command: string, args: string[]): Promise<{ ok: boolean; content: string }> {
  return new Promise((resolveCommand) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += String(chunk);
    });
    child.on("error", (error) => {
      resolveCommand({ ok: false, content: error.message });
    });
    child.on("close", (code) => {
      resolveCommand({ ok: code === 0, content: output.trim() });
    });
  });
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function isTextLikeDocument(attachment: { mimeType?: string; originalName?: string }): boolean {
  const mime = attachment.mimeType?.toLowerCase();
  const name = (attachment.originalName ?? "").toLowerCase();
  return mime?.startsWith("text/") === true ||
    mime === "application/json" ||
    mime === "application/xml" ||
    mime === "text/xml" ||
    mime === "text/markdown" ||
    /\.(txt|md|markdown|json|xml|csv)$/iu.test(name);
}
