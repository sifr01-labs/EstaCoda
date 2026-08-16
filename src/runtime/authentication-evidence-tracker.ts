import type { BrowserSnapshot, BrowserStateIdentity } from "../contracts/browser.js";
import type { AuthenticationEvidenceAssessmentEvent } from "../contracts/session.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import {
  deriveAuthenticationExecutionEffects,
  snapshotReportsAuthenticationError,
  type AuthenticationExecutionEffectReceipt,
  type AuthenticationExecutionStage,
} from "./authentication-execution-effects.js";

const PROTECTED_AUTHENTICATION_TOOLS = new Set([
  "browser.fill_protected_form",
  "browser.type",
]);
const BROWSER_OBSERVATION_TOOLS = new Set([
  "browser.console",
  "browser.extract",
  "browser.find",
  "browser.get_images",
  "browser.screenshot",
  "browser.snapshot",
  "browser.status",
  "browser.tabs",
]);
const AUTHENTICATED_TEXT_SIGNALS: Array<[string, RegExp]> = [
  ["account-home", /\b(?:account|customer|member|user)\s+(?:dashboard|home|overview)\b|(?:الصفحة الرئيسية للحساب|لوحة تحكم الحساب)/iu],
  ["profile", /\b(?:account|my|user)\s+profile\b|\b(?:account|profile) settings\b|(?:ملفي الشخصي|الملف الشخصي|إعدادات الحساب)/iu],
  ["signed-in", /\b(?:signed|logged)\s+in\s+as\b|(?:تم تسجيل الدخول باسم|مسجل الدخول باسم)/iu],
  ["sign-out", /\b(?:log|sign)[ -]?out\b|\blogout\b|(?:تسجيل الخروج|خروج من الحساب)/iu],
];
const SIGNED_OUT_PAGE_TERMS = /\b(?:log|sign)[ -]?in\b|(?:تسجيل الدخول|سجّل الدخول|سجل الدخول)/iu;
const PASSWORD_FIELD_TERMS = /\bpassword\b|(?:كلمة المرور)/iu;
const MAX_REMEMBERED_SNAPSHOTS = 64;

type ProtectedDeliveryReceipt = {
  submission: "not-requested" | "clicked" | "automatic" | "failed";
  documentChanged: boolean;
  challengeState: "departed" | "still-present" | "unknown";
  conditionMet: boolean;
  beforeIdentity: BrowserStateIdentity;
  afterIdentity: BrowserStateIdentity;
  sensitiveInputActive: boolean;
};

type RememberedSnapshot = {
  snapshot: BrowserSnapshot;
  scope: string;
  signals: Set<string>;
};

type PendingAuthenticationEvidence = {
  submissionToolCallId: string;
  stage: AuthenticationExecutionStage;
  scope: string;
  afterIdentity: BrowserStateIdentity;
  baselineSignals: Set<string>;
  challengeDeparted: boolean;
  stateTransitionObserved: boolean;
};

type VerifiedAuthenticationEvidence = {
  pending: PendingAuthenticationEvidence;
  identity: BrowserStateIdentity;
};

export type AuthenticationEvidenceObservation = {
  effects: AuthenticationExecutionEffectReceipt[];
  assessments: AuthenticationEvidenceAssessmentEvent[];
};

/**
 * Correlates trusted browser receipts in execution order. Browser state and
 * semantic evidence stay in memory; persisted assessments contain only bounded
 * verdicts and booleans.
 */
export class AuthenticationEvidenceTracker {
  readonly #snapshots: RememberedSnapshot[] = [];
  #pending: PendingAuthenticationEvidence | undefined;
  #verified: VerifiedAuthenticationEvidence | undefined;

  constructor(existingExecutions: readonly ToolExecutionRecord[] = []) {
    for (const execution of existingExecutions) this.#rememberExecutionSnapshot(execution);
  }

