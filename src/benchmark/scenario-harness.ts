import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LoadedRuntimeConfig } from "../config/runtime-config.js";
import type { Runtime, RuntimeOptions } from "../runtime/create-runtime.js";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import type { RuntimeEvent } from "../contracts/runtime-event.js";
import type { Trajectory } from "../contracts/trajectory.js";
import type { BenchmarkMetrics, BenchmarkRunSummary } from "./schema.js";
import { createEmptyBenchmarkMetrics } from "./schema.js";
import { benchCommand } from "../cli/bench-command.js";

export type BenchmarkScenarioHarnessInput = {
  fixtureRoot: string;
  instruction: string;
  model: string;
  benchmark: {
    name: string;
    version: string;
    taskId: string;
  };
  createRuntime: (options: RuntimeOptions & { sessionDb: SQLiteSessionDB }) => Promise<Runtime> | Runtime;
  loadConfig: () => Promise<LoadedRuntimeConfig>;
  timeoutMs?: number;
};

export type BenchmarkScenarioHarnessResult = {
  root: string;
  workspace: string;
  home: string;
  outDir: string;
  dbPath: string;
  summary: BenchmarkRunSummary;
  events: RuntimeEvent[];
  trajectory?: Trajectory;
  cleanup: () => Promise<void>;
};

export type BenchmarkCrossSessionRunInput = {
  id: string;
  instruction: string;
  taskId: string;
  createRuntime: (options: RuntimeOptions & { sessionDb: SQLiteSessionDB }) => Promise<Runtime> | Runtime;
};

export type BenchmarkCrossSessionHarnessInput = {
  fixtureRoot: string;
  model: string;
  benchmark: {
    name: string;
    version: string;
  };
  sessions: BenchmarkCrossSessionRunInput[];
  loadConfig: () => Promise<LoadedRuntimeConfig>;
  timeoutMs?: number;
};

export type BenchmarkCrossSessionRunResult = {
  id: string;
  outDir: string;
  summary: BenchmarkRunSummary;
  events: RuntimeEvent[];
  trajectory?: Trajectory;
};

export type BenchmarkCrossSessionHarnessResult = {
  root: string;
  workspace: string;
  home: string;
  dbPath: string;
  sessions: BenchmarkCrossSessionRunResult[];
  aggregateMetrics: BenchmarkMetrics;
  cleanup: () => Promise<void>;
};

