import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  Task,
  TaskAuthorityDisposition,
  TaskAuthorityPolicy,
  TaskDeliveryBinding,
  TaskPlanRevision,
  TaskStep,
} from "../contracts/task.js";
import { TASK_TOOL_RISK_CLASSES } from "../contracts/task.js";
import type { ToolRiskClass } from "../contracts/tool.js";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import { SQLiteTaskStore } from "./sqlite-task-store.js";
import { TaskResultService } from "./task-result-service.js";
import {
  TaskSessionCompletionService,
  taskSessionCompletionMessageId,
} from "./task-session-completion.js";

const NOW = "2030-01-01T00:00:00.000Z";

describe("TaskSessionCompletionService", () => {
  let tempDir: string;
  let sessionDb: SQLiteSessionDB;
  let store: SQLiteTaskStore;
  let results: TaskResultService;
  let service: TaskSessionCompletionService;
  let currentNowMs: number;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "estacoda-task-session-completion-"));
    sessionDb = new SQLiteSessionDB({ path: join(tempDir, "sessions.sqlite") });
    await sessionDb.createSession({ id: "creator-alpha", profileId: "alpha" });
    await sessionDb.createSession({ id: "unlinked-alpha", profileId: "alpha" });
    store = new SQLiteTaskStore({ db: sessionDb.db, profileId: "alpha" });
    store.createTaskGraph(makeSynthesisGraph());
    createCliBinding();
    currentNowMs = Date.parse(NOW);
    let sequence = 0;
    results = new TaskResultService({
      store,
      profileId: "alpha",
      contentRoot: join(tempDir, "results"),
      sessionDb,
      id: () => `result-${++sequence}`,
      handleId: () => `handle-${sequence}`,
      eventId: () => `event-${sequence}`,
      now: () => new Date(currentNowMs),
    });
    service = new TaskSessionCompletionService({
      store,
      resultService: results,
      sessionDb,
      profileId: "alpha",
      now: () => new Date(currentNowMs),
    });
  });

  afterEach(() => {
    sessionDb.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("appends only the accepted synthesis answer to the creator transcript exactly once", async () => {
    results.record({
      taskId: "task-synthesis",
      stepId: "step-worker",
      kind: "text",
      content: "Intermediate worker evidence must remain in Task inspection.",
    });
    const primary = results.record({
      taskId: "task-synthesis",
      stepId: "step-synthesis",
      kind: "text",
      content: "The final synthesized answer.",
    });
    completeTask();

    const delivered = await service.deliverPending("creator-alpha");
    expect(delivered).toEqual([
      expect.objectContaining({
        bindingId: "delivery-cli",
        taskId: "task-synthesis",
        resultId: primary.id,
        text: "The final synthesized answer.",
      }),
    ]);
    expect(store.getDeliveryBinding("delivery-cli")?.status).toBe("delivering");
    await acknowledge(delivered[0]!);
    await expect(service.deliverPending("creator-alpha")).resolves.toEqual([]);
    const messages = await sessionDb.listMessages("creator-alpha");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "agent",
      channel: "cli",
      content: "The final synthesized answer.",
      metadata: {
        taskCompletion: {
          version: 1,
          bindingId: "delivery-cli",
          taskId: "task-synthesis",
          resultId: primary.id,
        },
      },
    });
    expect(messages[0]?.content).not.toContain("Intermediate worker evidence");
    expect(store.getDeliveryBinding("delivery-cli")?.status).toBe("delivered");
  });

  it("delivers after transcript-preserving compaction into the active descendant session", async () => {
    results.record({
      taskId: "task-synthesis",
      stepId: "step-synthesis",
      kind: "text",
      content: "Answer after compaction.",
    });
    completeTask();
    await sessionDb.endSession("creator-alpha", "compression");
    await sessionDb.createSession({
      id: "compacted-alpha",
      profileId: "alpha",
      parentSessionId: "creator-alpha",
      metadata: { compactedFromSessionId: "creator-alpha" },
    });

    const delivered = await service.deliverPending("compacted-alpha");
    expect(delivered).toEqual([
      expect.objectContaining({ text: "Answer after compaction." }),
    ]);
    await service.acknowledge({
      sessionId: "compacted-alpha",
      bindingId: delivered[0]!.bindingId,
      messageId: delivered[0]!.messageId,
    });
    expect(await sessionDb.listMessages("creator-alpha")).toEqual([]);
    expect(await sessionDb.listMessages("compacted-alpha")).toEqual([
      expect.objectContaining({ role: "agent", content: "Answer after compaction." }),
    ]);
  });

  it("does not deliver to an unlinked session", async () => {
    results.record({
      taskId: "task-synthesis",
      stepId: "step-synthesis",
      kind: "text",
      content: "Private synthesized answer.",
    });
    completeTask();

    await expect(service.deliverPending("unlinked-alpha")).resolves.toEqual([]);
    expect(await sessionDb.listMessages("unlinked-alpha")).toEqual([]);
    expect(store.getDeliveryBinding("delivery-cli")?.status).toBe("pending");
  });

  it("does not let an unlinked session acknowledge a displayed completion", async () => {
    results.record({
      taskId: "task-synthesis",
      stepId: "step-synthesis",
      kind: "text",
      content: "Creator-only answer.",
    });
    completeTask();
    const delivered = await service.deliverPending("creator-alpha");

    await expect(service.acknowledge({
      sessionId: "unlinked-alpha",
      bindingId: delivered[0]!.bindingId,
      messageId: delivered[0]!.messageId,
    })).rejects.toThrow("unauthorized");
    expect(store.getDeliveryBinding("delivery-cli")?.status).toBe("delivering");
    await acknowledge(delivered[0]!);
    expect(store.getDeliveryBinding("delivery-cli")?.status).toBe("delivered");
  });

  it("safely retries an interrupted local claim", async () => {
    const primary = results.record({
      taskId: "task-synthesis",
      stepId: "step-synthesis",
      kind: "text",
      content: "Already appended answer.",
    });
    completeTask();
    expect(store.claimDeliveryBinding("delivery-cli", NOW)?.status).toBe("delivering");
    currentNowMs += 30_001;
    const digest = await service.deliverPending("creator-alpha");
    expect(digest).toEqual([expect.objectContaining({ resultId: primary.id, text: "Already appended answer." })]);
    await acknowledge(digest[0]!);
    expect(await sessionDb.listMessages("creator-alpha")).toHaveLength(1);
    expect(store.getDeliveryBinding("delivery-cli")?.status).toBe("delivered");
  });

  it("does not steal a fresh local delivery claim from another CLI process", async () => {
    results.record({
      taskId: "task-synthesis",
      stepId: "step-synthesis",
      kind: "text",
      content: "Claimed by another process.",
    });
    completeTask();
    expect(store.claimDeliveryBinding("delivery-cli", NOW)?.status).toBe("delivering");
    currentNowMs += 10_000;

    const recovered = await service.deliverPending("creator-alpha");
    expect(recovered).toEqual([]);
    expect(await sessionDb.listMessages("creator-alpha")).toEqual([]);
    expect(store.getDeliveryBinding("delivery-cli")?.status).toBe("delivering");
  });

  it("settles an interrupted claim when its deterministic message was already appended", async () => {
    const primary = results.record({
      taskId: "task-synthesis",
      stepId: "step-synthesis",
      kind: "text",
      content: "Persisted before the process stopped.",
    });
    completeTask();
    expect(store.claimDeliveryBinding("delivery-cli", NOW)?.status).toBe("delivering");
    await sessionDb.appendMessage({
      id: taskSessionCompletionMessageId("alpha", "delivery-cli"),
      sessionId: "creator-alpha",
      role: "agent",
      channel: "cli",
      content: "Persisted before the process stopped.",
      metadata: {
        taskCompletion: {
          version: 1,
          bindingId: "delivery-cli",
          taskId: "task-synthesis",
          resultId: primary.id,
        },
      },
    });

    currentNowMs += 30_001;
    const recovered = await service.deliverPending("creator-alpha");
    expect(recovered).toEqual([expect.objectContaining({
      bindingId: "delivery-cli",
      resultId: primary.id,
      text: "Persisted before the process stopped.",
    })]);
    expect(store.getDeliveryBinding("delivery-cli")?.status).toBe("delivering");
    await acknowledge(recovered[0]!);
    expect(await sessionDb.listMessages("creator-alpha")).toHaveLength(1);
    expect(store.getDeliveryBinding("delivery-cli")?.status).toBe("delivered");
  });

  function createCliBinding(): void {
    const binding: TaskDeliveryBinding = {
      id: "delivery-cli",
      profileId: "alpha",
      taskId: "task-synthesis",
      authorizedSessionId: "creator-alpha",
      deliveryKey: "origin-completion",
      destination: { platform: "cli" },
      status: "pending",
      createdAt: NOW,
      updatedAt: NOW,
    };
    store.atomicWrite((transaction) => transaction.createDeliveryBinding(binding));
  }

  async function acknowledge(message: { bindingId: string; messageId: string }): Promise<void> {
    await service.acknowledge({
      sessionId: "creator-alpha",
      bindingId: message.bindingId,
      messageId: message.messageId,
    });
  }

  function completeTask(): void {
    const task = store.getTask("task-synthesis")!;
    const running = { ...task, status: "running" as const, startedAt: NOW, updatedAt: NOW };
    store.updateTask(running);
    store.updateTask({ ...running, status: "completed", completedAt: NOW, updatedAt: NOW });
  }
});

