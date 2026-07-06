import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import type { LoadedRuntimeConfig } from "../config/runtime-config.js";
import type { ModelProfile, ResolvedModelRoute } from "../contracts/provider.js";
import type { Runtime, RuntimeOptions } from "../runtime/create-runtime.js";
import type { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import type { Trajectory, TrajectoryEventKind } from "../contracts/trajectory.js";
import {
  assertAllEvidence,
  assertCommandAttempted,
  assertFileInspected,
  assertFinalAnswerContainsRootCause,
  assertFinalAnswerContainsText,
  assertForbiddenPathUntouched,
  assertMetricLessThan,
  assertNoUnrelatedContextInjected,
  assertPatchTouchesExpectedPath,
  assertRuntimeEventKindAbsent,
  assertRuntimeEventKindPresent,
  assertTrajectoryEventKindPresent,
  assertWorkspacePathScoped,
  type BenchmarkEvidenceContext
} from "./evidence-assertions.js";
import {
  listDeterministicOperatorScenarios,
  OPERATOR_SCENARIO_CATEGORIES,
  OPERATOR_SCENARIO_REGISTRY,
  OPERATOR_SUITE_VERSION,
  type OperatorScenarioDefinition
} from "./operator-suite.js";
import { runBenchmarkScenario } from "./scenario-harness.js";

const execFileAsync = promisify(execFile);

describe("EstaCoda Operator Suite", () => {
  it("defines a contract for every registered operator scenario", () => {
    expect(Object.keys(OPERATOR_SCENARIO_REGISTRY).sort()).toEqual([...OPERATOR_SCENARIO_CATEGORIES].sort());
    for (const scenario of listDeterministicOperatorScenarios()) {
      expect(scenario.contract.objective).not.toBe("");
      expect(scenario.contract.fixtureShape).not.toBe("");
      expect(scenario.contract.expectedOutcome).not.toBe("");
      expect(scenario.contract.verifierCommand).not.toBe("");
      expect(scenario.contract.evidenceAssertions.length).toBeGreaterThan(0);
      expect(scenario.contract.metricsWatched.length).toBeGreaterThan(0);
      expect(scenario.contract.knownNonGoals.length).toBeGreaterThan(0);
    }
  });

  it.each(listDeterministicOperatorScenarios().map((scenario) => [scenario.id, scenario] as const))(
    "runs deterministic operator scenario %s",
    async (_id, scenario) => {
      const fixture = scenarioFixture(scenario.fixtureId);
      const instruction = await readFile(join(fixture, "instruction.txt"), "utf8");
      const result = await runBenchmarkScenario({
        fixtureRoot: fixture,
        instruction,
        model: "openai/gpt-test",
        benchmark: {
          name: "operator-suite",
          version: OPERATOR_SUITE_VERSION,
          taskId: scenario.id
        },
        loadConfig: async () => fakeLoadedConfig(),
        createRuntime: async (options) => operatorScenarioRuntime({
          scenario,
          fixture,
          workspace: options.workspaceRoot!,
          db: options.sessionDb
        })
      });

      try {
        await runVerifier(fixture, result.workspace);
        expect(result.summary.execution.status).toBe("success");
        expect(result.summary.artifacts.history).toBe(join(result.outDir, "history.jsonl"));
        expect(result.summary.artifacts.trajectory).toBe(join(result.outDir, "trajectory.jsonl"));
        expect(result.summary.artifacts.trajectorySummary).toBe(join(result.outDir, "trajectory-summary.json"));
        expect(await readFile(join(result.outDir, "history.jsonl"), "utf8")).toContain("\"benchmark-history-record\"");
        expect(await readFile(join(result.outDir, "trajectory-summary.json"), "utf8")).toContain("\"providerIterations\"");
        assertScenarioEvidence(scenario, {
          events: result.events,
          trajectory: result.trajectory,
          metrics: result.summary.metrics,
          finalAnswer: result.summary.finalAnswer
        });
      } finally {
        await result.cleanup();
      }
    }
  );
});

function assertScenarioEvidence(
  scenario: OperatorScenarioDefinition,
  context: BenchmarkEvidenceContext
): void {
  const common = [
    assertRuntimeEventKindPresent(context, "provider-result"),
    assertRuntimeEventKindAbsent(context, "agent-cancelled"),
    assertTrajectoryEventKindPresent(context, "provider-iteration"),
    assertMetricLessThan(context, "toolFailures", 3)
  ];

  switch (scenario.id) {
    case "one-file-bug-diagnosis":
      assertAllEvidence([
        ...common,
        assertFileInspected(context, "src/totals.js"),
        assertFileInspected(context, "test/totals.test.js"),
        assertCommandAttempted(context, "verifier before patch"),
        assertCommandAttempted(context, "verifier after patch"),
        assertPatchTouchesExpectedPath(context, "src/totals.js"),
        assertFinalAnswerContainsRootCause(context, "tax rate was added as a flat amount")
      ]);
      break;
    case "local-provider-base-url-repair":
      assertAllEvidence([
        ...common,
        assertFileInspected(context, "config/local-provider.json"),
        assertFileInspected(context, "scripts/verify-local-provider.js"),
        assertCommandAttempted(context, "verifier before patch"),
        assertCommandAttempted(context, "verifier after patch"),
        assertPatchTouchesExpectedPath(context, "config/local-provider.json"),
        assertFinalAnswerContainsRootCause(context, "base URL was missing the /v1 path")
      ]);
      break;
    case "tool-failure-retry-recovery":
      assertAllEvidence([
        ...common,
        assertCommandAttempted(context, "initial verifier attempt"),
        assertCommandAttempted(context, "verifier after recovery"),
        assertPatchTouchesExpectedPath(context, "recovery.log"),
        assertFinalAnswerContainsRootCause(context, "transient terminal failure"),
        assertRuntimeEventKindPresent(context, "tool-result")
      ]);
      break;
    case "two-workspace-scope-isolation":
      assertAllEvidence([
        ...common,
        assertFileInspected(context, "workspace-a/project.txt"),
        assertCommandAttempted(context, "workspace isolation verifier"),
        assertPatchTouchesExpectedPath(context, "workspace-a/output.txt"),
        assertForbiddenPathUntouched(context, "workspace-b"),
        assertNoUnrelatedContextInjected(context, "FRONTEND_PRIVATE_MARKER"),
        assertWorkspacePathScoped(context, "workspace-a/", "workspace-b/")
      ]);
      break;
    case "architecture-entrypoint-discovery":
      assertAllEvidence([
        ...common,
        assertFileInspected(context, "package.json"),
        assertFileInspected(context, "src/server.js"),
        assertFileInspected(context, "src/router.js"),
        assertFileInspected(context, "src/services/orders.js"),
        assertCommandAttempted(context, "architecture verifier"),
        assertFinalAnswerContainsText(context, "src/server.js is the entry point"),
        assertFinalAnswerContainsText(context, "src/router.js routes requests"),
        assertFinalAnswerContainsText(context, "src/services/orders.js handles order listing")
      ]);
      break;
    default:
      throw new Error(`Unhandled operator scenario: ${scenario.id}`);
  }
}

function scenarioFixture(id: string): string {
  return fileURLToPath(new URL(`../../benchmarks/operator-suite/${id}/`, import.meta.url));
}

async function runVerifier(fixture: string, workspace: string): Promise<void> {
  await execFileAsync("sh", [join(fixture, "verifier.sh"), workspace]);
}

function operatorScenarioRuntime(input: {
  scenario: OperatorScenarioDefinition;
  fixture: string;
  workspace: string;
  db: SQLiteSessionDB;
}): Runtime {
  const sessionId = `operator-${input.scenario.id}-session`;
  const trajectoryId = `operator-${input.scenario.id}-trajectory`;
  return {
    sessionId,
    trajectoryId,
    handle: vi.fn(async (request) => {
      await input.db.createSession({
        id: sessionId,
        profileId: "default",
        title: `Operator scenario ${input.scenario.id}`
      });

      await request.onEvent?.({
        kind: "context-usage",
        filled: 1600,
        total: 4096,
        source: "assembled-prompt"
      });
      await request.onEvent?.({
        kind: "provider-result",
        provider: "openai",
        model: "gpt-test",
        ok: true,
        fallback: false,
        willFallback: false,
        usage: {
          inputTokens: 420,
          outputTokens: 110,
          totalTokens: 530
        }
      });

      const finalAnswer = await runScenarioSteps(input, request);
      await input.db.saveTrajectory(buildTrajectory({
        id: trajectoryId,
        sessionId,
        modelId: "gpt-test",
        scenarioId: input.scenario.id,
        finalAnswer
      }));

      return {
        label: "EstaCoda",
        text: finalAnswer,
        providerExecution: undefined,
        toolExecutions: [],
        progress: []
      } as unknown as Awaited<ReturnType<Runtime["handle"]>>;
    }),
    dispose: vi.fn(async () => {}),
    tools: () => [],
    skills: () => [],
    describe: () => "operator suite deterministic runtime",
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
    sessionDb: input.db
  } as Runtime;
}

async function runScenarioSteps(
  input: {
    scenario: OperatorScenarioDefinition;
    fixture: string;
    workspace: string;
  },
  request: Parameters<Runtime["handle"]>[0]
): Promise<string> {
  switch (input.scenario.id) {
    case "one-file-bug-diagnosis":
      await emitRead(request, input.workspace, "src/totals.js");
      await emitRead(request, input.workspace, "test/totals.test.js");
      await emitVerifier(request, input.fixture, input.workspace, "verifier before patch", false);
      await emitWrite(request, input.workspace, "src/totals.js", fixedTotalsSource());
      await emitVerifier(request, input.fixture, input.workspace, "verifier after patch", true);
      return "The root cause was that the tax rate was added as a flat amount instead of multiplying subtotal by 1 + taxRate. I patched src/totals.js and verified the failing totals test passes.";
    case "local-provider-base-url-repair":
      await emitRead(request, input.workspace, "config/local-provider.json");
      await emitRead(request, input.workspace, "scripts/verify-local-provider.js");
      await emitVerifier(request, input.fixture, input.workspace, "verifier before patch", false);
      await emitWrite(request, input.workspace, "config/local-provider.json", fixedProviderConfig());
      await emitVerifier(request, input.fixture, input.workspace, "verifier after patch", true);
      return "The root cause was that the local provider base URL was missing the /v1 path required by OpenAI-compatible clients. I updated config/local-provider.json and verified the setup.";
    case "tool-failure-retry-recovery":
      await emitRead(request, input.workspace, "scripts/check-state.js");
      await emitFailedCommand(request, "initial verifier attempt");
      await emitWrite(request, input.workspace, "recovery.log", "recovered after injected terminal failure\n");
      await emitVerifier(request, input.fixture, input.workspace, "verifier after recovery", true);
      return "The root cause was a transient terminal failure during the first verification attempt. I recorded recovery.log, retried the verifier, and completed gracefully.";
    case "two-workspace-scope-isolation":
      await emitRead(request, input.workspace, "workspace-a/project.txt");
      await emitWrite(request, input.workspace, "workspace-a/output.txt", "backend service handles orders\n");
      await emitVerifier(request, input.fixture, input.workspace, "workspace isolation verifier", true);
      return "Completed the scoped workspace-a task and wrote workspace-a/output.txt without using unrelated workspace context.";
    case "architecture-entrypoint-discovery":
      await emitRead(request, input.workspace, "package.json");
      await emitRead(request, input.workspace, "src/server.js");
      await emitRead(request, input.workspace, "src/router.js");
      await emitRead(request, input.workspace, "src/services/orders.js");
      await emitVerifier(request, input.fixture, input.workspace, "architecture verifier", true);
      return "src/server.js is the entry point. src/router.js routes requests from handleRequest to route handlers. src/services/orders.js handles order listing for the /orders flow.";
    default:
      throw new Error(`Unhandled operator scenario: ${input.scenario.id}`);
  }
}

async function emitRead(
  request: Parameters<Runtime["handle"]>[0],
  workspace: string,
  targetSummary: string
): Promise<void> {
  await request.onEvent?.({
    kind: "tool-start",
    tool: "file.read",
    targetSummary
  });
  await readFile(join(workspace, targetSummary), "utf8");
  await request.onEvent?.({
    kind: "tool-result",
    tool: "file.read",
    targetSummary,
    ok: true
  });
}

async function emitWrite(
  request: Parameters<Runtime["handle"]>[0],
  workspace: string,
  targetSummary: string,
  content: string
): Promise<void> {
  await request.onEvent?.({
    kind: "tool-start",
    tool: "file.write",
    targetSummary
  });
  await writeFile(join(workspace, targetSummary), content, "utf8");
  await request.onEvent?.({
    kind: "tool-result",
    tool: "file.write",
    targetSummary,
    ok: true
  });
}

async function emitVerifier(
  request: Parameters<Runtime["handle"]>[0],
  fixture: string,
  workspace: string,
  targetSummary: string,
  expectSuccess: boolean
): Promise<void> {
  await request.onEvent?.({
    kind: "tool-start",
    tool: "terminal.run",
    targetSummary
  });
  const run = runVerifier(fixture, workspace);
  if (expectSuccess) {
    await run;
  } else {
    await run.catch(() => undefined);
  }
  await request.onEvent?.({
    kind: "tool-result",
    tool: "terminal.run",
    targetSummary,
    ok: expectSuccess
  });
}

async function emitFailedCommand(
  request: Parameters<Runtime["handle"]>[0],
  targetSummary: string
): Promise<void> {
  await request.onEvent?.({
    kind: "tool-start",
    tool: "terminal.run",
    targetSummary
  });
  await request.onEvent?.({
    kind: "tool-result",
    tool: "terminal.run",
    targetSummary,
    ok: false
  });
}

function buildTrajectory(input: {
  id: string;
  sessionId: string;
  modelId: string;
  scenarioId: string;
  finalAnswer: string;
}): Trajectory {
  const timestamp = "2026-07-06T00:00:00.000Z";
  let index = 0;
  const event = (kind: TrajectoryEventKind, data: Record<string, unknown>) => ({
    id: `${input.id}-${String(++index).padStart(2, "0")}-${kind}`,
    kind,
    timestamp,
    data
  });

  return {
    id: input.id,
    profileId: "default",
    sessionId: input.sessionId,
    modelId: input.modelId,
    events: [
      event("session-start", { scenarioId: input.scenarioId }),
      event("prompt-assembled", { layers: ["repo", "instruction"], scenarioId: input.scenarioId }),
      event("provider-iteration", { iteration: 1, scenarioId: input.scenarioId }),
      event("tool-call", { tool: "terminal.run", targetSummary: "verifier" }),
      event("assistant-output", { text: input.finalAnswer })
    ],
    outcome: {
      success: true,
      summary: input.finalAnswer
    }
  };
}

function fixedTotalsSource(): string {
  return `export function totalWithTax(items, taxRate) {
  const subtotal = items.reduce((sum, item) => sum + item.price, 0);
  return subtotal * (1 + taxRate);
}
`;
}

function fixedProviderConfig(): string {
  return `${JSON.stringify({
    provider: "local-openai",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "dev-coder"
  }, null, 2)}\n`;
}

function fakeLoadedConfig(): LoadedRuntimeConfig {
  const model: ModelProfile = {
    provider: "unconfigured",
    id: "unconfigured",
    contextWindowTokens: 4096,
    supportsTools: true,
    supportsVision: false,
    supportsStructuredOutput: false
  };
  const primaryModelRoute: ResolvedModelRoute = {
    provider: "unconfigured",
    id: "unconfigured",
    profile: model,
    contextWindowTokens: model.contextWindowTokens
  };

  return {
    config: {
      providers: {},
      model: {
        provider: "unconfigured",
        id: "unconfigured"
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