export async function runBenchmarkScenario(
  input: BenchmarkScenarioHarnessInput
): Promise<BenchmarkScenarioHarnessResult> {
  const root = await mkdtemp(join(tmpdir(), "estacoda-trajectory-scenario-"));
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  const outDir = join(root, "artifacts");
  const dbPath = join(home, "sessions.sqlite");

  await mkdir(home, { recursive: true });
  const db = new SQLiteSessionDB({ path: dbPath });
  await cp(join(input.fixtureRoot, "workspace"), workspace, { recursive: true });

  try {
    const result = await benchCommand(
      {
        argv: [],
        workspaceRoot: workspace,
        homeDir: home
      },
      [
        "run",
        "--workspace", workspace,
        "--instruction", input.instruction,
        "--out", outDir,
        "--home", home,
        "--model", input.model,
        "--benchmark-name", input.benchmark.name,
        "--benchmark-version", input.benchmark.version,
        "--task-id", input.benchmark.taskId,
        "--temperature", "0",
        "--timeout-ms", String(input.timeoutMs ?? 5000)
      ],
      {
        loadConfig: input.loadConfig,
        createSessionDb: () => db,
        createRuntime: (async (options) => input.createRuntime({
          ...options,
          sessionDb: db
        })) as typeof import("../runtime/create-runtime.js").createRuntime,
        makeTempHome: async () => home,
        getPackageVersion: async () => "0.1.test",
        getGitCommit: async () => "trajectory-scenario",
        now: sequentialNow([
          new Date("2026-07-06T00:00:00.000Z"),
          new Date("2026-07-06T00:00:04.000Z")
        ])
      }
    );

    const summary = JSON.parse(await readFile(join(outDir, "summary.json"), "utf8")) as BenchmarkRunSummary;
    const events = await readRuntimeEvents(join(outDir, "events.ndjson"));
    const trajectory = summary.artifacts.trajectory === null
      ? undefined
      : await readTrajectoryJsonl(summary.artifacts.trajectory, summary);

    if (result.exitCode !== 0 && summary.failure === null) {
      throw new Error(`Benchmark scenario failed without failure summary: ${result.output}`);
    }

    return {
      root,
      workspace,
      home,
      outDir,
      dbPath,
      summary,
      events,
      trajectory,
      cleanup: async () => {
        db.close();
        await rm(root, { recursive: true, force: true });
      }
    };
  } catch (error) {
    db.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export async function runBenchmarkCrossSessionScenario(
  input: BenchmarkCrossSessionHarnessInput
): Promise<BenchmarkCrossSessionHarnessResult> {
  const root = await mkdtemp(join(tmpdir(), "estacoda-cross-session-scenario-"));
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  const dbPath = join(home, "sessions.sqlite");

  await mkdir(home, { recursive: true });
  const db = new SQLiteSessionDB({ path: dbPath });
  await cp(join(input.fixtureRoot, "workspace"), workspace, { recursive: true });

  try {
    const sessions: BenchmarkCrossSessionRunResult[] = [];
    for (const [index, session] of input.sessions.entries()) {
      const outDir = join(root, "artifacts", session.id);
      const result = await benchCommand(
        {
          argv: [],
          workspaceRoot: workspace,
          homeDir: home
        },
        [
          "run",
          "--workspace", workspace,
          "--instruction", session.instruction,
          "--out", outDir,
          "--home", home,
          "--model", input.model,
          "--benchmark-name", input.benchmark.name,
          "--benchmark-version", input.benchmark.version,
          "--task-id", session.taskId,
          "--temperature", "0",
          "--timeout-ms", String(input.timeoutMs ?? 5000)
        ],
        {
          loadConfig: input.loadConfig,
          createSessionDb: () => db,
          createRuntime: (async (options) => session.createRuntime({
            ...options,
            sessionDb: db
          })) as typeof import("../runtime/create-runtime.js").createRuntime,
          makeTempHome: async () => home,
          getPackageVersion: async () => "0.1.test",
          getGitCommit: async () => "cross-session-scenario",
          now: sequentialNow([
            new Date(Date.UTC(2026, 6, 6, 0, index * 2, 0, 0)),
            new Date(Date.UTC(2026, 6, 6, 0, index * 2, 4, 0))
          ])
        }
      );

      const summary = JSON.parse(await readFile(join(outDir, "summary.json"), "utf8")) as BenchmarkRunSummary;
      const events = await readRuntimeEvents(join(outDir, "events.ndjson"));
      const trajectory = summary.artifacts.trajectory === null
        ? undefined
        : await readTrajectoryJsonl(summary.artifacts.trajectory, summary);

      if (result.exitCode !== 0 && summary.failure === null) {
        throw new Error(`Cross-session benchmark scenario failed without failure summary: ${result.output}`);
      }

      sessions.push({
        id: session.id,
        outDir,
        summary,
        events,
        trajectory
      });
    }

    return {
      root,
      workspace,
      home,
      dbPath,
      sessions,
      aggregateMetrics: aggregateSessionMetrics(sessions.map((session) => session.summary.metrics)),
      cleanup: async () => {
        db.close();
        await rm(root, { recursive: true, force: true });
      }
    };
  } catch (error) {
    db.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function readRuntimeEvents(path: string): Promise<RuntimeEvent[]> {
  const content = await readFile(path, "utf8");
  if (content.trim().length === 0) {
    return [];
  }
  return content.trim().split("\n").map((line) => JSON.parse(line) as RuntimeEvent);
}

async function readTrajectoryJsonl(path: string, summary: BenchmarkRunSummary): Promise<Trajectory> {
  const content = await readFile(path, "utf8");
  const events = content.trim().length === 0
    ? []
    : content.trim().split("\n").map((line) => JSON.parse(line) as Trajectory["events"][number]);
  return {
    id: summary.execution.trajectoryId ?? "",
    profileId: "default",
    sessionId: summary.execution.sessionId ?? "",
    modelId: summary.model.id,
    events,
    outcome: undefined
  };
}

function sequentialNow(values: Date[]): () => Date {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}

function aggregateSessionMetrics(metricsList: BenchmarkMetrics[]): BenchmarkMetrics {
  const aggregate = createEmptyBenchmarkMetrics();
  for (const metrics of metricsList) {
    aggregate.providerCalls += metrics.providerCalls;
    aggregate.providerToolCalls += metrics.providerToolCalls;
    aggregate.toolCalls += metrics.toolCalls;
    aggregate.toolFailures += metrics.toolFailures;
    aggregate.providerIterations += metrics.providerIterations;
    aggregate.providerBudgetExhaustions += metrics.providerBudgetExhaustions;
    aggregate.promptAssemblies += metrics.promptAssemblies;
    aggregate.skillRouteEvents += metrics.skillRouteEvents;
    aggregate.sessionRecallTriggered ||= metrics.sessionRecallTriggered;
    aggregate.sessionRecallCount += metrics.sessionRecallCount;
    aggregate.sessionRecallWarningCount += metrics.sessionRecallWarningCount;
    aggregate.externalMemoryRecallCount += metrics.externalMemoryRecallCount;
    aggregate.memoryWrites += metrics.memoryWrites;
    aggregate.memoryPromotions += metrics.memoryPromotions;
    aggregate.securityEscalations += metrics.securityEscalations;
    aggregate.agentCancelled ||= metrics.agentCancelled;
    aggregate.contextUsageEvents += metrics.contextUsageEvents;
    aggregate.inputTokens += metrics.inputTokens;
    aggregate.outputTokens += metrics.outputTokens;
    aggregate.totalTokens += metrics.totalTokens;
    aggregate.estimatedCostUsd = combineCost(aggregate.estimatedCostUsd, metrics.estimatedCostUsd);
  }
  return aggregate;
}

function combineCost(left: number | null, right: number | null): number | null {
  if (right === null) {
    return null;
  }
  return left === null ? right : left + right;
}
