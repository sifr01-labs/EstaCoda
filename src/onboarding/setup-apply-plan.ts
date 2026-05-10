import type { SetupVerificationReport } from "./verification.js";
import type {
  SetupReviewManifest,
  SetupReviewManifestLine,
  SetupReviewManifestTarget,
} from "./setup-review-manifest.js";
import type { SetupDraftReviewMetadata } from "./setup-drafts.js";

export type SetupReviewDecision =
  | {
      readonly kind: "approved-review-result";
      readonly manifest: SetupReviewManifest;
    }
  | {
      readonly kind: "cancelled-review-result";
      readonly manifest: SetupReviewManifest;
      readonly reason?: string;
    }
  | {
      readonly kind: "blocked-review-result";
      readonly manifest: SetupReviewManifest;
      readonly blockers: readonly string[];
    };

export type SetupApplyOperationKind =
  | "config-patch"
  | "credential-reference"
  | "workspace-trust-grant"
  | "verification-request"
  | "launch-handoff";

export type SetupRepairIntentKind =
  | "credential-repair"
  | "workspace-trust-repair"
  | "config-repair"
  | "state-repair"
  | "manual-review";

export type SetupApplyOperation = {
  readonly id: string;
  readonly kind: SetupApplyOperationKind;
  readonly sourceLineIds: readonly string[];
  readonly target?: SetupReviewManifestTarget;
  readonly review: SetupReviewManifestLine["review"];
  readonly preserveUnrelatedConfig?: true;
  readonly writesConfig: false;
  readonly writesTrustStore: false;
  readonly dryRunOnly: true;
};

export type SetupRepairIntent = {
  readonly kind: SetupRepairIntentKind;
  readonly sourceLineIds: readonly string[];
  readonly blockers: readonly string[];
};

export type SetupApplyEligibility =
  | {
      readonly eligible: true;
      readonly blockers: readonly [];
      readonly repairIntents: readonly [];
    }
  | {
      readonly eligible: false;
      readonly blockers: readonly string[];
      readonly repairIntents: readonly SetupRepairIntent[];
    };

export type SetupApplyPlan = {
  readonly kind: "setup-save-apply-plan";
  readonly manifestSourceBundleIds: readonly string[];
  readonly operations: readonly SetupApplyOperation[];
  readonly eligibility: Extract<SetupApplyEligibility, { readonly eligible: true }>;
  readonly verificationRequest?: SetupPostSaveVerificationRequest;
  readonly launchHandoffIntent?: SetupLaunchHandoffIntent;
  readonly preservesUnrelatedConfig: true;
  readonly writesConfig: false;
  readonly writesTrustStore: false;
  readonly dryRunOnly: true;
  readonly metadata: {
    readonly operationCount: number;
    readonly configOperationCount: number;
    readonly trustOperationCount: number;
    readonly credentialOperationCount: number;
  };
};

export type SetupApplyPlanningResult =
  | {
      readonly kind: "apply-plan-ready";
      readonly applyPlan: SetupApplyPlan;
      readonly eligibility: Extract<SetupApplyEligibility, { readonly eligible: true }>;
    }
  | {
      readonly kind: "cancelled";
      readonly endState: SetupApplyEndState;
      readonly applyPlan?: undefined;
      readonly eligibility: Extract<SetupApplyEligibility, { readonly eligible: false }>;
    }
  | {
      readonly kind: "blocked";
      readonly endState: SetupApplyEndState;
      readonly applyPlan?: undefined;
      readonly eligibility: Extract<SetupApplyEligibility, { readonly eligible: false }>;
    };

export type SetupPostSaveVerificationRequest = {
  readonly kind: "post-save-verification-request";
  readonly sourceLineIds: readonly string[];
  readonly readOnly: true;
};

export type SetupLaunchHandoffIntent = {
  readonly kind: "launch-handoff-intent";
  readonly sourceLineIds: readonly string[];
  readonly preference: "offer-after-verify" | "skip-launch";
  readonly requiresVerifiedReadyOrAcceptedDegraded: true;
};

