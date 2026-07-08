import type { EvalCase, EvalResult } from "../../contracts/eval.js";
import type { IntentTaskClass } from "../../contracts/intent.js";
import type { SkillDefinition, SkillRouting } from "../../contracts/skill.js";
import { SkillRegistry } from "../../skills/skill-registry.js";
import { IntentRouter } from "../../runtime/intent-router.js";
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
  expectedTaskClass?: IntentTaskClass;
  taskClass?: IntentTaskClass;
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
  taskClassCorrectness: RateMetric;
  weightedRoutingScore: number | null;
  baselineGates: {
    forbiddenSkillViolationsZero: boolean;
    noSkillCorrectnessMeasured: boolean;
    taskClassCorrectnessMeasured: boolean;
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
    expectedTaskClass: "general",
    taskClass: "general",
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

export function buildLiveRoutingEvalSeedCases(): RoutingEvalSeedCase[] {
  const releaseValidation = evalSkill({
    name: "release-validation",
    routing: {
      triggerPatterns: [{ type: "contains", value: "release route" }],
      priority: 10
    }
  });
  const docsWriting = evalSkill({
    name: "docs-writing",
    routing: {
      triggerPatterns: [{ type: "contains", value: "release route" }],
      priority: 5
    }
  });
  const reviewSkill = evalSkill({
    name: "code-review",
    routing: {
      triggerPatterns: [{ type: "contains", value: "review this release" }],
      priority: 5
    }
  });
  const rejectedReview = evalSkill({
    name: "deployment-review",
    routing: {
      triggerPatterns: [{ type: "contains", value: "review this release" }],
      negativePatterns: [{ type: "contains", value: "review this release" }],
      priority: 10
    }
  });
  const deferredSkill = evalSkill({
    name: "deferred-browser",
    routing: {
      triggerPatterns: [{ type: "contains", value: "deferred browser route" }],
      deferWhen: [{
        when: {
          promptMatches: [{ type: "contains", value: "deferred browser route" }]
        },
        reason: "Browser capability unavailable in routing eval."
      }]
    }
  });

  return [
    liveRoutingCase({
      id: "live-primary-and-supporting",
      prompt: "please use the release route",
      skills: [docsWriting, releaseValidation],
      expectedPrimarySkill: "release-validation",
      expectedSupportingCandidates: ["docs-writing"],
      expectedTaskClass: "general",
      forbiddenSkills: ["deploy-production"]
    }),
    liveRoutingCase({
      id: "live-no-skill-architecture-advice",
      prompt: "what do you think of this architecture plan?",
      skills: [releaseValidation],
      expectedNoSkill: true,
      expectedTaskClass: "architecture-advice",
      forbiddenSkills: ["deploy-production"]
    }),
    liveRoutingCase({
      id: "live-rejected-candidate",
      prompt: "review this release",
      skills: [rejectedReview, reviewSkill],
      expectedPrimarySkill: "code-review",
      expectedTaskClass: "general",
      forbiddenSkills: ["deployment-review"]
    }),
    liveRoutingCase({
      id: "live-deferred-candidate",
      prompt: "deferred browser route",
      skills: [deferredSkill],
      expectedNoSkill: true,
      expectedTaskClass: "general",
      forbiddenSkills: ["deferred-browser"]
    }),
    liveRoutingCase({
      id: "live-release-validation-task-class",
      prompt: "validate this branch before merge",
      skills: [],
      expectedNoSkill: true,
      expectedTaskClass: "release-validation",
      forbiddenSkills: ["deploy-production"]
    })
  ];
}

export function buildDefaultRoutingEvolutionBaselineCases(): RoutingEvalSeedCase[] {
  return [
    ...routingEvolutionSeedCases,
    ...buildLiveRoutingEvalSeedCases()
  ];
}

export function buildRoutingEvolutionBaselineReport(
  cases?: readonly RoutingEvalSeedCase[]
): RoutingEvolutionBaselineReport {
  const routingCases = cases ?? buildDefaultRoutingEvolutionBaselineCases();
  const routing = buildRoutingEvalMetrics(routingCases);
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
  const expectedTaskClassCases = cases.filter((testCase) => testCase.expectedTaskClass !== undefined);
  const correctTaskClassCases = expectedTaskClassCases.filter((testCase) =>
    testCase.taskClass === testCase.expectedTaskClass
  );

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
    taskClassCorrectness: rate(correctTaskClassCases.length, expectedTaskClassCases.length),
    weightedRoutingScore,
    baselineGates: {
      forbiddenSkillViolationsZero: forbiddenViolations.length === 0,
      noSkillCorrectnessMeasured: noSkillCases.length > 0,
      taskClassCorrectnessMeasured: expectedTaskClassCases.length > 0,
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
      assertEqual("routing case count", report.routing.caseCount, buildDefaultRoutingEvolutionBaselineCases().length),
      assertTrue("live router cases are included", report.routing.caseCount > routingEvolutionSeedCases.length),
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
      assertTrue("task-class correctness is reported", report.routing.taskClassCorrectness.status === "measured"),
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

function liveRoutingCase(input: {
  id: string;
  prompt: string;
  skills: SkillDefinition[];
  expectedPrimarySkill?: string;
  expectedNoSkill?: boolean;
  expectedTaskClass: IntentTaskClass;
  expectedSupportingCandidates?: string[];
  forbiddenSkills?: string[];
}): RoutingEvalSeedCase {
  const registry = new SkillRegistry();
  for (const skill of input.skills) {
    registry.register(skill);
  }
  const route = new IntentRouter({ skillRegistry: registry }).route(input.prompt);
  const candidateRoles = new Map((route.candidates ?? []).map((candidate) => [candidate.skill.name, candidate.role]));
  const rejectedCandidates = (route.candidates ?? [])
    .filter((candidate) => candidate.role === "rejected")
    .map((candidate) => ({
      skillName: candidate.skill.name,
      reason: candidate.reason
    }));
  const selectedSkill = route.primarySkill?.name;
  return {
    id: input.id,
    promptHash: input.id,
    expectedPrimarySkill: input.expectedPrimarySkill,
    selectedSkill,
    expectedNoSkill: input.expectedNoSkill,
    noSkillResult: input.expectedNoSkill === true
      ? selectedSkill === undefined ? "correct" : "missed"
      : selectedSkill === undefined ? "missed" : "not-applicable",
    expectedTaskClass: input.expectedTaskClass,
    taskClass: route.taskClass,
    candidatesShown: (route.candidates ?? []).map((candidate) => candidate.skill.name),
    expectedSupportingCandidates: input.expectedSupportingCandidates,
    supportingCandidates: (route.supportingSkills ?? [])
      .map((skill) => skill.name)
      .filter((name) => candidateRoles.get(name) === "supporting"),
    forbiddenSkills: input.forbiddenSkills,
    candidatesRejected: rejectedCandidates.length === 0 ? undefined : rejectedCandidates
  };
}

function evalSkill(input: {
  name: string;
  routing: SkillRouting;
}): SkillDefinition {
  return {
    name: input.name,
    description: `${input.name} routing eval skill.`,
    version: "0.1.0",
    routing: input.routing,
    whenToUse: [],
    requiredToolsets: [],
    playbook: [],
    permissionExpectations: [],
    examples: [],
    evaluations: []
  };
}

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
