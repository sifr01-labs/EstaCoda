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
  expectedShadowSemanticSkill?: string;
  expectedShadowSemanticCandidates?: string[];
  shadowSemanticSkill?: string;
  shadowSemanticCandidates?: string[];
  semanticImprovesRecall?: boolean;
  expectedShadowNoSelection?: boolean;
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
  shadowSemanticCorrectness: RateMetric;
  shadowSemanticCandidateRecall: RateMetric;
  shadowSemanticRecallImprovementRate: RateMetric;
  shadowSemanticFalsePositiveRate: RateMetric;
  shadowSemanticDisagreements: {
    count: number;
    cases: string[];
  };
  shadowSemanticForbiddenViolations: {
    count: number;
    cases: string[];
  };
  rejectionCorrectionRate: RateMetric;
  degradationCorrectness: RateMetric;
  taskClassCorrectness: RateMetric;
  weightedRoutingScore: number | null;
  noSkillFalsePositiveRate: RateMetric;
  baselineGates: {
    forbiddenSkillViolationsZero: boolean;
    shadowSemanticForbiddenViolationsZero: boolean;
    noSkillCorrectnessMeasured: boolean;
    noSkillFalsePositiveRateMeasured: boolean;
    taskClassCorrectnessMeasured: boolean;
    primaryPrecisionWeight: number;
    primaryRecallWeight: number;
    falsePositivesTrackedSeparately: boolean;
    primaryPrecisionMeetsThreshold: boolean;
    noSkillFalsePositiveRateMeetsThreshold: boolean;
    shadowSemanticFalsePositiveRateMeetsThreshold: boolean;
    shadowSemanticDisagreementsMeasured: boolean;
    shadowSemanticRecallImprovementMeasured: boolean;
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
const MIN_PRIMARY_PRECISION = 0.8;
const MAX_NO_SKILL_FALSE_POSITIVE_RATE = 0.25;
const MAX_SHADOW_SEMANTIC_FALSE_POSITIVE_RATE = 0;

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
  const deterministicReleaseRoute = evalSkill({
    name: "deterministic-release-route",
    description: "Run release route checks from explicit routing metadata.",
    routing: {
      triggerPatterns: [{ type: "contains", value: "release route" }],
      priority: 20
    },
    whenToUse: ["Use when the user explicitly asks for the release route."]
  });
  const semanticReleaseNotes = evalSkill({
    name: "semantic-release-notes",
    description: "Draft release notes and changelog summaries for launches.",
    routing: {
      priority: 1
    },
    whenToUse: ["Use for release notes, changelog drafting, and launch summaries."]
  });
  const semanticTestRunner = evalSkill({
    name: "semantic-test-runner",
    description: "Run tests and report test failures for repository validation.",
    routing: {},
    whenToUse: ["Use when the user asks to run tests, execute vitest, or validate test failures."]
  });
  const semanticBlockedReleaseNotes = evalSkill({
    name: "blocked-release-notes",
    description: "Draft release notes and changelog summaries.",
    routing: {
      negativePatterns: [{ type: "contains", value: "release notes" }]
    },
    whenToUse: ["Use for release notes and changelog drafting."]
  });
  const semanticFallbackReleaseNotes = evalSkill({
    name: "fallback-release-notes",
    description: "Prepare release notes and changelog summaries.",
    routing: {},
    whenToUse: ["Use for release notes and changelog summaries."]
  });
  const semanticDeferredReleaseNotes = evalSkill({
    name: "deferred-release-notes",
    description: "Prepare release notes and changelog summaries.",
    routing: {
      deferWhen: [{
        when: {
          promptMatches: [{ type: "contains", value: "release notes" }]
        },
        reason: "Release note drafting is unavailable in this eval."
      }]
    },
    whenToUse: ["Use for release notes and changelog summaries."]
  });
  const weakMetadataSkill = evalSkill({
    name: "generic-helper",
    description: "General helper.",
    routing: {},
    whenToUse: []
  });
  const semanticArchitectureSkill = evalSkill({
    name: "architecture-review",
    description: "Review architecture plans, system design tradeoffs, and component boundaries.",
    routing: {},
    whenToUse: ["Use for architecture review, design critique, and system boundary analysis."]
  });
  const semanticDocsSkill = evalSkill({
    name: "docs-writing-shadow",
    description: "Write architecture docs, README updates, and user-facing documentation.",
    routing: {},
    whenToUse: ["Use for architecture docs, documentation writing, README edits, and docs cleanup."]
  });
  const semanticChangelogSkill = evalSkill({
    name: "changelog-shadow",
    description: "Prepare changelog notes and release summaries.",
    routing: {},
    whenToUse: ["Use for changelog entries, release notes, and launch summaries."]
  });
  const arabicReleaseNotes = evalSkill({
    name: "arabic-release-notes",
    description: "كتابة ملاحظات الإصدار وملخصات التغييرات.",
    routing: {},
    whenToUse: ["استخدم عند طلب ملاحظات الإصدار أو ملخص التغييرات."]
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
    }),
    liveRoutingCase({
      id: "live-semantic-deterministic-disagreement",
      prompt: "please use the release route, then draft changelog release notes",
      skills: [deterministicReleaseRoute, semanticReleaseNotes],
      expectedPrimarySkill: "deterministic-release-route",
      expectedShadowSemanticSkill: "semantic-release-notes",
      expectedShadowSemanticCandidates: ["semantic-release-notes", "deterministic-release-route"],
      expectedTaskClass: "docs-writing",
      forbiddenSkills: ["deploy-production"]
    }),
    liveRoutingCase({
      id: "live-semantic-recall-improvement",
      prompt: "run the failing tests and summarize test failures",
      skills: [semanticTestRunner],
      expectedShadowSemanticSkill: "semantic-test-runner",
      semanticImprovesRecall: true,
      expectedTaskClass: "general",
      forbiddenSkills: ["deploy-production"]
    }),
    liveRoutingCase({
      id: "live-semantic-preserves-negative-pattern",
      prompt: "please draft release notes for the changelog",
      skills: [semanticBlockedReleaseNotes, semanticFallbackReleaseNotes],
      expectedShadowSemanticSkill: "fallback-release-notes",
      expectedTaskClass: "docs-writing",
      forbiddenSkills: ["blocked-release-notes"]
    }),
    liveRoutingCase({
      id: "live-semantic-preserves-defer-rule",
      prompt: "please draft release notes for the changelog",
      skills: [semanticDeferredReleaseNotes, semanticFallbackReleaseNotes],
      expectedShadowSemanticSkill: "fallback-release-notes",
      expectedTaskClass: "docs-writing",
      forbiddenSkills: ["deferred-release-notes"]
    }),
    liveRoutingCase({
      id: "live-semantic-weak-metadata-no-selection",
      prompt: "summarize the migration plan",
      skills: [weakMetadataSkill],
      expectedNoSkill: true,
      expectedShadowNoSelection: true,
      expectedTaskClass: "general",
      forbiddenSkills: ["generic-helper"]
    }),
    liveRoutingCase({
      id: "live-semantic-no-skill-overselect-guard",
      prompt: "what does release mean in music?",
      skills: [semanticChangelogSkill],
      expectedNoSkill: true,
      expectedShadowNoSelection: true,
      expectedTaskClass: "general",
      forbiddenSkills: ["changelog-shadow"]
    }),
    liveRoutingCase({
      id: "live-semantic-ambiguous-multiple-plausible",
      prompt: "review the architecture docs and system design boundaries",
      skills: [semanticArchitectureSkill, semanticDocsSkill],
      expectedShadowSemanticCandidates: ["architecture-review", "docs-writing-shadow"],
      expectedTaskClass: "architecture-advice",
      forbiddenSkills: ["deploy-production"]
    }),
    liveRoutingCase({
      id: "live-semantic-arabic-release-notes",
      prompt: "اكتب ملاحظات الإصدار وملخص التغييرات",
      skills: [arabicReleaseNotes],
      expectedShadowSemanticSkill: "arabic-release-notes",
      semanticImprovesRecall: true,
      expectedTaskClass: "general",
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
  const expectedShadowSemanticCases = cases.filter((testCase) =>
    testCase.expectedShadowSemanticSkill !== undefined || testCase.expectedShadowNoSelection === true
  );
  const correctShadowSemanticCases = expectedShadowSemanticCases.filter((testCase) =>
    testCase.expectedShadowNoSelection === true
      ? testCase.shadowSemanticSkill === undefined
      : testCase.shadowSemanticSkill === testCase.expectedShadowSemanticSkill
  );
  const expectedShadowSemanticCandidateCount = cases.reduce((count, testCase) =>
    count + (testCase.expectedShadowSemanticCandidates?.length ?? 0), 0);
  const matchedShadowSemanticCandidateCount = cases.reduce((count, testCase) => {
    const actual = new Set(testCase.shadowSemanticCandidates ?? []);
    return count + (testCase.expectedShadowSemanticCandidates ?? []).filter((skill) => actual.has(skill)).length;
  }, 0);
  const semanticRecallImprovementCases = cases.filter((testCase) => testCase.semanticImprovesRecall === true);
  const correctSemanticRecallImprovementCases = semanticRecallImprovementCases.filter((testCase) =>
    testCase.selectedSkill === undefined &&
    testCase.expectedShadowSemanticSkill !== undefined &&
    testCase.shadowSemanticSkill === testCase.expectedShadowSemanticSkill
  );
  const shadowSemanticFalsePositiveCases = noSkillCases.filter((testCase) =>
    testCase.shadowSemanticSkill !== undefined
  );
  const shadowSemanticForbiddenViolations = cases.filter((testCase) =>
    testCase.shadowSemanticSkill !== undefined && (testCase.forbiddenSkills ?? []).includes(testCase.shadowSemanticSkill)
  );
  const shadowSemanticDisagreementCases = cases.filter((testCase) =>
    testCase.selectedSkill !== undefined &&
    testCase.shadowSemanticSkill !== undefined &&
    testCase.selectedSkill !== testCase.shadowSemanticSkill
  );
  const noSkillFalsePositiveCases = noSkillCases.filter((testCase) => testCase.selectedSkill !== undefined);

  const primarySkillPrecision = rate(correctPrimarySelections.length, selectedCases.length);
  const primarySkillRecall = rate(correctPrimarySelections.length, expectedPrimaryCases.length);
  const noSkillFalsePositiveRate = rate(noSkillFalsePositiveCases.length, noSkillCases.length);
  const shadowSemanticFalsePositiveRate = rate(shadowSemanticFalsePositiveCases.length, noSkillCases.length);
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
    shadowSemanticCorrectness: rate(correctShadowSemanticCases.length, expectedShadowSemanticCases.length),
    shadowSemanticCandidateRecall: rate(matchedShadowSemanticCandidateCount, expectedShadowSemanticCandidateCount),
    shadowSemanticRecallImprovementRate: rate(
      correctSemanticRecallImprovementCases.length,
      semanticRecallImprovementCases.length
    ),
    shadowSemanticFalsePositiveRate,
    shadowSemanticDisagreements: {
      count: shadowSemanticDisagreementCases.length,
      cases: shadowSemanticDisagreementCases.map((testCase) => testCase.id)
    },
    shadowSemanticForbiddenViolations: {
      count: shadowSemanticForbiddenViolations.length,
      cases: shadowSemanticForbiddenViolations.map((testCase) => testCase.id)
    },
    rejectionCorrectionRate: rate(correctedRejectedCases.length, rejectedCases.length),
    degradationCorrectness: rate(correctDegradedCases.length, degradedCases.length),
    taskClassCorrectness: rate(correctTaskClassCases.length, expectedTaskClassCases.length),
    weightedRoutingScore,
    noSkillFalsePositiveRate,
    baselineGates: {
      forbiddenSkillViolationsZero: forbiddenViolations.length === 0,
      shadowSemanticForbiddenViolationsZero: shadowSemanticForbiddenViolations.length === 0,
      noSkillCorrectnessMeasured: noSkillCases.length > 0,
      noSkillFalsePositiveRateMeasured: noSkillCases.length > 0,
      taskClassCorrectnessMeasured: expectedTaskClassCases.length > 0,
      primaryPrecisionWeight: PRECISION_WEIGHT,
      primaryRecallWeight: RECALL_WEIGHT,
      falsePositivesTrackedSeparately: falsePositiveCases.length !== missCases.length ||
        falsePositiveCases.some((testCase) => !missCases.includes(testCase)),
      primaryPrecisionMeetsThreshold: primarySkillPrecision.value !== null &&
        primarySkillPrecision.value >= MIN_PRIMARY_PRECISION,
      noSkillFalsePositiveRateMeetsThreshold: noSkillFalsePositiveRate.value !== null &&
        noSkillFalsePositiveRate.value <= MAX_NO_SKILL_FALSE_POSITIVE_RATE,
      shadowSemanticFalsePositiveRateMeetsThreshold: shadowSemanticFalsePositiveRate.value !== null &&
        shadowSemanticFalsePositiveRate.value <= MAX_SHADOW_SEMANTIC_FALSE_POSITIVE_RATE,
      shadowSemanticDisagreementsMeasured: shadowSemanticDisagreementCases.length > 0,
      shadowSemanticRecallImprovementMeasured: semanticRecallImprovementCases.length > 0
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
      assertEqual("shadow semantic forbidden-skill violations are zero", report.routing.shadowSemanticForbiddenViolations.count, 0),
      assertTrue("no-skill correctness is measured", report.routing.noSkillCorrectness.status === "measured"),
      assertTrue("no-skill false-positive rate is measured", report.routing.noSkillFalsePositiveRate.status === "measured"),
      assertTrue("primary precision is reported", report.routing.primarySkillPrecision.status === "measured"),
      assertTrue("primary recall is reported", report.routing.primarySkillRecall.status === "measured"),
      assertTrue("precision is weighted more heavily than recall", report.routing.baselineGates.primaryPrecisionWeight > report.routing.baselineGates.primaryRecallWeight),
      assertTrue("false positives tracked separately from misses", report.routing.baselineGates.falsePositivesTrackedSeparately),
      assertTrue("supporting-candidate recall is reported", report.routing.supportingCandidateRecall.status === "measured"),
      assertTrue("shadow semantic correctness is reported", report.routing.shadowSemanticCorrectness.status === "measured"),
      assertTrue("shadow semantic candidate recall is reported", report.routing.shadowSemanticCandidateRecall.status === "measured"),
      assertTrue("shadow semantic recall improvement is reported", report.routing.shadowSemanticRecallImprovementRate.status === "measured"),
      assertTrue("shadow semantic false-positive rate is reported", report.routing.shadowSemanticFalsePositiveRate.status === "measured"),
      assertTrue("shadow semantic disagreements are measured", report.routing.baselineGates.shadowSemanticDisagreementsMeasured),
      assertTrue("shadow semantic recall improvements are measured", report.routing.baselineGates.shadowSemanticRecallImprovementMeasured),
      assertTrue("primary precision meets threshold", report.routing.baselineGates.primaryPrecisionMeetsThreshold),
      assertTrue("no-skill false-positive rate meets threshold", report.routing.baselineGates.noSkillFalsePositiveRateMeetsThreshold),
      assertTrue("shadow semantic false-positive rate meets threshold", report.routing.baselineGates.shadowSemanticFalsePositiveRateMeetsThreshold),
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
  expectedShadowSemanticSkill?: string;
  expectedShadowSemanticCandidates?: string[];
  expectedShadowNoSelection?: boolean;
  semanticImprovesRecall?: boolean;
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
    .filter((candidate) => candidate.role === "rejected" || candidate.role === "deferred")
    .map((candidate) => ({
      skillName: candidate.skill.name,
      reason: candidate.reason
    }));
  const selectedSkill = route.primarySkill?.name;
  const shadowSemanticSkill = route.shadowSemanticRoute?.wouldSelectSkill?.name;
  const shadowSemanticCandidates = route.shadowSemanticRoute?.candidates.map((candidate) => candidate.skill.name);
  return {
    id: input.id,
    promptHash: input.id,
    expectedPrimarySkill: input.expectedPrimarySkill,
    selectedSkill,
    expectedShadowSemanticSkill: input.expectedShadowSemanticSkill,
    expectedShadowSemanticCandidates: input.expectedShadowSemanticCandidates,
    shadowSemanticSkill,
    shadowSemanticCandidates,
    semanticImprovesRecall: input.semanticImprovesRecall,
    expectedShadowNoSelection: input.expectedShadowNoSelection,
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
  description?: string;
  whenToUse?: string[];
}): SkillDefinition {
  return {
    name: input.name,
    description: input.description ?? `${input.name} routing eval skill.`,
    version: "0.1.0",
    routing: input.routing,
    whenToUse: input.whenToUse ?? [],
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
