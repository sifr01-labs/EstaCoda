import type { EvalCase, EvalResult } from "../../contracts/eval.js";
import { assertEqual, assertTrue, buildResult } from "../eval-runner.js";

export type RateMetric = {
  value: number | null;
  numerator: number;
  denominator: number;
  status: "measured" | "unavailable" | "not-applicable";
};

export type RoutingEvalSeedCase = {
  id: string;
  promptHash: string;
  expectedPrimarySkill?: string;
  selectedSkill?: string;
  expectedNoSkill?: boolean;
  noSkillResult?: "correct" | "missed" | "not-applicable";
  candidatesShown: string[];
  expectedSupportingCandidates?: string[];
  supportingCandidates?: string[];
  forbiddenSkills?: string[];
  candidatesRejected?: Array<{ skillName: string; reason?: string }>;
  searchedReplacementSkill?: string;
  finalSkillUsed?: string;
  correctionSignals?: Array<{ source: "user" | "developer" | "model"; kind: string }>;
  expectedDegraded?: boolean;
  degradedCorrect?: boolean;
};

export type RoutingEvalMetrics = {
  caseCount: number;
  primarySkillPrecision: RateMetric;
  primarySkillRecall: RateMetric;
  falsePositiveRate: RateMetric;
  falsePositiveCount: number;
  missCount: number;
  forbiddenSkillViolations: {
    count: number;
    cases: string[];
  };
  noSkillCorrectness: RateMetric;
  supportingCandidateRecall: RateMetric;
  rejectionCorrectionRate: RateMetric;
  degradationCorrectness: RateMetric;
  weightedRoutingScore: number | null;
  baselineGates: {
    forbiddenSkillViolationsZero: boolean;
    noSkillCorrectnessMeasured: boolean;
    primaryPrecisionWeight: number;
    primaryRecallWeight: number;
    falsePositivesTrackedSeparately: boolean;
  };
};

export type EvolutionBaselineMetrics = {
  manualCorrectionRate: RateMetric;
  userDeveloperRejectionRate: RateMetric;
  proposalApprovalRate: RateMetric;
  proposalRejectionReasonDistribution: Record<string, number>;
  shadowAutoPromotionAcceptanceRate: RateMetric;
  rollbackRate: RateMetric;
  postPromotionRegressionRate: RateMetric;
  humanTakeoverRate: RateMetric;
  agentSelfCorrectionRate: RateMetric;
  routeRejectionFrequencyBySkill: Record<string, number>;
  frequentlySearchedReplacementSkill: Record<string, number>;
};

export type RoutingEvolutionBaselineReport = {
  routing: RoutingEvalMetrics;
  evolution: EvolutionBaselineMetrics;
};

const PRECISION_WEIGHT = 0.7;
const RECALL_WEIGHT = 0.3;

export const routingEvolutionSeedCases: RoutingEvalSeedCase[] = [
  {
    id: "primary-code-edit",
    promptHash: "route001",
    expectedPrimarySkill: "code-change",
    selectedSkill: "code-change",
    candidatesShown: ["code-change", "repo-search"],
    expectedSupportingCandidates: ["repo-search"],
    supportingCandidates: ["repo-search"],
    forbiddenSkills: ["deploy-production"]
  },
  {
    id: "no-skill-general-question",
    promptHash: "route002",
    expectedNoSkill: true,
    noSkillResult: "correct",
    candidatesShown: [],
    forbiddenSkills: ["terminal-command"]
  },
  {
    id: "missed-test-runner",
    promptHash: "route003",
    expectedPrimarySkill: "test-runner",
    candidatesShown: ["repo-search"],
    expectedSupportingCandidates: ["repo-search"],
    supportingCandidates: [],
    forbiddenSkills: ["deploy-production"]
  },
  {
    id: "wrong-primary-corrected",
    promptHash: "route004",
    expectedPrimarySkill: "git-helper",
    selectedSkill: "build-helper",
    candidatesShown: ["build-helper", "git-helper"],
    expectedSupportingCandidates: ["git-helper"],
    supportingCandidates: ["git-helper"],
    forbiddenSkills: ["deploy-production"],
    candidatesRejected: [{ skillName: "build-helper", reason: "developer corrected selected route" }],
    searchedReplacementSkill: "git-helper",
    finalSkillUsed: "git-helper",
    correctionSignals: [{ source: "developer", kind: "rejected" }]
  },
  {
    id: "degraded-provider-unavailable",
    promptHash: "route005",
    expectedPrimarySkill: "browser-automation",
    selectedSkill: "browser-automation",
    candidatesShown: ["browser-automation"],
    expectedDegraded: true,
    degradedCorrect: true,
    forbiddenSkills: ["deploy-production"]
  }
];

