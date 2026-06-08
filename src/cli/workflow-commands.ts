import type { CliCommandResult, CliOptions } from "./cli.js";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import { createSQLiteSessionDB } from "../session/session-setup.js";
import { resolveStateHome } from "../config/state-home.js";
import { defaultProfileId, readActiveProfile } from "../config/profile-home.js";
import { SQLiteWorkflowStore } from "../workflow/sqlite-workflow-store.js";
import { WorkflowLockService } from "../workflow/workflow-lock-service.js";
import { WorkflowEngine } from "../workflow/workflow-engine.js";
import { WorkflowCommandDispatcher } from "../workflow/workflow-command-dispatcher.js";
import { WorkflowProcessRegistry } from "../workflow/workflow-process-registry.js";
import { WorkflowEventSummaryService, DEFAULT_WORKFLOW_EVENT_SUMMARY_CONFIG } from "../workflow/workflow-event-summary-service.js";
import { beginExplicitWorkflowRun, beginSkillPlaybookWorkflowRun } from "../workflow/workflow-begin.js";
import type { LoadedSkill, SkillDefinition } from "../contracts/skill.js";

export async function workflowCommand(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const [subcommand, ...restArgs] = args;

  const openedDb = await openWorkflowDb(options);
  const { db, profileId } = openedDb;

  try {
    switch (subcommand) {
      case "begin":
        return await workflowBegin(db, profileId, restArgs, {
          runtimeSessionId: options.runtime?.sessionId,
          resolveSkill: options.runtime?.resolveSkill
        });
      case "list":
        return await workflowList(db, profileId);
      case "show":
        return await workflowShow(db, profileId, restArgs);
      case "status":
        return await workflowStatus(db, profileId, restArgs);
      case "trace":
        return await workflowTrace(db, profileId, restArgs);
      case "pause":
        return await workflowPause(db, profileId, restArgs);
      case "resume":
        return await workflowResume(db, profileId, restArgs);
      case "interrupt":
        return await workflowInterrupt(db, profileId, restArgs);
      case "cancel":
        return await workflowCancel(db, profileId, restArgs);
      case "steer":
        return await workflowSteer(db, profileId, restArgs);
      case "approve":
        return await workflowApprove(db, profileId, restArgs);
      case "reject":
        return await workflowReject(db, profileId, restArgs);
      case "retry":
        return await workflowRetry(db, profileId, restArgs);
      case "skip":
        return await workflowSkip(db, profileId, restArgs);
      case "checkpoint":
        return await workflowCheckpoint(db, profileId, restArgs);
      case "summarize":
        return await workflowSummarize(db, profileId, restArgs);
      case undefined:
      case "help":
      case "--help":
      case "-h":
        return {
          handled: true,
          exitCode: 0,
          output: workflowHelp()
        };
      default:
        return {
          handled: true,
          exitCode: 1,
          output: `Unknown workflow subcommand: ${subcommand}\n\n${workflowHelp()}`
        };
    }
  } finally {
    await openedDb.close();
  }
}

async function openWorkflowDb(options: CliOptions): Promise<{ db: SQLiteSessionDB; profileId: string; close: () => void }> {
  const profileId = options.profileId ?? readActiveProfile({ homeDir: options.homeDir }).profileId ?? defaultProfileId();
  if (options.runtime?.sessionDb instanceof SQLiteSessionDB) {
    return { db: options.runtime.sessionDb, profileId, close: () => undefined };
  }

  const stateHome = resolveStateHome({ homeDir: options.homeDir });
  const db = await createSQLiteSessionDB({ path: stateHome.sessionsSqlitePath });
  return { db, profileId, close: () => db.close() };
}

