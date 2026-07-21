import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentLoopResponse } from "../runtime/agent-loop.js";
import type { ChildAgentLoopFactory, ChildAgentLoopRuntime } from "../runtime/agent-loop-factory.js";
import type { AgentLoopRouteInput } from "../runtime/agent-loop-builder.js";
import type { SessionRecord } from "../contracts/session.js";
import { capabilityFirstDefaults } from "../contracts/security.js";
import { readActiveProfile, resolveGlobalStateHome, writeActiveProfile } from "../config/profile-home.js";
import { WorkspaceTrustStore } from "../security/workspace-trust-store.js";
import { createSQLiteSessionDB } from "../session/session-setup.js";
import { AgentStepExecutor } from "../workflow/agent-step-executor.js";
import { SQLiteTaskStore } from "../workflow/sqlite-task-store.js";
import { TaskApprovalService } from "../workflow/task-approval-service.js";
import { TaskOperatorService } from "../workflow/task-operator-service.js";
import { TaskResultService } from "../workflow/task-result-service.js";
import { TaskScheduler } from "../workflow/task-scheduler.js";
import { executeTaskCommand, taskCommand } from "./task-commands.js";

describe("Task commands", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "estacoda-task-command-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("renders deterministic non-interactive list and show output", async () => {
    const db = await createSQLiteSessionDB({ path: join(root, "sessions.sqlite") });
    await db.createSession({ id: "owner", profileId: "alpha" });
    const service = new TaskOperatorService({
      store: new SQLiteTaskStore({ db: db.db, profileId: "alpha" }),
      now: () => new Date("2026-01-01T00:00:00.000Z")
    });
    const created = service.begin({
      objective: "Inspect deterministic output",
      workspace: { canonicalPath: root, identityHash: "workspace-hash" },
      creatorSessionId: "owner"
    });

    await expect(executeTaskCommand({ args: ["list"], service, authorizedSessionId: "owner" })).resolves.toEqual({
      ok: true,
      output: `${created.taskId}\tqueued\twaiting\t0/1\tInspect deterministic output`
    });
    const shown = await executeTaskCommand({
      args: ["show", created.taskId],
      service,
      authorizedSessionId: "owner",
      workspaceTrusted: async () => true,
      backgroundHost: async () => "inactive"
    });
    expect(shown.ok).toBe(true);
    expect(shown.output).toContain(`Task ${created.taskId} · Inspect deterministic output`);
    expect(shown.output).toContain("Estimated cost: unavailable");
    expect(shown.output).toContain("Workspace: trusted");
    expect(shown.output).toContain("Background host: inactive");
    expect(shown.output).toContain("Execution: waiting");
    expect(shown.output).toContain("Background continuation: unavailable");
    expect(shown.output).not.toContain(root);
    db.close();
  });

  it("keeps --profile command-local while creating an explicit Task creator session", async () => {
    writeActiveProfile("alpha", { homeDir: root });
    await new WorkspaceTrustStore({ homeDir: root }).grant(root);
    const result = await taskCommand({
      argv: [],
      workspaceRoot: root,
      homeDir: root,
      profileId: "beta"
    }, ["begin", "Inspect", "the", "selected", "profile"]);

    expect(result).toMatchObject({ handled: true, exitCode: 0 });
    expect(result.output).toContain("Created Task:");
    expect(result.output).toContain("Creator session:");
    expect(readActiveProfile({ homeDir: root }).profileId).toBe("alpha");
    const db = await createSQLiteSessionDB({ path: resolveGlobalStateHome({ homeDir: root }).sessionsSqlitePath });
    const task = new SQLiteTaskStore({ db: db.db, profileId: "beta" }).listTasks()[0]!;
    expect(task.creatorSessionId).toBeDefined();
    await expect(db.getSession(task.creatorSessionId!)).resolves.toMatchObject({
      id: task.creatorSessionId,
      profileId: "beta",
      title: "Task: Inspect the selected profile",
      metadata: { kind: "task-operator-origin", source: "cli" }
    });
    expect(new SQLiteTaskStore({ db: db.db, profileId: "alpha" }).listTasks()).toHaveLength(0);
    db.close();
  });

  it("uses an explicitly selected profile session without creating another one", async () => {
    await new WorkspaceTrustStore({ homeDir: root }).grant(root);
    const paths = resolveGlobalStateHome({ homeDir: root });
    const setupDb = await createSQLiteSessionDB({ path: paths.sessionsSqlitePath });
    await setupDb.createSession({ id: "selected-owner", profileId: "default", title: "Existing owner" });
    setupDb.close();

    const result = await taskCommand({ argv: [], workspaceRoot: root, homeDir: root }, [
      "begin",
      "--session",
      "selected-owner",
      "Inspect",
      "with",
      "the",
      "existing",
      "session"
    ]);

    expect(result).toMatchObject({ handled: true, exitCode: 0 });
    expect(result.output).toContain("Creator session: selected-owner");
    const db = await createSQLiteSessionDB({ path: paths.sessionsSqlitePath });
    expect(await db.listSessions("default")).toEqual([
      expect.objectContaining({ id: "selected-owner", title: "Existing owner" })
    ]);
    expect(new SQLiteTaskStore({ db: db.db, profileId: "default" }).listTasks()[0])
      .toMatchObject({ creatorSessionId: "selected-owner" });
    db.close();
  });

  it("persists --background and reports that no foreground owner is active", async () => {
    await new WorkspaceTrustStore({ homeDir: root }).grant(root);
    const result = await taskCommand({ argv: [], workspaceRoot: root, homeDir: root }, [
      "begin",
      "--background",
      "Run",
      "through",
      "the",
      "gateway"
    ]);

    expect(result).toMatchObject({ handled: true, exitCode: 0 });
    expect(result.output).toContain("Execution: waiting");
    expect(result.output).toContain("Execution preference: background");
    expect(result.output).toContain("Foreground owner: inactive");
    expect(result.output).toContain("Background continuation: unavailable");
    const db = await createSQLiteSessionDB({ path: resolveGlobalStateHome({ homeDir: root }).sessionsSqlitePath });
    expect(new SQLiteTaskStore({ db: db.db, profileId: "default" }).listTasks()[0])
      .toMatchObject({ executionPreference: "background" });
    db.close();
  });

  it("runs a standalone CLI Task through the production Agent Step executor", async () => {
    await new WorkspaceTrustStore({ homeDir: root }).grant(root);
    const created = await taskCommand({ argv: [], workspaceRoot: root, homeDir: root }, [
      "begin",
      "Execute",
      "the",
      "durable",
      "Task"
    ]);
    expect(created).toMatchObject({ handled: true, exitCode: 0 });

    const db = await createSQLiteSessionDB({ path: resolveGlobalStateHome({ homeDir: root }).sessionsSqlitePath });
    const store = new SQLiteTaskStore({ db: db.db, profileId: "default" });
    const task = store.listTasks()[0]!;
    const creatorSession = await db.getSession(task.creatorSessionId!);
    expect(creatorSession).toMatchObject({ profileId: "default", metadata: { kind: "task-operator-origin" } });

    const childFactory: ChildAgentLoopFactory = {
      createChild: vi.fn(async (input) => {
        expect(input.parentSessionId).toBe(creatorSession!.id);
        const childSession = await db.createSession({
          id: "standalone-task-worker",
          profileId: input.profileId,
          parentSessionId: input.parentSessionId,
          metadata: { kind: "task-step-worker", ...(input.taskExecution ?? {}) }
        });
        return testChildRuntime(childSession, "Standalone Task completed.");
      })
    };
    const resultService = new TaskResultService({
      store,
      profileId: "default",
      contentRoot: join(root, "profiles", "default", "tasks", "results"),
      sessionDb: db
    });
    const executor = new AgentStepExecutor({
      childFactory,
      sessionDb: db,
      taskStore: store,
      hostWorkspace: task.workspace,
      isWorkspaceTrusted: () => true,
      parentVisibleTools: () => [],
      approvalService: new TaskApprovalService({ store }),
      securityPolicy: capabilityFirstDefaults
    });
    const scheduler = new TaskScheduler({
      store,
      resultService,
      ownerId: "standalone-task-scheduler",
      resolveExecutor: (candidate, step) => executor.canExecute(candidate, step) ? executor : undefined
    });
    store.acquireTaskHostLease({
      taskId: task.id,
      workspaceIdentityHash: task.workspace.identityHash,
      ownerId: "standalone-task-scheduler",
      kind: "foreground",
      acquiredAt: task.createdAt,
      expiresAt: new Date(Date.parse(task.createdAt) + 60_000).toISOString()
    });

    await expect(scheduler.runOnce()).resolves.toMatchObject({ dispatched: 1, completed: 1, failed: 0 });
    expect(store.getTask(task.id)?.status).toBe("completed");
    const results = store.listResults(task.id);
    expect(results).toEqual([expect.objectContaining({ kind: "text", status: "available" })]);
    await expect(resultService.readPage({
      taskId: task.id,
      resultId: results[0]!.id,
      sessionId: creatorSession!.id
    })).resolves.toMatchObject({ content: "Standalone Task completed.", hasMore: false });
    expect(childFactory.createChild).toHaveBeenCalledOnce();
    db.close();
  });

  it("fails closed when Task creation workspace trust is absent", async () => {
    const result = await taskCommand({ argv: [], workspaceRoot: root, homeDir: root }, ["begin", "Inspect"]);
    expect(result).toMatchObject({ handled: true, exitCode: 1 });
    expect(result.output).toContain("Task creation requires a trusted workspace");
  });

  it("does not create an origin session when the Task objective is invalid", async () => {
    await new WorkspaceTrustStore({ homeDir: root }).grant(root);
    const result = await taskCommand({ argv: [], workspaceRoot: root, homeDir: root }, [
      "begin",
      "x".repeat(4_001)
    ]);

    expect(result).toMatchObject({ handled: true, exitCode: 1 });
    expect(result.output).toContain("Task objective must be 1-4000 characters");
    const db = await createSQLiteSessionDB({ path: resolveGlobalStateHome({ homeDir: root }).sessionsSqlitePath });
    expect(await db.listSessions("default")).toEqual([]);
    expect(new SQLiteTaskStore({ db: db.db, profileId: "default" }).listTasks()).toEqual([]);
    db.close();
  });

  it("renders Arabic Task command copy without translating technical identifiers", async () => {
    const db = await createSQLiteSessionDB({ path: join(root, "sessions.sqlite") });
    const service = new TaskOperatorService({
      store: new SQLiteTaskStore({ db: db.db, profileId: "alpha" })
    });

    const help = await executeTaskCommand({ args: ["help"], service, locale: "ar" });
    expect(help.output).toContain("أوامر المهام الدائمة");
    expect(help.output).toContain("task show <task-id>");

    const empty = await executeTaskCommand({ args: ["list"], service, locale: "ar" });
    expect(empty.output).toBe("لم يتم العثور على مهام.");
    db.close();
  });

  it("does not let an in-session command select a different creator session", async () => {
    const db = await createSQLiteSessionDB({ path: join(root, "sessions.sqlite") });
    const service = new TaskOperatorService({
      store: new SQLiteTaskStore({ db: db.db, profileId: "alpha" })
    });
    const begin = vi.fn();

    const result = await executeTaskCommand({
      args: ["begin", "--session", "other", "Inspect"],
      service,
      authorizedSessionId: "owner",
      begin
    });

    expect(result).toEqual({
      ok: false,
      output: "--session is available only from the top-level task command."
    });
    expect(begin).not.toHaveBeenCalled();
    db.close();
  });
});

