import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { ChannelMessage } from "../contracts/channel.js";
import type { SQLiteDatabase } from "../storage/sqlite.js";
import { createSQLiteSessionDB } from "../session/session-setup.js";
import { CHANNEL_MESSAGE_TURN_SCHEMA_VERSION } from "../session/channel-message-turn-schema.js";
import {
  PendingTurnStoreError,
  SQLitePendingTurnStore,
  type PendingTurnStoreDiagnostic
} from "./pending-turn-store.js";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("pending turn schema", () => {
  it("migrates an existing v28 session database through the current profile-scoped schema", async () => {
    const root = await tempRoot();
    const dbPath = join(root, "sessions.sqlite");
    const initial = await createSQLiteSessionDB({ path: dbPath });
    initial.db.exec(`
      drop table channel_message_turn_bindings;
      drop table pending_channel_turn_delivery_ids;
      drop table pending_channel_turns;
      delete from schema_version where version in (29, 30, 31);
    `);
    initial.close();

    const migrated = await createSQLiteSessionDB({ path: dbPath });
    try {
      expect(migrated.db.query<{ version: number }>("select max(version) as version from schema_version").get())
        .toEqual({ version: CHANNEL_MESSAGE_TURN_SCHEMA_VERSION });
      expect(migrated.db.query<{ name: string }>(`
        select name from sqlite_master where type = 'table' and name = 'pending_channel_turns'
      `).get()).toEqual({ name: "pending_channel_turns" });
      expect(migrated.db.query<{ name: string }>(`
        select name from sqlite_master
        where type = 'index' and name = 'idx_pending_channel_turns_profile_status_fifo'
      `).get()).toEqual({ name: "idx_pending_channel_turns_profile_status_fifo" });
      expect(migrated.db.query<{ name: string }>(`
        select name from sqlite_master
        where type = 'table' and name = 'pending_channel_turn_delivery_ids'
      `).get()).toEqual({ name: "pending_channel_turn_delivery_ids" });
    } finally {
      migrated.close();
    }
  });

  it("migrates v29 rows into the delivery-identity index", async () => {
    const root = await tempRoot();
    const dbPath = join(root, "sessions.sqlite");
    const initial = await createSQLiteSessionDB({ path: dbPath });
    new SQLitePendingTurnStore({ db: initial.db, profileId: "default" })
      .enqueue({
        ...message("legacy-message", "legacy\n\nfragment"),
        metadata: {
          updateId: 42,
          debouncedMessageIds: ["legacy-message", "legacy-fragment"],
          debounceSize: 2,
          debounceWindowMs: 1_500
        }
      });
    initial.db.exec(`
      drop table channel_message_turn_bindings;
      drop table pending_channel_turn_delivery_ids;
      delete from schema_version where version in (30, 31);
    `);
    initial.close();

    const migrated = await createSQLiteSessionDB({ path: dbPath });
    try {
      const store = new SQLitePendingTurnStore({ db: migrated.db, profileId: "default" });
      expect(store.hasDeliveryIdentity("telegram", "legacy-message")).toBe(true);
      expect(store.hasDeliveryIdentity("telegram", "legacy-fragment")).toBe(true);
    } finally {
      migrated.close();
    }
  });
});

