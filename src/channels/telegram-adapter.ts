import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { ArtifactRecord } from "../contracts/artifact.js";
import type {
  ChannelAdapter,
  ChannelAttachment,
  ChannelMessage,
  ChannelSessionKey
} from "../contracts/channel.js";
import type { RuntimeEvent } from "../contracts/runtime-event.js";

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
  mediaRoot?: string;
  fetch?: TelegramFetch;
  now?: () => Date;
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
};

type TelegramMessage = {
  message_id: number;
  date?: number;
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

export class TelegramAdapter implements ChannelAdapter {
  readonly id = "telegram";
  readonly kind = "telegram";
  readonly #botToken: string;
  readonly #defaultChatId: string | undefined;
  readonly #pollTimeoutSeconds: number;
  readonly #mediaRoot: string | undefined;
  readonly #fetch: TelegramFetch;
  readonly #now: () => Date;
  #handler: ((message: ChannelMessage) => Promise<void>) | undefined;
  #offset = 0;
  #running = false;

  readonly delivery = {
    sendText: async (sessionKey: ChannelSessionKey, text: string) => {
      await this.#sendMessage(sessionKey.chatId, text);
    },
    sendProgress: async (sessionKey: ChannelSessionKey, event: RuntimeEvent) => {
      const rendered = renderProgress(event);

      if (rendered.length > 0) {
        await this.#sendMessage(sessionKey.chatId, rendered);
      }
    },
    sendArtifact: async (sessionKey: ChannelSessionKey, artifact: ArtifactRecord) => {
      await this.#sendMessage(sessionKey.chatId, renderArtifactNotice(artifact));
    }
  };

  constructor(options: TelegramAdapterOptions) {
    this.#botToken = options.botToken;
    this.#defaultChatId = options.defaultChatId;
    this.#pollTimeoutSeconds = options.pollTimeoutSeconds ?? 25;
    this.#mediaRoot = options.mediaRoot;
    this.#fetch = options.fetch ?? fetchJson;
    this.#now = options.now ?? (() => new Date());
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
      allowed_updates: ["message", "edited_message"]
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

      await this.#handler(message);
      count += 1;
    }

    return count;
  }

  get running(): boolean {
    return this.#running;
  }

  async #sendMessage(chatId: string, text: string): Promise<void> {
    await this.#call("sendMessage", {
      chat_id: chatId,
      text,
      disable_web_page_preview: true
    });
  }

  async #downloadAttachments(message: ChannelMessage): Promise<ChannelAttachment[]> {
    const downloaded: ChannelAttachment[] = [];

    for (const attachment of message.attachments ?? []) {
      const fileId = typeof attachment.metadata?.telegramFileId === "string"
        ? attachment.metadata.telegramFileId
        : attachment.id;
      const info = await this.#call<TelegramFileInfo>("getFile", {
        file_id: fileId
      });

      if (info.file_path === undefined) {
        downloaded.push(attachment);
        continue;
      }

      const localPath = await this.#downloadFile({
        filePath: info.file_path,
        attachment,
        message
      });

      downloaded.push({
        ...attachment,
        localPath,
        path: localPath,
        remoteUrl: `telegram://file/${info.file_path}`,
        metadata: {
          ...(attachment.metadata ?? {}),
          telegramFilePath: info.file_path,
          downloadedAt: this.#now().toISOString()
        }
      });
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
}

export function updateToChannelMessage(update: TelegramUpdate, now: () => Date = () => new Date()): ChannelMessage | undefined {
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

function renderProgress(event: RuntimeEvent): string {
  switch (event.kind) {
    case "agent-start":
      return "𓂀 EstaCoda is working...";
    case "skill":
      return `☥ skill: ${event.name}`;
    case "tool-start":
      return `💠 preparing ${event.tool}${event.stepId === undefined ? "" : ` (${event.stepId})`}`;
    case "provider-attempt":
      return `🧿 provider: ${event.provider}/${event.model}`;
    case "agent-final":
    case "provider-token":
      return "";
    default:
      return "";
  }
}

function renderArtifactNotice(artifact: ArtifactRecord): string {
  return [
    "💎 Artifact ready",
    `Type: ${artifact.kind}`,
    `Path: ${artifact.path}`,
    artifact.summary === undefined ? undefined : `Summary: ${artifact.summary}`
  ].filter((line) => line !== undefined).join("\n");
}

async function fetchJson(url: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}) {
  return fetch(url, init);
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
