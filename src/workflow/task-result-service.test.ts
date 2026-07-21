import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  Task,
  TaskAuthorityDisposition,
  TaskAuthorityPolicy,
  TaskPlanRevision,
  TaskStep
} from "../contracts/task.js";
import { TASK_TOOL_RISK_CLASSES } from "../contracts/task.js";
import type { ToolRiskClass } from "../contracts/tool.js";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import { SQLiteTaskStore } from "./sqlite-task-store.js";
import {
  TaskResultAccessError,
  TaskResultContentError,
  TaskResultService
} from "./task-result-service.js";

describe("TaskResultService", () => {
  let tempDir: string;
  let contentRoot: string;
  let sessionDb: SQLiteSessionDB;
  let store: SQLiteTaskStore;
  let handles: string[];
  let resultIds: string[];
  let eventIds: string[];
  let service: TaskResultService;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "estacoda-task-results-"));
    contentRoot = join(tempDir, "profiles", "alpha", "tasks", "results");
    sessionDb = new SQLiteSessionDB({ path: join(tempDir, "sessions.sqlite") });
    await sessionDb.createSession({ id: "creator-alpha", profileId: "alpha" });
    await sessionDb.createSession({ id: "observer-alpha", profileId: "alpha" });
    await sessionDb.createSession({ id: "unlinked-alpha", profileId: "alpha" });
    await sessionDb.createSession({ id: "session-beta", profileId: "beta" });
    store = new SQLiteTaskStore({ db: sessionDb.db, profileId: "alpha" });
    store.createTaskGraph(makeGraph());
    store.linkSession({
      taskId: "task-alpha",
      profileId: "alpha",
      sessionId: "observer-alpha",
      relationship: "observer",
      createdAt: NOW
    });
    handles = ["handle-1", "handle-2", "handle-3", "handle-4"];
    resultIds = ["result-1", "result-2", "result-3", "result-4"];
    eventIds = ["event-1", "event-2", "event-3", "event-4"];
    service = createService();
  });

  afterEach(() => {
    sessionDb.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("rejects a result service bound to a different TaskStore profile", () => {
    const betaStore = new SQLiteTaskStore({ db: sessionDb.db, profileId: "beta" });

    expect(() => new TaskResultService({
      store: betaStore,
      profileId: "alpha",
      contentRoot
    })).toThrowError(expect.objectContaining({ code: "profile-store-mismatch" }));
  });

  it("persists content outside SQLite and pages Unicode safely after restart", async () => {
    const result = service.record({
      taskId: "task-alpha",
      stepId: "step-alpha",
      kind: "text",
      content: "A😀BC",
      summary: "A durable result."
    });

    expect(result).toMatchObject({
      id: "result-1",
      profileId: "alpha",
      handle: "task-result:handle-1",
      byteLength: 7,
      contentHash: `sha256:${createHash("sha256").update("A😀BC").digest("hex")}`
    });
    expect(sessionDb.db.query<{ name: string }>("pragma table_info(task_results)").all()
      .some((column) => column.name === "content")).toBe(false);
    expect(store.listEvents("task-alpha", { kinds: ["result-recorded"] })).toEqual([
      expect.objectContaining({
        id: "event-1",
        data: expect.objectContaining({ resultId: "result-1", handle: "task-result:handle-1" })
      })
    ]);

    const restarted = createService();
    const first = await restarted.readPage({
      taskId: "task-alpha",
      resultId: result.id,
      sessionId: "creator-alpha",
      maxChars: 2
    });
    expect(first).toMatchObject({ content: "A😀", offset: 0, nextOffset: 2, totalChars: 4, hasMore: true });
    expect(await restarted.readPage({
      taskId: "task-alpha",
      resultId: result.id,
      sessionId: "creator-alpha",
      offset: first.nextOffset,
      maxChars: 2
    })).toMatchObject({ content: "BC", offset: 2, totalChars: 4, hasMore: false });
  });

  it("authorizes only sessions linked to the same profile-owned Task", async () => {
    const result = service.record({ taskId: "task-alpha", kind: "summary", content: "complete" });

    expect((await service.readPage({
      taskId: "task-alpha",
      resultId: result.id,
      sessionId: "observer-alpha"
    })).content).toBe("complete");
    await expect(service.readPage({
      taskId: "task-alpha",
      resultId: result.id,
      sessionId: "unlinked-alpha"
    })).rejects.toThrow(TaskResultAccessError);
    await expect(service.readPage({
      taskId: "task-alpha",
      resultId: result.id,
      sessionId: "session-beta"
    })).rejects.toThrow(TaskResultAccessError);

    const betaService = new TaskResultService({
      store: new SQLiteTaskStore({ db: sessionDb.db, profileId: "beta" }),
      profileId: "beta",
      contentRoot: join(tempDir, "profiles", "beta", "tasks", "results"),
      sessionDb
    });
    await expect(betaService.readPage({
      taskId: "task-alpha",
      resultId: result.id,
      sessionId: "session-beta"
    })).rejects.toThrow(TaskResultAccessError);
  });

  it("preserves access only through verified transcript-compaction ancestry", async () => {
    const result = service.record({ taskId: "task-alpha", kind: "summary", content: "survives compaction" });
    await sessionDb.endSession("creator-alpha", "compression");
    await sessionDb.createSession({
      id: "compacted-alpha",
      profileId: "alpha",
      parentSessionId: "creator-alpha",
      metadata: { compactedFromSessionId: "creator-alpha" }
    });
    await sessionDb.createSession({
      id: "ordinary-child-alpha",
      profileId: "alpha",
      parentSessionId: "creator-alpha",
      metadata: { kind: "delegated-child" }
    });

    expect((await service.readPage({
      taskId: "task-alpha",
      resultId: result.id,
      sessionId: "compacted-alpha"
    })).content).toBe("survives compaction");
    await expect(service.readPage({
      taskId: "task-alpha",
      resultId: result.id,
      sessionId: "ordinary-child-alpha"
    })).rejects.toThrow(TaskResultAccessError);
  });

  it("validates JSON and refuses to render binary artifacts as text", async () => {
    expect(() => service.record({ taskId: "task-alpha", kind: "json", content: "{" }))
      .toThrow(/valid UTF-8 JSON/u);
    const json = service.record({ taskId: "task-alpha", kind: "json", content: "{\"ok\":true}" });
    expect((await service.readPage({
      taskId: "task-alpha",
      resultId: json.id,
      sessionId: "creator-alpha"
    })).content).toBe("{\"ok\":true}");

    const binary = service.record({
      taskId: "task-alpha",
      kind: "artifact",
      content: new Uint8Array([0, 1, 2, 3]),
      mimeType: "application/octet-stream"
    });
    await expect(service.readPage({
      taskId: "task-alpha",
      resultId: binary.id,
      sessionId: "creator-alpha"
    })).rejects.toThrow(/binary/u);
  });

  it("enforces the Step's aggregate result budget and removes rejected content", () => {
    expect(() => service.record({
      taskId: "task-alpha",
      stepId: "step-alpha",
      kind: "json",
      content: "{}"
    })).toThrow(/does not match the Step result policy/u);
    service.record({ taskId: "task-alpha", stepId: "step-alpha", kind: "text", content: "123456" });
    expect(() => service.record({
      taskId: "task-alpha",
      stepId: "step-alpha",
      kind: "text",
      content: "78901"
    })).toThrow(/10-byte limit/u);
    expect(store.listResults("task-alpha")).toHaveLength(1);
    expect(contentFileExists("task-result:handle-2")).toBe(false);
  });

  it("rolls metadata back and deletes content when event persistence fails", () => {
    const duplicateEventService = new TaskResultService({
      store,
      profileId: "alpha",
      contentRoot,
      id: () => resultIds.shift()!,
      handleId: () => handles.shift()!,
      eventId: () => "duplicate-event",
      now: () => new Date(NOW)
    });
    duplicateEventService.record({ taskId: "task-alpha", kind: "summary", content: "first" });
    expect(() => duplicateEventService.record({ taskId: "task-alpha", kind: "summary", content: "second" }))
      .toThrow(/unique/iu);
    expect(store.getResult("result-2")).toBeNull();
    expect(contentFileExists("task-result:handle-2")).toBe(false);
  });

  it("publishes a prepared batch atomically when a later Result insert fails", () => {
    const duplicateEventService = new TaskResultService({
      store,
      profileId: "alpha",
      contentRoot,
      id: () => resultIds.shift()!,
      handleId: () => handles.shift()!,
      eventId: () => "duplicate-batch-event",
      now: () => new Date(NOW)
    });
    const batch = duplicateEventService.prepare([
      { taskId: "task-alpha", kind: "summary", content: "first" },
      { taskId: "task-alpha", kind: "summary", content: "second" }
    ]);

    expect(() => store.atomicWrite((transaction) => duplicateEventService.publishPrepared(batch, transaction)))
      .toThrow(/unique/iu);
    duplicateEventService.discardPrepared(batch);

    expect(store.listResults("task-alpha")).toEqual([]);
    expect(store.listEvents("task-alpha", { kinds: ["result-recorded"] })).toEqual([]);
    expect(contentFileExists("task-result:handle-1")).toBe(false);
    expect(contentFileExists("task-result:handle-2")).toBe(false);
  });

  it("rejects a prepared batch when its Attempt fence is cancelled before publication", () => {
    const task = store.getTask("task-alpha")!;
    const step = store.getStep("step-alpha")!;
    store.updateTask({ ...task, status: "running", startedAt: NOW, updatedAt: NOW });
    store.updateStep({ ...step, status: "ready", updatedAt: NOW });
    store.createAttempt({
      id: "attempt-alpha",
      profileId: "alpha",
      taskId: task.id,
      planRevisionId: step.planRevisionId,
      stepId: step.id,
      attemptNumber: 1,
      status: "queued",
      dispatchKey: "dispatch-alpha",
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
    });
    const lease = store.acquireAttemptLease({
      attemptId: "attempt-alpha",
      ownerId: "scheduler-alpha",
      acquiredAt: NOW,
      expiresAt: "2030-01-01T00:01:00.000Z"
    })!;
    store.updateAttempt({ ...store.getAttempt("attempt-alpha")!, status: "running", startedAt: NOW, updatedAt: NOW });
    store.updateStep({ ...store.getStep("step-alpha")!, status: "running", updatedAt: NOW });
    const batch = service.prepare([{
      taskId: task.id,
      stepId: step.id,
      attemptId: "attempt-alpha",
      kind: "text",
      content: "prepared",
      expectedLease: { ownerId: lease.ownerId, fencingToken: lease.fencingToken }
    }]);

    store.requestAttemptCancellation("attempt-alpha", "2030-01-01T00:00:01.000Z");
    expect(() => store.atomicWrite((transaction) => service.publishPrepared(batch, transaction)))
      .toThrowError(expect.objectContaining({ code: "result-fence-lost" }));
    service.discardPrepared(batch);

    expect(store.listResults(task.id)).toEqual([]);
    expect(contentFileExists("task-result:handle-1")).toBe(false);
  });

  it("removes abandoned prepared bodies when a restarted service recovers", () => {
    const batch = service.prepare([{
      taskId: "task-alpha",
      kind: "summary",
      content: "crash before settlement"
    }]);
    expect(contentFileExists(batch.results[0]!.handle)).toBe(true);
    expect(store.listResults("task-alpha")).toEqual([]);

    const restarted = createService();
    expect(restarted.recoverPrepared()).toEqual({ removed: 1, finalized: 0, unresolved: 0 });
    expect(contentFileExists(batch.results[0]!.handle)).toBe(false);
    expect(store.listResults("task-alpha")).toEqual([]);
  });

  it("preserves committed bodies when restart recovery finds a stale preparation marker", async () => {
    const batch = service.prepare([{
      taskId: "task-alpha",
      kind: "summary",
      content: "committed before marker cleanup"
    }]);
    store.atomicWrite((transaction) => service.publishPrepared(batch, transaction));

    const restarted = createService();
    expect(restarted.recoverPrepared()).toEqual({ removed: 0, finalized: 1, unresolved: 0 });
    expect(contentFileExists(batch.results[0]!.handle)).toBe(true);
    expect((await restarted.readPage({
      taskId: "task-alpha",
      resultId: batch.results[0]!.id,
      sessionId: "creator-alpha"
    })).content).toBe("committed before marker cleanup");
  });

  it("detects content tampering before returning a page", async () => {
    const result = service.record({ taskId: "task-alpha", kind: "text", content: "trusted" });
    writeFileSync(contentPath(result.handle), "tampered", "utf8");

    await expect(service.readPage({
      taskId: "task-alpha",
      resultId: result.id,
      sessionId: "creator-alpha"
    })).rejects.toThrow(/integrity verification/u);
  });

  it("refuses a result body replaced with a symlink", async () => {
    if (process.platform === "win32") return;
    const result = service.record({ taskId: "task-alpha", kind: "text", content: "trusted" });
    const outside = join(tempDir, "outside-result.txt");
    writeFileSync(outside, "trusted", "utf8");
    rmSync(contentPath(result.handle));
    symlinkSync(outside, contentPath(result.handle), "file");

    await expect(service.readPage({
      taskId: "task-alpha",
      resultId: result.id,
      sessionId: "creator-alpha"
    })).rejects.toThrow(/regular file/u);
  });

  it("rejects a symlinked profile result root before writing content", () => {
    if (process.platform === "win32") return;
    const outside = join(tempDir, "outside");
    mkdirSync(outside);
    mkdirSync(join(tempDir, "profiles", "alpha", "tasks"), { recursive: true });
    symlinkSync(outside, contentRoot, "dir");

    expect(() => service.record({ taskId: "task-alpha", kind: "summary", content: "do not write" }))
      .toThrow(/private directory/u);
    expect(readdirSync(outside)).toEqual([]);
    expect(store.listResults("task-alpha")).toEqual([]);
  });

  it("prunes metadata and content without permitting resurrection", async () => {
    const result = service.record({ taskId: "task-alpha", kind: "summary", content: "settled" });
    const path = contentPath(result.handle);
    expect(readFileSync(path, "utf8")).toBe("settled");

    expect(service.prune(result.taskId, result.id)).toMatchObject({ status: "pruned", prunedAt: NOW });
    expect(contentFileExists(result.handle)).toBe(false);
    await expect(service.readPage({
      taskId: result.taskId,
      resultId: result.id,
      sessionId: "creator-alpha"
    })).rejects.toThrow(TaskResultAccessError);
    expect(() => store.updateResult({ ...result, status: "available" })).toThrow(/immutable|Illegal Result/u);
  });

  function createService(): TaskResultService {
    return new TaskResultService({
      store,
      profileId: "alpha",
      contentRoot,
      sessionDb,
      id: () => resultIds.shift()!,
      handleId: () => handles.shift()!,
      eventId: () => eventIds.shift()!,
      now: () => new Date(NOW)
    });
  }

  function contentPath(handle: string): string {
    const digest = createHash("sha256").update(handle).digest("hex");
    return join(contentRoot, digest.slice(0, 2), `${digest}.bin`);
  }

  function contentFileExists(handle: string): boolean {
    try {
      readFileSync(contentPath(handle));
      return true;
    } catch {
      return false;
    }
  }
});

