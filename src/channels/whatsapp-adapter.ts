import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Boom } from "@hapi/boom";
import makeWASocket, {
  type WASocket,
  type BaileysEventMap,
  DisconnectReason,
  useMultiFileAuthState,
  downloadMediaMessage,
} from "@whiskeysockets/baileys";
import type { ArtifactRecord } from "../contracts/artifact.js";
import type {
  ChannelAdapter,
  ChannelAttachment,
  ChannelAttachmentKind,
  ChannelAttachmentStatus,
  ChannelMessage,
  ChannelSessionKey,
  ChannelTextOptions,
} from "../contracts/channel.js";
import type { RuntimeEvent } from "../contracts/runtime-event.js";
import { renderChannelProgressLabel } from "./activity-labels.js";

export type WhatsAppAdapterOptions = {
  /** Directory for Baileys auth state persistence */
  authDir?: string;
  /** Allowed user phone numbers (e.g. "971501234567") or JIDs (e.g. "971501234567@s.whatsapp.net") */
  allowedUsers?: string[];
  /** Pairing mode: qr = QR code scan, code = pairing code (bot) */
  pairingMode?: "qr" | "code";
  /** Phone number for pairing-code mode (e.g. "971501234567") */
  pairingCodePhoneNumber?: string;
  /** Max characters per message chunk (WhatsApp limit ~4096) */
  maxTextLength?: number;
  /** Directory to save downloaded media */
  mediaRoot?: string;
  /** Logger compatible with Baileys ILogger */
  logger?: {
    trace: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    fatal: (...args: unknown[]) => void;
  };
  /** Inject a mock socket for testing */
  socketFactory?: (opts: { authDir: string; logger: unknown }) => Promise<WASocket>;
  now?: () => Date;
};

type ConnectionStatus =
  | "connecting"
  | "qr"
  | "pairing_code"
  | "open"
  | "close"
  | "error";

export class WhatsAppAdapter implements ChannelAdapter {
  kind = "whatsapp" as const;
  running = false;
  connectionStatus: ConnectionStatus = "close";
  qrCode?: string;
  pairingCode?: string;
  lastError?: string;

  private socket?: WASocket;
  private handler?: (message: ChannelMessage) => Promise<void>;
  private options: WhatsAppAdapterOptions;
  private seenMessageIds = new Set<string>();

  constructor(options: WhatsAppAdapterOptions = {}) {
    this.options = options;
  }

  async start(handler: (message: ChannelMessage) => Promise<void>): Promise<void> {
    if (this.running) return;
    this.handler = handler;
    this.running = true;
    this.connectionStatus = "connecting";
    await this.connect();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.connectionStatus = "close";
    if (this.socket) {
      this.socket.end(undefined as unknown as Error);
      this.socket = undefined;
    }
  }

  get delivery() {
    return {
      sendText: async (sessionKey: ChannelSessionKey, text: string, options?: ChannelTextOptions) => {
        if (!this.socket || this.connectionStatus !== "open") {
          throw new Error("WhatsApp not connected");
        }
        const jid = sessionKey.chatId;
        const chunks = chunkWhatsAppText(text, this.options.maxTextLength ?? 4096);
        for (const chunk of chunks) {
          const formatted = options?.format === "html" ? stripHtmlTags(chunk) : chunk;
          await this.socket.sendMessage(jid, { text: markdownToWhatsApp(formatted) });
        }
      },
      sendProgress: async (sessionKey: ChannelSessionKey, event: RuntimeEvent) => {
        if (!this.socket || this.connectionStatus !== "open") return;
        const rendered = renderChannelProgressLabel(event);
        if (rendered.length > 0) {
          await this.socket.sendMessage(sessionKey.chatId, { text: rendered });
        }
      },
      sendArtifact: async (sessionKey: ChannelSessionKey, artifact: ArtifactRecord) => {
        if (!this.socket || this.connectionStatus !== "open") return;
        const caption = renderArtifactNotice(artifact);
        if (artifact.path) {
          await this.socket.sendMessage(sessionKey.chatId, {
            document: { url: artifact.path },
            mimetype: artifact.mimeType ?? "application/octet-stream",
            fileName: basename(artifact.path),
            caption,
          });
        } else {
          await this.socket.sendMessage(sessionKey.chatId, { text: caption });
        }
      },
    };
  }

