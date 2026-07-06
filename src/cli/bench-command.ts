import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { compareBenchmarkHistories } from "../benchmark/compare.js";
import { createBenchmarkHistoryRecord, readBenchmarkHistoryRecords } from "../benchmark/history.js";
import { aggregateBenchmarkMetrics } from "../benchmark/metrics.js";
import { renderBenchmarkComparisonMarkdown } from "../benchmark/report.js";
import {
  buildBenchmarkExecutionSummary,
  buildBenchmarkRunManifest
} from "../benchmark/run-manifest.js";
import type {
  BenchmarkArtifactSummary,
  BenchmarkFailureSummary,
  BenchmarkHomeMode,
  BenchmarkIdentity,
  BenchmarkModelSummary,
  BenchmarkRunStatus,
  EstaCodaBenchmarkIdentity
} from "../benchmark/schema.js";
import {
  buildBenchmarkTrajectorySummary,
  writeBenchmarkEventArtifact,
  writeBenchmarkEventLogArtifact,
  writeBenchmarkHistoryArtifact,
  writeBenchmarkSummaryArtifact,
  writeBenchmarkTrajectoryArtifact,
  writeBenchmarkTrajectorySummaryArtifact
} from "../benchmark/artifacts.js";
import { redactBenchmarkText, stripBenchmarkAnsi } from "../benchmark/redaction.js";
import { buildProviderRegistry, loadRuntimeConfig, type LoadedRuntimeConfig } from "../config/runtime-config.js";
import { applyRegisterProviderConfig, applyRegisterProviderModel } from "../config/provider-config-mutations.js";
import type { ResolvedModelRoute } from "../contracts/provider.js";
import type { RuntimeEvent } from "../contracts/runtime-event.js";
import type { SessionDB } from "../contracts/session.js";
import type { TrajectoryStore } from "../contracts/trajectory-store.js";
import { InMemorySessionDB } from "../session/in-memory-session-db.js";
import { resolveTokens } from "../theme/token-resolver.js";
import { createRuntime, type Runtime } from "../runtime/create-runtime.js";
import { normalizeModelInput } from "../providers/model-normalization.js";
import { getPackageVersion } from "./version-command.js";
import type { CliCommandResult, CliOptions } from "./cli.js";

const execFileAsync = promisify(execFile);

type BenchRunArgs = {
  workspace: string;
  outDir: string;
  artifactPaths: {
    summary?: string;
    eventLog?: string;
  };
  instruction: string;
  homeDir?: string;
  homeMode: BenchmarkHomeMode;
  benchmark: BenchmarkIdentity | null;
  modelInput?: string;
  temperature: number;
  maxTokens: number | null;
  timeoutMs: number;
  redact: boolean;
  providerBudgets: {
    maxProviderIterations?: number;
    maxProviderToolCalls?: number;
    maxRepeatedToolFailures?: number;
    maxProviderWallClockMs?: number;
  };
};

type BenchCompareArgs = {
  baseline: string;
  current: string;
};

type BenchArtifactPaths = BenchmarkArtifactSummary & {
  trajectory: string;
  trajectorySummary: string;
  history: string;
  stdout: string;
  stderr: string;
};

export type BenchCommandDependencies = {
  loadConfig?: typeof loadRuntimeConfig;
  createRuntime?: typeof createRuntime;
  createSessionDb?: (input: { homeDir: string; workspaceRoot: string }) => SessionDB;
  getPackageVersion?: typeof getPackageVersion;
  getGitCommit?: (workspaceRoot: string) => Promise<string | null>;
  getGitBranch?: (workspaceRoot: string) => Promise<string | null>;
  makeTempHome?: () => Promise<string>;
  now?: () => Date;
};

