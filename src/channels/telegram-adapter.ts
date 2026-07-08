import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { ArtifactRecord } from "../contracts/artifact.js";
import type {
  AdapterCapability,
  ChannelAdapter,
  ChannelAttachment,
  ChannelAttachmentStatus,
  ChannelMessage,
  ChannelSessionKey,
  ChannelStreamingTextHandle,
  ChannelStreamingTextOptions,
  ChannelStreamingTextResult,
  ChannelTextOptions
} from "../contracts/channel.js";
import type { RuntimeEvent } from "../contracts/runtime-event.js";
import type { TelegramChannelConfig } from "../config/runtime-config.js";
import { buildAdapterCapability } from "./adapter-capability.js";
import { renderChannelProgressLabel, type ActivityLabelLocale } from "./activity-labels.js";
import { formatTelegramReply } from "./telegram-format.js";
import {
  createTelegramStreamTextSanitizer,
  escapeTelegramPartialHtml,
  getUtf16Length,
  type TelegramStreamTextSanitizer
} from "./telegram-stream-text.js";

export type TelegramFetch = (url: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}) => Promise<{
  ok: boolean;
  status: number;
  statusText?: string;
  arrayBuffer?(): Promise<ArrayBuffer>;
  json(): Promise<unknown>;
  text?(): Promise<string>;
}>;

export type TelegramAdapterOptions = {
  botToken: string;
  defaultChatId?: string;
  pollTimeoutSeconds?: number;
  maxAttachmentBytes?: number;
  mediaRoot?: string;
  voiceTempRoot?: string;
  ffmpegPath?: string;
  activityLabelsLocale?: ActivityLabelLocale;
  fetch?: TelegramFetch;
  now?: () => Date;
  streamingNowMs?: () => number;
  mediaGroupBatchMs?: number;
  enabled?: boolean;
  missing?: string[];
};

export type TelegramCommand = {
  command: string;
  description: string;
};

type TelegramApiErrorParameters = {
  retry_after?: number;
};

type TelegramApiResponse<T> = {
  ok: boolean;
  result?: T;
  error_code?: number;
  description?: string;
  parameters?: TelegramApiErrorParameters;
};

export class TelegramApiError extends Error {
  readonly method: string;
  readonly httpStatus: number;
  readonly telegramErrorCode: number | undefined;
  readonly description: string | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(input: {
    method: string;
    httpStatus: number;
    statusText?: string;
    telegramErrorCode?: number;
    description?: string;
    retryAfterSeconds?: number;
  }) {
    super(`Telegram ${input.method} failed: ${input.description ?? input.statusText ?? input.httpStatus}`);
    this.name = "TelegramApiError";
    this.method = input.method;
    this.httpStatus = input.httpStatus;
    this.telegramErrorCode = input.telegramErrorCode;
    this.description = input.description;
    this.retryAfterSeconds = input.retryAfterSeconds;
  }
}

type TelegramFileInfo = {
  file_id: string;
  file_unique_id?: string;
  file_size?: number;
  file_path?: string;
};

type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

type TelegramCallbackQuery = {
  id: string;
  data?: string;
  from?: {
    id: number | string;
    first_name?: string;
    last_name?: string;
    username?: string;
  };
  message?: TelegramMessage;
};

type TelegramMessage = {
  message_id: number;
  date?: number;
  message_thread_id?: number;
  media_group_id?: string;
  text?: string;
  caption?: string;
  chat: {
    id: number | string;
    type?: string;
    title?: string;
    username?: string;
  };
  from?: {
    id: number | string;
    first_name?: string;
    last_name?: string;
    username?: string;
  };
  photo?: Array<{
    file_id: string;
    file_unique_id?: string;
    file_size?: number;
    width?: number;
    height?: number;
  }>;
  document?: TelegramFile;
  video?: TelegramFile;
  audio?: TelegramFile;
  voice?: TelegramFile;
};

type TelegramFile = {
  file_id: string;
  file_unique_id?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
};

type TelegramSentMessage = {
  message_id: number;
};

type ProgressEntry = {
  text: string;
  count: number;
};

type TelegramProgressState = {
  messageId?: number;
  entries: ProgressEntry[];
  lastRendered?: string;
};

type TelegramMediaGroupBuffer = {
  handler: (message: ChannelMessage) => Promise<void>;
  messages: ChannelMessage[];
  latestReceivedAt: string;
  timer?: ReturnType<typeof setTimeout>;
};

const DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const TELEGRAM_MAX_TEXT_UTF16 = 4096;
const TELEGRAM_RICH_MESSAGE_MAX_CHARS = 32768;
const TELEGRAM_HTML_BALANCE_RESERVE = 64;
const DEFAULT_STREAM_EDIT_INTERVAL_MS = 750;
const DEFAULT_STREAM_MIN_INITIAL_CHARS = 24;
const DEFAULT_STREAM_CURSOR = "▌";
const DEFAULT_STREAM_MAX_FLOOD_STRIKES = 2;
const DEFAULT_MEDIA_GROUP_BATCH_MS = 800;

export function countUnicodeCodePoints(text: string): number {
  return Array.from(text).length;
}

function telegramMediaGroupId(message: ChannelMessage): string | undefined {
  const telegram = message.metadata?.telegram;
  if (telegram === undefined || telegram === null || typeof telegram !== "object" || Array.isArray(telegram)) {
    return undefined;
  }
  const mediaGroupId = (telegram as { mediaGroupId?: unknown }).mediaGroupId;
  return typeof mediaGroupId === "string" && mediaGroupId.length > 0 ? mediaGroupId : undefined;
}

function telegramMessageId(message: ChannelMessage): number | undefined {
  const telegram = message.metadata?.telegram;
  if (telegram === undefined || telegram === null || typeof telegram !== "object" || Array.isArray(telegram)) {
    return undefined;
  }
  const messageId = (telegram as { messageId?: unknown }).messageId;
  return typeof messageId === "number" && Number.isFinite(messageId) ? messageId : undefined;
}

function telegramMediaGroupKey(message: ChannelMessage, mediaGroupId: string): string {
  return [
    message.channel,
    message.sessionKey.chatId,
    message.sessionKey.threadId ?? "",
    message.sessionKey.userId ?? message.sender.id,
    mediaGroupId
  ].join(":");
}

function combineTelegramMediaGroupMessages(
  messages: ChannelMessage[],
  options: { latestReceivedAt: string; windowMs: number }
): ChannelMessage {
  const ordered = [...messages].sort((left, right) =>
    (telegramMessageId(left) ?? Number.MAX_SAFE_INTEGER) -
    (telegramMessageId(right) ?? Number.MAX_SAFE_INTEGER)
  );
  const first = ordered[0] ?? messages[0]!;
  const mediaGroupId = telegramMediaGroupId(first);
  const text = ordered.find((message) => message.text.trim().length > 0)?.text ?? "";
  const attachments = ordered.flatMap((message) => message.attachments ?? []);
  const messageIds = ordered
    .map(telegramMessageId)
    .filter((messageId): messageId is number => messageId !== undefined);
  const updateIds = ordered
    .map((message) => {
      const telegram = message.metadata?.telegram;
      return telegram !== undefined && telegram !== null && typeof telegram === "object" && !Array.isArray(telegram)
        ? (telegram as { updateId?: unknown }).updateId
        : undefined;
    })
    .filter((updateId): updateId is number => typeof updateId === "number" && Number.isFinite(updateId));

  return {
    ...first,
    id: `${first.id}-media-group-${mediaGroupId ?? "unknown"}`,
    text,
    attachments,
    receivedAt: options.latestReceivedAt,
    metadata: {
      ...(first.metadata ?? {}),
      telegram: {
        ...((first.metadata?.telegram !== undefined && first.metadata.telegram !== null && typeof first.metadata.telegram === "object" && !Array.isArray(first.metadata.telegram))
          ? first.metadata.telegram
          : {}),
        mediaGroupId,
        mediaGroupMessageIds: messageIds,
        mediaGroupUpdateIds: updateIds,
        mediaGroupSize: ordered.length,
        mediaGroupWindowMs: options.windowMs
      }
    }
  };
}

export class TelegramAdapter implements ChannelAdapter {
  readonly id = "telegram";
  readonly kind = "telegram";
  readonly #botToken: string;
  readonly #defaultChatId: string | undefined;
  readonly #pollTimeoutSeconds: number;
  readonly #maxAttachmentBytes: number;
  readonly #mediaRoot: string | undefined;
  readonly #voiceTempRoot: string | undefined;
  readonly #ffmpegPath: string;
  readonly #activityLabelsLocale: ActivityLabelLocale;
  readonly #fetch: TelegramFetch;
  readonly #now: () => Date;
  readonly #streamingNowMs: () => number;
  readonly #mediaGroupBatchMs: number;
  readonly #config: TelegramChannelConfig;
  readonly #missing: string[] | undefined;
  #draftCapable = true;
  #richSendDisabled = false;
  #richDraftDisabled = false;
  #handler: ((message: ChannelMessage) => Promise<void>) | undefined;
  #offset = 0;
  #running = false;
  readonly #progressByChat = new Map<string, TelegramProgressState>();
  readonly #mediaGroupBuffers = new Map<string, TelegramMediaGroupBuffer>();

  readonly delivery = {
    sendText: async (sessionKey: ChannelSessionKey, text: string, options?: ChannelTextOptions) => {
      this.#progressByChat.delete(sessionKey.chatId);
      const formatted = formatTelegramReply(text, options);
      const chunks = chunkTelegramText(formatted.text, formatted.format);
      const editMessageId = parseTelegramEditMessageId(options?.editMessageId);

      if (chunks.length === 1 && editMessageId !== undefined) {
        try {
          await this.#editMessageText(sessionKey.chatId, editMessageId, chunks[0] ?? "", {
            ...options,
            format: formatted.format
          });
          return;
        } catch {
          // Stale or deleted callback messages should not break delivery; send a fresh card instead.
        }
      }

