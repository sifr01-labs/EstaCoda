import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  Task,
  TaskAttempt,
  TaskAuthorityDisposition,
  TaskAuthorityPolicy,
  TaskDeliveryBinding,
  TaskPlanRevision,
  TaskResult,
  TaskStep
} from "../contracts/task.js";
import { TASK_TOOL_RISK_CLASSES } from "../contracts/task.js";
import type { ToolRiskClass } from "../contracts/tool.js";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import { openDefaultSQLiteDatabase } from "../storage/factory.js";
import { SQLiteTaskStore, TaskStoreProfileError } from "./sqlite-task-store.js";
import {
  migrateTaskAgentExecutorSchemaV12,
  migrateTaskBackgroundHostSchemaV13,
  migrateTaskSchedulerSchemaV11,
  migrateTaskVerticalSliceSchemaV15,
  TASK_SCHEMA_VERSION
} from "./task-schema.js";

describe("SQLiteTaskStore", () => {
  let tempDir: string;
  let dbPath: string;
  let sessionDb: SQLiteSessionDB;
  let store: SQLiteTaskStore;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "estacoda-task-store-"));
    dbPath = join(tempDir, "sessions.sqlite");
    sessionDb = new SQLiteSessionDB({ path: dbPath });
    await sessionDb.createSession({ id: "session-alpha", profileId: "alpha" });
    await sessionDb.createSession({ id: "worker-alpha", profileId: "alpha" });
    await sessionDb.createSession({ id: "session-beta", profileId: "beta" });
    store = new SQLiteTaskStore({ db: sessionDb.db, profileId: "alpha" });
  });

  afterEach(() => {
    sessionDb.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("installs only the Task persistence schema and enables foreign keys", () => {
    const tables = new Set(sessionDb.db.query<{ name: string }>(
      "select name from sqlite_master where type = 'table'"
    ).all().map((row) => row.name));
    const version = sessionDb.db.query<{ version: number | null }>(
      "select max(version) as version from schema_version"
    ).get()?.version;
    const foreignKeys = sessionDb.db.query<{ foreign_keys: number }>("pragma foreign_keys").get()?.foreign_keys;
    const leaseColumns = sessionDb.db.query<{ name: string }>("pragma table_info(task_attempt_leases)").all();
    const attemptColumns = sessionDb.db.query<{ name: string }>("pragma table_info(task_attempts)").all();

    expect(version).toBe(TASK_SCHEMA_VERSION);
    expect(foreignKeys).toBe(1);
    expect([...TASK_TABLES].every((table) => tables.has(table))).toBe(true);
    expect([...WORKFLOW_TABLES].every((table) => !tables.has(table))).toBe(true);
    expect(leaseColumns.some((column) => column.name === "cancellation_requested_at")).toBe(true);
    expect(attemptColumns.some((column) => column.name === "lease_generation")).toBe(true);
  });

  it("round-trips an immutable plan graph and creator session link atomically", () => {
    const graph = makeGraph("alpha");
    store.createTaskGraph(graph);

    expect(store.getTask(graph.task.id)).toEqual(graph.task);
    expect(store.getPlanRevision(graph.revision.id)).toEqual(graph.revision);
    expect(store.listSteps(graph.task.id, graph.revision.id)).toEqual(graph.steps);
    expect(store.listSessionLinks(graph.task.id)).toEqual([{
      taskId: graph.task.id,
      profileId: "alpha",
      sessionId: "session-alpha",
      relationship: "creator",
      createdAt: NOW
    }]);
    expect(sessionDb.db.query("pragma foreign_key_check").all()).toEqual([]);
  });

  it("rolls back every write when an atomic callback fails", () => {
    const task = { ...makeGraph("alpha").task, id: "task-rollback", activePlanRevisionId: undefined };

    expect(() => store.atomicWrite((tx) => {
      tx.createTask(task);
      throw new Error("simulated failure");
    })).toThrow("simulated failure");

    expect(store.getTask(task.id)).toBeNull();
  });

  it("fails closed for cross-profile reads, inputs, and session ownership", () => {
    const alphaGraph = makeGraph("alpha");
    const betaGraph = makeGraph("beta");
    const betaStore = new SQLiteTaskStore({ db: sessionDb.db, profileId: "beta" });
    store.createTaskGraph(alphaGraph);
    betaStore.createTaskGraph(betaGraph);

    expect(store.getTask(betaGraph.task.id)).toBeNull();
    expect(betaStore.getTask(alphaGraph.task.id)).toBeNull();
    expect(() => store.createTask({
      ...alphaGraph.task,
      id: "task-wrong-session",
      activePlanRevisionId: undefined,
      creatorSessionId: "session-beta"
    })).toThrow(TaskStoreProfileError);
    expect(() => store.createTask({ ...betaGraph.task, id: "task-forged", activePlanRevisionId: undefined }))
      .toThrow(TaskStoreProfileError);
  });

  it("enforces Task creation and Attempt dispatch idempotency independently", () => {
    const graph = makeGraph("alpha");
    store.createTaskGraph(graph);
    expect(() => store.createTask({
      ...graph.task,
      id: "task-duplicate-creation",
      activePlanRevisionId: undefined
    })).toThrow(/unique/i);

    const first = makeAttempt("attempt-1");
    store.createAttempt(first);
    expect(() => store.createAttempt({
      ...first,
      id: "attempt-2",
      attemptNumber: 2
    })).toThrow(/unique/i);
  });

  it("enforces profile, state, active-plan, and fencing constraints inside SQLite", () => {
    const graph = makeGraph("alpha");
    store.createTaskGraph(graph);
    store.createAttempt(makeAttempt("attempt-1", true));

    expect(() => sessionDb.db.query(
      `insert into task_session_links (
        task_id, profile_id, session_id, relationship, step_id, attempt_id, created_at
      ) values (?, ?, ?, ?, ?, ?, ?)`
    ).run(graph.task.id, "alpha", "session-beta", "observer", null, null, NOW)).toThrow(/foreign key/i);
    expect(() => sessionDb.db.query(
      "update tasks set status = 'not-a-task-state' where id = ?"
    ).run(graph.task.id)).toThrow(/check constraint/i);
    expect(() => sessionDb.db.query(
      "update task_attempt_leases set fencing_token = 0 where attempt_id = ?"
    ).run("attempt-1")).toThrow(/check constraint/i);
    const revision2 = {
      ...graph.revision,
      id: "revision-alpha-2",
      revision: 2,
      status: "draft" as const,
      validatedAt: undefined,
      activatedAt: undefined
    };
    const steps2 = graph.steps.map((step) => ({
      ...step,
      id: `${step.id}-2`,
      planRevisionId: revision2.id,
      dependsOn: step.dependsOn.map((dependencyId) => `${dependencyId}-2`)
    }));
    store.createPlanRevisionGraph(revision2, steps2);
    const validatedRevision2 = { ...revision2, status: "validated" as const, validatedAt: NOW };
    store.updatePlanRevision(validatedRevision2);
    expect(() => store.updatePlanRevision({ ...validatedRevision2, status: "active", activatedAt: NOW }))
      .toThrow(/unique/i);
  });

  it("round-trips Attempts, fenced leases, Results, and bounded Events", () => {
    const graph = makeGraph("alpha");
    store.createTaskGraph(graph);
    const attempt = makeAttempt("attempt-1", true);
    store.createAttempt(attempt);
    const result = makeResult();
    store.recordResult(result);
    store.appendEvent({
      id: "event-result",
      profileId: "alpha",
      taskId: graph.task.id,
      planRevisionId: graph.revision.id,
      stepId: "step-research-alpha",
      attemptId: attempt.id,
      kind: "result-recorded",
      timestamp: NOW,
      data: { resultId: result.id }
    });

    expect(store.getAttempt(attempt.id)).toEqual({ ...attempt, resultIds: [result.id] });
    expect(store.getResult(result.id)).toEqual(result);
    expect(store.listEvents(graph.task.id, { attemptId: attempt.id })).toEqual([
      expect.objectContaining({ id: "event-result", data: { resultId: result.id } })
    ]);
  });

  it("persists authorized completion delivery and claims it only after Task settlement", () => {
    const graph = makeGraph("alpha");
    store.createTaskGraph(graph);
    const binding: TaskDeliveryBinding = {
      id: "delivery-alpha",
      profileId: "alpha",
      taskId: graph.task.id,
      authorizedSessionId: "session-alpha",
      deliveryKey: "origin-completion",
      destination: { platform: "telegram", chatId: "chat-1", threadId: "thread-1" },
      status: "pending",
      createdAt: NOW,
      updatedAt: NOW
    };

    store.atomicWrite((tx) => tx.createDeliveryBinding(binding));
    expect(store.getDeliveryBinding(binding.id)).toEqual(binding);
    expect(store.claimDeliveryBinding(binding.id, "2030-01-01T00:00:01.000Z")).toBeNull();

    const running = { ...graph.task, status: "running" as const, startedAt: NOW, updatedAt: NOW };
    store.updateTask(running);
    store.updateTask({
      ...running,
      status: "completed",
      completedAt: "2030-01-01T00:00:02.000Z",
      updatedAt: "2030-01-01T00:00:02.000Z"
    });
    expect(store.claimDeliveryBinding(binding.id, "2030-01-01T00:00:03.000Z"))
      .toMatchObject({ status: "delivering", startedAt: "2030-01-01T00:00:03.000Z" });
    expect(store.settleDeliveryBinding({
      id: binding.id,
      status: "delivered",
      settledAt: "2030-01-01T00:00:04.000Z"
    })).toMatchObject({ status: "delivered", deliveredAt: "2030-01-01T00:00:04.000Z" });
    expect(store.claimDeliveryBinding(binding.id, "2030-01-01T00:00:05.000Z")).toBeNull();
    expect(new SQLiteTaskStore({ db: sessionDb.db, profileId: "beta" }).getDeliveryBinding(binding.id)).toBeNull();
  });

  it("rejects unlinked, malformed, and duplicate completion delivery bindings", () => {
    const graph = makeGraph("alpha");
    store.createTaskGraph(graph);
    const binding: TaskDeliveryBinding = {
      id: "delivery-alpha",
      profileId: "alpha",
      taskId: graph.task.id,
      authorizedSessionId: "worker-alpha",
      deliveryKey: "completion",
      destination: { platform: "telegram", chatId: "chat-1" },
      status: "pending",
      createdAt: NOW,
      updatedAt: NOW
    };
    expect(() => store.atomicWrite((tx) => tx.createDeliveryBinding(binding))).toThrow(TaskStoreProfileError);

    store.linkSession({
      taskId: graph.task.id,
      profileId: "alpha",
      sessionId: "worker-alpha",
      relationship: "observer",
      createdAt: NOW
    });
    store.atomicWrite((tx) => tx.createDeliveryBinding(binding));
    expect(() => store.atomicWrite((tx) => tx.createDeliveryBinding({
      ...binding,
      id: "delivery-duplicate-key"
    }))).toThrow(/unique/i);
    expect(() => store.atomicWrite((tx) => tx.createDeliveryBinding({
      ...binding,
      id: "delivery-malformed",
      deliveryKey: "malformed",
      destination: { platform: "telegram", chatId: "" }
    }))).toThrow(/destination/i);
  });

  it("acquires, renews, cancellation-marks, and releases Attempt leases with fencing", () => {
    store.createTaskGraph(makeGraph("alpha"));
    store.createAttempt(makeAttempt("attempt-1"));

    const lease = store.acquireAttemptLease({
      attemptId: "attempt-1",
      ownerId: "scheduler-1",
      acquiredAt: NOW,
      expiresAt: "2030-01-01T00:01:00.000Z"
    });
    expect(lease).toMatchObject({ ownerId: "scheduler-1", fencingToken: 1 });
    expect(store.getAttempt("attempt-1")).toMatchObject({ status: "leased", lease });
    expect(store.acquireAttemptLease({
      attemptId: "attempt-1",
      ownerId: "scheduler-2",
      acquiredAt: NOW,
      expiresAt: "2030-01-01T00:01:00.000Z"
    })).toBeNull();

    expect(store.renewAttemptLease({
      attemptId: "attempt-1",
      ownerId: "scheduler-1",
      fencingToken: 1,
      heartbeatAt: "2030-01-01T00:00:30.000Z",
      expiresAt: "2030-01-01T00:02:00.000Z"
    })).toMatchObject({ heartbeatAt: "2030-01-01T00:00:30.000Z", expiresAt: "2030-01-01T00:02:00.000Z" });
    expect(store.renewAttemptLease({
      attemptId: "attempt-1",
      ownerId: "scheduler-2",
      fencingToken: 1,
      heartbeatAt: "2030-01-01T00:00:31.000Z",
      expiresAt: "2030-01-01T00:02:01.000Z"
    })).toBeNull();

    expect(store.requestAttemptCancellation("attempt-1", "2030-01-01T00:00:40.000Z"))
      .toMatchObject({ cancellationRequestedAt: "2030-01-01T00:00:40.000Z" });
    expect(store.renewAttemptLease({
      attemptId: "attempt-1",
      ownerId: "scheduler-1",
      fencingToken: 1,
      heartbeatAt: "2030-01-01T00:00:50.000Z",
      expiresAt: "2030-01-01T00:03:00.000Z"
    })).toMatchObject({
      cancellationRequestedAt: "2030-01-01T00:00:40.000Z",
      expiresAt: "2030-01-01T00:02:00.000Z"
    });
    expect(store.releaseAttemptLease({ attemptId: "attempt-1", ownerId: "scheduler-2", fencingToken: 1 }))
      .toBe(false);
    expect(store.releaseAttemptLease({ attemptId: "attempt-1", ownerId: "scheduler-1", fencingToken: 1 }))
      .toBe(true);
    expect(store.getAttempt("attempt-1")?.lease).toBeUndefined();
    store.updateAttempt({ ...store.getAttempt("attempt-1")!, status: "queued", updatedAt: "2030-01-01T00:01:00.000Z" });
    expect(store.acquireAttemptLease({
      attemptId: "attempt-1",
      ownerId: "scheduler-2",
      acquiredAt: "2030-01-01T00:01:01.000Z",
      expiresAt: "2030-01-01T00:02:01.000Z"
    })).toMatchObject({ ownerId: "scheduler-2", fencingToken: 2 });
  });

  it("rejects in-place plan mutation after persistence", () => {
    const graph = makeGraph("alpha");
    store.createTaskGraph(graph);
    const persisted = store.getStep("step-research-alpha")!;

    expect(() => store.updateStep({ ...persisted, objective: "A rewritten objective." }))
      .toThrow("Step definition is immutable");
    expect(store.getStep(persisted.id)?.objective).toBe(persisted.objective);
  });

  it("rejects illegal durable state transitions before writing", () => {
    const graph = makeGraph("alpha");
    store.createTaskGraph(graph);
    const persisted = store.getStep("step-research-alpha")!;

    expect(() => store.updateStep({ ...persisted, status: "completed" }))
      .toThrow("Illegal step transition");
    expect(store.getStep(persisted.id)?.status).toBe("pending");
  });

  it("rejects oversized Event metadata before it reaches SQLite", () => {
    const graph = makeGraph("alpha");
    store.createTaskGraph(graph);

    expect(() => store.appendEvent({
      id: "event-oversized",
      profileId: "alpha",
      taskId: graph.task.id,
      kind: "task-created",
      timestamp: NOW,
      data: { value: "x".repeat(17 * 1024) }
    })).toThrow("Event data exceeds");
  });

  it("rejects asynchronous transaction callbacks and invalidates their transaction store", () => {
    const graph = makeGraph("alpha");
    let transactionStore: import("./task-store.js").TaskStore | undefined;

    expect(() => store.atomicWrite((tx) => {
      transactionStore = tx;
      return Promise.resolve();
    })).toThrow("must be synchronous");

    expect(() => transactionStore!.createTask({ ...graph.task, activePlanRevisionId: undefined }))
      .toThrow("transaction is no longer active");
    expect(store.getTask(graph.task.id)).toBeNull();
  });
});

