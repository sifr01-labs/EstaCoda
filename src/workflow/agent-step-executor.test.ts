import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelProfile, ResolvedModelRoute } from "../contracts/provider.js";
import { capabilityFirstDefaults } from "../contracts/security.js";
import type {
  Task,
  TaskAuthorityDisposition,
  TaskAuthorityPolicy,
  TaskPlanRevision,
  TaskStep
} from "../contracts/task.js";
import { TASK_TOOL_RISK_CLASSES } from "../contracts/task.js";
import type { ToolDefinition, ToolRiskClass, ToolsetName } from "../contracts/tool.js";
import type { AgentLoopInput, AgentLoopResponse } from "../runtime/agent-loop.js";
import type {
  ChildAgentLoopFactory,
  ChildAgentLoopRuntime,
  CreateChildAgentLoopInput
} from "../runtime/agent-loop-factory.js";
import type { AgentLoopRouteInput } from "../runtime/agent-loop-builder.js";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import { AgentStepExecutor } from "./agent-step-executor.js";
import { SQLiteTaskStore } from "./sqlite-task-store.js";
import { TaskResultService } from "./task-result-service.js";
import { TaskApprovalService } from "./task-approval-service.js";
import { TaskScheduler } from "./task-scheduler.js";
import { TASK_STEP_HOST_HANDOFF_ABORT_REASON } from "./task-step-executor.js";