function makeSynthesisGraph(): { task: Task; revision: TaskPlanRevision; steps: TaskStep[] } {
  const authority = authorityPolicy();
  const task: Task = {
    id: "task-synthesis",
    profileId: "alpha",
    creatorSessionId: "creator-alpha",
    rootTaskId: "task-synthesis",
    originSessionId: "creator-alpha",
    source: "delegation",
    executionPreference: "auto",
    creationKey: "create-synthesis",
    objective: "Research and synthesize a final answer.",
    status: "queued",
    workspace: { canonicalPath: "/workspace/project", identityHash: "workspace-hash" },
    authorityPolicy: authority,
    executionLimits: {
      maxConcurrentAttempts: 2,
      maxProviderCalls: 20,
      maxTotalTokens: 20_000,
      maxWallClockMs: 60_000,
    },
    activePlanRevisionId: "revision-synthesis",
    createdBy: { kind: "user", sessionId: "creator-alpha" },
    createdAt: NOW,
    updatedAt: NOW,
  };
  const revision: TaskPlanRevision = {
    id: "revision-synthesis",
    profileId: "alpha",
    taskId: task.id,
    revision: 1,
    status: "active",
    reason: "Initial synthesis plan.",
    createdBy: task.createdBy,
    createdAt: NOW,
    validatedAt: NOW,
    activatedAt: NOW,
  };
  const baseStep: Omit<TaskStep, "id" | "key" | "position" | "title" | "objective" | "dependsOn" | "executor"> = {
    profileId: "alpha",
    taskId: task.id,
    planRevisionId: revision.id,
    status: "pending",
    childTaskPolicy: "forbid",
    authorityPolicy: authority,
    executionLimits: { maxProviderCalls: 10, maxTotalTokens: 10_000, maxWallClockMs: 30_000 },
    retryPolicy: {
      maxAttempts: 1,
      initialBackoffMs: 0,
      backoffMultiplier: 1,
      maxBackoffMs: 0,
      retryableFailureClasses: [],
      nonRetryableFailureClasses: ["security-deny"],
      requireIdempotent: true,
    },
    failurePolicy: { onAttemptsExhausted: "fail_task", optional: false },
    idempotency: "idempotent",
    resultPolicy: { kind: "text", required: true, maxBytes: 10_000 },
    createdAt: NOW,
    updatedAt: NOW,
  };
  const worker: TaskStep = {
    ...baseStep,
    id: "step-worker",
    key: "worker",
    position: 0,
    title: "Research",
    objective: "Produce evidence.",
    dependsOn: [],
    executor: { kind: "agent", role: "worker" },
  };
  const synthesis: TaskStep = {
    ...baseStep,
    id: "step-synthesis",
    key: "synthesis",
    position: 1,
    title: "Synthesize delegated results",
    objective: "Return the final answer.",
    dependsOn: [worker.id],
    executor: { kind: "agent", role: "synthesis" },
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
    maxChildDepth: 0,
  };
}
