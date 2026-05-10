import type { FirstRunPlanSession, SetupEditorPlanSession } from "./setup-router.js";
import type { FirstRunOnboardingStepId, FirstRunOnboardingSelections } from "./first-run-plan.js";
import type { SetupEditorActionDraft, SetupEditorActionId, SetupEditorPatchField } from "./setup-editor-actions.js";
import type { SetupEditorSectionId, SetupEditorSensitiveSurface } from "./setup-editor-plan.js";

export type SetupDraftSource =
  | {
      readonly kind: "first-run";
      readonly stepId: FirstRunOnboardingStepId;
    }
  | {
      readonly kind: "setup-editor";
      readonly sectionId: SetupEditorSectionId;
      readonly actionId: SetupEditorActionId;
    }
  | {
      readonly kind: "setup-module";
      readonly moduleId: string;
      readonly actionId: string;
    };

export type SetupDraftKind =
  | "provider-model-route"
  | "credential-reference"
  | "security-mode"
  | "workflow-learning"
  | "workspace-trust"
  | "optional-capability"
  | "verification"
  | "launch-handoff"
  | "future-model-fallback"
  | "diagnostic-blocker"
  | "exit";

export type SetupDraftRiskSurface =
  | "provider-selection"
  | "credential-reference"
  | "security-policy"
  | "workflow-learning"
  | "workspace-trust"
  | "optional-capability"
  | "setup-verification"
  | "agent-launch"
  | "config-repair"
  | "none";