  observe(executions: readonly ToolExecutionRecord[]): AuthenticationEvidenceObservation {
    const effects: AuthenticationExecutionEffectReceipt[] = [];
    const assessments: AuthenticationEvidenceAssessmentEvent[] = [];

    for (const execution of executions) {
      const baseEffects = deriveAuthenticationExecutionEffects([execution]);
      const protectedReceipt = protectedDeliveryReceipt(execution);

      if (this.#verified !== undefined) {
        const observation = this.#observeAfterVerification(execution, baseEffects);
        effects.push(...observation.effects);
        assessments.push(...observation.assessments);
        this.#rememberExecutionSnapshot(execution);
        continue;
      }

      effects.push(...baseEffects);

      if (protectedReceipt !== undefined) {
        const assessment = this.#observeProtectedSubmission(execution, protectedReceipt, baseEffects, effects);
        if (assessment !== undefined) assessments.push(assessment);
        this.#rememberExecutionSnapshot(execution);
        continue;
      }

      const invalidationReason = this.#pending === undefined
        ? undefined
        : pendingInvalidationReason(execution, this.#pending);
      if (this.#pending !== undefined && invalidationReason !== undefined) {
        const pending = this.#pending;
        const evidenceToolCallId = requiredToolCallId(execution);
        if (evidenceToolCallId !== undefined) {
          effects.push(blockedVerificationEffect(
            evidenceToolCallId,
            invalidationReason === "authentication-error"
              ? "The post-submit authentication state reached an error page."
              : invalidationReason === "signed-out"
                ? "The browser reached an explicit signed-out state after authentication submission."
                : "Authentication verification lost its causal chain after a consequential intervening browser action.",
            invalidationReason === "authentication-error" || invalidationReason === "signed-out"
              ? invalidationReason
              : undefined
          ));
          assessments.push(assessmentEvent({
            pending,
            outcome: invalidationReason === "causal-chain-interrupted" ? "invalidated" : "blocked",
            reason: invalidationReason,
            evidenceToolCallId,
            navigationInterrupted: invalidationReason === "causal-chain-interrupted",
          }));
        }
        this.#pending = undefined;
        this.#rememberExecutionSnapshot(execution);
        continue;
      }

      const snapshot = executionSnapshot(execution);
      if (this.#pending !== undefined && snapshot !== undefined && isCausalObservation(execution)) {
        const observation = this.#observePostSubmitSnapshot(execution, snapshot);
        effects.push(...observation.effects);
        assessments.push(...observation.assessments);
      }
      this.#rememberExecutionSnapshot(execution);
    }

    return { effects, assessments };
  }

  #observeProtectedSubmission(
    execution: ToolExecutionRecord,
    delivery: ProtectedDeliveryReceipt,
    baseEffects: readonly AuthenticationExecutionEffectReceipt[],
    effects: AuthenticationExecutionEffectReceipt[]
  ): AuthenticationEvidenceAssessmentEvent | undefined {
    const submissionToolCallId = requiredToolCallId(execution);
    const snapshot = executionSnapshot(execution);
    if (submissionToolCallId === undefined || snapshot === undefined) {
      this.#pending = undefined;
      return undefined;
    }
    const stage = execution.tool.name === "browser.fill_protected_form" ? "credentials" : "challenge";
    const scope = snapshotScope(snapshot, execution);
    const baseline = this.#findSnapshot(scope, delivery.beforeIdentity);
    const beforeSignals = baseline?.signals ?? new Set<string>();
    const afterSignals = authenticatedEvidenceSignals(snapshot);
    const postSubmitEvidence = afterSignals.size > 0;
    const preexistingEvidence = intersects(beforeSignals, afterSignals);
    const newEvidence = difference(afterSignals, beforeSignals);
    const challengeDeparted = delivery.challengeState === "departed";
    const stateTransitionObserved = challengeDeparted && (
      delivery.documentChanged ||
      (delivery.conditionMet && actionStateAdvanced(delivery.beforeIdentity, delivery.afterIdentity))
    );
    const blocked = baseEffects.some((effect) => effect.effect === "authentication-blocked") ||
      snapshotReportsAuthenticationError(snapshot);

    this.#pending = undefined;
    if (blocked || delivery.submission === "failed" || delivery.challengeState === "still-present") {
      return assessmentEvent({
        pending: {
          submissionToolCallId,
          stage,
          scope,
          afterIdentity: delivery.afterIdentity,
          baselineSignals: afterSignals,
          challengeDeparted,
          stateTransitionObserved,
        },
        outcome: "blocked",
        reason: snapshotReportsAuthenticationError(snapshot)
          ? "authentication-error"
          : delivery.challengeState === "still-present"
            ? "challenge-still-present"
            : "protected-submission-failed",
        evidenceToolCallId: submissionToolCallId,
        postSubmitEvidence,
        preexistingEvidence,
        sensitiveInputActive: delivery.sensitiveInputActive,
      });
    }
    if (
      execution.result?.ok !== true ||
      delivery.submission === "not-requested" ||
      delivery.challengeState === "unknown" ||
      delivery.sensitiveInputActive ||
      !challengeDeparted ||
      !stateTransitionObserved
    ) {
      return assessmentEvent({
        pending: {
          submissionToolCallId,
          stage,
          scope,
          afterIdentity: delivery.afterIdentity,
          baselineSignals: afterSignals,
          challengeDeparted,
          stateTransitionObserved,
        },
        outcome: "inconclusive",
        reason: "protected-settlement-inconclusive",
        evidenceToolCallId: submissionToolCallId,
        postSubmitEvidence,
        preexistingEvidence,
        sensitiveInputActive: delivery.sensitiveInputActive,
      });
    }

    const pending: PendingAuthenticationEvidence = {
      submissionToolCallId,
      stage,
      scope,
      afterIdentity: delivery.afterIdentity,
      baselineSignals: afterSignals,
      challengeDeparted,
      stateTransitionObserved,
    };
    const authenticatedDestination = stage === "challenge" &&
      challengeDeparted &&
      stateTransitionObserved &&
      postSubmitEvidence;
    if ((baseline !== undefined && newEvidence.size > 0) || authenticatedDestination) {
      this.#verified = { pending, identity: snapshot.identity };
      effects.push({
        effect: "authentication-verified",
        stage: "verification",
        toolCallId: submissionToolCallId,
      });
      return assessmentEvent({
        pending,
        outcome: "verified",
        reason: "authenticated-evidence-observed",
        evidenceToolCallId: submissionToolCallId,
        postSubmitEvidence: true,
        preexistingEvidence,
      });
    }

    this.#pending = pending;
    return assessmentEvent({
      pending,
      outcome: "candidate",
      reason: baseline !== undefined && postSubmitEvidence
        ? "preexisting-authenticated-evidence"
        : "challenge-departed-without-authenticated-evidence",
      evidenceToolCallId: submissionToolCallId,
      postSubmitEvidence,
      preexistingEvidence,
    });
  }

