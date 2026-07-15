import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryCurationCutoffError, type MemoryCurationCheckpointResult } from "./memory-curation-service.js";
import { SessionFinalizationWorker } from "./session-finalization-worker.js";
import { SessionFinalizationQueue, type SessionFinalizationJob } from "../session/session-finalization-queue.js";
import { createSQLiteSessionDB } from "../session/session-setup.js";
import type { SQLiteSessionDB } from "../session/sqlite-session-db.js";

describe("SessionFinalizationWorker", () => {
  let tempDir: string;
  let db: SQLiteSessionDB;
  let queue: SessionFinalizationQueue;
  let now: Date;
  let nextId: number;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "estacoda-finalization-worker-"));
    db = await createSQLiteSessionDB({ path: join(tempDir, "sessions.sqlite") });
    now = new Date("2030-01-01T00:00:00.000Z");
    nextId = 0;
    queue = new SessionFinalizationQueue({
      db: db.db,
      now: () => now,
      id: () => `job-${++nextId}`,
    });
    await db.createSession({ id: "session-1", profileId: "profile-a" });
    await db.appendMessage({ id: "message-1", sessionId: "session-1", role: "user", content: "remember this" });
  });

  afterEach(async () => {
    db.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  function worker(finalize: (job: SessionFinalizationJob, signal: AbortSignal) => Promise<MemoryCurationCheckpointResult>) {
    return new SessionFinalizationWorker({
      queue,
      profileId: "profile-a",
      ownerId: "worker-a",
      finalize,
      leaseMs: 60_000,
      heartbeatMs: 30_000,
      retryDelayMs: () => 5_000,
    });
  }

  it("completes a claimed job with a bounded curation outcome", async () => {
    const pending = queue.enqueue({ profileId: "profile-a", sessionId: "session-1", reason: "cli-exit" });
    const finalize = vi.fn(async () => checkpointResult("ignored"));

    await expect(worker(finalize).runOnce()).resolves.toMatchObject({
      status: "completed",
      outcomeCode: "curation-ignored",
    });
    expect(finalize).toHaveBeenCalledWith(expect.objectContaining({ id: pending.id }), expect.any(AbortSignal));
    expect(queue.get(pending.id, "profile-a")).toMatchObject({
      status: "completed",
      outcomeCode: "curation-ignored",
      attempts: 1,
    });
  });

  it("retries transient failures without persisting error text", async () => {
    const pending = queue.enqueue({ profileId: "profile-a", sessionId: "session-1", reason: "cli-exit" });
    const finalize = vi.fn(async () => { throw new Error("provider included secret user text"); });

    await expect(worker(finalize).runOnce()).resolves.toMatchObject({
      status: "retried",
      errorCode: "curation-failed",
    });
    expect(queue.get(pending.id, "profile-a")).toMatchObject({
      status: "pending",
      lastErrorCode: "curation-failed",
    });
    expect(JSON.stringify(queue.get(pending.id, "profile-a"))).not.toContain("secret user text");
  });

  it("fails terminally when the immutable message cutoff is unavailable", async () => {
    const pending = queue.enqueue({ profileId: "profile-a", sessionId: "session-1", reason: "cli-exit" });
    const finalize = vi.fn(async () => {
      throw new MemoryCurationCutoffError(
        "memory-curation-cutoff-missing",
        "private transcript details must not be persisted"
      );
    });

    await expect(worker(finalize).runOnce()).resolves.toMatchObject({
      status: "failed",
      errorCode: "memory-curation-cutoff-missing",
    });
    expect(queue.get(pending.id, "profile-a")).toMatchObject({
      status: "failed",
      lastErrorCode: "memory-curation-cutoff-missing",
    });
  });

  it("honors retry availability and exhausts bounded attempts", async () => {
    const pending = queue.enqueue({ profileId: "profile-a", sessionId: "session-1", reason: "cli-exit" });
    const failing = worker(async () => { throw new Error("offline"); });

    await expect(failing.runOnce()).resolves.toMatchObject({ status: "retried" });
    await expect(failing.runOnce()).resolves.toEqual({ status: "idle" });
    now = new Date("2030-01-01T00:00:05.000Z");
    await expect(failing.runOnce()).resolves.toMatchObject({ status: "retried" });
    now = new Date("2030-01-01T00:00:10.000Z");
    await expect(failing.runOnce()).resolves.toMatchObject({ status: "failed", errorCode: "curation-failed" });
    expect(queue.get(pending.id, "profile-a")).toMatchObject({ status: "failed", attempts: 3 });
  });

  it("returns an interrupted job to the queue during shutdown", async () => {
    const pending = queue.enqueue({ profileId: "profile-a", sessionId: "session-1", reason: "cli-exit" });
    const controller = new AbortController();
    const running = worker(async (_job, signal) => await new Promise<MemoryCurationCheckpointResult>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })).runOnce({ signal: controller.signal });

    controller.abort(new Error("shutdown"));
    await expect(running).resolves.toMatchObject({ status: "retried", errorCode: "worker-stopped" });
    expect(queue.get(pending.id, "profile-a")).toMatchObject({ status: "pending", lastErrorCode: "worker-stopped" });
  });
});

function checkpointResult(status: MemoryCurationCheckpointResult["status"]): MemoryCurationCheckpointResult {
  return {
    status,
    trigger: "runtime-dispose",
    sessionId: "session-1",
    sourceMessageCount: 1,
    reviewedMessageCount: 1,
    extractedFactCount: 0,
    candidateCount: 0,
    autoAppliedCount: 0,
    pendingReviewCount: 0,
    ignoredCount: 0,
    failedCount: 0,
    warnings: [],
  };
}