const NOW = "2030-01-01T00:00:00.000Z";

function makeGraph(): { task: Task; revision: TaskPlanRevision; steps: TaskStep[] } {
  const task: Task = {
    id: "task-alpha",
    profileId: "alpha",
    creatorSessionId: "creator-alpha",
    rootTaskId: "task-alpha",
    originSessionId: "creator-alpha",
    source: "cli",
    executionPreference: "auto",
    creationKey: "create-alpha",
    objective: "Produce a durable result.",
    status: "queued",
    workspace: { canonicalPath: "/workspace/project", identityHash: "workspace-hash" },
    authorityPolicy: authorityPolicy(),
    executionLimits: {
      maxConcurrentAttempts: 1,
      maxProviderCalls: 10,
      maxTotalTokens: 10_000,
      maxWallClockMs: 60_000
    },
    activePlanRevisionId: "revision-alpha",
    createdBy: { kind: "user", sessionId: "creator-alpha" },
    createdAt: NOW,
    updatedAt: NOW
  };
  const revision: TaskPlanRevision = {
    id: "revision-alpha",
    profileId: "alpha",
    taskId: task.id,
    revision: 1,
    status: "active",
    reason: "Initial plan.",
    createdBy: task.createdBy,
    createdAt: NOW,
    validatedAt: NOW,
    activatedAt: NOW
  };
  const step: TaskStep = {
    id: "step-alpha",
    profileId: "alpha",
    taskId: task.id,
    planRevisionId: revision.id,
    key: "produce",
    position: 0,
    status: "pending",
    title: "Produce result",
    objective: "Produce the requested result.",
    dependsOn: [],
    executor: { kind: "agent", role: "worker" },
    childTaskPolicy: "forbid",
    authorityPolicy: authorityPolicy(),
    executionLimits: {
      maxProviderCalls: 5,
      maxTotalTokens: 5_000,
      maxWallClockMs: 30_000
    },
    retryPolicy: {
      maxAttempts: 1,
      initialBackoffMs: 0,
      backoffMultiplier: 1,
      maxBackoffMs: 0,
      retryableFailureClasses: [],
      nonRetryableFailureClasses: ["security-deny"],
      requireIdempotent: true
    },
    failurePolicy: { onAttemptsExhausted: "fail_task", optional: false },
    idempotency: "idempotent",
    resultPolicy: { kind: "text", required: true, maxBytes: 10 },
    createdAt: NOW,
    updatedAt: NOW
  };
  return { task, revision, steps: [step] };
}

function authorityPolicy(): TaskAuthorityPolicy {
  return {
    allowedToolsets: ["core"],
    allowedTools: ["task.result.read"],
    blockedTools: [],
    riskClassPolicy: Object.fromEntries(
      TASK_TOOL_RISK_CLASSES.map((riskClass) => [riskClass, riskClass === "read-only-local" ? "runtime_policy" : "forbid"])
    ) as Record<ToolRiskClass, TaskAuthorityDisposition>,
    mayCreateChildTasks: false,
    maxChildDepth: 0
  };
}