  #observePostSubmitSnapshot(
    execution: ToolExecutionRecord,
    snapshot: BrowserSnapshot
  ): AuthenticationEvidenceObservation {
    const pending = this.#pending;
    const evidenceToolCallId = requiredToolCallId(execution);
    if (
      pending === undefined ||
      evidenceToolCallId === undefined ||
      snapshotScope(snapshot, execution) !== pending.scope ||
      !identityObservedAfter(snapshot.identity, pending.afterIdentity)
    ) {
      return { effects: [], assessments: [] };
    }
    if (snapshotReportsAuthenticationError(snapshot)) {
      this.#pending = undefined;
      return {
        effects: [blockedVerificationEffect(
          evidenceToolCallId,
          "The post-submit authentication state reached an error page.",
          "authentication-error"
        )],
        assessments: [assessmentEvent({
          pending,
          outcome: "blocked",
          reason: "authentication-error",
          evidenceToolCallId,
        })],
      };
    }

    const signals = authenticatedEvidenceSignals(snapshot);
    const newEvidence = difference(signals, pending.baselineSignals);
    const authenticatedDestination = pending.stage === "challenge" &&
      pending.challengeDeparted &&
      pending.stateTransitionObserved &&
      signals.size > 0;
    if (newEvidence.size === 0 && !authenticatedDestination) {
      return {
        effects: [],
        assessments: [assessmentEvent({
          pending,
          outcome: "inconclusive",
          reason: signals.size > 0
            ? "preexisting-authenticated-evidence"
            : "challenge-departed-without-authenticated-evidence",
          evidenceToolCallId,
          postSubmitEvidence: signals.size > 0,
          preexistingEvidence: intersects(signals, pending.baselineSignals),
        })],
      };
    }

    this.#pending = undefined;
    this.#verified = { pending, identity: snapshot.identity };
    return {
      effects: [{
        effect: "authentication-verified",
        stage: "verification",
        toolCallId: evidenceToolCallId,
      }],
      assessments: [assessmentEvent({
        pending,
        outcome: "verified",
        reason: "authenticated-evidence-observed",
        evidenceToolCallId,
        postSubmitEvidence: true,
        preexistingEvidence: intersects(signals, pending.baselineSignals),
      })],
    };
  }

  #observeAfterVerification(
    execution: ToolExecutionRecord,
    baseEffects: readonly AuthenticationExecutionEffectReceipt[]
  ): AuthenticationEvidenceObservation {
    const verified = this.#verified;
    const snapshot = executionSnapshot(execution);
    const evidenceToolCallId = requiredToolCallId(execution);
    if (
      verified === undefined ||
      snapshot === undefined ||
      evidenceToolCallId === undefined ||
      snapshotScope(snapshot, execution) !== verified.pending.scope ||
      !identityObservedAfter(snapshot.identity, verified.identity)
    ) {
      return { effects: [], assessments: [] };
    }

    const reason = snapshotReportsAuthenticationError(snapshot)
      ? "authentication-error" as const
      : snapshotReportsSignedOut(snapshot)
        ? "signed-out" as const
        : undefined;
    if (reason === undefined) return { effects: [], assessments: [] };

    const explicitEffect = baseEffects.find((effect) =>
      effect.effect === "authentication-blocked" && effect.failureProof === reason
    );
    this.#verified = undefined;
    return {
      effects: [explicitEffect ?? blockedVerificationEffect(
        evidenceToolCallId,
        reason === "authentication-error"
          ? "The authenticated browser state reached an explicit authentication error."
          : "The browser reached an explicit signed-out state.",
        reason
      )],
      assessments: [assessmentEvent({
        pending: verified.pending,
        outcome: "blocked",
        reason,
        evidenceToolCallId,
      })],
    };
  }

  #rememberExecutionSnapshot(execution: ToolExecutionRecord): void {
    const snapshot = executionSnapshot(execution);
    if (snapshot === undefined) return;
    this.#snapshots.push({
      snapshot,
      scope: snapshotScope(snapshot, execution),
      signals: authenticatedEvidenceSignals(snapshot),
    });
    if (this.#snapshots.length > MAX_REMEMBERED_SNAPSHOTS) this.#snapshots.shift();
  }

  #findSnapshot(scope: string, identity: BrowserStateIdentity): RememberedSnapshot | undefined {
    return [...this.#snapshots].reverse().find((entry) =>
      entry.scope === scope && sameBrowserState(entry.snapshot.identity, identity)
    );
  }
}

