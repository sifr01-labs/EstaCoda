import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { IntentRoute } from "../contracts/intent.js";
import type { RuntimeEvent } from "../contracts/runtime-event.js";
import type { SkillDefinition } from "../contracts/skill.js";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import { TrajectoryRecorder } from "../trajectory/trajectory-recorder.js";
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
        reason: "missing_echo",
        rawArgs: "sk-secret",
        toolResult: "private result",
        echoValue: "private provider reasoning"
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
        reason: "missing_echo"
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