export function buildRoutingEvolutionBaselineReport(
  cases: readonly RoutingEvalSeedCase[] = routingEvolutionSeedCases
): RoutingEvolutionBaselineReport {
  const routing = buildRoutingEvalMetrics(cases);
  return {
    routing,
    evolution: buildEmptyEvolutionMetrics()
  };
}

export function buildRoutingEvalMetrics(cases: readonly RoutingEvalSeedCase[]): RoutingEvalMetrics {
  const selectedCases = cases.filter((testCase) => testCase.selectedSkill !== undefined);
  const expectedPrimaryCases = cases.filter((testCase) => testCase.expectedPrimarySkill !== undefined);
  const correctPrimarySelections = expectedPrimaryCases.filter((testCase) =>
    testCase.selectedSkill === testCase.expectedPrimarySkill
  );
  const falsePositiveCases = selectedCases.filter((testCase) =>
    testCase.expectedPrimarySkill === undefined || testCase.selectedSkill !== testCase.expectedPrimarySkill
  );
  const missCases = expectedPrimaryCases.filter((testCase) => testCase.selectedSkill === undefined);
  const forbiddenViolations = cases.filter((testCase) =>
    testCase.selectedSkill !== undefined && (testCase.forbiddenSkills ?? []).includes(testCase.selectedSkill)
  );
  const noSkillCases = cases.filter((testCase) => testCase.expectedNoSkill === true);
  const correctNoSkillCases = noSkillCases.filter((testCase) =>
    testCase.selectedSkill === undefined && testCase.noSkillResult === "correct"
  );
  const expectedSupportingCount = cases.reduce((count, testCase) =>
    count + (testCase.expectedSupportingCandidates?.length ?? 0), 0);
  const matchedSupportingCount = cases.reduce((count, testCase) => {
    const actual = new Set(testCase.supportingCandidates ?? []);
    return count + (testCase.expectedSupportingCandidates ?? []).filter((skill) => actual.has(skill)).length;
  }, 0);
  const rejectedCases = cases.filter((testCase) => (testCase.candidatesRejected?.length ?? 0) > 0);
  const correctedRejectedCases = rejectedCases.filter((testCase) =>
    testCase.finalSkillUsed !== undefined &&
    testCase.finalSkillUsed === (testCase.searchedReplacementSkill ?? testCase.expectedPrimarySkill)
  );
  const degradedCases = cases.filter((testCase) => testCase.expectedDegraded === true);
  const correctDegradedCases = degradedCases.filter((testCase) => testCase.degradedCorrect === true);

  const primarySkillPrecision = rate(correctPrimarySelections.length, selectedCases.length);
  const primarySkillRecall = rate(correctPrimarySelections.length, expectedPrimaryCases.length);
  const weightedRoutingScore = primarySkillPrecision.value === null || primarySkillRecall.value === null
    ? null
    : (primarySkillPrecision.value * PRECISION_WEIGHT) + (primarySkillRecall.value * RECALL_WEIGHT);

  return {
    caseCount: cases.length,
    primarySkillPrecision,
    primarySkillRecall,
    falsePositiveRate: rate(falsePositiveCases.length, selectedCases.length),
    falsePositiveCount: falsePositiveCases.length,
    missCount: missCases.length,
    forbiddenSkillViolations: {
      count: forbiddenViolations.length,
      cases: forbiddenViolations.map((testCase) => testCase.id)
    },
    noSkillCorrectness: rate(correctNoSkillCases.length, noSkillCases.length),
    supportingCandidateRecall: rate(matchedSupportingCount, expectedSupportingCount),
    rejectionCorrectionRate: rate(correctedRejectedCases.length, rejectedCases.length),
    degradationCorrectness: rate(correctDegradedCases.length, degradedCases.length),
    weightedRoutingScore,
    baselineGates: {
      forbiddenSkillViolationsZero: forbiddenViolations.length === 0,
      noSkillCorrectnessMeasured: noSkillCases.length > 0,
      primaryPrecisionWeight: PRECISION_WEIGHT,
      primaryRecallWeight: RECALL_WEIGHT,
      falsePositivesTrackedSeparately: falsePositiveCases.length !== missCases.length ||
        falsePositiveCases.some((testCase) => !missCases.includes(testCase))
    }
  };
}

