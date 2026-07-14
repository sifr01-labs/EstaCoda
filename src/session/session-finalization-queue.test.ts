import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionFinalizationQueue } from "./session-finalization-queue.js";
import { createSQLiteSessionDB } from "./session-setup.js";
import type { SQLiteSessionDB } from "./sqlite-session-db.js";

describe("SessionFinalizationQueue", () => {
  let tempDir: string;
  let dbPath: string;
  let db: SQLiteSessionDB;
  let now: Date;
  let nextId: number;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "estacoda-finalization-queue-"));
    dbPath = join(tempDir, "sessions.sqlite");
    db = await createSQLiteSessionDB({ path: dbPath });
    now = new Date("2030-01-01T00:00:00.000Z");
    nextId = 0;
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  function queue(database = db): SessionFinalizationQueue {
    return new SessionFinalizationQueue({
      db: database.db,
      now: () => now,
      id: () => `job-${++nextId}`,
    });
  }

  it("captures an atomic message cutoff without storing message content", async () => {
    await db.createSession({ id: "session-1", profileId: "profile-a" });
    await db.appendMessage({ id: "message-1", sessionId: "session-1", role: "user", content: "private content" });
    await db.appendMessage({ id: "message-2", sessionId: "session-1", role: "agent", content: "private response" });

    const job = queue().enqueue({
      profileId: "profile-a",
      sessionId: "session-1",
      reason: "new-session",
    });

    expect(job).toMatchObject({
      id: "job-1",
      profileId: "profile-a",
      sessionId: "session-1",
      reason: "new-session",
      status: "pending",
      sourceMessageCount: 2,
      cutoffMessageId: "message-2",
      attempts: 0,
    });
    const stored = db.db
      .query<Record<string, unknown>>("select * from session_finalization_jobs where id = ?")
      .get(job.id);
    expect(JSON.stringify(stored)).not.toContain("private content");
    expect(JSON.stringify(stored)).not.toContain("private response");
  });

  it("deduplicates repeated enqueue requests for the same session cutoff", async () => {
    await db.createSession({ id: "session-1", profileId: "profile-a" });
    await db.appendMessage({ id: "message-1", sessionId: "session-1", role: "user", content: "first" });
    const first = queue().enqueue({ profileId: "profile-a", sessionId: "session-1", reason: "new-session" });
    const duplicate = queue().enqueue({ profileId: "profile-a", sessionId: "session-1", reason: "cli-exit" });

    expect(duplicate.id).toBe(first.id);
    expect(duplicate.reason).toBe("new-session");
    expect(queue().list({ profileId: "profile-a" })).toHaveLength(1);

    await db.appendMessage({ id: "message-2", sessionId: "session-1", role: "agent", content: "second" });
    const next = queue().enqueue({ profileId: "profile-a", sessionId: "session-1", reason: "cli-exit" });
    expect(next.id).not.toBe(first.id);
    expect(next.sourceMessageCount).toBe(2);
  });

  it("fails closed across profile boundaries", async () => {
    await db.createSession({ id: "session-a", profileId: "profile-a" });
    await db.createSession({ id: "session-b", profileId: "profile-b" });
    const job = queue().enqueue({ profileId: "profile-a", sessionId: "session-a", reason: "sigint" });

    expect(() => queue().enqueue({
      profileId: "profile-a",
      sessionId: "session-b",
      reason: "sigint",
    })).toThrow("Session not found in the requested profile scope.");
    expect(queue().get(job.id, "profile-b")).toBeUndefined();
    expect(queue().list({ profileId: "profile-b" })).toEqual([]);
    expect(queue().claimNext({ profileId: "profile-b", ownerId: "worker-b", leaseMs: 60_000 })).toBeUndefined();
  });

  it("claims jobs once across simultaneous database connections", async () => {
    await db.createSession({ id: "session-1", profileId: "profile-a" });
    queue().enqueue({ profileId: "profile-a", sessionId: "session-1", reason: "cli-exit" });
    const secondDb = await createSQLiteSessionDB({ path: dbPath });

    try {
      const firstClaim = queue(db).claimNext({ profileId: "profile-a", ownerId: "worker-a", leaseMs: 60_000 });
      const secondClaim = queue(secondDb).claimNext({ profileId: "profile-a", ownerId: "worker-b", leaseMs: 60_000 });
      expect(firstClaim).toMatchObject({ status: "running", leaseOwner: "worker-a", attempts: 1 });
      expect(secondClaim).toBeUndefined();
    } finally {
      secondDb.close();
    }
  });

  it("reclaims expired leases and rejects stale worker completion", async () => {
    await db.createSession({ id: "session-1", profileId: "profile-a" });
    const pending = queue().enqueue({ profileId: "profile-a", sessionId: "session-1", reason: "cli-exit" });
    expect(queue().claimNext({ profileId: "profile-a", ownerId: "worker-a", leaseMs: 1_000 })).toBeDefined();

    now = new Date("2030-01-01T00:00:02.000Z");
    const reclaimed = queue().claimNext({ profileId: "profile-a", ownerId: "worker-b", leaseMs: 1_000 });
    expect(reclaimed).toMatchObject({ id: pending.id, leaseOwner: "worker-b", attempts: 2 });
    expect(queue().complete({
      id: pending.id,
      profileId: "profile-a",
      ownerId: "worker-a",
      outcomeCode: "curated",
    })).toBe(false);
    expect(queue().complete({
      id: pending.id,
      profileId: "profile-a",
      ownerId: "worker-b",
      outcomeCode: "curated",
    })).toBe(true);
    expect(queue().get(pending.id, "profile-a")).toMatchObject({
      status: "completed",
      outcomeCode: "curated",
      attempts: 2,
    });
  });

  it("rejects completion and retry after the current worker lease expires", async () => {
    await db.createSession({ id: "session-1", profileId: "profile-a" });
    const pending = queue().enqueue({ profileId: "profile-a", sessionId: "session-1", reason: "cli-exit" });
    queue().claimNext({ profileId: "profile-a", ownerId: "worker-a", leaseMs: 1_000 });

    now = new Date("2030-01-01T00:00:02.000Z");
    expect(queue().complete({
      id: pending.id,
      profileId: "profile-a",
      ownerId: "worker-a",
      outcomeCode: "curated",
    })).toBe(false);
    expect(queue().retry({
      id: pending.id,
      profileId: "profile-a",
      ownerId: "worker-a",
      errorCode: "provider-unavailable",
      delayMs: 1_000,
    })).toBe(false);
  });

  it("supports bounded retry scheduling and terminal failure codes", async () => {
    await db.createSession({ id: "session-1", profileId: "profile-a" });
    const pending = queue().enqueue({ profileId: "profile-a", sessionId: "session-1", reason: "one-shot" });
    queue().claimNext({ profileId: "profile-a", ownerId: "worker-a", leaseMs: 60_000 });

    expect(queue().retry({
      id: pending.id,
      profileId: "profile-a",
      ownerId: "worker-a",
      errorCode: "provider-unavailable",
      delayMs: 5_000,
    })).toBe(true);
    expect(queue().claimNext({ profileId: "profile-a", ownerId: "worker-b", leaseMs: 60_000 })).toBeUndefined();

    now = new Date("2030-01-01T00:00:05.000Z");
    expect(queue().claimNext({ profileId: "profile-a", ownerId: "worker-b", leaseMs: 60_000 })).toBeDefined();
    expect(queue().fail({
      id: pending.id,
      profileId: "profile-a",
      ownerId: "worker-b",
      errorCode: "attempts-exhausted",
    })).toBe(true);
    expect(queue().get(pending.id, "profile-a")).toMatchObject({
      status: "failed",
      attempts: 2,
      lastErrorCode: "attempts-exhausted",
    });
  });

  it("rejects free-form outcome and error text", async () => {
    await db.createSession({ id: "session-1", profileId: "profile-a" });
    const pending = queue().enqueue({ profileId: "profile-a", sessionId: "session-1", reason: "cli-exit" });
    queue().claimNext({ profileId: "profile-a", ownerId: "worker-a", leaseMs: 60_000 });

    expect(() => queue().fail({
      id: pending.id,
      profileId: "profile-a",
      ownerId: "worker-a",
      errorCode: "Provider said: secret user text",
    })).toThrow("errorCode must be a short lowercase operational code.");
  });
});
