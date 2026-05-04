import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { ChannelSessionKey } from "../contracts/channel.js";
import type { ChannelSessionStore } from "./channel-gateway.js";
import type { SurfacePointerStore } from "./surface-pointer-store.js";
import type { SurfaceType } from "./surface-pointer.js";

export type ChannelSessionPolicy = {
  groupSessionsPerUser?: boolean;
  threadSessionsPerUser?: boolean;
  resetPolicy?: "none" | "idle" | "daily" | "both";
  idleResetMinutes?: number;
  timeZone?: string;
};

type ChannelSessionFile = {
  version: 1;
  entries: ChannelSessionEntry[];
};

type ChannelSessionEntry = {
  key: string;
  sessionId: string;
  platform: string;
  accountId?: string;
  chatId: string;
  threadId?: string;
  userId?: string;
  updatedAt: string;
};

export function shouldAutoResetSession(
  updatedAtIso: string,
  receivedAt: Date,
  policy: ChannelSessionPolicy
): boolean {
  const mode = policy.resetPolicy ?? "none";
  if (mode === "none") {
    return false;
  }

  const updatedAt = parseTimestamp(updatedAtIso);
  if (updatedAt === undefined) {
    return false;
  }

  const idleResetMinutes = policy.idleResetMinutes ?? 240;
  const idleExpired = (mode === "idle" || mode === "both")
    && receivedAt.getTime() - updatedAt.getTime() > idleResetMinutes * 60 * 1000;
  const crossedDay = (mode === "daily" || mode === "both")
    && localDayKey(receivedAt, policy.timeZone) !== localDayKey(updatedAt, policy.timeZone);

  return idleExpired || crossedDay;
}

export class PersistentChannelSessionStore implements ChannelSessionStore {
  readonly #path: string;
  readonly #entries = new Map<string, ChannelSessionEntry>();
  readonly #policy: ChannelSessionPolicy;
  readonly #surfacePointerStore?: SurfacePointerStore;
  #sequence = 0;
  #loaded = false;

  constructor(options: { path?: string; policy?: ChannelSessionPolicy; surfacePointerStore?: SurfacePointerStore } = {}) {
    this.#path = options.path ?? join(homedir(), ".estacoda", "channel-sessions.json");
    this.#policy = options.policy ?? {};
    this.#surfacePointerStore = options.surfacePointerStore;
  }

  get path(): string {
    return this.#path;
  }