export type SetupApplyExecutionResult = {
  readonly ok: boolean;
  readonly appliedOperationIds: readonly string[];
  readonly error?: string;
};

export type SetupApplyExecutor = {
  readonly apply: (plan: SetupApplyPlan) => Promise<SetupApplyExecutionResult> | SetupApplyExecutionResult;
  readonly verify?: (request: SetupPostSaveVerificationRequest) => Promise<SetupVerificationReport> | SetupVerificationReport;
};

export type SetupApplyFlowOptions = {
  readonly acceptDegraded?: boolean;
};

export type SetupVerificationClassification = "ready" | "degraded" | "blocked";

export type SetupApplyEndState =
  | {
      readonly kind: "verified-ready";
      readonly verification: SetupVerificationReport;
      readonly launchHandoffIntent?: SetupLaunchHandoffIntent;
    }
  | {
      readonly kind: "verified-degraded";
      readonly verification: SetupVerificationReport;
      readonly requiresExplicitContinueDecision: true;
      readonly launchHandoffIntent?: undefined;
    }
  | {
      readonly kind: "blocked";
      readonly reason: "review-blocked" | "save-failed" | "verification-blocked";
      readonly blockers: readonly string[];
      readonly repairIntents: readonly SetupRepairIntent[];
      readonly verification?: SetupVerificationReport;
      readonly launchHandoffIntent?: undefined;
    }
  | {
      readonly kind: "cancelled";
      readonly reason?: string;
      readonly operationsPlanned: 0;
      readonly launchHandoffIntent?: undefined;
    }
  | {
      readonly kind: "saved-not-launched";
      readonly verification?: SetupVerificationReport;
      readonly launchHandoffIntent?: SetupLaunchHandoffIntent;
    }
  | {
      readonly kind: "launched";
      readonly verification: SetupVerificationReport;
      readonly launchHandoffIntent: SetupLaunchHandoffIntent;
      readonly acceptedDegraded: boolean;
    };

export function planSetupApply(decision: SetupReviewDecision): SetupApplyPlanningResult {
  if (decision.kind === "cancelled-review-result") {
    return {
      kind: "cancelled",
      endState: {
        kind: "cancelled",
        reason: decision.reason,
        operationsPlanned: 0,
      },
      eligibility: {
        eligible: false,
        blockers: ["Review was cancelled."],
        repairIntents: [],
      },
    };
  }

  const manifest = decision.manifest;
  const eligibility = decision.kind === "blocked-review-result"
    ? blockedEligibility(decision.blockers, [])
    : evaluateSetupApplyEligibility(manifest);

  if (!eligibility.eligible) {
    return {
      kind: "blocked",
      endState: {
        kind: "blocked",
        reason: "review-blocked",
        blockers: eligibility.blockers,
        repairIntents: eligibility.repairIntents,
      },
      eligibility,
    };
  }

  const operations = operationsFromManifest(manifest);
  const verificationRequest = verificationRequestFromManifest(manifest);
  const launchHandoffIntent = launchHandoffFromManifest(manifest);
  const applyPlan: SetupApplyPlan = {
    kind: "setup-save-apply-plan",
    manifestSourceBundleIds: manifest.sourceBundleIds,
    operations,
    eligibility,
    verificationRequest,
    launchHandoffIntent,
    preservesUnrelatedConfig: true,
    writesConfig: false,
    writesTrustStore: false,
    dryRunOnly: true,
    metadata: {
      operationCount: operations.length,
      configOperationCount: operations.filter((operation) => operation.kind === "config-patch").length,
      trustOperationCount: operations.filter((operation) => operation.kind === "workspace-trust-grant").length,
      credentialOperationCount: operations.filter((operation) => operation.kind === "credential-reference").length,
    },
  };

  return {
    kind: "apply-plan-ready",
    applyPlan,
    eligibility,
  };
}

