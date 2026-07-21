import type {
  SetupDraft,
  SetupDraftBundle,
  SetupDraftReviewMetadata,
  SetupDraftRiskSurface,
  SetupDraftTarget,
} from "./setup-drafts.js";

export type SetupReviewManifestSection =
  | "files-to-write-update"
  | "secret-refs-to-store"
  | "workspace-trust-grants"
  | "provider-model-network"
  | "enabled-optional-capabilities"
  | "remote-control-surfaces"
  | "security-mode"
  | "workflow-learning"
  | "spending-policy"
  | "verification-checks"
  | "launch-handoff"
  | "blockers"
  | "warnings";

export type SetupReviewManifestSeverity = "info" | "warning" | "blocker";
export type SetupReviewManifestSuppressionReason = "broken-config" | "unsafe-diagnostic-only";

export type SetupReviewManifestLine = {
  readonly id: string;
  readonly section: SetupReviewManifestSection;
  readonly sourceDraftIds: readonly string[];
  readonly copyKey: string;
  readonly summaryKey: string;
  readonly riskSurface: SetupDraftRiskSurface;
  readonly target?: SetupReviewManifestTarget;
  readonly review: SetupDraftReviewMetadata;
  readonly severity: SetupReviewManifestSeverity;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
  readonly readOnly: boolean;
  readonly preserveUnrelatedConfig?: true;
};

export type SetupReviewManifestTarget =
  | {
      readonly kind: "config-scope";
      readonly path?: string;
      readonly scope: readonly string[];
      readonly preserveUnrelatedConfig: true;
    }
  | {
      readonly kind: "trust-store";
      readonly workspaceRoot: string;
      readonly trustStorePath: string;
    }
  | {
      readonly kind: "verification";
      readonly readOnly: true;
    }
  | {
      readonly kind: "launch";
      readonly preference: "offer-after-verify" | "skip-launch";
    }
  | {
      readonly kind: "diagnostic-only";
    };

export type SetupReviewManifest = {
  readonly kind: "setup-review-manifest";
  readonly sourceBundleIds: readonly string[];
  readonly lines: readonly SetupReviewManifestLine[];
  readonly sections: Record<SetupReviewManifestSection, readonly SetupReviewManifestLine[]>;
  readonly blockers: readonly SetupReviewManifestLine[];
  readonly warnings: readonly SetupReviewManifestLine[];
  readonly safeToReviewForApply: boolean;
  readonly suppressedNormalWrites: readonly {
    readonly bundleId: string;
    readonly reason: SetupReviewManifestSuppressionReason;
  }[];
  readonly metadata: {
    readonly bundleCount: number;
    readonly lineCount: number;
    readonly blockerCount: number;
    readonly warningCount: number;
    readonly readOnlyCount: number;
  };
};

export function buildSetupReviewManifest(
  bundles: readonly SetupDraftBundle[]
): SetupReviewManifest {
  const suppressions = bundles.flatMap((bundle) => normalWriteSuppressions(bundle));
  const suppressionMap = new Map(suppressions.map((suppression) => [suppression.bundleId, suppression.reason]));
  const lines = bundles.flatMap((bundle) => linesForBundle(bundle, suppressionMap.get(bundle.sourceId)));
  const sections = groupSections(lines);
  const blockers = sections.blockers;
  const warnings = sections.warnings;

  return {
    kind: "setup-review-manifest",
    sourceBundleIds: bundles.map((bundle) => bundle.sourceId),
    lines,
    sections,
    blockers,
    warnings,
    safeToReviewForApply: blockers.length === 0 && bundles.every((bundle) => bundle.safeToApplyLater),
    suppressedNormalWrites: suppressions,
    metadata: {
      bundleCount: bundles.length,
      lineCount: lines.length,
      blockerCount: blockers.length,
      warningCount: warnings.length,
      readOnlyCount: lines.filter((line) => line.readOnly).length,
    },
  };
}

function linesForBundle(
  bundle: SetupDraftBundle,
  suppressionReason: SetupReviewManifestSuppressionReason | undefined
): SetupReviewManifestLine[] {
  const lines: SetupReviewManifestLine[] = [];

  for (const draft of bundle.drafts) {
    if (suppressionReason !== undefined && draft.target.kind === "config-scope" && draft.kind !== "diagnostic-blocker") {
      continue;
    }
    lines.push(...linesForDraft(draft));
  }

  lines.push(...bundle.blockers.map((blocker, index) => diagnosticLine({
    id: `bundle.${bundle.sourceId}.blocker.${index}`,
    section: "blockers",
    sourceDraftIds: [],
    summaryKey: "setupReview.bundleBlocker.summary",
    values: { blocker },
    severity: "blocker",
    blockers: [blocker],
  })));
  lines.push(...bundle.warnings.map((warning, index) => diagnosticLine({
    id: `bundle.${bundle.sourceId}.warning.${index}`,
    section: "warnings",
    sourceDraftIds: [],
    summaryKey: "setupReview.bundleWarning.summary",
    values: { warning },
    severity: "warning",
    warnings: [warning],
  })));

  return lines;
}

