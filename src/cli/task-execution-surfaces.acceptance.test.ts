import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_DELEGATION_CONFIG } from "../config/delegation-defaults.js";
import type { ToolDefinition } from "../contracts/tool.js";
import { DurableDelegationService } from "../delegation/durable-delegation-service.js";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import { createDelegationTools } from "../tools/delegation-tools.js";
import { createTaskTools } from "../tools/task-tools.js";
import {
  createInitialOperatorConsoleState,
  createOperatorConsoleLayout,
  renderOperatorConsoleTextLines,
  type TaskCardState
} from "../ui/papyrus/operator-console/index.js";
import { SQLiteTaskStore } from "../workflow/sqlite-task-store.js";
import { TaskOperatorService, type TaskStatusProjection } from "../workflow/task-operator-service.js";
import { executeTaskCommand } from "./task-commands.js";

const NOW = new Date("2030-01-01T00:00:00.000Z");
const WORKSPACE = { canonicalPath: "/workspace/project", identityHash: "workspace-hash" } as const;

describe("Task execution ownership surface acceptance", () => {
  let root: string;
  let sessionDb: SQLiteSessionDB;
  let store: SQLiteTaskStore;
  let operator: TaskOperatorService;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "estacoda-task-surfaces-"));
    sessionDb = new SQLiteSessionDB({ path: join(root, "sessions.sqlite"), now: () => NOW });
    await sessionDb.createSession({ id: "interactive", profileId: "alpha" });
    store = new SQLiteTaskStore({ db: sessionDb.db, profileId: "alpha" });
    operator = new TaskOperatorService({
      store,
      now: () => NOW,
      backgroundContinuation: () => "unavailable"
    });
  });

  afterEach(() => {
    sessionDb.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps CLI, tools, cards, plain output, RTL, and Arabic copy truthful for auto and background execution", async () => {
    const automatic = operator.begin({
      objective: "قارن المصادر ثم اكتب الملخص",
      workspace: WORKSPACE,
      creatorSessionId: "interactive",
      executionPreference: "auto"
    });
    store.acquireTaskHostLease({
      taskId: automatic.taskId,
      workspaceIdentityHash: WORKSPACE.identityHash,
      ownerId: "foreground-owner",
      kind: "foreground",
      acquiredAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 60_000).toISOString()
    });

    const english = await executeTaskCommand({
      args: ["show", automatic.taskId],
      service: operator,
      authorizedSessionId: "interactive",
      backgroundHost: async () => "inactive",
      locale: "en"
    });
    expect(english.output).toContain("Execution: foreground");
    expect(english.output).toContain("Execution preference: auto");
    expect(english.output).toContain("Foreground owner: active");
    expect(english.output).toContain("Background continuation: unavailable");

    const arabic = await executeTaskCommand({
      args: ["show", automatic.taskId],
      service: operator,
      authorizedSessionId: "interactive",
      backgroundHost: async () => "inactive",
      locale: "ar"
    });
    expect(arabic.output).toContain("التنفيذ");
    expect(arabic.output).toContain("\u2066foreground\u2069");
    expect(arabic.output).toContain("مالك التنفيذ الأمامي: نشط");
    expect(arabic.output).toContain("\u2066unavailable\u2069");

    const taskStatus = createTaskTools({ service: operator, currentSessionId: () => "interactive" })[0]!;
    const statusResult = await taskStatus.run({ task_id: automatic.taskId });
    expect(statusResult.content).toContain("Execution: foreground");
    expect(statusResult.content).toContain("Execution preference: auto");
    expect(statusResult.content).toContain("Foreground owner: active");

    const createdInBackground = await executeTaskCommand({
      args: ["begin", "--background", "Run after the gateway claims this Task"],
      service: operator,
      authorizedSessionId: "interactive",
      begin: async (objective, creatorSessionId, executionPreference) => ({
        task: operator.begin({
          objective,
          workspace: WORKSPACE,
          creatorSessionId: creatorSessionId!,
          executionPreference
        }),
        creatorSessionId: creatorSessionId!
      }),
      backgroundHost: async () => "inactive",
      locale: "en"
    });
    expect(createdInBackground.output).toContain("Execution: waiting");
    expect(createdInBackground.output).toContain("Execution preference: background");
    expect(createdInBackground.output).toContain("Foreground owner: inactive");

    const delegation = new DurableDelegationService({
      store,
      creatorSessionId: () => "interactive",
      workspace: WORKSPACE,
      config: DEFAULT_DELEGATION_CONFIG,
      visibleTools: () => [RESULT_READER],
      backgroundContinuation: () => "unavailable",
      onTaskCreated: async (taskId) => {
        store.acquireTaskHostLease({
          taskId,
          workspaceIdentityHash: WORKSPACE.identityHash,
          ownerId: "foreground-delegation",
          kind: "foreground",
          acquiredAt: NOW.toISOString(),
          expiresAt: new Date(NOW.getTime() + 60_000).toISOString()
        });
      }
    });
    const delegateTool = createDelegationTools({ service: delegation, trustedWorkspace: () => true })[0]!;
    const foregroundDelegation = await delegateTool.run({ task: "Research now", executionPreference: "auto" }, {
      toolCallId: "delegate-foreground"
    });
    expect(foregroundDelegation.content).toContain("Execution: foreground");
    expect(foregroundDelegation.content).toContain("Task is running in this session");
    const backgroundDelegation = await delegateTool.run({ task: "Research later", executionPreference: "background" }, {
      toolCallId: "delegate-background"
    });
    expect(backgroundDelegation.content).toContain("Execution: waiting");
    expect(backgroundDelegation.content).toContain("Execution preference: background");
    expect(backgroundDelegation.content).toContain("no active background continuation");

    const projection = operator.status(automatic.taskId, "interactive");
    const card = projectionToCard(projection);
    const state = createInitialOperatorConsoleState({
      locale: "ar",
      terminal: { width: 30, height: 12, isTty: false },
      tasks: { cards: [card], selectedTaskId: card.taskId, scrollOffset: 0 }
    });
    const lines = renderOperatorConsoleTextLines(state, createOperatorConsoleLayout(state));
    const plain = lines.join("\n");
    expect(plain).toContain("المهام");
    expect(plain).toContain(`\u2068${automatic.taskId.slice(0, 12)}`);
    expect(plain).toContain("\u2068foreground\u2069");
    expect(plain).not.toMatch(/\u001B\[/u);
    expect(lines.every((line) => visibleWidth(line) <= 30)).toBe(true);
  });
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