  async getOrCreateSessionId(sessionKey: ChannelSessionKey, options?: { receivedAt?: string }): Promise<string> {
    await this.#ensureLoaded();
    const key = stableSessionKey(sessionKey, this.#policy);

    // Check surface pointer first. If a surface is explicitly attached to a
    // session, that takes precedence over the channel-local session mapping.
    if (this.#surfacePointerStore !== undefined) {
      const surfaceType = sessionKey.platform as SurfaceType;
      const surfaceId = sessionKey.chatId;
      const pointer = await this.#surfacePointerStore.getPointer(surfaceType, surfaceId);
      if (pointer !== undefined) {
        return pointer.sessionId;
      }
    }

    const existing = this.#entries.get(key);

    if (existing !== undefined) {
      const receivedAt = parseTimestamp(options?.receivedAt) ?? new Date();
      if (shouldAutoResetSession(existing.updatedAt, receivedAt, this.#policy)) {
        const sessionId = this.#newSessionId(sessionKey);
        this.#entries.set(key, createEntry(key, normalizeSessionKey(sessionKey, this.#policy), sessionId, receivedAt));
        await this.#flush();
        return sessionId;
      }

      existing.updatedAt = receivedAt.toISOString();
      this.#entries.set(key, existing);
      await this.#flush();
      return existing.sessionId;
    }

    const sessionId = buildBaseSessionId(sessionKey, this.#policy);
    this.#entries.set(
      key,
      createEntry(key, normalizeSessionKey(sessionKey, this.#policy), sessionId, parseTimestamp(options?.receivedAt) ?? new Date())
    );
    await this.#flush();
    return sessionId;
  }

  async resetSessionId(sessionKey: ChannelSessionKey, options?: { receivedAt?: string }): Promise<string> {
    await this.#ensureLoaded();
    const key = stableSessionKey(sessionKey, this.#policy);
    const sessionId = this.#newSessionId(sessionKey);
    this.#entries.set(
      key,
      createEntry(key, normalizeSessionKey(sessionKey, this.#policy), sessionId, parseTimestamp(options?.receivedAt) ?? new Date())
    );
    await this.#flush();
    return sessionId;
  }

  async setSessionId(sessionKey: ChannelSessionKey, sessionId: string, options?: { receivedAt?: string }): Promise<void> {
    await this.#ensureLoaded();
    const key = stableSessionKey(sessionKey, this.#policy);
    const receivedAt = parseTimestamp(options?.receivedAt) ?? new Date();
    this.#entries.set(
      key,
      createEntry(key, normalizeSessionKey(sessionKey, this.#policy), sessionId, receivedAt)
    );
    await this.#flush();
  }

  #newSessionId(sessionKey: ChannelSessionKey): string {
    this.#sequence += 1;
    return `${buildBaseSessionId(sessionKey, this.#policy)}-${this.#sequence}`;
  }

  async #ensureLoaded(): Promise<void> {
    if (this.#loaded) {
      return;
    }

    this.#loaded = true;

    try {
      const parsed = JSON.parse(await readFile(this.#path, "utf8")) as Partial<ChannelSessionFile>;
      const entries = Array.isArray(parsed.entries) ? parsed.entries : [];

      for (const entry of entries) {
        if (typeof entry.key !== "string" || typeof entry.sessionId !== "string") {
          continue;
        }

        this.#entries.set(entry.key, {
          key: entry.key,
          sessionId: entry.sessionId,
          platform: entry.platform,
          accountId: entry.accountId,
          chatId: entry.chatId,
          threadId: entry.threadId,
          userId: entry.userId,
          updatedAt: entry.updatedAt
        });
        this.#sequence = Math.max(this.#sequence, suffixSequence(entry.sessionId));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  async #flush(): Promise<void> {
    const file: ChannelSessionFile = {
      version: 1,
      entries: [...this.#entries.values()].sort((left, right) => left.key.localeCompare(right.key))
    };

    await mkdir(dirname(this.#path), { recursive: true });
    await writeFile(this.#path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
  }
}

function createEntry(key: string, sessionKey: ChannelSessionKey, sessionId: string, updatedAt: Date): ChannelSessionEntry {
  return {
    key,
    sessionId,
    platform: sessionKey.platform,
    accountId: sessionKey.accountId,
    chatId: sessionKey.chatId,
    threadId: sessionKey.threadId,
    userId: sessionKey.userId,
    updatedAt: updatedAt.toISOString()
  };
}

function suffixSequence(sessionId: string): number {
  const match = sessionId.match(/-(\d+)$/u);
  return match === null ? 0 : Number.parseInt(match[1] ?? "0", 10);
}

export function stableSessionKey(sessionKey: ChannelSessionKey, policy: ChannelSessionPolicy = {}): string {
  const normalized = normalizeSessionKey(sessionKey, policy);
  return [
    normalized.platform,
    normalized.accountId ?? "",
    normalized.chatType ?? "",
    normalized.chatId,
    normalized.threadId ?? "",
    normalized.userId ?? ""
  ].join(":");
}

export function sanitizeSessionPart(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return sanitized.length > 0 ? sanitized.slice(0, 64) : "default";
}

export function buildBaseSessionId(sessionKey: ChannelSessionKey, policy: ChannelSessionPolicy = {}): string {
  const normalized = normalizeSessionKey(sessionKey, policy);
  const parts = [
    "channel",
    sanitizeSessionPart(normalized.platform),
    sanitizeSessionPart(normalized.accountId ?? "default"),
    sanitizeSessionPart(normalized.chatType ?? "main"),
    sanitizeSessionPart(normalized.chatId),
    sanitizeSessionPart(normalized.threadId ?? "main")
  ];

  if (normalized.userId !== undefined) {
    parts.push(sanitizeSessionPart(normalized.userId));
  }

  return parts.join("-");
}

export function normalizeSessionKey(sessionKey: ChannelSessionKey, policy: ChannelSessionPolicy = {}): ChannelSessionKey {
  const chatType = normalizeChatType(sessionKey);
  const threadId = chatType === "thread" ? sessionKey.threadId : undefined;
  const isPerUser = shouldIsolatePerUser({
    chatType,
    userId: sessionKey.userId,
    policy
  });

  return {
    platform: sessionKey.platform,
    accountId: sessionKey.accountId,
    chatId: sessionKey.chatId,
    chatType,
    threadId,
    userId: isPerUser ? sessionKey.userId : undefined
  };
}

function normalizeChatType(sessionKey: ChannelSessionKey): "dm" | "group" | "channel" | "thread" {
  if (sessionKey.threadId !== undefined && sessionKey.threadId.length > 0) {
    return "thread";
  }

  if (sessionKey.chatType === "dm" || sessionKey.chatType === "group" || sessionKey.chatType === "channel" || sessionKey.chatType === "thread") {
    return sessionKey.chatType;
  }

  return "dm";
}

function shouldIsolatePerUser(input: {
  chatType: "dm" | "group" | "channel" | "thread";
  userId?: string;
  policy: ChannelSessionPolicy;
}): boolean {
  if (input.userId === undefined || input.userId.length === 0) {
    return false;
  }

  if (input.chatType === "dm" || input.chatType === "channel") {
    return false;
  }

  if (input.chatType === "thread") {
    return input.policy.threadSessionsPerUser ?? false;
  }

  return input.policy.groupSessionsPerUser ?? true;
}

function parseTimestamp(value: string | undefined): Date | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function localDayKey(value: Date, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(value);
}