      for (const [index, chunk] of chunks.entries()) {
        await this.#sendMessage(sessionKey.chatId, chunk, {
          ...options,
          actions: index === chunks.length - 1 ? options?.actions : undefined,
          format: formatted.format
        });
      }
    },
    sendProgress: async (sessionKey: ChannelSessionKey, event: RuntimeEvent) => {
      if (event.kind === "agent-start" || event.kind === "provider-attempt") {
        await this.#sendChatAction(sessionKey.chatId, "typing");
      }

      const rendered = renderChannelProgressLabel(event, this.#activityLabelsLocale);

      if (rendered.length > 0) {
        await this.#upsertProgressMessage(sessionKey.chatId, rendered);
      }
    },
    sendArtifact: async (sessionKey: ChannelSessionKey, artifact: ArtifactRecord) => {
      this.#progressByChat.delete(sessionKey.chatId);
      if (artifact.kind === "audio") {
        const delivered = await this.#sendAudioArtifact(sessionKey.chatId, artifact);
        if (delivered) {
          return;
        }
      }
      if (artifact.kind === "image") {
        const delivered = await this.#sendImageArtifact(sessionKey.chatId, artifact);
        if (delivered) {
          return;
        }
      }
      // Telegram Bot API limits:
      // - Multipart uploads: 50 MB for documents, videos, and other non-photo files
      // - URL-based sending: 20 MB for other types of content, enforced server-side
      const TELEGRAM_MAX_MULTIPART_BYTES = 50 * 1024 * 1024;
      const effectiveLimit = Math.min(this.#maxAttachmentBytes, TELEGRAM_MAX_MULTIPART_BYTES);
      const filePath = artifact.localPath ?? artifact.path;
      let exceedsLimit = false;
      if (filePath && !isHttpUrl(filePath)) {
        const info = await stat(filePath).catch(() => undefined);
        exceedsLimit = (info?.size ?? 0) > effectiveLimit;
      }
      if (!exceedsLimit) {
        if (artifact.kind === "video") {
          const delivered = await this.#sendVideoArtifact(sessionKey.chatId, artifact);
          if (delivered) {
            return;
          }
        }
        if (artifact.kind === "document" || artifact.kind === "data" || artifact.kind === "other") {
          const delivered = await this.#sendDocumentArtifact(sessionKey.chatId, artifact);
          if (delivered) {
            return;
          }
        }
      }
      await this.#sendMessage(sessionKey.chatId, renderArtifactNotice(artifact));
    },
    startStreamingText: (sessionKey: ChannelSessionKey, options?: ChannelStreamingTextOptions) => {
      return this.#startStreamingText(sessionKey, options);
    }
  };

  constructor(options: TelegramAdapterOptions) {
    this.#botToken = options.botToken;
    this.#defaultChatId = options.defaultChatId;
    this.#pollTimeoutSeconds = options.pollTimeoutSeconds ?? 25;
    this.#maxAttachmentBytes = options.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
    this.#mediaRoot = options.mediaRoot;
    this.#voiceTempRoot = options.voiceTempRoot;
    this.#ffmpegPath = options.ffmpegPath ?? "ffmpeg";
    this.#activityLabelsLocale = options.activityLabelsLocale ?? "en";
    this.#fetch = options.fetch ?? fetchJson;
    this.#now = options.now ?? (() => new Date());
    this.#streamingNowMs = options.streamingNowMs ?? (() => performance.now());
    this.#mediaGroupBatchMs = Math.max(0, Math.trunc(options.mediaGroupBatchMs ?? DEFAULT_MEDIA_GROUP_BATCH_MS));
    this.#missing = options.missing;
    this.#config = {
      enabled: options.enabled ?? true,
      defaultChatId: options.defaultChatId,
      pollTimeoutSeconds: options.pollTimeoutSeconds,
      maxAttachmentBytes: options.maxAttachmentBytes,
    };
  }

  getCapabilities(): AdapterCapability {
    return buildAdapterCapability({ kind: "telegram", config: this.#config, missing: this.#missing });
  }

  async start(handler: (message: ChannelMessage) => Promise<void>): Promise<void> {
    this.#handler = handler;
    this.#running = true;
  }

  async stop(): Promise<void> {
    this.#running = false;
    await this.#flushMediaGroupBuffers();
  }

  async pollOnce(): Promise<number> {
    if (this.#handler === undefined) {
      throw new Error("TelegramAdapter must be started before polling");
    }

    const response = await this.#call<TelegramUpdate[]>("getUpdates", {
      offset: this.#offset,
      timeout: this.#pollTimeoutSeconds,
      allowed_updates: ["message", "edited_message", "callback_query"]
    });
    let count = 0;

    for (const update of response) {
      this.#offset = Math.max(this.#offset, update.update_id + 1);
      const message = updateToChannelMessage(update, this.#now);

      if (message === undefined) {
        continue;
      }

      if (this.#mediaRoot !== undefined && (message.attachments ?? []).length > 0) {
        message.attachments = await this.#downloadAttachments(message);
      }

      const buffered = this.#maybeBufferMediaGroup(message);
      if (!buffered) {
        try {
          await this.#handler(message);
        } finally {
          if (update.callback_query?.id !== undefined) {
            await this.#answerCallbackQuery(update.callback_query.id);
          }
        }
      }
      count += 1;
    }

    return count;
  }

  #maybeBufferMediaGroup(message: ChannelMessage): boolean {
    if (this.#handler === undefined) {
      return false;
    }

    const mediaGroupId = telegramMediaGroupId(message);
    if (mediaGroupId === undefined || (message.attachments?.length ?? 0) === 0) {
      return false;
    }

    const key = telegramMediaGroupKey(message, mediaGroupId);
    const existing = this.#mediaGroupBuffers.get(key);
    if (existing !== undefined) {
      existing.messages.push(message);
      existing.latestReceivedAt = message.receivedAt;
      this.#resetMediaGroupTimer(key, existing);
      return true;
    }

    const buffer: TelegramMediaGroupBuffer = {
      handler: this.#handler,
      messages: [message],
      latestReceivedAt: message.receivedAt,
      timer: undefined
    };
    this.#mediaGroupBuffers.set(key, buffer);
    this.#resetMediaGroupTimer(key, buffer);
    return true;
  }

  #resetMediaGroupTimer(key: string, buffer: TelegramMediaGroupBuffer): void {
    if (buffer.timer !== undefined) {
      clearTimeout(buffer.timer);
    }
    buffer.timer = setTimeout(() => {
      void this.#flushMediaGroupBuffer(key).catch(() => undefined);
    }, this.#mediaGroupBatchMs);
  }

  async #flushMediaGroupBuffers(): Promise<void> {
    for (const key of [...this.#mediaGroupBuffers.keys()]) {
      await this.#flushMediaGroupBuffer(key);
    }
  }

  async #flushMediaGroupBuffer(key: string): Promise<void> {
    const buffer = this.#mediaGroupBuffers.get(key);
    if (buffer === undefined) {
      return;
    }
    this.#mediaGroupBuffers.delete(key);
    if (buffer.timer !== undefined) {
      clearTimeout(buffer.timer);
    }

    const combined = combineTelegramMediaGroupMessages(buffer.messages, {
      latestReceivedAt: buffer.latestReceivedAt,
      windowMs: this.#mediaGroupBatchMs
    });
    await buffer.handler(combined);
  }

  get running(): boolean {
    return this.#running;
  }

  #startStreamingText(sessionKey: ChannelSessionKey, options?: ChannelStreamingTextOptions): ChannelStreamingTextHandle {
    return new TelegramStreamingTextWorker({
      chatId: sessionKey.chatId,
      chatType: sessionKey.chatType,
      options,
      sendMessage: async (text, textOptions) => this.#sendMessage(sessionKey.chatId, text, textOptions),
      editMessageText: async (messageId, text, textOptions) => this.#editMessageText(sessionKey.chatId, messageId, text, textOptions),
      deleteMessage: async (messageId) => this.#deleteMessage(sessionKey.chatId, messageId),
      sendDraft: async (draftId, text) => this.#sendDraft(sessionKey.chatId, draftId, text),
      trySendRich: async (text) => this.#trySendRichMessage(sessionKey.chatId, text),
      trySendRichDraft: async (draftId, text) => this.#trySendRichDraft(sessionKey.chatId, draftId, text),
      prefersFreshFinal: (text) => this.#prefersFreshFinal(text),
      clearProgress: () => {
        this.#progressByChat.delete(sessionKey.chatId);
      },
      formatFinalText: (text) => {
        const formatted = formatTelegramReply(text);
        return {
          chunks: chunkTelegramText(formatted.text, formatted.format),
          format: formatted.format
        };
      },
      nowMs: this.#streamingNowMs
    });
  }

  async #trySendRichMessage(
    chatId: string,
    content: string,
    options?: ChannelTextOptions
  ): Promise<TelegramSentMessage | undefined> {
    if (!this.#shouldAttemptRich(content)) {
      return undefined;
    }

    try {
      return await this.#call<TelegramSentMessage>("sendRichMessage", {
        chat_id: chatId,
        ...this.#richMessagePayload(content),
        link_preview_options: this.#richLinkPreviewOptions(),
        reply_markup: options?.actions === undefined
          ? undefined
          : this.#inlineKeyboardPayload(options.actions)
      });
    } catch (error) {
      if (this.#isRichCapabilityError(error)) {
        this.#richSendDisabled = true;
        return undefined;
      }
      throw error;
    }
  }

  async #trySendRichDraft(chatId: string, draftId: number, content: string): Promise<boolean> {
    if (this.#richSendDisabled || this.#richDraftDisabled || !this.#botSupportsRich()) {
      return false;
    }

    if (content.trim().length === 0 || !this.#contentFitsRichLimits(content)) {
      return false;
    }

    try {
      await this.#call("sendRichMessageDraft", {
        chat_id: chatId,
        draft_id: draftId,
        ...this.#richMessagePayload(content)
      });
      return true;
    } catch (error) {
      if (this.#isRichCapabilityError(error)) {
        this.#richDraftDisabled = true;
      }
      return false;
    }
  }

  #prefersFreshFinal(content: string): boolean {
    return this.#shouldAttemptRich(content);
  }

  #contentFitsRichLimits(content: string): boolean {
    return countUnicodeCodePoints(content) <= TELEGRAM_RICH_MESSAGE_MAX_CHARS;
  }

  #botSupportsRich(): boolean {
    return true;
  }

  #shouldAttemptRich(content: string): boolean {
    return !this.#richSendDisabled
      && this.#botSupportsRich()
      && content.trim().length > 0
      && this.#contentFitsRichLimits(content);
  }

  #richMessagePayload(content: string): Record<string, unknown> {
    return {
      rich_message: {
        markdown: content
      }
    };
  }

  #richLinkPreviewOptions(): Record<string, unknown> {
    return {
      is_disabled: true
    };
  }

  #isRichCapabilityError(error: unknown): boolean {
    if (!(error instanceof TelegramApiError)) {
      return false;
    }

    const description = error.description?.toLowerCase() ?? "";
    return error.httpStatus === 404
      || error.telegramErrorCode === 404
      || description.includes("not found")
      || description.includes("no such method")
      || description.includes("unsupported")
      || description.includes("not implemented");
  }

  async #sendMessage(chatId: string, text: string, options?: ChannelTextOptions): Promise<TelegramSentMessage> {
    return this.#call<TelegramSentMessage>("sendMessage", {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      parse_mode: options?.format === "html" ? "HTML" : undefined,
      reply_markup: options?.actions === undefined
        ? undefined
        : this.#inlineKeyboardPayload(options.actions)
    });
  }

  #inlineKeyboardPayload(actions: NonNullable<ChannelTextOptions["actions"]>): Record<string, unknown> {
    return {
      inline_keyboard: actions.map((row) =>
        row.map((action) => ({
          text: action.label,
          callback_data: action.value
        }))
      )
    };
  }

  async #sendDraft(chatId: string, draftId: number, text: string): Promise<{ ok: boolean }> {
    if (!this.#draftCapable) {
      return { ok: false };
    }

    try {
      await this.#call("sendMessageDraft", {
        chat_id: chatId,
        draft_id: draftId,
        text,
        parse_mode: "HTML"
      });
      return { ok: true };
    } catch (error) {
      if (isTelegramDraftCapabilityError(error)) {
        this.#draftCapable = false;
      }
      return { ok: false };
    }
  }

  async setCommands(commands: TelegramCommand[]): Promise<void> {
    await this.#call("setMyCommands", {
      commands: commands
        .map((command) => ({
          command: command.command.startsWith("/") ? command.command.slice(1) : command.command,
          description: command.description.slice(0, 256)
        }))
        .filter((command) => /^[a-z0-9_]{1,32}$/u.test(command.command))
    });
  }

  async #sendChatAction(chatId: string, action: "typing" | "upload_document" | "upload_photo" | "upload_voice" | "upload_video"): Promise<void> {
    await this.#call("sendChatAction", {
      chat_id: chatId,
      action
    });
  }

  async #answerCallbackQuery(callbackQueryId: string): Promise<void> {
    await this.#call("answerCallbackQuery", {
      callback_query_id: callbackQueryId
    });
  }

  async #editMessageText(chatId: string, messageId: number, text: string, options?: ChannelTextOptions): Promise<TelegramSentMessage> {
    return this.#call<TelegramSentMessage>("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      disable_web_page_preview: true,
      parse_mode: options?.format === "html" ? "HTML" : undefined,
      reply_markup: options?.actions === undefined
        ? undefined
        : this.#inlineKeyboardPayload(options.actions)
    });
  }

  async #deleteMessage(chatId: string, messageId: number): Promise<void> {
    await this.#call("deleteMessage", {
      chat_id: chatId,
      message_id: messageId
    });
  }

  async #upsertProgressMessage(chatId: string, line: string): Promise<void> {
    const state = this.#progressByChat.get(chatId) ?? {
      entries: []
    };
    appendProgressEntry(state.entries, line);
    const rendered = renderProgressSummary(state.entries);

    if (rendered.length === 0 || rendered === state.lastRendered) {
      this.#progressByChat.set(chatId, state);
      return;
    }

    if (state.messageId === undefined) {
      const message = await this.#sendMessage(chatId, rendered);
      state.messageId = message.message_id;
      state.lastRendered = rendered;
      this.#progressByChat.set(chatId, state);
      return;
    }

    try {
      await this.#editMessageText(chatId, state.messageId, rendered);
      state.lastRendered = rendered;
      this.#progressByChat.set(chatId, state);
    } catch {
      const message = await this.#sendMessage(chatId, rendered);
      state.messageId = message.message_id;
      state.lastRendered = rendered;
      this.#progressByChat.set(chatId, state);
    }
  }

  async #downloadAttachments(message: ChannelMessage): Promise<ChannelAttachment[]> {
    const downloaded: ChannelAttachment[] = [];

    for (const attachment of message.attachments ?? []) {
      const unsupportedReason = classifyUnsupportedAttachment(attachment);
      if (unsupportedReason !== undefined) {
        downloaded.push(markAttachmentFailure(attachment, "unsupported", "unsupported-type", unsupportedReason));
        continue;
      }

      if ((attachment.bytes ?? 0) > this.#maxAttachmentBytes) {
        downloaded.push(markAttachmentFailure(
          attachment,
          "too-large",
          "attachment-too-large",
          `This attachment is too large to inspect in Telegram right now. The current limit is ${formatBytes(this.#maxAttachmentBytes)}.`
        ));
        continue;
      }

      const fileId = typeof attachment.metadata?.telegramFileId === "string"
        ? attachment.metadata.telegramFileId
        : attachment.id;

      let info: TelegramFileInfo;
      try {
        info = await this.#call<TelegramFileInfo>("getFile", {
          file_id: fileId
        });
      } catch {
        downloaded.push(markAttachmentFailure(
          attachment,
          "download-failed",
          "attachment-download-failed",
          "I couldn't fetch that Telegram attachment just now. Please resend it and I'll try again."
        ));
        continue;
      }

      if ((info.file_size ?? attachment.bytes ?? 0) > this.#maxAttachmentBytes) {
        downloaded.push(markAttachmentFailure(
          {
            ...attachment,
            bytes: info.file_size ?? attachment.bytes
          },
          "too-large",
          "attachment-too-large",
          `This attachment is too large to inspect in Telegram right now. The current limit is ${formatBytes(this.#maxAttachmentBytes)}.`
        ));
        continue;
      }

      if (info.file_path === undefined) {
        downloaded.push(markAttachmentFailure(
          attachment,
          "download-failed",
          "attachment-download-failed",
          "I couldn't access the attachment file path from Telegram. Please resend it and I'll try again."
        ));
        continue;
      }

      try {
        const localPath = await this.#downloadFile({
          filePath: info.file_path,
          attachment,
          message
        });

        downloaded.push({
          ...attachment,
          status: "ready",
          failureCode: undefined,
          failureMessage: undefined,
          bytes: info.file_size ?? attachment.bytes,
          localPath,
          path: localPath,
          remoteUrl: `telegram://file/${info.file_path}`,
          metadata: {
            ...(attachment.metadata ?? {}),
            telegramFilePath: info.file_path,
            downloadedAt: this.#now().toISOString()
          }
        });
      } catch {
        downloaded.push(markAttachmentFailure(
          {
            ...attachment,
            bytes: info.file_size ?? attachment.bytes,
            remoteUrl: `telegram://file/${info.file_path}`
          },
          "download-failed",
          "attachment-download-failed",
          "I couldn't download that attachment just now. Please resend it and I'll try again."
        ));
      }
    }

    return downloaded;
  }

  async #downloadFile(input: {
    filePath: string;
    attachment: ChannelAttachment;
    message: ChannelMessage;
  }): Promise<string> {
    if (this.#mediaRoot === undefined) {
      throw new Error("Telegram media root is not configured");
    }

    const extension = extname(input.filePath) || extname(input.attachment.originalName ?? "") || extensionForAttachment(input.attachment);
    const filename = [
      sanitizePathPart(input.message.sessionKey.chatId),
      sanitizePathPart(input.message.id),
      sanitizePathPart(input.attachment.id)
    ].join("-");
    const localDir = join(this.#mediaRoot, "telegram", sanitizePathPart(input.message.sessionKey.chatId));
    const localPath = join(localDir, `${filename}${extension}`);
    const response = await this.#fetch(`https://api.telegram.org/file/bot${this.#botToken}/${input.filePath}`);

    if (!response.ok) {
      throw new Error(`Telegram file download failed: ${response.statusText ?? response.status}`);
    }

    if (response.arrayBuffer === undefined) {
      throw new Error("Telegram file download response does not support arrayBuffer");
    }

    await mkdir(localDir, { recursive: true });
    await writeFile(localPath, Buffer.from(await response.arrayBuffer()));

    return localPath;
  }

  async #sendAudioArtifact(chatId: string, artifact: ArtifactRecord): Promise<boolean> {
    let cleanupPath: string | undefined;
    try {
      const localPath = artifact.localPath ?? artifact.path;
      const converted = await this.#prepareTelegramVoiceArtifact(localPath, artifact);
      cleanupPath = converted.cleanupPath;
      const uploadPath = converted.path;
      const bytes = await readFile(uploadPath);
      const form = new FormData();
      const voiceBubble = converted.voiceBubble;
      form.set("chat_id", chatId);
      form.set(voiceBubble ? "voice" : "audio", new Blob([bytes], { type: converted.mimeType }), basename(uploadPath));
      const caption = renderAudioArtifactCaption(artifact);
      if (caption.length > 0) {
        form.set("caption", caption);
      }
      await this.#sendChatAction(chatId, "upload_voice");
      await this.#callMultipart<TelegramSentMessage>(voiceBubble ? "sendVoice" : "sendAudio", form);
      return true;
    } catch {
      return false;
    } finally {
      if (cleanupPath !== undefined) {
        await rm(cleanupPath, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  async #prepareTelegramVoiceArtifact(localPath: string, artifact: ArtifactRecord): Promise<{
    path: string;
    mimeType: string;
    voiceBubble: boolean;
    cleanupPath?: string;
  }> {
    if (isTelegramVoiceBubbleArtifact(artifact)) {
      return {
        path: localPath,
        mimeType: artifact.mimeType ?? "audio/ogg",
        voiceBubble: true
      };
    }

    if (artifact.metadata?.deliveryHint !== "voice") {
      return {
        path: localPath,
        mimeType: artifact.mimeType ?? "audio/mpeg",
        voiceBubble: false
      };
    }

    const converted = await this.#convertToTelegramVoice(localPath, artifact);
    if (converted === undefined) {
      return {
        path: localPath,
        mimeType: artifact.mimeType ?? "audio/mpeg",
        voiceBubble: false
      };
    }
    return converted;
  }

  async #convertToTelegramVoice(localPath: string, artifact: ArtifactRecord): Promise<{
    path: string;
    mimeType: string;
    voiceBubble: true;
    cleanupPath: string;
  } | undefined> {
    const root = this.#voiceTempRoot ?? (this.#mediaRoot === undefined ? undefined : join(this.#mediaRoot, "telegram-voice-temp"));
    if (root === undefined) {
      return undefined;
    }
    await mkdir(root, { recursive: true }).catch(() => {});
    const tempDir = await mkdtemp(join(root, "opus-")).catch(() => undefined);
    if (tempDir === undefined) {
      return undefined;
    }
    const outputPath = join(tempDir, `${sanitizePathPart(artifact.id)}.ogg`);
    const result = await runCommand(this.#ffmpegPath, [
      "-y",
      "-i",
      localPath,
      "-c:a",
      "libopus",
      "-b:a",
      "24k",
      outputPath
    ]);
    if (!result.ok) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      return undefined;
    }
    const fileStat = await stat(outputPath).catch(() => undefined);
    if (fileStat === undefined || fileStat.size === 0) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
      return undefined;
    }
    return {
      path: outputPath,
      mimeType: "audio/ogg",
      voiceBubble: true,
      cleanupPath: tempDir
    };
  }

  async #sendImageArtifact(chatId: string, artifact: ArtifactRecord): Promise<boolean> {
    try {
      const form = new FormData();
      form.set("chat_id", chatId);
      if (isHttpUrl(artifact.path)) {
        form.set("photo", artifact.path);
      } else {
        const localPath = artifact.localPath ?? artifact.path;
        const bytes = await readFile(localPath);
        form.set("photo", new Blob([bytes], { type: artifact.mimeType ?? "image/png" }), basename(localPath));
      }
      const caption = renderImageArtifactCaption(artifact);
      if (caption.length > 0) {
        form.set("caption", caption);
      }
      await this.#sendChatAction(chatId, "upload_photo");
      await this.#callMultipart<TelegramSentMessage>("sendPhoto", form);
      return true;
    } catch {
      return false;
    }
  }

  async #sendDocumentArtifact(chatId: string, artifact: ArtifactRecord): Promise<boolean> {
    try {
      const form = new FormData();
      form.set("chat_id", chatId);
      if (isHttpUrl(artifact.path)) {
        form.set("document", artifact.path);
      } else {
        const localPath = artifact.localPath ?? artifact.path;
        const bytes = await readFile(localPath);
        form.set("document", new Blob([bytes], { type: artifact.mimeType ?? "application/octet-stream" }), basename(localPath));
      }
      const caption = renderDocumentArtifactCaption(artifact);
      if (caption.length > 0) {
        form.set("caption", caption);
      }
      await this.#sendChatAction(chatId, "upload_document");
      await this.#callMultipart<TelegramSentMessage>("sendDocument", form);
      return true;
    } catch {
      return false;
    }
  }

  async #sendVideoArtifact(chatId: string, artifact: ArtifactRecord): Promise<boolean> {
    try {
      const form = new FormData();
      form.set("chat_id", chatId);
      if (isHttpUrl(artifact.path)) {
        form.set("video", artifact.path);
      } else {
        const localPath = artifact.localPath ?? artifact.path;
        const bytes = await readFile(localPath);
        form.set("video", new Blob([bytes], { type: artifact.mimeType ?? "video/mp4" }), basename(localPath));
      }
      const caption = renderVideoArtifactCaption(artifact);
      if (caption.length > 0) {
        form.set("caption", caption);
      }
      await this.#sendChatAction(chatId, "upload_video");
      await this.#callMultipart<TelegramSentMessage>("sendVideo", form);
      return true;
    } catch {
      return false;
    }
  }

  async #call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const response = await this.#fetch(`https://api.telegram.org/bot${this.#botToken}/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(body)
    });
    const payload = await response.json() as TelegramApiResponse<T>;

    if (!response.ok || !payload.ok) {
      throw telegramApiError(method, response, payload);
    }

    return payload.result as T;
  }

  async #callMultipart<T>(method: string, body: FormData): Promise<T> {
    const response = await this.#fetch(`https://api.telegram.org/bot${this.#botToken}/${method}`, {
      method: "POST",
      body: body as unknown as string
    });
    const payload = await response.json() as TelegramApiResponse<T>;

    if (!response.ok || !payload.ok) {
      throw telegramApiError(method, response, payload);
    }

    return payload.result as T;
  }
}

