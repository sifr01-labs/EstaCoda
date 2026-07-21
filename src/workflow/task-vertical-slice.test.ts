import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskAuthorityDisposition, TaskAuthorityPolicy, TaskStep } from "../contracts/task.js";
import { TASK_TOOL_RISK_CLASSES } from "../contracts/task.js";
import type { ToolRiskClass } from "../contracts/tool.js";
import type { DeliveryTarget } from "../channels/delivery-router.js";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import { FixedTaskCreationConflictError, FixedTaskService, type CreateFixedTaskInput } from "./fixed-task-service.js";
import { SQLiteTaskStore } from "./sqlite-task-store.js";
import { TaskBackgroundHost } from "./task-background-host.js";
import { TaskCompletionDeliveryService } from "./task-completion-delivery.js";
import { TaskResultService } from "./task-result-service.js";
import { TaskScheduler } from "./task-scheduler.js";
import type { TaskStepExecutionInput, TaskStepExecutor } from "./task-step-executor.js";

const NOW = "2030-01-01T00:00:00.000Z";

describe("durable research-to-report vertical slice", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("survives restart, applies steering, publishes an accepted artifact, and explicitly retries delivery", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "estacoda-task-vertical-"));
    tempDirs.push(tempDir);
    const databasePath = join(tempDir, "sessions.sqlite");
    const resultRoot = join(tempDir, "task-results");
    const id = sequentialIds();
    let sessionDb = new SQLiteSessionDB({ path: databasePath });
    await sessionDb.createSession({ id: "creator-alpha", profileId: "alpha" });
    await sessionDb.createSession({ id: "unlinked-alpha", profileId: "alpha" });
    let store = new SQLiteTaskStore({ db: sessionDb.db, profileId: "alpha" });
    let taskService = new FixedTaskService({ store, now, id });
    const definition = researchReportDefinition();
    const graph = taskService.create(definition);
    await sessionDb.createSession({ id: "worker-alpha", profileId: "alpha", parentSessionId: "creator-alpha" });
    store.atomicWrite((transaction) => transaction.linkSession({
      taskId: graph.task.id,
      profileId: "alpha",
      sessionId: "worker-alpha",
      relationship: "worker",
      stepId: graph.steps[0]!.id,
      createdAt: NOW
    }));
    expect(store.listEvents(graph.task.id).map((event) => event.kind)).toEqual([
      "task-created",
      "plan-revision-created",
      "plan-revision-validated",
      "plan-revision-activated"
    ]);
    expect(taskService.create(definition)).toMatchObject({
      task: { id: graph.task.id },
      completionDelivery: { id: graph.completionDelivery?.id }
    });
    expect(() => taskService.create({
      ...definition,
      completionDelivery: {
        deliveryKey: "origin-completion",
        destination: { platform: "telegram", chatId: "different-origin" }
      }
    })).toThrow(FixedTaskCreationConflictError);
    expect(() => taskService.create({ ...definition, objective: "A conflicting objective." }))
      .toThrow(FixedTaskCreationConflictError);
    expect(() => taskService.steer({
      taskId: graph.task.id,
      authorizedSessionId: "unlinked-alpha",
      guidance: "Unauthorized guidance."
    })).toThrow(/not authorized/u);
    expect(() => taskService.steer({
      taskId: graph.task.id,
      authorizedSessionId: "worker-alpha",
      guidance: "Worker-authored guidance."
    })).toThrow(/not authorized/u);

    let resultService = createResultService(store, sessionDb, resultRoot, id);
    const failedDelivery = vi.fn(async (_targets: DeliveryTarget[], _text: string) =>
      new Map([["telegram:research", { success: false }]]));
    let delivery = new TaskCompletionDeliveryService({
      store,
      resultService,
      router: { deliverText: failedDelivery },
      now,
      id: () => id("delivery")
    });
    const binding = graph.completionDelivery!;
    expect(binding).toMatchObject({
      taskId: graph.task.id,
      authorizedSessionId: "creator-alpha",
      deliveryKey: "origin-completion",
      destination: { platform: "telegram", chatId: "research" },
      status: "pending"
    });

    const firstExecutor = scriptedExecutor(store);
    const firstHost = createHost(store, resultService, delivery, firstExecutor, "host-before-restart", id);
    const firstTick = await firstHost.runOnce();
    expect(firstTick.scheduler).toMatchObject({ dispatched: 3, completed: 2, failed: 1 });
    expect(store.getTask(graph.task.id)?.status).toBe("running");
    expect(store.listResults(graph.task.id)).toHaveLength(2);

    sessionDb.close();
    sessionDb = new SQLiteSessionDB({ path: databasePath });
    store = new SQLiteTaskStore({ db: sessionDb.db, profileId: "alpha" });
    taskService = new FixedTaskService({ store, now, id });
    resultService = createResultService(store, sessionDb, resultRoot, id);
    const deliveredText: string[] = [];
    const successfulDelivery = vi.fn(async (_targets: DeliveryTarget[], text: string) => {
      deliveredText.push(text);
      return new Map([["telegram:research", { success: true }]]);
    });
    delivery = new TaskCompletionDeliveryService({
      store,
      resultService,
      router: { deliverText: failedDelivery },
      now,
      id: () => id("delivery")
    });
    const guidance = taskService.steer({
      taskId: graph.task.id,
      authorizedSessionId: "creator-alpha",
      guidance: "Emphasize verified primary-source evidence.\nCall out uncertainty in the synthesis."
    });
    expect(store.listEvents(graph.task.id, { kinds: ["task-steered"] })[0]?.data).toEqual({
      guidanceId: guidance.id,
      characterCount: guidance.guidance.length
    });

    const executor = scriptedExecutor(store);
    const host = createHost(store, resultService, delivery, executor, "host-after-restart", id);
    await host.runOnce();
    await host.runOnce();
    const settled = await host.runOnce();
    expect(settled.scheduler).toMatchObject({ completed: 1 });
    expect(store.getTask(graph.task.id)?.status).toBe("completed");
    expect(executor.synthesisEvidence).toEqual({ researchResults: 3, guidance: guidance.guidance });
    const results = store.listResults(graph.task.id);
    expect(results.map((result) => result.kind)).toEqual(["text", "text", "text", "text", "artifact"]);
    expect(results.at(-1)).toMatchObject({
      kind: "artifact",
      byteLength: Buffer.byteLength("# Governed research report\n\nVerified findings."),
      mimeType: "text/markdown"
    });
    expect(store.getDeliveryBinding(binding.id)).toMatchObject({
      status: "failed",
      failureClass: "delivery-failed"
    });
    expect(failedDelivery).toHaveBeenCalledTimes(1);

    delivery = new TaskCompletionDeliveryService({
      store,
      resultService,
      router: { deliverText: successfulDelivery },
      now,
      id: () => id("delivery")
    });
    expect(() => delivery.retry(binding.id, "unlinked-alpha")).toThrow(/not authorized/u);
    expect(delivery.retry(binding.id, "creator-alpha").status).toBe("pending");
    await createHost(store, resultService, delivery, executor, "host-delivery-retry", id).runOnce();
    expect(store.getDeliveryBinding(binding.id)?.status).toBe("delivered");
    expect(successfulDelivery).toHaveBeenCalledTimes(1);
    expect(deliveredText[0]).toContain("Artifact handle: task-result:");
    expect(deliveredText[0]).not.toContain(resultRoot);
    sessionDb.close();
  });
});

