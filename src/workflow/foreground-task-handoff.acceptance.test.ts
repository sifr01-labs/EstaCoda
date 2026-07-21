import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DELEGATION_CONFIG } from "../config/delegation-defaults.js";
import type { TaskWorkspaceBinding } from "../contracts/task.js";
import type { ToolDefinition } from "../contracts/tool.js";
import { DurableDelegationService } from "../delegation/durable-delegation-service.js";
import { GatewayApprovalQueue } from "../gateway/approval-queue.js";
import { WorkspaceApprovalController } from "../security/workspace-approval-controller.js";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import type { AgentStepExecutor } from "./agent-step-executor.js";
import { FakeTaskStepExecutor } from "./fake-task-step-executor.js";
import { ForegroundTaskHost } from "./foreground-task-host.js";
import { SQLiteTaskStore } from "./sqlite-task-store.js";
import { SupervisorTaskBackgroundHost } from "./supervisor-task-background-host.js";
import { TaskApprovalService } from "./task-approval-service.js";
import { TaskOperatorService } from "./task-operator-service.js";
import { TaskResultService } from "./task-result-service.js";

const WORKSPACE_A = { canonicalPath: "/workspace/a", identityHash: "workspace-a" } as const;
const WORKSPACE_B = { canonicalPath: "/workspace/b", identityHash: "workspace-b" } as const;
const START = Date.parse("2030-01-01T00:00:00.000Z");