describe("Task schema migrations", () => {
  it("drops Workflow persistence while preserving unrelated session data", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "estacoda-task-migration-"));
    const dbPath = join(tempDir, "sessions.sqlite");
    const legacy = openDefaultSQLiteDatabase({ path: dbPath });
    try {
      legacy.exec(`
        create table sessions (
          id text primary key,
          profile_id text not null default 'default',
          title text,
          created_at text not null,
          updated_at text not null,
          parent_session_id text,
          ended_at text,
          end_reason text,
          metadata_json text
        );
        create table messages (
          id text primary key,
          session_id text not null references sessions(id) on delete cascade,
          role text not null,
          content text not null,
          created_at text not null,
          channel text,
          metadata_json text
        );
        create virtual table messages_fts using fts5(message_id unindexed, content, tokenize = 'unicode61');
        create table session_events (
          id text primary key,
          session_id text not null references sessions(id) on delete cascade,
          created_at text not null,
          event_json text not null
        );
        create table trajectories (
          id text primary key,
          session_id text not null references sessions(id) on delete cascade,
          profile_id text not null,
          model_id text not null,
          created_at text not null,
          completed_at text,
          event_count integer not null default 0,
          events_json text not null,
          outcome_json text,
          compressed_json text
        );
        create table trajectory_failures (
          id text primary key,
          trajectory_id text not null references trajectories(id) on delete cascade,
          session_id text not null,
          timestamp text not null,
          class text not null,
          message text not null,
          recoverable integer not null default 0,
          context_json text
        );
        create table schema_version (version integer primary key);
        insert into schema_version(version) values (9);
        insert into sessions(id, profile_id, title, created_at, updated_at)
          values ('preserved-session', 'alpha', 'Preserve me', '${NOW}', '${NOW}');
        insert into messages(id, session_id, role, content, created_at)
          values ('preserved-message', 'preserved-session', 'user', 'still here', '${NOW}');
        create table workflow_runs(id text primary key, session_id text not null);
        insert into workflow_runs(id, session_id) values ('discarded-run', 'preserved-session');
        create table workflow_steps(
          id text primary key,
          workflow_run_id text not null references workflow_runs(id) on delete cascade
        );
        insert into workflow_steps(id, workflow_run_id) values ('discarded-step', 'discarded-run');
      `);
    } finally {
      legacy.close();
    }

    const migrated = new SQLiteSessionDB({ path: dbPath });
    try {
      await expect(migrated.getSession("preserved-session")).resolves.toMatchObject({ title: "Preserve me" });
      await expect(migrated.listMessages("preserved-session")).resolves.toEqual([
        expect.objectContaining({ id: "preserved-message", content: "still here" })
      ]);
      expect(migrated.db.query<{ name: string }>(
        "select name from sqlite_master where type = 'table' and name = 'workflow_runs'"
      ).get()).toBeNull();
      expect(migrated.db.query<{ name: string }>(
        "select name from sqlite_master where type = 'table' and name = 'tasks'"
      ).get()).toEqual({ name: "tasks" });
      expect(migrated.db.query<{ version: number }>(
        "select max(version) as version from schema_version"
      ).get()?.version).toBe(TASK_SCHEMA_VERSION);
    } finally {
      migrated.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("Task scheduler schema v11 migration", () => {
  it("adds cancellation requests idempotently without replacing existing leases", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "estacoda-task-scheduler-migration-"));
    const database = openDefaultSQLiteDatabase({ path: join(tempDir, "scheduler.sqlite") });
    try {
      database.exec(`
        create table task_attempt_leases (
          attempt_id text primary key,
          profile_id text not null,
          task_id text not null,
          owner_id text not null,
          fencing_token integer not null,
          acquired_at text not null,
          heartbeat_at text not null,
          expires_at text not null
        );
        insert into task_attempt_leases values (
          'attempt-1', 'alpha', 'task-1', 'scheduler-1', 3,
          '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:10.000Z', '2030-01-01T00:01:00.000Z'
        );
      `);

      migrateTaskSchedulerSchemaV11(database);
      migrateTaskSchedulerSchemaV11(database);

      expect(database.query<{ owner_id: string; fencing_token: number; cancellation_requested_at: string | null }>(
        "select owner_id, fencing_token, cancellation_requested_at from task_attempt_leases"
      ).get()).toEqual({ owner_id: "scheduler-1", fencing_token: 3, cancellation_requested_at: null });
    } finally {
      database.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("Task agent executor schema v12 migration", () => {
  it("preserves existing Task events and admits fenced progress events idempotently", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "estacoda-task-agent-migration-"));
    const database = openDefaultSQLiteDatabase({ path: join(tempDir, "agent.sqlite") });
    try {
      database.exec(`
        pragma foreign_keys = on;
        create table tasks(id text primary key, profile_id text not null, unique(profile_id, id));
        create table task_plan_revisions(
          id text primary key, profile_id text not null, task_id text not null,
          unique(profile_id, task_id, id)
        );
        create table task_steps(
          id text primary key, profile_id text not null, task_id text not null,
          unique(profile_id, task_id, id)
        );
        create table task_attempts(
          id text primary key, profile_id text not null, task_id text not null,
          unique(profile_id, task_id, id)
        );
        create table task_events (
          id text primary key,
          profile_id text not null,
          task_id text not null,
          plan_revision_id text,
          step_id text,
          attempt_id text,
          kind text not null check(kind in ('task-created', 'attempt-started')),
          timestamp text not null,
          data_json text not null check(json_valid(data_json)),
          unique(profile_id, id),
          foreign key(profile_id, task_id) references tasks(profile_id, id),
          foreign key(profile_id, task_id, plan_revision_id)
            references task_plan_revisions(profile_id, task_id, id),
          foreign key(profile_id, task_id, step_id)
            references task_steps(profile_id, task_id, id),
          foreign key(profile_id, task_id, attempt_id)
            references task_attempts(profile_id, task_id, id)
        );
        create index idx_task_events_task on task_events(profile_id, task_id, timestamp, id);
        create index idx_task_events_attempt on task_events(profile_id, attempt_id, timestamp);
        insert into tasks values ('task-1', 'alpha');
        insert into task_events values (
          'event-1', 'alpha', 'task-1', null, null, null,
          'task-created', '${NOW}', '{"preserved":true}'
        );
      `);

      migrateTaskAgentExecutorSchemaV12(database);
      migrateTaskAgentExecutorSchemaV12(database);
      database.query(
        `insert into task_events values (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run("event-2", "alpha", "task-1", null, null, null, "attempt-progressed", NOW, "{}");

      expect(database.query<{ id: string; kind: string; data_json: string }>(
        "select id, kind, data_json from task_events order by id"
      ).all()).toEqual([
        { id: "event-1", kind: "task-created", data_json: '{"preserved":true}' },
        { id: "event-2", kind: "attempt-progressed", data_json: "{}" }
      ]);
      expect(database.query("pragma foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("Task background host schema v13 migration", () => {
  it("adds the completion delivery outbox idempotently", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "estacoda-task-host-migration-"));
    const database = openDefaultSQLiteDatabase({ path: join(tempDir, "host.sqlite") });
    try {
      database.exec(`
        pragma foreign_keys = on;
        create table sessions(id text primary key, profile_id text not null, unique(profile_id, id));
        create table tasks(id text primary key, profile_id text not null, unique(profile_id, id));
      `);
      migrateTaskBackgroundHostSchemaV13(database);
      migrateTaskBackgroundHostSchemaV13(database);
      expect(database.query<{ name: string }>(
        "select name from sqlite_master where type = 'table' and name = 'task_delivery_bindings'"
      ).get()).toEqual({ name: "task_delivery_bindings" });
      expect(database.query("pragma foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("Task vertical slice schema v15 migration", () => {
  it("preserves events and adds durable steering idempotently", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "estacoda-task-vertical-migration-"));
    const database = openDefaultSQLiteDatabase({ path: join(tempDir, "vertical.sqlite") });
    try {
      database.exec(`
        pragma foreign_keys = on;
        create table sessions(id text primary key, profile_id text not null, unique(profile_id, id));
        create table tasks(id text primary key, profile_id text not null, unique(profile_id, id));
        create table task_plan_revisions(
          id text primary key, profile_id text not null, task_id text not null,
          unique(profile_id, task_id, id)
        );
        create table task_steps(
          id text primary key, profile_id text not null, task_id text not null,
          unique(profile_id, task_id, id)
        );
        create table task_attempts(
          id text primary key, profile_id text not null, task_id text not null,
          unique(profile_id, task_id, id)
        );
        create table task_events (
          id text primary key,
          profile_id text not null,
          task_id text not null,
          plan_revision_id text,
          step_id text,
          attempt_id text,
          kind text not null check(kind in ('task-created', 'attempt-progressed')),
          timestamp text not null,
          data_json text not null check(json_valid(data_json)),
          unique(profile_id, id),
          foreign key(profile_id, task_id) references tasks(profile_id, id),
          foreign key(profile_id, task_id, plan_revision_id)
            references task_plan_revisions(profile_id, task_id, id),
          foreign key(profile_id, task_id, step_id)
            references task_steps(profile_id, task_id, id),
          foreign key(profile_id, task_id, attempt_id)
            references task_attempts(profile_id, task_id, id)
        );
        create index idx_task_events_task on task_events(profile_id, task_id, timestamp, id);
        create index idx_task_events_attempt on task_events(profile_id, attempt_id, timestamp);
        insert into sessions values ('session-1', 'alpha');
        insert into tasks values ('task-1', 'alpha');
        insert into task_events values (
          'event-1', 'alpha', 'task-1', null, null, null,
          'task-created', '${NOW}', '{"preserved":true}'
        );
      `);

      migrateTaskVerticalSliceSchemaV15(database);
      migrateTaskVerticalSliceSchemaV15(database);
      database.query(
        `insert into task_guidance values (?, ?, ?, ?, ?, ?)`
      ).run("guidance-1", "alpha", "task-1", "session-1", "Use primary sources.", NOW);
      database.query(
        `insert into task_events values (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run("event-2", "alpha", "task-1", null, null, null, "task-steered", NOW, "{}");

      expect(database.query<{ id: string; kind: string }>(
        "select id, kind from task_events order by id"
      ).all()).toEqual([
        { id: "event-1", kind: "task-created" },
        { id: "event-2", kind: "task-steered" }
      ]);
      expect(database.query("pragma foreign_key_check").all()).toEqual([]);
    } finally {
      database.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

const NOW = "2030-01-01T00:00:00.000Z";

function makeGraph(profileId: "alpha" | "beta") {
  const suffix = profileId;
  const taskId = `task-${suffix}`;
  const revisionId = `revision-${suffix}`;
  const creatorSessionId = `session-${suffix}`;
  const task: Task = {
    id: taskId,
    profileId,
    creatorSessionId,
    source: "cli",
    creationKey: `create-${suffix}`,
    objective: "Research and summarize the requested topic.",
    status: "queued",
    workspace: { canonicalPath: "/workspace/project", identityHash: "workspace-hash" },
    authorityPolicy: taskAuthority(),
    budgetPolicy: {
      maxConcurrentAttempts: 2,
      maxProviderCalls: 20,
      maxTotalTokens: 100_000,
      maxEstimatedCostUsd: 5,
      maxWallClockMs: 3_600_000
    },
    activePlanRevisionId: revisionId,
    createdBy: { kind: "user", sessionId: creatorSessionId },
    createdAt: NOW,
    updatedAt: NOW
  };
  const revision: TaskPlanRevision = {
    id: revisionId,
    profileId,
    taskId,
    revision: 1,
    status: "active",
    reason: "Initial plan.",
    createdBy: { kind: "user", sessionId: creatorSessionId },
    createdAt: NOW,
    validatedAt: NOW,
    activatedAt: NOW
  };
  const steps: TaskStep[] = [
    makeStep({ id: `step-research-${suffix}`, key: "research", position: 0, profileId, taskId, revisionId }),
    makeStep({
      id: `step-summarize-${suffix}`,
      key: "summarize",
      position: 1,
      dependsOn: [`step-research-${suffix}`],
      profileId,
      taskId,
      revisionId
    })
  ];
  return { task, revision, steps };
}

function makeStep(input: {
  id: string;
  key: string;
  position: number;
  dependsOn?: readonly string[];
  profileId: string;
  taskId: string;
  revisionId: string;
}): TaskStep {
  return {
    id: input.id,
    profileId: input.profileId,
    taskId: input.taskId,
    planRevisionId: input.revisionId,
    key: input.key,
    position: input.position,
    status: "pending",
    title: `Execute ${input.key}`,
    objective: `Complete ${input.key}.`,
    dependsOn: input.dependsOn ?? [],
    executor: { kind: "agent", role: "worker" },
    authorityPolicy: stepAuthority(),
    budget: {
      maxProviderCalls: 5,
      maxTotalTokens: 20_000,
      maxEstimatedCostUsd: 1,
      maxWallClockMs: 600_000
    },
    retryPolicy: {
      maxAttempts: 2,
      initialBackoffMs: 100,
      backoffMultiplier: 2,
      maxBackoffMs: 1_000,
      retryableFailureClasses: ["transient"],
      nonRetryableFailureClasses: ["security-deny"],
      requireIdempotent: true
    },
    failurePolicy: { onAttemptsExhausted: "fail_task", optional: false },
    idempotency: "idempotent",
    resultPolicy: { kind: "text", required: true, maxBytes: 50_000 },
    createdAt: NOW,
    updatedAt: NOW
  };
}

function makeAttempt(id: string, withLease = false): TaskAttempt {
  return {
    id,
    profileId: "alpha",
    taskId: "task-alpha",
    planRevisionId: "revision-alpha",
    stepId: "step-research-alpha",
    attemptNumber: 1,
    status: withLease ? "leased" : "queued",
    dispatchKey: "dispatch-research-1",
    workerSessionId: "worker-alpha",
    ...(withLease ? {
      lease: {
        attemptId: id,
        profileId: "alpha",
        taskId: "task-alpha",
        ownerId: "host-1",
        fencingToken: 1,
        acquiredAt: NOW,
        heartbeatAt: NOW,
        expiresAt: "2030-01-01T00:01:00.000Z"
      }
    } : {}),
    usage: {
      providerCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      usageComplete: true,
      pricingComplete: true,
      incompleteReasons: []
    },
    resultIds: [],
    createdAt: NOW,
    updatedAt: NOW
  };
}

function makeResult(): TaskResult {
  return {
    id: "result-1",
    profileId: "alpha",
    taskId: "task-alpha",
    stepId: "step-research-alpha",
    attemptId: "attempt-1",
    kind: "summary",
    status: "available",
    handle: "task-result:result-1",
    byteLength: 128,
    contentHash: "sha256:result",
    mimeType: "text/plain",
    summary: "Research complete.",
    createdAt: NOW
  };
}

function taskAuthority(): TaskAuthorityPolicy {
  return {
    allowedToolsets: ["files", "web"],
    allowedTools: ["file.read", "web.search"],
    blockedTools: ["terminal.run"],
    riskClassPolicy: riskPolicy({
      "read-only-local": "runtime_policy",
      "read-only-network": "runtime_policy",
      "workspace-write": "require_approval"
    }),
    mayCreateChildTasks: true,
    maxChildDepth: 2
  };
}

function stepAuthority(): TaskAuthorityPolicy {
  return {
    allowedToolsets: ["files"],
    allowedTools: ["file.read"],
    blockedTools: ["terminal.run"],
    riskClassPolicy: riskPolicy({ "read-only-local": "runtime_policy" }),
    mayCreateChildTasks: false,
    maxChildDepth: 0
  };
}

function riskPolicy(
  overrides: Partial<Record<ToolRiskClass, TaskAuthorityDisposition>>
): Record<ToolRiskClass, TaskAuthorityDisposition> {
  return Object.fromEntries(
    TASK_TOOL_RISK_CLASSES.map((riskClass) => [riskClass, overrides[riskClass] ?? "forbid"])
  ) as Record<ToolRiskClass, TaskAuthorityDisposition>;
}

const TASK_TABLES = [
  "tasks",
  "task_plan_revisions",
  "task_steps",
  "task_step_dependencies",
  "task_attempts",
  "task_attempt_leases",
  "task_results",
  "task_events",
  "task_session_links",
  "task_guidance",
  "task_usage_entries",
  "task_approval_links",
  "task_delivery_bindings"
] as const;

const WORKFLOW_TABLES = [
  "workflow_runs",
  "workflow_steps",
  "workflow_events",
  "workflow_operator_events",
  "workflow_checkpoints",
  "workflow_approval_gates",
  "workflow_locks",
  "workflow_processes",
  "workflow_artifacts",
  "workflow_agent_run_links",
  "workflow_event_summaries"
] as const;
