import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MemoryCurationBusyError,
  SQLiteMemoryCurationCoordinator,
} from "./memory-curation-coordinator.js";
import { createSQLiteSessionDB } from "../session/session-setup.js";
import type { SQLiteSessionDB } from "../session/sqlite-session-db.js";

describe("SQLiteMemoryCurationCoordinator", () => {
  let tempDir: string;
  let dbPath: string;
  let firstDb: SQLiteSessionDB;
  let secondDb: SQLiteSessionDB;
  let now: Date;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "estacoda-curation-coordinator-"));
    dbPath = join(tempDir, "sessions.sqlite");
    firstDb = await createSQLiteSessionDB({ path: dbPath });
    secondDb = await createSQLiteSessionDB({ path: dbPath });
    now = new Date("2030-01-01T00:00:00.000Z");
  });

  afterEach(async () => {
    firstDb.close();
    secondDb.close();
    await rm(tempDir, { recursive: true, force: true });
  });

  function coordinator(db: SQLiteSessionDB, profileId: string, ownerId: string) {
    return new SQLiteMemoryCurationCoordinator({
      db: db.db,
      profileId,
      ownerId,
      now: () => now,
      leaseMs: 60_000,
      heartbeatMs: 30_000,
    });
  }

  it("serializes curation across processes for the same profile", async () => {
    let releaseFirst!: () => void;
    const firstDone = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = coordinator(firstDb, "profile-a", "worker-a").runExclusive({
      task: async () => {
        await firstDone;
        return "first";
      },
    });

    await expect(coordinator(secondDb, "profile-a", "worker-b").runExclusive({
      task: async () => "second",
    })).rejects.toBeInstanceOf(MemoryCurationBusyError);

    releaseFirst();
    await expect(first).resolves.toBe("first");
    await expect(coordinator(secondDb, "profile-a", "worker-b").runExclusive({
      task: async () => "second",
    })).resolves.toBe("second");
  });

  it("allows different profiles to curate independently", async () => {
    let releaseFirst!: () => void;
    const firstDone = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = coordinator(firstDb, "profile-a", "worker-a").runExclusive({
      task: async () => {
        await firstDone;
        return "first";
      },
    });

    await expect(coordinator(secondDb, "profile-b", "worker-b").runExclusive({
      task: async () => "second",
    })).resolves.toBe("second");
    releaseFirst();
    await first;
  });

  it("reclaims an expired profile lease", async () => {
    firstDb.db.query(
      `insert into memory_curation_leases (
        profile_id, owner_id, acquired_at, lease_expires_at, updated_at
      ) values (?, ?, ?, ?, ?)`
    ).run(
      "profile-a",
      "dead-worker",
      "2029-12-31T23:00:00.000Z",
      "2029-12-31T23:59:59.000Z",
      "2029-12-31T23:00:00.000Z"
    );

    await expect(coordinator(secondDb, "profile-a", "worker-b").runExclusive({
      task: async () => "recovered",
    })).resolves.toBe("recovered");
  });

  it("forwards caller cancellation to the coordinated task", async () => {
    const controller = new AbortController();
    const running = coordinator(firstDb, "profile-a", "worker-a").runExclusive({
      signal: controller.signal,
      task: async (signal) => await new Promise<string>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    });

    controller.abort(new Error("cancelled"));
    await expect(running).rejects.toThrow("cancelled");
    expect(firstDb.db.query("select * from memory_curation_leases").all()).toEqual([]);
  });
});