describe("interactive foreground execution and gateway handoff acceptance", () => {
  let root: string;
  let sessionDb: SQLiteSessionDB;
  let store: SQLiteTaskStore;
  let resultService: TaskResultService;
  let nowMs: number;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "estacoda-foreground-acceptance-"));
    nowMs = START;
    sessionDb = new SQLiteSessionDB({ path: join(root, "sessions.sqlite"), now });
    await sessionDb.createSession({ id: "interactive-a", profileId: "alpha" });
    await sessionDb.createSession({ id: "interactive-b", profileId: "alpha" });
    store = new SQLiteTaskStore({ db: sessionDb.db, profileId: "alpha" });
    resultService = new TaskResultService({
      store,
      profileId: "alpha",
      contentRoot: join(root, "results"),
      sessionDb,
      now
    });
  });

  afterEach(() => {
    sessionDb.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("starts three workers without a gateway, returns after dispatch, survives session switching, and synthesizes once", async () => {
    const releases = new Map<string, () => void>();
    let primaryTaskId: string | undefined;
    const foregroundExecutor = new FakeTaskStepExecutor(({ task, step }) => {
      if (task.id === primaryTaskId && step.key.startsWith("delegated-")) {
        return new Promise((resolve) => {
          releases.set(step.key, () => resolve({
            outcome: "succeeded",
            results: [{ kind: "text", content: `${step.key} result` }]
          }));
        });
      }
      return {
        outcome: "succeeded",
        results: [{ kind: "text", content: `${task.creatorSessionId}:${step.key}` }]
      };
    });
    const foreground = foregroundHost(foregroundExecutor, "foreground-interactive");
    await foreground.start();
    let activeSessionId = "interactive-a";
    const delegation = delegationService({
      workspace: WORKSPACE_A,
      creatorSessionId: () => activeSessionId,
      onTaskCreated: async (taskId) => {
        primaryTaskId ??= taskId;
        await foreground.startTask(taskId);
      },
      backgroundContinuation: "unavailable"
    });

    const creation = delegation.createAndActivate({
      toolCallId: "turn-a-delegate",
      trustedWorkspace: true,
      tasks: [
        { task: "Research the first source." },
        { task: "Research the second source." },
        { task: "Research the third source." }
      ],
      synthesis: { objective: "Synthesize all three durable worker results." }
    });
    const handle = await creation;

    expect(handle).toMatchObject({
      taskId: primaryTaskId,
      status: "running",
      executionPreference: "auto",
      execution: "foreground",
      workerStepIds: expect.arrayContaining([expect.any(String), expect.any(String), expect.any(String)]),
      synthesisStepId: expect.any(String)
    });
    expect(handle.workerStepIds).toHaveLength(3);
    expect(releases.size).toBe(3);
    expect(store.listAttempts(handle.taskId)).toHaveLength(3);
    expect(store.listResults(handle.taskId)).toHaveLength(0);

    const backgroundRuntimeFactory = vi.fn();
    const competingBackground = backgroundHost(backgroundRuntimeFactory, "background-competing");
    await expect(competingBackground.runOnce()).resolves.toMatchObject({ scheduler: { dispatched: 0 } });
    expect(backgroundRuntimeFactory).not.toHaveBeenCalled();

    activeSessionId = "interactive-b";
    const switched = await delegation.createAndActivate({
      toolCallId: "turn-b-delegate",
      trustedWorkspace: true,
      tasks: [{ task: "Continue in the newly selected conversation session." }]
    });
    await vi.waitFor(() => expect(store.getTask(switched.taskId)?.status).toBe("completed"));
    expect(store.listSessionLinks(switched.taskId)).toEqual([
      expect.objectContaining({ sessionId: "interactive-b", relationship: "creator" })
    ]);

    for (const release of releases.values()) release();
    await vi.waitFor(() => expect(store.getTask(handle.taskId)?.status).toBe("completed"));
    expect(foregroundExecutor.executions.filter(({ task }) => task.id === handle.taskId).map(({ step }) => step.key))
      .toEqual(["delegated-1", "delegated-2", "delegated-3", "synthesis"]);
    expect(store.listResults(handle.taskId)).toHaveLength(4);
    expect(store.listAttempts(handle.taskId)).toHaveLength(4);

    await competingBackground.dispose();
    await foreground.shutdown();
  });

  it("waits truthfully with no gateway, then recovers safe work across workspaces without repeating unsafe work", async () => {
    let releaseSafe: (() => void) | undefined;
    const safeForegroundExecutor = new FakeTaskStepExecutor(() => new Promise((resolve) => {
      releaseSafe = () => resolve({ outcome: "succeeded", results: [{ kind: "text", content: "stale safe result" }] });
    }));
    const safeForeground = foregroundHost(safeForegroundExecutor, "foreground-safe", {
      handoffSettleGraceMs: 0,
      handoffAbortGraceMs: 0
    });
    const safeDelegation = delegationService({
      workspace: WORKSPACE_A,
      creatorSessionId: () => "interactive-a",
      onTaskCreated: (taskId) => safeForeground.startTask(taskId).then(() => undefined),
      backgroundContinuation: "unavailable"
    });
    const safe = await safeDelegation.createAndActivate({
      toolCallId: "safe-handoff",
      trustedWorkspace: true,
      tasks: [{ task: "Read durable state safely." }]
    });
    const safeAttemptId = store.listAttempts(safe.taskId)[0]!.id;
    await safeForeground.shutdown();

    const waiting = new TaskOperatorService({
      store,
      now,
      backgroundContinuation: () => "unavailable"
    }).status(safe.taskId, "interactive-a");
    expect(waiting).toMatchObject({
      status: "waiting_for_host",
      execution: "waiting",
      foregroundOwnerActive: false,
      backgroundContinuation: "unavailable",
      executionWaitingReason: "Foreground execution ended; waiting for a background Task host."
    });

    let releaseUnsafe: (() => void) | undefined;
    const unsafeForegroundExecutor = new FakeTaskStepExecutor(() => new Promise((resolve) => {
      releaseUnsafe = () => resolve({ outcome: "succeeded", results: [{ kind: "text", content: "uncertain result" }] });
    }));
    const unsafeForeground = foregroundHost(unsafeForegroundExecutor, "foreground-unsafe", {
      handoffSettleGraceMs: 0,
      handoffAbortGraceMs: 0
    });
    const unsafe = new TaskOperatorService({ store, now }).begin({
      objective: "Perform work whose side effects cannot be proven safe to repeat.",
      workspace: WORKSPACE_A,
      creatorSessionId: "interactive-a"
    });
    await unsafeForeground.startTask(unsafe.taskId);
    await unsafeForeground.shutdown();
    expect(store.getTask(unsafe.taskId)).toMatchObject({
      status: "waiting_for_input",
      waitReason: { kind: "operator" }
    });
    expect(store.listAttempts(unsafe.taskId)[0]).toMatchObject({
      status: "interrupted",
      failure: { class: "host-handoff-uncertain", uncertainSideEffects: true }
    });

    const backgroundOnly = delegationService({
      workspace: WORKSPACE_B,
      creatorSessionId: () => "interactive-b",
      backgroundContinuation: "available"
    }).create({
      toolCallId: "workspace-b-background",
      trustedWorkspace: true,
      executionPreference: "background",
      tasks: [{ task: "Execute directly in the workspace B gateway runtime." }]
    });
    expect(backgroundOnly).toMatchObject({ executionPreference: "background", execution: "waiting" });

    const executions: Array<{ taskId: string; workspace: string; fencingToken: number | undefined }> = [];
    const createExecutorRuntime = vi.fn(async (workspace: TaskWorkspaceBinding) => {
      const executor = new FakeTaskStepExecutor(({ task, attempt }) => {
        executions.push({
          taskId: task.id,
          workspace: workspace.identityHash,
          fencingToken: attempt.lease?.fencingToken
        });
        return { outcome: "succeeded", results: [{ kind: "text", content: `resumed:${workspace.identityHash}` }] };
      });
      return { taskAgentExecutor: asAgentExecutor(executor), dispose: async () => undefined };
    });
    const background = backgroundHost(createExecutorRuntime, "background-recovery");
    await expect(background.runOnce()).resolves.toMatchObject({ scheduler: { dispatched: 2, completed: 2 } });

    expect(store.getTask(safe.taskId)?.status).toBe("completed");
    expect(store.getTask(backgroundOnly.taskId)?.status).toBe("completed");
    expect(store.getTask(unsafe.taskId)?.status).toBe("waiting_for_input");
    expect(executions).toEqual(expect.arrayContaining([
      { taskId: safe.taskId, workspace: "workspace-a", fencingToken: 2 },
      { taskId: backgroundOnly.taskId, workspace: "workspace-b", fencingToken: 1 }
    ]));
    expect(executions.some(({ taskId }) => taskId === unsafe.taskId)).toBe(false);
    expect(createExecutorRuntime.mock.calls.map(([workspace]) => workspace.identityHash).sort())
      .toEqual(["workspace-a", "workspace-b"]);

    releaseSafe!();
    releaseUnsafe!();
    await vi.waitFor(() => expect(store.listResults(safe.taskId)).toHaveLength(1));
    expect(store.listResults(unsafe.taskId)).toHaveLength(0);
    await background.dispose();
  });

  it("recovers a safe Attempt after a foreground crash and fences its late result", async () => {
    let releaseCrashed: (() => void) | undefined;
    const crashedExecutor = new FakeTaskStepExecutor(() => new Promise((resolve) => {
      releaseCrashed = () => resolve({ outcome: "succeeded", results: [{ kind: "text", content: "late crashed result" }] });
    }));
    const crashedForeground = foregroundHost(crashedExecutor, "foreground-crashed", {
      leaseMs: 60_000,
      heartbeatIntervalMs: 30_000
    });
    const delegated = delegationService({
      workspace: WORKSPACE_A,
      creatorSessionId: () => "interactive-a",
      onTaskCreated: (taskId) => crashedForeground.startTask(taskId).then(() => undefined),
      backgroundContinuation: "available"
    });
    const task = await delegated.createAndActivate({
      toolCallId: "crash-recovery",
      trustedWorkspace: true,
      tasks: [{ task: "Read state safely before the foreground process crashes." }]
    });
    const crashedAttempt = store.listAttempts(task.taskId)[0]!;
    expect(crashedAttempt.status).toBe("running");

    nowMs += 120_000;
    const recoveredExecutor = new FakeTaskStepExecutor(() => ({
      outcome: "succeeded",
      results: [{ kind: "text", content: "gateway recovery result" }]
    }));
    const background = backgroundHost(async () => ({
      taskAgentExecutor: asAgentExecutor(recoveredExecutor),
      dispose: async () => undefined
    }), "background-after-crash", {
      leaseMs: 60_000,
      heartbeatIntervalMs: 30_000
    });

    await expect(background.runOnce()).resolves.toMatchObject({ scheduler: { dispatched: 1, completed: 1 } });
    expect(recoveredExecutor.executions).toHaveLength(1);
    expect(recoveredExecutor.executions[0]?.attempt.id).not.toBe(crashedAttempt.id);
    expect(recoveredExecutor.executions[0]?.attempt.attemptNumber).toBe(2);
    expect(store.getAttempt(crashedAttempt.id)).toMatchObject({
      status: "expired",
      failure: { class: "lease-expired" }
    });
    expect(store.getTask(task.taskId)?.status).toBe("completed");

    releaseCrashed!();
    await vi.waitFor(() => expect(store.listResults(task.taskId)).toHaveLength(1));
    const acceptedResult = store.listResults(task.taskId)[0]!;
    await expect(resultService.readPage({
      taskId: task.taskId,
      resultId: acceptedResult.id,
      sessionId: "interactive-a"
    })).resolves.toMatchObject({ content: "gateway recovery result" });

    await background.dispose();
    await crashedForeground.shutdown();
  });

  it("authorizes foreground approvals to the active session and preserves unresolved approval for gateway continuation", async () => {
    const queue = new GatewayApprovalQueue({
      db: sessionDb.db,
      controller: new WorkspaceApprovalController(),
      now
    });
    const approvalService = new TaskApprovalService({ store, queue, now });
    const executions = new Map<string, number>();
    const foregroundExecutor = new FakeTaskStepExecutor(({ task }) => {
      const count = (executions.get(task.id) ?? 0) + 1;
      executions.set(task.id, count);
      return count === 1
        ? {
            outcome: "waiting_for_approval",
            approval: {
              toolName: "file.write",
              riskClass: "workspace-write",
              targetFingerprint: `sha256:${"a".repeat(64)}`,
              targetPreview: `write ${task.id}`
            }
          }
        : { outcome: "succeeded", results: [{ kind: "text", content: `approved:${task.id}` }] };
    });
    const foreground = new ForegroundTaskHost({
      store,
      resultService,
      executor: foregroundExecutor,
      approvalService,
      ownerId: "foreground-approvals",
      workspaceIdentityHash: WORKSPACE_A.identityHash,
      leaseMs: 600_000,
      heartbeatIntervalMs: 300_000,
      now
    });
    const operator = new TaskOperatorService({ store, now });
    const interactive = operator.begin({
      objective: "Write an artifact after interactive review.",
      workspace: WORKSPACE_A,
      creatorSessionId: "interactive-a"
    });
    await foreground.startTask(interactive.taskId);
    await vi.waitFor(() => expect(store.getTask(interactive.taskId)?.status).toBe("waiting_for_approval"));
    await foreground.runOnce();

    expect(foreground.listPendingApprovals("interactive-b")).toEqual([]);
    const interactiveApproval = foreground.listPendingApprovals("interactive-a")[0]!;
    expect(interactiveApproval).toMatchObject({ taskId: interactive.taskId, authorizedSessionId: "interactive-a" });
    await foreground.resolvePendingApproval({
      approvalId: interactiveApproval.approvalId,
      authorizedSessionId: "interactive-a",
      decision: "approved"
    });
    await vi.waitFor(() => expect(store.getTask(interactive.taskId)?.status).toBe("completed"));
    expect(executions.get(interactive.taskId)).toBe(2);

    const continued = operator.begin({
      objective: "Keep this approval durable when the interactive process exits.",
      workspace: WORKSPACE_A,
      creatorSessionId: "interactive-a"
    });
    await foreground.startTask(continued.taskId);
    await vi.waitFor(() => expect(store.getTask(continued.taskId)?.status).toBe("waiting_for_approval"));
    await foreground.runOnce();
    const continuedApproval = foreground.listPendingApprovals("interactive-a")
      .find(({ taskId }) => taskId === continued.taskId)!;
    const continuedAttemptId = store.listAttempts(continued.taskId)[0]!.id;
    await foreground.shutdown();

    const backgroundExecutor = new FakeTaskStepExecutor(() => ({
      outcome: "succeeded",
      results: [{ kind: "text", content: "approved by gateway" }]
    }));
    const background = new SupervisorTaskBackgroundHost({
      store,
      resultService,
      router: { deliverText: async () => new Map() },
      ownerId: "background-approvals",
      resolveWorkspace: async () => WORKSPACE_A,
      isWorkspaceTrusted: () => true,
      createExecutorRuntime: async () => ({
        taskAgentExecutor: asAgentExecutor(backgroundExecutor),
        dispose: async () => undefined
      }),
      approvalService: new TaskApprovalService({ store, queue, now }),
      leaseMs: 600_000,
      heartbeatIntervalMs: 300_000,
      now
    });
    expect((await background.runOnce()).scheduler?.dispatched).toBe(0);
    await queue.resolveApproval(continuedApproval.approvalId, "approved", "gateway-operator", {
      profileId: "alpha",
      sessionId: "interactive-a"
    });
    await expect(background.runOnce()).resolves.toMatchObject({ scheduler: { dispatched: 1, completed: 1 } });
    expect(backgroundExecutor.executions[0]?.attempt.id).toBe(continuedAttemptId);
    expect(store.getTask(continued.taskId)?.status).toBe("completed");
    expect(store.listApprovalLinks({ taskId: continued.taskId })[0]?.status).toBe("approved");
    await background.dispose();
  });

  function now(): Date {
    return new Date(nowMs);
  }

  function foregroundHost(
    executor: FakeTaskStepExecutor,
    ownerId: string,
    overrides: Partial<{
      leaseMs: number;
      heartbeatIntervalMs: number;
      handoffSettleGraceMs: number;
      handoffAbortGraceMs: number;
    }> = {}
  ): ForegroundTaskHost {
    return new ForegroundTaskHost({
      store,
      resultService,
      executor,
      ownerId,
      workspaceIdentityHash: WORKSPACE_A.identityHash,
      leaseMs: overrides.leaseMs ?? 600_000,
      heartbeatIntervalMs: overrides.heartbeatIntervalMs ?? 300_000,
      handoffSettleGraceMs: overrides.handoffSettleGraceMs,
      handoffAbortGraceMs: overrides.handoffAbortGraceMs,
      now
    });
  }

  function backgroundHost(
    createExecutorRuntime: ConstructorParameters<typeof SupervisorTaskBackgroundHost>[0]["createExecutorRuntime"],
    ownerId: string,
    overrides: Partial<{ leaseMs: number; heartbeatIntervalMs: number }> = {}
  ): SupervisorTaskBackgroundHost {
    return new SupervisorTaskBackgroundHost({
      store,
      resultService,
      router: { deliverText: async () => new Map() },
      ownerId,
      resolveWorkspace: async (canonicalPath) => canonicalPath === WORKSPACE_A.canonicalPath ? WORKSPACE_A : WORKSPACE_B,
      isWorkspaceTrusted: () => true,
      createExecutorRuntime,
      leaseMs: overrides.leaseMs ?? 600_000,
      heartbeatIntervalMs: overrides.heartbeatIntervalMs ?? 300_000,
      now
    });
  }

  function delegationService(input: {
    workspace: typeof WORKSPACE_A | typeof WORKSPACE_B;
    creatorSessionId: () => string;
    onTaskCreated?: (taskId: string) => Promise<void>;
    backgroundContinuation: "available" | "unavailable";
  }): DurableDelegationService {
    return new DurableDelegationService({
      store,
      creatorSessionId: input.creatorSessionId,
      workspace: input.workspace,
      config: DEFAULT_DELEGATION_CONFIG,
      visibleTools: () => [RESULT_READER],
      backgroundContinuation: () => input.backgroundContinuation,
      onTaskCreated: input.onTaskCreated
    });
  }
});

const RESULT_READER: ToolDefinition = {
  name: "task.result.read",
  description: "Read a bounded durable Task result.",
  inputSchema: {},
  riskClass: "read-only-local",
  toolsets: ["core"],
  progressLabel: "reading task result",
  maxResultSizeChars: 1_000
};

function asAgentExecutor(executor: FakeTaskStepExecutor): AgentStepExecutor {
  return {
    kind: "agent" as const,
    canExecute: () => true,
    execute: executor.execute.bind(executor)
  } as unknown as AgentStepExecutor;
}
