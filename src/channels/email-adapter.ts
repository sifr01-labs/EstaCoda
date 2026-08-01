import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ArtifactRecord } from "../contracts/artifact.js";
import type {
  AdapterCapability,
  ChannelAdapter,
  ChannelAttachment,
  ChannelMessage,
  ChannelSessionKey,
  ChannelTextOptions
} from "../contracts/channel.js";
import type { RuntimeEvent } from "../contracts/runtime-event.js";
import type { EmailChannelConfig } from "../config/runtime-config.js";
import { buildAdapterCapability } from "./adapter-capability.js";
import { renderChannelProgressLabel, type ActivityLabelLocale } from "./activity-labels.js";
import { fileURLToPath } from "node:url";

export type EmailAdapterOptions = {
  imapHost: string;
  imapPort?: number;
  smtpHost: string;
  smtpPort?: number;
  username: string;
  password: string;
  ownAddress: string;
  homeAddress?: string;
  allowedSenders?: string[];
  allowAllUsers?: boolean;
  pollIntervalSeconds?: number;
  mediaRoot?: string;
  activityLabelsLocale?: ActivityLabelLocale;
  workerPath?: string;
  pythonBinary?: string;
  now?: () => Date;
  skipAttachments?: boolean;
  markAllSeenOnConnect?: boolean;
  enabled?: boolean;
  missing?: string[];
};

type EmailWorkerPollResult = {
  ok: boolean;
  messages?: EmailWorkerMessage[];
  error?: string;
};

type EmailWorkerMessage = {
  message_id: string;
  msg_id_header: string;
  from: string;
  to: string;
  cc: string[];
  subject: string;
  body: string;
  body_html?: string;
  date: string;
  in_reply_to: string;
  references: string[];
  attachments: EmailWorkerAttachment[];
};

type EmailWorkerAttachment = {
  filename: string;
  mime_type: string;
  size: number;
  data_b64: string;
};

type EmailWorkerSendResult = {
  ok: boolean;
  message_id?: string;
  error?: string;
};

type EmailWorkerRequest = {
  command: "poll" | "send" | "test";
  args: Record<string, unknown>;
};

export class EmailAdapter implements ChannelAdapter {
  readonly id = "email";
  readonly kind = "email";

  readonly #imapHost: string;
  readonly #imapPort: number;
  readonly #smtpHost: string;
  readonly #smtpPort: number;
  readonly #username: string;
  readonly #password: string;
  readonly #ownAddress: string;
  readonly #homeAddress: string | undefined;
  readonly #allowedSenders: string[];
  readonly #allowAllUsers: boolean;
  readonly #pollIntervalSeconds: number;
  readonly #mediaRoot: string | undefined;
  readonly #activityLabelsLocale: ActivityLabelLocale;
  readonly #workerPath: string;
  readonly #pythonBinary: string;
  readonly #now: () => Date;
  readonly #skipAttachments: boolean;
  readonly #markAllSeenOnConnect: boolean;
  readonly #config: EmailChannelConfig;
  readonly #missing: string[] | undefined;

  #handler: ((message: ChannelMessage) => Promise<void>) | undefined;
  #running = false;
  #pollTimer: ReturnType<typeof setInterval> | undefined;
  #messageIdToThread = new Map<string, string>(); // msg_id_header -> conversationId
  #conversationIdToReferences = new Map<string, string[]>(); // conversationId -> references