export function evaluateSetupApplyEligibility(manifest: SetupReviewManifest): SetupApplyEligibility {
  const blockers = new Set<string>();
  const repairIntents: SetupRepairIntent[] = [];

  for (const suppression of manifest.suppressedNormalWrites) {
    const message = suppression.reason === "broken-config"
      ? "Broken config blocks normal apply planning."
      : "Unsafe diagnostic-only config repair blocks normal apply planning.";
    blockers.add(message);
    repairIntents.push({
      kind: "config-repair",
      sourceLineIds: [],
      blockers: [message],
    });
  }

  for (const line of manifest.blockers) {
    const lineBlockers = line.blockers.length > 0 ? line.blockers : [line.summaryKey];
    if (line.section === "blockers") {
      for (const blocker of lineBlockers) {
        if (isWorkspaceTrustBlocker(blocker) && hasWorkspaceTrustGrant(manifest)) {
          continue;
        }
        blockers.add(blocker);
      }
      const intent = repairIntentForLine(line);
      if (intent !== undefined) {
        repairIntents.push(intent);
      }
    }
  }

  if (blockers.size > 0) {
    return blockedEligibility([...blockers], repairIntents);
  }

  return {
    eligible: true,
    blockers: [],
    repairIntents: [],
  };
}

export async function executeSetupApplyPlan(
  plan: SetupApplyPlan,
  executor: SetupApplyExecutor,
  options: SetupApplyFlowOptions = {}
): Promise<SetupApplyEndState> {
  const saveResult = await executor.apply(plan);
  if (!saveResult.ok) {
    return {
      kind: "blocked",
      reason: "save-failed",
      blockers: [saveResult.error ?? "Setup save failed."],
      repairIntents: [{
        kind: "manual-review",
        sourceLineIds: [],
        blockers: [saveResult.error ?? "Setup save failed."],
      }],
    };
  }

  if (plan.verificationRequest === undefined || executor.verify === undefined) {
    return {
      kind: "saved-not-launched",
      launchHandoffIntent: plan.launchHandoffIntent,
    };
  }

  const verification = await executor.verify(plan.verificationRequest);
  const classification = classifySetupVerificationReport(verification);

  if (classification === "blocked") {
    return {
      kind: "blocked",
      reason: "verification-blocked",
      blockers: verification.warnings.length > 0 ? verification.warnings : ["Post-save verification is blocked."],
      repairIntents: [{
        kind: "manual-review",
        sourceLineIds: plan.verificationRequest.sourceLineIds,
        blockers: verification.warnings.length > 0 ? verification.warnings : ["Post-save verification is blocked."],
      }],
      verification,
    };
  }

  if (classification === "degraded") {
    if (options.acceptDegraded === true && plan.launchHandoffIntent?.preference === "offer-after-verify") {
      return {
        kind: "launched",
        verification,
        launchHandoffIntent: plan.launchHandoffIntent,
        acceptedDegraded: true,
      };
    }
    if (options.acceptDegraded === true) {
      return {
        kind: "saved-not-launched",
        verification,
        launchHandoffIntent: plan.launchHandoffIntent,
      };
    }
    return {
      kind: "verified-degraded",
      verification,
      requiresExplicitContinueDecision: true,
    };
  }

  if (plan.launchHandoffIntent?.preference === "offer-after-verify") {
    return {
      kind: "launched",
      verification,
      launchHandoffIntent: plan.launchHandoffIntent,
      acceptedDegraded: false,
    };
  }

  if (plan.launchHandoffIntent?.preference === "skip-launch") {
    return {
      kind: "saved-not-launched",
      verification,
      launchHandoffIntent: plan.launchHandoffIntent,
    };
  }

  return {
    kind: "verified-ready",
    verification,
  };
}

export function classifySetupVerificationReport(report: SetupVerificationReport): SetupVerificationClassification {
  const blockingIssueCodes = new Set([
    "provider-incomplete",
    "missing-api-key",
    "no-credential-pool",
    "no-available-credential",
    "workspace-not-trusted",
    "state-not-writable",
    "read-only-tool-blocked",
    "provider-adapter-missing",
    "provider-not-executable",
    "provider-health-blocked",
    "model-not-registered",
  ]);
  if (!report.stateWritable || report.providerDiagnostic.status === "blocked") return "blocked";
  if (report.issueCodes.some((code) => blockingIssueCodes.has(code))) return "blocked";
  if (report.warnings.length > 0 || report.providerDiagnostic.status === "warning") return "degraded";
  return "ready";
}

