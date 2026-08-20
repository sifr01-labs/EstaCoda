import type { ExecutionPlan, ExecutionPlanBlockerKind } from "../contracts/execution-plan.js";
import type { ProviderUsageEntry } from "../contracts/provider-usage.js";
import type {
  AuthenticationEvidenceAssessmentEvent,
  SessionEvent,
} from "../contracts/session.js";
import { providerUsageTotals } from "../providers/provider-usage-ledger.js";

export const SLOW_PROVIDER_CALL_MS = 10_000;
export const MAX_REPEATED_OBSERVATION_GROUPS = 5;

export type SessionExecutionDiagnosis = {
  readonly sessionId: string;
  readonly provider: {
    readonly calls: number;
    readonly totalTokens: number;
    readonly usageComplete: boolean;
    readonly estimatedCostUsd: number;
    readonly costComplete: boolean;
    readonly timedCalls: number;
    readonly slowCalls: number;
    readonly slowestCallMs?: number;
  };
  readonly tools: {
    readonly calls: number;
    readonly results: number;
    readonly failedResults: number;
  };
  readonly observations: {
    readonly repeatedCalls: number;
    readonly repeatedGroups: ReadonlyArray<{ readonly tool: string; readonly calls: number }>;
    readonly blocked: number;
  };
  readonly mission: {
    readonly activationObserved: boolean;
    readonly progressTransitions: number;
    readonly status: ExecutionPlan["status"] | "not observed";
    readonly items: Readonly<Record<ExecutionPlan["items"][number]["status"], number>>;
  };
  readonly evidence: {
    readonly mutations: number;
    readonly verifications: number;
  };
  readonly finalCause: string;
  readonly authentication: {
    readonly submissionObserved: "yes" | "no";
    readonly challenge: "departed" | "still present" | "unknown";
    readonly documentTransitionOccurred: "yes" | "no" | "unknown";
    readonly causalEvidence: "verified" | "inconclusive" | "invalidated" | "unknown";
    readonly sensitiveState: "released" | "remained active" | "unknown";
    readonly providerSeam: "no" | "unknown";
  };
};

const READ_ONLY_RISK_CLASSES = new Set(["read-only-local", "read-only-network"]);
const MUTATION_RISK_CLASSES = new Set([
  "workspace-write",
  "external-side-effect",
  "destructive-local",
  "shared-state-mutation",
  "spend-money",
  "sandbox-escape",
]);
const SAFE_TOOL_NAME = /^[a-z0-9][a-z0-9._:-]{0,63}$/iu;

