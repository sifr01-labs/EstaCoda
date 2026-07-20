import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskAttempt, TaskUsageTotals } from "../contracts/task.js";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import { SQLiteTaskStore } from "./sqlite-task-store.js";
import { TaskOperatorService } from "./task-operator-service.js";

describe("TaskOperatorService", () => {
  let root: string;
  let db: SQLiteSessionDB;
  let store: SQLiteTaskStore;
  let service: TaskOperatorService;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "estacoda-task-operator-"));
    db = new SQLiteSessionDB({ path: join(root, "sessions.sqlite") });
    await db.createSession({ id: "owner", profileId: "alpha" });
    await db.createSession({ id: "other", profileId: "alpha" });
    store = new SQLiteTaskStore({ db: db.db, profileId: "alpha" });
    let sequence = 0;
    service = new TaskOperatorService({
      store,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      eventId: () => `operator-event-${++sequence}`
    });
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("creates a conservative fixed Task linked to the interactive creator", () => {
    const created = service.begin({
      objective: "Inspect the runtime and write a focused fix.",
      workspace: workspace(),
      creatorSessionId: "owner"
    });
    const task = store.getTask(created.taskId)!;
    const step = store.listSteps(task.id, task.activePlanRevisionId!)[0]!;

    expect(created).toMatchObject({ status: "queued", progress: { total: 1, pending: 1 } });
    expect(store.listSessionLinks(task.id)).toEqual([
      expect.objectContaining({ sessionId: "owner", relationship: "creator" })
    ]);
    expect(store.listDeliveryBindings({ taskId: task.id })).toEqual([]);
    expect(step).toMatchObject({
      executor: { kind: "agent", role: "worker" },
      idempotency: "unknown",
      failurePolicy: { onAttemptsExhausted: "wait_for_operator", optional: false }
    });
    expect(step.authorityPolicy.riskClassPolicy["workspace-write"]).toBe("require_approval");
    expect(step.authorityPolicy.riskClassPolicy["external-side-effect"]).toBe("forbid");
    expect(step.authorityPolicy.blockedTools).toContain("terminal.run");
  });

  it("atomically binds an authorized gateway completion destination at creation", () => {
    const created = service.begin({
      objective: "Inspect the runtime and report back.",
      workspace: workspace(),
      creatorSessionId: "owner",
      source: "gateway",
      completionDestination: { platform: "discord", chatId: "channel-1", threadId: "thread-1" }
    });
    const task = store.getTask(created.taskId)!;

    expect(task.source).toBe("gateway");
    expect(store.listSessionLinks(task.id)).toEqual([
      expect.objectContaining({ sessionId: "owner", relationship: "creator" })
    ]);
    expect(store.listDeliveryBindings({ taskId: task.id })).toEqual([
      expect.objectContaining({
        authorizedSessionId: "owner",
        deliveryKey: "origin-completion",
        destination: { platform: "discord", chatId: "channel-1", threadId: "thread-1" },
        status: "pending"
      })
    ]);
  });

  it("rolls back the Task graph and session link when completion binding fails", () => {
    const atomicWrite = store.atomicWrite.bind(store);
    vi.spyOn(store, "atomicWrite").mockImplementation((work) => atomicWrite((transaction) => work(new Proxy(transaction, {
      get(target, property, receiver) {
        if (property === "createDeliveryBinding") {
          return () => { throw new Error("injected delivery binding failure"); };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
    }))));

    expect(() => service.begin({
      objective: "Inspect the runtime and report back.",
      workspace: workspace(),
      creatorSessionId: "owner",
      source: "gateway",
      completionDestination: { platform: "telegram", chatId: "chat-1" }
    })).toThrow("injected delivery binding failure");
    expect(store.listTasks()).toEqual([]);
  });

  it("rejects operator Task creation without a profile-local creator session", () => {
    expect(() => service.begin({
      objective: "Inspect status",
      workspace: workspace(),
      creatorSessionId: "missing"
    })).toThrow();
    expect(store.listTasks()).toEqual([]);
  });

  it("enforces session-scoped reads and creator-only mutation", () => {
    const created = service.begin({ objective: "Inspect status", workspace: workspace(), creatorSessionId: "owner" });
    expect(() => service.status(created.taskId, "other")).toThrow("not found for this session");
    expect(() => service.pause(created.taskId, "other")).toThrow("not found for this session");
    expect(() => service.cancel(created.taskId, "other")).toThrow("not found for this session");
    expect(service.pause(created.taskId, "owner").status).toBe("paused");
    expect(service.resume(created.taskId, "owner").status).toBe("queued");
  });

  it("requeues an operator-waiting Step so the scheduler creates a new Attempt", () => {
    const created = service.begin({ objective: "Inspect status", workspace: workspace(), creatorSessionId: "owner" });
    const task = store.getTask(created.taskId)!;
    const step = store.listSteps(task.id, task.activePlanRevisionId!)[0]!;
    store.atomicWrite((tx) => {
      tx.updateTask({ ...task, status: "running", startedAt: now(), updatedAt: now() });
      tx.updateStep({ ...step, status: "ready", updatedAt: now() });
      tx.updateStep({ ...step, status: "running", updatedAt: now() });
      tx.createAttempt(failedAttempt(task.id, step.id, step.planRevisionId));
      tx.updateStep({ ...step, status: "waiting_for_input", updatedAt: now() });
      tx.updateTask({
        ...task,
        status: "waiting_for_input",
        startedAt: now(),
        updatedAt: now(),
        waitReason: { kind: "operator", summary: "Review retry", requestedAt: now() }
      });
    });

    const retried = service.retry(task.id, step.id, "owner");
    expect(retried.status).toBe("queued");
    expect(store.getStep(step.id)?.status).toBe("ready");
    expect(store.listAttempts(task.id, step.id)).toHaveLength(1);
    expect(store.listEvents(task.id, { kinds: ["step-state-changed"] }).at(-1)?.data).toMatchObject({
      reasonCode: "operator-retry"
    });
  });

  it("cancels queued work durably and keeps status output bounded", () => {
    const created = service.begin({
      objective: `Inspect ${"x".repeat(500)}`,
      workspace: workspace(),
      creatorSessionId: "owner"
    });
    const cancelled = service.cancel(created.taskId, "owner");
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.objective.length).toBeLessThanOrEqual(240);
    expect(store.listSteps(created.taskId, store.getTask(created.taskId)!.activePlanRevisionId!)[0]?.status).toBe("cancelled");
    expect(store.listEvents(created.taskId, { kinds: ["task-state-changed"] }).at(-1)?.data).toMatchObject({
      reasonCode: "operator-request"
    });
  });

  it("projects bounded inspection data without exposing event payloads or internal result metadata", () => {
    const created = service.begin({
      objective: "Inspect sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 and summarize",
      workspace: workspace(),
      creatorSessionId: "owner"
    });
    const task = store.getTask(created.taskId)!;
    const step = store.listSteps(task.id, task.activePlanRevisionId!)[0]!;
    store.atomicWrite((tx) => {
      tx.appendEvent({
        id: "safe-event",
        profileId: "alpha",
        taskId: task.id,
        planRevisionId: step.planRevisionId,
        stepId: step.id,
        kind: "attempt-progressed",
        timestamp: now(),
        data: {
          rawToolInput: "must-not-project",
          activity: { kind: "tool", label: "Using browser.navigate", toolCategory: "browser" }
        }
      });
      tx.recordResult({
        id: "result-safe",
        profileId: "alpha",
        taskId: task.id,
        stepId: step.id,
        kind: "summary",
        status: "available",
        handle: "task-result://safe",
        byteLength: 42,
        contentHash: "a".repeat(64),
        summary: "Bearer abcdefghijklmnopqrstuvwxyz123456",
        createdAt: now()
      });
    });

    const projection = service.status(task.id, "owner");
    expect(projection.objective).toContain("[REDACTED]");
    expect(projection.planRevision).toEqual({ revision: 1, status: "active" });
    expect(projection.steps).toEqual([
      expect.objectContaining({ stepId: step.id, title: "Complete Task", dependsOn: [] })
    ]);
    expect(projection.recentActivity[0]).toMatchObject({
      kind: "attempt-progressed",
      label: "Using browser.navigate · Complete Task"
    });
    expect(JSON.stringify(projection)).not.toContain("must-not-project");
    expect(projection.results[0]?.summary).toBe("Bearer [REDACTED]");
    expect(projection.results[0]).not.toHaveProperty("contentHash");
  });
});

function workspace() {
  return { canonicalPath: "/private/workspace", identityHash: "workspace-hash" };
}

function now() {
  return "2026-01-01T00:00:00.000Z";
}

function failedAttempt(taskId: string, stepId: string, planRevisionId: string): TaskAttempt {
  return {
    id: "attempt-1",
    profileId: "alpha",
    taskId,
    planRevisionId,
    stepId,
    attemptNumber: 1,
    status: "failed",
    dispatchKey: "dispatch-1",
    usage: emptyUsage(),
    failure: { class: "provider", message: "redacted", retryable: false, uncertainSideEffects: false },
    resultIds: [],
    createdAt: now(),
    updatedAt: now(),
    completedAt: now()
  };
}

function emptyUsage(): TaskUsageTotals {
  return {
    providerCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    usageComplete: true,
    pricingComplete: true,
    incompleteReasons: []
  };
}