function createWorkflowServices(db: SQLiteSessionDB, profileId: string) {
  const store = new SQLiteWorkflowStore({ db: db.db, profileId });
  const lockService = new WorkflowLockService({ store });
  const engine = new WorkflowEngine({ store, lockService, ownerId: "cli" });
  const processRegistry = new WorkflowProcessRegistry({ store });
  const compactionService = new WorkflowEventSummaryService({ store, config: DEFAULT_WORKFLOW_EVENT_SUMMARY_CONFIG });
  const dispatcher = new WorkflowCommandDispatcher({ engine, store, processRegistry, compactionService });
  return { store, engine, dispatcher };
}

function workflowHelp(): string {
  return [
    "EstaCoda workflow commands (v0.8)",
    "  estacoda workflow begin --session <sessionId> <objective>",
    "                                                   Create and start a workflow run",
    "  estacoda workflow begin --skill <skillName> --session <sessionId> <objective>",
    "                                                   Create and start a skill playbook workflow run",
    "  estacoda workflow list                          List workflow runs",
    "  estacoda workflow show <runId>                   Show workflow run details",
    "  estacoda workflow status <runId>                 Show workflow run status",
    "  estacoda workflow trace <runId> [limit]          Show workflow run trace",
    "  estacoda workflow pause <runId> [reason]         Request pause at next safe boundary",
    "  estacoda workflow resume <runId>                 Resume a paused/interrupted/waiting workflow run",
    "  estacoda workflow interrupt <runId> [reason]     Interrupt a running workflow run",
    "  estacoda workflow cancel <runId> [reason]        Cancel a workflow run",
    "  estacoda workflow steer <runId> <instruction>    Inject operator guidance",
    "  estacoda workflow approve <stepId>               Approve a pending gate",
    "  estacoda workflow reject <stepId> [reason]       Reject a pending gate",
    "  estacoda workflow retry <stepId>                 Retry a failed step",
    "  estacoda workflow skip <stepId> [reason]         Skip a skippable step",
    "  estacoda workflow checkpoint <runId> <name>      Create a checkpoint",
    "  estacoda workflow summarize <runId>              Summarize workflow events"
  ].join("\n");
}

async function workflowBegin(
  db: SQLiteSessionDB,
  profileId: string,
  args: string[],
  options: {
    runtimeSessionId?: string;
    resolveSkill?: (name: string) => LoadedSkill | SkillDefinition | undefined;
  } = {}
): Promise<CliCommandResult> {
  const parsed = parseWorkflowBeginArgs(args);
  const sessionId = parsed.sessionId ?? options.runtimeSessionId;
  if (parsed.error !== undefined) {
    return { handled: true, exitCode: 1, output: parsed.error };
  }
  if (sessionId === undefined) {
    return {
      handled: true,
      exitCode: 1,
      output: [
        "Usage: estacoda workflow begin --session <sessionId> <objective>",
        "Workflow begin requires an explicit session ID outside an interactive session."
      ].join("\n")
    };
  }
  const objective = parsed.objective;
  if (objective.length === 0) {
    return {
      handled: true,
      exitCode: 1,
      output: parsed.skillName === undefined
        ? "Usage: estacoda workflow begin --session <sessionId> <objective>"
        : "Usage: estacoda workflow begin --skill <skillName> --session <sessionId> <objective>"
    };
  }

  const session = await db.getSessionForProfile(sessionId, profileId);
  if (session === undefined) {
    return { handled: true, exitCode: 1, output: `Session not found in active profile: ${sessionId}` };
  }

  const { engine } = createWorkflowServices(db, profileId);
  const skill = parsed.skillName === undefined ? undefined : options.resolveSkill?.(parsed.skillName);
  if (parsed.skillName !== undefined && options.resolveSkill === undefined) {
    return {
      handled: true,
      exitCode: 1,
      output: "Skill-backed workflow begin is not available in standalone CLI without a runtime skill registry."
    };
  }
  if (parsed.skillName !== undefined && skill === undefined) {
    return { handled: true, exitCode: 1, output: `Skill not found: ${parsed.skillName}` };
  }
  const result = skill === undefined
    ? await beginExplicitWorkflowRun({
        engine,
        sessionId,
        objective
      })
    : await beginSkillPlaybookWorkflowRun({
        engine,
        sessionId,
        objective,
        skill
      });

  return {
    handled: true,
    exitCode: 0,
    output: [
      `Created workflow: ${result.run.id}`,
      `Started workflow: ${result.run.id}`,
      `Not activated. Use /workflow activate ${result.run.id} inside an interactive session.`
    ].join("\n")
  };
}

