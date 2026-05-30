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
  ChannelTextOptions
} from "../contracts/channel.js";
import type { RuntimeEvent } from "../contracts/runtime-event.js";
import type { TelegramChannelConfig } from "../config/runtime-config.js";
import { buildAdapterCapability } from "./adapter-capability.js";
import { renderChannelProgressLabel, type ActivityLabelLocale } from "./activity-labels.js";
import { formatTelegramReply } from "./telegram-format.js";

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
  enabled?: boolean;
  missing?: string[];
};

export type TelegramCommand = {
  command: string;
  description: string;
};

type TelegramApiResponse<T> = {
  ok: boolean;
  result?: T;
  description?: string;
};

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

const DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const TELEGRAM_MAX_TEXT_UTF16 = 4096;
const TELEGRAM_HTML_BALANCE_RESERVE = 64;

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
  readonly #config: TelegramChannelConfig;
  readonly #missing: string[] | undefined;
  #handler: ((message: ChannelMessage) => Promise<void>) | undefined;
  #offset = 0;
  #running = false;
  readonly #progressByChat = new Map<string, TelegramProgressState>();

  readonly delivery = {
    sendText: async (sessionKey: ChannelSessionKey, text: string, options?: ChannelTextOptions) => {
      this.#progressByChat.delete(sessionKey.chatId);
      const formatted = formatTelegramReply(text, options);
      const chunks = chunkTelegramText(formatted.text, formatted.format);

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
      await this.#sendMessage(sessionKey.chatId, renderArtifactNotice(artifact));
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

      try {
        await this.#handler(message);
      } finally {
        if (update.callback_query?.id !== undefined) {
          await this.#answerCallbackQuery(update.callback_query.id);
        }
      }
      count += 1;
    }

    return count;
  }

  get running(): boolean {
    return this.#running;
  }

  async #sendMessage(chatId: string, text: string, options?: ChannelTextOptions): Promise<TelegramSentMessage> {
    return this.#call<TelegramSentMessage>("sendMessage", {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      parse_mode: options?.format === "html" ? "HTML" : undefined,
      reply_markup: options?.actions === undefined
        ? undefined
        : {
            inline_keyboard: options.actions.map((row) =>
              row.map((action) => ({
                text: action.label,
                callback_data: action.value
              }))
            )
          }
    });
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

  async #sendChatAction(chatId: string, action: "typing" | "upload_document" | "upload_photo" | "upload_voice"): Promise<void> {
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

  async #editMessageText(chatId: string, messageId: number, text: string): Promise<TelegramSentMessage> {
    return this.#call<TelegramSentMessage>("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      disable_web_page_preview: true
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
      throw new Error(`Telegram ${method} failed: ${payload.description ?? response.statusText ?? response.status}`);
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
      throw new Error(`Telegram ${method} failed: ${payload.description ?? response.statusText ?? response.status}`);
    }

    return payload.result as T;
  }
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
        chatType: message.chat.type
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
