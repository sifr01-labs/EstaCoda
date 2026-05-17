import type { CliCommandResult, CliOptions } from "./cli.js";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import { createSQLiteSessionDB } from "../session/session-setup.js";
import { resolveStateHome } from "../config/state-home.js";
import { defaultProfileId, readActiveProfile } from "../config/profile-home.js";
import { SQLiteTaskFlowStore } from "../taskflow/sqlite-taskflow-store.js";
import { FlowLockService } from "../taskflow/flow-lock-service.js";
import { TaskFlowEngine } from "../taskflow/taskflow-engine.js";
import { OperatorCommandDispatcher } from "../taskflow/operator-command-dispatcher.js";
import { FlowProcessRegistry } from "../taskflow/flow-process-registry.js";
import { FlowCompactionService, DEFAULT_COMPACTION_CONFIG } from "../taskflow/flow-compaction-service.js";

export async function flowCommand(options: CliOptions, args: string[]): Promise<CliCommandResult> {
  const [subcommand, ...restArgs] = args;

  const openedDb = await openFlowDb(options);
  const { db, profileId } = openedDb;

  try {
    switch (subcommand) {
      case "list":
        return await flowList(db, profileId);
      case "show":
        return await flowShow(db, profileId, restArgs);
      case "status":
        return await flowStatus(db, profileId, restArgs);
      case "trace":
        return await flowTrace(db, profileId, restArgs);
      case "pause":
        return await flowPause(db, profileId, restArgs);
      case "resume":
        return await flowResume(db, profileId, restArgs);
      case "interrupt":
        return await flowInterrupt(db, profileId, restArgs);
      case "cancel":
        return await flowCancel(db, profileId, restArgs);
      case "steer":
        return await flowSteer(db, profileId, restArgs);
      case "approve":
        return await flowApprove(db, profileId, restArgs);
      case "reject":
        return await flowReject(db, profileId, restArgs);
      case "retry":
        return await flowRetry(db, profileId, restArgs);
      case "skip":
        return await flowSkip(db, profileId, restArgs);
      case "checkpoint":
        return await flowCheckpoint(db, profileId, restArgs);
      case "compact":
        return await flowCompact(db, profileId, restArgs);
      case undefined:
      case "help":
      case "--help":
      case "-h":
        return {
          handled: true,
          exitCode: 0,
          output: flowHelp()
        };
      default:
        return {
          handled: true,
          exitCode: 1,
          output: `Unknown flow subcommand: ${subcommand}\n\n${flowHelp()}`
        };
    }
  } finally {
    await openedDb.close();
  }
}

async function openFlowDb(options: CliOptions): Promise<{ db: SQLiteSessionDB; profileId: string; close: () => void }> {
  const profileId = options.profileId ?? readActiveProfile({ homeDir: options.homeDir }).profileId ?? defaultProfileId();
  if (options.runtime?.sessionDb instanceof SQLiteSessionDB) {
    return { db: options.runtime.sessionDb, profileId, close: () => undefined };
  }

  const stateHome = resolveStateHome({ homeDir: options.homeDir });
  const db = await createSQLiteSessionDB({ path: stateHome.sessionsSqlitePath });
  return { db, profileId, close: () => db.close() };
}

function createFlowServices(db: SQLiteSessionDB, profileId: string) {
  const store = new SQLiteTaskFlowStore({ db: db.db, profileId });
  const lockService = new FlowLockService({ store });
  const engine = new TaskFlowEngine({ store, lockService, ownerId: "cli" });
  const processRegistry = new FlowProcessRegistry({ store });
  const compactionService = new FlowCompactionService({ store, config: DEFAULT_COMPACTION_CONFIG });
  const dispatcher = new OperatorCommandDispatcher({ engine, store, processRegistry, compactionService });
  return { store, engine, dispatcher };
}

function flowHelp(): string {
  return [
    "EstaCoda flow commands (v0.8)",
    "  estacoda flow list                          List all flows",
    "  estacoda flow show <flowId>                 Show flow details",
    "  estacoda flow status <flowId>               Show flow status",
    "  estacoda flow trace <flowId> [limit]        Show flow trace",
    "  estacoda flow pause <flowId> [reason]       Request pause at next safe boundary",
    "  estacoda flow resume <flowId>               Resume a paused/interrupted/waiting flow",
    "  estacoda flow interrupt <flowId> [reason]   Interrupt a running flow",
    "  estacoda flow cancel <flowId> [reason]      Cancel a flow",
    "  estacoda flow steer <flowId> <instruction>  Inject operator guidance",
    "  estacoda flow approve <stepId>              Approve a pending gate",
    "  estacoda flow reject <stepId> [reason]      Reject a pending gate",
    "  estacoda flow retry <stepId>                Retry a failed step",
    "  estacoda flow skip <stepId> [reason]        Skip a skippable step",
    "  estacoda flow checkpoint <flowId> <name>    Create a checkpoint",
    "  estacoda flow compact <flowId>              Compact flow events"
  ].join("\n");
}

