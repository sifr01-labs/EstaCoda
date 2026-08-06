import { normalizeProfileId } from "../config/profile-home.js";
import type { ChannelSessionKey } from "../contracts/channel.js";
import type { SQLiteDatabase } from "../storage/sqlite.js";

const MAX_IDENTIFIER_CHARS = 512;
const MAX_MESSAGE_IDS = 256;

export type ChannelMessageTurnBinding = {
  sessionId: string;
  turnId: string;
  createdAt: string;
};

export type ChannelMessageTurnStore = {
  record(input: {
    sessionKey: ChannelSessionKey;
    platformMessageIds: readonly string[];
    sessionId: string;
    turnId: string;
  }): void | Promise<void>;
  resolve(input: {
    sessionKey: ChannelSessionKey;
    platformMessageId: string;
  }): ChannelMessageTurnBinding | undefined | Promise<ChannelMessageTurnBinding | undefined>;
};

type BindingRow = {
  session_id: string;
  turn_id: string;
  created_at: string;
};

/** Profile-scoped durable attribution from an outbound platform message to its visible turn. */
export class SQLiteChannelMessageTurnStore implements ChannelMessageTurnStore {
  readonly #db: SQLiteDatabase;
  readonly #profileId: string;
  readonly #now: () => Date;

  constructor(options: { db: SQLiteDatabase; profileId: string; now?: () => Date }) {
    this.#db = options.db;
    this.#profileId = normalizeProfileId(options.profileId);
    this.#now = options.now ?? (() => new Date());
  }

  record(input: {
    sessionKey: ChannelSessionKey;
    platformMessageIds: readonly string[];
    sessionId: string;
    turnId: string;
  }): void {
    const surface = normalizeSurface(input.sessionKey);
    const sessionId = identifier(input.sessionId, "sessionId");
    const turnId = identifier(input.turnId, "turnId");
    const messageIds = [...new Set(input.platformMessageIds.map((value) => identifier(value, "platformMessageId")))]
      .slice(0, MAX_MESSAGE_IDS);
    if (messageIds.length === 0) return;

    const session = this.#db.query<{ profile_id: string }>(
      "select profile_id from sessions where id = ?"
    ).get(sessionId);
    const turn = this.#db.query<{ profile_id: string; role: string }>(`
      select sessions.profile_id as profile_id, messages.role as role
      from messages
      join sessions on sessions.id = messages.session_id
      where messages.id = ?
    `).get(turnId);
    if (session?.profile_id !== this.#profileId || turn?.profile_id !== this.#profileId || turn.role !== "user") {
      throw new Error("Channel message attribution target is invalid.");
    }

    const existingQuery = this.#db.query<BindingRow>(`
      select session_id, turn_id, created_at
      from channel_message_turn_bindings
      where profile_id = ? and channel = ? and account_id = ? and chat_id = ? and thread_id = ?
        and platform_message_id = ?
    `);
    const insert = this.#db.query(`
      insert into channel_message_turn_bindings (
        profile_id, channel, account_id, chat_id, thread_id, platform_message_id,
        session_id, turn_id, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const createdAt = this.#now().toISOString();
    this.#db.exec("begin immediate");
    try {
      for (const platformMessageId of messageIds) {
        const existing = existingQuery.get(
          this.#profileId,
          surface.channel,
          surface.accountId,
          surface.chatId,
          surface.threadId,
          platformMessageId
        );
        if (existing !== null) {
          if (existing.session_id !== sessionId || existing.turn_id !== turnId) {
            throw new Error("Channel message attribution is immutable.");
          }
          continue;
        }
        insert.run(
          this.#profileId,
          surface.channel,
          surface.accountId,
          surface.chatId,
          surface.threadId,
          platformMessageId,
          sessionId,
          turnId,
          createdAt
        );
      }
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
    const surface = normalizeSurface(input.sessionKey);
    const platformMessageId = identifier(input.platformMessageId, "platformMessageId");
    const row = this.#db.query<BindingRow>(`
      select session_id, turn_id, created_at
      from channel_message_turn_bindings
      where profile_id = ? and channel = ? and account_id = ? and chat_id = ? and thread_id = ?
        and platform_message_id = ?
    `).get(
      this.#profileId,
      surface.channel,
      surface.accountId,
      surface.chatId,
      surface.threadId,
      platformMessageId
    );
    return row === null ? undefined : {
      sessionId: row.session_id,
      turnId: row.turn_id,
      createdAt: row.created_at
    };
  }
}

function normalizeSurface(sessionKey: ChannelSessionKey): {
  channel: string;
  accountId: string;
  chatId: string;
  threadId: string;
} {
  return {
    channel: identifier(sessionKey.platform, "channel", 64),
    accountId: optionalIdentifier(sessionKey.accountId, "accountId"),
    chatId: identifier(sessionKey.chatId, "chatId"),
    threadId: optionalIdentifier(sessionKey.threadId, "threadId")
  };
}

function optionalIdentifier(value: string | undefined, label: string): string {
  return value === undefined ? "" : identifier(value, label);
}

function identifier(value: string, label: string, max = MAX_IDENTIFIER_CHARS): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || /\p{Cc}/u.test(value)) {
    throw new Error(`Invalid ${label}.`);
  }
  return value;
}