function assessmentEvent(input: {
  pending: PendingAuthenticationEvidence;
  outcome: AuthenticationEvidenceAssessmentEvent["outcome"];
  reason: AuthenticationEvidenceAssessmentEvent["reason"];
  evidenceToolCallId?: string;
  postSubmitEvidence?: boolean;
  preexistingEvidence?: boolean;
  navigationInterrupted?: boolean;
  sensitiveInputActive?: boolean;
}): AuthenticationEvidenceAssessmentEvent {
  return {
    kind: "authentication-evidence-assessed",
    stage: input.pending.stage,
    outcome: input.outcome,
    reason: input.reason,
    submissionToolCallId: input.pending.submissionToolCallId,
    ...(input.evidenceToolCallId === undefined ? {} : { evidenceToolCallId: input.evidenceToolCallId }),
    challengeDeparted: input.pending.challengeDeparted,
    stateTransitionObserved: input.pending.stateTransitionObserved,
    postSubmitEvidence: input.postSubmitEvidence ?? false,
    preexistingEvidence: input.preexistingEvidence ?? false,
    navigationInterrupted: input.navigationInterrupted ?? false,
    sensitiveInputActive: input.sensitiveInputActive ?? false,
  };
}

function blockedVerificationEffect(
  toolCallId: string,
  summary: string,
  failureProof?: AuthenticationExecutionEffectReceipt["failureProof"]
): AuthenticationExecutionEffectReceipt {
  return {
    effect: "authentication-blocked",
    stage: "verification",
    toolCallId,
    blocker: { kind: "external_state", summary },
    ...(failureProof === undefined ? {} : { failureProof }),
  };
}