function telegramApiError<T>(
  method: string,
  response: Pick<Awaited<ReturnType<TelegramFetch>>, "status" | "statusText">,
  payload: TelegramApiResponse<T>
): TelegramApiError {
  return new TelegramApiError({
    method,
    httpStatus: response.status,
    statusText: response.statusText,
    telegramErrorCode: payload.error_code,
    description: payload.description,
    retryAfterSeconds: payload.parameters?.retry_after
  });
}

function isTelegramDraftCapabilityError(error: unknown): boolean {
  if (!(error instanceof TelegramApiError)) {
    return false;
  }

  const description = error.description?.toLowerCase() ?? "";
  return error.httpStatus === 404
    || error.telegramErrorCode === 404
    || description.includes("not found")
    || description.includes("no such method")
    || description.includes("unsupported");
}

function truncateTelegramRichDraftText(text: string): string {
  const codePoints = Array.from(text);
  if (codePoints.length <= TELEGRAM_RICH_MESSAGE_MAX_CHARS) {
    return text;
  }
  return codePoints.slice(0, TELEGRAM_RICH_MESSAGE_MAX_CHARS).join("");
}

type TelegramStreamingTextWorkerInput = {
  chatId: string;
  chatType?: "dm" | "group" | "channel" | "thread";
  options?: ChannelStreamingTextOptions;
  sendMessage(text: string, options: ChannelTextOptions): Promise<TelegramSentMessage>;
  editMessageText(messageId: number, text: string, options: ChannelTextOptions): Promise<TelegramSentMessage>;
  deleteMessage(messageId: number): Promise<void>;
  sendDraft?(draftId: number, text: string): Promise<{ ok: boolean }>;
  trySendRich?(text: string): Promise<TelegramSentMessage | undefined>;
  trySendRichDraft?(draftId: number, text: string): Promise<boolean>;
  prefersFreshFinal?(text: string): boolean;
  clearProgress(): void;
  formatFinalText(text: string): { chunks: string[]; format: "plain" | "html" };
  nowMs?(): number;
};