export type SetupDraftTarget =
  | {
      readonly kind: "config-scope";
      readonly scope: readonly SetupEditorPatchField[];
      readonly path?: string;
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

export type SetupDraftReviewMetadata = {
  readonly copyKey: string;
  readonly summaryKey: string;
  readonly redacted: true;
  readonly values: Record<string, string | readonly string[] | boolean | undefined>;
};

export type SetupDraftApplyIntent = {
  readonly kind: "dry-run-apply-intent";
  readonly effect:
    | "config-patch"
    | "credential-reference"
    | "trust-grant"
    | "verification"
    | "launch-handoff"
    | "diagnostic-only"
    | "exit";
  readonly dryRunOnly: true;
  readonly writesConfig: false;
  readonly writesTrustStore: false;
};

export type SetupDraft = {
  readonly id: string;
  readonly kind: SetupDraftKind;
  readonly source: SetupDraftSource;
  readonly riskSurface: SetupDraftRiskSurface;
  readonly target: SetupDraftTarget;
  readonly review: SetupDraftReviewMetadata;
  readonly applyIntent: SetupDraftApplyIntent;
  readonly preserveUnrelatedConfig?: true;
  readonly requiresReview: boolean;
  readonly readOnly: boolean;
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
};

export type SetupDraftBundleSourceKind =
  | "first-run-plan-session"
  | "setup-editor-plan-session"
  | "setup-module-session";

export type SetupDraftBundle = {
  readonly kind: "setup-draft-bundle";
  readonly sourceKind: SetupDraftBundleSourceKind;
  readonly sourceId: string;
  readonly drafts: readonly SetupDraft[];
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
  readonly safeToApplyLater: boolean;
  readonly metadata: {
    readonly draftCount: number;
    readonly requiresReviewCount: number;
    readonly readOnlyCount: number;
  };
};

export type SetupDraftBundleOptions = {
  readonly configPath?: string;
  readonly workspaceRoot?: string;
  readonly trustStorePath?: string;
};

export function buildFirstRunDraftBundle(
  session: FirstRunPlanSession,
  options: SetupDraftBundleOptions = {}
): SetupDraftBundle {
  const selections = session.plan.selections;
  const drafts = [
    firstRunProviderModelDraft(selections, options),
    firstRunCredentialDraft(selections, options),
    firstRunSecurityDraft(selections, options),
    firstRunWorkflowDraft(selections, options),
    firstRunWorkspaceTrustDraft(selections, options),
    firstRunOptionalCapabilitiesDraft(selections, options),
    verificationDraft({ kind: "first-run", stepId: "verify" }),
    launchDraft(selections),
  ].filter((draft): draft is SetupDraft => draft !== undefined);

  return bundle("first-run-plan-session", "first-run:welcome", drafts, [], []);
}

export function buildSetupEditorDraftBundle(
  session: SetupEditorPlanSession,
  options: SetupDraftBundleOptions = {}
): SetupDraftBundle {
  const drafts = session.plan.actions.map((action) => draftFromEditorAction(action, options));
  return bundle(
    "setup-editor-plan-session",
    `setup-editor:${session.plan.sourceState}`,
    drafts,
    session.plan.blockers,
    session.plan.warnings,
    session.plan.safeForNormalConfigEditing
  );
}

function firstRunProviderModelDraft(
  selections: FirstRunOnboardingSelections,
  options: SetupDraftBundleOptions
): SetupDraft | undefined {
  if (selections.primaryProvider === undefined && selections.primaryModel === undefined) return undefined;
  return configDraft({
    id: "first-run.provider-model-route",
    kind: "provider-model-route",
    source: { kind: "first-run", stepId: "primary-model" },
    riskSurface: "provider-selection",
    scope: ["model.provider", "model.id"],
    configPath: options.configPath,
    summaryKey: "setupDrafts.providerModelRoute.summary",
    values: {
      provider: selections.primaryProvider,
      model: selections.primaryModel,
    },
  });
}

function firstRunCredentialDraft(
  selections: FirstRunOnboardingSelections,
  options: SetupDraftBundleOptions
): SetupDraft | undefined {
  if (selections.primaryCredential === undefined || selections.primaryCredential.kind === "none") return undefined;
  return credentialDraft({
    id: "first-run.credential-reference",
    source: { kind: "first-run", stepId: "primary-credential" },
    configPath: options.configPath,
    envVars: [selections.primaryCredential.name],
  });
}

function firstRunSecurityDraft(
  selections: FirstRunOnboardingSelections,
  options: SetupDraftBundleOptions
): SetupDraft | undefined {
  if (selections.securityMode === undefined) return undefined;
  return configDraft({
    id: "first-run.security-mode",
    kind: "security-mode",
    source: { kind: "first-run", stepId: "security-mode" },
    riskSurface: "security-policy",
    scope: ["security.approvalMode"],
    configPath: options.configPath,
    summaryKey: "setupDrafts.securityMode.summary",
    values: { securityMode: selections.securityMode },
  });
}

function firstRunWorkflowDraft(
  selections: FirstRunOnboardingSelections,
  options: SetupDraftBundleOptions
): SetupDraft | undefined {
  if (selections.workflowLearning === undefined) return undefined;
  return configDraft({
    id: "first-run.workflow-learning",
    kind: "workflow-learning",
    source: { kind: "first-run", stepId: "workflow-learning" },
    riskSurface: "workflow-learning",
    scope: ["skills.autonomy"],
    configPath: options.configPath,
    summaryKey: "setupDrafts.workflowLearning.summary",
    values: { workflowLearning: selections.workflowLearning },
  });
}

function firstRunWorkspaceTrustDraft(
  selections: FirstRunOnboardingSelections,
  options: SetupDraftBundleOptions
): SetupDraft | undefined {
  if (selections.workspaceTrusted !== true) return undefined;
  return workspaceTrustDraft({
    id: "first-run.workspace-trust",
    source: { kind: "first-run", stepId: "workspace-trust" },
    workspaceRoot: options.workspaceRoot ?? selections.workspaceRoot ?? "",
    trustStorePath: options.trustStorePath ?? "",
  });
}

function firstRunOptionalCapabilitiesDraft(
  selections: FirstRunOnboardingSelections,
  options: SetupDraftBundleOptions
): SetupDraft | undefined {
  if (selections.optionalCapabilities === undefined && selections.optionalCapabilitiesSkipped !== true) return undefined;
  return configDraft({
    id: "first-run.optional-capabilities",
    kind: "optional-capability",
    source: { kind: "first-run", stepId: "optional-capabilities" },
    riskSurface: "optional-capability",
    scope: ["channels", "voice", "vision", "browser"],
    configPath: options.configPath,
    summaryKey: "setupDrafts.optionalCapabilities.summary",
    values: {
      skipped: selections.optionalCapabilitiesSkipped === true,
      capabilities: selections.optionalCapabilities ?? [],
    },
    requiresReview: false,
  });
}

function launchDraft(selections: FirstRunOnboardingSelections): SetupDraft | undefined {
  if (selections.launchSelected === undefined) return undefined;
  return {
    id: "first-run.launch-handoff",
    kind: "launch-handoff",
    source: { kind: "first-run", stepId: "launch" },
    riskSurface: "agent-launch",
    target: {
      kind: "launch",
      preference: selections.launchSelected ? "offer-after-verify" : "skip-launch",
    },
    review: review("setupDrafts.launch.summary", { launchSelected: selections.launchSelected }),
    applyIntent: intent("launch-handoff"),
    requiresReview: false,
    readOnly: true,
    blockers: [],
    warnings: [],
  };
}

function draftFromEditorAction(
  action: SetupEditorActionDraft,
  options: SetupDraftBundleOptions
): SetupDraft {
  const source: SetupDraftSource = {
    kind: "setup-editor",
    sectionId: action.sectionId,
    actionId: action.id,
  };

  if (action.id === "repair-workspace-trust") {
    return workspaceTrustDraft({
      id: editorDraftId(action),
      source,
      workspaceRoot: options.workspaceRoot ?? "",
      trustStorePath: options.trustStorePath ?? "",
    });
  }

  if (action.id === "run-readonly-verification") {
    return verificationDraft(source);
  }

  if (action.id === "cancel-setup-editor") {
    return {
      id: editorDraftId(action),
      kind: "exit",
      source,
      riskSurface: "none",
      target: { kind: "diagnostic-only" },
      review: review("setupDrafts.exit.summary", {}),
      applyIntent: intent("exit"),
      requiresReview: false,
      readOnly: true,
      blockers: [],
      warnings: [],
    };
  }

  if (action.id === "repair-broken-config") {
    return {
      id: editorDraftId(action),
      kind: "diagnostic-blocker",
      source,
      riskSurface: "config-repair",
      target: { kind: "diagnostic-only" },
      review: review("setupDrafts.brokenConfig.summary", {}),
      applyIntent: intent("diagnostic-only"),
      requiresReview: true,
      readOnly: true,
      blockers: ["Normal config editing is blocked until config can be parsed."],
      warnings: [],
    };
  }

  if (action.credentialRefs !== undefined || action.id === "edit-primary-credential-reference" || action.id === "repair-missing-credential") {
    return credentialDraft({
      id: editorDraftId(action),
      source,
      configPath: options.configPath,
      envVars: action.credentialRefs?.map((ref) => ref.name) ?? [],
    });
  }

  return configDraft({
    id: editorDraftId(action),
    kind: kindForEditorAction(action),
    source,
    riskSurface: riskSurfaceForAction(action),
    scope: action.patch?.fields ?? [],
    configPath: options.configPath,
    summaryKey: `setupDrafts.${action.id}.summary`,
    values: { actionId: action.id },
  });
}

function configDraft(input: {
  readonly id: string;
  readonly kind: SetupDraftKind;
  readonly source: SetupDraftSource;
  readonly riskSurface: SetupDraftRiskSurface;
  readonly scope: readonly SetupEditorPatchField[];
  readonly configPath?: string;
  readonly summaryKey: string;
  readonly values: SetupDraftReviewMetadata["values"];
  readonly requiresReview?: boolean;
}): SetupDraft {
  return {
    id: input.id,
    kind: input.kind,
    source: input.source,
    riskSurface: input.riskSurface,
    target: {
      kind: "config-scope",
      scope: input.scope,
      path: input.configPath,
      preserveUnrelatedConfig: true,
    },
    review: review(input.summaryKey, input.values),
    applyIntent: intent("config-patch"),
    preserveUnrelatedConfig: true,
    requiresReview: input.requiresReview ?? true,
    readOnly: false,
    blockers: [],
    warnings: [],
  };
}

function credentialDraft(input: {
  readonly id: string;
  readonly source: SetupDraftSource;
  readonly configPath?: string;
  readonly envVars: readonly string[];
}): SetupDraft {
  return {
    id: input.id,
    kind: "credential-reference",
    source: input.source,
    riskSurface: "credential-reference",
    target: {
      kind: "config-scope",
      scope: ["providers.*.apiKeyEnv"],
      path: input.configPath,
      preserveUnrelatedConfig: true,
    },
    review: review("setupDrafts.credentialReference.summary", {
      envVars: [...new Set(input.envVars)].sort(),
      credentialValuesIncluded: false,
    }),
    applyIntent: intent("credential-reference"),
    preserveUnrelatedConfig: true,
    requiresReview: true,
    readOnly: false,
    blockers: [],
    warnings: [],
  };
}

function workspaceTrustDraft(input: {
  readonly id: string;
  readonly source: SetupDraftSource;
  readonly workspaceRoot: string;
  readonly trustStorePath: string;
}): SetupDraft {
  return {
    id: input.id,
    kind: "workspace-trust",
    source: input.source,
    riskSurface: "workspace-trust",
    target: {
      kind: "trust-store",
      workspaceRoot: input.workspaceRoot,
      trustStorePath: input.trustStorePath,
    },
    review: review("setupDrafts.workspaceTrust.summary", {
      workspaceRoot: input.workspaceRoot,
      trustStorePath: input.trustStorePath,
    }),
    applyIntent: intent("trust-grant"),
    requiresReview: true,
    readOnly: false,
    blockers: [],
    warnings: [],
  };
}

function verificationDraft(source: SetupDraftSource): SetupDraft {
  return {
    id: `${source.kind}.verification`,
    kind: "verification",
    source,
    riskSurface: "setup-verification",
    target: { kind: "verification", readOnly: true },
    review: review("setupDrafts.verification.summary", { readOnly: true }),
    applyIntent: intent("verification"),
    requiresReview: false,
    readOnly: true,
    blockers: [],
    warnings: [],
  };
}

function bundle(
  sourceKind: SetupDraftBundleSourceKind,
  sourceId: string,
  drafts: readonly SetupDraft[],
  blockers: readonly string[],
  warnings: readonly string[],
  safeToApplyLater = true
): SetupDraftBundle {
  return {
    kind: "setup-draft-bundle",
    sourceKind,
    sourceId,
    drafts,
    blockers,
    warnings,
    safeToApplyLater: safeToApplyLater && blockers.length === 0,
    metadata: {
      draftCount: drafts.length,
      requiresReviewCount: drafts.filter((draft) => draft.requiresReview).length,
      readOnlyCount: drafts.filter((draft) => draft.readOnly).length,
    },
  };
}

function review(
  summaryKey: string,
  values: SetupDraftReviewMetadata["values"]
): SetupDraftReviewMetadata {
  return {
    copyKey: "setupDrafts.review",
    summaryKey,
    redacted: true,
    values,
  };
}

function intent(effect: SetupDraftApplyIntent["effect"]): SetupDraftApplyIntent {
  return {
    kind: "dry-run-apply-intent",
    effect,
    dryRunOnly: true,
    writesConfig: false,
    writesTrustStore: false,
  };
}

function editorDraftId(action: SetupEditorActionDraft): string {
  return `setup-editor.${action.sectionId}.${action.id}`;
}

function kindForEditorAction(action: SetupEditorActionDraft): SetupDraftKind {
  switch (action.id) {
    case "edit-primary-model-route":
    case "repair-primary-provider":
      return "provider-model-route";
    case "edit-security-mode":
      return "security-mode";
    case "edit-workflow-learning":
      return "workflow-learning";
    case "review-optional-capabilities":
      return "optional-capability";
    case "repair-state-directory":
      return "diagnostic-blocker";
    case "edit-primary-credential-reference":
    case "repair-missing-credential":
    case "repair-workspace-trust":
    case "run-readonly-verification":
    case "repair-broken-config":
    case "cancel-setup-editor":
      return "diagnostic-blocker";
  }
}

function riskSurfaceForAction(action: SetupEditorActionDraft): SetupDraftRiskSurface {
  const surfaceMap: Record<SetupEditorSensitiveSurface, SetupDraftRiskSurface> = {
    "config-summary": "none",
    "provider-selection": "provider-selection",
    "credential-reference": "credential-reference",
    "security-policy": "security-policy",
    "workflow-learning": "workflow-learning",
    "workspace-trust": "workspace-trust",
    "optional-capability": "optional-capability",
    "setup-verification": "setup-verification",
    "config-repair": "config-repair",
    none: "none",
  };
  return surfaceMap[action.sectionId === "model-route"
    ? "provider-selection"
    : action.sectionId === "credentials"
      ? "credential-reference"
      : action.sectionId === "security-mode"
        ? "security-policy"
        : action.sectionId === "workflow-learning"
          ? "workflow-learning"
          : action.sectionId === "optional-capabilities"
            ? "optional-capability"
            : action.sectionId === "config-safety"
              ? "config-repair"
              : "none"];
}