export async function benchCommand(
  options: CliOptions,
  args: string[],
  dependencies: BenchCommandDependencies = {}
): Promise<CliCommandResult> {
  const subcommand = args[0];
  if (subcommand === undefined || subcommand === "--help" || subcommand === "-h") {
    return {
      handled: true,
      exitCode: 0,
      output: renderBenchHelp()
    };
  }

  if (subcommand === "compare") {
    if (hasFlag(args.slice(1), "--help", "-h")) {
      return {
        handled: true,
        exitCode: 0,
        output: renderBenchCompareHelp()
      };
    }

    const parsedCompare = parseBenchCompareArgs(args.slice(1));
    if (!parsedCompare.ok) {
      return {
        handled: true,
        exitCode: 1,
        output: parsedCompare.error
      };
    }
    return runBenchCompare(parsedCompare.args);
  }

  if (subcommand !== "run") {
    return {
      handled: true,
      exitCode: 1,
      output: `Unknown bench command: ${subcommand}\n\n${renderBenchHelp()}`
    };
  }

  if (hasFlag(args.slice(1), "--help", "-h")) {
    return {
      handled: true,
      exitCode: 0,
      output: renderBenchRunHelp()
    };
  }

  const parsed = await parseBenchRunArgs(args.slice(1));
  if (!parsed.ok) {
    return {
      handled: true,
      exitCode: 1,
      output: parsed.error
    };
  }

  return runBenchRun(options, parsed.args, dependencies);
}

async function runBenchCompare(args: BenchCompareArgs): Promise<CliCommandResult> {
  try {
    const [baseline, current] = await Promise.all([
      readBenchmarkHistoryRecords(args.baseline),
      readBenchmarkHistoryRecords(args.current)
    ]);
    const comparison = compareBenchmarkHistories({ baseline, current });
    return {
      handled: true,
      exitCode: 0,
      output: renderBenchmarkComparisonMarkdown(comparison)
    };
  } catch (error) {
    return {
      handled: true,
      exitCode: 1,
      output: error instanceof Error ? error.message : String(error)
    };
  }
}