describe("AgentStepExecutor", () => {
  let tempDir: string;
  let sessionDb: SQLiteSessionDB;
  let store: SQLiteTaskStore;
  let resultService: TaskResultService;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "estacoda-agent-step-executor-"));
    idsForHelper = 0;
    sessionDb = new SQLiteSessionDB({ path: join(tempDir, "sessions.sqlite"), now });
    await sessionDb.createSession({ id: "creator-alpha", profileId: "alpha" });
    store = new SQLiteTaskStore({ db: sessionDb.db, profileId: "alpha" });
    resultService = new TaskResultService({
      store,
      profileId: "alpha",
      contentRoot: join(tempDir, "profiles", "alpha", "tasks", "results"),
      sessionDb,
      now,
      id: () => nextId("result"),
      handleId: () => nextId("handle"),
      eventId: () => nextId("result-event")
    });
  });

  afterEach(() => {
    sessionDb.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("runs a fenced read-only child and durably settles its full result, usage, and ownership", async () => {
    const graph = makeGraph();
    store.createTaskGraph(graph);
    store.atomicWrite((transaction) => transaction.createGuidance({
      id: "guidance-alpha",
      profileId: "alpha",
      taskId: graph.task.id,
      authorizedSessionId: "creator-alpha",
      guidance: "Prioritize the verified source.",
      createdAt: NOW
    }));
    let childInput: CreateChildAgentLoopInput | undefined;
    let handledInput: AgentLoopInput | undefined;
    const cleanup = vi.fn(async () => undefined);
    const childFactory: ChildAgentLoopFactory = {
      createChild: vi.fn(async (input) => {
        childInput = input;
        await sessionDb.createSession({
          id: "worker-alpha",
          profileId: input.profileId,
          parentSessionId: input.parentSessionId,
          metadata: { kind: "task-step-worker", ...(input.taskExecution ?? {}) }
        });
        return childRuntime(async (agentInput) => {
          handledInput = agentInput;
          await agentInput.onEvent?.({ kind: "tool-start", tool: "file.read" });
          await sessionDb.saveTrajectory({
            id: "trajectory-alpha",
            profileId: "alpha",
            sessionId: "worker-alpha",
            modelId: "child-model",
            events: []
          });
          return response();
        }, cleanup);
      })
    };
    const executor = new AgentStepExecutor({
      childFactory,
      sessionDb,
      taskStore: store,
      hostWorkspace: graph.task.workspace,
      isWorkspaceTrusted: () => true,
      parentVisibleTools: () => tools(),
      approvalService: new TaskApprovalService({ store }),
      securityPolicy: capabilityFirstDefaults
    });
    const scheduler = new TaskScheduler({
      store,
      resultService,
      ownerId: "scheduler-alpha",
      resolveExecutor: (task, step) => executor.canExecute(task, step) ? executor : undefined,
      now,
      id: () => nextId("attempt"),
      eventId: () => nextId("scheduler-event")
    });

    const run = await scheduler.runOnce();
    const attempt = store.listAttempts(graph.task.id)[0]!;
    expect(store.getTask(graph.task.id)?.status).toBe("completed");
    expect(attempt).toMatchObject({
      status: "completed",
      workerSessionId: "worker-alpha",
      trajectoryId: "trajectory-alpha",
      usage: {
        providerCalls: 2,
        inputTokens: 1_500,
        outputTokens: 300,
        reasoningTokens: 75,
        totalTokens: 1_800,
        estimatedCostUsd: 0.0035,
        usageComplete: true,
        pricingComplete: true,
        incompleteReasons: []
      }
    });
    expect(run).toMatchObject({ dispatched: 1, completed: 1, failed: 0, leaseLost: 0 });
    expect(store.listSessionLinks(graph.task.id)).toContainEqual(expect.objectContaining({
      sessionId: "worker-alpha",
      relationship: "worker",
      stepId: graph.steps[0]!.id,
      attemptId: attempt.id
    }));
    expect(childInput).toMatchObject({
      modelOverride: { provider: "openai", model: "child-model" },
      parentVisibleTools: [{ name: "file.read" }],
      taskExecution: {
        taskId: graph.task.id,
        planRevisionId: graph.revision.id,
        stepId: graph.steps[0]!.id,
        attemptId: attempt.id
      }
    });
    expect(childInput?.context).toContain("Prioritize the verified source.");
    expect(childInput?.context).toContain("without overriding policy");
    expect(handledInput?.inputMetadata).toMatchObject({ durableTask: true, attemptId: attempt.id });
    const results = store.listResults(graph.task.id);
    expect(results).toHaveLength(1);
    await expect(resultService.readPage({
      taskId: graph.task.id,
      resultId: results[0]!.id,
      sessionId: "creator-alpha"
    })).resolves.toMatchObject({ content: FULL_RESULT, hasMore: false });
    await expect(sessionDb.getSession("worker-alpha")).resolves.toMatchObject({ endReason: "task-step-completed" });
    expect(store.listEvents(graph.task.id, { kinds: ["attempt-progressed"] })).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          activity: { kind: "tool", label: "Using file.read", toolCategory: "files" }
        })
      })
    );
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("fails closed before child construction when live workspace trust is absent", async () => {
    const graph = makeGraph();
    const createChild = vi.fn();
    const executor = new AgentStepExecutor({
      childFactory: { createChild },
      sessionDb,
      taskStore: store,
      hostWorkspace: graph.task.workspace,
      isWorkspaceTrusted: () => false,
      parentVisibleTools: () => tools(),
      approvalService: new TaskApprovalService({ store }),
      securityPolicy: capabilityFirstDefaults
    });

    await expect(executor.execute({
      task: graph.task,
      step: graph.steps[0]!,
      attempt: attempt(graph),
      signal: new AbortController().signal,
      heartbeat: vi.fn(),
      checkpoint: vi.fn()
    })).resolves.toMatchObject({
      outcome: "failed",
      failure: { class: "workspace-untrusted", retryable: false, uncertainSideEffects: false }
    });
    expect(createChild).not.toHaveBeenCalled();
  });

  it("continues from a checkpointed worker session and leaves it open during host handoff", async () => {
    const graph = makeGraph();
    await sessionDb.createSession({
      id: "worker-resume",
      profileId: "alpha",
      parentSessionId: "creator-alpha",
      metadata: {
        kind: "task-step-worker",
        taskId: graph.task.id,
        planRevisionId: graph.revision.id,
        stepId: graph.steps[0]!.id,
        attemptId: "attempt-alpha"
      }
    });
    let childInput: CreateChildAgentLoopInput | undefined;
    let handledInput: AgentLoopInput | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const childFactory: ChildAgentLoopFactory = {
      createChild: vi.fn(async (input) => {
        childInput = input;
        return childRuntime(async (agentInput) => {
          handledInput = agentInput;
          markStarted!();
          return await new Promise<AgentLoopResponse>((_resolve, reject) => {
            agentInput.signal?.addEventListener("abort", () => reject(new Error("handoff")), { once: true });
          });
        }, async () => undefined, { sessionId: "worker-resume", trajectoryId: "trajectory-resume" });
      })
    };
    const executor = new AgentStepExecutor({
      childFactory,
      sessionDb,
      taskStore: store,
      hostWorkspace: graph.task.workspace,
      isWorkspaceTrusted: () => true,
      parentVisibleTools: () => tools(),
      approvalService: new TaskApprovalService({ store }),
      securityPolicy: capabilityFirstDefaults
    });
    const controller = new AbortController();
    const execution = executor.execute({
      task: graph.task,
      step: graph.steps[0]!,
      attempt: { ...attempt(graph), workerSessionId: "worker-resume" },
      signal: controller.signal,
      heartbeat: vi.fn(),
      checkpoint: vi.fn()
    });
    await started;

    controller.abort(TASK_STEP_HOST_HANDOFF_ABORT_REASON);

    await expect(execution).resolves.toMatchObject({ outcome: "cancelled", workerSessionId: "worker-resume" });
    expect(childInput?.resumeSessionId).toBe("worker-resume");
    expect(handledInput?.text).toContain("Continue this durable Task from the saved worker session");
    await expect(sessionDb.getSession("worker-resume")).resolves.toMatchObject({ endedAt: undefined });
  });

  it("captures artifact bytes only through the injected resolver and enforces the declared size", async () => {
    const graph = makeGraph();
    graph.steps[0] = {
      ...graph.steps[0]!,
      resultPolicy: { kind: "artifact", required: true, maxBytes: 1_024 }
    };
    store.createTaskGraph(graph);
    const artifactBytes = new Uint8Array([1, 2, 3, 4]);
    const resolveArtifactContent = vi.fn(async () => artifactBytes);
    const childFactory: ChildAgentLoopFactory = {
      createChild: vi.fn(async (input) => {
        await sessionDb.createSession({
          id: "worker-artifact",
          profileId: input.profileId,
          parentSessionId: input.parentSessionId,
          metadata: { kind: "task-step-worker", ...(input.taskExecution ?? {}) }
        });
        return childRuntime(async () => {
          await sessionDb.saveTrajectory({
            id: "trajectory-artifact",
            profileId: "alpha",
            sessionId: "worker-artifact",
            modelId: "child-model",
            events: []
          });
          return response({
            text: "Artifact captured.",
            artifacts: [{
              id: "artifact-1",
              path: "artifact://artifact-1",
              kind: "data",
              bytes: artifactBytes.byteLength,
              createdAt: NOW,
              mimeType: "application/octet-stream",
              summary: "Complete binary output."
            }]
          });
        }, vi.fn(async () => undefined), {
          sessionId: "worker-artifact",
          trajectoryId: "trajectory-artifact"
        });
      })
    };
    const executor = new AgentStepExecutor({
      childFactory,
      sessionDb,
      taskStore: store,
      hostWorkspace: graph.task.workspace,
      isWorkspaceTrusted: () => true,
      parentVisibleTools: () => tools(),
      resolveArtifactContent,
      approvalService: new TaskApprovalService({ store }),
      securityPolicy: capabilityFirstDefaults
    });
    const scheduler = new TaskScheduler({
      store,
      resultService,
      ownerId: "scheduler-alpha",
      resolveExecutor: () => executor,
      now,
      id: () => nextId("attempt"),
      eventId: () => nextId("scheduler-event")
    });

    expect(await scheduler.runOnce()).toMatchObject({ completed: 1, failed: 0 });
    expect(resolveArtifactContent).toHaveBeenCalledWith(expect.objectContaining({
      artifact: expect.objectContaining({ id: "artifact-1" }),
      task: expect.objectContaining({ id: graph.task.id }),
      step: expect.objectContaining({ id: graph.steps[0]!.id })
    }));
    expect(store.listResults(graph.task.id)).toEqual([
      expect.objectContaining({
        kind: "artifact",
        byteLength: artifactBytes.byteLength,
        mimeType: "application/octet-stream",
        summary: "Complete binary output."
      })
    ]);
  });
});

