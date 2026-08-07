import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSQLiteSessionDB } from "../session/session-setup.js";
import {
  CHANNEL_MESSAGE_TURN_SCHEMA_VERSION,
  migrateChannelMessageTurnSchemaV31
} from "../session/channel-message-turn-schema.js";
import {
  channelSurfaceScopeHash,
  SQLiteChannelMessageTurnStore
} from "./channel-message-turn-store.js";

const tempPaths: string[] = [];
const openDatabases: Array<{ close(): void }> = [];

afterEach(async () => {
  for (const db of openDatabases.splice(0)) db.close();
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("SQLiteChannelMessageTurnStore", () => {
  it("persists inbound and outbound chunks using only the hashed normalized surface", async () => {
    const fixture = await createFixture();
    const store = new SQLiteChannelMessageTurnStore({
      db: fixture.db.db,
      profileId: "alpha",
      now: () => new Date("2030-01-01T00:00:00.000Z")
    });
    const sessionKey = {
      platform: "telegram" as const,
      accountId: "private-account",
      chatId: "private-chat",
      chatType: "thread" as const,
      threadId: "private-topic",
      userId: "private-user"
    };

    store.record({
      sessionKey,
      platformMessageIds: ["100"],
      direction: "inbound",
      sessionId: "session-1",
      turnId: "turn-1"
    });
    store.record({
      sessionKey,
      platformMessageIds: ["101", "102"],
      direction: "outbound",
      sessionId: "session-1",
      turnId: "turn-1"
    });

    expect(store.resolve({ sessionKey, platformMessageId: "100" })).toMatchObject({
      sessionId: "session-1",
      turnId: "turn-1",
      direction: "inbound"
    });
    expect(store.resolve({ sessionKey, platformMessageId: "102" })).toMatchObject({ direction: "outbound" });
    expect(store.resolve({
      sessionKey: { ...sessionKey, userId: "other-user" },
      platformMessageId: "102"
    })).toBeUndefined();
    const row = fixture.db.db.query<{ channel: string; surface_scope_hash: string }>(`
      select channel, surface_scope_hash from channel_message_turn_bindings where platform_message_id = '102'
    `).get();
    expect(row).toEqual({ channel: "telegram", surface_scope_hash: channelSurfaceScopeHash(sessionKey) });
    const columns = fixture.db.db.query<{ name: string }>("pragma table_info(channel_message_turn_bindings)")
      .all().map((column) => column.name);
    expect(columns).not.toEqual(expect.arrayContaining(["account_id", "chat_id", "thread_id", "user_id"]));
  });

  it("keeps an existing platform message attribution and direction immutable", async () => {
    const fixture = await createFixture();
    await fixture.db.appendMessage({ id: "turn-2", sessionId: "session-1", role: "user", content: "second" });
    const store = new SQLiteChannelMessageTurnStore({ db: fixture.db.db, profileId: "alpha" });
    const sessionKey = { platform: "telegram" as const, accountId: "telegram", chatId: "chat-1" };
    store.record({
      sessionKey,
      platformMessageIds: ["101"],
      direction: "outbound",
      sessionId: "session-1",
      turnId: "turn-1"
    });

    expect(() => store.record({
      sessionKey,
      platformMessageIds: ["101"],
      direction: "inbound",
      sessionId: "session-1",
      turnId: "turn-2"
    })).toThrow("immutable");
    expect(store.resolve({ sessionKey, platformMessageId: "101" })).toMatchObject({
      turnId: "turn-1",
      direction: "outbound"
    });
  });

  it("requires the attributed user turn to belong to the attributed session", async () => {
    const fixture = await createFixture();
    await fixture.db.createSession({ id: "session-2", profileId: "alpha" });
    await fixture.db.appendMessage({ id: "turn-2", sessionId: "session-2", role: "user", content: "second" });
    const store = new SQLiteChannelMessageTurnStore({ db: fixture.db.db, profileId: "alpha" });

    expect(() => store.record({
      sessionKey: { platform: "telegram", chatId: "chat-1" },
      platformMessageIds: ["101"],
      direction: "outbound",
      sessionId: "session-1",
      turnId: "turn-2"
    })).toThrow("target is invalid");
  });

  it("expires links and deterministically evicts the oldest rows beyond the profile bound", async () => {
    const fixture = await createFixture();
    let nowMs = Date.parse("2030-01-01T00:00:00.000Z");
    const store = new SQLiteChannelMessageTurnStore({
      db: fixture.db.db,
      profileId: "alpha",
      now: () => new Date(nowMs),
      retentionMs: 1_000,
      maxBindings: 2
    });
    const sessionKey = { platform: "telegram" as const, chatId: "chat-1", chatType: "dm" as const };
    for (const messageId of ["1", "2", "3"]) {
      store.record({
        sessionKey,
        platformMessageIds: [messageId],
        direction: "outbound",
        sessionId: "session-1",
        turnId: "turn-1"
      });
      nowMs += 10;
    }

    expect(store.resolve({ sessionKey, platformMessageId: "1" })).toBeUndefined();
    expect(store.resolve({ sessionKey, platformMessageId: "2" })).toBeDefined();
    expect(store.resolve({ sessionKey, platformMessageId: "3" })).toBeDefined();
    nowMs += 1_000;
    expect(store.resolve({ sessionKey, platformMessageId: "2" })).toBeUndefined();
    expect(store.prune()).toEqual({ expired: 2, excess: 0 });
  });

  it("fails closed for malformed stored timestamps and isolates profiles", async () => {
    const fixture = await createFixture();
    const sessionKey = { platform: "telegram" as const, chatId: "chat-1" };
    const hash = channelSurfaceScopeHash(sessionKey);
    fixture.db.db.query(`
      insert into channel_message_turn_bindings (
        profile_id, channel, surface_scope_hash, platform_message_id, direction,
        session_id, turn_id, created_at, expires_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("alpha", "telegram", hash, "bad", "outbound", "session-1", "turn-1", "not-a-date", "not-a-date");

    expect(new SQLiteChannelMessageTurnStore({ db: fixture.db.db, profileId: "alpha" }).resolve({
      sessionKey,
      platformMessageId: "bad"
    })).toBeUndefined();
    expect(new SQLiteChannelMessageTurnStore({ db: fixture.db.db, profileId: "beta" }).resolve({
      sessionKey,
      platformMessageId: "bad"
    })).toBeUndefined();
  });

  it("creates the v32 bounded binding schema", async () => {
    const fixture = await createFixture();
    expect(fixture.db.db.query<{ version: number }>(
      "select max(version) as version from schema_version"
    ).get()).toEqual({ version: CHANNEL_MESSAGE_TURN_SCHEMA_VERSION });
    expect(fixture.db.db.query<{ name: string }>(`
      select name from sqlite_master where type = 'index' and name = 'idx_channel_message_turn_bindings_retention'
    `).get()).toEqual({ name: "idx_channel_message_turn_bindings_retention" });
  });

  it("invalidates v31 links that cannot be migrated into the stronger surface scope", async () => {
    const fixture = await createFixture();
    fixture.db.db.exec("drop table channel_message_turn_bindings");
    migrateChannelMessageTurnSchemaV31(fixture.db.db);
    fixture.db.db.query(`
      insert into channel_message_turn_bindings (
        profile_id, channel, account_id, chat_id, thread_id,
        platform_message_id, session_id, turn_id, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "alpha", "telegram", "account", "chat", "", "101",
      "session-1", "turn-1", "2030-01-01T00:00:00.000Z"
    );
    fixture.db.db.query("delete from schema_version where version = ?")
      .run(CHANNEL_MESSAGE_TURN_SCHEMA_VERSION);

    const migrated = await createSQLiteSessionDB({ path: join(fixture.root, "sessions.sqlite") });
    openDatabases.push(migrated);
    expect(migrated.db.query<{ count: number }>(
      "select count(*) as count from channel_message_turn_bindings"
    ).get()).toEqual({ count: 0 });
    const columns = migrated.db.query<{ name: string }>("pragma table_info(channel_message_turn_bindings)")
      .all().map((column) => column.name);
    expect(columns).toContain("surface_scope_hash");
    expect(columns).not.toContain("chat_id");
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "estacoda-channel-turn-"));
  tempPaths.push(root);
  const db = await createSQLiteSessionDB({ path: join(root, "sessions.sqlite") });
  openDatabases.push(db);
  await db.createSession({ id: "session-1", profileId: "alpha" });
  await db.appendMessage({ id: "turn-1", sessionId: "session-1", role: "user", content: "first" });
  return { root, db };
}