type TelegramStreamingTextSegment = {
  sanitizer: TelegramStreamTextSanitizer;
  messageId?: number;
  committedEscapedLength: number;
  committedMessageIds: number[];
  lastSentHtml?: string;
  timer?: ReturnType<typeof setTimeout>;
  retryTimer?: ReturnType<typeof setTimeout>;
  sealed: boolean;
  cleanupStarted: boolean;
};

class TelegramStreamingTextWorker implements ChannelStreamingTextHandle {
  static #draftIdCounter = 0;
  readonly #input: TelegramStreamingTextWorkerInput;
  readonly #editIntervalMs: number;
  readonly #minInitialChars: number;
  readonly #cursorText: string;
  readonly #cursorHtml: string;
  readonly #maxFloodStrikes: number;
  readonly #cleanupFailedAttempts: boolean;
  readonly #freshFinalAfterSeconds: number;
  readonly #nowMs: () => number;
  #useDraftStreaming = false;
  #draftId = 0;
  #lastDraftText = "";
  #segment: TelegramStreamingTextSegment = createStreamingTextSegment();
  #queue: Promise<void> = Promise.resolve();
  #terminal: "active" | "finished" | "aborted" | "failed" = "active";
  #fallbackRequired = false;
  #finishPromise: Promise<ChannelStreamingTextResult> | undefined;
  #abortPromise: Promise<void> | undefined;
  #messageCreatedTs: number | undefined;
  #floodStrikes = 0;
  readonly #errors: unknown[] = [];

