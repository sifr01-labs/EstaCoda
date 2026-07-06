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
import type { Trajectory } from "../contracts/trajectory.js";
import {
  assertAllEvidence,
  assertCommandAttempted,
  assertFileInspected,
  assertFinalAnswerContainsRootCause,
  assertMetricLessThan,
  assertPatchTouchesExpectedPath,
  assertTrajectoryEventKindAbsent,
  assertTrajectoryEventKindPresent
} from "./evidence-assertions.js";
import { runBenchmarkScenario } from "./scenario-harness.js";

const execFileAsync = promisify(execFile);

describe("trajectory-backed scenario evals", () => {
  it("diagnoses and fixes a broken local provider setup with trajectory artifacts", async () => {
    const fixture = scenarioFixture("local-provider-setup");
    const instruction = await readFile(join(fixture, "instruction.txt"), "utf8");
    const result = await runBenchmarkScenario({
      fixtureRoot: fixture,
      instruction,
      model: "openai/gpt-test",
      benchmark: {
        name: "trajectory-scenario-evals",
        version: "0.1.0",
        taskId: "local-provider-setup"
      },
      loadConfig: async () => fakeLoadedConfig(),
      createRuntime: async (options) => localProviderSetupRuntime({
        fixture,
        workspace: options.workspaceRoot!,
        db: options.sessionDb
      })
    });

    try {
      await expect(runVerifier(fixture, result.workspace)).resolves.toBeUndefined();
      await expect(readFile(join(result.workspace, "config/local-provider.json"), "utf8")).resolves.toContain("http://127.0.0.1:11434/v1");

      expect(result.summary.artifacts.trajectory).toBe(join(result.outDir, "trajectory.jsonl"));
      expect(result.summary.artifacts.trajectorySummary).toBe(join(result.outDir, "trajectory-summary.json"));
      expect(result.trajectory).toBeDefined();
      expect(await readFile(join(result.outDir, "trajectory.jsonl"), "utf8")).not.toMatch(/\u001b\[/u);
      const trajectorySummary = JSON.parse(await readFile(join(result.outDir, "trajectory-summary.json"), "utf8"));
      expect(trajectorySummary).toMatchObject({
        id: "trajectory-local-provider",
        eventCount: result.trajectory!.events.length,
        metrics: {
          providerIterations: 1,
          providerBudgetExhaustions: 1,
          promptAssemblies: 1,
          skillRouteEvents: 1,
          externalMemoryRecallCount: 1,
          memoryWrites: 1,
          memoryPromotions: 1,
          securityEscalations: 1,
          agentCancelled: false
        }
      });
      expect(result.summary.metrics).toMatchObject({
        providerIterations: 1,
        providerBudgetExhaustions: 1,
        promptAssemblies: 1,
        skillRouteEvents: 1,
        sessionRecallTriggered: false,
        externalMemoryRecallCount: 1,
        memoryWrites: 1,
        memoryPromotions: 1,
        securityEscalations: 1,
        agentCancelled: false,
        estimatedCostUsd: null
      });

      assertAllEvidence([
        assertFileInspected(evidenceContext(result), "config/local-provider.json"),
        assertFileInspected(evidenceContext(result), "scripts/verify-local-provider.js"),
        assertCommandAttempted(evidenceContext(result), "verifier before patch"),
        assertCommandAttempted(evidenceContext(result), "verifier after patch"),
        assertPatchTouchesExpectedPath(evidenceContext(result), "config/local-provider.json"),
        assertFinalAnswerContainsRootCause(evidenceContext(result), "base URL was missing the /v1 path"),
        assertMetricLessThan(evidenceContext(result), "toolFailures", 2),
        assertTrajectoryEventKindPresent(evidenceContext(result), "provider-iteration"),
        assertTrajectoryEventKindPresent(evidenceContext(result), "memory-write"),
        assertTrajectoryEventKindAbsent(evidenceContext(result), "agent-cancelled")
      ]);
    } finally {
      await result.cleanup();
    }
  });
});

function evidenceContext(result: Awaited<ReturnType<typeof runBenchmarkScenario>>) {
  return {
    events: result.events,
    trajectory: result.trajectory,
    metrics: result.summary.metrics,
    finalAnswer: result.summary.finalAnswer
  };
}

function scenarioFixture(id: string): string {
  return fileURLToPath(new URL(`../../benchmarks/trajectory-scenario-evals/${id}/`, import.meta.url));
}

async function runVerifier(fixture: string, workspace: string): Promise<void> {
  await execFileAsync("sh", [join(fixture, "verifier.sh"), workspace]);
}

function localProviderSetupRuntime(input: {
  fixture: string;
  workspace: string;
  db: SQLiteSessionDB;
}): Runtime {
  const sessionId = "session-local-provider";
  const trajectoryId = "trajectory-local-provider";
  return {
    sessionId,
    trajectoryId,
    handle: vi.fn(async (request) => {
      await input.db.createSession({
        id: sessionId,
        profileId: "default",
        title: "Local provider setup scenario"
      });

      await request.onEvent?.({
        kind: "provider-result",
        provider: "openai",
        model: "gpt-test",
        ok: true,
        fallback: false,
        willFallback: false,
        usage: {
          inputTokens: 480,
          outputTokens: 140,
          totalTokens: 620
        }
      });
      await emitToolRead(request, input.workspace, "config/local-provider.json");
      await emitToolRead(request, input.workspace, "scripts/verify-local-provider.js");
      await emitVerifier(request, input.fixture, input.workspace, "verifier before patch", false);

      await request.onEvent?.({
        kind: "tool-start",
        tool: "file.write",
        targetSummary: "config/local-provider.json"
      });
      await writeFile(join(input.workspace, "config/local-provider.json"), fixedProviderConfig(), "utf8");
      await request.onEvent?.({
        kind: "tool-result",
        tool: "file.write",
        targetSummary: "config/local-provider.json",
        ok: true
      });
      await emitVerifier(request, input.fixture, input.workspace, "verifier after patch", true);

      await input.db.saveTrajectory(buildTrajectory({
        id: trajectoryId,
        sessionId,
        finalAnswer: "The root cause was that the local OpenAI-compatible base URL was missing the /v1 path. I updated config/local-provider.json with the minimal /v1 fix and verified the setup state passes."
      }));

      return {
        label: "EstaCoda",
        text: "The root cause was that the local OpenAI-compatible base URL was missing the /v1 path. I updated config/local-provider.json with the minimal /v1 fix and verified the setup state passes.",
        providerExecution: undefined,
        toolExecutions: [],
        progress: []
      } as unknown as Awaited<ReturnType<Runtime["handle"]>>;
    }),
    dispose: vi.fn(async () => {}),
    tools: () => [],
    skills: () => [],
    describe: () => "trajectory scenario fake runtime",
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

async function emitToolRead(
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

function buildTrajectory(input: {
  id: string;
  sessionId: string;
  finalAnswer: string;
}): Trajectory {
  const base = "2026-07-06T00:00:00.000Z";
  let index = 0;
  const event = (kind: Trajectory["events"][number]["kind"], data: Record<string, unknown>) => ({
    id: `${input.id}-${String(++index).padStart(2, "0")}-${kind}`,
    kind,
    timestamp: base,
    data
  });

  return {
    id: input.id,
    profileId: "default",
    sessionId: input.sessionId,
    modelId: "gpt-test",
    events: [
      event("session-start", { sessionId: input.sessionId }),
      event("user-input", { text: "diagnose local provider setup" }),
      event("prompt-assembled", { budget: { filled: 1800, total: 4096 } }),
      event("skill-route-telemetry", { selectedSkill: "verify", confidence: 0.6 }),
      event("provider-iteration", { iteration: 1, phase: "initial", ok: true, toolCalls: 5, executedTools: 5, exhausted: false }),
      event("tool-call", { tool: "file.read", targetSummary: "config/local-provider.json" }),
      event("tool-result", { tool: "file.read", targetSummary: "config/local-provider.json", ok: true }),
      event("tool-call", { tool: "file.read", targetSummary: "scripts/verify-local-provider.js" }),
      event("tool-call", { tool: "terminal.run", targetSummary: "verifier before patch" }),
      event("tool-result", { tool: "terminal.run", targetSummary: "verifier before patch", ok: false }),
      event("security-risk-escalated", { from: "read-only-local", to: "workspace-write", reason: "minimal config fix required" }),
      event("external-memory-recall", { enabled: false, attempted: false, resultCount: 0, totalChars: 0, warningCount: 0, failureCount: 0 }),
      event("memory-write", { provider: "local", outcome: "diagnosed local provider setup" }),
      event("memory-promotion", { source: "trajectory", note: "\u001b[31mredacted ansi marker\u001b[0m" }),
      event("tool-call", { tool: "file.write", targetSummary: "config/local-provider.json" }),
      event("tool-result", { tool: "file.write", targetSummary: "config/local-provider.json", ok: true }),
      event("provider-budget-exhausted", { budget: "wall-clock", limit: 1, observed: 2, reason: "synthetic scenario signal" }),
      event("tool-call", { tool: "terminal.run", targetSummary: "verifier after patch" }),
      event("tool-result", { tool: "terminal.run", targetSummary: "verifier after patch", ok: true }),
      event("assistant-output", { text: input.finalAnswer }),
      event("session-end", { outcome: { success: true } })
    ],
    outcome: {
      success: true,
      summary: input.finalAnswer
    }
  };
}

function fixedProviderConfig(): string {
  return `${JSON.stringify({
    provider: "local-openai-compatible",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "qwen2.5-coder"
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