  private async connect(): Promise<void> {
    const authDir = this.options.authDir ?? join(process.cwd(), ".whatsapp-auth");
    await mkdir(authDir, { recursive: true });

    if (this.options.socketFactory) {
      this.socket = await this.options.socketFactory({ authDir, logger: this.options.logger });
    } else {
      const { state, saveCreds } = await useMultiFileAuthState(authDir);
      this.socket = makeWASocket({
        auth: state,
        logger: this.options.logger as any,
        printQRInTerminal: this.options.pairingMode !== "code",
      });
      this.socket.ev.on("creds.update", saveCreds);
    }

    if (this.socket && !this.options.socketFactory && this.options.pairingMode === "code" && this.options.pairingCodePhoneNumber) {
      // Wait a tick for the socket to initialize before requesting pairing code
      setTimeout(async () => {
        try {
          const code = await this.socket!.requestPairingCode!(this.options.pairingCodePhoneNumber!);
          this.pairingCode = code;
          this.connectionStatus = "pairing_code";
        } catch (err) {
          this.lastError = `Pairing code failed: ${(err as Error).message}`;
          this.connectionStatus = "error";
        }
      }, 500);
    }

    this.socket.ev.on("connection.update", (update: Partial<BaileysEventMap["connection.update"]>) => {
      this.handleConnectionUpdate(update);
    });

    this.socket.ev.on("messages.upsert", (upsert: BaileysEventMap["messages.upsert"]) => {
      this.handleMessagesUpsert(upsert);
    });
  }

  private handleConnectionUpdate(update: Partial<BaileysEventMap["connection.update"]> & { qr?: string }): void {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      this.qrCode = qr;
      this.connectionStatus = "qr";
    }

    if (connection === "open") {
      this.connectionStatus = "open";
      this.lastError = undefined;
    } else if (connection === "close") {
      const shouldReconnect =
        (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
      this.connectionStatus = shouldReconnect ? "connecting" : "close";
      if (!shouldReconnect) {
        this.lastError = "Logged out";
      }
    }
  }