async function runBenchRun(
  options: CliOptions,
  args: BenchRunArgs,
  dependencies: BenchCommandDependencies
): Promise<CliCommandResult> {
  const now = dependencies.now ?? (() => new Date());
  const startedAt = now();
  const artifacts = benchmarkArtifactPaths(args.outDir, args.artifactPaths);
  const events: RuntimeEvent[] = [];
  let runtime: Runtime | undefined;
  let finalAnswer = "";
  let status: BenchmarkRunStatus = "success";
  let failure: BenchmarkFailureSummary | null = null;
  let modelSummary: BenchmarkModelSummary = {
    provider: args.modelInput?.split("/", 1)[0] ?? "unconfigured",
    id: args.modelInput?.includes("/") === true ? args.modelInput.slice(args.modelInput.indexOf("/") + 1) : args.modelInput ?? "unconfigured",
    settings: {
      temperature: args.temperature,
      maxTokens: args.maxTokens
    }
  };
  const benchmarkHome = args.homeDir ?? await (dependencies.makeTempHome ?? defaultMakeTempHome)();
  const sessionDb = dependencies.createSessionDb?.({
    homeDir: benchmarkHome,
    workspaceRoot: args.workspace
  }) ?? new InMemorySessionDB();

  await prepareBenchmarkArtifactDirs(artifacts);
  await writeBenchmarkEventLogArtifact(artifacts.eventLog, [], { redact: args.redact });

  try {
    const config = await loadBenchmarkConfig({
      workspaceRoot: args.workspace,
      homeDir: benchmarkHome,
      profileId: options.profileId,
      loadConfig: dependencies.loadConfig ?? loadRuntimeConfig
    });
    const route = await resolveBenchmarkModelRoute(config, args.modelInput);
    if (route === undefined) {
      throw benchmarkError(
        "config_error",
        "No benchmark model is configured. Pass --model <provider/model> or configure the selected benchmark home."
      );
    }
    const runtimeConfig = args.modelInput === undefined
      ? config
      : enableBenchmarkModelProvider(config, route);

    modelSummary = {
      provider: route.provider,
      id: route.id,
      settings: {
        temperature: args.temperature,
        maxTokens: args.maxTokens
      }
    };

    runtime = await (dependencies.createRuntime ?? createRuntime)({
      tokens: resolveTokens("standard", "dark", "kemetBlue"),
      model: route.profile,
      primaryModelRoute: route,
      modelFallbackRoutes: runtimeConfig.modelFallbackRoutes,
      homeDir: benchmarkHome,
      profileId: options.profileId ?? runtimeConfig.profileId,
      workspaceRoot: args.workspace,
      sessionDb,
      externalSkillRoots: runtimeConfig.skills.externalDirs,
      skillAutonomy: runtimeConfig.skills.autonomy,
      skillConfig: runtimeConfig.skills.config,
      ui: runtimeConfig.ui,
      agentProfile: runtimeConfig.profile,
      providerRegistry: runtimeConfig.providerRegistry,
      providerConfigs: runtimeConfig.config.providers,
      auxiliaryModels: runtimeConfig.auxiliaryModels,
      compression: runtimeConfig.compression,
      memory: runtimeConfig.memory,
      externalMemory: runtimeConfig.externalMemory,
      mcpServers: runtimeConfig.mcp.servers,
      browser: runtimeConfig.browser,
      imageGen: runtimeConfig.imageGen,
      tts: runtimeConfig.tts,
      stt: runtimeConfig.stt,
      telegramReady: false,
      enableWebNetwork: runtimeConfig.web.enableNetwork,
      webMaxContentChars: runtimeConfig.web.maxContentChars,
      webConfig: {
        backend: runtimeConfig.web.backend,
        searchBackend: runtimeConfig.web.searchBackend,
        extractBackend: runtimeConfig.web.extractBackend,
        crawlBackend: runtimeConfig.web.crawlBackend,
        brave: runtimeConfig.web.brave
      },
      securityConfig: {
        allowPrivateUrls: runtimeConfig.security.allowPrivateUrls,
        websiteBlocklist: runtimeConfig.security.websiteBlocklist
      },
      securityMode: "open",
      workspaceTrusted: true,
      executionControls: {
        providerBudgets: args.providerBudgets,
        providerRequestDefaults: {
          temperature: args.temperature,
          ...(args.maxTokens === null ? {} : { maxTokens: args.maxTokens })
        },
        childProcessEnv: {
          mode: "isolated",
          homeDir: benchmarkHome
        }
      }
    });

    const response = await runWithTimeout(
      args.timeoutMs,
      (signal) => runtime!.handle({
        text: args.instruction,
        channel: "cli",
        trustedWorkspace: true,
        signal,
        onEvent: async (event) => {
          events.push(event);
          await writeBenchmarkEventArtifact(artifacts.eventLog, event, { redact: args.redact });
        }
      })
    );
    finalAnswer = response.text;
  } catch (error) {
    const classified = classifyBenchmarkError(error);
    status = classified.status;
    failure = classified.failure;
  } finally {
    await runtime?.dispose();
  }

  const endedAt = now();
  const estacoda = await buildEstaCodaBenchmarkIdentity(args.workspace, dependencies);
  const gitBranch = await (dependencies.getGitBranch ?? defaultGetGitBranch)(args.workspace);
  const trajectory = await loadBenchmarkTrajectory(sessionDb, runtime?.trajectoryId);
  const metrics = aggregateBenchmarkMetrics(events, undefined, trajectory);
  if (trajectory !== undefined) {
    await writeBenchmarkTrajectoryArtifact(artifacts.trajectory, trajectory, { redact: args.redact });
    await writeBenchmarkTrajectorySummaryArtifact(
      artifacts.trajectorySummary,
      buildBenchmarkTrajectorySummary(trajectory, metrics),
      { redact: args.redact }
    );
  }
  const summary = buildBenchmarkRunManifest({
    benchmark: args.benchmark,
    estacoda,
    execution: buildBenchmarkExecutionSummary({
      status,
      startedAt,
      endedAt,
      workspace: args.workspace,
      home: benchmarkHome,
      homeMode: args.homeMode,
      sessionId: runtime?.sessionId ?? null,
      trajectoryId: runtime?.trajectoryId ?? null
    }),
    model: modelSummary,
    metrics,
    finalAnswer,
    artifacts: {
      summary: artifacts.summary,
      eventLog: artifacts.eventLog,
      trajectory: trajectory === undefined ? null : artifacts.trajectory,
      trajectorySummary: trajectory === undefined ? null : artifacts.trajectorySummary,
      history: artifacts.history,
      stdout: artifacts.stdout,
      stderr: failure === null ? null : artifacts.stderr
    },
    failure
  });

  await writeBenchmarkHistoryArtifact(
    artifacts.history,
    createBenchmarkHistoryRecord(summary, { timestamp: endedAt, branch: gitBranch }),
    { redact: args.redact }
  );
  await writeBenchmarkSummaryArtifact(artifacts.summary, summary, { redact: args.redact });
  await writeTextBenchmarkArtifact(artifacts.stdout, renderBenchmarkStdout(summary), args.redact);
  if (failure !== null) {
    await writeTextBenchmarkArtifact(artifacts.stderr, `${failure.message}\n`, args.redact);
  }

  return {
    handled: true,
    exitCode: status === "success" ? 0 : 1,
    output: [
      `Benchmark run: ${status}`,
      `Summary: ${artifacts.summary}`,
      `Events: ${artifacts.eventLog}`,
      `Home: ${benchmarkHome}`,
      failure === null ? undefined : `Error: ${failure.message}`
    ].filter((line) => line !== undefined).join("\n")
  };
}

