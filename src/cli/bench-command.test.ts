import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelProfile, ResolvedModelRoute } from "../contracts/provider.js";
import type { RuntimeEvent } from "../contracts/runtime-event.js";
import type { Runtime, RuntimeOptions } from "../runtime/create-runtime.js";
import type { LoadedRuntimeConfig } from "../config/runtime-config.js";
import { runCliCommand } from "./cli.js";
import { benchCommand } from "./bench-command.js";

let tempDir: string | undefined;

async function makeTempDir(prefix = "estacoda-bench-command-test-"): Promise<string> {
  tempDir = await mkdtemp(join(tmpdir(), prefix));
  return tempDir;
}

afterEach(async () => {
  if (tempDir !== undefined) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("benchCommand", () => {
  it("renders help through the central CLI dispatcher", async () => {
    const result = await runCliCommand({
      argv: ["bench", "--help"],
      workspaceRoot: "/tmp/workspace",
      homeDir: "/tmp/home"
    });

    expect(result.handled).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("estacoda bench run");
  });

  it("runs a headless benchmark task and writes artifacts", async () => {
    const root = await makeTempDir();
    const workspace = join(root, "workspace");
    const outDir = join(root, "artifacts");
    const generatedHome = join(root, "home");
    await mkdir(workspace);
    const capturedRuntimeOptions: RuntimeOptions[] = [];
    const runtime = fakeRuntime([
      {
        kind: "provider-result",
        provider: "openai",
        model: "gpt-test",
        ok: true,
        fallback: false,
        willFallback: false,
        usage: {
          inputTokens: 100,
          outputTokens: 25,
          totalTokens: 125
        }
      },
      {
        kind: "tool-start",
        tool: "terminal.run"
      },
      {
        kind: "tool-result",
        tool: "terminal.run",
        ok: false
      },
      {
        kind: "provider-budget-exhausted",
        budget: "iterations",
        limit: 4,
        observed: 5,
        reason: "benchmark loop limit reached"
      },
      {
        kind: "security-risk-escalated",
        from: "read-only-local",
        to: "workspace-write",
        reason: "write requested after inspection"
      },
      {
        kind: "context-estimate",
        filled: 2048,
        total: 8192,
        source: "assembled-prompt",
        stage: "assembled-prompt"
      }
    ]);

    const result = await benchCommand(
      {
        argv: [],
        workspaceRoot: workspace,
        homeDir: join(root, "caller-home")
      },
      [
        "run",
        "--workspace", workspace,
        "--instruction", "solve the task",
        "--out", outDir,
        "--model", "openai/gpt-test",
        "--temperature", "0",
        "--max-tokens", "1200",
        "--benchmark-name", "terminal-bench",
        "--benchmark-version", "2.0",
        "--task-id", "task-a"
      ],
      {
        loadConfig: async () => fakeLoadedConfig("unconfigured", "unconfigured"),
        createRuntime: (async (options) => {
          capturedRuntimeOptions.push(options);
          return runtime;
        }) as typeof import("../runtime/create-runtime.js").createRuntime,
        makeTempHome: async () => generatedHome,
        getPackageVersion: async () => "0.1.test",
        getGitCommit: async () => "abc123",
        getGitBranch: async () => "ame/benchmark-regression-tracking",
        now: sequentialNow([
          new Date("2026-07-05T00:00:00.000Z"),
          new Date("2026-07-05T00:00:03.000Z")
        ])
      }
    );

    expect(result).toMatchObject({
      handled: true,
      exitCode: 0
    });
    expect(result.output).toContain("Benchmark run: success");
    const runtimeInput = vi.mocked(runtime.handle).mock.calls[0]?.[0];
    expect(runtimeInput).toEqual(expect.objectContaining({
      trustedWorkspace: true
    }));
    expect(runtimeInput?.text).toContain("Benchmark execution contract:");
    expect(runtimeInput?.text).toContain("isolated benchmark workspace or container");
    expect(runtimeInput?.text).toContain("The task is evaluated by filesystem, process, or benchmark-verifier state, not by prose alone.");
    expect(runtimeInput?.text).toContain("Do not answer with a plan only");
    expect(runtimeInput?.text).toContain("Task instruction:\nsolve the task");
    expect(runtimeInput?.text).not.toContain("task-a");
    expect(capturedRuntimeOptions[0]).toMatchObject({
      workspaceRoot: workspace,
      homeDir: generatedHome,
      providerConfigs: {
        openai: {
          enableNetwork: true
        }
      },
      securityMode: "open",
      workspaceTrusted: true,
      executionControls: {
        providerRequestDefaults: {
          temperature: 0,
          maxTokens: 1200
        },
        childProcessEnv: {
          mode: "isolated",
          homeDir: generatedHome
        }
      }
    });

    const summary = JSON.parse(await readFile(join(outDir, "summary.json"), "utf8"));
    expect(summary).toMatchObject({
      runMode: "headless-benchmark",
      benchmark: {
        name: "terminal-bench",
        version: "2.0",
        taskId: "task-a",
        attempt: 1
      },
      estacoda: {
        version: "0.1.test",
        gitCommit: "abc123"
      },
      execution: {
        status: "success",
        workspace,
        home: generatedHome,
        homeMode: "generated",
        sessionId: "session-1",
        trajectoryId: "trajectory-1"
      },
      model: {
        provider: "openai",
        id: "gpt-test",
        settings: {
          temperature: 0,
          maxTokens: 1200
        }
      },
      metrics: {
        providerCalls: 1,
        toolCalls: 1,
        toolFailures: 1,
        providerBudgetExhaustions: 1,
        securityEscalations: 1,
        contextUsageEvents: 1,
        inputTokens: 100,
        outputTokens: 25,
        totalTokens: 125,
        estimatedCostUsd: null
      },
      artifacts: {
        history: join(outDir, "history.jsonl")
      },
      finalAnswer: "done"
    });

    const history = JSON.parse(await readFile(join(outDir, "history.jsonl"), "utf8"));
    expect(history).toMatchObject({
      kind: "benchmark-history-record",
      timestamp: "2026-07-05T00:00:03.000Z",
      estacoda: {
        version: "0.1.test",
        gitCommit: "abc123",
        branch: "ame/benchmark-regression-tracking"
      },
      benchmark: {
        name: "terminal-bench",
        version: "2.0",
        taskId: "task-a"
      },
      tokenCounts: {
        inputTokens: 100,
        outputTokens: 25,
        totalTokens: 125
      },
      estimatedCostUsd: null
    });

    const events = await readFile(join(outDir, "events.ndjson"), "utf8");
    expect(events).toContain("\"provider-result\"");
    expect(events).toContain("\"provider-budget-exhausted\"");
    expect(events).toContain("\"security-risk-escalated\"");
    expect(events).toContain("\"context-estimate\"");
    expect(await readFile(join(outDir, "stdout.txt"), "utf8")).toContain("done");
  });

  it("writes a config_error summary when no benchmark model can be resolved", async () => {
    const root = await makeTempDir();
    const workspace = join(root, "workspace");
    const outDir = join(root, "artifacts");
    await mkdir(workspace);

    const result = await benchCommand(
      {
        argv: [],
        workspaceRoot: workspace,
        homeDir: join(root, "caller-home")
      },
      [
        "run",
        "--workspace", workspace,
        "--instruction", "solve the task",
        "--out", outDir
      ],
      {
        loadConfig: async () => fakeLoadedConfig("unconfigured", "unconfigured"),
        makeTempHome: async () => join(root, "home"),
        getPackageVersion: async () => "0.1.test",
        getGitCommit: async () => null,
        now: sequentialNow([
          new Date("2026-07-05T00:00:00.000Z"),
          new Date("2026-07-05T00:00:01.000Z")
        ])
      }
    );

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Benchmark run: config_error");

    const summary = JSON.parse(await readFile(join(outDir, "summary.json"), "utf8"));
    expect(summary.execution.status).toBe("config_error");
    expect(summary.failure).toMatchObject({
      status: "config_error"
    });
  });

  it("writes config_error artifacts to explicit summary and event paths", async () => {
    const root = await makeTempDir();
    const workspace = join(root, "workspace");
    const summaryPath = join(root, "explicit", "summary.json");
    const eventLogPath = join(root, "logs", "events.jsonl");
    await mkdir(workspace);

    const result = await benchCommand(
      {
        argv: [],
        workspaceRoot: workspace,
        homeDir: join(root, "caller-home")
      },
      [
        "run",
        "--workspace", workspace,
        "--instruction", "solve the task",
        "--json-output", summaryPath,
        "--event-log", eventLogPath
      ],
      {
        loadConfig: async () => fakeLoadedConfig("unconfigured", "unconfigured"),
        makeTempHome: async () => join(root, "home"),
        getPackageVersion: async () => "0.1.test",
        getGitCommit: async () => null,
        now: sequentialNow([
          new Date("2026-07-05T00:00:00.000Z"),
          new Date("2026-07-05T00:00:01.000Z")
        ])
      }
    );

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(`Summary: ${summaryPath}`);
    expect(result.output).toContain(`Events: ${eventLogPath}`);

    const summary = JSON.parse(await readFile(summaryPath, "utf8"));
    expect(summary).toMatchObject({
      benchmark: null,
      execution: {
        status: "config_error"
      },
      metrics: {
        estimatedCostUsd: null
      },
      finalAnswer: "",
      artifacts: {
        summary: summaryPath,
        eventLog: eventLogPath,
        history: join(root, "explicit", "history.jsonl"),
        stdout: join(root, "explicit", "stdout.txt"),
        stderr: join(root, "explicit", "stderr.txt")
      }
    });

    const eventLog = await readFile(eventLogPath, "utf8");
    expect(eventLog).toBe("");
    expect(await readFile(join(root, "explicit", "stdout.txt"), "utf8")).toContain("status=config_error");
    expect(await readFile(join(root, "explicit", "stderr.txt"), "utf8")).toContain("No benchmark model is configured");
    expect(await readFile(join(root, "explicit", "history.jsonl"), "utf8")).toContain("\"status\":\"config_error\"");
  });

  it("streams benchmark events before the run finishes", async () => {
    const root = await makeTempDir();
    const workspace = join(root, "workspace");
    const outDir = join(root, "artifacts");
    const eventLog = join(outDir, "events.ndjson");
    await mkdir(workspace);
    let sawStreamedEvent = false;
    const runtime = {
      ...fakeRuntime([]),
      handle: vi.fn(async (input) => {
        await input.onEvent?.({
          kind: "tool-start",
          tool: "terminal.run"
        });
        sawStreamedEvent = (await readFile(eventLog, "utf8")).includes("\"tool-start\"");
        return {
          label: "EstaCoda",
          text: "done",
          providerExecution: undefined,
          toolExecutions: [],
          progress: []
        } as unknown as Awaited<ReturnType<Runtime["handle"]>>;
      })
    } as Runtime;

    await benchCommand(
      { argv: [], workspaceRoot: workspace, homeDir: join(root, "caller-home") },
      [
        "run",
        "--workspace", workspace,
        "--instruction", "solve the task",
        "--out", outDir,
        "--model", "openai/gpt-test"
      ],
      dependenciesForRuntime(root, runtime)
    );

    expect(sawStreamedEvent).toBe(true);
  });

  it("does not retry or add a corrective nudge when a benchmark run returns without tool calls", async () => {
    const root = await makeTempDir();
    const workspace = join(root, "workspace");
    const outDir = join(root, "artifacts");
    await mkdir(workspace);
    const runtime = fakeRuntime([
      {
        kind: "provider-result",
        provider: "openai",
        model: "gpt-test",
        ok: true,
        fallback: false,
        willFallback: false
      }
    ], "Implementation plan only.");

    const result = await benchCommand(
      { argv: [], workspaceRoot: workspace, homeDir: join(root, "caller-home") },
      [
        "run",
        "--workspace", workspace,
        "--instruction", "solve the task",
        "--out", outDir,
        "--model", "openai/gpt-test",
        "--benchmark-name", "terminal-bench",
        "--benchmark-version", "2.0",
        "--task-id", "make-mips-interpreter"
      ],
      dependenciesForRuntime(root, runtime)
    );

    expect(result.exitCode).toBe(0);
    expect(runtime.handle).toHaveBeenCalledTimes(1);
    const runtimeInput = vi.mocked(runtime.handle).mock.calls[0]?.[0];
    expect(runtimeInput?.text).toContain("Benchmark execution contract:");
    expect(runtimeInput?.text).toContain("Task instruction:\nsolve the task");
    expect(runtimeInput?.text).not.toContain("You did not use tools");
    expect(runtimeInput?.text).not.toContain("make-mips-interpreter");

    const summary = JSON.parse(await readFile(join(outDir, "summary.json"), "utf8"));
    expect(summary.metrics).toMatchObject({
      providerCalls: 1,
      providerToolCalls: 0,
      toolCalls: 0
    });
    expect(summary.finalAnswer).toBe("Implementation plan only.");
  });

  it("redacts stdout and stderr artifacts by default", async () => {
    const root = await makeTempDir();
    const workspace = join(root, "workspace");
    const successOutDir = join(root, "success-artifacts");
    const failureOutDir = join(root, "failure-artifacts");
    await mkdir(workspace);
    const secret = "sk-123456789012345678901234";

    await benchCommand(
      { argv: [], workspaceRoot: workspace, homeDir: join(root, "caller-home") },
      [
        "run",
        "--workspace", workspace,
        "--instruction", "solve the task",
        "--out", successOutDir,
        "--model", "openai/gpt-test"
      ],
      dependenciesForRuntime(root, fakeRuntime([], `\u001b[32mfinal\u001b[0m ${secret}`))
    );

    const stdout = await readFile(join(successOutDir, "stdout.txt"), "utf8");
    expect(stdout).not.toContain(secret);
    expect(stdout).toContain("[REDACTED]");
    expect(stdout).not.toMatch(/\u001b\[/u);

    await benchCommand(
      { argv: [], workspaceRoot: workspace, homeDir: join(root, "caller-home") },
      [
        "run",
        "--workspace", workspace,
        "--instruction", "solve the task",
        "--out", failureOutDir,
        "--model", "openai/gpt-test"
      ],
      dependenciesForRuntime(root, throwingRuntime(`provider failed API_KEY=${secret}`))
    );

    const stderr = await readFile(join(failureOutDir, "stderr.txt"), "utf8");
    expect(stderr).not.toContain(secret);
    expect(stderr).toContain("[REDACTED]");
    expect(stderr).not.toMatch(/\u001b\[/u);
  });

  it("hard-enforces benchmark timeout when runtime ignores abort", async () => {
    const root = await makeTempDir();
    const workspace = join(root, "workspace");
    const outDir = join(root, "artifacts");
    await mkdir(workspace);
    const runtime = hangingRuntime();

    const result = await benchCommand(
      { argv: [], workspaceRoot: workspace, homeDir: join(root, "caller-home") },
      [
        "run",
        "--workspace", workspace,
        "--instruction", "solve the task",
        "--out", outDir,
        "--model", "openai/gpt-test",
        "--timeout-ms", "10"
      ],
      dependenciesForRuntime(root, runtime)
    );

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Benchmark run: timeout");
    expect(runtime.dispose).toHaveBeenCalled();
    const summary = JSON.parse(await readFile(join(outDir, "summary.json"), "utf8"));
    expect(summary.execution.status).toBe("timeout");
  });

  it("compares benchmark history artifacts with positional paths", async () => {
    const root = await makeTempDir();
    const baseline = join(root, "baseline.jsonl");
    const current = join(root, "current.jsonl");
    await writeHistoryFixture(baseline, { taskId: "task-a", durationSeconds: 10, totalTokens: 100, toolFailures: 0 });
    await writeHistoryFixture(current, { taskId: "task-a", durationSeconds: 14, totalTokens: 160, toolFailures: 1 });

    const result = await benchCommand(
      { argv: [], workspaceRoot: root, homeDir: join(root, "caller-home") },
      ["compare", baseline, current]
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("# Benchmark Comparison");
    expect(result.output).toContain("aggregate: duration increased by 40%.");
    expect(result.output).toContain("aggregate: tool failures increased by 1.");
  });

  it("compares benchmark summary artifacts with --baseline and --current", async () => {
    const root = await makeTempDir();
    const baseline = join(root, "baseline-summary.json");
    const current = join(root, "current-summary.json");
    await writeSummaryFixture(baseline, { taskId: "task-a", totalTokens: 100, toolFailures: 1 });
    await writeSummaryFixture(current, { taskId: "task-a", totalTokens: 90, toolFailures: 0 });

    const result = await benchCommand(
      { argv: [], workspaceRoot: root, homeDir: join(root, "caller-home") },
      ["compare", "--baseline", baseline, "--current", current]
    );

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("| fixture-suite/1/task-a | success -> success |");
    expect(result.output).toContain("tool failures improved by 1");
  });
});

function fakeRuntime(events: RuntimeEvent[], finalText = "done"): Runtime {
  return {
    sessionId: "session-1",
    trajectoryId: "trajectory-1",
    handle: vi.fn(async (input) => {
      for (const event of events) {
        await input.onEvent?.(event);
      }
      return {
        label: "EstaCoda",
        text: finalText,
        providerExecution: undefined,
        toolExecutions: [],
        progress: []
      } as unknown as Awaited<ReturnType<Runtime["handle"]>>;
    }),
    dispose: vi.fn(async () => {}),
    tools: () => [],
    skills: () => [],
    describe: () => "fake runtime",
    agentEvolutionPolicy: () => ({ enabled: false }) as never,
    getStatus: () => ({ kind: "status", title: "", groups: [] }) as never,
    getModelInfo: () => ({ kind: "keyValueBlock", title: "", items: [] }) as never,
    getStartup: () => ({ kind: "startup", title: "", subtitle: "", sections: [] }) as never,
    getStartupReadiness: async () => ({ status: "ready", checks: [] }) as never,
    latestResumeNote: async () => undefined,
    inspectMemoryPromotions: async () => [],
    inspectMcpServers: () => [],
    trustWorkspace: async () => {},
    isWorkspaceTrusted: async () => true,
    revokeWorkspaceTrust: async () => false,
    sessionDb: {} as never
  } as Runtime;
}

function throwingRuntime(message: string): Runtime {
  return {
    ...fakeRuntime([]),
    handle: vi.fn(async () => {
      throw new Error(message);
    })
  } as Runtime;
}

function hangingRuntime(): Runtime {
  return {
    ...fakeRuntime([]),
    handle: vi.fn(() => new Promise<Awaited<ReturnType<Runtime["handle"]>>>(() => {}))
  } as Runtime;
}

function dependenciesForRuntime(root: string, runtime: Runtime) {
  return {
    loadConfig: async () => fakeLoadedConfig("unconfigured", "unconfigured"),
    createRuntime: (async () => runtime) as typeof import("../runtime/create-runtime.js").createRuntime,
    makeTempHome: async () => join(root, "home"),
    getPackageVersion: async () => "0.1.test",
    getGitCommit: async () => null,
    getGitBranch: async () => null
  };
}

function fakeLoadedConfig(provider: string, id: string): LoadedRuntimeConfig {
  const model: ModelProfile = {
    provider,
    id,
    contextWindowTokens: 4096,
    supportsTools: true,
    supportsVision: false,
    supportsStructuredOutput: false
  };
  const primaryModelRoute: ResolvedModelRoute = {
    provider,
    id,
    profile: model,
    contextWindowTokens: model.contextWindowTokens
  };

  return {
    config: {
      providers: {},
      model: {
        provider,
        id
      }
    },
    sources: [],
    homeDir: "/tmp/home",
    profileId: "default",
    model,
    primaryModelRoute,
    modelFallbackRoutes: [],
    providerRegistry: {} as never,
    auxiliaryModels: {} as never,
    web: {
      enableNetwork: false
    },
    security: {
      approvalMode: "adaptive",
      assessor: {},
      allowPrivateUrls: false,
      websiteBlocklist: []
    },
    mcp: {
      servers: {}
    },
    skills: {
      externalDirs: [],
      autonomy: "off",
      config: {}
    },
    ui: {
      language: "en",
      flavor: "standard",
      activityLabels: "en",
      showResponseProgress: false
    },
    profile: {
      mode: "focused",
      responseLanguage: "en"
    },
    compression: {} as never,
    memory: {} as never,
    externalMemory: {} as never,
    browser: {
      backend: "unconfigured",
      autoLaunch: false,
      summarizeSnapshots: "auto",
      snapshotSummarizeThreshold: 0
    },
    imageGen: {} as never,
    tts: {} as never,
    stt: {} as never,
    channels: {
      telegram: {
        ready: false
      }
    }
  } as unknown as LoadedRuntimeConfig;
}

function sequentialNow(values: Date[]): () => Date {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)]!;
}

async function writeHistoryFixture(
  path: string,
  input: { taskId: string; durationSeconds: number; totalTokens: number; toolFailures: number }
): Promise<void> {
  await writeFile(path, `${JSON.stringify({
    schemaVersion: 1,
    kind: "benchmark-history-record",
    timestamp: "2026-07-06T00:00:00.000Z",
    estacoda: { version: "0.1.test", gitCommit: "abc123", branch: "main" },
    benchmark: { name: "fixture-suite", version: "1", taskId: input.taskId, attempt: 1 },
    provider: "openai",
    model: "gpt-test",
    executionSettings: { temperature: 0, maxTokens: null },
    execution: { status: "success", durationSeconds: input.durationSeconds, wallClockMs: input.durationSeconds * 1000 },
    metrics: {
      ...emptyMetricFixture(),
      totalTokens: input.totalTokens,
      toolFailures: input.toolFailures
    },
    tokenCounts: { inputTokens: input.totalTokens, outputTokens: 0, totalTokens: input.totalTokens },
    estimatedCostUsd: null
  })}\n`, "utf8");
}

async function writeSummaryFixture(
  path: string,
  input: { taskId: string; totalTokens: number; toolFailures: number }
): Promise<void> {
  await writeFile(path, `${JSON.stringify({
    schemaVersion: 1,
    runMode: "headless-benchmark",
    benchmark: { name: "fixture-suite", version: "1", taskId: input.taskId, attempt: 1 },
    estacoda: { version: "0.1.test", gitCommit: "abc123" },
    execution: {
      status: "success",
      startedAt: "2026-07-06T00:00:00.000Z",
      endedAt: "2026-07-06T00:00:01.000Z",
      wallClockMs: 1000,
      workspace: "/tmp/workspace",
      home: "/tmp/home",
      homeMode: "generated",
      policy: "container-benchmark",
      sessionId: "session-1",
      trajectoryId: null
    },
    model: { provider: "openai", id: "gpt-test", settings: { temperature: 0, maxTokens: null } },
    metrics: {
      ...emptyMetricFixture(),
      totalTokens: input.totalTokens,
      toolFailures: input.toolFailures
    },
    finalAnswer: "done",
    artifacts: {
      summary: path,
      eventLog: "/tmp/events.jsonl",
      trajectory: null,
      trajectorySummary: null,
      history: null,
      stdout: null,
      stderr: null
    },
    failure: null
  })}\n`, "utf8");
}

function emptyMetricFixture() {
  return {
    providerCalls: 0,
    providerToolCalls: 0,
    toolCalls: 0,
    toolFailures: 0,
    providerIterations: 0,
    providerBudgetExhaustions: 0,
    promptAssemblies: 0,
    skillRouteEvents: 0,
    sessionRecallTriggered: false,
    sessionRecallCount: 0,
    sessionRecallWarningCount: 0,
    externalMemoryRecallCount: 0,
    memoryWrites: 0,
    memoryPromotions: 0,
    securityEscalations: 0,
    agentCancelled: false,
    contextUsageEvents: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: null
  };
}