  private async handleMessagesUpsert(upsert: BaileysEventMap["messages.upsert"]): Promise<void> {
    if (upsert.type !== "notify") return;
    if (!this.handler) return;

    for (const msg of upsert.messages) {
      if (this.seenMessageIds.has(msg.key.id ?? "")) continue;
      this.seenMessageIds.add(msg.key.id ?? "");

      const fromJid = msg.key.remoteJid;
      if (!fromJid) continue;

      // Only handle DMs (no group messages in MVP)
      if (fromJid.endsWith("@g.us")) continue;

      const senderId = fromJid.replace(/@s\.whatsapp\.net$/, "").replace(/@lid$/, "");

      // Allowed user filter
      if (this.options.allowedUsers && this.options.allowedUsers.length > 0) {
        const allowed = this.options.allowedUsers.some((u) => {
          const normalized = u.replace(/@s\.whatsapp\.net$/, "").replace(/@lid$/, "");
          return normalized === senderId;
        });
        if (!allowed) continue;
      }

      // Skip messages from self
      if (msg.key.fromMe) continue;

      const text = extractTextFromMessage(msg);
      const attachments: ChannelAttachment[] = [];

      // Download media if present
      const mediaRoot = this.options.mediaRoot;
      if (mediaRoot && hasMedia(msg)) {
        try {
          const stream = await downloadMediaMessage(msg, "buffer", {}, this.options.logger as any);
          if (stream && Buffer.isBuffer(stream)) {
            const ext = guessExtensionFromMessage(msg);
            const fileName = `${randomUUID()}${ext}`;
            const localPath = join(mediaRoot, fileName);
            await mkdir(dirname(localPath), { recursive: true });
            await writeFile(localPath, stream);
            attachments.push({
              id: randomUUID(),
              kind: mediaKindFromMessage(msg),
              status: "ready",
              mimeType: guessMimeFromMessage(msg),
              originalName: fileName,
              localPath,
              bytes: stream.length,
            });
          }
        } catch (err) {
          attachments.push({
            id: randomUUID(),
            kind: "unknown" as ChannelAttachmentKind,
            status: "download-failed",
            failureCode: "whatsapp_media_download_failed",
            failureMessage: (err as Error).message,
          });
        }
      }

      const channelMessage: ChannelMessage = {
        id: msg.key.id ?? randomUUID(),
        channel: "whatsapp",
        sessionKey: {
          platform: "whatsapp",
          chatId: fromJid,
          chatType: "dm",
          userId: senderId,
        },
        text: text ?? "",
        sender: {
          id: senderId,
          displayName: msg.pushName ?? senderId,
        },
        attachments: attachments.length > 0 ? attachments : undefined,
        receivedAt: this.options.now?.().toISOString() ?? new Date().toISOString(),
        metadata: {
          timestamp: msg.messageTimestamp,
          pushName: msg.pushName,
        },
      };

      try {
        await this.handler(channelMessage);
      } catch (err) {
        // Swallow handler errors to keep the socket alive
      }
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function extractTextFromMessage(msg: any): string | undefined {
  const m = msg.message;
  if (!m) return undefined;
  return (
    m.conversation ??
    m.extendedTextMessage?.text ??
    m.imageMessage?.caption ??
    m.videoMessage?.caption ??
    m.documentMessage?.caption ??
    undefined
  );
}

function hasMedia(msg: any): boolean {
  const m = msg.message;
  if (!m) return false;
  return !!(m.imageMessage || m.videoMessage || m.audioMessage || m.documentMessage || m.stickerMessage);
}

function mediaKindFromMessage(msg: any): ChannelAttachmentKind {
  const m = msg.message;
  if (!m) return "unknown";
  if (m.imageMessage) return "image";
  if (m.videoMessage) return "video";
  if (m.audioMessage) return m.audioMessage.ptt ? "voice" : "audio";
  if (m.documentMessage) return "document";
  if (m.stickerMessage) return "image";
  return "unknown";
}

function guessExtensionFromMessage(msg: any): string {
  const m = msg.message;
  if (m?.imageMessage) return ".jpg";
  if (m?.videoMessage) return ".mp4";
  if (m?.audioMessage) return m.audioMessage.ptt ? ".ogg" : ".mp3";
  if (m?.documentMessage) {
    const fileName = m.documentMessage.fileName ?? "";
    const ext = extname(fileName);
    return ext || ".bin";
  }
  if (m?.stickerMessage) return ".webp";
  return ".bin";
}

function guessMimeFromMessage(msg: any): string | undefined {
  const m = msg.message;
  if (m?.imageMessage) return m.imageMessage.mimetype ?? "image/jpeg";
  if (m?.videoMessage) return m.videoMessage.mimetype ?? "video/mp4";
  if (m?.audioMessage) return m.audioMessage.mimetype ?? "audio/ogg";
  if (m?.documentMessage) return m.documentMessage.mimetype ?? "application/octet-stream";
  if (m?.stickerMessage) return m.stickerMessage.mimetype ?? "image/webp";
  return undefined;
}

function chunkWhatsAppText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + maxLen, text.length);
    // Try to break at newline
    const nl = text.lastIndexOf("\n", end);
    if (nl > i && nl >= end - 200) {
      end = nl;
    } else {
      // Try to break at space
      const sp = text.lastIndexOf(" ", end);
      if (sp > i && sp >= end - 100) {
        end = sp;
      }
    }
    chunks.push(text.slice(i, end));
    i = end + (text[end] === "\n" || text[end] === " " ? 1 : 0);
  }
  return chunks;
}

function markdownToWhatsApp(text: string): string {
  // WhatsApp supports *bold* and _italic_ natively
  // Convert **text** → *text*
  let out = text.replace(/\*\*(.+?)\*\*/g, "*$1*");
  // Convert __text__ → _text_
  out = out.replace(/__(.+?)__/g, "_$1_");
  // Convert ~~text~~ → ~text~
  out = out.replace(/~~(.+?)~~/g, "~$1~");
  // Convert ```code``` to WhatsApp code block (triple backtick works natively)
  // Inline `code` also works natively
  return out;
}

function stripHtmlTags(text: string): string {
  return text.replace(/<[^>]+>/g, "");
}

function renderArtifactNotice(artifact: ArtifactRecord): string {
  const parts: string[] = [];
  parts.push(`Artifact: ${artifact.id}`);
  if (artifact.path) parts.push(`Path: ${artifact.path}`);
  if (artifact.mimeType) parts.push(`Type: ${artifact.mimeType}`);
  if (artifact.kind) parts.push(`Kind: ${artifact.kind}`);
  return parts.join("\n");
}