describe("SQLitePendingTurnStore", () => {
  it("isolates profiles and inserts duplicate platform deliveries idempotently", async () => {
    const fixture = await createFixture();
    try {
      const alpha = fixture.store({ profileId: "alpha", idFactory: () => "shared-turn-id" });
      const beta = fixture.store({ profileId: "beta", idFactory: () => "shared-turn-id" });
      const input = message("message-1", "first");

      expect(alpha.enqueue(input).inserted).toBe(true);
      expect(alpha.enqueue(input)).toMatchObject({ inserted: false, turn: { id: "shared-turn-id" } });
      expect(beta.enqueue(input).inserted).toBe(true);
      expect(alpha.list()).toHaveLength(1);
      expect(beta.list()).toHaveLength(1);
      expect(beta.clear()).toBe(1);
      expect(alpha.list()).toHaveLength(1);
    } finally {
      fixture.close();
    }
  });

  it("indexes every bounded rapid-text delivery id and removes aliases with the owning turn", async () => {
    const fixture = await createFixture();
    try {
      const store = fixture.store({ idFactory: () => "batched-turn" });
      const batched = {
        ...message("message-1", "first\n\nsecond\n\nthird"),
        metadata: {
          updateId: 42,
          debouncedMessageIds: ["message-1", "message-2", "message-3"],
          debounceSize: 3,
          debounceWindowMs: 1_500
        }
      };
      const inserted = store.enqueue(batched);

      expect(store.hasDeliveryIdentity("telegram", "message-1")).toBe(true);
      expect(store.hasDeliveryIdentity("telegram", "message-2")).toBe(true);
      expect(store.hasDeliveryIdentity("telegram", "message-3")).toBe(true);
      expect(store.enqueue(message("message-2", "second"))).toMatchObject({
        inserted: false,
        turn: { id: inserted.turn.id }
      });

      expect(store.clearPendingTurns([inserted.turn.id])).toBe(1);
      expect(store.hasDeliveryIdentity("telegram", "message-1")).toBe(false);
      expect(store.hasDeliveryIdentity("telegram", "message-2")).toBe(false);
      expect(store.hasDeliveryIdentity("telegram", "message-3")).toBe(false);
    } finally {
      fixture.close();
    }
  });

  it("rejects reuse of a platform message id with different content", async () => {
    const fixture = await createFixture();
    try {
      const store = fixture.store();
      store.enqueue(message("same-id", "first"));
      expect(() => store.enqueue(message("same-id", "changed"))).toThrowError(
        expect.objectContaining({ code: "state_conflict" })
      );
    } finally {
      fixture.close();
    }
  });

  it("claims exact FIFO order and requires the matching claim to complete", async () => {
    const fixture = await createFixture();
    let turn = 0;
    let claim = 0;
    try {
      const store = fixture.store({
        idFactory: () => `turn-${++turn}`,
        claimIdFactory: () => `claim-${++claim}`
      });
      store.enqueue(message("message-1", "first"));
      store.enqueue(message("message-2", "second"));

      const first = store.claimNext();
      const second = store.claimNext();
      expect([first?.platformMessageId, second?.platformMessageId]).toEqual(["message-1", "message-2"]);
      expect(store.claimNext()).toBeUndefined();
      expect(() => store.complete(first!.id, "wrong-claim")).toThrowError(
        expect.objectContaining({ code: "state_conflict" })
      );
      expect(store.complete(first!.id, first!.claimId!)).toMatchObject({ status: "completed" });
    } finally {
      fixture.close();
    }
  });

  it("serializes claims across independent SQLite connections", async () => {
    const root = await tempRoot();
    const dbPath = join(root, "sessions.sqlite");
    const firstDb = await createSQLiteSessionDB({ path: dbPath });
    const secondDb = await createSQLiteSessionDB({ path: dbPath });
    try {
      let turn = 0;
      const writer = new SQLitePendingTurnStore({
        db: firstDb.db,
        profileId: "default",
        idFactory: () => `turn-${++turn}`
      });
      writer.enqueue(message("message-1", "first"));
      writer.enqueue(message("message-2", "second"));
      const claimantA = new SQLitePendingTurnStore({ db: firstDb.db, profileId: "default" });
      const claimantB = new SQLitePendingTurnStore({ db: secondDb.db, profileId: "default" });

      const claims = [claimantA.claimNext(), claimantB.claimNext()];
      expect(claims.map((entry) => entry?.platformMessageId)).toEqual(["message-1", "message-2"]);
      expect(new Set(claims.map((entry) => entry?.id)).size).toBe(2);
    } finally {
      firstDb.close();
      secondDb.close();
    }
  });

  it("moves crash-left claims to uncertain without replaying them", async () => {
    const fixture = await createFixture();
    try {
      const store = fixture.store();
      store.enqueue(message("message-1", "first"));
      const claimed = store.claimNext()!;
      expect(store.markClaimedAsUncertain(claimed.id)).toBe(1);
      expect(store.claimNext()).toBeUndefined();
      expect(store.list({ statuses: ["uncertain"] })).toMatchObject([
        { id: claimed.id, status: "uncertain" }
      ]);
    } finally {
      fixture.close();
    }
  });

  it("claims an exact turn, releases a pre-execution race, and exposes durable status counts", async () => {
    const fixture = await createFixture();
    try {
      const store = fixture.store({ claimIdFactory: () => "claim-1" });
      const first = store.enqueue(message("message-1", "first")).turn;
      store.enqueue(message("message-2", "second"));

      const claimed = store.claim(first.id);
      expect(claimed).toMatchObject({ id: first.id, status: "claimed", claimId: "claim-1" });
      expect(store.counts()).toMatchObject({ pending: 1, claimed: 1, uncertain: 0 });
      expect(store.releaseClaim(first.id, "claim-1")).toMatchObject({ status: "pending" });
      expect(store.counts()).toMatchObject({ pending: 2, claimed: 0, uncertain: 0 });
    } finally {
      fixture.close();
    }
  });

  it("coalesces a pending FIFO tail transactionally and deduplicates the incoming delivery", async () => {
    const fixture = await createFixture();
    let turn = 0;
    try {
      const store = fixture.store({ idFactory: () => `turn-${++turn}` });
      const original = message("message-1", "first");
      const incoming = message("message-2", "second");
      const combined = {
        ...original,
        text: "first\n\nsecond",
        metadata: {
          ...original.metadata,
          busyTextCoalescedMessageIds: ["message-1", "message-2"],
          busyTextCoalescedReceivedAts: [original.receivedAt, incoming.receivedAt],
          busyTextCoalescingSize: 2,
          busyTextCoalescingWindowMs: 1_500
        }
      };
      const target = store.enqueue(original).turn;

      expect(store.coalescePending({
        turnId: target.id,
        previousMessage: original,
        incomingMessage: incoming,
        combinedMessage: combined
      })).toMatchObject({ duplicate: false, turn: { id: target.id, message: combined } });
      expect(store.enqueue(incoming)).toMatchObject({ inserted: false, turn: { status: "completed" } });
      expect(store.enqueue(combined)).toMatchObject({ inserted: false, turn: { id: target.id } });
      expect(store.list({ statuses: ["pending"] })).toMatchObject([{ id: target.id, message: combined }]);
    } finally {
      fixture.close();
    }
  });

  it("replaces and clears an exact pending set atomically", async () => {
    const fixture = await createFixture();
    let turn = 0;
    try {
      const store = fixture.store({ idFactory: () => `turn-${++turn}` });
      const first = store.enqueue(message("message-1", "first")).turn;
      const second = store.enqueue(message("message-2", "second")).turn;
      const replacement = store.replacePending(
        [first.id, second.id],
        message("message-3", "replacement")
      );
      expect(replacement.inserted).toBe(true);
      expect(store.list({ statuses: ["pending"] })).toMatchObject([
        { id: replacement.turn.id, platformMessageId: "message-3" }
      ]);
      expect(() => store.clearPendingTurns([first.id])).toThrowError(
        expect.objectContaining({ code: "state_conflict" })
      );
      expect(store.list({ statuses: ["pending"] })).toHaveLength(1);
      expect(store.clearPendingTurns([replacement.turn.id])).toBe(1);
      expect(store.list({ statuses: ["pending"] })).toHaveLength(0);
    } finally {
      fixture.close();
    }
  });

  it("enforces the active-row cap and frees capacity after completion", async () => {
    const fixture = await createFixture();
    try {
      let turn = 0;
      const store = fixture.store({ maxPendingPerProfile: 2, idFactory: () => `turn-${++turn}` });
      store.enqueue(message("message-1", "first"));
      store.enqueue(message("message-2", "second"));
      expect(() => store.enqueue(message("message-3", "third"))).toThrowError(
        expect.objectContaining({ code: "capacity_exceeded" })
      );
      const claimed = store.claimNext()!;
      store.complete(claimed.id, claimed.claimId!);
      expect(store.enqueue(message("message-3", "third")).inserted).toBe(true);
    } finally {
      fixture.close();
    }
  });

  it("prunes completed and uncertain rows after bounded retention", async () => {
    const fixture = await createFixture();
    let now = new Date("2026-01-01T00:00:00.000Z");
    try {
      let turn = 0;
      const store = fixture.store({
        now: () => now,
        uncertainRetentionDays: 1,
        idFactory: () => `turn-${++turn}`
      });
      store.enqueue(message("completed", "done"));
      const completed = store.claimNext()!;
      store.complete(completed.id, completed.claimId!);
      store.enqueue(message("uncertain", "maybe"));
      store.markClaimedAsUncertain(store.claimNext()!.id);

      now = new Date("2026-01-03T00:00:00.000Z");
      expect(store.pruneRetention()).toBe(2);
      expect(store.list()).toEqual([]);
    } finally {
      fixture.close();
    }
  });

  it("rejects invalid payloads, secret-shaped content, and sensitive metadata", async () => {
    const fixture = await createFixture();
    try {
      const store = fixture.store();
      expect(() => store.enqueue({ ...message("bad-date", "text"), receivedAt: "yesterday" }))
        .toThrowError(expect.objectContaining({ code: "invalid_payload" }));
      expect(() => store.enqueue(message("secret", "use sk-1234567890abcdefghijklmnop")))
        .toThrowError(expect.objectContaining({ code: "invalid_payload" }));
      expect(() => store.enqueue({
        ...message("metadata", "text"),
        metadata: { access_token: "not-even-a-real-secret" }
      })).toThrowError(expect.objectContaining({ code: "invalid_payload" }));
      expect(() => store.enqueue(message("oversized-text", "x".repeat(100_001))))
        .toThrowError(expect.objectContaining({ code: "invalid_payload" }));
      expect(() => store.enqueue({
        ...message("oversized-metadata", "text"),
        metadata: { note: "x".repeat(32_769) }
      })).toThrowError(expect.objectContaining({ code: "invalid_payload" }));
    } finally {
      fixture.close();
    }
  });

  it("canonicalizes approved attachments and rejects traversal, remote URLs, and escaping symlinks", async () => {
    const fixture = await createFixture();
    const mediaRoot = join(fixture.root, "media");
    const outsideRoot = join(fixture.root, "outside");
    await mkdir(mediaRoot);
    await mkdir(outsideRoot);
    const approvedFile = join(mediaRoot, "approved.txt");
    const outsideFile = join(outsideRoot, "private.txt");
    const escapeLink = join(mediaRoot, "escape.txt");
    await writeFile(approvedFile, "approved");
    await writeFile(outsideFile, "private");
    await symlink(outsideFile, escapeLink);
    try {
      let turn = 0;
      const store = fixture.store({ approvedMediaRoots: [mediaRoot], idFactory: () => `turn-${++turn}` });
      const accepted = store.enqueue(withAttachment(message("valid", "file"), { localPath: approvedFile }));
      expect(accepted.turn.message.attachments?.[0]?.localPath).toBe(await realpath(approvedFile));
      expect(() => store.enqueue(withAttachment(message("outside", "file"), { localPath: outsideFile })))
        .toThrowError(expect.objectContaining({ code: "invalid_payload" }));
      expect(() => store.enqueue(withAttachment(message("relative", "file"), { localPath: "../private.txt" })))
        .toThrowError(expect.objectContaining({ code: "invalid_payload" }));
      expect(() => store.enqueue(withAttachment(message("symlink", "file"), { localPath: escapeLink })))
        .toThrowError(expect.objectContaining({ code: "invalid_payload" }));
      expect(() => store.enqueue(withAttachment(message("remote", "file"), { remoteUrl: "https://example.test/a" })))
        .toThrowError(expect.objectContaining({ code: "invalid_payload" }));
    } finally {
      fixture.close();
    }
  });

  it("can complete a claimed turn after its approved attachment is removed", async () => {
    const fixture = await createFixture();
    const mediaRoot = join(fixture.root, "media");
    await mkdir(mediaRoot);
    const approvedFile = join(mediaRoot, "temporary.txt");
    await writeFile(approvedFile, "temporary");
    try {
      const store = fixture.store({ approvedMediaRoots: [mediaRoot] });
      store.enqueue(withAttachment(message("temporary", "file"), { localPath: approvedFile }));
      const claimed = store.claimNext()!;
      await rm(approvedFile);
      expect(() => store.validateForRecovery(claimed.message)).toThrowError(
        expect.objectContaining({ code: "invalid_payload", operation: "recover" })
      );
      expect(store.complete(claimed.id, claimed.claimId!)).toMatchObject({ status: "completed" });
    } finally {
      fixture.close();
    }
  });

  it("quarantines a recovery row whose attachment became an escaping symlink without blocking other rows", async () => {
    const fixture = await createFixture();
    const mediaRoot = join(fixture.root, "media");
    const outsideRoot = join(fixture.root, "outside");
    await mkdir(mediaRoot);
    await mkdir(outsideRoot);
    const replacedFile = join(mediaRoot, "replace-me.txt");
    const outsideFile = join(outsideRoot, "private.txt");
    await writeFile(replacedFile, "safe");
    await writeFile(outsideFile, "private");
    try {
      let turn = 0;
      const store = fixture.store({
        approvedMediaRoots: [mediaRoot],
        idFactory: () => `turn-${++turn}`
      });
      store.enqueue(withAttachment(message("invalid-attachment", "file"), { localPath: replacedFile }));
      store.enqueue(message("still-valid", "continue"));
      await rm(replacedFile);
      await symlink(outsideFile, replacedFile);

      expect(store.listPendingForRecovery()).toMatchObject([
        { platformMessageId: "still-valid", status: "pending" }
      ]);
      expect(store.counts()).toMatchObject({ pending: 1, uncertain: 1 });
      expect(fixture.db.db.query<{ status: string }>(`
        select status from pending_channel_turns
        where profile_id = ? and platform_message_id = ?
      `).get("default", "invalid-attachment")).toEqual({ status: "uncertain" });
    } finally {
      fixture.close();
    }
  });

  it("returns structured database errors and emits content-free diagnostics", () => {
    const diagnostics: PendingTurnStoreDiagnostic[] = [];
    const failingDb: SQLiteDatabase = {
      exec: () => undefined,
      query: () => {
        throw new Error("database failed while storing raw-private-message sk-1234567890abcdefghijklmnop");
      },
      close: () => undefined
    };
    const store = new SQLitePendingTurnStore({
      db: failingDb,
      profileId: "default",
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic)
    });

    let thrown: unknown;
    try {
      store.list();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PendingTurnStoreError);
    expect(thrown).toMatchObject({ code: "database_failure", operation: "list", retryable: true });
    expect((thrown as Error).message).not.toContain("raw-private-message");
    expect(JSON.stringify(diagnostics)).not.toContain("raw-private-message");
    expect(diagnostics).toEqual([{ operation: "list", code: "database_failure", retryable: true }]);
  });

  it("fails closed when persisted message data no longer matches its indexed identity", async () => {
    const fixture = await createFixture();
    try {
      const store = fixture.store();
      store.enqueue(message("message-1", "first"));
      fixture.db.db.query("update pending_channel_turns set message_json = ? where profile_id = ?")
        .run(JSON.stringify({ id: "different", channel: "telegram" }), "default");
      expect(() => store.list()).toThrowError(expect.objectContaining({ code: "corrupt_record" }));
    } finally {
      fixture.close();
    }
  });
});

async function createFixture() {
  const root = await tempRoot();
  const db = await createSQLiteSessionDB({ path: join(root, "sessions.sqlite") });
  return {
    root,
    db,
    store: (options: Partial<ConstructorParameters<typeof SQLitePendingTurnStore>[0]> = {}) =>
      new SQLitePendingTurnStore({ db: db.db, profileId: "default", ...options }),
    close: () => db.close()
  };
}

async function tempRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "estacoda-pending-turn-"));
  tempPaths.push(path);
  return path;
}

function message(id: string, text: string): ChannelMessage {
  return {
    id,
    channel: "telegram",
    sessionKey: { platform: "telegram", chatId: "chat-1", accountId: "account-1", userId: "user-1" },
    text,
    sender: { id: "user-1", displayName: "Test User" },
    attachments: [],
    receivedAt: "2026-01-01T00:00:00.000Z",
    metadata: { updateId: 42 }
  };
}

function withAttachment(
  input: ChannelMessage,
  attachment: { localPath?: string; remoteUrl?: string }
): ChannelMessage {
  return {
    ...input,
    attachments: [{ id: `${input.id}-attachment`, kind: "document", status: "ready", ...attachment }]
  };
}
