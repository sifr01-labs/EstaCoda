import type { SQLiteDatabase } from "../storage/sqlite.js";

export const CHANNEL_MESSAGE_TURN_SCHEMA_V31 = 31;
export const CHANNEL_MESSAGE_TURN_SCHEMA_VERSION = 32;

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

/**
 * v31 did not retain enough normalized scope information to reconstruct per-user
 * group boundaries safely. Drop those short-lived hints rather than migrating
 * them into a weaker scope.
 */
export function migrateChannelMessageTurnSchemaV32(db: SQLiteDatabase): void {
  db.exec(`
    drop table channel_message_turn_bindings;

    create table channel_message_turn_bindings (
      profile_id text not null check(length(profile_id) between 1 and 128),
      channel text not null check(length(channel) between 1 and 64),
      surface_scope_hash text not null check(length(surface_scope_hash) = 64),
      platform_message_id text not null check(length(platform_message_id) between 1 and 512),
      direction text not null check(direction in ('inbound', 'outbound')),
      session_id text not null check(length(session_id) between 1 and 512),
      turn_id text not null check(length(turn_id) between 1 and 512),
      created_at text not null,
      expires_at text not null,
      primary key(profile_id, surface_scope_hash, platform_message_id),
      foreign key(session_id) references sessions(id) on delete cascade,
      foreign key(turn_id) references messages(id) on delete cascade
    );

    create index idx_channel_message_turn_bindings_turn
      on channel_message_turn_bindings(profile_id, turn_id);

    create index idx_channel_message_turn_bindings_retention
      on channel_message_turn_bindings(profile_id, expires_at, created_at, surface_scope_hash, platform_message_id);
  `);
}
