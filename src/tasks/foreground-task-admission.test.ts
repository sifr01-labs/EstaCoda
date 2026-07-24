import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import type { InitialTaskHostLeaseInput } from "./task-store.js";
import { SQLiteTaskStore } from "./sqlite-task-store.js";
import { TaskOperatorService } from "./task-operator-service.js";

const PROFILE_ID = "alpha";
const WORKSPACE = { canonicalPath: "/workspace/alpha", identityHash: "workspace-alpha" } as const;
const START = Date.parse("2030-01-01T00:00:00.000Z");
const LEASE_MS = 60_000;

describe("atomic foreground Task admission", () => {
  let root: string;
  let databasePath: string;
  let creatorDb: SQLiteSessionDB | undefined;
  let observerDb: SQLiteSessionDB;
  let creatorStore: SQLiteTaskStore;
  let observerStore: SQLiteTaskStore;
  let nowMs: number;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "estacoda-task-admission-"));
    databasePath = join(root, "sessions.sqlite");
    nowMs = START;
    creatorDb = new SQLiteSessionDB({ path: databasePath, now });
    await creatorDb.createSession({ id: "interactive", profileId: PROFILE_ID });
    observerDb = new SQLiteSessionDB({ path: databasePath, now });
    creatorStore = new SQLiteTaskStore({ db: creatorDb.db, profileId: PROFILE_ID });
    observerStore = new SQLiteTaskStore({ db: observerDb.db, profileId: PROFILE_ID });
  });

  afterEach(() => {
    creatorDb?.close();
    observerDb.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("makes a new interactive Task visible with foreground ownership already established", () => {
    const created = operator(creatorStore).begin({
      objective: "Start immediately in the interactive process.",
      workspace: WORKSPACE,
      creatorSessionId: "interactive",
      executionPreference: "auto",
      initialHostLease: foregroundAdmission()
    });

    expect(observerStore.getTask(created.taskId)).toMatchObject({
      id: created.taskId,
      executionPreference: "auto",
      status: "queued"
    });
    expect(observerStore.getTaskHostLease(created.taskId)).toMatchObject({
      taskId: created.taskId,
      ownerId: "foreground-interactive",
      kind: "foreground",
      fencingToken: 1
    });
    expect(observerStore.acquireTaskHostLease({
      taskId: created.taskId,
      workspaceIdentityHash: WORKSPACE.identityHash,
      ownerId: "gateway",
      kind: "background",
      acquiredAt: now().toISOString(),
      expiresAt: new Date(nowMs + LEASE_MS).toISOString()
    })).toBeNull();
  });

  it("leaves background-preferred Tasks eligible for immediate gateway ownership", () => {
    const created = operator(creatorStore).begin({
      objective: "Run directly in the background.",
      workspace: WORKSPACE,
      creatorSessionId: "interactive",
      executionPreference: "background"
    });

    expect(observerStore.getTaskHostLease(created.taskId)).toBeNull();
    expect(observerStore.acquireTaskHostLease({
      taskId: created.taskId,
      workspaceIdentityHash: WORKSPACE.identityHash,
      ownerId: "gateway",
      kind: "background",
      acquiredAt: now().toISOString(),
      expiresAt: new Date(nowMs + LEASE_MS).toISOString()
    })).toMatchObject({ ownerId: "gateway", kind: "background", fencingToken: 1 });
  });

  it("preserves a just-created Task across a foreground crash and permits takeover only after expiry", () => {
    const created = operator(creatorStore).begin({
      objective: "Survive an immediate interactive process crash.",
      workspace: WORKSPACE,
      creatorSessionId: "interactive",
      executionPreference: "auto",
      initialHostLease: foregroundAdmission()
    });

    creatorDb!.close();
    creatorDb = undefined;
    expect(observerStore.getTask(created.taskId)).not.toBeNull();
    expect(observerStore.getTaskHostLease(created.taskId)).toMatchObject({ kind: "foreground", fencingToken: 1 });

    nowMs += LEASE_MS + 1;
    expect(observerStore.acquireTaskHostLease({
      taskId: created.taskId,
      workspaceIdentityHash: WORKSPACE.identityHash,
      ownerId: "gateway",
      kind: "background",
      acquiredAt: now().toISOString(),
      expiresAt: new Date(nowMs + LEASE_MS).toISOString()
    })).toMatchObject({ ownerId: "gateway", kind: "background", fencingToken: 2 });
  });

  it("rolls back the whole graph when initial foreground lease persistence fails", () => {
    const invalidAdmission: InitialTaskHostLeaseInput = {
      ...foregroundAdmission(),
      acquiredAt: "not-a-timestamp"
    };

    expect(() => operator(creatorStore).begin({
      objective: "Never expose a partially admitted Task.",
      workspace: WORKSPACE,
      creatorSessionId: "interactive",
      executionPreference: "auto",
      initialHostLease: invalidAdmission
    })).toThrow(/lease acquisition/i);

    expect(creatorStore.listTasks()).toEqual([]);
    expect(observerStore.listTasks()).toEqual([]);
  });

  function now(): Date {
    return new Date(nowMs);
  }

  function foregroundAdmission(): InitialTaskHostLeaseInput {
    return {
      workspaceIdentityHash: WORKSPACE.identityHash,
      ownerId: "foreground-interactive",
      kind: "foreground",
      acquiredAt: now().toISOString(),
      expiresAt: new Date(nowMs + LEASE_MS).toISOString()
    };
  }

  function operator(store: SQLiteTaskStore): TaskOperatorService {
    return new TaskOperatorService({ store, now });
  }
});
