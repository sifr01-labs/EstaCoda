import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Trajectory } from "../contracts/trajectory.js";
import { createSQLiteSessionDB } from "../session/session-setup.js";
import { trace } from "./trace-commands.js";

describe("trace commands", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), "estacoda-trace-command-test-"));
  });

  afterEach(() => {
    rmSync(tempHome, { recursive: true, force: true });
  });

  it("summarizes richer skill routing telemetry in timelines", async () => {
    const db = await createSQLiteSessionDB({ homeDir: tempHome });
    await db.createSession({ id: "session-1", profileId: "default" });
    await db.saveTrajectory(routingTrajectory());
    db.close();

    const result = await trace({
      argv: ["trace", "timeline", "trajectory-1"],
      workspaceRoot: tempHome,
      homeDir: tempHome
    }, ["timeline", "trajectory-1"]);

    expect(result).toMatchObject({
      handled: true,
      exitCode: 0
    });
    expect(result.output).toContain("skill-route-usage");
    expect(result.output).toContain("primary-skill selected+invoked task=release-validation confidence=0.82");
    expect(result.output).toContain("skill-route-telemetry");
    expect(result.output).toContain("task=release-validation selected=primary-skill primary=primary-skill");
    expect(result.output).toContain("supporting=supporting-skill");
    expect(result.output).toContain("candidates=candidate-skill");
    expect(result.output).toContain("shown=5");
    expect(result.output).toContain("rejected=rejected-skill(Negative pattern matched.)");
    expect(result.output).toContain("deferred=deferred-skill(Capability unavailable.)");
    expect(result.output).toContain("shadow=candidate-skill:0.66");
    expect(result.output).toContain("outcome=succeeded");
  });
});

function routingTrajectory(): Trajectory {
  return {
    id: "trajectory-1",
    profileId: "default",
    sessionId: "session-1",
    modelId: "test-model",
    events: [
      {
        id: "event-1",
        kind: "skill-route-usage",
        timestamp: "2030-01-01T00:00:00.000Z",
        data: {
          promptHash: "hash-1",
          skillName: "primary-skill",
          nativeIntent: "general",
          taskClass: "release-validation",
          labels: ["release", "validation"],
          selected: true,
          invoked: true,
          deferred: false,
          confidence: 0.82,
          evidenceKinds: ["trigger"]
        }
      },
      {
        id: "event-2",
        kind: "skill-route-telemetry",
        timestamp: "2030-01-01T00:00:01.000Z",
        data: {
          promptHash: "hash-1",
          labels: ["release", "validation"],
          confidence: 0.82,
          routeConfidence: 0.82,
          selectedSkill: "primary-skill",
          finalSkillUsed: "primary-skill",
          explicitInvocation: false,
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
          rejectedCandidates: [{ skillName: "rejected-skill", reason: "Negative pattern matched." }],
          deferredCandidates: [{ skillName: "deferred-skill", reason: "Capability unavailable." }],
          shadowSemanticRoute: {
            mode: "local-semantic-shadow",
            wouldSelectSkill: "candidate-skill",
            confidence: 0.66,
            rationale: "Shadow semantic route would select candidate-skill; deterministic primary is primary-skill.",
            candidates: [{
              skillName: "candidate-skill",
              score: 0.66,
              confidence: 0.66,
              evidenceKinds: ["semantic-shadow"]
            }]
          },
          finalOutcomeStatus: "succeeded",
          candidates: [
            {
              skillName: "primary-skill",
              selected: true,
              explicitInvocation: false,
              confidence: 0.82,
              sourceKind: "bundled",
              role: "primary"
            },
            {
              skillName: "supporting-skill",
              selected: false,
              explicitInvocation: false,
              confidence: 0.67,
              sourceKind: "bundled",
              role: "supporting"
            }
          ]
        }
      }
    ],
    outcome: {
      success: true,
      summary: "completed"
    }
  };
}
