import type { SetupEditorPlanSession } from "./setup-router.js";
import type { OnboardingOptionalCapabilityDraftId, OnboardingWizardState } from "./onboarding-wizard/state.js";
import type { SetupEditorActionDraft, SetupEditorActionId, SetupEditorPatchField } from "./setup-editor-actions.js";
import type { SetupEditorSectionId, SetupEditorSensitiveSurface } from "./setup-editor-plan.js";

export type OnboardingWizardDraftStepId =
  | "interface-language"
  | "workspace-trust"
  | "primary-model"
  | "primary-credential"
  | "security-mode"
  | "workflow-learning"
  | "optional-capabilities"
  | "verify";

export type SetupDraftSource =
  | {
      readonly kind: "onboarding-wizard";
      readonly stepId: OnboardingWizardDraftStepId;
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
  | "fallback-model-route"
  | "auxiliary-model-route"
  | "credential-reference"
  | "security-mode"
  | "workflow-learning"
  | "ui-preferences"
  | "workspace-trust"
  | "optional-capability"
  | "verification"
  | "launch-handoff"
  | "diagnostic-blocker"
  | "exit";

export type SetupDraftRiskSurface =
  | "provider-selection"
  | "credential-reference"
  | "security-policy"
  | "workflow-learning"
  | "interface-preference"
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
  readonly values: Record<string, string | readonly string[] | boolean | number | undefined>;
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
  | "onboarding-wizard-state"
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

export function buildOnboardingWizardDraftBundle(
  state: OnboardingWizardState,
  options: SetupDraftBundleOptions = {}
): SetupDraftBundle {
  const drafts = [
    onboardingUiPreferencesDraft(state, options),
    onboardingProviderModelDraft(state, options),
    onboardingCredentialDraft(state, options),
    onboardingSecurityDraft(state, options),
    onboardingAgentEvolutionDraft(state, options),
    onboardingWorkspaceTrustDraft(state, options),
    ...onboardingOptionalCapabilityDrafts(state, options),
    verificationDraft({ kind: "onboarding-wizard", stepId: "verify" }),
  ].filter((draft): draft is SetupDraft => draft !== undefined);

  return bundle("onboarding-wizard-state", "onboarding-wizard:state", drafts, [], []);
}

export function buildSetupEditorDraftBundle(
  session: SetupEditorPlanSession,
  options: SetupDraftBundleOptions = {}
): SetupDraftBundle {
  const drafts = session.plan.actions.map((action) => draftFromEditorAction(action, options));
  return buildSetupEditorDraftBundleFromActions(session, drafts);
}

export function buildSetupEditorActionDraftBundle(
  session: SetupEditorPlanSession,
  actions: readonly SetupEditorActionDraft[],
  options: SetupDraftBundleOptions = {}
): SetupDraftBundle {
  const drafts = actions.map((action) => draftFromEditorAction(action, options));
  return buildSetupEditorDraftBundleFromActions(session, drafts);
}

function buildSetupEditorDraftBundleFromActions(
  session: SetupEditorPlanSession,
  drafts: readonly SetupDraft[]
): SetupDraftBundle {
  return bundle(
    "setup-editor-plan-session",
    `setup-editor:${session.plan.sourceState}`,
    drafts,
    session.plan.blockers,
    session.plan.warnings,
    session.plan.safeForNormalConfigEditing
  );
}

function onboardingUiPreferencesDraft(
  state: OnboardingWizardState,
  options: SetupDraftBundleOptions
): SetupDraft | undefined {
  const preferences = state.interfacePreferences;
  if (preferences?.language === undefined || preferences.flavor === undefined || preferences.activityLabels === undefined) {
    return undefined;
  }
  return configDraft({
    id: "onboarding-wizard.ui-preferences",
    kind: "ui-preferences",
    source: { kind: "onboarding-wizard", stepId: "interface-language" },
    riskSurface: "interface-preference",
    scope: ["ui.language", "ui.flavor", "ui.activityLabels"],
    configPath: options.configPath,
    summaryKey: "setupDrafts.uiPreferences.summary",
    values: {
      language: preferences?.language,
      flavor: preferences?.flavor,
      activityLabels: preferences?.activityLabels,
    },
  });
}

function onboardingProviderModelDraft(
  state: OnboardingWizardState,
  options: SetupDraftBundleOptions
): SetupDraft | undefined {
  const route = state.primaryRoute;
  if (route?.provider === undefined && route?.model === undefined) return undefined;
  return configDraft({
    id: "onboarding-wizard.provider-model-route",
    kind: "provider-model-route",
    source: { kind: "onboarding-wizard", stepId: "primary-model" },
    riskSurface: "provider-selection",
    scope: ["model.provider", "model.id"],
    configPath: options.configPath,
    summaryKey: "setupDrafts.providerModelRoute.summary",
    values: {
      provider: route?.provider,
      model: route?.model,
      baseUrl: route?.baseUrl,
      contextWindowTokens: route?.contextWindowTokens,
      apiMode: route?.apiMode,
      authMethod: route?.authMethod,
    },
  });
}

function onboardingCredentialDraft(
  state: OnboardingWizardState,
  options: SetupDraftBundleOptions
): SetupDraft | undefined {
  const envVarName = state.credential?.envVarName;
  if (envVarName === undefined || envVarName.trim().length === 0) return undefined;
  return credentialDraft({
    id: "onboarding-wizard.credential-reference",
    source: { kind: "onboarding-wizard", stepId: "primary-credential" },
    configPath: options.configPath,
    envVars: [envVarName],
    provider: state.primaryRoute?.provider,
    model: state.primaryRoute?.model,
  });
}

function onboardingSecurityDraft(
  state: OnboardingWizardState,
  options: SetupDraftBundleOptions
): SetupDraft | undefined {
  if (state.securityMode === undefined) return undefined;
  return configDraft({
    id: "onboarding-wizard.security-mode",
    kind: "security-mode",
    source: { kind: "onboarding-wizard", stepId: "security-mode" },
    riskSurface: "security-policy",
    scope: ["security.approvalMode"],
    configPath: options.configPath,
    summaryKey: "setupDrafts.securityMode.summary",
    values: { securityMode: state.securityMode },
  });
}

function onboardingAgentEvolutionDraft(
  state: OnboardingWizardState,
  options: SetupDraftBundleOptions
): SetupDraft | undefined {
  if (state.agentEvolution === undefined) return undefined;
  return configDraft({
    id: "onboarding-wizard.workflow-learning",
    kind: "workflow-learning",
    source: { kind: "onboarding-wizard", stepId: "workflow-learning" },
    riskSurface: "workflow-learning",
    scope: ["skills.autonomy"],
    configPath: options.configPath,
    summaryKey: "setupDrafts.workflowLearning.summary",
    values: { workflowLearning: state.agentEvolution },
  });
}

function onboardingWorkspaceTrustDraft(
  state: OnboardingWizardState,
  options: SetupDraftBundleOptions
): SetupDraft | undefined {
  if (state.workspace?.trustStatus !== "trusted") return undefined;
  return workspaceTrustDraft({
    id: "onboarding-wizard.workspace-trust",
    source: { kind: "onboarding-wizard", stepId: "workspace-trust" },
    workspaceRoot: options.workspaceRoot ?? state.workspace.path ?? "",
    trustStorePath: options.trustStorePath ?? "",
  });
}

function onboardingOptionalCapabilitiesDraft(
  state: OnboardingWizardState,
  options: SetupDraftBundleOptions
): SetupDraft | undefined {
  const capabilities = onboardingSelectedOptionalCapabilities(state);
  const hasExplicitSelection = state.optionalCapabilities?.selected !== undefined;
  if (capabilities.length === 0 && !hasExplicitSelection) return undefined;
  return configDraft({
    id: "onboarding-wizard.optional-capabilities",
    kind: "optional-capability",
    source: { kind: "onboarding-wizard", stepId: "optional-capabilities" },
    riskSurface: "optional-capability",
    scope: ["channels", "voice", "browser"],
    configPath: options.configPath,
    summaryKey: "setupDrafts.optionalCapabilities.summary",
    values: {
      skipped: capabilities.length === 0,
      capabilities,
    },
    requiresReview: false,
  });
}

function onboardingOptionalCapabilityDrafts(
  state: OnboardingWizardState,
  options: SetupDraftBundleOptions
): readonly (SetupDraft | undefined)[] {
  if (state.optionalCapabilityDrafts !== undefined) {
    return state.optionalCapabilityDrafts;
  }
  return [onboardingOptionalCapabilitiesDraft(state, options)];
}

function onboardingSelectedOptionalCapabilities(
  state: OnboardingWizardState
): readonly OnboardingOptionalCapabilityDraftId[] {
  const selected = state.optionalCapabilities?.selected;
  if (selected !== undefined) return selected;

  const capabilities: OnboardingOptionalCapabilityDraftId[] = [];
  if (
    state.optionalCapabilities?.channels?.telegram === "configured" ||
    state.optionalCapabilities?.channels?.whatsapp === "configured"
  ) {
    capabilities.push("channels");
  }
  if (
    state.optionalCapabilities?.voice?.stt === "configured" ||
    state.optionalCapabilities?.voice?.tts === "configured"
  ) {
    capabilities.push("voice");
  }
  if (state.optionalCapabilities?.browser === "configured") capabilities.push("browser");
  return capabilities;
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

  if (action.id === "edit-security-mode") {
    return configDraft({
      id: editorDraftId(action),
      kind: "security-mode",
      source,
      riskSurface: "security-policy",
      scope: action.patch?.fields ?? [],
      configPath: options.configPath,
      summaryKey: "setupDrafts.securityMode.summary",
      values: action.reviewValues ?? {},
    });
  }

  if (action.id === "edit-workflow-learning") {
    return configDraft({
      id: editorDraftId(action),
      kind: "workflow-learning",
      source,
      riskSurface: "workflow-learning",
      scope: action.patch?.fields ?? [],
      configPath: options.configPath,
      summaryKey: "setupDrafts.workflowLearning.summary",
      values: action.reviewValues ?? {},
    });
  }

  if (action.id === "edit-language") {
    return configDraft({
      id: editorDraftId(action),
      kind: "ui-preferences",
      source,
      riskSurface: "interface-preference",
      scope: action.patch?.fields ?? ["ui.language", "ui.flavor", "ui.activityLabels"],
      configPath: options.configPath,
      summaryKey: "setupDrafts.uiPreferences.summary",
      values: action.reviewValues ?? {},
    });
  }

  if (action.id === "edit-primary-model-route" || action.id === "repair-primary-provider") {
    return configDraft({
      id: editorDraftId(action),
      kind: "provider-model-route",
      source,
      riskSurface: "provider-selection",
      scope: action.patch?.fields ?? ["provider.route"],
      configPath: options.configPath,
      summaryKey: "setupDrafts.providerModelRoute.summary",
      values: action.reviewValues ?? {},
    });
  }

  if (action.id === "edit-fallback-model-route") {
    return configDraft({
      id: editorDraftId(action),
      kind: "fallback-model-route",
      source,
      riskSurface: "provider-selection",
      scope: ["model.fallbacks"],
      configPath: options.configPath,
      summaryKey: fallbackRouteSummaryKey(action.reviewValues),
      values: action.reviewValues ?? {},
    });
  }

  if (action.id === "edit-auxiliary-model-route") {
    return configDraft({
      id: editorDraftId(action),
      kind: "auxiliary-model-route",
      source,
      riskSurface: "provider-selection",
      scope: ["auxiliaryModels.*"],
      configPath: options.configPath,
      summaryKey: "setupDrafts.auxiliaryModelRoute.summary",
      values: action.reviewValues ?? {},
    });
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

  if (action.id === "repair-broken-config" || action.id === "repair-state-directory") {
    return {
      id: editorDraftId(action),
      kind: "diagnostic-blocker",
      source,
      riskSurface: "config-repair",
      target: { kind: "diagnostic-only" },
      review: review(action.id === "repair-state-directory"
        ? "setupDrafts.stateDirectory.summary"
        : "setupDrafts.brokenConfig.summary", {}),
      applyIntent: intent("diagnostic-only"),
      requiresReview: true,
      readOnly: true,
      blockers: [action.id === "repair-state-directory"
        ? "Normal config editing is blocked until the EstaCoda state directory is writable."
        : "Normal config editing is blocked until config can be parsed."],
      warnings: [],
    };
  }

  if (
    action.credentialRefs !== undefined ||
    action.id === "store-provider-credential-reference" ||
    action.id === "edit-primary-credential-reference" ||
    action.id === "repair-missing-credential"
  ) {
    const envVar = stringReviewValue(action.reviewValues?.apiKeyEnv);
    const credentialRefs = action.credentialRefs?.map((ref) => ref.name) ?? [];
    return credentialDraft({
      id: editorDraftId(action),
      source,
      configPath: options.configPath,
      scope: action.patch?.fields ?? ["provider.credentialReference"],
      envVars: envVar === undefined ? credentialRefs : [envVar],
      provider: stringReviewValue(action.reviewValues?.provider),
      model: stringReviewValue(action.reviewValues?.model),
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
  readonly scope?: readonly SetupEditorPatchField[];
  readonly envVars: readonly string[];
  readonly provider?: string;
  readonly model?: string;
}): SetupDraft {
  return {
    id: input.id,
    kind: "credential-reference",
    source: input.source,
    riskSurface: "credential-reference",
    target: {
      kind: "config-scope",
      scope: input.scope ?? ["providers.*.apiKeyEnv"],
      path: input.configPath,
      preserveUnrelatedConfig: true,
    },
    review: review("setupDrafts.credentialReference.summary", {
      envVars: [...new Set(input.envVars)].sort(),
      credentialValuesIncluded: false,
      provider: input.provider,
      model: input.model,
    }),
    applyIntent: intent("credential-reference"),
    preserveUnrelatedConfig: true,
    requiresReview: true,
    readOnly: false,
    blockers: [],
    warnings: [],
  };
}

function stringReviewValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function fallbackRouteSummaryKey(reviewValues: SetupEditorActionDraft["reviewValues"]): string {
  return reviewValues?.fallbackOperation === "replace"
    ? "setupDrafts.fallbackModelRoute.replace.summary"
    : "setupDrafts.fallbackModelRoute.add.summary";
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
    case "edit-fallback-model-route":
      return "fallback-model-route";
    case "edit-auxiliary-model-route":
      return "auxiliary-model-route";
    case "edit-security-mode":
      return "security-mode";
    case "edit-workflow-learning":
      return "workflow-learning";
    case "edit-language":
      return "ui-preferences";
    case "review-optional-capabilities":
    case "configure-channels":
    case "configure-voice":
    case "configure-image-generation":
    case "configure-browser":
      return "optional-capability";
    case "repair-state-directory":
      return "diagnostic-blocker";
    case "store-provider-credential-reference":
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
    "interface-preference": "interface-preference",
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
          : action.sectionId === "interface-preference"
            ? "interface-preference"
            : action.sectionId === "optional-capabilities"
              ? "optional-capability"
              : action.sectionId === "config-safety"
                ? "config-repair"
                : "none"];
}
