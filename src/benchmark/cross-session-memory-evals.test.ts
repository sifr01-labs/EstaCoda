import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import type { LoadedRuntimeConfig } from "../config/runtime-config.js";
import type { ModelProfile, ResolvedModelRoute } from "../contracts/provider.js";
import type { Trajectory } from "../contracts/trajectory.js";
import type { Runtime } from "../runtime/create-runtime.js";
import type { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import {
  assertAllEvidence,
  assertFinalAnswerContainsText,
  assertMetricLessThan,
  assertRecalledSourceSession,
  assertSessionRecallTriggered,
  assertTrajectoryContainsText,
  assertTrajectoryEventKindPresent,
  assertTrajectoryExcludesText
} from "./evidence-assertions.js";
import { runBenchmarkCrossSessionScenario } from "./scenario-harness.js";

const execFileAsync = promisify(execFile);
const sessionAId = "session-memory-a";
const sessionBId = "session-memory-b";
const trajectoryAId = "trajectory-memory-a";
const trajectoryBId = "trajectory-memory-b";
const projectPreference = "release codename is NORTHSTAR, and status updates must use concise bullet points";

describe("cross-session memory evals", () => {
  it("recalls durable project context from a prior isolated session", async () => {
    const fixture = scenarioFixture("project-preference-recall");
    const sessionAInstruction = await readFile(join(fixture, "session-a.txt"), "utf8");
    const sessionBInstruction = await readFile(join(fixture, "session-b.txt"), "utf8");
    const result = await runBenchmarkCrossSessionScenario({
      fixtureRoot: fixture,
      model: "openai/gpt-test",
      benchmark: {
        name: "cross-session-memory-evals",
        version: "0.1.0"
      },
      loadConfig: async () => fakeLoadedConfig(),
      sessions: [
        {
          id: "session-a",
          instruction: sessionAInstruction,
          taskId: "project-preference-session-a",
          createRuntime: async (options) => memorySeedRuntime(options.sessionDb)
        },
        {
          id: "session-b",
          instruction: sessionBInstruction,
          taskId: "project-preference-session-b",
          createRuntime: async (options) => memoryRecallRuntime({
            fixture,
            workspace: options.workspaceRoot!,
            db: options.sessionDb
          })
        }
      ]
    });

    try {
      expect(result.sessions).toHaveLength(2);
      await expect(runVerifier(fixture, result.workspace)).resolves.toBeUndefined();

      const [sessionA, sessionB] = result.sessions;
      expect(sessionA?.summary.artifacts.trajectory).toBe(join(sessionA!.outDir, "trajectory.jsonl"));
      expect(sessionA?.summary.artifacts.trajectorySummary).toBe(join(sessionA!.outDir, "trajectory-summary.json"));
      expect(sessionB?.summary.artifacts.trajectory).toBe(join(sessionB!.outDir, "trajectory.jsonl"));
      expect(sessionB?.summary.artifacts.trajectorySummary).toBe(join(sessionB!.outDir, "trajectory-summary.json"));
      await expect(readFile(join(sessionA!.outDir, "trajectory.jsonl"), "utf8")).resolves.toContain("memory-write");
      await expect(readFile(join(sessionB!.outDir, "trajectory.jsonl"), "utf8")).resolves.toContain("session-recall-decision");

      const summaryA = JSON.parse(await readFile(join(sessionA!.outDir, "trajectory-summary.json"), "utf8"));
      const summaryB = JSON.parse(await readFile(join(sessionB!.outDir, "trajectory-summary.json"), "utf8"));
      expect(summaryA).toMatchObject({
        eventKinds: {
          "memory-write": 1,
          "memory-promotion": 1
        },
        metrics: {
          memoryWrites: 1,
          memoryPromotions: 1
        }
      });
      expect(summaryB).toMatchObject({
        eventKinds: {
          "session-recall-decision": 1,
          "external-memory-recall": 1
        },
        recall: {
          sourceSessionIds: [sessionAId],
          warningCount: 0
        },
        metrics: {
          sessionRecallTriggered: true,
          sessionRecallCount: 1,
          sessionRecallWarningCount: 0,
          externalMemoryRecallCount: 1
        }
      });
      expect(JSON.stringify(summaryB.recall)).toContain("NORTHSTAR");

      expect(result.aggregateMetrics).toMatchObject({
        sessionRecallTriggered: true,
        sessionRecallCount: 1,
        sessionRecallWarningCount: 0,
        externalMemoryRecallCount: 1,
        memoryWrites: 1,
        memoryPromotions: 1,
        estimatedCostUsd: null
      });

      assertAllEvidence([
        assertTrajectoryEventKindPresent(evidenceContext(sessionA!), "memory-write"),
        assertTrajectoryEventKindPresent(evidenceContext(sessionA!), "memory-promotion"),
        assertSessionRecallTriggered(evidenceContext(sessionB!)),
        assertRecalledSourceSession(evidenceContext(sessionB!), sessionAId),
        assertTrajectoryContainsText(evidenceContext(sessionB!), "NORTHSTAR"),
        assertFinalAnswerContainsText(evidenceContext(sessionB!), "NORTHSTAR"),
        assertTrajectoryExcludesText(evidenceContext(sessionB!), "LEGACY"),
        assertMetricLessThan(evidenceContext(sessionB!), "toolFailures", 1)
      ]);
    } finally {
      await result.cleanup();
    }
  });
});

function evidenceContext(result: Awaited<ReturnType<typeof runBenchmarkCrossSessionScenario>>["sessions"][number]) {
  return {
    events: result.events,
    trajectory: result.trajectory,
    metrics: result.summary.metrics,
    finalAnswer: result.summary.finalAnswer
  };
}

function scenarioFixture(id: string): string {
  return fileURLToPath(new URL(`../../benchmarks/cross-session-memory-evals/${id}/`, import.meta.url));
}

async function runVerifier(fixture: string, workspace: string): Promise<void> {
  await execFileAsync("sh", [join(fixture, "verifier.sh"), workspace]);
}

function memorySeedRuntime(db: SQLiteSessionDB): Runtime {
  return fakeRuntime({
    sessionId: sessionAId,
    trajectoryId: trajectoryAId,
    handle: async (request) => {
      await db.createSession({
        id: sessionAId,
        profileId: "default",
        title: "Memory seed session"
      });
      await request.onEvent?.({
        kind: "provider-result",
        provider: "openai",
        model: "gpt-test",
        ok: true,
        fallback: false,
        willFallback: false,
        usage: {
          inputTokens: 220,
          outputTokens: 80,
          totalTokens: 300
        }
      });
      const finalAnswer = "Stored the project preference: NORTHSTAR status updates should use concise bullet points.";
      await db.saveTrajectory(buildTrajectory({
        id: trajectoryAId,
        sessionId: sessionAId,
        events: [
          event(trajectoryAId, "session-start", { sessionId: sessionAId }),
          event(trajectoryAId, "user-input", { text: "remember project preference" }),
          event(trajectoryAId, "prompt-assembled", { budget: { filled: 1200, total: 4096 } }),
          event(trajectoryAId, "provider-iteration", { iteration: 1, phase: "initial", ok: true, toolCalls: 0, executedTools: 0, exhausted: false }),
          event(trajectoryAId, "memory-write", {
            scope: "project",
            content: projectPreference,
            sourceSessionId: sessionAId
          }),
          event(trajectoryAId, "memory-promotion", {
            type: "project-fact",
            content: projectPreference,
            sourceSessionId: sessionAId
          }),
          event(trajectoryAId, "assistant-output", { text: finalAnswer }),
          event(trajectoryAId, "session-end", { outcome: { success: true } })
        ],
        finalAnswer
      }));
      return runtimeResponse(finalAnswer);
    },
    db
  });
}

function memoryRecallRuntime(input: {
  fixture: string;
  workspace: string;
  db: SQLiteSessionDB;
}): Runtime {
  return fakeRuntime({
    sessionId: sessionBId,
    trajectoryId: trajectoryBId,
    handle: async (request) => {
      await input.db.createSession({
        id: sessionBId,
        profileId: "default",
        title: "Memory recall session"
      });
      const priorTrajectory = await input.db.loadTrajectory(trajectoryAId);
      const recalledContext = extractProjectPreference(priorTrajectory);
      await request.onEvent?.({
        kind: "session-recall-decision",
        triggered: recalledContext.includes("NORTHSTAR"),
        reason: "prior project preference matched continuation request",
        sourceSessionIds: recalledContext.includes("NORTHSTAR") ? [sessionAId] : []
      });
      await request.onEvent?.({
        kind: "provider-result",
        provider: "openai",
        model: "gpt-test",
        ok: true,
        fallback: false,
        willFallback: false,
        usage: {
          inputTokens: 340,
          outputTokens: 120,
          totalTokens: 460
        }
      });

      const finalAnswer = "Using the recalled NORTHSTAR project preference:\n- Codename: NORTHSTAR\n- Format: concise bullet points\n- Next step: keep the status update brief.";
      await mkdir(join(input.workspace, "reports"), { recursive: true });
      await writeFile(join(input.workspace, "reports/status.md"), `${finalAnswer}\n`, "utf8");
      await input.db.saveTrajectory(buildTrajectory({
        id: trajectoryBId,
        sessionId: sessionBId,
        events: [
          event(trajectoryBId, "session-start", { sessionId: sessionBId }),
          event(trajectoryBId, "user-input", { text: "continue using prior project context" }),
          event(trajectoryBId, "prompt-assembled", { budget: { filled: 1500, total: 4096 } }),
          event(trajectoryBId, "session-recall-decision", {
            triggered: recalledContext.includes("NORTHSTAR"),
            reason: "prior project preference matched continuation request",
            query: "prior project context and status preference",
            sourceSessionIds: recalledContext.includes("NORTHSTAR") ? [sessionAId] : [],
            warningCount: 0,
            recalledContext
          }),
          event(trajectoryBId, "external-memory-recall", {
            providerIds: ["isolated-scenario-memory"],
            enabled: true,
            attempted: true,
            resultCount: recalledContext.includes("NORTHSTAR") ? 1 : 0,
            totalChars: recalledContext.length,
            workspaceScoped: true,
            warningCount: 0,
            failureCount: 0,
            recalledContent: recalledContext
          }),
          event(trajectoryBId, "provider-iteration", { iteration: 1, phase: "initial", ok: true, toolCalls: 0, executedTools: 0, exhausted: false }),
          event(trajectoryBId, "assistant-output", { text: finalAnswer }),
          event(trajectoryBId, "session-end", { outcome: { success: true } })
        ],
        finalAnswer
      }));
      return runtimeResponse(finalAnswer);
    },
    db: input.db
  });
}

function fakeRuntime(input: {
  sessionId: string;
  trajectoryId: string;
  handle: Runtime["handle"];
  db: SQLiteSessionDB;
}): Runtime {
  return {
    sessionId: input.sessionId,
    trajectoryId: input.trajectoryId,
    handle: vi.fn(input.handle),
    dispose: vi.fn(async () => {}),
    tools: () => [],
    skills: () => [],
    describe: () => "cross-session memory scenario fake runtime",
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

function runtimeResponse(text: string): Awaited<ReturnType<Runtime["handle"]>> {
  return {
    label: "EstaCoda",
    text,
    providerExecution: undefined,
    toolExecutions: [],
    progress: []
  } as unknown as Awaited<ReturnType<Runtime["handle"]>>;
}

function buildTrajectory(input: {
  id: string;
  sessionId: string;
  events: Trajectory["events"];
  finalAnswer: string;
}): Trajectory {
  return {
    id: input.id,
    profileId: "default",
    sessionId: input.sessionId,
    modelId: "gpt-test",
    events: input.events,
    outcome: {
      success: true,
      summary: input.finalAnswer
    }
  };
}

function event(
  trajectoryId: string,
  kind: Trajectory["events"][number]["kind"],
  data: Record<string, unknown>
): Trajectory["events"][number] {
  const index = String(nextEventIndex++).padStart(2, "0");
  return {
    id: `${trajectoryId}-${index}-${kind}`,
    kind,
    timestamp: "2026-07-06T00:00:00.000Z",
    data
  };
}

let nextEventIndex = 0;

function extractProjectPreference(trajectory: Trajectory | undefined): string {
  const memoryEvent = trajectory?.events.find((item) => item.kind === "memory-write");
  const content = memoryEvent?.data.content;
  return typeof content === "string" ? content : "LEGACY fallback context";
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