export function diagnoseSessionExecution(input: {
  readonly sessionId: string;
  readonly events: readonly SessionEvent[];
  readonly providerUsage: readonly ProviderUsageEntry[];
}): SessionExecutionDiagnosis {
  const usage = providerUsageTotals(input.providerUsage);
  const observationCalls = new Map<string, number>();
  const plans: Array<{ kind: string; plan: ExecutionPlan }> = [];
  const authenticationAssessments: AuthenticationEvidenceAssessmentEvent[] = [];
  let toolCalls = 0;
  let toolResults = 0;
  let failedToolResults = 0;
  let blockedObservations = 0;
  let mutationEvidence = 0;
  let verificationEvidence = 0;
  let timedProviderCalls = 0;
  let slowProviderCalls = 0;
  let slowestProviderCallMs: number | undefined;

  for (const event of input.events) {
    if (event.kind === "tool-called") {
      toolCalls += 1;
      continue;
    }
    if (event.kind === "tool-result") {
      toolResults += 1;
      if (event.result?.ok !== true) failedToolResults += 1;
      continue;
    }
    if (event.kind === "execution-evidence-recorded") {
      if (event.executionEffect?.kind === "read" || event.executionEffect?.kind === "verification" || (
        event.executionEffect === undefined &&
        event.riskClass !== undefined &&
        READ_ONLY_RISK_CLASSES.has(event.riskClass)
      )) {
        const tool = safeToolName(event.tool);
        observationCalls.set(tool, (observationCalls.get(tool) ?? 0) + 1);
        if (event.status === "blocked") blockedObservations += 1;
        if (
          event.status === "success" &&
          (event.executionEffect === undefined || (
            event.executionEffect.kind === "verification" && event.verifiedMutation !== undefined
          ))
        ) verificationEvidence += 1;
      } else if (
        event.status === "success" &&
        (event.executionEffect?.kind === "mutation" || (
          event.executionEffect === undefined &&
          event.riskClass !== undefined &&
          MUTATION_RISK_CLASSES.has(event.riskClass)
        ))
      ) {
        mutationEvidence += 1;
      }
      continue;
    }
    if (isExecutionPlanLifecycleEvent(event)) {
      plans.push({ kind: event.kind, plan: event.plan });
      continue;
    }
    if (isAuthenticationAssessment(event)) {
      authenticationAssessments.push(event);
      continue;
    }
    if (event.kind === "provider-completion" || event.kind === "provider-continuation") {
      for (const attempt of event.attempts) {
        const durationMs = attempt.streamDiagnostics?.durationMs;
        if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) continue;
        timedProviderCalls += 1;
        slowestProviderCallMs = Math.max(slowestProviderCallMs ?? 0, durationMs);
        if (durationMs >= SLOW_PROVIDER_CALL_MS) slowProviderCalls += 1;
      }
    }
  }

  const repeatedGroups = [...observationCalls.entries()]
    .filter(([, calls]) => calls > 1)
    .sort(([leftTool, leftCalls], [rightTool, rightCalls]) =>
      rightCalls - leftCalls || leftTool.localeCompare(rightTool)
    )
    .slice(0, MAX_REPEATED_OBSERVATION_GROUPS)
    .map(([tool, calls]) => ({ tool, calls }));
  const repeatedCalls = [...observationCalls.values()]
    .reduce((total, calls) => total + Math.max(0, calls - 1), 0);
  const latestPlan = plans.at(-1)?.plan;
  const latestAuthentication = authenticationAssessments.at(-1);

  return {
    sessionId: input.sessionId,
    provider: {
      calls: usage.providerCalls,
      totalTokens: usage.totalTokens,
      usageComplete: usage.usageComplete,
      estimatedCostUsd: usage.estimatedCostUsd,
      costComplete: usage.usageComplete && usage.pricingComplete,
      timedCalls: timedProviderCalls,
      slowCalls: slowProviderCalls,
      ...(slowestProviderCallMs === undefined ? {} : { slowestCallMs: slowestProviderCallMs }),
    },
    tools: {
      calls: toolCalls,
      results: toolResults,
      failedResults: failedToolResults,
    },
    observations: {
      repeatedCalls,
      repeatedGroups,
      blocked: blockedObservations,
    },
    mission: {
      activationObserved: plans.some((event) => event.kind === "execution-plan-started"),
      progressTransitions: plans.filter((event) => event.kind !== "execution-plan-started").length,
      status: latestPlan?.status ?? "not observed",
      items: itemStatusCounts(latestPlan),
    },
    evidence: {
      mutations: mutationEvidence,
      verifications: verificationEvidence,
    },
    finalCause: finalCause(input.events, plans),
    authentication: authenticationDiagnosis(latestAuthentication),
  };
}

function authenticationDiagnosis(
  assessment: AuthenticationEvidenceAssessmentEvent | undefined
): SessionExecutionDiagnosis["authentication"] {
  if (assessment === undefined) {
    return {
      submissionObserved: "no",
      challenge: "unknown",
      documentTransitionOccurred: "unknown",
      causalEvidence: "unknown",
      sensitiveState: "unknown",
      providerSeam: "unknown",
    };
  }

  return {
    submissionObserved: "yes",
    challenge: assessment.challengeDeparted
      ? "departed"
      : assessment.reason === "challenge-still-present"
        ? "still present"
        : "unknown",
    documentTransitionOccurred: assessment.stateTransitionObserved ? "yes" : "no",
    causalEvidence: assessment.outcome === "verified"
      ? "verified"
      : assessment.outcome === "invalidated"
        ? "invalidated"
        : "inconclusive",
    sensitiveState: assessment.sensitiveInputActive ? "remained active" : "released",
    providerSeam: atomicProtectedSubmissionProven(assessment) ? "no" : "unknown",
  };
}

