import { createWebTools } from "../tools/web-tools.js";
import { ProviderAccountingError } from "../providers/provider-executor.js";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DELEGATION_CONFIG } from "../config/delegation-defaults.js";
import type { ModelProfile, ResolvedModelRoute } from "../contracts/provider.js";
import type { RuntimeEvent } from "../contracts/runtime-event.js";
import { capabilityFirstDefaults } from "../contracts/security.js";
import type {
  Task,
  TaskAttempt,
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
import { SubagentRegistry } from "../delegation/subagent-registry.js";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import { createTaskResultTools } from "../tools/task-result-tools.js";
import {
  AgentStepExecutor,
  MAX_PERSISTED_ASSISTANT_PREVIEWS_PER_ATTEMPT
} from "./agent-step-executor.js";
import { SQLiteTaskStore } from "./sqlite-task-store.js";
import { TaskResultService } from "./task-result-service.js";
import { TaskApprovalService } from "./task-approval-service.js";
import { TaskScheduler } from "./task-scheduler.js";
import { TASK_STEP_HOST_HANDOFF_ABORT_REASON } from "./task-step-executor.js";
import type { TaskStore } from "./task-store.js";
import { taskDelegationDepth } from "./task-tree-accounting.js";

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

  it.each(["step default","Task override","cleared override"])("runs a fenced child with %s and durably settles its result and ownership", async (mode) => {
    const graph = makeGraph();
    store.createTaskGraph(graph);
    if(mode!=="step default")store.appendEvent({id:"model-choice",profileId:graph.task.profileId,taskId:graph.task.id,kind:"model-override-changed",timestamp:NOW,data:{selection:{providerId:"local",modelId:"operator-model"}}});
    if(mode==="cleared override")store.appendEvent({id:"model-clear",profileId:graph.task.profileId,taskId:graph.task.id,kind:"model-override-changed",timestamp:new Date(Date.parse(NOW)+1).toISOString(),data:{selection:null}});

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
    let previewNow = Date.parse(NOW);
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
          for (let index = 0; index < MAX_PERSISTED_ASSISTANT_PREVIEWS_PER_ATTEMPT + 6; index++) {
            agentInput.onDelta?.(`Preview ${index} password: hunter2. `);
            previewNow += 1_001;
          }
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
      securityPolicy: capabilityFirstDefaults,
      now: () => new Date(previewNow)
    });
    acquireHostLease(store, graph.task, "scheduler-alpha");
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
      depth: 1,
      modelOverride: mode==="Task override"?{provider:"local",model:"operator-model"}:{ provider: "openai", model: "child-model" },
      parentVisibleTools: [{ name: "file.read" }],
      taskExecution: {
        taskId: graph.task.id,
        planRevisionId: graph.revision.id,
        stepId: graph.steps[0]!.id,
        attemptId: attempt.id,
        attemptFencingToken: 1,
        originSessionId: "creator-alpha",
        originTurnId: "origin-turn-alpha"
      }
    });
    expect(childInput?.context).toContain("Prioritize the verified source.");
    expect(childInput?.context).toContain("without overriding policy");
    expect(childInput?.context).toContain("summary paragraph of at most 200 characters without Markdown");
    expect(handledInput?.inputMetadata).toMatchObject({ durableTask: true, attemptId: attempt.id });
    const results = store.listResults(graph.task.id);
    expect(results).toHaveLength(1);
    expect(results[0]?.displaySummary).toBe(FULL_RESULT);
    expect(results[0]?.summary).toBeUndefined();
    await expect(resultService.readPage({
      taskId: graph.task.id,
      resultId: results[0]!.id,
      sessionId: "creator-alpha"
    })).resolves.toMatchObject({ content: FULL_RESULT, hasMore: false });
    await expect(sessionDb.getSession("worker-alpha")).resolves.toMatchObject({ endReason: "task-step-completed" });
    expect(store.listEvents(graph.task.id, { kinds: ["attempt-progressed"] })).toContainEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          activity: { kind: "tool", label: "Reading files", traceCategory: "read", toolCategory: "files" }
        })
      })
    );
    const assistantActivities = store.listEvents(graph.task.id, { kinds: ["attempt-progressed"] })
      .map((event) => event.data.activity)
      .filter((activity) => (activity as { kind?: string } | undefined)?.kind === "assistant");
    const milestones = store.listEvents(graph.task.id, { kinds: ["attempt-progressed"] })
      .map((event) => event.data.milestone)
      .filter((milestone) => milestone !== undefined);
    expect(milestones).toEqual(["provider-completed", "result-captured"]);
    expect(JSON.stringify(store.listEvents(graph.task.id, { kinds: ["attempt-progressed"] })))
      .not.toContain(FULL_RESULT);
    expect(assistantActivities).toHaveLength(MAX_PERSISTED_ASSISTANT_PREVIEWS_PER_ATTEMPT);
    expect(JSON.stringify(assistantActivities)).not.toContain("hunter2");
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("propagates the durable Task ancestry depth through construction, registry, and progress", async () => {
    const lineage = makeNestedLineage(3);
    const nestedStore = taskStoreWithLineage(store, lineage);
    const graph = lineage[lineage.length - 1]!;
    expect(lineage.map((candidate) => taskDelegationDepth(
      nestedStore,
      candidate.task,
      candidate.steps[0]!
    ))).toEqual([1, 2, 3]);
    const registry = new SubagentRegistry();
    const registerSubagent = vi.spyOn(registry, "registerSubagent");
    const events: RuntimeEvent[] = [];
    let childInput: CreateChildAgentLoopInput | undefined;
    const childFactory: ChildAgentLoopFactory = {
      createChild: vi.fn(async (input) => {
        childInput = input;
        await sessionDb.createSession({
          id: "worker-depth-three",
          profileId: input.profileId,
          parentSessionId: input.parentSessionId,
          metadata: { kind: "task-step-worker", ...(input.taskExecution ?? {}), depth: input.depth }
        });
        return childRuntime(async (agentInput) => {
          await agentInput.onEvent?.({ kind: "tool-start", tool: "file.read" });
          return response();
        }, async () => undefined, {
          sessionId: "worker-depth-three",
          trajectoryId: "trajectory-depth-three"
        });
      })
    };
    const executor = new AgentStepExecutor({
      childFactory,
      sessionDb,
      taskStore: nestedStore,
      hostWorkspace: graph.task.workspace,
      isWorkspaceTrusted: () => true,
      parentVisibleTools: () => tools(),
      subagentRegistry: registry,
      onEvent: async (event) => { events.push(event); },
      approvalService: new TaskApprovalService({ store: nestedStore }),
      securityPolicy: capabilityFirstDefaults,
      now
    });

    await expect(executor.execute({
      task: graph.task,
      step: graph.steps[0]!,
      attempt: attempt(graph),
      signal: new AbortController().signal,
      heartbeat: vi.fn(),
      checkpoint: vi.fn()
    })).resolves.toMatchObject({ outcome: "succeeded", workerSessionId: "worker-depth-three" });

    expect(childInput).toMatchObject({ depth: 3 });
    expect(registerSubagent).toHaveBeenCalledWith(expect.objectContaining({ depth: 3 }));
    expect(events).toContainEqual(expect.objectContaining({
      kind: "delegation-progress",
      depth: 3,
      taskId: graph.task.id,
      stepId: graph.steps[0]!.id
    }));
  });

  it("fails closed instead of guessing a depth when durable Task ancestry is invalid", async () => {
    const lineage = makeNestedLineage(2);
    const nestedStore = taskStoreWithLineage(store, lineage);
    const graph = lineage[1]!;
    const task = { ...graph.task, parentTaskId: "missing-parent" };
    const createChild = vi.fn();
    const executor = new AgentStepExecutor({
      childFactory: { createChild },
      sessionDb,
      taskStore: nestedStore,
      hostWorkspace: graph.task.workspace,
      isWorkspaceTrusted: () => true,
      parentVisibleTools: () => tools(),
      approvalService: new TaskApprovalService({ store: nestedStore }),
      securityPolicy: capabilityFirstDefaults
    });

    await expect(executor.execute({
      task,
      step: graph.steps[0]!,
      attempt: attempt({ ...graph, task }),
      signal: new AbortController().signal,
      heartbeat: vi.fn(),
      checkpoint: vi.fn()
    })).resolves.toMatchObject({
      outcome: "failed",
      failure: { class: "task-lineage-invalid", retryable: false }
    });
    expect(createChild).not.toHaveBeenCalled();
  });

  it.each([
    { tools: [] as string[], toolsets: [] as ToolsetName[], failureClass: "delegated-tools-unavailable" },
    { tools: ["web.search"], toolsets: ["web"] as ToolsetName[], failureClass: "delegated-authority-violation" }
  ])("does not call the provider when delegated access revalidation fails: $failureClass", async ({
    tools: effectiveTools,
    toolsets: effectiveToolsets,
    failureClass
  }) => {
    const graph = makeGraph();
    const step: TaskStep = {
      ...graph.steps[0]!,
      executor: {
        ...graph.steps[0]!.executor,
        delegationAccess: {
          version: 1,
          requestedTools: ["file.read"],
          requestedToolsets: ["files"],
          parentVisibleTools: ["file.read"],
          effectiveAllowedTools: ["file.read"],
          effectiveAllowedToolsets: ["files"],
          strippedTools: [],
          rejectedRequestedTools: [],
          rejectedRequestedToolsets: []
        }
      }
    };
    const handle = vi.fn(async () => response());
    const cleanup = vi.fn(async () => undefined);
    const childFactory: ChildAgentLoopFactory = {
      createChild: vi.fn(async (input) => {
        await sessionDb.createSession({
          id: `worker-access-${failureClass}`,
          profileId: input.profileId,
          parentSessionId: input.parentSessionId,
          metadata: { kind: "task-step-worker", ...(input.taskExecution ?? {}) }
        });
        return childRuntime(handle, cleanup, {
          sessionId: `worker-access-${failureClass}`,
          trajectoryId: `trajectory-access-${failureClass}`
        }, { tools: effectiveTools, toolsets: effectiveToolsets });
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

    await expect(executor.execute({
      task: graph.task,
      step,
      attempt: attempt({ ...graph, steps: [step] }),
      signal: new AbortController().signal,
      heartbeat: vi.fn(),
      checkpoint: vi.fn()
    })).resolves.toMatchObject({
      outcome: "failed",
      failure: { class: failureClass, retryable: false },
      workerSessionId: `worker-access-${failureClass}`
    });
    expect(handle).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
    await expect(sessionDb.getSession(`worker-access-${failureClass}`)).resolves.toMatchObject({
      endReason: "task-step-failed"
    });
  });

  it("accepts only observed live citations and observed repository references for research Steps", async () => {
    const cases = [
      {
        name: "missing-live-tool",
        research: { scope: "live", requireLiveSources: true, requireRepositoryEvidence: false },
        text: "Training-memory answer with https://unobserved.example/report",
        executions: [],
        outcome: "failed",
        diagnostic: true
      },
      ...["verified-extract", "extract-body-link", "extract-without-search"].map((name) => ({
        name,
        research: { scope: "live", requireLiveSources: true, requireRepositoryEvidence: false },
        text: name === "extract-body-link" ? "Claim cites https://fabricated.example/report" : "Claim cites https://verified.example/report",
        executions: [
          ...(name === "extract-without-search" ? [] : [successfulEvidenceExecution("web.search", "read-only-network", ["web", "research"],
            { query: "current report" }, "Search results", { results: [{ url: "https://observed.example/report" }] })]),
          successfulEvidenceExecution("web.extract", "read-only-network", ["web", "research"],
            { url: "https://verified.example/report" }, "A page containing a link to https://fabricated.example/report", { url: "https://verified.example/report" })
        ],
        outcome: name === "verified-extract" ? "succeeded" : "failed",
        diagnostic: name !== "verified-extract"
      })),
      {
        name: "fabricated-live-url",
        research: { scope: "live", requireLiveSources: true, requireRepositoryEvidence: false },
        text: "Claim cites https://fabricated.example/report",
        executions: [successfulEvidenceExecution("web.search", "read-only-network", ["web", "research"], {
          query: "current report"
        }, "1. Observed\nhttps://observed.example/report", {
          results: [{ title: "Observed", url: "https://observed.example/report" }]
        })],
        outcome: "failed",
        diagnostic: true
      },
      {
        name: "mixed-observed-and-fabricated-live-urls",
        research: { scope: "live", requireLiveSources: true, requireRepositoryEvidence: false },
        text: "Observed https://observed.example/report but also https://fabricated.example/report",
        executions: [successfulEvidenceExecution("web.search", "read-only-network", ["web", "research"], {
          query: "current report"
        }, "1. Observed\nhttps://observed.example/report", {
          results: [{ title: "Observed", url: "https://observed.example/report" }]
        })],
        outcome: "failed",
        diagnostic: true
      },
      {
        name: "accepted-live-url",
        research: { scope: "live", requireLiveSources: true, requireRepositoryEvidence: false },
        text: "Supported finding: [Observed](https://observed.example/report).",
        executions: [successfulEvidenceExecution("web.search", "read-only-network", ["web", "research"], {
          query: "current report"
        }, "1. Observed\nhttps://observed.example/report", {
          results: [{ title: "Observed", url: "https://observed.example/report" }]
        })],
        outcome: "succeeded",
        diagnostic: false
      },
      {
        name: "missing-repository-discovery",
        research: { scope: "repository", requireLiveSources: false, requireRepositoryEvidence: true },
        text: "Repository finding in src/runtime/agent.ts:12.",
        executions: [successfulEvidenceExecution("file.read", "read-only-local", ["files", "research"], {
          path: "src/runtime/agent.ts"
        }, "# src/runtime/agent.ts\nexport class Agent {}", { path: "src/runtime/agent.ts" })],
        outcome: "failed",
        diagnostic: true
      },
      {
        name: "accepted-repository-evidence",
        research: { scope: "repository", requireLiveSources: false, requireRepositoryEvidence: true },
        text: "Repository finding in src/runtime/agent.ts:12.",
        executions: [
          successfulEvidenceExecution("file.search", "read-only-local", ["files", "research"], {
            query: "class Agent"
          }, "src/runtime/agent.ts:12:export class Agent {}"),
          successfulEvidenceExecution("file.read", "read-only-local", ["files", "research"], {
            path: "src/runtime/agent.ts"
          }, "# src/runtime/agent.ts\nexport class Agent {}", { path: "src/runtime/agent.ts" })
        ],
        outcome: "succeeded",
        diagnostic: false
      }
    ] as const;

    for (const candidate of cases) {
      const graph = makeGraph();
      const step: TaskStep = {
        ...graph.steps[0]!,
        id: `step-${candidate.name}`,
        executor: {
          ...graph.steps[0]!.executor,
          research: candidate.research
        }
      };
      const handle = vi.fn(async () => response({
        text: candidate.text,
        toolExecutions: [...candidate.executions]
      }));
      const childFactory: ChildAgentLoopFactory = {
        createChild: vi.fn(async (input) => {
          const sessionId = `worker-${candidate.name}`;
          await sessionDb.createSession({
            id: sessionId,
            profileId: input.profileId,
            parentSessionId: input.parentSessionId,
            metadata: { kind: "task-step-worker", ...(input.taskExecution ?? {}) }
          });
          return childRuntime(handle, async () => undefined, {
            sessionId,
            trajectoryId: `trajectory-${candidate.name}`
          }, {
            tools: candidate.executions.map((execution) => execution.tool.name),
            toolsets: [...new Set(candidate.executions.flatMap((execution) => execution.tool.toolsets))]
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
        approvalService: new TaskApprovalService({ store }),
        securityPolicy: capabilityFirstDefaults
      });

      const settlement = await executor.execute({
        task: graph.task,
        step,
        attempt: attempt({ ...graph, steps: [step] }),
        signal: new AbortController().signal,
        heartbeat: vi.fn(),
        checkpoint: vi.fn()
      });

      expect(settlement.outcome).toBe(candidate.outcome);
      if (candidate.outcome === "failed") {
        expect(settlement).toMatchObject({
          failure: { class: "evidence-contract-unsatisfied", retryable: false }
        });
        expect(settlement).toHaveProperty("diagnosticResults");
      } else {
        expect(settlement).toMatchObject({
          results: [expect.objectContaining({ kind: "text", content: candidate.text })]
        });
      }
      expect(handle).toHaveBeenCalledOnce();
    }
  });

  it("records the durable Task ancestry depth in timeout diagnostics", async () => {
    vi.useFakeTimers();
    try {
      const lineage = makeNestedLineage(3);
      const nestedStore = taskStoreWithLineage(store, lineage);
      const graph = lineage[lineage.length - 1]!;
      const childFactory: ChildAgentLoopFactory = {
        createChild: vi.fn(async (input) => {
          await sessionDb.createSession({
            id: "worker-depth-timeout",
            profileId: input.profileId,
            parentSessionId: input.parentSessionId,
            metadata: { kind: "task-step-worker", ...(input.taskExecution ?? {}), depth: input.depth }
          });
          return childRuntime(
            async () => await new Promise<AgentLoopResponse>(() => undefined),
            async () => undefined,
            { sessionId: "worker-depth-timeout", trajectoryId: "trajectory-depth-timeout" }
          );
        })
      };
      const executor = new AgentStepExecutor({
        childFactory,
        sessionDb,
        taskStore: nestedStore,
        hostWorkspace: graph.task.workspace,
        isWorkspaceTrusted: () => true,
        parentVisibleTools: () => tools(),
        delegationConfig: { ...DEFAULT_DELEGATION_CONFIG, childTimeoutSeconds: 1 },
        diagnosticsRoot: tempDir,
        approvalService: new TaskApprovalService({ store: nestedStore }),
        securityPolicy: capabilityFirstDefaults,
        now
      });

      const execution = executor.execute({
        task: graph.task,
        step: graph.steps[0]!,
        attempt: attempt(graph),
        signal: new AbortController().signal,
        heartbeat: vi.fn(),
        checkpoint: vi.fn()
      });
      await vi.advanceTimersByTimeAsync(1_001);

      await expect(execution).resolves.toMatchObject({
        outcome: "failed",
        failure: { class: "timeout" },
        workerSessionId: "worker-depth-timeout"
      });
      const diagnosticFiles = readdirSync(join(tempDir, "delegation"));
      expect(diagnosticFiles).toHaveLength(1);
      const diagnostic = JSON.parse(readFileSync(join(tempDir, "delegation", diagnosticFiles[0]!), "utf8")) as
        Record<string, unknown>;
      expect(diagnostic).toMatchObject({
        reason: "timeout",
        depth: 3
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives dependent Steps directly executable Task result read inputs without exposing opaque handles", async () => {
    const base = makeDependencyGraph();
    const researchStep: TaskStep = {
      ...base.steps[0]!,
      executor: {
        ...base.steps[0]!.executor,
        research: {
          scope: "accepted-live-evidence",
          requireLiveSources: true,
          requireRepositoryEvidence: false
        }
      }
    };
    const graph = { ...base, steps: [researchStep, base.steps[1]!] };
    store.createTaskGraph(graph);
    resultService.record({
      id: "failed-dependency-output",
      taskId: graph.task.id,
      stepId: graph.steps[0]!.id,
      kind: "text",
      disposition: "diagnostic",
      content: "Incomplete dependency output that must not be synthesized."
    });
    const dependencyResult = resultService.record({
      id: "dependency-result",
      taskId: graph.task.id,
      stepId: graph.steps[0]!.id,
      kind: "text",
      content: "Verified dependency content.",
      summary: "Verified dependency summary."
    });
    let childInput: CreateChildAgentLoopInput | undefined;
    const childFactory: ChildAgentLoopFactory = {
      createChild: vi.fn(async (input) => {
        childInput = input;
        await sessionDb.createSession({
          id: "worker-synthesis",
          profileId: input.profileId,
          parentSessionId: input.parentSessionId,
          metadata: { kind: "task-step-worker", ...(input.taskExecution ?? {}) }
        });
        return childRuntime(async () => response(), vi.fn(async () => undefined), {
          sessionId: "worker-synthesis",
          trajectoryId: "trajectory-synthesis"
        }, { tools: ["task.result.read"], toolsets: ["core"] });
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

    await expect(executor.execute({
      task: graph.task,
      step: graph.steps[1]!,
      attempt: attempt(graph, graph.steps[1]!),
      signal: new AbortController().signal,
      heartbeat: vi.fn(),
      checkpoint: vi.fn()
    })).resolves.toMatchObject({ outcome: "succeeded" });

    const marker = "Do not derive task_id from a result handle:\n";
    const context = childInput?.context ?? "";
    const markerIndex = context.indexOf(marker);
    expect(markerIndex).toBeGreaterThanOrEqual(0);
    const references = JSON.parse(context.slice(markerIndex + marker.length)) as Array<Record<string, unknown>>;
    expect(references).toEqual([{
      stepId: graph.steps[0]!.id,
      researchScope: "accepted-live-evidence",
      readInput: {
        task_id: graph.task.id,
        result_id: dependencyResult.id
      },
      kind: "text",
      bytes: Buffer.byteLength("Verified dependency content."),
      summary: "Verified dependency summary."
    }]);
    expect(references[0]).not.toHaveProperty("handle");
    expect(references[0]).not.toHaveProperty("resultId");

    const [readTool] = createTaskResultTools({
      service: resultService,
      currentSessionId: () => "creator-alpha"
    });
    await expect(readTool!.run(references[0]!.readInput)).resolves.toMatchObject({
      ok: true,
      content: "Verified dependency content.",
      metadata: {
        taskId: graph.task.id,
        resultId: dependencyResult.id
      }
    });
  });

  it("gives partial synthesis an explicit bounded coverage manifest without diagnostic output", async () => {
    const base = makeDependencyGraph();
    const successful: TaskStep = {
      ...base.steps[0]!,
      id: "step-successful",
      key: "successful",
      title: "Research successful source",
      position: 0,
      executor: {
        ...base.steps[0]!.executor,
        research: { scope: "available-scope", requireLiveSources: true, requireRepositoryEvidence: false }
      }
    };
    const failed: TaskStep = {
      ...base.steps[0]!,
      id: "step-failed",
      key: "failed",
      title: "Research unavailable source",
      position: 1,
      executor: {
        ...base.steps[0]!.executor,
        research: { scope: "missing-scope", requireLiveSources: true, requireRepositoryEvidence: false }
      }
    };
    const synthesis: TaskStep = {
      ...base.steps[1]!,
      position: 2,
      dependsOn: [successful.id, failed.id],
      executor: { kind: "agent", role: "synthesis" }
    };
    const graph = { ...base, steps: [successful, failed, synthesis] };
    store.createTaskGraph(graph);
    for (const dependency of [successful, failed]) {
      store.updateStep({ ...dependency, status: "ready" });
      store.updateStep({ ...dependency, status: "running" });
    }
    store.updateStep({ ...successful, status: "completed" });
    store.updateStep({ ...failed, status: "failed" });
    resultService.record({
      id: "accepted-partial-result",
      taskId: graph.task.id,
      stepId: successful.id,
      kind: "text",
      content: "Verified partial evidence.",
      summary: "Verified partial evidence summary."
    });
    resultService.record({
      id: "diagnostic-partial-result",
      taskId: graph.task.id,
      stepId: failed.id,
      kind: "text",
      disposition: "diagnostic",
      content: "Untrusted incomplete output must stay out of synthesis context."
    });
    let childInput: CreateChildAgentLoopInput | undefined;
    const executor = new AgentStepExecutor({
      childFactory: {
        createChild: vi.fn(async (input) => {
          childInput = input;
          await sessionDb.createSession({
            id: "worker-partial-synthesis",
            profileId: input.profileId,
            parentSessionId: input.parentSessionId,
            metadata: { kind: "task-step-worker", ...(input.taskExecution ?? {}) }
          });
          return childRuntime(async () => response(), vi.fn(async () => undefined), {
            sessionId: "worker-partial-synthesis",
            trajectoryId: "trajectory-partial-synthesis"
          }, { tools: ["task.result.read"], toolsets: ["core"] });
        })
      },
      sessionDb,
      taskStore: store,
      hostWorkspace: graph.task.workspace,
      isWorkspaceTrusted: () => true,
      parentVisibleTools: () => tools(),
      approvalService: new TaskApprovalService({ store }),
      securityPolicy: capabilityFirstDefaults
    });

    await expect(executor.execute({
      task: graph.task,
      step: synthesis,
      attempt: attempt(graph, synthesis),
      signal: new AbortController().signal,
      heartbeat: vi.fn(),
      checkpoint: vi.fn()
    })).resolves.toMatchObject({ outcome: "succeeded" });

    const context = childInput?.context ?? "";
    expect(context).toContain("Partial synthesis boundary");
    expect(context).toContain("Keep each scope's evidence distinct");
    expect(context).toContain("Explicitly identify failed, cancelled, skipped, or missing coverage");
    expect(context).toContain(`\"stepId\":\"${successful.id}\",\"title\":\"${successful.title}\",\"researchScope\":\"available-scope\",\"status\":\"completed\",\"resultAvailable\":true`);
    expect(context).toContain(`\"stepId\":\"${failed.id}\",\"title\":\"${failed.title}\",\"researchScope\":\"missing-scope\",\"status\":\"failed\",\"resultAvailable\":false`);
    expect(context).toContain("missing-scope");
    expect(context).toContain("accepted-partial-result");
    expect(context).not.toContain("diagnostic-partial-result");
    expect(context).not.toContain("Untrusted incomplete output");
    expect(context.length).toBeLessThanOrEqual(16_000);
  });

  it.each([[false,"provider-accounting"], [true,"provider-accounting"], [false,"evidence-contract-unsatisfied"], [true,"evidence-contract-unsatisfied"]] as const)("carries a prior draft into targeted recovery within its profile (foreign=%s, failure=%s)", async (foreign, failureClass) => {
    const graph = makeGraph();
    store.createTaskGraph(graph);
    await sessionDb.createSession({ id: "prior-worker", profileId: foreign ? "other" : "alpha", parentSessionId: "creator-alpha" });
    await sessionDb.appendMessage({ sessionId: "prior-worker", role: "agent", content: "Retained research with https://example.org/study", metadata: { [failureClass === "provider-accounting" ? "accountingDiagnostic" : "completionCandidate"]: true, accepted: false } });
    vi.spyOn(store, "listAttempts").mockReturnValue([{ ...attempt(graph), attemptNumber: 1, workerSessionId: "prior-worker",
      failure: { class: failureClass, message: "Unresolved defect", retryable: true, uncertainSideEffects: false } }]);
    const createChild = vi.fn(async (input: CreateChildAgentLoopInput) => {
      await sessionDb.createSession({ id: "next-worker", profileId: input.profileId, parentSessionId: input.parentSessionId });
      return childRuntime(async () => response(), async () => undefined, { sessionId: "next-worker", trajectoryId: "recovery-trajectory" });
    });
    const executor = new AgentStepExecutor({ childFactory: { createChild }, sessionDb, taskStore: store, hostWorkspace: graph.task.workspace,
      isWorkspaceTrusted: () => true, parentVisibleTools: tools, approvalService: new TaskApprovalService({ store }), securityPolicy: capabilityFirstDefaults });
    await executor.execute({ task: graph.task, step: graph.steps[0]!, attempt: { ...attempt(graph), attemptNumber: 2 },
      signal: new AbortController().signal, heartbeat: vi.fn(), checkpoint: vi.fn() });
    const context = createChild.mock.calls[0]![0].context;
    if (foreign) expect(context).not.toContain("Retained research");
    else {
      expect(context).toContain("Retained research with https://example.org/study");
      expect(context).toContain("not accepted evidence");
      expect(context).toContain("verify its relevant sources");
    }
  });

  it.each([false, true])("retains accounting drafts only for read-only steps (mutating=%s)", async mutating => {
    const graph = makeGraph();
    if (mutating) graph.steps[0]!.authorityPolicy = { ...graph.steps[0]!.authorityPolicy,
      riskClassPolicy: riskPolicy({ "read-only-local": "runtime_policy", "destructive-local": "runtime_policy" }) };
    const childFactory: ChildAgentLoopFactory = { createChild: vi.fn(async input => {
      await sessionDb.createSession({ id: "worker-accounting", profileId: input.profileId, parentSessionId: input.parentSessionId });
      return childRuntime(async () => { throw new ProviderAccountingError("Useful draft.\npassword: secret-value-for-test"); }, async () => undefined,
        { sessionId: "worker-accounting", trajectoryId: "accounting-trajectory" });
    }) };
    const executor = new AgentStepExecutor({ childFactory, sessionDb, taskStore: store, hostWorkspace: graph.task.workspace,
      isWorkspaceTrusted: () => true, parentVisibleTools: tools, approvalService: new TaskApprovalService({ store }), securityPolicy: capabilityFirstDefaults });
    const settlement = await executor.execute({ task: graph.task, step: graph.steps[0]!, attempt: attempt(graph),
      signal: new AbortController().signal, heartbeat: vi.fn(), checkpoint: vi.fn() });
    expect(settlement).toMatchObject({ outcome: "failed", failure: { class: "provider-accounting", retryable: !mutating, uncertainSideEffects: mutating } });
    expect(JSON.stringify(settlement)).not.toContain("secret-value-for-test");
    if (mutating) expect(settlement).not.toHaveProperty("diagnosticResults");
    else expect(settlement).toMatchObject({ diagnosticResults: [{ content: expect.stringContaining("Useful draft.") }] });
    expect((await sessionDb.listMessages("worker-accounting")).some(message => message.metadata?.accountingDiagnostic)).toBe(!mutating);
  });

  it("settles exhaustion with the original defect and substantive draft rather than validating the stop message", async () => {
    const graph = makeGraph();
    const childFactory: ChildAgentLoopFactory = { createChild: vi.fn(async input => {
      await sessionDb.createSession({ id: "stopped-worker", profileId: input.profileId, parentSessionId: input.parentSessionId });
      return childRuntime(async () => response({ text: "Execution stopped before an accepted answer was produced.",
        completionCandidate: "Substantive rejected findings", completionValidationFailure: "unobserved-source: repair citation",
        finalOutcome: { status: "partially_completed", terminationCause: "budget_exhausted", completionFloor: "read", confirmedActions: [], uncertainActions: [] } }),
        async () => undefined, { sessionId: "stopped-worker", trajectoryId: "stopped" });
    }) };
    const executor = new AgentStepExecutor({ childFactory, sessionDb, taskStore: store, hostWorkspace: graph.task.workspace,
      isWorkspaceTrusted: () => true, parentVisibleTools: tools, approvalService: new TaskApprovalService({ store }), securityPolicy: capabilityFirstDefaults });
    const settled = await executor.execute({ task: graph.task, step: graph.steps[0]!, attempt: attempt(graph), signal: new AbortController().signal, heartbeat: vi.fn(), checkpoint: vi.fn() });
    expect(settled).toMatchObject({ outcome: "failed", failure: { class: "execution-stopped", message: expect.stringContaining("budget_exhausted") }, diagnosticResults: [{ content: "Substantive rejected findings" }] });
    expect(JSON.stringify(settled)).toContain("unobserved-source");
    expect(JSON.stringify(settled)).not.toContain("source-citations-missing");
  });

  it("keeps accepted-report content checks in the delivery runtime even with an execution marker", async () => {
    const graph = makeGraph();
    graph.steps[0]!.executor = { ...graph.steps[0]!.executor, role: "report-delivery", requestContract: {
      version: 1, objective: "Save report.md", requirements: { skillReferences: [], issues: [],
        fileOutput: { format: "markdown", path: "report.md", verification: "execution" } }
    } };
    let handled: AgentLoopInput | undefined;
    const childFactory: ChildAgentLoopFactory = { createChild: vi.fn(async input => {
      await sessionDb.createSession({ id: "delivery-worker", profileId: input.profileId, parentSessionId: input.parentSessionId });
      return childRuntime(async request => { handled = request; return response(); }, async () => undefined,
        { sessionId: "delivery-worker", trajectoryId: "delivery" });
    }) };
    const executor = new AgentStepExecutor({ childFactory, sessionDb, taskStore: store, hostWorkspace: graph.task.workspace,
      isWorkspaceTrusted: () => true, parentVisibleTools: tools, approvalService: new TaskApprovalService({ store }), securityPolicy: capabilityFirstDefaults });
    const settled = await executor.execute({ task: graph.task, step: graph.steps[0]!, attempt: attempt(graph), signal: new AbortController().signal, heartbeat: vi.fn(), checkpoint: vi.fn() });
    expect(handled?.stepCompletion?.requirements).toMatchObject({ sourceTaskId: graph.task.id, fileOutput: { verification: "execution" } });
    const { requiresAnyFileContentVerification } = await import("../contracts/request-requirements.js");
    expect(requiresAnyFileContentVerification(handled?.stepCompletion?.requirements)).toBe(true);
    expect(settled).toMatchObject({ outcome: "failed", failure: { class: "evidence-contract-unsatisfied" } });
  });

  it("returns safe read-only failure output as diagnostic content", async () => {
    const graph = makeGraph();
    const childFactory: ChildAgentLoopFactory = {
      createChild: vi.fn(async (input) => {
        await sessionDb.createSession({
          id: "worker-read-failure",
          profileId: input.profileId,
          parentSessionId: input.parentSessionId,
          metadata: { kind: "task-step-worker", ...(input.taskExecution ?? {}) }
        });
        return childRuntime(async () => response({
          text: "Partial findings before the read failed.",
          toolExecutions: [{
            tool: tool("file.read", "read-only-local", ["files"]),
            input: { path: "notes.txt" },
            decision: "allow",
            riskClass: "read-only-local",
            result: { ok: false, content: "Read failed." }
          }]
        }), async () => undefined, {
          sessionId: "worker-read-failure",
          trajectoryId: "trajectory-read-failure"
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
      failure: { class: "tool-error" },
      diagnosticResults: [{ kind: "text", content: "Partial findings before the read failed." }]
    });
  });

  it.each(["alternative", "disclosed", "required-source", "required-code-source", "missing-table", "unobserved", "denied", "unavailable-tool", "search-recovered", "search-no-evidence", "search-denied", "search-unavailable", "dns-unavailable", "fetch-failed", "provider-failed", "unsafe-url"])("handles inaccessible research sources: %s", async mode => {
    const graph=makeGraph(), base=graph.steps[0]!;
    const url="https://observed.example/report", unavailable="https://unavailable.example/report(2026).pdf";
    const step:TaskStep={...base,objective:mode==="required-source"?`Read ${unavailable}`:mode==="required-code-source"?`Read \`${unavailable}\``:"Research methods",executor:{...base.executor,role:"worker",
      research:{scope:"methods",requireLiveSources:true,requireRepositoryEvidence:false},requestContract:{version:1,objective:"Research",requirements:{skillReferences:[],issues:[],research:{fresh:true,domain:"general"}}}}};
    const calls: import("../tools/tool-executor.js").ToolExecutionRecord[]=[successfulEvidenceExecution("web.search","read-only-network",["web","research"],{query:"methods"},"Observed",{provider:"ddgs",results:[{url,snippet:"A method"},...(mode==="disclosed"?[{url:unavailable,snippet:"Study abstract"}]:[])]}),{
      tool:tool("web.extract","read-only-network",["web"]),input:{url:unavailable},decision:mode==="denied"?"deny" as const:"allow" as const,riskClass:"read-only-network" as const,
      result:{ok:false,content:"Unavailable",metadata:mode==="unavailable-tool"?{reason:"unavailable"}:mode==="dns-unavailable"?{reason:"url-resolution-failed"}:["unsafe-url", "fetch-failed", "provider-failed"].includes(mode)?{reason:mode}:{status:403}}}];
    if(mode.startsWith("search-")) {
      calls[1]={tool:tool("web.search","read-only-network",["web"]),input:{query:"additional sources"},decision:mode==="search-denied"?"deny":"allow",riskClass:"read-only-network",
        result:{ok:false,content:"Search unavailable",metadata:{provider:"ddgs",reason:mode==="search-unavailable"?"unavailable":"provider-failed"}}};
      if(mode==="search-no-evidence") calls.shift();
    }
    const text=(mode==="missing-table"?`Found ${url}`:`| Source URL | Supported claim | Limitation |\n| --- | --- | --- |\n| ${mode==="unobserved"?"https://invented.example/report":url} | A method | Snippet only |`)+(mode==="disclosed"?`\nAccess limitation: ${unavailable} returned HTTP 403; only its search snippet was observed.`:"");
    const childFactory:ChildAgentLoopFactory={createChild:vi.fn(async input=>{
      await sessionDb.createSession({id:"alternative-worker",profileId:input.profileId,parentSessionId:input.parentSessionId});
      return childRuntime(async request=>{
        const failure = request.stepCompletion?.validate?.(text, calls);
        expect(failure === undefined).toBe(["alternative", "disclosed", "missing-table", "search-recovered", "dns-unavailable", "fetch-failed", "provider-failed"].includes(mode));
        return response({text,toolExecutions:calls});
      },async()=>undefined,{sessionId:"alternative-worker",trajectoryId:"alternative-trajectory"}, {tools:calls.map(call=>call.tool.name),toolsets:["web","research"]});
    })};
    const executor=new AgentStepExecutor({childFactory,sessionDb,taskStore:store,hostWorkspace:graph.task.workspace,isWorkspaceTrusted:()=>true,parentVisibleTools:()=>tools(),approvalService:new TaskApprovalService({store}),securityPolicy:capabilityFirstDefaults});
    const result=await executor.execute({task:graph.task,step,attempt:attempt({...graph,steps:[step]}),signal:new AbortController().signal,heartbeat:vi.fn(),checkpoint:vi.fn()});
    expect(result.outcome).toBe(["alternative", "disclosed", "missing-table", "search-recovered", "dns-unavailable", "fetch-failed", "provider-failed"].includes(mode)?"succeeded":"failed");
    if(result.outcome==="succeeded")expect(result.results?.[0]?.content).toContain("Source access limitation: 1");
  });

  it.each([
    "alternative", "public-canonical", "no-read", "earlier-read", "uncited-read", "empty-read",
    "denied", "denied-alternative", "required-step", "required-scope", "required-parent",
    "rejected-citation", "unsafe-url", "redirect-secret-in-url", "network-disabled", "unavailable",
    "uncertain-effect", "other-failure"
  ])("abandons only optional pre-fetch secret URLs with cited later evidence: %s", async mode => {
    const graph = makeGraph(), base = graph.steps[0]!;
    const rejected = "https://candidate.example/keyboard?token=test-only-secret";
    const alternative = mode === "public-canonical" ? "https://candidate.example/keyboard" : "https://primary.example/keyboard";
    const observed = "Keyboard navigation must provide visible focus.";
    const fetch = vi.fn(async () => ({ ok: true, status: 200, statusText: "OK", headers: { get: () => "text/plain" }, text: async () => observed }));
    const resolveHostname = vi.fn(async () => ["93.184.216.34"]);
    const extract = createWebTools({ enableNetwork: true, fetch, resolveHostname }).find(t => t.name === "web.extract")!;
    const blocked = await extract.run({ url: rejected });
    expect(blocked).toMatchObject({ ok: false, metadata: { reason: "secret-in-url" } });
    expect(JSON.stringify(blocked)).not.toContain("test-only-secret");
    expect(fetch).not.toHaveBeenCalled();
    expect(resolveHostname).not.toHaveBeenCalled();
    const step: TaskStep = { ...base, objective: mode === "required-step" ? `Read ${rejected}` : "Research keyboard navigation",
      executor: { ...base.executor, role: "worker",
        research: { scope: mode === "required-scope" ? `Read ${rejected}` : "keyboard navigation", requireLiveSources: true, requireRepositoryEvidence: false },
        requestContract: { version: 1, objective: mode === "required-parent" ? `Use only ${rejected}` : "Research accessible forms",
          requirements: { skillReferences: [], issues: [], research: { fresh: true, domain: "general" } } } } };
    const failure: import("../tools/tool-executor.js").ToolExecutionRecord = {
      tool: extract, input: { url: rejected }, decision: mode === "denied" ? "deny" : "allow", riskClass: "read-only-network", result: blocked
    };
    if (["unsafe-url", "redirect-secret-in-url", "network-disabled", "unavailable"].includes(mode)) {
      failure.result = { ...blocked, metadata: { ...blocked.metadata, reason: mode } };
    }
    if (mode === "uncertain-effect") failure.settlement = { terminalStatus: "failed", dispatchState: "finished", sideEffectState: "possible" };
    const calls: import("../tools/tool-executor.js").ToolExecutionRecord[] = [
      successfulEvidenceExecution("web.search", "read-only-network", ["web", "research"], { query: "keyboard navigation" }, "Observed candidates",
        { provider: "ddgs", results: [{ url: alternative, snippet: observed }, { url: rejected, snippet: "Unverified candidate" }, { url: "https://snippet.example/overview", snippet: "Overview" }] }), failure
    ];
    if (mode !== "no-read") {
      const read: import("../tools/tool-executor.js").ToolExecutionRecord = { tool: extract, input: { url: alternative },
        decision: mode === "denied-alternative" ? "deny" : "allow", riskClass: "read-only-network", result: await extract.run({ url: alternative }) };
      if (mode === "empty-read") read.result!.metadata = { ...read.result!.metadata, content: "" };
      if (mode === "earlier-read") calls.splice(1, 0, read); else calls.push(read);
    }
    if (mode === "other-failure") calls.push({ ...failure, input: { url: "http://127.0.0.1/private" }, result: { ok: false, content: "Blocked", metadata: { reason: "unsafe-url" } } });
    const text = mode === "uncited-read" ? "Keyboard overview. Source: https://snippet.example/overview" :
      `${observed} Source: ${alternative}. Evidence: retrieved passage, not an interactive accessibility test.` + (mode === "rejected-citation" ? ` Also supported by ${rejected}` : "");
    const accepted = mode === "alternative" || mode === "public-canonical";
    const childFactory: ChildAgentLoopFactory = { createChild: vi.fn(async input => {
      await sessionDb.createSession({ id: "secret-url-worker", profileId: input.profileId, parentSessionId: input.parentSessionId });
      return childRuntime(async request => {
        // Search observations alone do not resolve a rejected candidate.
        expect(request.stepCompletion?.validate?.(text, [calls[0]!, failure])).toBeDefined();
        expect(request.stepCompletion?.validate?.(text, calls) === undefined).toBe(accepted);
        return response({ text, toolExecutions: calls });
      }, async () => undefined, { sessionId: "secret-url-worker", trajectoryId: "secret-url-trajectory" },
      { tools: ["web.search", "web.extract"], toolsets: ["web", "research"] });
    }) };
    const executor = new AgentStepExecutor({ childFactory, sessionDb, taskStore: store, hostWorkspace: graph.task.workspace,
      isWorkspaceTrusted: () => true, parentVisibleTools: () => tools(), approvalService: new TaskApprovalService({ store }), securityPolicy: capabilityFirstDefaults });
    const result = await executor.execute({ task: graph.task, step, attempt: attempt({ ...graph, steps: [step] }), signal: new AbortController().signal, heartbeat: vi.fn(), checkpoint: vi.fn() });
    expect(result.outcome).toBe(accepted ? "succeeded" : "failed");
    if (result.outcome === "succeeded") {
      expect(result.results?.[0]?.content).toContain("Source access limitation: 1");
      expect(result.results?.[0]?.content).not.toContain("test-only-secret");
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it.each(["recovered", "offset", "unrecovered", "different-source", "denied", "empty"])("handles bounded passage recovery: %s", async mode => {
    const graph = makeGraph(), base = graph.steps[0]!;
    const url = "https://observed.example/report";
    const step: TaskStep = { ...base, objective: "Research validator behavior", executor: { ...base.executor, role: "worker",
      research: { scope: "validator behavior", requireLiveSources: true, requireRepositoryEvidence: false },
      requestContract: { version: 1, objective: "Research validator behavior", requirements: { skillReferences: [], issues: [], research: { fresh: true, domain: "general" } } } } };
    const extract = createWebTools({ enableNetwork: true, resolveHostname: async () => ["93.184.216.34"],
      fetch: async () => ({ ok: true, status: 200, statusText: "OK", headers: { get: () => "text/plain" },
        text: async () => "If-None-Match uses weak comparison for cache validation." }) }).find(t => t.name === "web.extract")!;
    const accepted = mode === "recovered" || mode === "offset";
    const firstInput = mode === "offset" ? { url, startChar: 99999 } : { url, query: "A sender MAY generate a weak" };
    const secondInput = { url: mode === "different-source" ? "https://other.example/report" : url, query: mode === "unrecovered" ? "missing phrase" : "uses weak comparison" };
    const calls: import("../tools/tool-executor.js").ToolExecutionRecord[] = [
      successfulEvidenceExecution("web.search", "read-only-network", ["web", "research"], { query: "validator behavior" }, "Observed", {provider: "ddgs", results: [{ url, snippet: "If-None-Match uses weak comparison." }]}),
      ...await Promise.all([firstInput,secondInput].map(async input => ({tool:extract,input,decision:"allow" as const,riskClass:"read-only-network" as const,result:await extract.run(input)})))
    ];
    if (mode === "denied") calls[1]!.decision = "deny";
    if (mode === "empty") calls[2]!.result!.metadata = { ...calls[2]!.result!.metadata, content: "" };
    const text = `If-None-Match uses weak comparison for cache validation. Source: ${url}. Evidence: retrieved source text; not an interoperability test.`;
    const childFactory:ChildAgentLoopFactory={createChild:vi.fn(async input=>{
      await sessionDb.createSession({id:"regression-worker",profileId:input.profileId,parentSessionId:input.parentSessionId});
      return childRuntime(async request=>{
        const feedback=request.stepCompletion?.validate?.(text,calls);
        expect(feedback === undefined).toBe(accepted);
        return response({text,toolExecutions:calls});
      },async()=>undefined,{sessionId:"regression-worker",trajectoryId:"regression-trajectory"},{tools:calls.map(call=>call.tool.name),toolsets:["web","research"]});
    })};
    const executor=new AgentStepExecutor({childFactory,sessionDb,taskStore:store,hostWorkspace:graph.task.workspace,isWorkspaceTrusted:()=>true,parentVisibleTools:()=>tools(),approvalService:new TaskApprovalService({store}),securityPolicy:capabilityFirstDefaults});
    const result=await executor.execute({task:graph.task,step,attempt:attempt({...graph,steps:[step]}),signal:new AbortController().signal,heartbeat:vi.fn(),checkpoint:vi.fn()});

    expect(result.outcome).toBe(accepted ? "succeeded" : "failed");
  });

  it("accepts an exact read retry that succeeds later in the same Attempt", async () => {
    const graph = makeGraph();
    const fileRead = tool("file.read", "read-only-local", ["files"]);
    const childFactory: ChildAgentLoopFactory = {
      createChild: vi.fn(async (input) => {
        await sessionDb.createSession({
          id: "worker-read-recovered",
          profileId: input.profileId,
          parentSessionId: input.parentSessionId,
          metadata: { kind: "task-step-worker", ...(input.taskExecution ?? {}) }
        });
        return childRuntime(async () => response({
          text: "Verified content after retry.",
          toolExecutions: [
            {
              tool: fileRead,
              input: { path: "notes.txt", line: 1 },
              decision: "allow",
              riskClass: "read-only-local",
              result: { ok: false, content: "Temporary read failure." }
            },
            {
              tool: fileRead,
              input: { line: 1, path: "notes.txt" },
              decision: "allow",
              riskClass: "read-only-local",
              result: { ok: true, content: "Verified source." }
            }
          ]
        }), async () => undefined, {
          sessionId: "worker-read-recovered",
          trajectoryId: "trajectory-read-recovered"
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
      outcome: "succeeded",
      results: [{ kind: "text", content: "Verified content after retry." }]
    });
  });

  it("does not publish diagnostic output from denied or mutating tool activity", async () => {
    const graph = makeGraph();
    let responseNumber = 0;
    const childFactory: ChildAgentLoopFactory = {
      createChild: vi.fn(async (input) => {
        responseNumber++;
        const sessionId = `worker-unsafe-${responseNumber}`;
        await sessionDb.createSession({
          id: sessionId,
          profileId: input.profileId,
          parentSessionId: input.parentSessionId,
          metadata: { kind: "task-step-worker", ...(input.taskExecution ?? {}) }
        });
        const denied = responseNumber === 1;
        return childRuntime(async () => response({
          text: denied ? "Content produced behind a denied boundary." : "Output after a failed mutation.",
          toolExecutions: [{
            tool: tool(denied ? "file.read" : "terminal.run", denied ? "read-only-local" : "workspace-write", ["files"]),
            input: {},
            decision: denied ? "deny" : "allow",
            riskClass: denied ? "read-only-local" : "workspace-write",
            result: { ok: false, content: denied ? "Denied." : "Mutation failed." }
          }]
        }), async () => undefined, {
          sessionId,
          trajectoryId: `trajectory-unsafe-${responseNumber}`
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
      approvalService: new TaskApprovalService({ store }),
      securityPolicy: capabilityFirstDefaults
    });
    const execute = () => executor.execute({
      task: graph.task,
      step: graph.steps[0]!,
      attempt: attempt(graph),
      signal: new AbortController().signal,
      heartbeat: vi.fn(),
      checkpoint: vi.fn()
    });

    const deniedSettlement = await execute();
    expect(deniedSettlement).toMatchObject({ outcome: "failed", failure: { class: "security-deny" } });
    expect(deniedSettlement).not.toHaveProperty("diagnosticResults");
    const mutatingSettlement = await execute();
    expect(mutatingSettlement).toMatchObject({ outcome: "failed", failure: { class: "tool-error" } });
    expect(mutatingSettlement).not.toHaveProperty("diagnosticResults");
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

  it("fails closed before child construction when the scheduler provides no Attempt lease", async () => {
    const graph = makeGraph();
    const createChild = vi.fn();
    const executor = new AgentStepExecutor({
      childFactory: { createChild },
      sessionDb,
      taskStore: store,
      hostWorkspace: graph.task.workspace,
      isWorkspaceTrusted: () => true,
      parentVisibleTools: () => tools(),
      approvalService: new TaskApprovalService({ store }),
      securityPolicy: capabilityFirstDefaults
    });
    const unleasedAttempt: TaskAttempt = attempt(graph);
    delete unleasedAttempt.lease;

    await expect(executor.execute({
      task: graph.task,
      step: graph.steps[0]!,
      attempt: unleasedAttempt,
      signal: new AbortController().signal,
      heartbeat: vi.fn(),
      checkpoint: vi.fn()
    })).resolves.toMatchObject({
      outcome: "failed",
      failure: { class: "lease-missing", retryable: true, uncertainSideEffects: false }
    });
    expect(createChild).not.toHaveBeenCalled();
  });

  it("cancels and cleans up a child resolved after construction-time cancellation", async () => {
    const graph = makeGraph();
    let resolveChild!: (child: ChildAgentLoopRuntime) => void;
    const childReady = new Promise<ChildAgentLoopRuntime>((resolve) => { resolveChild = resolve; });
    const handle = vi.fn(async () => response());
    const cleanup = vi.fn(async () => undefined);
    const createChild = vi.fn(() => childReady);
    const executor = new AgentStepExecutor({
      childFactory: { createChild },
      sessionDb,
      taskStore: store,
      hostWorkspace: graph.task.workspace,
      isWorkspaceTrusted: () => true,
      parentVisibleTools: () => tools(),
      approvalService: new TaskApprovalService({ store }),
      securityPolicy: capabilityFirstDefaults
    });
    const controller = new AbortController();
    const checkpoint = vi.fn();
    const execution = executor.execute({
      task: graph.task,
      step: graph.steps[0]!,
      attempt: attempt(graph),
      signal: controller.signal,
      heartbeat: vi.fn(),
      checkpoint
    });
    await vi.waitFor(() => expect(createChild).toHaveBeenCalledOnce());

    controller.abort("operator-request");
    await sessionDb.createSession({
      id: "worker-cancelled-construction",
      profileId: "alpha",
      parentSessionId: "creator-alpha"
    });
    resolveChild(childRuntime(handle, cleanup, {
      sessionId: "worker-cancelled-construction",
      trajectoryId: "trajectory-cancelled-construction"
    }));

    await expect(execution).resolves.toMatchObject({
      outcome: "cancelled",
      workerSessionId: "worker-cancelled-construction"
    });
    expect(handle).not.toHaveBeenCalled();
    expect(checkpoint).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledOnce();
    await expect(sessionDb.getSession("worker-cancelled-construction")).resolves.toMatchObject({
      endedAt: expect.any(String),
      endReason: "task-step-cancelled"
    });
  });

  it("checkpoints and preserves a child resolved after construction-time host handoff", async () => {
    const graph = makeGraph();
    let resolveChild!: (child: ChildAgentLoopRuntime) => void;
    const childReady = new Promise<ChildAgentLoopRuntime>((resolve) => { resolveChild = resolve; });
    const handle = vi.fn(async () => response());
    const cleanup = vi.fn(async () => undefined);
    const createChild = vi.fn(() => childReady);
    const executor = new AgentStepExecutor({
      childFactory: { createChild },
      sessionDb,
      taskStore: store,
      hostWorkspace: graph.task.workspace,
      isWorkspaceTrusted: () => true,
      parentVisibleTools: () => tools(),
      approvalService: new TaskApprovalService({ store }),
      securityPolicy: capabilityFirstDefaults
    });
    const controller = new AbortController();
    const checkpoint = vi.fn();
    const execution = executor.execute({
      task: graph.task,
      step: graph.steps[0]!,
      attempt: attempt(graph),
      signal: controller.signal,
      heartbeat: vi.fn(),
      checkpoint
    });
    await vi.waitFor(() => expect(createChild).toHaveBeenCalledOnce());
    controller.abort(TASK_STEP_HOST_HANDOFF_ABORT_REASON);
    await sessionDb.createSession({
      id: "worker-handoff-construction",
      profileId: "alpha",
      parentSessionId: "creator-alpha"
    });
    resolveChild(childRuntime(handle, cleanup, {
      sessionId: "worker-handoff-construction",
      trajectoryId: "trajectory-handoff-construction"
    }));

    await expect(execution).resolves.toMatchObject({
      outcome: "cancelled",
      workerSessionId: "worker-handoff-construction"
    });
    expect(handle).not.toHaveBeenCalled();
    expect(checkpoint).toHaveBeenCalledWith({ workerSessionId: "worker-handoff-construction" });
    expect(cleanup).toHaveBeenCalledOnce();
    await expect(sessionDb.getSession("worker-handoff-construction")).resolves.toMatchObject({ endedAt: undefined });
  });

  it("propagates the exact provider spending denial to the Task scheduler", async () => {
    const graph = makeGraph();
    const childFactory: ChildAgentLoopFactory = {
      createChild: vi.fn(async (input) => {
        await sessionDb.createSession({
          id: "worker-spend-denied",
          profileId: input.profileId,
          parentSessionId: input.parentSessionId,
          metadata: { kind: "task-step-worker", ...(input.taskExecution ?? {}) }
        });
        return childRuntime(async () => response({
          providerExecution: {
            ok: false,
            fallbackUsed: false,
            attempts: [{
              provider: "openai",
              model: "child-model",
              state: "preflight",
              ok: false,
              errorClass: "spend-denied",
              content: "No provider request was sent."
            }],
            spendDenialReason: "TASK_CAPACITY_RESERVED",
            toolCalls: []
          }
        }), async () => undefined, {
          sessionId: "worker-spend-denied",
          trajectoryId: "trajectory-spend-denied"
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
      outcome: "spending_denied",
      reason: "TASK_CAPACITY_RESERVED",
      workerSessionId: "worker-spend-denied"
    });
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
    acquireHostLease(store, graph.task, "scheduler-alpha");

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
    originTurnId: "origin-turn-alpha",
    source: "cli",
    executionPreference: "auto",
    creationKey: "create-alpha",
    objective: "Research and return the complete durable result.",
    status: "queued",
    workspace: { canonicalPath: "/workspace/project", identityHash: "workspace-hash" },
    authorityPolicy: policy,
    executionLimits: {
      maxConcurrentAttempts: 1,
      maxProviderCalls: 10,
      maxTotalTokens: 100_000,
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
    executionLimits: { maxProviderCalls: 5, maxTotalTokens: 50_000, maxWallClockMs: 120_000 },
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

function makeNestedLineage(depth: number): ReturnType<typeof makeGraph>[] {
  if (!Number.isSafeInteger(depth) || depth < 1) throw new Error("Nested test depth must be positive.");
  const lineage: ReturnType<typeof makeGraph>[] = [];
  for (let level = 1; level <= depth; level++) {
    const base = makeGraph();
    const parent = lineage[level - 2];
    const taskId = `task-depth-${level}`;
    const revisionId = `revision-depth-${level}`;
    const stepId = `step-depth-${level}`;
    const parentAttemptId = parent === undefined ? undefined : `lineage-attempt-${level - 1}`;
    const task: Task = {
      ...base.task,
      id: taskId,
      rootTaskId: parent?.task.rootTaskId ?? taskId,
      ...(parent === undefined ? {} : { parentTaskId: parent.task.id, parentAttemptId }),
      source: parent === undefined ? "cli" : "delegation",
      creationKey: `create-depth-${level}`,
      activePlanRevisionId: revisionId,
      createdBy: parent === undefined
        ? base.task.createdBy
        : { kind: "agent", sessionId: "creator-alpha", taskId: parent.task.id, attemptId: parentAttemptId }
    };
    const revision: TaskPlanRevision = {
      ...base.revision,
      id: revisionId,
      taskId,
      createdBy: task.createdBy
    };
    const step: TaskStep = {
      ...base.steps[0]!,
      id: stepId,
      taskId,
      planRevisionId: revisionId
    };
    lineage.push({ task, revision, steps: [step] });
  }
  return lineage;
}

function taskStoreWithLineage(
  base: SQLiteTaskStore,
  lineage: readonly ReturnType<typeof makeGraph>[]
): TaskStore {
  const tasks = new Map(lineage.map((graph) => [graph.task.id, graph.task]));
  const steps = new Map(lineage.map((graph) => [graph.steps[0]!.id, graph.steps[0]!]));
  const attempts = new Map(lineage.slice(0, -1).map((graph, index) => {
    const value = {
      ...attempt(graph),
      id: `lineage-attempt-${index + 1}`,
      dispatchKey: `lineage-dispatch-${index + 1}`,
      lease: undefined
    } satisfies TaskAttempt;
    return [value.id, value] as const;
  }));
  return new Proxy(base, {
    get(target, property) {
      if (property === "getTask") {
        return (id: string) => tasks.get(id) ?? target.getTask(id);
      }
      if (property === "getStep") {
        return (id: string) => steps.get(id) ?? target.getStep(id);
      }
      if (property === "getAttempt") {
        return (id: string) => attempts.get(id) ?? target.getAttempt(id);
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    }
  }) as TaskStore;
}

function makeDependencyGraph(): ReturnType<typeof makeGraph> {
  const graph = makeGraph();
  const authorityPolicy = {
    ...graph.task.authorityPolicy,
    allowedToolsets: [...graph.task.authorityPolicy.allowedToolsets, "core"],
    allowedTools: ["task.result.read"]
  } satisfies TaskAuthorityPolicy;
  const dependency: TaskStep = {
    ...graph.steps[0]!,
    id: "step-dependency",
    key: "dependency",
    title: "Produce dependency result",
    position: 0,
    authorityPolicy
  };
  const synthesis: TaskStep = {
    ...graph.steps[0]!,
    id: "step-synthesis",
    key: "synthesis",
    title: "Synthesize dependency result",
    objective: "Read the dependency and return the complete synthesis.",
    position: 1,
    dependsOn: [dependency.id],
    authorityPolicy
  };
  return {
    task: { ...graph.task, authorityPolicy },
    revision: graph.revision,
    steps: [dependency, synthesis]
  };
}

function acquireHostLease(store: SQLiteTaskStore, task: Task, ownerId: string): void {
  store.acquireTaskHostLease({
    taskId: task.id,
    workspaceIdentityHash: task.workspace.identityHash,
    ownerId,
    kind: "background",
    acquiredAt: NOW,
    expiresAt: "2030-01-01T00:01:00.000Z"
  });
}

function attempt(graph: ReturnType<typeof makeGraph>, step: TaskStep = graph.steps[0]!) {
  return {
    id: "attempt-alpha",
    profileId: "alpha",
    taskId: graph.task.id,
    planRevisionId: graph.revision.id,
    stepId: step.id,
    attemptNumber: 1,
    status: "running" as const,
    dispatchKey: "dispatch-alpha",
    lease: {
      attemptId: "attempt-alpha",
      profileId: "alpha",
      taskId: graph.task.id,
      ownerId: "scheduler-alpha",
      fencingToken: 1,
      acquiredAt: NOW,
      heartbeatAt: NOW,
      expiresAt: "2030-01-01T00:01:00.000Z"
    },
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
  },
  access: { tools: string[]; toolsets: ToolsetName[] } = {
    tools: ["file.read"],
    toolsets: ["files"]
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
      effectiveAllowedToolsets: access.toolsets,
      effectiveAllowedTools: access.tools,
      strippedTools: [],
      blockedTools: [],
      rejectedRequestedTools: [],
      rejectedRequestedToolsets: []
    },
    handle,
    cleanup
  };
}

function successfulEvidenceExecution(
  name: string,
  riskClass: ToolRiskClass,
  toolsets: ToolsetName[],
  input: Record<string, unknown>,
  content: string,
  metadata?: Record<string, unknown>
): Awaited<ReturnType<ChildAgentLoopRuntime["handle"]>>["toolExecutions"][number] {
  return {
    tool: tool(name, riskClass, toolsets),
    input,
    decision: "allow",
    riskClass,
    result: {
      ok: true,
      content,
      ...(metadata === undefined ? {} : { metadata })
    }
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
          state: "dispatched",
          dispatchedAt: NOW,
          ok: false,
          content: "",
          usage: { inputTokens: 500, outputTokens: 100, reasoningTokens: 25, totalTokens: 600 }
        },
        {
          provider: "openai",
          model: "child-model",
          state: "dispatched",
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
