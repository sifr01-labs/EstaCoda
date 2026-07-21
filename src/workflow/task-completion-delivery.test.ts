import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Task,
  TaskAuthorityDisposition,
  TaskAuthorityPolicy,
  TaskPlanRevision,
  TaskStep
} from "../contracts/task.js";
import { TASK_TOOL_RISK_CLASSES } from "../contracts/task.js";
import type { ToolRiskClass } from "../contracts/tool.js";
import type { DeliveryTarget } from "../channels/delivery-router.js";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import { SQLiteTaskStore } from "./sqlite-task-store.js";
import {
  TaskCompletionDeliveryService,
  type TaskCompletionDeliveryRouter
} from "./task-completion-delivery.js";
import { TaskResultService } from "./task-result-service.js";

const NOW = "2030-01-01T00:00:00.000Z";

describe("TaskCompletionDeliveryService", () => {
  let tempDir: string;
  let sessionDb: SQLiteSessionDB;
  let store: SQLiteTaskStore;
  let resultService: TaskResultService;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "estacoda-task-delivery-"));
    sessionDb = new SQLiteSessionDB({ path: join(tempDir, "sessions.sqlite") });
    await sessionDb.createSession({ id: "creator-alpha", profileId: "alpha" });
    await sessionDb.createSession({ id: "unlinked-alpha", profileId: "alpha" });
    store = new SQLiteTaskStore({ db: sessionDb.db, profileId: "alpha" });
    store.createTaskGraph(makeGraph());
    let resultId = 0;
    resultService = new TaskResultService({
      store,
      profileId: "alpha",
      contentRoot: join(tempDir, "results"),
      sessionDb,
      id: () => `result-${++resultId}`,
      handleId: () => `handle-${resultId}`,
      eventId: () => `event-${resultId}`,
      now: () => new Date(NOW)
    });
  });

  afterEach(() => {
    sessionDb.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("delivers terminal text and opaque artifact handles exactly once", async () => {
    resultService.record({ taskId: "task-alpha", kind: "text", content: "A durable answer." });
    resultService.record({
      taskId: "task-alpha",
      kind: "artifact",
      content: new Uint8Array([1, 2, 3]),
      mimeType: "application/octet-stream",
      summary: "Binary output"
    });
    completeTask();
    const deliverText = vi.fn(async (_targets: DeliveryTarget[], _text: string) =>
      new Map([["telegram:chat-1:thread-1", { success: true }]]));
    const service = createService(deliverText);
    service.bind({
      taskId: "task-alpha",
      authorizedSessionId: "creator-alpha",
      deliveryKey: "origin",
      destination: { platform: "telegram", chatId: "chat-1", threadId: "thread-1" }
    });

    await expect(service.runOnce()).resolves.toEqual({ recovered: 0, claimed: 1, delivered: 1, failed: 0 });
    expect(deliverText).toHaveBeenCalledTimes(1);
    const [targets, text] = deliverText.mock.calls[0]!;
    expect(targets).toEqual([{ kind: "channel", platform: "telegram", chatId: "chat-1", threadId: "thread-1" }]);
    expect(text).toContain("A durable answer.");
    expect(text).toContain("Artifact handle: task-result:handle-2");
    expect(text).not.toContain(tempDir);
    await expect(service.runOnce()).resolves.toEqual({ recovered: 0, claimed: 0, delivered: 0, failed: 0 });
    expect(deliverText).toHaveBeenCalledTimes(1);
  });

  it("delivers the synthesis Result as primary without expanding intermediate worker bodies", async () => {
    store.createTaskGraph(makeSynthesisGraph());
    resultService.record({
      taskId: "task-synthesis",
      stepId: "step-synthesis-worker",
      kind: "text",
      content: "Intermediate worker evidence that should stay behind its handle."
    });
    resultService.record({
      taskId: "task-synthesis",
      stepId: "step-synthesis-primary",
      kind: "text",
      content: "The final synthesized answer."
    });
    completeTask("task-synthesis");
    const deliverText = vi.fn(async (_targets: DeliveryTarget[], _text: string) =>
      new Map([["telegram:chat-1", { success: true }]]));
    const service = createService(deliverText);
    service.bind({
      taskId: "task-synthesis",
      authorizedSessionId: "creator-alpha",
      deliveryKey: "synthesis",
      destination: { platform: "telegram", chatId: "chat-1" }
    });

    await service.runOnce();
    const text = deliverText.mock.calls[0]![1];
    expect(text).toContain("Primary result result-2");
    expect(text).toContain("The final synthesized answer.");
    expect(text).toContain("1 intermediate result(s) remain available through task.result.read.");
    expect(text).not.toContain("Intermediate worker evidence");
  });

  it("keeps delivery pending until its Task reaches a terminal state", async () => {
    const deliverText = vi.fn(async (_targets: DeliveryTarget[], _text: string) =>
      new Map([["telegram:chat-1", { success: true }]]));
    const service = createService(deliverText);
    const binding = service.bind({
      taskId: "task-alpha",
      authorizedSessionId: "creator-alpha",
      deliveryKey: "origin",
      destination: { platform: "telegram", chatId: "chat-1" }
    });

    await expect(service.runOnce()).resolves.toEqual({ recovered: 0, claimed: 0, delivered: 0, failed: 0 });
    expect(store.getDeliveryBinding(binding.id)?.status).toBe("pending");
    expect(deliverText).not.toHaveBeenCalled();
  });

  it("records delivery failure without automatically retrying an external side effect", async () => {
    completeTask();
    const deliverText = vi.fn(async (_targets: DeliveryTarget[], _text: string) => new Map([["email:owner@example.com", {
      success: false,
      error: "sensitive transport detail"
    }]]));
    const service = createService(deliverText);
    const binding = service.bind({
      taskId: "task-alpha",
      authorizedSessionId: "creator-alpha",
      deliveryKey: "email",
      destination: { platform: "email", address: "owner@example.com" }
    });

    await expect(service.runOnce()).resolves.toMatchObject({ claimed: 1, failed: 1 });
    expect(store.getDeliveryBinding(binding.id)).toMatchObject({
      status: "failed",
      failureClass: "delivery-failed",
      failureMessage: "Task completion delivery failed."
    });
    expect(JSON.stringify(store.getDeliveryBinding(binding.id))).not.toContain("sensitive transport detail");
    await service.runOnce();
    expect(deliverText).toHaveBeenCalledTimes(1);
  });

  it("fails closed after restart when a previous external delivery outcome is ambiguous", () => {
    completeTask();
    const deliverText = vi.fn(async (_targets: DeliveryTarget[], _text: string) =>
      new Map([["telegram:chat-1", { success: true }]]));
    const service = createService(deliverText);
    const binding = service.bind({
      taskId: "task-alpha",
      authorizedSessionId: "creator-alpha",
      deliveryKey: "origin",
      destination: { platform: "telegram", chatId: "chat-1" }
    });
    expect(store.claimDeliveryBinding(binding.id, "2030-01-01T00:00:02.000Z")?.status).toBe("delivering");

    expect(service.recoverInterrupted()).toBe(1);
    expect(store.getDeliveryBinding(binding.id)).toMatchObject({
      status: "failed",
      failureClass: "delivery-outcome-unknown"
    });
    expect(() => service.retry(binding.id, "creator-alpha")).toThrow(/ambiguous external outcome/u);
    expect(deliverText).not.toHaveBeenCalled();
  });

  it("does not retry a transport exception with an unknown external outcome", async () => {
    completeTask();
    const service = createService(vi.fn(async () => {
      throw new Error("transport disconnected after send");
    }));
    const binding = service.bind({
      taskId: "task-alpha",
      authorizedSessionId: "creator-alpha",
      deliveryKey: "uncertain",
      destination: { platform: "telegram", chatId: "chat-1" }
    });

    await expect(service.runOnce()).resolves.toMatchObject({ claimed: 1, failed: 1 });
    expect(store.getDeliveryBinding(binding.id)).toMatchObject({
      status: "failed",
      failureClass: "delivery-outcome-unknown"
    });
    expect(() => service.retry(binding.id, "creator-alpha")).toThrow(/ambiguous external outcome/u);
  });

  it("requires a linked profile-owned session and a concrete channel destination", () => {
    const service = createService(vi.fn());
    expect(() => service.bind({
      taskId: "task-alpha",
      authorizedSessionId: "unlinked-alpha",
      deliveryKey: "origin",
      destination: { platform: "telegram", chatId: "chat-1" }
    })).toThrow(/not authorized/u);
    expect(() => service.bind({
      taskId: "task-alpha",
      authorizedSessionId: "creator-alpha",
      deliveryKey: "invalid",
      destination: { platform: "telegram", chatId: "" }
    })).toThrow(/chat ID is invalid/u);
  });

  function createService(deliverText: TaskCompletionDeliveryRouter["deliverText"]) {
    return new TaskCompletionDeliveryService({
      store,
      resultService,
      router: { deliverText },
      id: () => "delivery-1",
      now: () => new Date(NOW)
    });
  }

  function completeTask(taskId = "task-alpha"): void {
    const task = store.getTask(taskId)!;
    const running = { ...task, status: "running" as const, startedAt: NOW, updatedAt: NOW };
    store.updateTask(running);
    store.updateTask({ ...running, status: "completed", completedAt: NOW, updatedAt: NOW });
  }
});