function projectionToCard(task: TaskStatusProjection): TaskCardState {
  return {
    taskId: task.taskId,
    objective: task.objective,
    status: task.status,
    executionPreference: task.executionPreference,
    execution: task.execution,
    foregroundOwnerActive: task.foregroundOwnerActive,
    backgroundContinuation: task.backgroundContinuation,
    ...(task.executionWaitingReason === undefined ? {} : { executionWaitingReason: task.executionWaitingReason }),
    progress: { completed: task.progress.completed, skipped: task.progress.skipped, total: task.progress.total },
    ...(task.planRevision === undefined ? {} : { planRevision: task.planRevision }),
    steps: task.steps.map((step) => ({
      stepId: step.stepId,
      title: step.title,
      status: step.status,
      dependsOn: step.dependsOn,
      childTaskPolicy: step.childTaskPolicy,
      ...(step.activeAttempt === undefined ? {} : { activeAttempt: step.activeAttempt })
    })),
    childTasks: task.childTasks,
    recentActivity: task.recentActivity,
    ...(task.currentToolCategory === undefined ? {} : { currentToolCategory: task.currentToolCategory }),
    elapsedMs: task.elapsedMs,
    usage: task.usage,
    results: task.results,
    ...(task.waitReason === undefined ? {} : { waitReason: task.waitReason }),
    ...(task.failure === undefined ? {} : { failure: task.failure }),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt
  };
}

function visibleWidth(value: string): number {
  return [...value.replace(/[\u2066-\u2069]/gu, "")].length;
}