function createHost(
  store: SQLiteTaskStore,
  resultService: TaskResultService,
  delivery: TaskCompletionDeliveryService,
  executor: TaskStepExecutor,
  ownerId: string,
  id: (kind: string) => string
): TaskBackgroundHost {
  acquireTestHostLeases(store, ownerId);
  const scheduler = new TaskScheduler({
    store,
    resultService,
    ownerId,
    resolveExecutor: () => executor,
    now,
    id: () => id("attempt"),
    eventId: () => id("scheduler-event")
  });
  return new TaskBackgroundHost({ scheduler, delivery, now });
}

function acquireTestHostLeases(store: SQLiteTaskStore, ownerId: string): void {
  for (const task of store.listTasks()) {
    const existing = store.getTaskHostLease(task.id);
    if (existing !== null && existing.ownerId !== ownerId) {
      store.releaseTaskHostLease({
        taskId: task.id,
        workspaceIdentityHash: existing.workspaceIdentityHash,
        ownerId: existing.ownerId,
        kind: existing.kind,
        fencingToken: existing.fencingToken
      });
    }
    if (store.getTaskHostLease(task.id) !== null) continue;
    store.acquireTaskHostLease({
      taskId: task.id,
      workspaceIdentityHash: task.workspace.identityHash,
      ownerId,
      kind: "background",
      acquiredAt: now().toISOString(),
      expiresAt: new Date(now().getTime() + 60_000).toISOString()
    });
  }
}

function createResultService(
  store: SQLiteTaskStore,
  sessionDb: SQLiteSessionDB,
  contentRoot: string,
  id: (kind: string) => string
): TaskResultService {
  return new TaskResultService({
    store,
    profileId: store.profileId,
    contentRoot,
    sessionDb,
    id: () => id("result"),
    handleId: () => id("handle"),
    eventId: () => id("result-event"),
    now
  });
}

function scriptedExecutor(store: SQLiteTaskStore): TaskStepExecutor & {
  synthesisEvidence?: { researchResults: number; guidance: string };
} {
  const executor: TaskStepExecutor & {
    synthesisEvidence?: { researchResults: number; guidance: string };
  } = {
    kind: "agent",
    async execute(input: TaskStepExecutionInput) {
      if (input.step.key === "research-b" && input.attempt.attemptNumber === 1) {
        return {
          outcome: "failed",
          failure: { class: "timeout", message: "Research route timed out.", retryable: true, uncertainSideEffects: false },
          usage: usage(1, 100)
        };
      }
      if (input.step.key.startsWith("research-")) {
        return {
          outcome: "succeeded",
          results: [{ kind: "text", content: `Verified findings for ${input.step.key}.` }],
          usage: usage(1, 120)
        };
      }
      if (input.step.key === "synthesis") {
        const dependencyIds = new Set(input.step.dependsOn);
        const researchResults = store.listResults(input.task.id)
          .filter((result) => result.stepId !== undefined && dependencyIds.has(result.stepId)).length;
        const guidance = store.listGuidance(input.task.id).at(-1)?.guidance ?? "";
        executor.synthesisEvidence = { researchResults, guidance };
        return {
          outcome: "succeeded",
          results: [{ kind: "text", content: "Synthesis based on all three durable research results." }],
          usage: usage(1, 180)
        };
      }
      return {
        outcome: "succeeded",
        results: [{
          kind: "artifact",
          content: "# Governed research report\n\nVerified findings.",
          mimeType: "text/markdown",
          summary: "Published research report"
        }],
        usage: usage(1, 80)
      };
    }
  };
  return executor;
}