  constructor(input: TelegramStreamingTextWorkerInput) {
    this.#input = input;
    this.#editIntervalMs = input.options?.editIntervalMs ?? DEFAULT_STREAM_EDIT_INTERVAL_MS;
    this.#minInitialChars = input.options?.minInitialChars ?? DEFAULT_STREAM_MIN_INITIAL_CHARS;
    this.#cursorText = input.options?.cursor ?? DEFAULT_STREAM_CURSOR;
    this.#cursorHtml = escapeTelegramPartialHtml(this.#cursorText);
    this.#maxFloodStrikes = Math.max(0, Math.trunc(input.options?.maxFloodStrikes ?? DEFAULT_STREAM_MAX_FLOOD_STRIKES));
    this.#cleanupFailedAttempts = input.options?.cleanupFailedAttempts ?? true;
    this.#freshFinalAfterSeconds = Math.max(0, input.options?.freshFinalAfterSeconds ?? 0);
    this.#nowMs = input.nowMs ?? (() => performance.now());
    const transport = input.options?.transport ?? "auto";
    this.#useDraftStreaming = transport !== "edit" && input.chatType === "dm" && input.sendDraft !== undefined;
    if (this.#useDraftStreaming) {
      this.#assignNextDraftId();
    }

    input.options?.signal?.addEventListener("abort", () => {
      void this.abort("signal");
    }, { once: true });
  }

  append(text: string): void {
    if (!this.#canStream() || text.length === 0) {
      return;
    }

    const segment = this.#segment;
    segment.sanitizer.append(text);
    const snapshot = segment.sanitizer.snapshot();

    if (snapshot.visibleCharCount === 0) {
      return;
    }

    this.#scheduleFlush(segment);
  }

