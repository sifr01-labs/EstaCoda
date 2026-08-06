import type { SQLiteDatabase } from "../storage/sqlite.js";

export const PENDING_TURN_SCHEMA_VERSION = 30;

export function migratePendingTurnSchemaV29(db: SQLiteDatabase): void {
  db.exec(`
    create table pending_channel_turns (
      sequence integer primary key autoincrement,
      turn_id text not null check(length(turn_id) between 1 and 128),
      profile_id text not null check(length(profile_id) between 1 and 128),
      channel text not null check(length(channel) between 1 and 64),
      platform_message_id text not null check(length(platform_message_id) between 1 and 512),
      status text not null check(status in ('pending', 'claimed', 'completed', 'uncertain')),
      message_json text not null check(json_valid(message_json) and length(message_json) <= 262144),
      claim_id text check(claim_id is null or length(claim_id) between 1 and 128),
      claimed_at text,
      completed_at text,
      uncertain_at text,
      created_at text not null,
      updated_at text not null,
      unique(profile_id, turn_id),
      unique(profile_id, channel, platform_message_id),
      check(
        (status = 'pending' and claim_id is null and claimed_at is null) or
        (status = 'claimed' and claim_id is not null and claimed_at is not null) or
        (status = 'completed' and completed_at is not null) or
        (status = 'uncertain' and uncertain_at is not null)
      )
    );

    create index idx_pending_channel_turns_profile_status_fifo
      on pending_channel_turns(profile_id, status, sequence);
    create index idx_pending_channel_turns_profile_terminal_retention
      on pending_channel_turns(profile_id, status, updated_at);
  `);
}

export function migratePendingTurnDeliveryIdentitySchemaV30(db: SQLiteDatabase): void {
  db.exec(`
    create table pending_channel_turn_delivery_ids (
      profile_id text not null check(length(profile_id) between 1 and 128),
      channel text not null check(length(channel) between 1 and 64),
      platform_message_id text not null check(length(platform_message_id) between 1 and 512),
      turn_id text not null check(length(turn_id) between 1 and 128),
      created_at text not null,
      primary key(profile_id, channel, platform_message_id),
      foreign key(profile_id, turn_id)
        references pending_channel_turns(profile_id, turn_id)
        on delete cascade
    );

    create index idx_pending_channel_turn_delivery_ids_turn
      on pending_channel_turn_delivery_ids(profile_id, turn_id);

    insert into pending_channel_turn_delivery_ids (
      profile_id, channel, platform_message_id, turn_id, created_at
    )
    select profile_id, channel, platform_message_id, turn_id, created_at
    from pending_channel_turns;
  `);

  const rows = db.query<{
    profile_id: string;
    channel: string;
    platform_message_id: string;
    turn_id: string;
    created_at: string;
    message_json: string;
  }>(`
    select profile_id, channel, platform_message_id, turn_id, created_at, message_json
    from pending_channel_turns
  `).all();
  const insertIdentity = db.query(`
    insert or ignore into pending_channel_turn_delivery_ids (
      profile_id, channel, platform_message_id, turn_id, created_at
    ) values (?, ?, ?, ?, ?)
  `);
  for (const row of rows) {
    const parsed = JSON.parse(row.message_json) as unknown;
    const metadata = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) &&
      "metadata" in parsed && typeof parsed.metadata === "object" && parsed.metadata !== null &&
      !Array.isArray(parsed.metadata)
      ? parsed.metadata as Record<string, unknown>
      : undefined;
    const aliases = [
      ...(Array.isArray(metadata?.debouncedMessageIds) ? metadata.debouncedMessageIds : []),
      ...(Array.isArray(metadata?.busyTextCoalescedMessageIds)
        ? metadata.busyTextCoalescedMessageIds
        : [])
    ];
    const boundedAliases = [...new Set(aliases)]
      .filter((value): value is string =>
        typeof value === "string" && value.length > 0 && value.length <= 512 && !/\p{Cc}/u.test(value))
      .slice(0, 255);
    for (const platformMessageId of boundedAliases) {
      insertIdentity.run(row.profile_id, row.channel, platformMessageId, row.turn_id, row.created_at);
    }
  }
}