function parseWorkflowBeginArgs(args: string[]): { sessionId?: string; skillName?: string; objective: string; error?: string } {
  const objectiveParts: string[] = [];
  let sessionId: string | undefined;
  let skillName: string | undefined;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--session") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) {
        return { objective: "", error: "Usage: estacoda workflow begin --session <sessionId> <objective>" };
      }
      sessionId = value;
      index++;
      continue;
    }
    if (arg === "--skill") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) {
        return { objective: "", error: "Usage: estacoda workflow begin --skill <skillName> --session <sessionId> <objective>" };
      }
      skillName = value;
      index++;
      continue;
    }
    objectiveParts.push(arg);
  }

  return {
    sessionId,
    skillName,
    objective: objectiveParts.join(" ").trim()
  };
}

async function workflowList(db: SQLiteSessionDB, profileId: string): Promise<CliCommandResult> {
  const { store } = createWorkflowServices(db, profileId);
  const runs = await store.listActiveWorkflowRuns();

  if (runs.length === 0) {
    return { handled: true, exitCode: 0, output: "No workflow runs found." };
  }

  const lines = runs.map((f) => {
    const elapsed = f.createdAt ? Math.floor((Date.now() - new Date(f.createdAt).getTime()) / 1000) : 0;
    const elapsedStr = elapsed > 60 ? `${Math.floor(elapsed / 60)}m` : `${elapsed}s`;
    return `${f.id}  ${f.status.padEnd(12)}  ${elapsedStr.padStart(4)}  ${f.sessionId}`;
  });

  return {
    handled: true,
    exitCode: 0,
    output: ["runId                         status        age  sessionId", ...lines].join("\n")
  };
}

async function workflowShow(db: SQLiteSessionDB, profileId: string, args: string[]): Promise<CliCommandResult> {
  const runId = args[0];
  if (runId === undefined) {
    return { handled: true, exitCode: 1, output: "Usage: estacoda workflow show <runId>" };
  }

  const { store } = createWorkflowServices(db, profileId);
  const flow = await store.getWorkflowRun(runId);
  if (!flow) {
    return { handled: true, exitCode: 1, output: `Workflow run not found: ${runId}` };
  }

  const steps = await store.listWorkflowSteps(runId);
  const lines = [
    `Workflow: ${flow.id}`,
    `Status: ${flow.status}`,
    `Session: ${flow.sessionId}`,
    `Created: ${flow.createdAt}`,
    `Updated: ${flow.updatedAt}`,
    `Steps: ${steps.length}`,
    `Checkpoints: ${flow.checkpointCount ?? 0}`,
    `Retries: ${flow.retryCount ?? 0}`,
    "",
    "Steps:",
    ...steps.map((s) => `  ${s.index + 1}. ${s.name} (${s.status})${s.id === flow.currentStepId ? " [current]" : ""}`)
  ];

  return { handled: true, exitCode: 0, output: lines.join("\n") };
}

async function workflowStatus(db: SQLiteSessionDB, profileId: string, args: string[]): Promise<CliCommandResult> {
  const runId = args[0];
  if (runId === undefined) {
    return { handled: true, exitCode: 1, output: "Usage: estacoda workflow status <runId>" };
  }

  const { dispatcher } = createWorkflowServices(db, profileId);
  const result = await dispatcher.dispatch({ command: "/status", runId: runId });
  return {
    handled: true,
    exitCode: result.ok ? 0 : 1,
    output: result.ok ? result.message : `Error: ${result.error}`
  };
}