  segmentBreak(_reason?: string): void {
    if (!this.#canStream()) {
      return;
    }

    const segment = this.#segment;
    this.#clearSegmentTimers(segment);
    this.#segment = createStreamingTextSegment();
    this.#messageCreatedTs = undefined;
    this.#lastDraftText = "";
    if (this.#useDraftStreaming) {
      this.#assignNextDraftId();
    }
    this.#input.clearProgress();
    this.#runSafely(async () => {
      if (this.#useDraftStreaming) {
        await this.#materializeDraftSegment(segment);
      } else {
        await this.#sealSegment(segment);
      }
    });
  }

  providerAttemptResult(result: {
    ok: boolean;
    willFallback: boolean;
    provider: string;
    model: string;
  }): void {
    if (!this.#canStream() || result.ok) {
      return;
    }

    const segment = this.#segment;
    if (result.willFallback) {
      this.#resetForProviderFallback(segment);
      return;
    }

    this.#degrade(segment);
    this.#runSafely(async () => {
      await this.#cleanupFailedAttempt(segment);
    });
  }

  finish(finalText: string): Promise<ChannelStreamingTextResult> {
    if (this.#finishPromise !== undefined) {
      return this.#finishPromise;
    }

    this.#terminal = "finished";
    const segment = this.#segment;
    this.#clearSegmentTimers(segment);
    this.#finishPromise = this.#enqueue(async () => {
      if (this.#fallbackRequired) {
        return {
          delivered: false,
          fallbackRequired: true
        };
      }

      if (this.#useDraftStreaming) {
        return this.#finishDraft(finalText);
      }

      if (segment.messageId === undefined) {
        return {
          delivered: false,
          fallbackRequired: true
        };
      }

      if (segment.messageId !== undefined && (this.#shouldSendFreshFinal() || this.#input.prefersFreshFinal?.(finalText) === true)) {
        return this.#finishWithFreshFinal(segment, finalText);
      }

      try {
        const formatted = this.#input.formatFinalText(finalText);
        const finalChunks = formatted.chunks.flatMap((chunk) => splitStreamingTelegramText(chunk, TELEGRAM_MAX_TEXT_UTF16));
        const [firstChunk, ...remainingChunks] = finalChunks;

        if (firstChunk === undefined) {
          return {
            delivered: false,
            fallbackRequired: true
          };
        }

        await this.#input.editMessageText(segment.messageId, firstChunk, { format: formatted.format });

        for (const chunk of remainingChunks) {
          await this.#input.sendMessage(chunk, { format: formatted.format });
        }

        this.#clearTimers();
        segment.lastSentHtml = firstChunk;
        return {
          delivered: true,
          fallbackRequired: false,
          deliveredText: finalText
        };
      } catch (error) {
        this.#captureError(error);
        return {
          delivered: false,
          fallbackRequired: true
        };
      }
    });
    return this.#finishPromise;
  }

  abort(_reason?: string): Promise<void> {
    if (this.#abortPromise !== undefined) {
      return this.#abortPromise;
    }

    this.#terminal = "aborted";
    const segment = this.#segment;
    this.#clearTimers();
    if (this.#useDraftStreaming) {
      this.#abortPromise = Promise.resolve();
      return this.#abortPromise;
    }
    this.#abortPromise = this.#enqueue(async () => {
      if (segment.messageId === undefined) {
        return;
      }

      try {
        await this.#editSegmentWithoutCursor(segment);
      } catch (error) {
        this.#captureError(error);
      }
    }).then(() => undefined, (error) => {
      this.#captureError(error);
    });
    return this.#abortPromise;
  }

  #scheduleFlush(segment: TelegramStreamingTextSegment): void {
    if (segment !== this.#segment || segment.timer !== undefined || segment.retryTimer !== undefined || !this.#canStream()) {
      return;
    }

    const delay = segment.messageId === undefined ? 0 : this.#editIntervalMs;
    segment.timer = setTimeout(() => {
      segment.timer = undefined;
      this.#runSafely(async () => {
        if (segment !== this.#segment || !this.#canStream()) {
          return;
        }
        await this.#flushSegment(segment, true);
      });
    }, delay);
  }

  async #sealSegment(segment: TelegramStreamingTextSegment): Promise<void> {
    if (segment.sealed) {
      return;
    }

    try {
      await this.#flushSegment(segment, false);
      if (segment.messageId !== undefined) {
        await this.#editSegmentWithoutCursor(segment);
      }
      segment.sealed = true;
    } catch (error) {
      this.#captureError(error);
      this.#fallbackRequired = true;
    }
  }

  async #flushSegment(segment: TelegramStreamingTextSegment, includeCursor: boolean): Promise<void> {
    if (segment.sealed || !this.#canStream()) {
      return;
    }

    const snapshot = segment.sanitizer.snapshot();

    if (snapshot.visibleCharCount === 0) {
      return;
    }

    if (segment.messageId === undefined && snapshot.visibleCharCount < this.#minInitialChars) {
      return;
    }

    const tailEscaped = snapshot.escapedHtml.slice(segment.committedEscapedLength);
    const cursorSuffix = includeCursor ? this.#cursorHtml : "";
    const rendered = `${tailEscaped}${cursorSuffix}`;

    if (this.#useDraftStreaming && includeCursor && segment.messageId === undefined) {
      if (this.#lastDraftText === rendered) {
        return;
      }

      const richDraftText = truncateTelegramRichDraftText(`${snapshot.visibleText}${this.#cursorText}`);
      const richDraftOk = await this.#input.trySendRichDraft?.(this.#draftId, richDraftText);
      if (richDraftOk === true) {
        this.#lastDraftText = rendered;
        return;
      }

      const draftRendered = getUtf16Length(rendered) > TELEGRAM_MAX_TEXT_UTF16
        ? splitTelegramText(rendered, TELEGRAM_MAX_TEXT_UTF16)[0] ?? rendered.slice(0, TELEGRAM_MAX_TEXT_UTF16)
        : rendered;

      const result = await this.#input.sendDraft?.(this.#draftId, draftRendered);
      if (result?.ok === true) {
        this.#lastDraftText = rendered;
        return;
      }

      this.#useDraftStreaming = false;
    }

    if (getUtf16Length(rendered) > TELEGRAM_MAX_TEXT_UTF16) {
      await this.#flushOverflowSegment(segment, includeCursor);
      return;
    }

    if (segment.messageId === undefined) {
      let message: TelegramSentMessage;
      try {
        message = await this.#input.sendMessage(rendered, { format: "html" });
      } catch (error) {
        if (this.#handleFloodControl(error, segment, includeCursor)) {
          return;
        }
        throw error;
      }
      if (!this.#canStream() || segment.sealed) {
        return;
      }
      segment.messageId = message.message_id;
      this.#recordMessageCreated(segment);
      segment.lastSentHtml = rendered;
      this.#floodStrikes = 0;
      return;
    }

    if (segment.lastSentHtml === rendered) {
      return;
    }

    try {
      await this.#input.editMessageText(segment.messageId, rendered, { format: "html" });
    } catch (error) {
      if (this.#handleFloodControl(error, segment, includeCursor)) {
        return;
      }
      throw error;
    }
    if (!this.#canStream() || segment.sealed) {
      return;
    }
    segment.lastSentHtml = rendered;
    this.#floodStrikes = 0;
  }

  async #flushOverflowSegment(segment: TelegramStreamingTextSegment, includeCursor: boolean): Promise<void> {
    if (segment.sealed || !this.#canStream()) {
      return;
    }

    const snapshot = segment.sanitizer.snapshot();
    const tailEscaped = snapshot.escapedHtml.slice(segment.committedEscapedLength);
    const cursorSuffix = includeCursor ? this.#cursorHtml : "";
    const chunks = splitOverflowTail(tailEscaped, TELEGRAM_MAX_TEXT_UTF16, cursorSuffix);

    if (chunks.length === 0) {
      return;
    }

    const finalChunk = chunks.at(-1);
    if (finalChunk === undefined) {
      return;
    }

    const previewChunks = chunks.slice(0, -1);
    let liveMessageId = segment.messageId;

    for (const [index, chunk] of previewChunks.entries()) {
      let previewMessageId: number;
      if (index === 0 && liveMessageId !== undefined) {
        try {
          await this.#input.editMessageText(liveMessageId, chunk, { format: "html" });
        } catch (error) {
          if (this.#handleFloodControl(error, segment, includeCursor)) {
            return;
          }
          throw error;
        }
        previewMessageId = liveMessageId;
        liveMessageId = undefined;
      } else {
        let message: TelegramSentMessage;
        try {
          message = await this.#input.sendMessage(chunk, { format: "html" });
        } catch (error) {
          if (this.#handleFloodControl(error, segment, includeCursor)) {
            return;
          }
          throw error;
        }
        previewMessageId = message.message_id;
        this.#recordMessageCreated(segment);
      }

      if (!this.#canStream() || segment.sealed) {
        return;
      }

      segment.committedEscapedLength += chunk.length;
      segment.committedMessageIds.push(previewMessageId);
      if (segment.messageId === previewMessageId) {
        segment.messageId = undefined;
        segment.lastSentHtml = undefined;
      }
      this.#floodStrikes = 0;
    }

    const renderedFinalChunk = `${finalChunk}${cursorSuffix}`;
    if (getUtf16Length(renderedFinalChunk) > TELEGRAM_MAX_TEXT_UTF16) {
      this.#degrade(segment);
      return;
    }

    if (liveMessageId === undefined) {
      let message: TelegramSentMessage;
      try {
        message = await this.#input.sendMessage(renderedFinalChunk, { format: "html" });
      } catch (error) {
        if (this.#handleFloodControl(error, segment, includeCursor)) {
          return;
        }
        throw error;
      }
      if (!this.#canStream() || segment.sealed) {
        return;
      }
      segment.messageId = message.message_id;
      this.#recordMessageCreated(segment);
    } else if (segment.lastSentHtml !== renderedFinalChunk) {
      try {
        await this.#input.editMessageText(liveMessageId, renderedFinalChunk, { format: "html" });
      } catch (error) {
        if (this.#handleFloodControl(error, segment, includeCursor)) {
          return;
        }
        throw error;
      }
      if (!this.#canStream() || segment.sealed) {
        return;
      }
      segment.messageId = liveMessageId;
    }

    segment.lastSentHtml = renderedFinalChunk;
    this.#floodStrikes = 0;
  }

  async #finishWithFreshFinal(
    segment: TelegramStreamingTextSegment,
    finalText: string
  ): Promise<ChannelStreamingTextResult> {
    try {
      const richMessage = await this.#input.trySendRich?.(finalText);
      if (richMessage !== undefined) {
        await this.#deletePreviewMessages(segment);
        this.#clearTimers();
        return {
          delivered: true,
          fallbackRequired: false,
          deliveredText: finalText
        };
      }

      const formatted = this.#input.formatFinalText(finalText);
      const chunks = formatted.chunks.flatMap((chunk) => splitStreamingTelegramText(chunk, TELEGRAM_MAX_TEXT_UTF16));

      if (chunks.length === 0) {
        return {
          delivered: false,
          fallbackRequired: true
        };
      }

      for (const chunk of chunks) {
        await this.#input.sendMessage(chunk, { format: formatted.format });
      }

      await this.#deletePreviewMessages(segment);
      this.#clearTimers();
      return {
        delivered: true,
        fallbackRequired: false,
        deliveredText: finalText
      };
    } catch (error) {
      this.#captureError(error);
      return {
        delivered: false,
        fallbackRequired: true
      };
    }
  }

  async #finishDraft(finalText: string): Promise<ChannelStreamingTextResult> {
    try {
      const formatted = this.#input.formatFinalText(finalText);
      const chunks = formatted.chunks.flatMap((chunk) => splitStreamingTelegramText(chunk, TELEGRAM_MAX_TEXT_UTF16));

      if (chunks.length === 0) {
        return {
          delivered: false,
          fallbackRequired: true
        };
      }

      for (const chunk of chunks) {
        await this.#input.sendMessage(chunk, { format: formatted.format });
      }

      this.#clearTimers();
      return {
        delivered: true,
        fallbackRequired: false,
        deliveredText: finalText
      };
    } catch (error) {
      this.#captureError(error);
      return {
        delivered: false,
        fallbackRequired: true
      };
    }
  }

  async #materializeDraftSegment(segment: TelegramStreamingTextSegment): Promise<void> {
    if (segment.sealed) {
      return;
    }

    const snapshot = segment.sanitizer.snapshot();
    if (snapshot.visibleCharCount === 0) {
      segment.sealed = true;
      return;
    }

    try {
      const formatted = this.#input.formatFinalText(snapshot.visibleText);
      const chunks = formatted.chunks.flatMap((chunk) => splitStreamingTelegramText(chunk, TELEGRAM_MAX_TEXT_UTF16));
      for (const chunk of chunks) {
        await this.#input.sendMessage(chunk, { format: formatted.format });
      }
      segment.sealed = true;
    } catch (error) {
      this.#captureError(error);
      this.#fallbackRequired = true;
    }
  }

  async #editSegmentWithoutCursor(segment: TelegramStreamingTextSegment): Promise<void> {
    if (segment.messageId === undefined) {
      return;
    }

    const rendered = segment.sanitizer.snapshot().escapedHtml.slice(segment.committedEscapedLength);

    if (rendered.length === 0 || segment.lastSentHtml === rendered) {
      return;
    }
    if (getUtf16Length(rendered) > TELEGRAM_MAX_TEXT_UTF16) {
      await this.#flushOverflowSegment(segment, false);
      return;
    }

    await this.#input.editMessageText(segment.messageId, rendered, { format: "html" });
    segment.lastSentHtml = rendered;
  }

  async #cleanupFailedAttempt(segment: TelegramStreamingTextSegment): Promise<void> {
    if (segment.cleanupStarted || segment.sealed) {
      return;
    }
    segment.cleanupStarted = true;

    if (!this.#cleanupFailedAttempts) {
      return;
    }

    const messageIds = [
      ...segment.committedMessageIds,
      ...(segment.messageId === undefined ? [] : [segment.messageId])
    ];

    for (const messageId of messageIds) {
      try {
        await this.#input.deleteMessage(messageId);
      } catch (deleteError) {
        this.#captureError(deleteError);
        try {
          await this.#input.editMessageText(messageId, "Response interrupted. A complete reply will follow.", { format: "html" });
        } catch (editError) {
          this.#captureError(editError);
        }
      }
    }
  }

  async #deletePreviewMessages(segment: TelegramStreamingTextSegment): Promise<void> {
    const messageIds = [
      ...segment.committedMessageIds,
      ...(segment.messageId === undefined ? [] : [segment.messageId])
    ];

    for (const messageId of messageIds) {
      try {
        await this.#input.deleteMessage(messageId);
      } catch (error) {
        this.#captureError(error);
      }
    }
  }

  #recordMessageCreated(segment: TelegramStreamingTextSegment): void {
    if (segment === this.#segment) {
      this.#messageCreatedTs ??= this.#nowMs();
    }
  }

  #shouldSendFreshFinal(): boolean {
    if (this.#freshFinalAfterSeconds <= 0 || this.#messageCreatedTs === undefined) {
      return false;
    }

    return this.#nowMs() - this.#messageCreatedTs >= this.#freshFinalAfterSeconds * 1000;
  }

  #assignNextDraftId(): void {
    TelegramStreamingTextWorker.#draftIdCounter += 1;
    this.#draftId = TelegramStreamingTextWorker.#draftIdCounter;
  }

  #handleFloodControl(error: unknown, segment: TelegramStreamingTextSegment, includeCursor: boolean): boolean {
    if (!(error instanceof TelegramApiError) || error.retryAfterSeconds === undefined) {
      return false;
    }

    this.#captureError(error);
    this.#floodStrikes += 1;
    if (this.#floodStrikes > this.#maxFloodStrikes) {
      this.#degrade(segment);
      return true;
    }

    this.#scheduleRetry(segment, includeCursor, error.retryAfterSeconds);
    return true;
  }

  #scheduleRetry(segment: TelegramStreamingTextSegment, includeCursor: boolean, retryAfterSeconds: number): void {
    if (segment.sealed || !this.#canStream()) {
      return;
    }

    this.#clearSegmentTimer(segment);
    if (segment.retryTimer !== undefined) {
      return;
    }

    const delayMs = Math.max(0, retryAfterSeconds * 1000);
    segment.retryTimer = setTimeout(() => {
      segment.retryTimer = undefined;
      this.#runSafely(async () => {
        if (segment !== this.#segment || segment.sealed || !this.#canStream()) {
          return;
        }
        await this.#flushSegment(segment, includeCursor);
      });
    }, delayMs);
  }

  #degrade(segment?: TelegramStreamingTextSegment): void {
    this.#fallbackRequired = true;
    this.#terminal = "failed";
    if (segment !== undefined) {
      this.#clearSegmentTimers(segment);
    }
    this.#clearTimers();
  }

  #resetForProviderFallback(segment: TelegramStreamingTextSegment): void {
    this.#clearSegmentTimers(segment);
    this.#segment = createStreamingTextSegment();
    this.#messageCreatedTs = undefined;
    this.#lastDraftText = "";
    this.#floodStrikes = 0;
    if (this.#useDraftStreaming) {
      this.#assignNextDraftId();
    }
    this.#input.clearProgress();
    this.#runSafely(async () => {
      await this.#cleanupFailedAttempt(segment);
    });
  }

  #canStream(): boolean {
    return this.#terminal === "active" && !this.#fallbackRequired;
  }

  #runSafely(operation: () => Promise<void>): void {
    void this.#enqueue(operation).catch((error) => {
      this.#captureError(error);
    });
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(() => undefined, (error) => {
      this.#captureError(error);
    });
    return result;
  }

  #clearTimers(): void {
    this.#clearSegmentTimers(this.#segment);
  }

  #clearSegmentTimer(segment: TelegramStreamingTextSegment): void {
    if (segment.timer !== undefined) {
      clearTimeout(segment.timer);
      segment.timer = undefined;
    }
  }

  #clearSegmentRetryTimer(segment: TelegramStreamingTextSegment): void {
    if (segment.retryTimer !== undefined) {
      clearTimeout(segment.retryTimer);
      segment.retryTimer = undefined;
    }
  }

  #clearSegmentTimers(segment: TelegramStreamingTextSegment): void {
    this.#clearSegmentTimer(segment);
    this.#clearSegmentRetryTimer(segment);
  }

  #captureError(error: unknown): void {
    this.#errors.push(error);
  }
}

