import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DelegationConfig } from "../../contracts/delegation.js";
import type { ToolDefinition, ToolRiskClass, ToolsetName } from "../../contracts/tool.js";
import { DEFAULT_DELEGATION_CONFIG } from "../../config/delegation-defaults.js";
import { DurableDelegationService } from "../../delegation/durable-delegation-service.js";
import { resolveChildToolAccess } from "../../delegation/toolset-security.js";
import { SQLiteSessionDB } from "../../session/sqlite-session-db.js";
import { SQLiteTaskStore } from "../../workflow/sqlite-task-store.js";
import type { SmokeCase, SmokeContext } from "../smoke-case.js";

export const delegation_mvp_case: SmokeCase = {
  id: "delegation-mvp",
  name: "Durable delegation Task cutover smoke coverage",
  tags: ["delegation", "tasks", "runtime", "security"],
  run: async (context) => {
    smokeToolBounds(context);
    await smokeDurableCreation(context);
  }
};

function smokeToolBounds(context: SmokeContext): void {
  const tools = [
    ...context.tools.list(),
    tool("delegate_task", "shared-state-mutation", ["core", "research", "coding"])
  ];
  const leaf = resolveChildToolAccess({
    parentVisibleTools: tools,
    childCandidateTools: tools,
    config: delegationConfig({ maxSpawnDepth: 2 }),
    request: { role: "leaf", depth: 1 }
  });
  const orchestrator = resolveChildToolAccess({
    parentVisibleTools: tools,
    childCandidateTools: tools,
    config: delegationConfig({ maxSpawnDepth: 2 }),
    request: { role: "orchestrator", depth: 1 }
  });
  assert(!leaf.effectiveAllowedTools.includes("delegate_task"), "leaf Task Step must not receive delegate_task");
  assert(orchestrator.effectiveAllowedTools.includes("delegate_task"), "bounded orchestrator Task Step should retain delegate_task");
}

async function smokeDurableCreation(context: SmokeContext): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "estacoda-durable-delegation-smoke-"));
  const sessionDb = new SQLiteSessionDB({ path: join(root, "sessions.sqlite") });
  try {
    await sessionDb.createSession({ id: "parent", profileId: "smoke" });
    const store = new SQLiteTaskStore({ db: sessionDb.db, profileId: "smoke" });
    const service = new DurableDelegationService({
      store,
      creatorSessionId: () => "parent",
      workspace: { canonicalPath: context.configToolsWorkspace, identityHash: "smoke-workspace" },
      config: delegationConfig({ maxConcurrentChildren: 2, maxBatchTasks: 3, maxSpawnDepth: 2 }),
      visibleTools: () => [
        tool("file.read", "read-only-local", ["files"]),
        tool("web.search", "read-only-network", ["web"]),
        tool("task.result.read", "read-only-local", ["core"]),
        tool("delegate_task", "shared-state-mutation", ["core", "research", "coding"])
      ]
    });
    const first = service.create({
      toolCallId: "provider-call-1",
      trustedWorkspace: true,
      tasks: [{ task: "Inspect A" }, { task: "Inspect B", role: "orchestrator" }],
      synthesis: { objective: "Combine both durable worker Results." }
    });
    const replay = service.create({
      toolCallId: "provider-call-1",
      trustedWorkspace: true,
      tasks: [{ task: "Inspect A" }, { task: "Inspect B", role: "orchestrator" }],
      synthesis: { objective: "Combine both durable worker Results." }
    });
    const task = store.getTask(first.taskId);
    assert(first.status === "queued", "delegate_task must return a queued handle immediately");
    assert(replay.taskId === first.taskId && replay.idempotentReplay, "provider call replay must reuse the durable Task");
    assert(task?.executionLimits.maxConcurrentAttempts === 2, "durable Task must preserve configured delegation concurrency");
    const steps = store.listSteps(first.taskId, task?.activePlanRevisionId ?? "missing");
    const synthesis = steps.find((step) => step.executor.role === "synthesis");
    assert(steps.length === 3, "synthesized batch delegation must persist workers and one terminal Step");
    assert(synthesis !== undefined, "synthesized batch delegation must include the synthesis Step");
    assert(synthesis.id === first.primaryResultStepId, "synthesis must be the declared primary Result Step");
    assert(synthesis.dependsOn.length === 2, "synthesis must depend on every fixed worker Step");
  } finally {
    sessionDb.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function delegationConfig(overrides: Partial<DelegationConfig>): DelegationConfig {
  return { ...DEFAULT_DELEGATION_CONFIG, ...overrides };
}

function tool(name: string, riskClass: ToolRiskClass, toolsets: ToolsetName[]): ToolDefinition {
  return {
    name,
    description: name,
    inputSchema: { type: "object" },
    riskClass,
    toolsets,
    progressLabel: name,
    maxResultSizeChars: 1_000
  };
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