export function buildEmptyEvolutionMetrics(): EvolutionBaselineMetrics {
  return {
    manualCorrectionRate: unavailableRate(),
    userDeveloperRejectionRate: unavailableRate(),
    proposalApprovalRate: unavailableRate(),
    proposalRejectionReasonDistribution: {},
    shadowAutoPromotionAcceptanceRate: unavailableRate(),
    rollbackRate: unavailableRate(),
    postPromotionRegressionRate: unavailableRate(),
    humanTakeoverRate: unavailableRate(),
    agentSelfCorrectionRate: unavailableRate(),
    routeRejectionFrequencyBySkill: {},
    frequentlySearchedReplacementSkill: {}
  };
}

export const routingEvolutionBaselineCase: EvalCase = {
  id: "routing-evolution-baseline",
  name: "Routing and evolution baseline metrics are deterministic",
  description: "Offline route/evolution fixture metrics establish Phase 1A measurement contracts without behavior changes.",
  tags: ["routing", "evolution", "offline"],
  run: async (): Promise<EvalResult> => {
    const startedAt = Date.now();
    const report = buildRoutingEvolutionBaselineReport();
    const assertions = [
      assertEqual("routing case count", report.routing.caseCount, routingEvolutionSeedCases.length),
      assertTrue("seed includes no-skill cases", routingEvolutionSeedCases.some((testCase) => testCase.expectedNoSkill === true)),
      assertEqual("forbidden-skill violations are zero", report.routing.forbiddenSkillViolations.count, 0),
      assertTrue("no-skill correctness is measured", report.routing.noSkillCorrectness.status === "measured"),
      assertTrue("primary precision is reported", report.routing.primarySkillPrecision.status === "measured"),
      assertTrue("primary recall is reported", report.routing.primarySkillRecall.status === "measured"),
      assertTrue("precision is weighted more heavily than recall", report.routing.baselineGates.primaryPrecisionWeight > report.routing.baselineGates.primaryRecallWeight),
      assertTrue("false positives tracked separately from misses", report.routing.baselineGates.falsePositivesTrackedSeparately),
      assertTrue("supporting-candidate recall is reported", report.routing.supportingCandidateRecall.status === "measured"),
      assertTrue("rejection correction rate is reported", report.routing.rejectionCorrectionRate.status === "measured"),
      assertTrue("degradation correctness is reported", report.routing.degradationCorrectness.status === "measured"),
      assertTrue("evolution manual correction metric shape exists", report.evolution.manualCorrectionRate.status === "unavailable"),
      assertTrue("evolution rejection distribution shape exists", typeof report.evolution.proposalRejectionReasonDistribution === "object"),
      assertTrue("route rejection frequency shape exists", typeof report.evolution.routeRejectionFrequencyBySkill === "object"),
      assertTrue("replacement search frequency shape exists", typeof report.evolution.frequentlySearchedReplacementSkill === "object")
    ];

    return buildResult(
      "routing-evolution-baseline",
      "Routing and evolution baseline metrics are deterministic",
      assertions,
      Date.now() - startedAt
    );
  }
};

function rate(numerator: number, denominator: number): RateMetric {
  if (denominator === 0) {
    return {
      value: null,
      numerator,
      denominator,
      status: "not-applicable"
    };
  }
  return {
    value: numerator / denominator,
    numerator,
    denominator,
    status: "measured"
  };
}

function unavailableRate(): RateMetric {
  return {
    value: null,
    numerator: 0,
    denominator: 0,
    status: "unavailable"
  };
}