function makeGraph(): { task: Task; revision: TaskPlanRevision; steps: TaskStep[] } {
  const authority = authorityPolicy();
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
    authorityPolicy: authority,
    budgetPolicy: {
      maxConcurrentAttempts: 1,
      maxProviderCalls: 10,
      maxTotalTokens: 10_000,
      maxEstimatedCostUsd: 1,
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
  return {
    task,
    revision,
    steps: [{
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
      authorityPolicy: authority,
      budget: { maxProviderCalls: 5, maxTotalTokens: 5_000, maxEstimatedCostUsd: 1, maxWallClockMs: 30_000 },
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
      resultPolicy: { kind: "text", required: true, maxBytes: 10_000 },
      createdAt: NOW,
      updatedAt: NOW
    }]
  };
}

function makeSynthesisGraph(): { task: Task; revision: TaskPlanRevision; steps: TaskStep[] } {
  const base = makeGraph();
  const task: Task = {
    ...base.task,
    id: "task-synthesis",
    rootTaskId: "task-synthesis",
    creationKey: "create-synthesis",
    activePlanRevisionId: "revision-synthesis"
  };
  const revision: TaskPlanRevision = {
    ...base.revision,
    id: "revision-synthesis",
    taskId: task.id
  };
  const worker: TaskStep = {
    ...base.steps[0]!,
    id: "step-synthesis-worker",
    taskId: task.id,
    planRevisionId: revision.id
  };
  const synthesis: TaskStep = {
    ...worker,
    id: "step-synthesis-primary",
    key: "synthesis",
    position: 1,
    title: "Synthesize result",
    objective: "Return the primary terminal answer.",
    dependsOn: [worker.id],
    executor: { kind: "agent", role: "synthesis" }
  };
  return { task, revision, steps: [worker, synthesis] };
}

function authorityPolicy(): TaskAuthorityPolicy {
  return {
    allowedToolsets: ["files"],
    allowedTools: ["file.read"],
    blockedTools: [],
    riskClassPolicy: Object.fromEntries(
      TASK_TOOL_RISK_CLASSES.map((riskClass) => [riskClass, riskClass === "read-only-local" ? "runtime_policy" : "forbid"])
    ) as Record<ToolRiskClass, TaskAuthorityDisposition>,
    mayCreateChildTasks: false,
    maxChildDepth: 0
  };
}