async function workflowTrace(db: SQLiteSessionDB, profileId: string, args: string[]): Promise<CliCommandResult> {
  const runId = args[0];
  const limit = args[1] !== undefined ? parseInt(args[1], 10) : undefined;
  if (runId === undefined) {
    return { handled: true, exitCode: 1, output: "Usage: estacoda workflow trace <runId> [limit]" };
  }

  const { dispatcher } = createWorkflowServices(db, profileId);
  const result = await dispatcher.dispatch({ command: "/trace", runId: runId, limit: Number.isNaN(limit) ? undefined : limit });
  return {
    handled: true,
    exitCode: result.ok ? 0 : 1,
    output: result.ok ? result.message : `Error: ${result.error}`
  };
}

async function workflowPause(db: SQLiteSessionDB, profileId: string, args: string[]): Promise<CliCommandResult> {
  const runId = args[0];
  if (runId === undefined) {
    return { handled: true, exitCode: 1, output: "Usage: estacoda workflow pause <runId> [reason]" };
  }

  const { dispatcher } = createWorkflowServices(db, profileId);
  const result = await dispatcher.dispatch({
    command: "/pause",
    runId: runId,
    reason: args.slice(1).join(" ") || undefined,
    operator: "cli"
  });
  return {
    handled: true,
    exitCode: result.ok ? 0 : 1,
    output: result.ok ? result.message : `Error: ${result.error}`
  };
}

async function workflowResume(db: SQLiteSessionDB, profileId: string, args: string[]): Promise<CliCommandResult> {
  const runId = args[0];
  if (runId === undefined) {
    return { handled: true, exitCode: 1, output: "Usage: estacoda workflow resume <runId>" };
  }

  const { dispatcher } = createWorkflowServices(db, profileId);
  const result = await dispatcher.dispatch({ command: "/resume", runId: runId, operator: "cli" });
  return {
    handled: true,
    exitCode: result.ok ? 0 : 1,
    output: result.ok ? result.message : `Error: ${result.error}`
  };
}

async function workflowInterrupt(db: SQLiteSessionDB, profileId: string, args: string[]): Promise<CliCommandResult> {
  const runId = args[0];
  if (runId === undefined) {
    return { handled: true, exitCode: 1, output: "Usage: estacoda workflow interrupt <runId> [reason]" };
  }

  const { dispatcher } = createWorkflowServices(db, profileId);
  const result = await dispatcher.dispatch({
    command: "/interrupt",
    runId: runId,
    reason: args.slice(1).join(" ") || undefined,
    operator: "cli"
  });
  return {
    handled: true,
    exitCode: result.ok ? 0 : 1,
    output: result.ok ? result.message : `Error: ${result.error}`
  };
}

async function workflowCancel(db: SQLiteSessionDB, profileId: string, args: string[]): Promise<CliCommandResult> {
  const runId = args[0];
  if (runId === undefined) {
    return { handled: true, exitCode: 1, output: "Usage: estacoda workflow cancel <runId> [reason]" };
  }

  const { dispatcher } = createWorkflowServices(db, profileId);
  const result = await dispatcher.dispatch({
    command: "/cancel",
    runId: runId,
    reason: args.slice(1).join(" ") || undefined,
    operator: "cli"
  });
  return {
    handled: true,
    exitCode: result.ok ? 0 : 1,
    output: result.ok ? result.message : `Error: ${result.error}`
  };
}

async function workflowSteer(db: SQLiteSessionDB, profileId: string, args: string[]): Promise<CliCommandResult> {
  const runId = args[0];
  const guidance = args.slice(1).join(" ");
  if (runId === undefined || guidance.length === 0) {
    return { handled: true, exitCode: 1, output: "Usage: estacoda workflow steer <runId> <instruction>" };
  }

  const { dispatcher } = createWorkflowServices(db, profileId);
  const result = await dispatcher.dispatch({
    command: "/steer",
    runId: runId,
    guidance,
    operator: "cli"
  });
  return {
    handled: true,
    exitCode: result.ok ? 0 : 1,
    output: result.ok ? result.message : `Error: ${result.error}`
  };
}