const TEST_ROUTES = (() => {
  const model = {
    id: "test-model",
    provider: "local",
    contextWindowTokens: 16_000,
    supportsTools: true,
    supportsVision: false,
    supportsStructuredOutput: true,
    cost: { inputPerMillionTokens: 1, outputPerMillionTokens: 2 }
  } as const;
  const route = { provider: "local", id: model.id, profile: model } as const;
  return {
    model,
    mainRoute: route,
    primaryModelRoute: route,
    modelFallbackRoutes: [],
    providerPreferences: {}
  } satisfies AgentLoopRouteInput;
})();

function testChildRuntime(
  childSession: SessionRecord,
  text: string
): ChildAgentLoopRuntime {
  return {
    childSession,
    childSessionId: childSession.id,
    sessionRuntimeContext: { currentSessionId: () => childSession.id } as never,
    builtSession: { providerRoutes: TEST_ROUTES } as never,
    agentLoop: { trajectoryId: undefined } as never,
    suppressedRuntimeFeatures: [],
    enabledRuntimeFeatures: [],
    approvalMode: "non-interactive-fail-closed",
    toolAccess: {
      effectiveAllowedToolsets: [],
      effectiveAllowedTools: [],
      strippedTools: [],
      blockedTools: [],
      rejectedRequestedTools: [],
      rejectedRequestedToolsets: []
    },
    handle: async () => successfulResponse(text),
    cleanup: async () => undefined
  };
}

function successfulResponse(text: string): AgentLoopResponse {
  return {
    label: "EstaCoda",
    text,
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
      response: { ok: true, content: text, provider: "local", model: "test-model" },
      fallbackUsed: false,
      attempts: [{
        provider: "local",
        model: "test-model",
        state: "dispatched",
        dispatchedAt: "2030-01-01T00:00:00.000Z",
        ok: true,
        content: text,
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 }
      }],
      toolCalls: []
    }
  };
}