function parseBenchCompareArgs(args: string[]): { ok: true; args: BenchCompareArgs } | { ok: false; error: string } {
  let baseline: string | undefined;
  let current: string | undefined;
  const positional: string[] = [];

  try {
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      switch (arg) {
        case "--baseline":
          baseline = requiredValue(args, ++index, arg);
          break;
        case "--current":
          current = requiredValue(args, ++index, arg);
          break;
        default:
          if (arg.startsWith("--")) {
            return { ok: false, error: `Unknown bench compare option: ${arg}\n\n${renderBenchCompareHelp()}` };
          }
          positional.push(arg);
      }
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  if (baseline !== undefined || current !== undefined) {
    if (positional.length > 0) {
      return { ok: false, error: "Use either positional runs or --baseline/--current, not both." };
    }
    if (baseline === undefined || current === undefined) {
      return { ok: false, error: "bench compare requires both --baseline <run> and --current <run>." };
    }
    return { ok: true, args: { baseline: resolve(baseline), current: resolve(current) } };
  }

  if (positional.length !== 2) {
    return { ok: false, error: `bench compare requires two run artifacts.\n\n${renderBenchCompareHelp()}` };
  }
  return { ok: true, args: { baseline: resolve(positional[0]!), current: resolve(positional[1]!) } };
}

async function resolveBenchmarkModelRoute(
  config: LoadedRuntimeConfig,
  modelInput: string | undefined
): Promise<LoadedRuntimeConfig["primaryModelRoute"] | undefined> {
  if (modelInput === undefined) {
    return config.primaryModelRoute.provider === "unconfigured" || config.primaryModelRoute.id === "unconfigured"
      ? undefined
      : config.primaryModelRoute;
  }

  const normalized = await normalizeModelInput(modelInput, { config: config.config });
  if (normalized.kind !== "exact") {
    throw benchmarkError("config_error", `Unable to resolve model '${modelInput}': ${normalized.reason}`);
  }
  return normalized.route;
}

function enableBenchmarkModelProvider(
  config: LoadedRuntimeConfig,
  route: ResolvedModelRoute
): LoadedRuntimeConfig {
  const providerConfig = applyRegisterProviderConfig(config.config, {
    provider: route.provider,
    ...(route.baseUrl === undefined ? {} : { baseUrl: route.baseUrl }),
    ...(route.apiKeyEnv === undefined ? {} : { apiKeyEnv: route.apiKeyEnv }),
    enableNetwork: true
  });
  const patchedConfig = applyRegisterProviderModel(providerConfig, {
    provider: route.provider,
    models: [route.id]
  });

  return {
    ...config,
    config: patchedConfig,
    providerRegistry: buildProviderRegistry(patchedConfig)
  };
}

async function loadBenchmarkConfig(input: {
  workspaceRoot: string;
  homeDir: string;
  profileId: string | undefined;
  loadConfig: typeof loadRuntimeConfig;
}): Promise<LoadedRuntimeConfig> {
  try {
    return await input.loadConfig({
      workspaceRoot: input.workspaceRoot,
      homeDir: input.homeDir,
      profileId: input.profileId
    });
  } catch (error) {
    throw benchmarkError("config_error", error instanceof Error ? error.message : String(error));
  }
}

async function parseBenchRunArgs(args: string[]): Promise<{ ok: true; args: BenchRunArgs } | { ok: false; error: string }> {
  let workspace: string | undefined;
  let outDir: string | undefined;
  let summaryPath: string | undefined;
  let eventLogPath: string | undefined;
  let instruction: string | undefined;
  let instructionFile: string | undefined;
  let homeDir: string | undefined;
  let isolatedHome = false;
  let modelInput: string | undefined;
  let benchmarkName: string | undefined;
  let benchmarkVersion: string | undefined;
  let taskId: string | undefined;
  let attempt = 1;
  let temperature = 0;
  let maxTokens: number | null = null;
  let timeoutMs = 30 * 60_000;
  let redact = true;
  const providerBudgets: BenchRunArgs["providerBudgets"] = {};

  try {
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      switch (arg) {
        case "--workspace":
          workspace = requiredValue(args, ++index, arg);
          break;
        case "--out":
        case "--output-dir":
          outDir = requiredValue(args, ++index, arg);
          break;
        case "--json-output":
          summaryPath = requiredValue(args, ++index, arg);
          break;
        case "--event-log":
          eventLogPath = requiredValue(args, ++index, arg);
          break;
        case "--instruction":
          instruction = requiredValue(args, ++index, arg);
          break;
        case "--instruction-file":
          instructionFile = requiredValue(args, ++index, arg);
          break;
        case "--home":
          homeDir = requiredValue(args, ++index, arg);
          break;
        case "--isolated-home":
          isolatedHome = true;
          break;
        case "--model":
          modelInput = requiredValue(args, ++index, arg);
          break;
        case "--benchmark-name":
          benchmarkName = requiredValue(args, ++index, arg);
          break;
        case "--benchmark-version":
          benchmarkVersion = requiredValue(args, ++index, arg);
          break;
        case "--task-id":
          taskId = requiredValue(args, ++index, arg);
          break;
        case "--attempt":
          attempt = parsePositiveInteger(requiredValue(args, ++index, arg), arg);
          break;
        case "--temperature":
          temperature = parseFiniteNumber(requiredValue(args, ++index, arg), arg);
          break;
        case "--max-tokens":
          maxTokens = parsePositiveInteger(requiredValue(args, ++index, arg), arg);
          break;
        case "--timeout-ms":
          timeoutMs = parsePositiveInteger(requiredValue(args, ++index, arg), arg);
          break;
        case "--max-provider-iterations":
          providerBudgets.maxProviderIterations = parsePositiveInteger(requiredValue(args, ++index, arg), arg);
          break;
        case "--max-provider-tool-calls":
          providerBudgets.maxProviderToolCalls = parsePositiveInteger(requiredValue(args, ++index, arg), arg);
          break;
        case "--max-repeated-tool-failures":
          providerBudgets.maxRepeatedToolFailures = parsePositiveInteger(requiredValue(args, ++index, arg), arg);
          break;
        case "--max-provider-wall-clock-ms":
          providerBudgets.maxProviderWallClockMs = parsePositiveInteger(requiredValue(args, ++index, arg), arg);
          break;
        case "--no-redact":
          redact = false;
          break;
        default:
          return { ok: false, error: `Unknown bench run option: ${arg}\n\n${renderBenchRunHelp()}` };
      }
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  if (workspace === undefined) {
    return { ok: false, error: "bench run requires --workspace <dir>." };
  }
  if (outDir === undefined && summaryPath === undefined && eventLogPath === undefined) {
    return { ok: false, error: "bench run requires --out <dir> or --json-output/--event-log artifact paths." };
  }
  if (instruction !== undefined && instructionFile !== undefined) {
    return { ok: false, error: "Use only one of --instruction or --instruction-file." };
  }
  if (instruction === undefined && instructionFile === undefined) {
    return { ok: false, error: "bench run requires --instruction <text> or --instruction-file <path>." };
  }
  if (homeDir !== undefined && isolatedHome) {
    return { ok: false, error: "Use only one of --home or --isolated-home." };
  }

  const identityFields = [benchmarkName, benchmarkVersion, taskId].filter((value) => value !== undefined).length;
  if (identityFields !== 0 && identityFields !== 3) {
    return {
      ok: false,
      error: "Benchmark identity requires --benchmark-name, --benchmark-version, and --task-id together."
    };
  }

  let resolvedInstruction: string;
  try {
    resolvedInstruction = instructionFile === undefined
      ? instruction!
      : await readFile(instructionFile, "utf8");
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  const resolvedSummaryPath = summaryPath === undefined ? undefined : resolve(summaryPath);
  const resolvedEventLogPath = eventLogPath === undefined ? undefined : resolve(eventLogPath);
  const resolvedOutDir = outDir === undefined
    ? dirname(resolvedSummaryPath ?? resolvedEventLogPath!)
    : resolve(outDir);

  return {
    ok: true,
    args: {
      workspace: resolve(workspace),
      outDir: resolvedOutDir,
      artifactPaths: {
        ...(resolvedSummaryPath === undefined ? {} : { summary: resolvedSummaryPath }),
        ...(resolvedEventLogPath === undefined ? {} : { eventLog: resolvedEventLogPath })
      },
      instruction: resolvedInstruction,
      homeDir: homeDir === undefined ? undefined : resolve(homeDir),
      homeMode: homeDir === undefined ? "generated" : "explicit",
      benchmark: benchmarkName === undefined || benchmarkVersion === undefined || taskId === undefined
        ? null
        : { name: benchmarkName, version: benchmarkVersion, taskId, attempt },
      modelInput,
      temperature,
      maxTokens,
      timeoutMs,
      redact,
      providerBudgets
    }
  };
}

async function runWithTimeout<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const runPromise = run(controller.signal);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort(new BenchmarkTimeoutError(timeoutMs));
      reject(new BenchmarkTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([runPromise, timeoutPromise]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    if (timedOut) {
      runPromise.catch(() => {});
    }
  }
}

function classifyBenchmarkError(error: unknown): {
  status: BenchmarkRunStatus;
  failure: BenchmarkFailureSummary;
} {
  if (error instanceof BenchmarkCliError) {
    return {
      status: error.status,
      failure: {
        status: error.status,
        message: error.message
      }
    };
  }
  if (error instanceof BenchmarkTimeoutError) {
    return {
      status: "timeout",
      failure: {
        status: "timeout",
        message: `Benchmark run exceeded ${error.timeoutMs}ms.`,
        code: "timeout"
      }
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  const status: BenchmarkRunStatus = /provider|model/iu.test(message) ? "provider_error" : "runtime_error";
  return {
    status,
    failure: {
      status,
      message
    }
  };
}

function benchmarkError(status: BenchmarkRunStatus, message: string): BenchmarkCliError {
  return new BenchmarkCliError(status, message);
}

class BenchmarkCliError extends Error {
  constructor(readonly status: BenchmarkRunStatus, message: string) {
    super(message);
  }
}

class BenchmarkTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Benchmark timed out after ${timeoutMs}ms.`);
  }
}

async function buildEstaCodaBenchmarkIdentity(
  workspaceRoot: string,
  dependencies: BenchCommandDependencies
): Promise<EstaCodaBenchmarkIdentity> {
  const version = await (dependencies.getPackageVersion ?? getPackageVersion)();
  const gitCommit = await (dependencies.getGitCommit ?? defaultGetGitCommit)(workspaceRoot);
  return { version, gitCommit };
}

async function defaultGetGitCommit(workspaceRoot: string): Promise<string | null> {
  try {
    const result = await execFileAsync("git", ["-C", workspaceRoot, "rev-parse", "--short", "HEAD"]);
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

async function defaultGetGitBranch(workspaceRoot: string): Promise<string | null> {
  try {
    const result = await execFileAsync("git", ["-C", workspaceRoot, "rev-parse", "--abbrev-ref", "HEAD"]);
    const branch = result.stdout.trim();
    return branch.length === 0 || branch === "HEAD" ? null : branch;
  } catch {
    return null;
  }
}

async function defaultMakeTempHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "estacoda-bench-home-"));
}

function benchmarkArtifactPaths(
  outDir: string,
  overrides: BenchRunArgs["artifactPaths"] = {}
): BenchArtifactPaths {
  return {
    summary: overrides.summary ?? join(outDir, "summary.json"),
    eventLog: overrides.eventLog ?? join(outDir, "events.ndjson"),
    trajectory: join(outDir, "trajectory.jsonl"),
    trajectorySummary: join(outDir, "trajectory-summary.json"),
    history: join(outDir, "history.jsonl"),
    stdout: join(outDir, "stdout.txt"),
    stderr: join(outDir, "stderr.txt")
  };
}

async function prepareBenchmarkArtifactDirs(
  artifacts: BenchArtifactPaths
): Promise<void> {
  await Promise.all(
    Array.from(new Set([
      dirname(artifacts.summary),
      dirname(artifacts.eventLog),
      dirname(artifacts.trajectory),
      dirname(artifacts.trajectorySummary),
      dirname(artifacts.history),
      dirname(artifacts.stdout),
      dirname(artifacts.stderr)
    ])).map((dir) => mkdir(dir, { recursive: true }))
  );
}

function renderBenchmarkStdout(summary: ReturnType<typeof buildBenchmarkRunManifest>): string {
  return [
    `status=${summary.execution.status}`,
    `session=${summary.execution.sessionId ?? ""}`,
    `trajectory=${summary.execution.trajectoryId ?? ""}`,
    "",
    summary.finalAnswer
  ].join("\n");
}

async function writeTextBenchmarkArtifact(path: string, content: string, redact: boolean): Promise<void> {
  const cleanContent = stripBenchmarkAnsi(content);
  await writeFile(path, redact ? redactBenchmarkText(cleanContent) : cleanContent, "utf8");
}

async function loadBenchmarkTrajectory(
  sessionDb: SessionDB,
  trajectoryId: string | undefined
): Promise<import("../contracts/trajectory.js").Trajectory | undefined> {
  if (trajectoryId === undefined || !isTrajectoryStore(sessionDb)) {
    return undefined;
  }

  return sessionDb.loadTrajectory(trajectoryId);
}

function isTrajectoryStore(db: SessionDB): db is SessionDB & Pick<TrajectoryStore, "loadTrajectory"> {
  return typeof (db as { loadTrajectory?: unknown }).loadTrajectory === "function";
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return parsed;
}

function parseFiniteNumber(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${flag} must be a finite number.`);
  }
  return parsed;
}

function hasFlag(args: readonly string[], ...flags: string[]): boolean {
  return args.some((arg) => flags.includes(arg));
}

function renderBenchHelp(): string {
  return [
    "EstaCoda benchmark",
    "",
    "Usage:",
    "  estacoda bench run --workspace <dir> --instruction <text> --out <dir>",
    "  estacoda bench run --workspace <dir> --instruction-file <path> --out <dir>",
    "  estacoda bench run --workspace <dir> --instruction-file <path> --json-output <path> --event-log <path>",
    "  estacoda bench compare <baseline-run> <current-run>",
    "  estacoda bench compare --baseline <run> --current <run>",
    "",
    "Run EstaCoda headlessly for benchmark harnesses and compare historical runs."
  ].join("\n");
}

function renderBenchCompareHelp(): string {
  return [
    "EstaCoda benchmark compare",
    "",
    "Usage:",
    "  estacoda bench compare <baseline-run> <current-run>",
    "  estacoda bench compare --baseline <run> --current <run>",
    "",
    "Compares benchmark history JSONL or summary JSON artifacts and prints a warning-only markdown report."
  ].join("\n");
}

function renderBenchRunHelp(): string {
  return [
    "EstaCoda benchmark run",
    "",
    "Usage:",
    "  estacoda bench run --workspace <dir> --instruction <text> --out <dir> [--model <provider/model>]",
    "  estacoda bench run --workspace <dir> --instruction-file <path> --json-output <path> --event-log <path>",
    "",
    "Options:",
    "  --workspace <dir>              Explicit benchmark workspace",
    "  --instruction <text>           Task instruction",
    "  --instruction-file <path>      Read task instruction from a file",
    "  --out, --output-dir <dir>      Artifact output directory",
    "  --json-output <path>           Write summary JSON to an explicit path",
    "  --event-log <path>             Write event log JSONL/NDJSON to an explicit path",
    "  --home <dir>                   Explicit EstaCoda home for this run",
    "  --isolated-home                Use a generated isolated home (default)",
    "  --model <provider/model>       Command-local model override",
    "  --temperature <n>              Provider temperature (default: 0)",
    "  --max-tokens <n>               Provider max tokens",
    "  --timeout-ms <n>               Run timeout in milliseconds",
    "  --benchmark-name <name>        Benchmark identity name",
    "  --benchmark-version <version>  Benchmark identity version",
    "  --task-id <id>                 Benchmark task id",
    "  --attempt <n>                  Benchmark attempt number (default: 1)",
    "  --no-redact                    Write artifacts without default redaction",
    "  --help, -h                    Show this help"
  ].join("\n");
}
