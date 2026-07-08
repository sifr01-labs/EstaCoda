import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { IntentRoute, SkillRouteCandidate } from "../contracts/intent.js";
import type { MemoryProvider, SkillOutcome } from "../contracts/memory.js";
import type { RuntimeEvent } from "../contracts/runtime-event.js";
import type { SkillDefinition } from "../contracts/skill.js";
import type { ToolDefinition } from "../contracts/tool.js";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import { SkillEvolutionStore } from "../skills/skill-evolution.js";
import { TrajectoryRecorder } from "../trajectory/trajectory-recorder.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import { RunRecorder } from "./run-recorder.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "estacoda-run-recorder-"));
  tempDirs.push(dir);
  return dir;
}

describe("RunRecorder", () => {
  it("records legacy-compatible skill-route telemetry without storing raw prompt text", async () => {
    const db = new SQLiteSessionDB({ path: join(makeTempDir(), "sessions.sqlite") });

    try {
      const session = await db.createSession({ id: "session-1", profileId: "default" });
      const trajectoryRecorder = new TrajectoryRecorder({
        profileId: "default",
        sessionId: session.id,
        modelId: "test-model",
        id: () => "trajectory-1"
      });
      const runRecorder = new RunRecorder({
        sessionDb: db,
        sessionId: session.id,
        trajectoryRecorder,
        trajectoryStore: db,
        profileId: "default"
      });
      const alpha = skill("alpha-skill");
      const prompt = "route this secret prompt to alpha";

      await runRecorder.recordRouteUsage({
        intent: route([alpha]),
        selectedSkill: alpha,
        channel: "cli",
        userText: prompt
      });

      const events = await db.listEvents(session.id);
      const telemetry = events.find((event) => event.kind === "skill-route-telemetry");
      expect(telemetry).toMatchObject({
        kind: "skill-route-telemetry",
        telemetry: {
          labels: ["general"],
          confidence: 0.7,
          routeConfidence: 0.7,
          selectedSkill: "alpha-skill",
          finalSkillUsed: "alpha-skill",
          explicitInvocation: false,
          candidatesShown: ["alpha-skill"],
          candidates: [expect.objectContaining({
            skillName: "alpha-skill",
            selected: true,
            confidence: 0.7,
            promptHash: expect.any(String)
          })]
        }
      });
      expect(telemetry?.kind === "skill-route-telemetry" ? telemetry.telemetry.promptHash : undefined)
        .toMatch(/^[0-9a-f]{16}$/u);
      expect(JSON.stringify(events)).not.toContain(prompt);

      await db.appendEvent(session.id, {
        kind: "skill-route-telemetry",
        telemetry: {
          promptHash: "legacy-route",
          labels: [],
          confidence: 0.5,
          selectedSkill: "legacy-skill",
          explicitInvocation: false,
          candidates: []
        }
      });
      await expect(db.listEvents(session.id)).resolves.toContainEqual({
        kind: "skill-route-telemetry",
        telemetry: {
          promptHash: "legacy-route",
          labels: [],
          confidence: 0.5,
          selectedSkill: "legacy-skill",
          explicitInvocation: false,
          candidates: []
        }
      });
    } finally {
      db.close();
    }
  });

  it("records optional route correction, search, final skill, and no-skill fields without advisory tools", async () => {
    const db = new SQLiteSessionDB({ path: join(makeTempDir(), "sessions.sqlite") });

    try {
      const session = await db.createSession({ id: "session-1", profileId: "default" });
      const trajectoryRecorder = new TrajectoryRecorder({
        profileId: "default",
        sessionId: session.id,
        modelId: "test-model",
        id: () => "trajectory-1"
      });
      const emitted: RuntimeEvent[] = [];
      const runRecorder = new RunRecorder({
        sessionDb: db,
        sessionId: session.id,
        trajectoryRecorder,
        trajectoryStore: db,
        profileId: "default"
      });
      const alpha = skill("alpha-skill");
      const beta = skill("beta-skill");

      await runRecorder.recordRouteUsage({
        intent: route([alpha, beta]),
        selectedSkill: alpha,
        channel: "cli",
        userText: "route to alpha then correct to beta",
        routeDetails: {
          taskClass: "code.change",
          candidatesRejected: [{ skillName: "alpha-skill", reason: "too broad" }],
          searchedReplacementSkill: "beta-skill",
          finalSkillUsed: "beta-skill",
          correctionSignals: [{
            source: "model",
            kind: "self-corrected",
            skillName: "alpha-skill",
            replacementSkillName: "beta-skill",
            reason: "candidate fit improved"
          }],
          modelSelfCorrectionSignal: "selected beta after rejecting alpha",
          finalOutcomeStatus: "succeeded"
        },
        onEvent: (event) => {
          emitted.push(event);
        }
      });
      await runRecorder.recordRouteUsage({
        intent: route([]),
        selectedSkill: undefined,
        channel: "cli",
        userText: "general prompt without a skill",
        routeDetails: {
          noSkillResult: "correct",
          finalOutcomeStatus: "succeeded"
        }
      });

      const events = await db.listEvents(session.id);
      expect(events).toContainEqual(expect.objectContaining({
        kind: "skill-route-telemetry",
        telemetry: expect.objectContaining({
          selectedSkill: "alpha-skill",
          finalSkillUsed: "beta-skill",
          taskClass: "code.change",
          candidatesShown: ["alpha-skill", "beta-skill"],
          candidatesRejected: [{ skillName: "alpha-skill", reason: "too broad" }],
          searchedReplacementSkill: "beta-skill",
          correctionSignals: [expect.objectContaining({
            source: "model",
            kind: "self-corrected",
            replacementSkillName: "beta-skill"
          })],
          modelSelfCorrectionSignal: "selected beta after rejecting alpha",
          finalOutcomeStatus: "succeeded"
        })
      }));
      const noSkillTelemetry = events.find((event) =>
        event.kind === "skill-route-telemetry" && event.telemetry.noSkillResult === "correct"
      );
      expect(noSkillTelemetry).toMatchObject({
        kind: "skill-route-telemetry",
        telemetry: {
          candidatesShown: [],
          noSkillResult: "correct",
          finalOutcomeStatus: "succeeded"
        }
      });
      expect(noSkillTelemetry?.kind === "skill-route-telemetry" ? noSkillTelemetry.telemetry : {})
        .not.toHaveProperty("selectedSkill");
      expect(noSkillTelemetry?.kind === "skill-route-telemetry" ? noSkillTelemetry.telemetry : {})
        .not.toHaveProperty("finalSkillUsed");
      expect(emitted).toContainEqual(expect.objectContaining({
        kind: "skill-route-telemetry",
        selectedSkill: "alpha-skill",
        finalSkillUsed: "beta-skill",
        candidatesShown: ["alpha-skill", "beta-skill"],
        finalOutcomeStatus: "succeeded",
        details: expect.objectContaining({
          searchedReplacementSkill: "beta-skill"
        })
      }));
    } finally {
      db.close();
    }
  });

  it("records governed route role telemetry without changing legacy candidates", async () => {
    const db = new SQLiteSessionDB({ path: join(makeTempDir(), "sessions.sqlite") });

    try {
      const session = await db.createSession({ id: "session-1", profileId: "default" });
      const trajectoryRecorder = new TrajectoryRecorder({
        profileId: "default",
        sessionId: session.id,
        modelId: "test-model",
        id: () => "trajectory-1"
      });
      const emitted: RuntimeEvent[] = [];
      const runRecorder = new RunRecorder({
        sessionDb: db,
        sessionId: session.id,
        trajectoryRecorder,
        trajectoryStore: db,
        profileId: "default"
      });
      const primary = skill("primary-skill");
      const supporting = skill("supporting-skill");
      const plainCandidate = skill("candidate-skill");
      const rejected = skill("rejected-skill");
      const deferred = skill("deferred-skill");

      await runRecorder.recordRouteUsage({
        intent: governedRoute({
          primary,
          supporting: [supporting],
          candidates: [plainCandidate],
          rejected: [{ skill: rejected, reason: "Negative pattern matched." }],
          deferred: [{ skill: deferred, reason: "Capability unavailable." }]
        }),
        selectedSkill: primary,
        channel: "cli",
        userText: "route to a governed skill",
        onEvent: (event) => {
          emitted.push(event);
        }
      });

      const events = await db.listEvents(session.id);
      expect(events).toContainEqual(expect.objectContaining({
        kind: "skill-route-usage",
        taskClass: "release-validation"
      }));
      expect(events).toContainEqual(expect.objectContaining({
        kind: "skill-route-telemetry",
        telemetry: expect.objectContaining({
          taskClass: "release-validation",
          primarySkill: "primary-skill",
          supportingSkills: ["supporting-skill"],
          candidateSkills: ["candidate-skill"],
          candidatesShown: [
            "primary-skill",
            "supporting-skill",
            "candidate-skill",
            "rejected-skill",
            "deferred-skill"
          ],
          candidatesRejected: [{ skillName: "rejected-skill", reason: "Negative pattern matched." }],
          rejectedCandidates: [{ skillName: "rejected-skill", reason: "Negative pattern matched." }],
          deferredCandidates: [{ skillName: "deferred-skill", reason: "Capability unavailable." }],
          candidates: [
            expect.objectContaining({ skillName: "primary-skill", selected: true }),
            expect.objectContaining({ skillName: "supporting-skill", selected: false })
          ]
        })
      }));
      expect(emitted).toContainEqual(expect.objectContaining({
        kind: "skill-route-telemetry",
        taskClass: "release-validation",
        primarySkill: "primary-skill",
        supportingSkills: ["supporting-skill"],
        candidateSkills: ["candidate-skill"],
        rejectedCandidates: [{ skillName: "rejected-skill", reason: "Negative pattern matched." }],
        deferredCandidates: [{ skillName: "deferred-skill", reason: "Capability unavailable." }],
        candidates: [
          expect.objectContaining({ skillName: "primary-skill", role: "primary" }),
          expect.objectContaining({ skillName: "supporting-skill", role: "supporting" })
        ],
        details: expect.objectContaining({
          candidatesShown: [
            "primary-skill",
            "supporting-skill",
            "candidate-skill",
            "rejected-skill",
            "deferred-skill"
          ]
        })
      }));
    } finally {
      db.close();
    }
  });

  it("records skill outcomes without writing them to prompt memory", async () => {
    const root = makeTempDir();
    const db = new SQLiteSessionDB({ path: join(root, "sessions.sqlite") });

    try {
      const session = await db.createSession({ id: "session-1", profileId: "default" });
      const trajectoryRecorder = new TrajectoryRecorder({
        profileId: "default",
        sessionId: session.id,
        modelId: "test-model",
        id: () => "trajectory-1"
      });
      const memoryWrites: SkillOutcome[] = [];
      const memoryProvider = fakeMemoryProvider(memoryWrites);
      const skillEvolutionStore = new SkillEvolutionStore({
        usagePath: join(root, "skills", ".usage.json"),
        evolutionRoot: join(root, "skills", ".evolution")
      });
      const runRecorder = new RunRecorder({
        sessionDb: db,
        sessionId: session.id,
        trajectoryRecorder,
        trajectoryStore: db,
        profileId: "default",
        memoryProvider,
        skillEvolutionStore
      });
      const selectedSkill = skill("alpha-skill");

      const outcomes = await runRecorder.recordSkillOutcomes({
        selectedSkill,
        userText: "<think>private routing note</think>Run the alpha checks",
        toolExecutions: [execution("file.read")],
        toolPlans: []
      });

      expect(outcomes).toHaveLength(1);
      expect(outcomes[0]).toEqual(expect.objectContaining({
        skill: "alpha-skill",
        status: "succeeded",
        tools: ["file.read"]
      }));
      expect(outcomes[0]?.memoryTargets).toBeUndefined();
      expect(memoryWrites).toEqual([]);

      const events = await db.listEvents(session.id);
      expect(events.some((event) => event.kind === "memory-write")).toBe(false);
      const observations = await skillEvolutionStore.listObservations({ skillName: "alpha-skill" });
      expect(observations).toHaveLength(1);
      expect(observations[0]).toEqual(expect.objectContaining({
        skillName: "alpha-skill",
        type: "success",
        promptSummary: "Run the alpha checks",
        toolsAttempted: ["file.read"]
      }));
    } finally {
      db.close();
    }
  });

  it("persists the trajectory before saving a classified failure", async () => {
    const db = new SQLiteSessionDB({ path: join(makeTempDir(), "sessions.sqlite") });

    try {
      const session = await db.createSession({ id: "session-1", profileId: "default" });
      let idCounter = 0;
      const trajectoryRecorder = new TrajectoryRecorder({
        profileId: "default",
        sessionId: session.id,
        modelId: "test-model",
        id: () => `id-${++idCounter}`
      });
      trajectoryRecorder.record("user-input", { text: "please fetch a page" });

      const runRecorder = new RunRecorder({
        sessionDb: db,
        sessionId: session.id,
        trajectoryRecorder,
        trajectoryStore: db,
        profileId: "default"
      });

      await expect(runRecorder.recordClassifiedFailure({
        kind: "generic",
        error: new Error("fetch failed"),
        message: "fetch failed"
      }, "tool-execution")).resolves.toBeUndefined();

      const failures = await db.listFailuresForSession(session.id);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({
        sessionId: session.id,
        trajectoryId: trajectoryRecorder.trajectoryId,
        class: "unknown",
        message: "fetch failed"
      });

      const trajectory = await db.loadTrajectory(trajectoryRecorder.trajectoryId);
      expect(trajectory).toMatchObject({
        id: trajectoryRecorder.trajectoryId,
        sessionId: session.id,
        profileId: "default",
        modelId: "test-model"
      });
      expect(trajectory?.events.map((event) => event.kind)).toContain("user-input");
    } finally {
      db.close();
    }
  });

  it("persists structured tool-history diagnostics as count-only events", async () => {
    const db = new SQLiteSessionDB({ path: join(makeTempDir(), "sessions.sqlite") });

    try {
      const session = await db.createSession({ id: "session-1", profileId: "default" });
      const trajectoryRecorder = new TrajectoryRecorder({
        profileId: "default",
        sessionId: session.id,
        modelId: "test-model",
        id: () => "trajectory-1"
      });
      const runRecorder = new RunRecorder({
        sessionDb: db,
        sessionId: session.id,
        trajectoryRecorder,
        trajectoryStore: db,
        profileId: "default"
      });

      await runRecorder.recordStructuredToolHistoryDiagnostic({
        kind: "structured-tool-history-selected",
        provider: "test-provider",
        model: "test-model",
        routeRole: "primary",
        nativePairs: 1.8,
        droppedOrphans: -3,
        injectedStubs: 0,
        mergedUsers: 1,
        echoMessages: 1,
        preservedEchoMessages: 1,
        placeholderEchoMessages: 2,
        strippedEchoMessages: 3,
        historicalNativeReplay: true,
        historicalToolResultsLabeled: 2.9,
        mutableStateToolResultsLabeled: Number.POSITIVE_INFINITY,
        reason: "missing_echo",
        rawArgs: "sk-secret",
        toolResult: "private result",
        echoValue: "private provider reasoning"
      } as never);
      await runRecorder.recordStructuredToolHistoryDiagnostic({
        kind: "structured-tool-history-repaired",
        provider: "test-provider",
        preservedEchoMessages: -1,
        placeholderEchoMessages: Number.NaN,
        strippedEchoMessages: "3",
        historicalNativeReplay: false
      } as never);

      const events = await db.listEvents(session.id);
      expect(events).toContainEqual({
        kind: "structured-tool-history-selected",
        provider: "test-provider",
        model: "test-model",
        routeRole: "primary",
        nativePairs: 1,
        droppedOrphans: 0,
        injectedStubs: 0,
        mergedUsers: 1,
        echoMessages: 1,
        preservedEchoMessages: 1,
        placeholderEchoMessages: 2,
        strippedEchoMessages: 3,
        historicalNativeReplay: true,
        historicalToolResultsLabeled: 2,
        mutableStateToolResultsLabeled: 0,
        reason: "missing_echo"
      });
      expect(events).toContainEqual({
        kind: "structured-tool-history-repaired",
        provider: "test-provider"
      });
      const serialized = JSON.stringify(events);
      expect(serialized).not.toContain("sk-secret");
      expect(serialized).not.toContain("private result");
      expect(serialized).not.toContain("private provider reasoning");
    } finally {
      db.close();
    }
  });
});