function authenticatedEvidenceSignals(snapshot: BrowserSnapshot): Set<string> {
  if (snapshot.sensitiveInputActive === true) return new Set();
  const visibleElements = (snapshot.elements ?? []).filter((element) =>
    element.hidden !== true && element.disabled !== true
  );
  const evidence = [
    snapshot.title,
    ...visibleElements.flatMap((element) => [element.name, element.label, element.text]),
  ].filter((value): value is string => typeof value === "string").join(" ");
  return new Set(AUTHENTICATED_TEXT_SIGNALS.flatMap(([signal, pattern]) =>
    pattern.test(evidence) ? [signal] : []
  ));
}

function protectedDeliveryReceipt(execution: ToolExecutionRecord): ProtectedDeliveryReceipt | undefined {
  if (
    execution.decision !== "allow" ||
    !PROTECTED_AUTHENTICATION_TOOLS.has(execution.tool.name)
  ) return undefined;
  const metadata = record(execution.result?.metadata);
  const candidate = record(metadata?.protectedDelivery);
  if (
    candidate?.delivery !== "delivered" ||
    !isSubmission(candidate.submission) ||
    typeof candidate.documentChanged !== "boolean" ||
    !isChallengeState(candidate.challengeState) ||
    typeof candidate.conditionMet !== "boolean" ||
    !isBrowserStateIdentity(candidate.beforeIdentity) ||
    !isBrowserStateIdentity(candidate.afterIdentity) ||
    typeof candidate.sensitiveInputActive !== "boolean"
  ) return undefined;
  return {
    submission: candidate.submission,
    documentChanged: candidate.documentChanged,
    challengeState: candidate.challengeState,
    conditionMet: candidate.conditionMet,
    beforeIdentity: candidate.beforeIdentity,
    afterIdentity: candidate.afterIdentity,
    sensitiveInputActive: candidate.sensitiveInputActive,
  };
}

function executionSnapshot(execution: ToolExecutionRecord): BrowserSnapshot | undefined {
  const snapshot = record(record(execution.result?.metadata)?.snapshot);
  if (
    snapshot === undefined ||
    typeof snapshot.sessionId !== "string" ||
    typeof snapshot.url !== "string" ||
    typeof snapshot.observedAt !== "string" ||
    !isBrowserStateIdentity(snapshot.identity)
  ) return undefined;
  return snapshot as BrowserSnapshot;
}

function snapshotScope(snapshot: BrowserSnapshot, execution: ToolExecutionRecord): string {
  const inputTab = typeof execution.input?.tabRef === "string" ? execution.input.tabRef : undefined;
  return `${snapshot.sessionId}\u0000${snapshot.tab?.ref ?? inputTab ?? ""}`;
}