function normalWriteSuppressions(
  bundle: SetupDraftBundle
): readonly {
  readonly bundleId: string;
  readonly reason: SetupReviewManifestSuppressionReason;
}[] {
  const hasDiagnosticOnlyConfigRepair = bundle.drafts.some((draft) =>
    draft.kind === "diagnostic-blocker" &&
    draft.riskSurface === "config-repair" &&
    draft.applyIntent.effect === "diagnostic-only"
  );
  if (!hasDiagnosticOnlyConfigRepair) return [];

  const reason = bundle.sourceId.includes("broken-config") ||
    bundle.blockers.some((blocker) => /config.*(parse|parsed|repair)|normal config editing is blocked/iu.test(blocker))
    ? "broken-config"
    : "unsafe-diagnostic-only";
  return [{ bundleId: bundle.sourceId, reason }];
}

function linesForDraft(draft: SetupDraft): SetupReviewManifestLine[] {
  const lines: SetupReviewManifestLine[] = [];

  if (draft.blockers.length > 0 || draft.kind === "diagnostic-blocker") {
    lines.push(lineFromDraft(draft, "blockers", {
      idSuffix: "blocker",
      severity: "blocker",
      readOnly: true,
    }));
  }

  if (draft.warnings.length > 0) {
    lines.push(lineFromDraft(draft, "warnings", {
      idSuffix: "warning",
      severity: "warning",
      readOnly: true,
    }));
  }

  if (isSkippedOptionalCapability(draft) || draft.kind === "diagnostic-blocker" || draft.kind === "exit") {
    return lines;
  }

  if (draft.target.kind === "config-scope" && !draft.readOnly) {
    lines.push(lineFromDraft(draft, "files-to-write-update", { idSuffix: "file" }));
  }

  switch (draft.kind) {
    case "provider-model-route":
      lines.push(lineFromDraft(draft, "provider-model-network", { idSuffix: "provider-model" }));
      break;
    case "fallback-model-route":
      lines.push(lineFromDraft(draft, "provider-model-network", { idSuffix: "fallback" }));
      break;
    case "auxiliary-model-route":
      lines.push(lineFromDraft(draft, "provider-model-network", { idSuffix: "auxiliary" }));
      break;
    case "credential-reference":
      lines.push(lineFromDraft(draft, "secret-refs-to-store", { idSuffix: "secret-ref" }));
      break;
    case "workspace-trust":
      lines.push(lineFromDraft(draft, "workspace-trust-grants", { idSuffix: "workspace-trust" }));
      break;
    case "security-mode":
      lines.push(lineFromDraft(draft, "security-mode", { idSuffix: "security" }));
      break;
    case "workflow-learning":
      lines.push(lineFromDraft(draft, "workflow-learning", { idSuffix: "workflow" }));
      break;
    case "spending-policy":
      lines.push(lineFromDraft(draft, "spending-policy", { idSuffix: "spending" }));
      break;
    case "optional-capability":
      lines.push(...optionalCapabilityLines(draft));
      break;
    case "verification":
      lines.push(lineFromDraft(draft, "verification-checks", {
        idSuffix: "verification",
        readOnly: true,
      }));
      break;
    case "launch-handoff":
      lines.push(lineFromDraft(draft, "launch-handoff", {
        idSuffix: "launch",
        readOnly: true,
      }));
      break;
  }

  return lines;
}

function optionalCapabilityLines(draft: SetupDraft): SetupReviewManifestLine[] {
  const lines = [
    lineFromDraft(draft, "enabled-optional-capabilities", { idSuffix: "capability" }),
  ];
  if (isRemoteControlCapability(draft)) {
    lines.push(lineFromDraft(draft, "remote-control-surfaces", { idSuffix: "remote-control" }));
  }
  return lines;
}