function operationsFromManifest(manifest: SetupReviewManifest): SetupApplyOperation[] {
  return [
    ...manifest.sections["files-to-write-update"].map((line) => operationFromLine("config-patch", line)),
    ...manifest.sections["secret-refs-to-store"].map((line) => operationFromLine("credential-reference", line)),
    ...manifest.sections["workspace-trust-grants"].map((line) => operationFromLine("workspace-trust-grant", line)),
    ...manifest.sections["verification-checks"].map((line) => operationFromLine("verification-request", line)),
    ...manifest.sections["launch-handoff"].map((line) => operationFromLine("launch-handoff", line)),
  ];
}

function operationFromLine(kind: SetupApplyOperationKind, line: SetupReviewManifestLine): SetupApplyOperation {
  return {
    id: `apply.${line.id}`,
    kind,
    sourceLineIds: [line.id],
    target: line.target,
    review: redactedReviewForApply(line.review),
    ...(line.preserveUnrelatedConfig === true || line.target?.kind === "config-scope"
      ? { preserveUnrelatedConfig: true as const }
      : {}),
    writesConfig: false,
    writesTrustStore: false,
    dryRunOnly: true,
  };
}

function verificationRequestFromManifest(manifest: SetupReviewManifest): SetupPostSaveVerificationRequest | undefined {
  const lineIds = manifest.sections["verification-checks"].map((line) => line.id);
  if (lineIds.length === 0) return undefined;
  return {
    kind: "post-save-verification-request",
    sourceLineIds: lineIds,
    readOnly: true,
  };
}

function launchHandoffFromManifest(manifest: SetupReviewManifest): SetupLaunchHandoffIntent | undefined {
  const line = manifest.sections["launch-handoff"][0];
  if (line?.target?.kind !== "launch") return undefined;
  return {
    kind: "launch-handoff-intent",
    sourceLineIds: [line.id],
    preference: line.target.preference,
    requiresVerifiedReadyOrAcceptedDegraded: true,
  };
}

function blockedEligibility(
  blockers: readonly string[],
  repairIntents: readonly SetupRepairIntent[]
): Extract<SetupApplyEligibility, { readonly eligible: false }> {
  return {
    eligible: false,
    blockers,
    repairIntents,
  };
}

function repairIntentForLine(line: SetupReviewManifestLine): SetupRepairIntent | undefined {
  const blockers = line.blockers;
  if (blockers.length === 0) return undefined;
  if (line.riskSurface === "credential-reference" || blockers.some((blocker) => /credential|api key|env/i.test(blocker))) {
    return {
      kind: "credential-repair",
      sourceLineIds: line.sourceDraftIds,
      blockers,
    };
  }
  if (line.riskSurface === "workspace-trust" || blockers.some(isWorkspaceTrustBlocker)) {
    return {
      kind: "workspace-trust-repair",
      sourceLineIds: line.sourceDraftIds,
      blockers,
    };
  }
  if (line.riskSurface === "config-repair") {
    return {
      kind: "config-repair",
      sourceLineIds: line.sourceDraftIds,
      blockers,
    };
  }
  return {
    kind: "manual-review",
    sourceLineIds: line.sourceDraftIds,
    blockers,
  };
}

function hasWorkspaceTrustGrant(manifest: SetupReviewManifest): boolean {
  return manifest.sections["workspace-trust-grants"].length > 0;
}

function isWorkspaceTrustBlocker(blocker: string): boolean {
  return /workspace.*trust|not trusted/i.test(blocker);
}

function redactedReviewForApply(review: SetupDraftReviewMetadata): SetupDraftReviewMetadata {
  return {
    ...review,
    redacted: true,
    values: Object.fromEntries(
      Object.entries(review.values).map(([key, value]) => [
        key,
        isRawSecretReviewKey(key) ? undefined : value,
      ])
    ),
  };
}

function isRawSecretReviewKey(key: string): boolean {
  return /(token|secret|apiKey)$/iu.test(key) && !/(Env|Included)$/u.test(key);
}