  readonly delivery = {
    sendText: async (sessionKey: ChannelSessionKey, text: string, _options?: ChannelTextOptions) => {
      await this.#sendReply(sessionKey, text);
    },
    sendProgress: async (sessionKey: ChannelSessionKey, event: RuntimeEvent) => {
      const rendered = renderChannelProgressLabel(event, this.#activityLabelsLocale);
      if (rendered.length > 0) {
        await this.#sendReply(sessionKey, rendered);
      }
    },
    sendArtifact: async (sessionKey: ChannelSessionKey, artifact: ArtifactRecord) => {
      const notice = renderArtifactNotice(artifact);
      const delivery = await this.#sendReply(sessionKey, notice, [artifact]);
      return delivery.artifactAttachmentCount === 1
        ? { status: "delivered" as const, method: "native-upload" as const }
        : {
            status: "degraded" as const,
            method: "fallback-notice" as const,
            reasonCode: "artifact-content-unavailable"
          };
    }
  };

  constructor(options: EmailAdapterOptions) {
    this.#imapHost = options.imapHost;
    this.#imapPort = options.imapPort ?? 993;
    this.#smtpHost = options.smtpHost;
    this.#smtpPort = options.smtpPort ?? 587;
    this.#username = options.username;
    this.#password = options.password;
    this.#ownAddress = options.ownAddress;
    this.#homeAddress = options.homeAddress;
    this.#allowedSenders = (options.allowedSenders ?? []).map((s) => s.toLowerCase());
    this.#allowAllUsers = options.allowAllUsers ?? false;
    this.#pollIntervalSeconds = options.pollIntervalSeconds ?? 15;
    this.#mediaRoot = options.mediaRoot;
    this.#activityLabelsLocale = options.activityLabelsLocale ?? "en";
    this.#workerPath = options.workerPath ?? defaultWorkerPath();
    this.#pythonBinary = options.pythonBinary ?? "python3";
    this.#now = options.now ?? (() => new Date());
    this.#skipAttachments = options.skipAttachments ?? false;
    this.#markAllSeenOnConnect = options.markAllSeenOnConnect ?? false;
    this.#missing = options.missing;
    this.#config = {
      enabled: options.enabled ?? true,
      imapHost: options.imapHost,
      imapPort: options.imapPort,
      smtpHost: options.smtpHost,
      smtpPort: options.smtpPort,
      username: options.username,
      ownAddress: options.ownAddress,
      homeAddress: options.homeAddress,
      allowedSenders: options.allowedSenders,
      allowAllUsers: options.allowAllUsers,
      pollIntervalSeconds: options.pollIntervalSeconds,
    };
  }