function pendingInvalidationReason(
  execution: ToolExecutionRecord,
  pending: PendingAuthenticationEvidence
): "authentication-error" | "signed-out" | "causal-chain-interrupted" | undefined {
  const snapshot = executionSnapshot(execution);
  if (snapshot !== undefined && snapshotReportsAuthenticationError(snapshot)) return "authentication-error";
  if (!isConsequentialBrowserAction(execution, snapshot, pending.afterIdentity)) return undefined;
  return snapshot !== undefined && snapshotReportsSignedOut(snapshot)
    ? "signed-out"
    : "causal-chain-interrupted";
}

function isConsequentialBrowserAction(
  execution: ToolExecutionRecord,
  snapshot: BrowserSnapshot | undefined,
  anchor: BrowserStateIdentity
): boolean {
  if (
    execution.decision !== "allow" ||
    execution.result?.ok !== true ||
    !execution.tool.name.startsWith("browser.") ||
    BROWSER_OBSERVATION_TOOLS.has(execution.tool.name) ||
    snapshot === undefined
  ) return false;
  if (snapshot.actionDelta?.outcome === "no-change") return false;
  if (snapshot.actionDelta?.outcome === "changed") return true;
  return actionStateAdvanced(anchor, snapshot.identity);
}

function isCausalObservation(execution: ToolExecutionRecord): boolean {
  return execution.decision === "allow" &&
    execution.result?.ok === true &&
    BROWSER_OBSERVATION_TOOLS.has(execution.tool.name);
}

function requiredToolCallId(execution: ToolExecutionRecord): string | undefined {
  const value = execution.toolCallId?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

function actionStateAdvanced(before: BrowserStateIdentity, after: BrowserStateIdentity): boolean {
  return after.documentEpoch > before.documentEpoch ||
    (after.documentEpoch === before.documentEpoch && after.actionRevision > before.actionRevision);
}

function identityObservedAfter(current: BrowserStateIdentity, anchor: BrowserStateIdentity): boolean {
  return current.documentEpoch > anchor.documentEpoch ||
    (current.documentEpoch === anchor.documentEpoch && current.actionRevision > anchor.actionRevision) ||
    (current.documentEpoch === anchor.documentEpoch &&
      current.actionRevision === anchor.actionRevision &&
      current.observationId > anchor.observationId);
}

function sameBrowserState(left: BrowserStateIdentity, right: BrowserStateIdentity): boolean {
  return left.documentEpoch === right.documentEpoch && left.actionRevision === right.actionRevision;
}

function snapshotReportsSignedOut(snapshot: BrowserSnapshot): boolean {
  if (snapshot.sensitiveInputActive === true) return false;
  const visibleElements = (snapshot.elements ?? []).filter((element) =>
    element.hidden !== true && element.disabled !== true
  );
  const pageEvidence = [snapshot.url, snapshot.title, snapshot.text]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  const hasPasswordField = visibleElements.some((element) =>
    [element.name, element.label, element.text].some((value) =>
      typeof value === "string" && PASSWORD_FIELD_TERMS.test(value)
    )
  );
  return hasPasswordField && SIGNED_OUT_PAGE_TERMS.test(pageEvidence);
}

function difference(left: ReadonlySet<string>, right: ReadonlySet<string>): Set<string> {
  return new Set([...left].filter((value) => !right.has(value)));
}

function intersects(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return [...left].some((value) => right.has(value));
}

function isBrowserStateIdentity(value: unknown): value is BrowserStateIdentity {
  const candidate = record(value);
  return candidate !== undefined &&
    positiveInteger(candidate.documentEpoch) &&
    positiveInteger(candidate.actionRevision) &&
    positiveInteger(candidate.observationId);
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isSubmission(value: unknown): value is ProtectedDeliveryReceipt["submission"] {
  return value === "not-requested" || value === "clicked" || value === "automatic" || value === "failed";
}

function isChallengeState(value: unknown): value is ProtectedDeliveryReceipt["challengeState"] {
  return value === "departed" || value === "still-present" || value === "unknown";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