async function workflowApprove(db: SQLiteSessionDB, profileId: string, args: string[]): Promise<CliCommandResult> {
  const stepId = args[0];
  if (stepId === undefined) {
    return { handled: true, exitCode: 1, output: "Usage: estacoda workflow approve <stepId>" };
  }

  const { dispatcher } = createWorkflowServices(db, profileId);
  const result = await dispatcher.dispatch({ command: "/approve", stepId, operator: "cli" });
  return {
    handled: true,
    exitCode: result.ok ? 0 : 1,
    output: result.ok ? result.message : `Error: ${result.error}`
  };
}

async function workflowReject(db: SQLiteSessionDB, profileId: string, args: string[]): Promise<CliCommandResult> {
  const stepId = args[0];
  if (stepId === undefined) {
    return { handled: true, exitCode: 1, output: "Usage: estacoda workflow reject <stepId> [reason]" };
  }

  const { dispatcher } = createWorkflowServices(db, profileId);
  const result = await dispatcher.dispatch({
    command: "/reject",
    stepId,
    reason: args.slice(1).join(" ") || undefined,
    operator: "cli"
  });
  return {
    handled: true,
    exitCode: result.ok ? 0 : 1,
    output: result.ok ? result.message : `Error: ${result.error}`
  };
}

async function workflowRetry(db: SQLiteSessionDB, profileId: string, args: string[]): Promise<CliCommandResult> {
  const stepId = args[0];
  if (stepId === undefined) {
    return { handled: true, exitCode: 1, output: "Usage: estacoda workflow retry <stepId>" };
  }

  const { dispatcher } = createWorkflowServices(db, profileId);
  const result = await dispatcher.dispatch({ command: "/retry", stepId, operator: "cli" });
  return {
    handled: true,
    exitCode: result.ok ? 0 : 1,
    output: result.ok ? result.message : `Error: ${result.error}`
  };
}

async function workflowSkip(db: SQLiteSessionDB, profileId: string, args: string[]): Promise<CliCommandResult> {
  const stepId = args[0];
  if (stepId === undefined) {
    return { handled: true, exitCode: 1, output: "Usage: estacoda workflow skip <stepId> [reason]" };
  }

  const { dispatcher } = createWorkflowServices(db, profileId);
  const result = await dispatcher.dispatch({
    command: "/skip",
    stepId,
    reason: args.slice(1).join(" ") || undefined,
    operator: "cli"
  });
  return {
    handled: true,
    exitCode: result.ok ? 0 : 1,
    output: result.ok ? result.message : `Error: ${result.error}`
  };
}

async function workflowCheckpoint(db: SQLiteSessionDB, profileId: string, args: string[]): Promise<CliCommandResult> {
  const runId = args[0];
  const name = args.slice(1).join(" ");
  if (runId === undefined || name.length === 0) {
    return { handled: true, exitCode: 1, output: "Usage: estacoda workflow checkpoint <runId> <name>" };
  }

  const { dispatcher } = createWorkflowServices(db, profileId);
  const result = await dispatcher.dispatch({
    command: "/checkpoint",
    runId: runId,
    name,
    operator: "cli"
  });
  return {
    handled: true,
    exitCode: result.ok ? 0 : 1,
    output: result.ok ? result.message : `Error: ${result.error}`
  };
}

async function workflowSummarize(db: SQLiteSessionDB, profileId: string, args: string[]): Promise<CliCommandResult> {
  const runId = args[0];
  if (runId === undefined) {
    return { handled: true, exitCode: 1, output: "Usage: estacoda workflow summarize <runId>" };
  }

  const { dispatcher } = createWorkflowServices(db, profileId);
  const result = await dispatcher.dispatch({ command: "/compact", runId: runId, operator: "cli" });
  return {
    handled: true,
    exitCode: result.ok ? 0 : 1,
    output: result.ok ? result.message : `Error: ${result.error}`
  };
}