function createStreamingTextSegment(): TelegramStreamingTextSegment {
  return {
    sanitizer: createTelegramStreamTextSanitizer(),
    committedEscapedLength: 0,
    committedMessageIds: [],
    sealed: false,
    cleanupStarted: false
  };
}

function splitOverflowTail(text: string, maxUtf16Length: number, cursorSuffix: string): string[] {
  if (text.length === 0) {
    return [];
  }

  const cursorLength = getUtf16Length(cursorSuffix);
  const finalMaxLength = Math.max(1, maxUtf16Length - cursorLength);
  const chunks: string[] = [];
  let remaining = text;

  if (cursorLength === 0) {
    return splitStreamingTelegramText(text, maxUtf16Length);
  }

  while (getUtf16Length(remaining) > maxUtf16Length) {
    const splitIndex = findSafeStreamingHtmlSplit(remaining, maxUtf16Length);
    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex);
  }

  if (getUtf16Length(`${remaining}${cursorSuffix}`) > maxUtf16Length) {
    const splitTarget = Math.max(1, remaining.length - finalMaxLength);
    const splitIndex = findSafeStreamingHtmlSplit(remaining, splitTarget);
    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex);
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

function splitStreamingTelegramText(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (getUtf16Length(remaining) > maxLength) {
    const splitIndex = findSafeStreamingHtmlSplit(remaining, maxLength);
    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex);
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

function findSafeStreamingHtmlSplit(text: string, targetIndex: number): number {
  const boundedTarget = Math.max(1, Math.min(targetIndex, text.length));
  const newlineIndex = text.lastIndexOf("\n", boundedTarget - 1);
  if (newlineIndex >= 0) {
    return newlineIndex + 1;
  }

  const spaceIndex = text.lastIndexOf(" ", boundedTarget - 1);
  if (spaceIndex >= 0) {
    return spaceIndex + 1;
  }

  return avoidHtmlEntitySplit(text, avoidSurrogateSplit(text, boundedTarget));
}

function avoidHtmlEntitySplit(text: string, index: number): number {
  const entityStart = text.lastIndexOf("&", index - 1);
  if (entityStart < 0) {
    return index;
  }

  const entityEnd = text.indexOf(";", entityStart + 1);
  if (entityEnd >= index && entityEnd - entityStart <= 10) {
    return Math.max(1, avoidSurrogateSplit(text, entityStart));
  }

  return index;
}

function avoidSurrogateSplit(text: string, index: number): number {
  if (index <= 0 || index >= text.length) {
    return index;
  }

  const previous = text.charCodeAt(index - 1);
  const current = text.charCodeAt(index);
  if (previous >= 0xD800 && previous <= 0xDBFF && current >= 0xDC00 && current <= 0xDFFF) {
    return index - 1;
  }

  return index;
}

export function updateToChannelMessage(update: TelegramUpdate, now: () => Date = () => new Date()): ChannelMessage | undefined {
  if (update.callback_query !== undefined) {
    return callbackQueryToChannelMessage(update, now);
  }

  const message = update.message ?? update.edited_message;

  if (message === undefined) {
    return undefined;
  }

  const chatId = String(message.chat.id);
  const senderId = String(message.from?.id ?? message.chat.id);
  const displayName = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(" ");

  return {
    id: `telegram-${update.update_id}-${message.message_id}`,
    channel: "telegram",
    sessionKey: {
      platform: "telegram",
      accountId: "telegram",
      chatId,
      chatType: telegramChatType(message.chat.type, message.message_thread_id),
      threadId: message.message_thread_id === undefined ? undefined : String(message.message_thread_id),
      userId: senderId
    },
    text: message.text ?? message.caption ?? "",
    sender: {
      id: senderId,
      displayName: displayName.length > 0 ? displayName : message.chat.title,
      username: message.from?.username ?? message.chat.username
    },
    attachments: telegramAttachments(message),
    receivedAt: message.date === undefined ? now().toISOString() : new Date(message.date * 1000).toISOString(),
    metadata: {
      telegram: {
        updateId: update.update_id,
        messageId: message.message_id,
        chatType: message.chat.type,
        ...(message.media_group_id === undefined ? {} : { mediaGroupId: message.media_group_id })
      }
    }
  };
}

function callbackQueryToChannelMessage(update: TelegramUpdate, now: () => Date): ChannelMessage | undefined {
  const callback = update.callback_query;
  const message = callback?.message;

  if (callback === undefined || message === undefined || typeof callback.data !== "string" || callback.data.length === 0) {
    return undefined;
  }

  const chatId = String(message.chat.id);
  const senderId = String(callback.from?.id ?? message.from?.id ?? message.chat.id);
  const displayName = [callback.from?.first_name, callback.from?.last_name].filter(Boolean).join(" ");

  return {
    id: `telegram-callback-${update.update_id}-${callback.id}`,
    channel: "telegram",
    sessionKey: {
      platform: "telegram",
      accountId: "telegram",
      chatId,
      chatType: telegramChatType(message.chat.type, message.message_thread_id),
      threadId: message.message_thread_id === undefined ? undefined : String(message.message_thread_id),
      userId: senderId
    },
    text: callback.data,
    sender: {
      id: senderId,
      displayName: displayName.length > 0 ? displayName : message.chat.title,
      username: callback.from?.username ?? message.from?.username ?? message.chat.username
    },
    attachments: [],
    receivedAt: message.date === undefined ? now().toISOString() : new Date(message.date * 1000).toISOString(),
    metadata: {
      telegram: {
        updateId: update.update_id,
        messageId: message.message_id,
        callbackQueryId: callback.id,
        chatType: message.chat.type
      }
    }
  };
}

function telegramChatType(chatType?: string, threadId?: number): "dm" | "group" | "channel" | "thread" {
  if (threadId !== undefined) {
    return "thread";
  }

  if (chatType === "private") {
    return "dm";
  }

  if (chatType === "channel") {
    return "channel";
  }

  return "group";
}

function telegramAttachments(message: TelegramMessage): ChannelAttachment[] {
  const attachments: ChannelAttachment[] = [];
  const largestPhoto = [...(message.photo ?? [])].sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0))[0];

  if (largestPhoto !== undefined) {
    attachments.push({
      id: largestPhoto.file_id,
      kind: "image",
      bytes: largestPhoto.file_size,
      metadata: {
        telegramFileId: largestPhoto.file_id,
        telegramUniqueId: largestPhoto.file_unique_id,
        width: largestPhoto.width,
        height: largestPhoto.height
      }
    });
  }

  appendFileAttachment(attachments, "document", message.document);
  appendFileAttachment(attachments, "video", message.video);
  appendFileAttachment(attachments, "audio", message.audio);
  appendFileAttachment(attachments, "voice", message.voice);

  return attachments;
}

function appendFileAttachment(
  attachments: ChannelAttachment[],
  kind: ChannelAttachment["kind"],
  file: TelegramFile | undefined
): void {
  if (file === undefined) {
    return;
  }

  attachments.push({
    id: file.file_id,
    kind,
    originalName: file.file_name,
    mimeType: file.mime_type,
    bytes: file.file_size,
    metadata: {
      telegramFileId: file.file_id,
      telegramUniqueId: file.file_unique_id
    }
  });
}

function appendProgressEntry(entries: ProgressEntry[], text: string): void {
  const last = entries.at(-1);

  if (last?.text === text) {
    last.count += 1;
    return;
  }

  entries.push({
    text,
    count: 1
  });

  if (entries.length > 12) {
    entries.splice(0, entries.length - 12);
  }
}

function renderProgressSummary(entries: ProgressEntry[]): string {
  return entries
    .map((entry) => entry.count > 1 ? `${entry.text} (x${entry.count})` : entry.text)
    .join("\n");
}

function renderArtifactNotice(artifact: ArtifactRecord): string {
  return [
    "💎 Artifact ready",
    `Type: ${artifact.kind}`,
    `Path: ${artifact.path}`,
    artifact.summary === undefined ? undefined : `Summary: ${truncateSummary(artifact.summary)}`
  ].filter((line) => line !== undefined).join("\n");
}

