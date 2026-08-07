import { createHash } from "node:crypto";
import { normalizeProfileId } from "../config/profile-home.js";
import type { ChannelSessionKey } from "../contracts/channel.js";
import type { SQLiteDatabase } from "../storage/sqlite.js";

const MAX_IDENTIFIER_CHARS = 512;
const MAX_MESSAGE_IDS_PER_WRITE = 256;
export const CHANNEL_MESSAGE_TURN_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
export const MAX_CHANNEL_MESSAGE_TURN_BINDINGS = 10_000;

export type ChannelMessageTurnDirection = "inbound" | "outbound";

export type ChannelMessageTurnBinding = {
  sessionId: string;
  turnId: string;
  direction: ChannelMessageTurnDirection;
  createdAt: string;
  expiresAt: string;
};

export type ChannelMessageTurnPruneResult = {
  expired: number;
  excess: number;
};

export type ChannelMessageTurnStore = {
  record(input: {
    sessionKey: ChannelSessionKey;
    platformMessageIds: readonly string[];
    direction: ChannelMessageTurnDirection;
    sessionId: string;
    turnId: string;
  }): void | Promise<void>;
  resolve(input: {
    sessionKey: ChannelSessionKey;
    platformMessageId: string;
  }): ChannelMessageTurnBinding | undefined | Promise<ChannelMessageTurnBinding | undefined>;
  prune(): ChannelMessageTurnPruneResult | Promise<ChannelMessageTurnPruneResult>;
};

type BindingRow = {
  session_id: string;
  turn_id: string;
  direction: string;
  created_at: string;
  expires_at: string;
};

/** Profile-scoped, bounded attribution from a hashed channel surface to its visible turn. */
export class SQLiteChannelMessageTurnStore implements ChannelMessageTurnStore {
  readonly #db: SQLiteDatabase;
  readonly #profileId: string;
  readonly #now: () => Date;
  readonly #retentionMs: number;
  readonly #maxBindings: number;

  constructor(options: {
    db: SQLiteDatabase;
    profileId: string;
    now?: () => Date;
    retentionMs?: number;
    maxBindings?: number;
  }) {
    this.#db = options.db;
    this.#profileId = normalizeProfileId(options.profileId);
    this.#now = options.now ?? (() => new Date());
    this.#retentionMs = positiveInteger(options.retentionMs ?? CHANNEL_MESSAGE_TURN_RETENTION_MS, "retentionMs");
    this.#maxBindings = positiveInteger(options.maxBindings ?? MAX_CHANNEL_MESSAGE_TURN_BINDINGS, "maxBindings");
  }

