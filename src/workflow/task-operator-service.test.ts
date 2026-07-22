import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskAttempt, TaskStep, TaskUsageTotals } from "../contracts/task.js";
import type { ProviderUsageEntry } from "../contracts/provider-usage.js";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import { FixedTaskService, type FixedTaskStepInput } from "./fixed-task-service.js";
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
    expect(task.spendingLimit).toBeUndefined();
    expect(task.executionLimits).not.toHaveProperty("maxEstimatedCostUsd");
    expect(created).toMatchObject({
      executionPreference: "auto",
      execution: "waiting",
      foregroundOwnerActive: false,
      backgroundContinuation: "unknown"
    });
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

  it("snapshots an optional configured monetary default on new root Tasks", () => {
    const bounded = new TaskOperatorService({
      store,
      defaultTaskSpendingLimit: { maxEstimatedCostUsd: 4, warningThresholdPercent: 70 }
    }).begin({ objective: "Bound this Task.", workspace: workspace(), creatorSessionId: "owner" });
    expect(store.getTask(bounded.taskId)?.spendingLimit).toEqual({
      maxEstimatedCostUsd: 4,
      warningThresholdPercent: 70
    });
  });

  it("projects immutable charged failures through Attempt, Step, and Task totals", async () => {
    const created = service.begin({
      objective: "Project charged retries.",
      workspace: workspace(),
      creatorSessionId: "owner"
    });
    const task = store.getTask(created.taskId)!;
    const step = store.listSteps(task.id, task.activePlanRevisionId!)[0]!;
    const attempt = failedAttempt(task.id, step.id, step.planRevisionId);
    store.atomicWrite((tx) => tx.createAttempt(attempt));
    await db.recordProviderUsageEntries([{
      id: "usage-failed-attempt",
      profileId: "alpha",
      sessionId: "owner",
      requestKey: "failed-attempt-request",
      provider: "priced",
      model: "model",
      routeRole: "fallback",
      routeIndex: 1,
      providerAttemptIndex: 1,
      sourceKind: "task",
      pricing: {
        currency: "USD",
        inputPerMillionTokens: 1,
        outputPerMillionTokens: 1,
        fingerprint: "pricing-v1"
      },
      pricingFingerprint: "pricing-v1",
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 120,
      estimatedCostUsd: 0.25,
      usageComplete: true,
      pricingComplete: true,
      incompleteReasons: [],
      taskId: task.id,
      rootTaskId: task.id,
      planRevisionId: step.planRevisionId,
      stepId: step.id,
      attemptId: attempt.id,
      dispatchedAt: now()
    }]);

    const projected = service.status(task.id, "owner");
    expect(projected.usage).toMatchObject({ providerCalls: 1, estimatedCostUsd: 0.25 });
    expect(projected.steps[0]?.usage).toMatchObject({ providerCalls: 1, estimatedCostUsd: 0.25 });
    expect(projected.steps[0]?.attempts).toEqual([
      expect.objectContaining({
        attemptId: attempt.id,
        status: "failed",
        usage: expect.objectContaining({ providerCalls: 1, estimatedCostUsd: 0.25 })
      })
    ]);
  });

  it("projects stable Subagents, direct retry Attempts, trace attribution, Results, and usage without N+1 reads", async () => {
    await db.createSession({ id: "worker-one", profileId: "alpha", parentSessionId: "owner" });
    await db.createSession({ id: "worker-two", profileId: "alpha", parentSessionId: "owner" });
    const seed = service.begin({ objective: "Seed projection policy.", workspace: workspace(), creatorSessionId: "owner" });
    const seedTask = store.getTask(seed.taskId)!;
    const seedStep = store.listSteps(seedTask.id, seedTask.activePlanRevisionId!)[0]!;
    let idSequence = 0;
    const graph = new FixedTaskService({
      store,
      now: () => new Date(now()),
      id: (kind) => `projection-${kind}-${++idSequence}`
    }).create({
      creatorSessionId: "owner",
      source: "delegation",
      objective: "Research two paths and synthesize the result.",
      workspace: workspace(),
      authorityPolicy: seedTask.authorityPolicy,
      executionLimits: seedTask.executionLimits,
      steps: [
        projectionStep(seedStep, "research", "Research authentication", "worker"),
        projectionStep(seedStep, "review", "Review API boundaries", "orchestrator"),
        {
          ...projectionStep(seedStep, "synthesis", "Synthesize the findings", "synthesis"),
          dependsOn: ["research", "review"]
        }
      ]
    });
    const [researchStep] = graph.steps;
    const firstAttempt = projectionAttempt({
      id: "attempt-research-1",
      taskId: graph.task.id,
      stepId: researchStep!.id,
      planRevisionId: graph.revision.id,
      attemptNumber: 1,
      status: "failed",
      workerSessionId: "worker-one",
      createdAt: "2026-01-01T00:00:01.000Z",
      updatedAt: "2026-01-01T00:00:02.000Z",
      completedAt: "2026-01-01T00:00:02.000Z"
    });
    const retryAttempt = projectionAttempt({
      id: "attempt-research-2",
      taskId: graph.task.id,
      stepId: researchStep!.id,
      planRevisionId: graph.revision.id,
      attemptNumber: 2,
      status: "running",
      workerSessionId: "worker-two",
      createdAt: "2026-01-01T00:00:03.000Z",
      updatedAt: "2026-01-01T00:00:04.000Z",
      startedAt: "2026-01-01T00:00:03.000Z"
    });
    store.atomicWrite((tx) => {
      tx.updateTask({
        ...graph.task,
        status: "running",
        startedAt: "2026-01-01T00:00:01.000Z",
        updatedAt: "2026-01-01T00:00:04.000Z"
      });
      tx.updateStep({ ...researchStep!, status: "ready", updatedAt: "2026-01-01T00:00:01.000Z" });
      tx.updateStep({ ...researchStep!, status: "running", updatedAt: "2026-01-01T00:00:04.000Z" });
      tx.createAttempt(firstAttempt);
      tx.createAttempt(retryAttempt);
      tx.appendEvent({
        id: "event-retry-activity",
        profileId: "alpha",
        taskId: graph.task.id,
        planRevisionId: graph.revision.id,
        stepId: researchStep!.id,
        attemptId: retryAttempt.id,
        kind: "attempt-progressed",
        timestamp: "2026-01-01T00:00:04.000Z",
        data: {
          rawToolInput: "must-not-project",
          activity: { kind: "tool", label: "Reading session guards", traceCategory: "read", toolCategory: "files" }
        }
      });
      tx.appendEvent({
        id: "event-retry-preview",
        profileId: "alpha",
        taskId: graph.task.id,
        planRevisionId: graph.revision.id,
        stepId: researchStep!.id,
        attemptId: retryAttempt.id,
        kind: "attempt-progressed",
        timestamp: "2026-01-01T00:00:04.001Z",
        data: {
          activity: {
            kind: "assistant",
            label: "Assistant answer",
            traceCategory: "answer",
            assistantPreview: "The session guards are mapped safely."
          }
        }
      });
      tx.recordResult({
        id: "result-research",
        profileId: "alpha",
        taskId: graph.task.id,
        stepId: researchStep!.id,
        attemptId: retryAttempt.id,
        kind: "summary",
        disposition: "accepted",
        status: "available",
        handle: "task-result://research",
        byteLength: 24,
        contentHash: "b".repeat(64),
        summary: "Safe research summary",
        createdAt: "2026-01-01T00:00:04.000Z"
      });
    });
    await db.recordProviderUsageEntries([
      providerUsageEntry(graph.task.id, graph.revision.id, researchStep!.id, firstAttempt.id, "usage-research-1", 100, 0.01),
      providerUsageEntry(graph.task.id, graph.revision.id, researchStep!.id, retryAttempt.id, "usage-research-2", 200, 0.02)
    ]);
    const usageReads = vi.spyOn(store, "listProviderUsageEntries");

    const projection = service.status(graph.task.id, "owner");

    expect(usageReads).toHaveBeenCalledTimes(1);
    expect(projection.steps.map((step) => ({ position: step.position, role: step.executorRole }))).toEqual([
      { position: 0, role: "worker" },
      { position: 1, role: "orchestrator" },
      { position: 2, role: "synthesis" }
    ]);
    expect(projection.subagents.map((subagent) => subagent.displayLabel)).toEqual(["Subagent 1", "Subagent 2"]);
    expect(projection.subagents).toHaveLength(2);
    expect(projection.subagents[0]).toMatchObject({
      stepId: researchStep!.id,
      position: 0,
      displayIndex: 1,
      role: "worker",
      objective: "Research authentication",
      currentActivity: "Assistant answer",
      currentToolCategory: "files",
      assistantPreview: "The session guards are mapped safely.",
      latestAttempt: {
        attemptId: retryAttempt.id,
        attemptNumber: 2,
        workerSessionId: "worker-two"
      },
      activeAttempt: { attemptId: retryAttempt.id },
      usage: {
        total: { providerCalls: 2, totalTokens: 300, estimatedCostUsd: 0.03 },
        currentAttempt: { providerCalls: 1, totalTokens: 200, estimatedCostUsd: 0.02 }
      }
    });
    expect(projection.subagents[0]?.attempts.map((attempt) => attempt.attemptId)).toEqual([
      firstAttempt.id,
      retryAttempt.id
    ]);
    expect(projection.subagents[0]?.trace).toEqual([
      expect.objectContaining({
        eventId: "event-retry-activity",
        attemptId: retryAttempt.id,
        subagentIndex: 1,
        category: "read",
        label: "Reading session guards · Research authentication"
      }),
      expect.objectContaining({
        eventId: "event-retry-preview",
        attemptId: retryAttempt.id,
        subagentIndex: 1,
        category: "answer",
        label: "The session guards are mapped safely. · Research authentication"
      })
    ]);
    expect(projection.subagents[0]?.results).toEqual([
      expect.objectContaining({
        id: "result-research",
        handle: "task-result://research",
        stepId: researchStep!.id,
        attemptId: retryAttempt.id
      })
    ]);
    expect(JSON.stringify(projection)).not.toContain("must-not-project");
  });

  it("retains a bounded chronological safe Task trace and reports earlier history", () => {
    const created = service.begin({ objective: "Project a bounded trace.", workspace: workspace(), creatorSessionId: "owner" });
    const task = store.getTask(created.taskId)!;
    const step = store.listSteps(task.id, task.activePlanRevisionId!)[0]!;
    store.atomicWrite((tx) => {
      for (let index = 0; index < 520; index += 1) {
        tx.appendEvent({
          id: `trace-event-${String(index).padStart(3, "0")}`,
          profileId: "alpha",
          taskId: task.id,
          stepId: step.id,
          kind: "task-steered",
          timestamp: new Date(Date.parse(now()) + index + 1).toISOString(),
          data: {
            guidance: "must-not-project",
            activity: {
              kind: "tool",
              label: `Safe trace event ${index}`,
              traceCategory: index % 2 === 0 ? "search" : "read"
            }
          }
        });
      }
    });

    const projection = service.status(task.id, "owner");
    const trace = projection.trace;

    expect(trace.events).toHaveLength(512);
    expect(trace.totalEvents).toBe(store.listEvents(task.id, { limit: 1_000 }).length);
    expect(Object.values(trace.categoryCounts).reduce((total, count) => total + count, 0)).toBe(trace.totalEvents);
    expect(trace.categoryCounts).toMatchObject({ search: 260, read: 260 });
    expect(trace.hasEarlierEvents).toBe(true);
    expect(trace.events[0]?.eventId).toBe("trace-event-008");
    expect(trace.events.at(-1)?.eventId).toBe("trace-event-519");
    expect(trace.events.every((event, index, events) =>
      index === 0 || event.timestamp >= events[index - 1]!.timestamp
    )).toBe(true);
    expect(projection.subagents[0]?.traceSummary).toMatchObject({
      totalEvents: expect.any(Number),
      hasEarlierEvents: true,
      categoryCounts: { search: 260, read: 260 }
    });
    expect(JSON.stringify(trace)).not.toContain("must-not-project");
  });

  it("projects durable Task budget balances without inventing a second ledger", () => {
    const bounded = new TaskOperatorService({
      store,
      defaultTaskSpendingLimit: { maxEstimatedCostUsd: 1, warningThresholdPercent: 80 },
      spendingScope: (_kind, ownerId) => ({
        profileId: "alpha",
        kind: "root_task",
        ownerId,
        maxEstimatedCostUsd: 1,
        warningThresholdPercent: 80,
        spentCostUsd: 0.42,
        reservedCostUsd: 0.18,
        state: "available",
        ownerCreatedAt: now(),
        createdAt: now()
      })
    }).begin({ objective: "Show budget state.", workspace: workspace(), creatorSessionId: "owner" });

    expect(bounded.spending).toEqual({
      spentCostUsd: 0.42,
      reservedCostUsd: 0.18,
      remainingCostUsd: 0.4,
      maxEstimatedCostUsd: 1,
      warningThresholdPercent: 80,
      state: "available"
    });
  });

  it("projects live host ownership and safe continuation readiness", () => {
    const readyService = new TaskOperatorService({
      store,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      backgroundContinuation: () => "available"
    });
    const created = readyService.begin({
      objective: "Inspect host ownership.",
      workspace: workspace(),
      creatorSessionId: "owner"
    });
    store.acquireTaskHostLease({
      taskId: created.taskId,
      workspaceIdentityHash: workspace().identityHash,
      ownerId: "foreground-owner-secret",
      kind: "foreground",
      acquiredAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:01:00.000Z"
    });

    const projected = readyService.status(created.taskId, "owner");
    expect(projected).toMatchObject({
      execution: "foreground",
      foregroundOwnerActive: true,
      backgroundContinuation: "available"
    });
    expect(JSON.stringify(projected)).not.toContain("foreground-owner-secret");
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

    expect(task).toMatchObject({ source: "gateway", executionPreference: "background" });
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
          activity: { kind: "tool", label: "Using browser.navigate", traceCategory: "plan", toolCategory: "browser" }
        }
      });
      tx.recordResult({
        id: "result-safe",
        profileId: "alpha",
        taskId: task.id,
        stepId: step.id,
        kind: "summary",
        disposition: "accepted",
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
    expect(projection.steps[0]?.objective).toContain("[REDACTED]");
    expect(projection.subagents[0]?.objective).toContain("[REDACTED]");
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

function projectionStep(
  seed: TaskStep,
  key: string,
  objective: string,
  role: TaskStep["executor"]["role"]
): FixedTaskStepInput {
  return {
    key,
    title: objective,
    objective,
    dependsOn: [],
    executor: { kind: "agent", role },
    childTaskPolicy: "forbid",
    authorityPolicy: seed.authorityPolicy,
    executionLimits: seed.executionLimits,
    retryPolicy: seed.retryPolicy,
    failurePolicy: seed.failurePolicy,
    idempotency: seed.idempotency,
    resultPolicy: seed.resultPolicy
  };
}

function projectionAttempt(input: {
  id: string;
  taskId: string;
  stepId: string;
  planRevisionId: string;
  attemptNumber: number;
  status: TaskAttempt["status"];
  workerSessionId: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}): TaskAttempt {
  return {
    id: input.id,
    profileId: "alpha",
    taskId: input.taskId,
    planRevisionId: input.planRevisionId,
    stepId: input.stepId,
    attemptNumber: input.attemptNumber,
    status: input.status,
    dispatchKey: `dispatch-${input.id}`,
    workerSessionId: input.workerSessionId,
    usage: emptyUsage(),
    ...(input.status === "failed"
      ? { failure: { class: "provider", message: "redacted", retryable: true, uncertainSideEffects: false } }
      : {}),
    resultIds: [],
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    ...(input.startedAt === undefined ? {} : { startedAt: input.startedAt }),
    ...(input.completedAt === undefined ? {} : { completedAt: input.completedAt })
  };
}

function providerUsageEntry(
  taskId: string,
  planRevisionId: string,
  stepId: string,
  attemptId: string,
  id: string,
  totalTokens: number,
  estimatedCostUsd: number
): ProviderUsageEntry {
  return {
    id,
    profileId: "alpha",
    sessionId: "owner",
    requestKey: `request-${id}`,
    provider: "priced",
    model: "model",
    routeRole: "primary",
    routeIndex: 0,
    providerAttemptIndex: 1,
    sourceKind: "task",
    pricing: {
      currency: "USD",
      inputPerMillionTokens: 1,
      outputPerMillionTokens: 1,
      fingerprint: "pricing-v1"
    },
    pricingFingerprint: "pricing-v1",
    inputTokens: totalTokens,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens,
    estimatedCostUsd,
    usageComplete: true,
    pricingComplete: true,
    incompleteReasons: [],
    taskId,
    rootTaskId: taskId,
    planRevisionId,
    stepId,
    attemptId,
    dispatchedAt: now()
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