function researchReportDefinition(): CreateFixedTaskInput {
  const taskAuthority = authorityPolicy(
    ["core", "web", "research", "files"],
    { "read-only-local": "runtime_policy", "read-only-network": "runtime_policy", "workspace-write": "require_approval" }
  );
  const researchAuthority = authorityPolicy(
    ["core", "web", "research"],
    { "read-only-local": "runtime_policy", "read-only-network": "runtime_policy" }
  );
  const synthesisAuthority = authorityPolicy(["core"], { "read-only-local": "runtime_policy" });
  const publicationAuthority = authorityPolicy(
    ["core", "files"],
    { "read-only-local": "runtime_policy", "workspace-write": "require_approval" }
  );
  const researchSteps = ["a", "b", "c"].map((suffix) => step(
    `research-${suffix}`,
    [],
    researchAuthority,
    { kind: "text", required: true, maxBytes: 50_000 }
  ));
  return {
    creatorSessionId: "creator-alpha",
    source: "runtime",
    creationKey: "research-report:request-1",
    objective: "Research three sources, synthesize the findings, and publish a governed report.",
    workspace: { canonicalPath: "/workspace/project", identityHash: "workspace-hash" },
    authorityPolicy: taskAuthority,
    executionLimits: {
      maxConcurrentAttempts: 3,
      maxProviderCalls: 20,
      maxTotalTokens: 100_000,
      maxWallClockMs: 600_000
    },
    steps: [
      ...researchSteps,
      step("synthesis", researchSteps.map((entry) => entry.key), synthesisAuthority, {
        kind: "text",
        required: true,
        maxBytes: 100_000
      }),
      step("publication", ["synthesis"], publicationAuthority, {
        kind: "artifact",
        required: true,
        maxBytes: 100_000
      })
    ],
    planReason: "Deterministic research-to-report vertical slice.",
    completionDelivery: {
      deliveryKey: "origin-completion",
      destination: { platform: "telegram", chatId: "research" }
    }
  };
}

function step(
  key: string,
  dependsOn: readonly string[],
  authorityPolicy: TaskAuthorityPolicy,
  resultPolicy: TaskStep["resultPolicy"]
) {
  return {
    key,
    title: key === "publication" ? "Publish report" : key === "synthesis" ? "Synthesize research" : `Research ${key}`,
    objective: `Complete ${key} within the declared Task authority.`,
    dependsOn,
    executor: { kind: "agent" as const, role: key.startsWith("research-") ? "worker" as const : "orchestrator" as const },
    childTaskPolicy: "forbid" as const,
    authorityPolicy,
    executionLimits: { maxProviderCalls: 5, maxTotalTokens: 25_000, maxWallClockMs: 300_000 },
    retryPolicy: {
      maxAttempts: 2,
      initialBackoffMs: 0,
      backoffMultiplier: 1,
      maxBackoffMs: 0,
      retryableFailureClasses: ["timeout", "result-persistence-failed", "lease-expired"],
      nonRetryableFailureClasses: ["security-deny"],
      requireIdempotent: true
    },
    failurePolicy: { onAttemptsExhausted: "fail_task" as const, optional: false },
    idempotency: "idempotent" as const,
    resultPolicy
  };
}

function authorityPolicy(
  allowedToolsets: readonly string[],
  overrides: Partial<Record<ToolRiskClass, TaskAuthorityDisposition>>
): TaskAuthorityPolicy {
  return {
    allowedToolsets,
    blockedTools: [],
    riskClassPolicy: Object.fromEntries(
      TASK_TOOL_RISK_CLASSES.map((riskClass) => [riskClass, overrides[riskClass] ?? "forbid"])
    ) as Record<ToolRiskClass, TaskAuthorityDisposition>,
    mayCreateChildTasks: false,
    maxChildDepth: 0
  };
}

function usage(providerCalls: number, totalTokens: number) {
  return {
    providerCalls,
    inputTokens: totalTokens,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens,
    estimatedCostUsd: totalTokens / 1_000_000,
    usageComplete: true,
    pricingComplete: true,
    incompleteReasons: []
  };
}

function sequentialIds(): (kind: string) => string {
  let sequence = 0;
  return (kind) => `${kind}-${++sequence}`;
}

function now(): Date {
  return new Date(NOW);
}