function itemStatusCounts(plan: ExecutionPlan | undefined): SessionExecutionDiagnosis["mission"]["items"] {
  const counts = {
    pending: 0,
    in_progress: 0,
    completed: 0,
    blocked: 0,
    cancelled: 0,
  };
  for (const item of plan?.items ?? []) counts[item.status] += 1;
  return counts;
}

function finalCause(
  events: readonly SessionEvent[],
  plans: ReadonlyArray<{ readonly kind: string; readonly plan: ExecutionPlan }>
): string {
  const latestPlan = plans.at(-1)?.plan;
  if (latestPlan !== undefined) {
    if (latestPlan.status === "blocked") {
      const blockerKinds = [...new Set(latestPlan.items
        .map((item) => item.blocker?.kind)
        .filter((kind): kind is ExecutionPlanBlockerKind => kind !== undefined))]
        .sort();
      return blockerKinds.length === 0
        ? "Plan blocked"
        : `Plan blocked (${blockerKinds.map(formatBlockerKind).join(", ")})`;
    }
    if (latestPlan.status !== "active") return `Plan ${latestPlan.status}`;
  }

  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.kind === "provider-budget-exhausted") return "Provider budget exhausted";
    if (event.kind === "provider-completion" || event.kind === "provider-continuation") {
      return event.ok ? "Provider turn completed" : "Provider execution failed";
    }
  }
  return latestPlan === undefined ? "Unknown" : "Plan active";
}

/**
 * Some assessment reasons can be emitted before the receipt proves that a
 * submit happened. Keep the seam unknown for those ambiguous settlements.
 */
function atomicProtectedSubmissionProven(assessment: AuthenticationEvidenceAssessmentEvent): boolean {
  if (assessment.reason === "protected-settlement-inconclusive" || assessment.reason === "challenge-still-present") {
    return false;
  }
  if (assessment.reason !== "authentication-error") return true;
  return assessment.evidenceToolCallId !== undefined &&
    assessment.evidenceToolCallId !== assessment.submissionToolCallId;
}

function formatBlockerKind(kind: ExecutionPlanBlockerKind): string {
  return kind.replaceAll("_", " ");
}

function safeToolName(value: unknown): string {
  return typeof value === "string" && SAFE_TOOL_NAME.test(value) ? value : "[redacted]";
}

function isExecutionPlanLifecycleEvent(
  event: SessionEvent
): event is Extract<SessionEvent, { kind: `execution-plan-${string}` }> {
  const lifecycleKind = event.kind === "execution-plan-started" ||
    event.kind === "execution-plan-updated" ||
    event.kind === "execution-plan-completed" ||
    event.kind === "execution-plan-blocked" ||
    event.kind === "execution-plan-transferred" ||
    event.kind === "execution-plan-abandoned";
  if (!lifecycleKind) return false;
  const plan = event.plan;
  return plan !== null && typeof plan === "object" &&
    ["active", "completed", "blocked", "transferred", "abandoned"].includes(plan.status) &&
    Array.isArray(plan.items) && plan.items.every((item) =>
      item !== null && typeof item === "object" &&
      ["pending", "in_progress", "completed", "blocked", "cancelled"].includes(item.status)
    );
}

function isAuthenticationAssessment(
  event: SessionEvent
): event is AuthenticationEvidenceAssessmentEvent {
  if (event.kind !== "authentication-evidence-assessed") return false;
  return typeof event.submissionToolCallId === "string" && event.submissionToolCallId.length > 0 &&
    ["credentials", "challenge", "verification"].includes(event.stage) &&
    typeof event.challengeDeparted === "boolean" &&
    typeof event.stateTransitionObserved === "boolean" &&
    typeof event.postSubmitEvidence === "boolean" &&
    typeof event.preexistingEvidence === "boolean" &&
    typeof event.navigationInterrupted === "boolean" &&
    typeof event.sensitiveInputActive === "boolean" &&
    ["candidate", "verified", "blocked", "invalidated", "inconclusive"].includes(event.outcome) &&
    [
      "authenticated-evidence-observed",
      "authentication-error",
      "causal-chain-interrupted",
      "challenge-departed-without-authenticated-evidence",
      "challenge-still-present",
      "preexisting-authenticated-evidence",
      "protected-settlement-inconclusive",
      "protected-submission-failed",
      "signed-out",
    ].includes(event.reason);
}
