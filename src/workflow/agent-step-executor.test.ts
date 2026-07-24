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
      modelOverride: { provider: "openai", model: "child-model" },
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
    const graph = makeDependencyGraph();
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
      position: 0
    };
    const failed: TaskStep = {
      ...base.steps[0]!,
      id: "step-failed",
      key: "failed",
      title: "Research unavailable source",
      position: 1
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
          });
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
    expect(context).toContain("Explicitly identify failed, cancelled, skipped, or missing coverage");
    expect(context).toContain(`\"stepId\":\"${successful.id}\",\"title\":\"${successful.title}\",\"status\":\"completed\",\"resultAvailable\":true`);
    expect(context).toContain(`\"stepId\":\"${failed.id}\",\"title\":\"${failed.title}\",\"status\":\"failed\",\"resultAvailable\":false`);
    expect(context).toContain("accepted-partial-result");
    expect(context).not.toContain("diagnostic-partial-result");
    expect(context).not.toContain("Untrusted incomplete output");
    expect(context.length).toBeLessThanOrEqual(16_000);
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