async function flowList(db: SQLiteSessionDB, profileId: string): Promise<CliCommandResult> {
  const { store } = createFlowServices(db, profileId);
  const flows = await store.listActiveFlows();

  if (flows.length === 0) {
    return { handled: true, exitCode: 0, output: "No flows found." };
  }

  const lines = flows.map((f) => {
    const elapsed = f.createdAt ? Math.floor((Date.now() - new Date(f.createdAt).getTime()) / 1000) : 0;
    const elapsedStr = elapsed > 60 ? `${Math.floor(elapsed / 60)}m` : `${elapsed}s`;
    return `${f.id}  ${f.status.padEnd(12)}  ${elapsedStr.padStart(4)}  ${f.sessionId}`;
  });

  return {
    handled: true,
    exitCode: 0,
    output: ["flowId                        status        age  sessionId", ...lines].join("\n")
  };
}

async function flowShow(db: SQLiteSessionDB, profileId: string, args: string[]): Promise<CliCommandResult> {
  const flowId = args[0];
  if (flowId === undefined) {
    return { handled: true, exitCode: 1, output: "Usage: estacoda flow show <flowId>" };
  }

  const { store } = createFlowServices(db, profileId);
  const flow = await store.getFlow(flowId);
  if (!flow) {
    return { handled: true, exitCode: 1, output: `Flow not found: ${flowId}` };
  }

  const steps = await store.listSteps(flowId);
  const lines = [
    `Flow: ${flow.id}`,
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

async function flowStatus(db: SQLiteSessionDB, profileId: string, args: string[]): Promise<CliCommandResult> {
  const flowId = args[0];
  if (flowId === undefined) {
    return { handled: true, exitCode: 1, output: "Usage: estacoda flow status <flowId>" };
  }

  const { dispatcher } = createFlowServices(db, profileId);
  const result = await dispatcher.dispatch({ command: "/status", flowId });
  return {
    handled: true,
    exitCode: result.ok ? 0 : 1,
    output: result.ok ? result.message : `Error: ${result.error}`
  };
}

async function flowTrace(db: SQLiteSessionDB, profileId: string, args: string[]): Promise<CliCommandResult> {
  const flowId = args[0];
  const limit = args[1] !== undefined ? parseInt(args[1], 10) : undefined;
  if (flowId === undefined) {
    return { handled: true, exitCode: 1, output: "Usage: estacoda flow trace <flowId> [limit]" };
  }

  const { dispatcher } = createFlowServices(db, profileId);
  const result = await dispatcher.dispatch({ command: "/trace", flowId, limit: Number.isNaN(limit) ? undefined : limit });
  return {
    handled: true,
    exitCode: result.ok ? 0 : 1,
    output: result.ok ? result.message : `Error: ${result.error}`
  };
}

async function flowPause(db: SQLiteSessionDB, profileId: string, args: string[]): Promise<CliCommandResult> {
  const flowId = args[0];
  if (flowId === undefined) {
    return { handled: true, exitCode: 1, output: "Usage: estacoda flow pause <flowId> [reason]" };
  }

  const { dispatcher } = createFlowServices(db, profileId);
  const result = await dispatcher.dispatch({
    command: "/pause",
    flowId,
    reason: args.slice(1).join(" ") || undefined,
    operator: "cli"
  });
  return {
    handled: true,
    exitCode: result.ok ? 0 : 1,
    output: result.ok ? result.message : `Error: ${result.error}`
  };
}

async function flowResume(db: SQLiteSessionDB, profileId: string, args: string[]): Promise<CliCommandResult> {
  const flowId = args[0];
  if (flowId === undefined) {
    return { handled: true, exitCode: 1, output: "Usage: estacoda flow resume <flowId>" };
  }

  const { dispatcher } = createFlowServices(db, profileId);
  const result = await dispatcher.dispatch({ command: "/resume", flowId, operator: "cli" });
  return {
    handled: true,
    exitCode: result.ok ? 0 : 1,
    output: result.ok ? result.message : `Error: ${result.error}`
  };
}

async function flowInterrupt(db: SQLiteSessionDB, profileId: string, args: string[]): Promise<CliCommandResult> {
  const flowId = args[0];
  if (flowId === undefined) {
    return { handled: true, exitCode: 1, output: "Usage: estacoda flow interrupt <flowId> [reason]" };
  }

  const { dispatcher } = createFlowServices(db, profileId);
  const result = await dispatcher.dispatch({
    command: "/interrupt",
    flowId,
    reason: args.slice(1).join(" ") || undefined,
    operator: "cli"
  });
  return {
    handled: true,
    exitCode: result.ok ? 0 : 1,
    output: result.ok ? result.message : `Error: ${result.error}`
  };
}

async function flowCancel(db: SQLiteSessionDB, profileId: string, args: string[]): Promise<CliCommandResult> {
  const flowId = args[0];
  if (flowId === undefined) {
    return { handled: true, exitCode: 1, output: "Usage: estacoda flow cancel <flowId> [reason]" };
  }

  const { dispatcher } = createFlowServices(db, profileId);
  const result = await dispatcher.dispatch({
    command: "/cancel",
    flowId,
    reason: args.slice(1).join(" ") || undefined,
    operator: "cli"
  });
  return {
    handled: true,
    exitCode: result.ok ? 0 : 1,
    output: result.ok ? result.message : `Error: ${result.error}`
  };
}

async function flowSteer(db: SQLiteSessionDB, profileId: string, args: string[]): Promise<CliCommandResult> {
  const flowId = args[0];
  const guidance = args.slice(1).join(" ");
  if (flowId === undefined || guidance.length === 0) {
    return { handled: true, exitCode: 1, output: "Usage: estacoda flow steer <flowId> <instruction>" };
  }

  const { dispatcher } = createFlowServices(db, profileId);
  const result = await dispatcher.dispatch({
    command: "/steer",
    flowId,
    guidance,
    operator: "cli"
  });
  return {
    handled: true,
    exitCode: result.ok ? 0 : 1,
    output: result.ok ? result.message : `Error: ${result.error}`
  };
}

async function flowApprove(db: SQLiteSessionDB, profileId: string, args: string[]): Promise<CliCommandResult> {
  const stepId = args[0];
  if (stepId === undefined) {
    return { handled: true, exitCode: 1, output: "Usage: estacoda flow approve <stepId>" };
  }

  const { dispatcher } = createFlowServices(db, profileId);
  const result = await dispatcher.dispatch({ command: "/approve", stepId, operator: "cli" });
  return {
    handled: true,
    exitCode: result.ok ? 0 : 1,
    output: result.ok ? result.message : `Error: ${result.error}`
  };
}

async function flowReject(db: SQLiteSessionDB, profileId: string, args: string[]): Promise<CliCommandResult> {
  const stepId = args[0];
  if (stepId === undefined) {
    return { handled: true, exitCode: 1, output: "Usage: estacoda flow reject <stepId> [reason]" };
  }

  const { dispatcher } = createFlowServices(db, profileId);
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

async function flowRetry(db: SQLiteSessionDB, profileId: string, args: string[]): Promise<CliCommandResult> {
  const stepId = args[0];
  if (stepId === undefined) {
    return { handled: true, exitCode: 1, output: "Usage: estacoda flow retry <stepId>" };
  }

  const { dispatcher } = createFlowServices(db, profileId);
  const result = await dispatcher.dispatch({ command: "/retry", stepId, operator: "cli" });
  return {
    handled: true,
    exitCode: result.ok ? 0 : 1,
    output: result.ok ? result.message : `Error: ${result.error}`
  };
}

async function flowSkip(db: SQLiteSessionDB, profileId: string, args: string[]): Promise<CliCommandResult> {
  const stepId = args[0];
  if (stepId === undefined) {
    return { handled: true, exitCode: 1, output: "Usage: estacoda flow skip <stepId> [reason]" };
  }

  const { dispatcher } = createFlowServices(db, profileId);
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

async function flowCheckpoint(db: SQLiteSessionDB, profileId: string, args: string[]): Promise<CliCommandResult> {
  const flowId = args[0];
  const name = args.slice(1).join(" ");
  if (flowId === undefined || name.length === 0) {
    return { handled: true, exitCode: 1, output: "Usage: estacoda flow checkpoint <flowId> <name>" };
  }

  const { dispatcher } = createFlowServices(db, profileId);
  const result = await dispatcher.dispatch({
    command: "/checkpoint",
    flowId,
    name,
    operator: "cli"
  });
  return {
    handled: true,
    exitCode: result.ok ? 0 : 1,
    output: result.ok ? result.message : `Error: ${result.error}`
  };
}

async function flowCompact(db: SQLiteSessionDB, profileId: string, args: string[]): Promise<CliCommandResult> {
  const flowId = args[0];
  if (flowId === undefined) {
    return { handled: true, exitCode: 1, output: "Usage: estacoda flow compact <flowId>" };
  }

  const { dispatcher } = createFlowServices(db, profileId);
  const result = await dispatcher.dispatch({ command: "/compact", flowId, operator: "cli" });
  return {
    handled: true,
    exitCode: result.ok ? 0 : 1,
    output: result.ok ? result.message : `Error: ${result.error}`
  };
}