  getCapabilities(): AdapterCapability {
    return buildAdapterCapability({ kind: "email", config: this.#config, missing: this.#missing });
  }

  async start(handler: (message: ChannelMessage) => Promise<void>): Promise<void> {
    this.#handler = handler;
    this.#running = true;
    if (this.#markAllSeenOnConnect) {
      try {
        await this.#runWorker<EmailWorkerPollResult>({
          command: "poll",
          args: {
            imap_host: this.#imapHost,
            imap_port: this.#imapPort,
            username: this.#username,
            password: this.#password,
            allowed_senders: this.#allowedSenders,
            own_address: this.#ownAddress,
            mark_seen: true,
            skip_attachments: true,
            mark_all_seen_only: true
          }
        });
      } catch {
        // ignore
      }
    }
    this.#pollTimer = setInterval(async () => {
      try {
        await this.pollOnce();
      } catch {
        // Poll errors are silent; they will be retried
      }
    }, this.#pollIntervalSeconds * 1000);
  }

  async stop(): Promise<void> {
    this.#running = false;
    if (this.#pollTimer !== undefined) {
      clearInterval(this.#pollTimer);
      this.#pollTimer = undefined;
    }
  }

  get running(): boolean {
    return this.#running;
  }

  async pollOnce(): Promise<number> {
    if (this.#handler === undefined) {
      throw new Error("EmailAdapter must be started before polling");
    }

    const result = await this.#runWorker<EmailWorkerPollResult>({
      command: "poll",
      args: {
        imap_host: this.#imapHost,
        imap_port: this.#imapPort,
        username: this.#username,
        password: this.#password,
        allowed_senders: this.#allowedSenders,
        own_address: this.#ownAddress,
        allow_all_users: this.#allowAllUsers,
        mark_seen: true,
        skip_attachments: this.#skipAttachments
      }
    });

    if (!result.ok || result.messages === undefined) {
      return 0;
    }

    let count = 0;
    for (const email of result.messages) {
      const message = await this.#emailToChannelMessage(email);
      if (message !== undefined) {
        await this.#handler(message);
        count += 1;
      }
    }
    return count;
  }

  async testConnectivity(): Promise<{ imap: boolean; smtp: boolean; error?: string }> {
    const result = await this.#runWorker<{
      ok: boolean;
      imap: boolean;
      smtp: boolean;
      error?: string;
      imap_error?: string;
      smtp_error?: string;
    }>({
      command: "test",
      args: {
        imap_host: this.#imapHost,
        imap_port: this.#imapPort,
        smtp_host: this.#smtpHost,
        smtp_port: this.#smtpPort,
        username: this.#username,
        password: this.#password
      }
    });

    return {
      imap: result.imap ?? false,
      smtp: result.smtp ?? false,
      error: result.error ?? result.imap_error ?? result.smtp_error
    };
  }

  async #sendReply(
    sessionKey: ChannelSessionKey,
    text: string,
    artifacts?: ArtifactRecord[]
  ): Promise<{ artifactAttachmentCount: number }> {
    const conversationId = sessionKey.chatId;
    const toAddr = conversationId.split("::")[0] ?? conversationId;

    const references = this.#conversationIdToReferences.get(conversationId) ?? [];
    const inReplyTo = references.length > 0 ? references[references.length - 1] : undefined;

    // Check if text contains MEDIA: references for attachments
    const mediaPaths = extractMediaPaths(text);
    const attachments: Array<{
      filename: string;
      mime_type: string;
      data_b64: string;
    }> = [];
    let artifactAttachmentCount = 0;

    for (const mediaPath of mediaPaths) {
      try {
        const { readFile } = await import("node:fs/promises");
        const { basename } = await import("node:path");
        const data = await readFile(mediaPath);
        const mimeType = guessMimeType(mediaPath);
        attachments.push({
          filename: basename(mediaPath),
          mime_type: mimeType,
          data_b64: Buffer.from(data).toString("base64")
        });
      } catch {
        // Skip unreadable media
      }
    }

    // Also attach artifact files if provided
    for (const artifact of artifacts ?? []) {
      const localPath = artifact.localPath ?? artifact.path;
      if (localPath === undefined) continue;
      try {
        const { readFile } = await import("node:fs/promises");
        const { basename } = await import("node:path");
        const data = await readFile(localPath);
        attachments.push({
          filename: basename(localPath),
          mime_type: artifact.mimeType ?? guessMimeType(localPath),
          data_b64: Buffer.from(data).toString("base64")
        });
        artifactAttachmentCount++;
      } catch {
        // Skip unreadable artifact
      }
    }

    const result = await this.#runWorker<EmailWorkerSendResult>({
      command: "send",
      args: {
        smtp_host: this.#smtpHost,
        smtp_port: this.#smtpPort,
        username: this.#username,
        password: this.#password,
        from: this.#ownAddress,
        to: [toAddr],
        subject: `Re: ${sessionKey.threadId ?? ""}`,
        body: stripMediaMarkers(text),
        in_reply_to: inReplyTo,
        references: references.length > 0 ? references : undefined,
        attachments: attachments.length > 0 ? attachments : undefined
      }
    });

    if (!result.ok) {
      throw new Error(result.error ?? "Email delivery failed");
    }

    if (result.message_id) {
      const updatedRefs = [...references, result.message_id];
      this.#conversationIdToReferences.set(conversationId, updatedRefs);
    }
    return { artifactAttachmentCount };
  }

  async #emailToChannelMessage(email: EmailWorkerMessage): Promise<ChannelMessage | undefined> {
    const senderEmail = email.from;
    const subject = email.subject;

    // Self-message filter
    if (senderEmail.toLowerCase() === this.#ownAddress.toLowerCase()) {
      return undefined;
    }

    // Automated-sender filter
    const automatedHeaders = ["auto-submitted", "x-autoreply", "precedence"];
    const isAutomated = automatedHeaders.some((h) =>
      (email as unknown as Record<string, string>)[h] !== undefined
    );
    if (isAutomated) {
      return undefined;
    }

    const isReply = subject.toLowerCase().startsWith("re:");
    const cleanSubject = isReply ? subject.slice(3).trim() : subject;

    // Determine conversation ID
    let conversationId: string;
    if (email.in_reply_to && this.#messageIdToThread.has(email.in_reply_to)) {
      conversationId = this.#messageIdToThread.get(email.in_reply_to)!;
    } else if (email.references.length > 0) {
      const parentRef = email.references.find((ref) => this.#messageIdToThread.has(ref));
      if (parentRef) {
        conversationId = this.#messageIdToThread.get(parentRef)!;
      } else {
        conversationId = `${senderEmail}::${cleanSubject}`;
      }
    } else {
      conversationId = `${senderEmail}::${cleanSubject}`;
    }

    // Track message ID for threading
    if (email.msg_id_header) {
      this.#messageIdToThread.set(email.msg_id_header, conversationId);
    }

    // Track references for reply threading
    const refs = this.#conversationIdToReferences.get(conversationId) ?? [];
    if (email.msg_id_header && !refs.includes(email.msg_id_header)) {
      refs.push(email.msg_id_header);
    }
    if (email.references.length > 0) {
      for (const ref of email.references) {
        if (!refs.includes(ref)) {
          refs.push(ref);
        }
      }
    }
    this.#conversationIdToReferences.set(conversationId, refs);

    const attachments: ChannelAttachment[] = [];
    for (const att of email.attachments) {
      const attachment = await this.#saveAttachment(att, conversationId, email.message_id);
      if (attachment !== undefined) {
        attachments.push(attachment);
      }
    }

    const sessionKey: ChannelSessionKey = {
      platform: "email",
      chatId: conversationId,
      userId: senderEmail,
      chatType: "dm",
      threadId: cleanSubject
    };

    return {
      id: `email-${email.message_id}`,
      channel: "email",
      sessionKey,
      text: formatEmailBody(email, isReply),
      sender: {
        id: senderEmail,
        displayName: senderEmail
      },
      attachments,
      receivedAt: this.#now().toISOString(),
      metadata: {
        emailMessageId: email.msg_id_header,
        emailDate: email.date,
        emailSubject: subject,
        emailReferences: email.references,
        emailInReplyTo: email.in_reply_to
      }
    };
  }

  async #saveAttachment(
    att: EmailWorkerAttachment,
    conversationId: string,
    messageId: string
  ): Promise<ChannelAttachment | undefined> {
    if (this.#mediaRoot === undefined) {
      return {
        id: randomUUID(),
        kind: classifyAttachmentKind(att.mime_type, att.filename),
        status: "ready",
        mimeType: att.mime_type,
        originalName: att.filename,
        name: att.filename,
        bytes: att.size,
        metadata: {
          emailDataB64: att.data_b64
        }
      };
    }

    try {
      const dir = join(this.#mediaRoot, "email", sanitizePathPart(conversationId));
      await mkdir(dir, { recursive: true });
      const localPath = join(dir, `${sanitizePathPart(messageId)}-${sanitizePathPart(att.filename)}`);
      const data = Buffer.from(att.data_b64, "base64");
      await writeFile(localPath, data);

      return {
        id: randomUUID(),
        kind: classifyAttachmentKind(att.mime_type, att.filename),
        status: "ready",
        mimeType: att.mime_type,
        originalName: att.filename,
        name: att.filename,
        bytes: att.size,
        localPath,
        path: localPath,
        metadata: {
          downloadedAt: this.#now().toISOString()
        }
      };
    } catch {
      return {
        id: randomUUID(),
        kind: classifyAttachmentKind(att.mime_type, att.filename),
        status: "download-failed",
        failureCode: "attachment-download-failed",
        failureMessage: "Failed to save email attachment to disk",
        mimeType: att.mime_type,
        originalName: att.filename,
        name: att.filename,
        bytes: att.size
      };
    }
  }

  async #runWorker<T>(request: EmailWorkerRequest): Promise<T> {
    const { spawn } = await import("node:child_process");

    return new Promise<T>((resolve, reject) => {
      const child = spawn(this.#pythonBinary, ["-u", this.#workerPath], {
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
        stdio: ["pipe", "pipe", "pipe"]
      });

      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Email worker timed out after 30s"));
      }, 30_000);

      let stdout = "";
      let stderr = "";

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });

      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(new Error(`Failed to start email worker: ${error.message}`));
      });

      child.on("close", () => {
        clearTimeout(timeout);
        try {
          const parsed = JSON.parse(stdout) as T;
          resolve(parsed);
        } catch {
          reject(new Error(`Invalid email worker response: ${stderr || stdout}`));
        }
      });

      child.stdin.end(`${JSON.stringify(request)}\n`);
    });
  }
}

function defaultWorkerPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "../../workers/email/email_worker.py");
}

function sanitizePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 64);
}

function classifyAttachmentKind(mimeType: string, filename: string): ChannelAttachment["kind"] {
  const type = mimeType.toLowerCase();
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("text/")) return "document";
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md", "csv", "json", "yaml", "yml", "zip", "tar", "gz"].includes(ext)) {
    return "document";
  }
  return "file";
}

function formatEmailBody(email: EmailWorkerMessage, isReply: boolean): string {
  const lines: string[] = [];
  if (!isReply && email.subject) {
    lines.push(`[Subject: ${email.subject}]`);
  }
  if (email.body_html !== undefined && email.body_html.length > 0) {
    lines.push(email.body);
    lines.push("");
    lines.push("[HTML version available but not displayed]");
  } else {
    lines.push(email.body);
  }
  return lines.join("\n");
}

function renderArtifactNotice(artifact: ArtifactRecord): string {
  const parts: string[] = [];
  parts.push(`Artifact: ${artifact.id}`);
  if (artifact.path) {
    parts.push(`Path: ${artifact.path}`);
  }
  return parts.join("\n");
}

function extractMediaPaths(text: string): string[] {
  const paths: string[] = [];
  const regex = /MEDIA:([\S]+)/gu;
  let match;
  while ((match = regex.exec(text)) !== null) {
    paths.push(match[1]!);
  }
  return paths;
}

function stripMediaMarkers(text: string): string {
  return text.replace(/MEDIA:[\S]+/gu, "").trim();
}

function guessMimeType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    mp4: "video/mp4",
    mp3: "audio/mpeg",
    ogg: "audio/ogg",
    wav: "audio/wav",
    pdf: "application/pdf",
    txt: "text/plain",
    md: "text/markdown",
    json: "application/json",
    csv: "text/csv",
    zip: "application/zip"
  };
  return map[ext] ?? "application/octet-stream";
}