const NOW = "2030-01-01T00:00:00.000Z";
const FULL_RESULT = "Complete child result, including details that must not be reduced to a summary.";

function now(): Date {
  return new Date(NOW);
}

function nextId(prefix: string): string {
  return `${prefix}-${++idsForHelper}`;
}

let idsForHelper = 0;

function makeGraph(): { task: Task; revision: TaskPlanRevision; steps: TaskStep[] } {
  const policy = authorityPolicy();
  const task: Task = {
    id: "task-alpha",
    profileId: "alpha",
    creatorSessionId: "creator-alpha",
    rootTaskId: "task-alpha",
    originSessionId: "creator-alpha",
    source: "cli",
    executionPreference: "auto",
    creationKey: "create-alpha",
    objective: "Research and return the complete durable result.",
    status: "queued",
    workspace: { canonicalPath: "/workspace/project", identityHash: "workspace-hash" },
    authorityPolicy: policy,
    budgetPolicy: {
      maxConcurrentAttempts: 1,
      maxProviderCalls: 10,
      maxTotalTokens: 100_000,
      maxEstimatedCostUsd: 10,
      maxWallClockMs: 300_000
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
    reason: "Agent executor test plan.",
    createdBy: task.createdBy,
    createdAt: NOW,
    validatedAt: NOW,
    activatedAt: NOW
  };
  const step: TaskStep = {
    id: "step-agent",
    profileId: "alpha",
    taskId: task.id,
    planRevisionId: revision.id,
    key: "agent",
    position: 0,
    status: "pending",
    title: "Run agent Step",
    objective: "Inspect the workspace and return the full answer.",
    dependsOn: [],
    executor: { kind: "agent", role: "worker", model: { provider: "openai", id: "child-model" } },
    childTaskPolicy: "forbid",
    authorityPolicy: policy,
    budget: { maxProviderCalls: 5, maxTotalTokens: 50_000, maxEstimatedCostUsd: 5, maxWallClockMs: 120_000 },
    retryPolicy: {
      maxAttempts: 1,
      initialBackoffMs: 0,
      backoffMultiplier: 1,
      maxBackoffMs: 0,
      retryableFailureClasses: ["provider-error"],
      nonRetryableFailureClasses: ["security-deny"],
      requireIdempotent: true
    },
    failurePolicy: { onAttemptsExhausted: "fail_task", optional: false },
    idempotency: "idempotent",
    resultPolicy: { kind: "text", required: true, maxBytes: 50_000 },
    createdAt: NOW,
    updatedAt: NOW
  };
  return { task, revision, steps: [step] };
}

function attempt(graph: ReturnType<typeof makeGraph>) {
  return {
    id: "attempt-alpha",
    profileId: "alpha",
    taskId: graph.task.id,
    planRevisionId: graph.revision.id,
    stepId: graph.steps[0]!.id,
    attemptNumber: 1,
    status: "running" as const,
    dispatchKey: "dispatch-alpha",
    usage: emptyUsage(),
    resultIds: [],
    createdAt: NOW,
    updatedAt: NOW,
    startedAt: NOW
  };
}

function childRuntime(
  handle: (input: AgentLoopInput) => Promise<AgentLoopResponse>,
  cleanup: () => Promise<void>,
  identity: { sessionId: string; trajectoryId: string } = {
    sessionId: "worker-alpha",
    trajectoryId: "trajectory-alpha"
  }
): ChildAgentLoopRuntime {
  return {
    childSession: { id: identity.sessionId, profileId: "alpha", createdAt: NOW, updatedAt: NOW },
    childSessionId: identity.sessionId,
    sessionRuntimeContext: { currentSessionId: () => identity.sessionId } as never,
    builtSession: { providerRoutes: routes() } as never,
    agentLoop: { trajectoryId: identity.trajectoryId } as never,
    suppressedRuntimeFeatures: [],
    enabledRuntimeFeatures: [],
    approvalMode: "non-interactive-fail-closed",
    toolAccess: {
      effectiveAllowedToolsets: ["files"],
      effectiveAllowedTools: ["file.read"],
      strippedTools: [],
      blockedTools: [],
      rejectedRequestedTools: [],
      rejectedRequestedToolsets: []
    },
    handle,
    cleanup
  };
}

function response(overrides: Partial<AgentLoopResponse> = {}): AgentLoopResponse {
  return {
    label: "EstaCoda",
    text: FULL_RESULT,
    matchedSkills: [],
    intent: {
      nativeIntent: "general",
      labels: ["general"],
      confidence: 1,
      suggestedToolsets: [],
      suggestedSkills: [],
      confirmationRequired: false,
      rationale: "test",
      evidence: []
    },
    securityDecision: "allow",
    toolExecutions: [],
    toolPlans: [],
    skillOutcomes: [],
    artifacts: [],
    context: undefined,
    projectContext: undefined,
    progress: [],
    providerExecution: {
      ok: true,
      response: { ok: true, content: FULL_RESULT, provider: "openai", model: "child-model" },
      fallbackUsed: true,
      attempts: [
        {
          provider: "openai",
          model: "fallback-model",
          dispatched: true,
          dispatchedAt: NOW,
          ok: false,
          content: "",
          usage: { inputTokens: 500, outputTokens: 100, reasoningTokens: 25, totalTokens: 600 }
        },
        {
          provider: "openai",
          model: "child-model",
          dispatched: true,
          dispatchedAt: NOW,
          ok: true,
          content: FULL_RESULT,
          usage: { inputTokens: 1_000, outputTokens: 200, reasoningTokens: 50, totalTokens: 1_200 }
        }
      ],
      toolCalls: []
    },
    ...overrides
  };
}

function routes(): AgentLoopRouteInput {
  const primary = route("child-model", {
    inputPerMillionTokens: 2,
    outputPerMillionTokens: 4,
    reasoningPerMillionTokens: 0
  });
  const fallback = route("fallback-model", {
    inputPerMillionTokens: 1,
    outputPerMillionTokens: 2,
    reasoningPerMillionTokens: 0
  });
  return {
    model: primary.profile,
    mainRoute: primary,
    primaryModelRoute: primary,
    modelFallbackRoutes: [fallback],
    providerPreferences: {}
  };
}

function route(id: string, cost: NonNullable<ModelProfile["cost"]>): ResolvedModelRoute {
  const profile: ModelProfile = {
    id,
    provider: "openai",
    contextWindowTokens: 100_000,
    supportsTools: true,
    supportsVision: false,
    supportsStructuredOutput: true,
    cost
  };
  return { provider: "openai", id, profile };
}

function tools(): ToolDefinition[] {
  return [
    tool("file.read", "read-only-local", ["files"]),
    tool("web.search", "read-only-network", ["web"]),
    tool("terminal.run", "workspace-write", ["files"]),
    tool("delegate_task", "shared-state-mutation", ["files"])
  ];
}

function tool(name: string, riskClass: ToolRiskClass, toolsets: ToolsetName[]): ToolDefinition {
  return { name, description: name, inputSchema: {}, riskClass, toolsets, progressLabel: name, maxResultSizeChars: 10_000 };
}

function authorityPolicy(): TaskAuthorityPolicy {
  return {
    allowedToolsets: ["files", "web"],
    blockedTools: ["web.search"],
    riskClassPolicy: riskPolicy({ "read-only-local": "runtime_policy", "read-only-network": "runtime_policy" }),
    mayCreateChildTasks: false,
    maxChildDepth: 0
  };
}

function riskPolicy(overrides: Partial<Record<ToolRiskClass, TaskAuthorityDisposition>>) {
  return Object.fromEntries(TASK_TOOL_RISK_CLASSES.map((riskClass) => [riskClass, overrides[riskClass] ?? "forbid"])) as
    Record<ToolRiskClass, TaskAuthorityDisposition>;
}

function emptyUsage() {
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
