import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSQLiteSessionDB } from "../session/session-setup.js";
import { CHANNEL_MESSAGE_TURN_SCHEMA_VERSION } from "../session/channel-message-turn-schema.js";
import { SQLiteChannelMessageTurnStore } from "./channel-message-turn-store.js";

const tempPaths: string[] = [];
const openDatabases: Array<{ close(): void }> = [];

afterEach(async () => {
  for (const db of openDatabases.splice(0)) db.close();
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("SQLiteChannelMessageTurnStore", () => {
  it("persists all delivered chunks and resolves only the exact profile and surface", async () => {
    const fixture = await createFixture();
    const store = new SQLiteChannelMessageTurnStore({
      db: fixture.db.db,
      profileId: "alpha",
      now: () => new Date("2030-01-01T00:00:00.000Z")
    });
    const sessionKey = {
      platform: "telegram" as const,
      accountId: "telegram",
      chatId: "chat-1",
      chatType: "thread" as const,
      threadId: "topic-7"
    };

    store.record({
      sessionKey,
      platformMessageIds: ["101", "102"],
      sessionId: "session-1",
      turnId: "turn-1"
    });

    expect(store.resolve({ sessionKey, platformMessageId: "102" })).toEqual({
      sessionId: "session-1",
      turnId: "turn-1",
      createdAt: "2030-01-01T00:00:00.000Z"
    });
    expect(store.resolve({
      sessionKey: { ...sessionKey, threadId: "topic-8" },
      platformMessageId: "102"
    })).toBeUndefined();
    expect(new SQLiteChannelMessageTurnStore({ db: fixture.db.db, profileId: "beta" }).resolve({
      sessionKey,
      platformMessageId: "102"
    })).toBeUndefined();
  });

  it("keeps an existing platform message attribution immutable", async () => {
    const fixture = await createFixture();
    await fixture.db.appendMessage({ id: "turn-2", sessionId: "session-1", role: "user", content: "second" });
    const store = new SQLiteChannelMessageTurnStore({ db: fixture.db.db, profileId: "alpha" });
    const sessionKey = { platform: "telegram" as const, accountId: "telegram", chatId: "chat-1" };
    store.record({ sessionKey, platformMessageIds: ["101"], sessionId: "session-1", turnId: "turn-1" });

    expect(() => store.record({
      sessionKey,
      platformMessageIds: ["101"],
      sessionId: "session-1",
      turnId: "turn-2"
    })).toThrow("immutable");
    expect(store.resolve({ sessionKey, platformMessageId: "101" })?.turnId).toBe("turn-1");
  });

  it("creates the v31 binding schema", async () => {
    const fixture = await createFixture();
    expect(fixture.db.db.query<{ version: number }>(
      "select max(version) as version from schema_version"
    ).get()).toEqual({ version: CHANNEL_MESSAGE_TURN_SCHEMA_VERSION });
    expect(fixture.db.db.query<{ name: string }>(`
      select name from sqlite_master where type = 'table' and name = 'channel_message_turn_bindings'
    `).get()).toEqual({ name: "channel_message_turn_bindings" });
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