function skill(name: string): SkillDefinition {
  return {
    name,
    description: `${name} description`,
    version: "1.0.0",
    whenToUse: [],
    requiredToolsets: [],
    playbook: [],
    permissionExpectations: [],
    examples: [],
    evaluations: [],
    routing: {
      labels: ["general"]
    }
  };
}

function route(suggestedSkills: SkillDefinition[]): IntentRoute {
  return {
    nativeIntent: "general",
    labels: ["general"],
    confidence: 0.7,
    suggestedToolsets: [],
    suggestedSkills,
    confirmationRequired: false,
    evidence: [{
      kind: "native-intent",
      detail: "No narrow native intent matched.",
      weight: 0.35
    }],
    rationale: "test route"
  };
}

function governedRoute(input: {
  primary: SkillDefinition;
  supporting: SkillDefinition[];
  candidates: SkillDefinition[];
  rejected: Array<{ skill: SkillDefinition; reason: string }>;
  deferred: Array<{ skill: SkillDefinition; reason: string }>;
}): IntentRoute {
  const selected = [input.primary, ...input.supporting];
  const routeCandidates: SkillRouteCandidate[] = [
    routeCandidate(input.primary, "primary"),
    ...input.supporting.map((entry) => routeCandidate(entry, "supporting")),
    ...input.candidates.map((entry) => routeCandidate(entry, "candidate")),
    ...input.rejected.map((entry) => routeCandidate(entry.skill, "rejected", entry.reason)),
    ...input.deferred.map((entry) => routeCandidate(entry.skill, "deferred", entry.reason))
  ];

  return {
    ...route(selected),
    taskClass: "release-validation",
    primarySkill: input.primary,
    supportingSkills: input.supporting,
    candidates: routeCandidates,
    rejectedCandidates: routeCandidates.filter((candidate) =>
      candidate.role === "rejected" || candidate.role === "deferred"
    )
  };
}

