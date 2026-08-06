import type { SQLiteDatabase } from "../storage/sqlite.js";

export const CHANNEL_MESSAGE_TURN_SCHEMA_VERSION = 31;

export function migrateChannelMessageTurnSchemaV31(db: SQLiteDatabase): void {
  db.exec(`
    create table channel_message_turn_bindings (
      profile_id text not null check(length(profile_id) between 1 and 128),
      channel text not null check(length(channel) between 1 and 64),
      account_id text not null check(length(account_id) <= 512),
      chat_id text not null check(length(chat_id) between 1 and 512),
      thread_id text not null check(length(thread_id) <= 512),
      platform_message_id text not null check(length(platform_message_id) between 1 and 512),
      session_id text not null check(length(session_id) between 1 and 512),
      turn_id text not null check(length(turn_id) between 1 and 512),
      created_at text not null,
      primary key(profile_id, channel, account_id, chat_id, thread_id, platform_message_id),
      foreign key(session_id) references sessions(id) on delete cascade,
      foreign key(turn_id) references messages(id) on delete cascade
    );

    create index idx_channel_message_turn_bindings_turn
      on channel_message_turn_bindings(profile_id, turn_id);
  `);
}
