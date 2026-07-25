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

    await expect(service.runOnce()).resolves.toEqual({
      recovered: 0, recoveryFailed: 0, claimed: 1, delivered: 1, failed: 0
    });
    expect(deliverText).toHaveBeenCalledTimes(1);
    const [targets, text] = deliverText.mock.calls[0]!;
    expect(targets).toEqual([{ kind: "channel", platform: "telegram", chatId: "chat-1", threadId: "thread-1" }]);
    expect(text).toContain("A durable answer.");
    expect(text).toContain("Artifact handle: task-result:handle-2");
    expect(text).toContain("Task total:");
    expect(text).toContain("Produce result: unavailable");
    expect(text).not.toContain(tempDir);
    await expect(service.runOnce()).resolves.toEqual({
      recovered: 0, recoveryFailed: 0, claimed: 0, delivered: 0, failed: 0
    });
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

  it("delivers a deterministic failure receipt instead of diagnostic output or a substitute answer", async () => {
    store.createTaskGraph(makeSynthesisGraph());
    resultService.record({
      taskId: "task-synthesis",
      stepId: "step-synthesis-worker",
      kind: "text",
      disposition: "diagnostic",
      content: "Incomplete worker text must not become the requested answer."
    });
    completeTask("task-synthesis");
    const deliverText = vi.fn(async (_targets: DeliveryTarget[], _text: string) =>
      new Map([["telegram:chat-1", { success: true }]]));
    const service = createService(deliverText);
    service.bind({
      taskId: "task-synthesis",
      authorizedSessionId: "creator-alpha",
      deliveryKey: "failed-synthesis",
      destination: { platform: "telegram", chatId: "chat-1" }
    });

    await service.runOnce();

    expect(deliverText).toHaveBeenCalledOnce();
    const text = deliverText.mock.calls[0]![1];
    expect(text).toContain("The delegated Task settled without an accepted answer.");
    expect(text).toContain("No substitute answer was generated.");
    expect(text).not.toContain("Incomplete worker text");
    await service.runOnce();
    expect(deliverText).toHaveBeenCalledOnce();
  });

  it("localizes the external no-answer receipt in Arabic", async () => {
    store.createTaskGraph(makeSynthesisGraph());
    completeTask("task-synthesis");
    const deliverText = vi.fn(async (_targets: DeliveryTarget[], _text: string) =>
      new Map([["telegram:chat-1", { success: true }]]));
    const service = createService(deliverText, "ar");
    service.bind({
      taskId: "task-synthesis",
      authorizedSessionId: "creator-alpha",
      deliveryKey: "failed-synthesis-ar",
      destination: { platform: "telegram", chatId: "chat-1" }
    });

    await service.runOnce();

    const text = deliverText.mock.calls[0]![1];
    expect(text).toContain("اكتملت Task المفوضة من دون إجابة مقبولة");
    expect(text).toContain("لم تُنشأ إجابة بديلة");
  });

  it("leaves local CLI completion bindings for the interactive session", async () => {
    resultService.record({ taskId: "task-alpha", kind: "text", content: "Local answer." });
    completeTask();
    store.atomicWrite((transaction) => transaction.createDeliveryBinding({
      id: "delivery-cli",
      profileId: "alpha",
      taskId: "task-alpha",
      authorizedSessionId: "creator-alpha",
      deliveryKey: "local-completion",
      destination: { platform: "cli" },
      status: "pending",
      createdAt: NOW,
      updatedAt: NOW,
    }));
    const deliverText = vi.fn(async (_targets: DeliveryTarget[], _text: string) => new Map());
    const service = createService(deliverText);

    await expect(service.runOnce()).resolves.toEqual({
      recovered: 0, recoveryFailed: 0, claimed: 0, delivered: 0, failed: 0
    });
    expect(deliverText).not.toHaveBeenCalled();
    expect(store.getDeliveryBinding("delivery-cli")?.status).toBe("pending");
  });

  it("delivers a threshold warning to the authorized remote origin before Task completion", async () => {
    const deliverText = vi.fn(async (_targets: DeliveryTarget[], _text: string) =>
      new Map([["telegram:chat-1", { success: true }]]));
    const service = createService(deliverText);
    const binding = service.bind({
      taskId: "task-alpha",
      authorizedSessionId: "creator-alpha",
      deliveryKey: "origin-warning",
      destination: { platform: "telegram", chatId: "chat-1" }
    });
    sessionDb.db.query(
      `insert into provider_spending_scopes (
        profile_id, kind, owner_id, max_estimated_cost_usd, warning_threshold_percent,
        spent_cost_usd, reserved_cost_usd, state, owner_created_at, created_at, warning_reached_at
      ) values (?, 'root_task', ?, 5, 80, 0, 4, 'warning', ?, ?, ?)`
    ).run("alpha", "task-alpha", NOW, NOW, NOW);
    sessionDb.db.query(
      `insert into provider_spending_warnings (
        id, profile_id, scope_kind, scope_owner_id, session_id, root_task_id,
        warning_threshold_percent, max_estimated_cost_usd, committed_cost_usd, occurred_at,
        delivery_binding_id, delivery_status
      ) values (?, ?, 'root_task', ?, ?, ?, 80, 5, 4, ?, ?, 'pending')`
    ).run(
      "warning-1",
      "alpha",
      "task-alpha",
      "creator-alpha",
      "task-alpha",
      NOW,
      binding.id
    );

    await expect(service.runOnce()).resolves.toEqual({
      recovered: 0, recoveryFailed: 0, claimed: 1, delivered: 1, failed: 0
    });
    expect(deliverText).toHaveBeenCalledOnce();
    expect(deliverText.mock.calls[0]![1]).toContain("Estimated spending warning");
    expect(deliverText.mock.calls[0]![1]).toContain("$4.00 of $5.00");
    expect(store.getDeliveryBinding(binding.id)?.status).toBe("pending");
    expect(store.listProviderSpendingWarningDeliveries()).toEqual([
      expect.objectContaining({ id: "warning-1", deliveryStatus: "delivered" })
    ]);
    await expect(service.runOnce()).resolves.toEqual({
      recovered: 0, recoveryFailed: 0, claimed: 0, delivered: 0, failed: 0
    });
    expect(deliverText).toHaveBeenCalledOnce();
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

    await expect(service.runOnce()).resolves.toEqual({
      recovered: 0, recoveryFailed: 0, claimed: 0, delivered: 0, failed: 0
    });
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

    expect(service.recoverInterrupted()).toEqual({ recovered: 1, failed: 0 });
    expect(store.getDeliveryBinding(binding.id)).toMatchObject({
      status: "failed",
      failureClass: "delivery-outcome-unknown"
    });
    expect(() => service.retry(binding.id, "creator-alpha")).toThrow(/ambiguous external outcome/u);
    expect(deliverText).not.toHaveBeenCalled();
  });

  it("isolates a failed interrupted binding and continues recovering healthy bindings", () => {
    completeTask();
    for (const id of ["delivery-corrupt", "delivery-healthy"]) {
      store.atomicWrite((transaction) => transaction.createDeliveryBinding({
        id,
        profileId: "alpha",
        taskId: "task-alpha",
        authorizedSessionId: "creator-alpha",
        deliveryKey: id,
        destination: { platform: "telegram", chatId: id },
        status: "pending",
        createdAt: NOW,
        updatedAt: NOW
      }));
      expect(store.claimDeliveryBinding(id, NOW)?.status).toBe("delivering");
    }
    const settleDeliveryBinding = store.settleDeliveryBinding.bind(store);
    vi.spyOn(store, "settleDeliveryBinding").mockImplementation((input) => {
      if (input.id === "delivery-corrupt") throw new TypeError("corrupt binding row");
      return settleDeliveryBinding(input);
    });

    expect(createService(vi.fn()).recoverInterrupted()).toEqual({ recovered: 1, failed: 1 });
    expect(store.getDeliveryBinding("delivery-corrupt")?.status).toBe("delivering");
    expect(store.getDeliveryBinding("delivery-healthy")).toMatchObject({
      status: "failed",
      failureClass: "delivery-outcome-unknown"
    });
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

  function createService(
    deliverText: TaskCompletionDeliveryRouter["deliverText"],
    locale: "en" | "ar" = "en"
  ) {
    return new TaskCompletionDeliveryService({
      store,
      resultService,
      router: { deliverText },
      id: () => "delivery-1",
      now: () => new Date(NOW),
      locale
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
      executionLimits: { maxProviderCalls: 5, maxTotalTokens: 5_000, maxWallClockMs: 30_000 },
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