function routeCandidate(
  skillDefinition: SkillDefinition,
  role: SkillRouteCandidate["role"],
  reason?: string
): SkillRouteCandidate {
  return {
    skill: skillDefinition,
    role,
    score: role === "candidate" ? 0.6 : role === "rejected" || role === "deferred" ? 0 : 0.8,
    confidence: role === "candidate" ? 0.6 : role === "rejected" || role === "deferred" ? 0 : 0.8,
    evidence: [{
      kind: role === "rejected"
        ? "skill-negative-pattern"
        : role === "deferred"
          ? "skill-defer-rule"
          : "skill-trigger-pattern",
      source: skillDefinition.name,
      detail: reason ?? `Matched ${skillDefinition.name}.`,
      weight: role === "candidate" ? 0.6 : 0.8
    }],
    reason
  };
}

function execution(name: string): ToolExecutionRecord {
  return {
    tool: {
      name,
      description: name,
      inputSchema: {},
      riskClass: "read-only-local",
      toolsets: ["files"],
      progressLabel: name,
      maxResultSizeChars: 1_000
    } satisfies ToolDefinition,
    decision: "allow",
    riskClass: "read-only-local",
    result: {
      ok: true,
      content: "ok"
    }
  };
}

function fakeMemoryProvider(writes: SkillOutcome[]): MemoryProvider {
  return {
    id: "memory",
    context: () => ({ text: "", usage: [] }),
    search: () => [],
    conclude: () => undefined,
    recordSkillOutcome: (outcome) => {
      writes.push(outcome);
    }
  };
}
