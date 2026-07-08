import { describe, expect, it } from "vitest";
import {
  buildDefaultRoutingEvolutionBaselineCases,
  buildLiveRoutingEvalSeedCases,
  buildRoutingEvalMetrics,
  buildRoutingEvolutionBaselineReport,
  routingEvolutionSeedCases,
  type RoutingEvalSeedCase
} from "./routing-evolution-baseline.js";

describe("routing evolution baseline metrics", () => {
  it("produces deterministic baseline results", () => {
    const first = buildRoutingEvolutionBaselineReport();
    const second = buildRoutingEvolutionBaselineReport();

    expect(first).toEqual(second);
    expect(first.routing.caseCount).toBe(buildDefaultRoutingEvolutionBaselineCases().length);
    expect(first.routing.caseCount).toBeGreaterThan(routingEvolutionSeedCases.length);
  });

  it("seed fixtures include no-skill cases", () => {
    expect(routingEvolutionSeedCases.some((testCase) => testCase.expectedNoSkill === true)).toBe(true);
    expect(buildRoutingEvolutionBaselineReport().routing.noSkillCorrectness.status).toBe("measured");
  });

  it("builds deterministic live router seed cases", () => {
    const first = buildLiveRoutingEvalSeedCases();
    const second = buildLiveRoutingEvalSeedCases();

    expect(first).toEqual(second);
    expect(first).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "live-primary-and-supporting",
        expectedPrimarySkill: "release-validation",
        selectedSkill: "release-validation",
        expectedSupportingCandidates: ["docs-writing"],
        supportingCandidates: ["docs-writing"]
      }),
      expect.objectContaining({
        id: "live-no-skill-architecture-advice",
        expectedNoSkill: true,
        noSkillResult: "correct",
        expectedTaskClass: "architecture-advice",
        taskClass: "architecture-advice"
      }),
      expect.objectContaining({
        id: "live-rejected-candidate",
        candidatesRejected: [{ skillName: "deployment-review", reason: "Negative routing pattern matched." }]
      })
    ]));
  });

  it("reports live router primary, supporting, no-skill, and task-class metrics", () => {
    const metrics = buildRoutingEvalMetrics(buildLiveRoutingEvalSeedCases());

    expect(metrics.primarySkillPrecision).toEqual(expect.objectContaining({
      status: "measured",
      value: 1
    }));
    expect(metrics.primarySkillRecall).toEqual(expect.objectContaining({
      status: "measured",
      value: 1
    }));
    expect(metrics.noSkillCorrectness).toEqual(expect.objectContaining({
      status: "measured",
      value: 1
    }));
    expect(metrics.supportingCandidateRecall).toEqual(expect.objectContaining({
      status: "measured",
      value: 1
    }));
    expect(metrics.taskClassCorrectness).toEqual(expect.objectContaining({
      status: "measured",
      value: 1
    }));
    expect(metrics.forbiddenSkillViolations.count).toBe(0);
  });

  it("counts forbidden-skill violations separately", () => {
    const cases: RoutingEvalSeedCase[] = [
      {
        id: "forbidden-selected",
        promptHash: "bad001",
        expectedPrimarySkill: "safe-skill",
        selectedSkill: "dangerous-skill",
        candidatesShown: ["dangerous-skill"],
        forbiddenSkills: ["dangerous-skill"]
      }
    ];

    const metrics = buildRoutingEvalMetrics(cases);

    expect(metrics.forbiddenSkillViolations).toEqual({
      count: 1,
      cases: ["forbidden-selected"]
    });
    expect(metrics.falsePositiveCount).toBe(1);
  });

  it("tracks false positives separately from misses", () => {
    const cases: RoutingEvalSeedCase[] = [
      {
        id: "wrong-selected",
        promptHash: "fp001",
        expectedPrimarySkill: "expected-skill",
        selectedSkill: "other-skill",
        candidatesShown: ["other-skill"]
      },
      {
        id: "missed-selected",
        promptHash: "miss001",
        expectedPrimarySkill: "missing-skill",
        candidatesShown: []
      }
    ];

    const metrics = buildRoutingEvalMetrics(cases);

    expect(metrics.falsePositiveCount).toBe(1);
    expect(metrics.missCount).toBe(1);
    expect(metrics.falsePositiveRate.status).toBe("measured");
    expect(metrics.primarySkillRecall.status).toBe("measured");
  });

  it("reports primary precision and recall separately with precision weighted higher", () => {
    const metrics = buildRoutingEvolutionBaselineReport().routing;

    expect(metrics.primarySkillPrecision).toEqual(expect.objectContaining({
      status: "measured",
      numerator: expect.any(Number),
      denominator: expect.any(Number)
    }));
    expect(metrics.primarySkillRecall).toEqual(expect.objectContaining({
      status: "measured",
      numerator: expect.any(Number),
      denominator: expect.any(Number)
    }));
    expect(metrics.baselineGates.primaryPrecisionWeight).toBeGreaterThan(metrics.baselineGates.primaryRecallWeight);
  });

  it("reports task-class correctness separately", () => {
    const metrics = buildRoutingEvalMetrics([
      {
        id: "task-class-correct",
        promptHash: "tc001",
        candidatesShown: [],
        expectedTaskClass: "docs-writing",
        taskClass: "docs-writing"
      },
      {
        id: "task-class-wrong",
        promptHash: "tc002",
        candidatesShown: [],
        expectedTaskClass: "code-review",
        taskClass: "general"
      }
    ]);

    expect(metrics.taskClassCorrectness).toEqual({
      status: "measured",
      numerator: 1,
      denominator: 2,
      value: 0.5
    });
  });

  it("keeps evolution metric shape present when baseline data is empty", () => {
    const metrics = buildRoutingEvolutionBaselineReport().evolution;

    expect(metrics.manualCorrectionRate.status).toBe("unavailable");
    expect(metrics.userDeveloperRejectionRate.status).toBe("unavailable");
    expect(metrics.proposalApprovalRate.status).toBe("unavailable");
    expect(metrics.proposalRejectionReasonDistribution).toEqual({});
    expect(metrics.shadowAutoPromotionAcceptanceRate.status).toBe("unavailable");
    expect(metrics.rollbackRate.status).toBe("unavailable");
    expect(metrics.postPromotionRegressionRate.status).toBe("unavailable");
    expect(metrics.humanTakeoverRate.status).toBe("unavailable");
    expect(metrics.agentSelfCorrectionRate.status).toBe("unavailable");
    expect(metrics.routeRejectionFrequencyBySkill).toEqual({});
    expect(metrics.frequentlySearchedReplacementSkill).toEqual({});
  });
});