function renderAudioArtifactCaption(artifact: ArtifactRecord): string {
  return [
    artifact.summary ?? "Generated audio",
    `Artifact: ${artifact.id}`
  ].join("\n").slice(0, 1024);
}

function renderImageArtifactCaption(artifact: ArtifactRecord): string {
  return [
    artifact.summary ?? "Generated image",
    `Artifact: ${artifact.id}`
  ].join("\n").slice(0, 1024);
}

function renderDocumentArtifactCaption(artifact: ArtifactRecord): string {
  return [
    artifact.summary ?? `Generated ${artifact.kind}`,
    `Artifact: ${artifact.id}`
  ].join("\n").slice(0, 1024);
}

function renderVideoArtifactCaption(artifact: ArtifactRecord): string {
  return [
    artifact.summary ?? `Generated ${artifact.kind}`,
    `Artifact: ${artifact.id}`
  ].join("\n").slice(0, 1024);
}

function parseTelegramEditMessageId(value: string | null | undefined): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function chunkTelegramText(
  text: string,
  format: "plain" | "html",
  maxLength = TELEGRAM_MAX_TEXT_UTF16
): string[] {
  if (utf16Length(text) <= maxLength) {
    return [text];
  }

  let expectedChunkCount = Math.max(2, Math.ceil(utf16Length(text) / Math.max(1, maxLength - telegramChunkSuffix(1, 9).length)));
  let htmlReserve = format === "html" ? TELEGRAM_HTML_BALANCE_RESERVE : 0;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const suffixReserve = telegramChunkSuffix(expectedChunkCount, expectedChunkCount).length;
    const bodyLimit = maxLength - suffixReserve - htmlReserve;

    if (bodyLimit < 1) {
      break;
    }

    const rawChunks = splitTelegramText(text, bodyLimit);
    const chunks = format === "html" ? balanceHtmlChunks(rawChunks) : rawChunks;
    const nextChunkCount = chunks.length;
    const hasOversizedChunk = chunks.some((chunk, index) =>
      utf16Length(chunk) + telegramChunkSuffix(index + 1, nextChunkCount).length > maxLength
    );

    if (!hasOversizedChunk && nextChunkCount === expectedChunkCount) {
      return chunks.map((chunk, index) => chunk + telegramChunkSuffix(index + 1, nextChunkCount));
    }

    expectedChunkCount = nextChunkCount;

    if (hasOversizedChunk) {
      htmlReserve += TELEGRAM_HTML_BALANCE_RESERVE;
    }
  }

  return splitTelegramText(text, maxLength - telegramChunkSuffix(1, expectedChunkCount).length)
    .map((chunk, index, chunks) => chunk + telegramChunkSuffix(index + 1, chunks.length));
}

function utf16Length(text: string): number {
  return text.length;
}

function telegramChunkSuffix(index: number, total: number): string {
  return ` (${index}/${total})`;
}

function splitTelegramText(text: string, maxLength: number): string[] {
  if (utf16Length(text) <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    if (utf16Length(text.slice(start)) <= maxLength) {
      chunks.push(text.slice(start));
      break;
    }

    const splitAt = findTelegramSplit(text, start, maxLength);
    chunks.push(text.slice(start, splitAt));
    start = splitAt;
  }

  return chunks;
}

function findTelegramSplit(text: string, start: number, maxLength: number): number {
  const hardEnd = Math.min(start + maxLength, text.length);
  const minimum = start + Math.floor(maxLength / 2);
  const newline = text.lastIndexOf("\n", hardEnd);

  if (newline > minimum) {
    const splitAt = nudgeTelegramSplit(text, start, newline + 1, minimum);
    if (splitAt > start) {
      return splitAt;
    }
  }

  const space = text.lastIndexOf(" ", hardEnd);

  if (space > minimum) {
    const splitAt = nudgeTelegramSplit(text, start, space + 1, minimum);
    if (splitAt > start) {
      return splitAt;
    }
  }

  const splitAt = nudgeTelegramSplit(text, start, hardEnd, minimum);
  return splitAt > start ? splitAt : avoidSplitSurrogatePair(text, hardEnd);
}

function nudgeTelegramSplit(text: string, start: number, candidate: number, minimum: number): number {
  let splitAt = avoidSplitSurrogatePair(text, candidate);

  while (splitAt > start) {
    const unsafeStart = unsafeTrailingHtmlBoundaryStart(text, start, splitAt);

    if (unsafeStart === undefined) {
      return splitAt;
    }

    if (unsafeStart < minimum) {
      return 0;
    }

    splitAt = avoidSplitSurrogatePair(text, unsafeStart);
  }

  return 0;
}

function unsafeTrailingHtmlBoundaryStart(text: string, start: number, end: number): number | undefined {
  const value = text.slice(start, end);
  const lastLt = value.lastIndexOf("<");
  const lastGt = value.lastIndexOf(">");

  if (lastLt > lastGt) {
    return start + lastLt;
  }

  const lastAmp = value.lastIndexOf("&");
  const lastSemi = value.lastIndexOf(";");

  if (lastAmp > lastSemi && !/\s/u.test(value.slice(lastAmp + 1))) {
    return start + lastAmp;
  }

  return undefined;
}

function avoidSplitSurrogatePair(text: string, index: number): number {
  if (index <= 0 || index >= text.length) {
    return index;
  }

  const previous = text.charCodeAt(index - 1);
  const next = text.charCodeAt(index);

  if (previous >= 0xD800 && previous <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF) {
    return index - 1;
  }

  return index;
}

type HtmlTagFrame = {
  name: string;
  open: string;
};

function balanceHtmlChunks(chunks: string[]): string[] {
  const activeTags: HtmlTagFrame[] = [];

  return chunks.map((chunk) => {
    const prefix = activeTags.map((tag) => tag.open).join("");
    updateHtmlTagStack(activeTags, chunk);
    const suffix = [...activeTags].reverse().map((tag) => `</${tag.name}>`).join("");
    return `${prefix}${chunk}${suffix}`;
  });
}

function updateHtmlTagStack(activeTags: HtmlTagFrame[], text: string): void {
  for (const match of text.matchAll(/<\s*(\/)?\s*([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^>]*)?>/gu)) {
    const full = match[0];
    const closing = match[1] === "/";
    const name = match[2].toLowerCase();

    if (full.endsWith("/>")) {
      continue;
    }

    if (closing) {
      const existing = activeTags.map((tag) => tag.name).lastIndexOf(name);

      if (existing >= 0) {
        activeTags.splice(existing);
      }
      continue;
    }

    activeTags.push({ name, open: full });
  }
}

function isHttpUrl(value: string): boolean {
  return value.startsWith("https://") || value.startsWith("http://");
}

function isTelegramVoiceBubbleArtifact(artifact: ArtifactRecord): boolean {
  const mime = artifact.mimeType?.toLowerCase();
  const path = (artifact.localPath ?? artifact.path).toLowerCase();
  return mime === "audio/ogg" || path.endsWith(".ogg") || path.endsWith(".opus");
}

function runCommand(command: string, args: string[]): Promise<{ ok: true } | { ok: false }> {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", () => { resolveResult({ ok: false }); });
    child.on("close", (code) => { resolveResult(code === 0 ? { ok: true } : { ok: false }); });
  });
}

async function fetchJson(url: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}) {
  return fetch(url, init as RequestInit);
}

function sanitizePathPart(value: string): string {
  const base = basename(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");

  return base.length > 0 ? base.slice(0, 80) : "item";
}

function extensionForAttachment(attachment: ChannelAttachment): string {
  if (attachment.kind === "image") {
    return ".jpg";
  }

  if (attachment.kind === "video") {
    return ".mp4";
  }

  if (attachment.kind === "audio" || attachment.kind === "voice") {
    return ".ogg";
  }

  return ".bin";
}

function classifyUnsupportedAttachment(attachment: ChannelAttachment): string | undefined {
  if (attachment.kind === "image" || attachment.kind === "video" || attachment.kind === "audio" || attachment.kind === "voice") {
    return undefined;
  }

  if (attachment.kind === "document") {
    const normalizedMime = attachment.mimeType?.toLowerCase();
    const normalizedName = (attachment.originalName ?? attachment.name ?? "").toLowerCase();

    if (normalizedMime === undefined) {
      return normalizedName.length === 0 || /\.(txt|md|markdown|pdf|json|xml|csv)$/i.test(normalizedName)
        ? undefined
        : "I can't inspect this attachment type yet in Telegram. Try sending an image, PDF, or text-like document.";
    }

    if (
      normalizedMime.startsWith("text/") ||
      normalizedMime === "application/pdf" ||
      normalizedMime === "application/json" ||
      normalizedMime === "application/xml" ||
      normalizedMime === "text/xml" ||
      normalizedMime === "text/markdown"
    ) {
      return undefined;
    }

    if (/\.(txt|md|markdown|pdf|json|xml|csv)$/i.test(normalizedName)) {
      return undefined;
    }

    return "I can't inspect this attachment type yet in Telegram. Try sending an image, PDF, or text-like document.";
  }

  return "I can't inspect this attachment type yet in Telegram. Try sending an image, PDF, audio, video, or text-like document.";
}

function markAttachmentFailure(
  attachment: ChannelAttachment,
  status: Exclude<ChannelAttachmentStatus, "ready">,
  failureCode: string,
  failureMessage: string
): ChannelAttachment {
  return {
    ...attachment,
    status,
    failureCode,
    failureMessage,
    metadata: {
      ...(attachment.metadata ?? {}),
      attachmentStatus: status,
      attachmentFailureCode: failureCode
    }
  };
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${bytes} B`;
}

function truncateSummary(value: string, maxChars = 240): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}