function lineFromDraft(
  draft: SetupDraft,
  section: SetupReviewManifestSection,
  options: {
    readonly idSuffix: string;
    readonly severity?: SetupReviewManifestSeverity;
    readonly readOnly?: boolean;
  }
): SetupReviewManifestLine {
  return {
    id: `${section}.${draft.id}.${options.idSuffix}`,
    section,
    sourceDraftIds: [draft.id],
    copyKey: draft.review.copyKey,
    summaryKey: draft.review.summaryKey,
    riskSurface: draft.riskSurface,
    target: targetForManifest(draft.target),
    review: redactedReview(draft.review),
    severity: options.severity ?? severityForDraft(draft),
    blockers: draft.blockers,
    warnings: draft.warnings,
    readOnly: options.readOnly ?? draft.readOnly,
    ...(draft.preserveUnrelatedConfig === true || draft.target.kind === "config-scope"
      ? { preserveUnrelatedConfig: true as const }
      : {}),
  };
}

function diagnosticLine(input: {
  readonly id: string;
  readonly section: "blockers" | "warnings";
  readonly sourceDraftIds: readonly string[];
  readonly summaryKey: string;
  readonly values: SetupDraftReviewMetadata["values"];
  readonly severity: SetupReviewManifestSeverity;
  readonly blockers?: readonly string[];
  readonly warnings?: readonly string[];
}): SetupReviewManifestLine {
  return {
    id: input.id,
    section: input.section,
    sourceDraftIds: input.sourceDraftIds,
    copyKey: "setupReview.diagnostic",
    summaryKey: input.summaryKey,
    riskSurface: "config-repair",
    target: { kind: "diagnostic-only" },
    review: redactedReview({
      copyKey: "setupReview.diagnostic",
      summaryKey: input.summaryKey,
      redacted: true,
      values: input.values,
    }),
    severity: input.severity,
    blockers: input.blockers ?? [],
    warnings: input.warnings ?? [],
    readOnly: true,
  };
}

function targetForManifest(target: SetupDraftTarget): SetupReviewManifestTarget {
  switch (target.kind) {
    case "config-scope":
      return {
        kind: "config-scope",
        path: target.path,
        scope: target.scope,
        preserveUnrelatedConfig: true,
      };
    case "trust-store":
      return {
        kind: "trust-store",
        workspaceRoot: target.workspaceRoot,
        trustStorePath: target.trustStorePath,
      };
    case "verification":
      return {
        kind: "verification",
        readOnly: true,
      };
    case "launch":
      return {
        kind: "launch",
        preference: target.preference,
      };
    case "diagnostic-only":
      return {
        kind: "diagnostic-only",
      };
  }
}

function groupSections(
  lines: readonly SetupReviewManifestLine[]
): Record<SetupReviewManifestSection, readonly SetupReviewManifestLine[]> {
  return {
    "files-to-write-update": lines.filter((line) => line.section === "files-to-write-update"),
    "secret-refs-to-store": lines.filter((line) => line.section === "secret-refs-to-store"),
    "workspace-trust-grants": lines.filter((line) => line.section === "workspace-trust-grants"),
    "provider-model-network": lines.filter((line) => line.section === "provider-model-network"),
    "enabled-optional-capabilities": lines.filter((line) => line.section === "enabled-optional-capabilities"),
    "remote-control-surfaces": lines.filter((line) => line.section === "remote-control-surfaces"),
    "security-mode": lines.filter((line) => line.section === "security-mode"),
    "workflow-learning": lines.filter((line) => line.section === "workflow-learning"),
    "spending-policy": lines.filter((line) => line.section === "spending-policy"),
    "verification-checks": lines.filter((line) => line.section === "verification-checks"),
    "launch-handoff": lines.filter((line) => line.section === "launch-handoff"),
    blockers: lines.filter((line) => line.section === "blockers"),
    warnings: lines.filter((line) => line.section === "warnings"),
  };
}

function redactedReview(review: SetupDraftReviewMetadata): SetupDraftReviewMetadata {
  return {
    ...review,
    redacted: true,
    values: redactReviewValues(review.values),
  };
}

function redactReviewValues(
  values: SetupDraftReviewMetadata["values"]
): SetupDraftReviewMetadata["values"] {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => {
      if (isRawSecretKey(key)) {
        return [key, undefined];
      }
      return [key, value];
    })
  );
}

function isRawSecretKey(key: string): boolean {
  return /(token|secret|apiKey)$/iu.test(key) && !/(Env|Included)$/u.test(key);
}

function severityForDraft(draft: SetupDraft): SetupReviewManifestSeverity {
  if (draft.blockers.length > 0) return "blocker";
  if (draft.warnings.length > 0) return "warning";
  return "info";
}

function isSkippedOptionalCapability(draft: SetupDraft): boolean {
  return draft.kind === "optional-capability" && draft.review.values.skipped === true;
}

function isRemoteControlCapability(draft: SetupDraft): boolean {
  return draft.kind === "optional-capability" && draft.review.values.remoteControlIdentityConstraint !== undefined;
}