  record(input: {
    sessionKey: ChannelSessionKey;
    platformMessageIds: readonly string[];
    direction: ChannelMessageTurnDirection;
    sessionId: string;
    turnId: string;
  }): void {
    const channel = identifier(input.sessionKey.platform, "channel", 64);
    const surfaceScopeHash = channelSurfaceScopeHash(input.sessionKey);
    const direction = bindingDirection(input.direction);
    const sessionId = identifier(input.sessionId, "sessionId");
    const turnId = identifier(input.turnId, "turnId");
    const messageIds = [...new Set(input.platformMessageIds.map((value) => identifier(value, "platformMessageId")))]
      .slice(0, MAX_MESSAGE_IDS_PER_WRITE);
    if (messageIds.length === 0) return;

    const session = this.#db.query<{ profile_id: string }>(
      "select profile_id from sessions where id = ?"
    ).get(sessionId);
    const turn = this.#db.query<{ profile_id: string; role: string; session_id: string }>(`
      select sessions.profile_id as profile_id, messages.role as role, messages.session_id as session_id
      from messages
      join sessions on sessions.id = messages.session_id
      where messages.id = ?
    `).get(turnId);
    if (
      session?.profile_id !== this.#profileId ||
      turn?.profile_id !== this.#profileId ||
      turn.role !== "user" ||
      turn.session_id !== sessionId
    ) {
      throw new Error("Channel message attribution target is invalid.");
    }

    const existingQuery = this.#db.query<BindingRow>(`
      select session_id, turn_id, direction, created_at, expires_at
      from channel_message_turn_bindings
      where profile_id = ? and surface_scope_hash = ? and platform_message_id = ?
    `);
    const insert = this.#db.query(`
      insert into channel_message_turn_bindings (
        profile_id, channel, surface_scope_hash, platform_message_id, direction,
        session_id, turn_id, created_at, expires_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const now = validDate(this.#now(), "now");
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.#retentionMs).toISOString();
    this.#db.exec("begin immediate");
    try {
      this.#pruneWithinTransaction(createdAt);
      for (const platformMessageId of messageIds) {
        const existing = existingQuery.get(this.#profileId, surfaceScopeHash, platformMessageId);
        if (existing !== null) {
          if (
            existing.session_id !== sessionId ||
            existing.turn_id !== turnId ||
            existing.direction !== direction
          ) {
            throw new Error("Channel message attribution is immutable.");
          }
          continue;
        }
        insert.run(
          this.#profileId,
          channel,
          surfaceScopeHash,
          platformMessageId,
          direction,
          sessionId,
          turnId,
          createdAt,
          expiresAt
        );
      }
      this.#pruneExcessWithinTransaction();
      this.#db.exec("commit");
    } catch (error) {
      try {
        this.#db.exec("rollback");
      } catch {
        // Preserve the original binding failure.
      }
      throw error;
    }
  }

  resolve(input: {
    sessionKey: ChannelSessionKey;
    platformMessageId: string;
  }): ChannelMessageTurnBinding | undefined {
    const surfaceScopeHash = channelSurfaceScopeHash(input.sessionKey);
    const platformMessageId = identifier(input.platformMessageId, "platformMessageId");
    const now = validDate(this.#now(), "now");
    const row = this.#db.query<BindingRow>(`
      select session_id, turn_id, direction, created_at, expires_at
      from channel_message_turn_bindings
      where profile_id = ? and surface_scope_hash = ? and platform_message_id = ? and expires_at > ?
    `).get(this.#profileId, surfaceScopeHash, platformMessageId, now.toISOString());
    if (row === null || !validStoredDate(row.created_at) || !validStoredDate(row.expires_at)) return undefined;
    const direction = optionalBindingDirection(row.direction);
    return direction === undefined ? undefined : {
      sessionId: row.session_id,
      turnId: row.turn_id,
      direction,
      createdAt: row.created_at,
      expiresAt: row.expires_at
    };
  }

  prune(): ChannelMessageTurnPruneResult {
    const now = validDate(this.#now(), "now").toISOString();
    this.#db.exec("begin immediate");
    try {
      const expired = this.#pruneWithinTransaction(now);
      const excess = this.#pruneExcessWithinTransaction();
      this.#db.exec("commit");
      return { expired, excess };
    } catch (error) {
      try {
        this.#db.exec("rollback");
      } catch {
        // Preserve the original pruning failure.
      }
      throw error;
    }
  }

  #pruneWithinTransaction(now: string): number {
    const result = this.#db.query(`
      delete from channel_message_turn_bindings
      where profile_id = ? and expires_at <= ?
    `).run(this.#profileId, now);
    return Number(result.changes);
  }

  #pruneExcessWithinTransaction(): number {
    const count = this.#db.query<{ count: number }>(`
      select count(*) as count from channel_message_turn_bindings where profile_id = ?
    `).get(this.#profileId)?.count ?? 0;
    const excess = Math.max(0, count - this.#maxBindings);
    if (excess === 0) return 0;
    const result = this.#db.query(`
      delete from channel_message_turn_bindings
      where rowid in (
        select rowid from channel_message_turn_bindings
        where profile_id = ?
        order by created_at asc, surface_scope_hash asc, platform_message_id asc
        limit ?
      )
    `).run(this.#profileId, excess);
    return Number(result.changes);
  }
}

export function channelSurfaceScopeHash(sessionKey: ChannelSessionKey): string {
  const normalized = [
    identifier(sessionKey.platform, "channel", 64),
    optionalIdentifier(sessionKey.accountId, "accountId"),
    optionalIdentifier(sessionKey.chatType, "chatType", 64),
    identifier(sessionKey.chatId, "chatId"),
    optionalIdentifier(sessionKey.threadId, "threadId"),
    optionalIdentifier(sessionKey.userId, "userId")
  ];
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function optionalIdentifier(value: string | undefined, label: string, max = MAX_IDENTIFIER_CHARS): string {
  return value === undefined ? "" : identifier(value, label, max);
}

function identifier(value: string, label: string, max = MAX_IDENTIFIER_CHARS): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /\p{Cc}/u.test(value)) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}

function bindingDirection(value: string): ChannelMessageTurnDirection {
  const direction = optionalBindingDirection(value);
  if (direction === undefined) throw new Error("Invalid channel message direction.");
  return direction;
}

function optionalBindingDirection(value: string): ChannelMessageTurnDirection | undefined {
  return value === "inbound" || value === "outbound" ? value : undefined;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${label}.`);
  return value;
}

function validDate(value: Date, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new Error(`Invalid ${label}.`);
  return value;
}

function validStoredDate(value: string): boolean {
  return value.length <= 64 && Number.isFinite(Date.parse(value));
}
