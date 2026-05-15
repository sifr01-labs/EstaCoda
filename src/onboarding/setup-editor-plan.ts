import type { SetupEntryState } from "./setup-entry-state.js";
import { scopedPatch, setupEditorAction, type SetupEditorActionDraft } from "./setup-editor-actions.js";

export type SetupEditorPlanMode = "configured" | "configured-degraded" | "repair-first";

export type SetupEditorSectionId =
  | "config-summary"
  | "model-route"
  | "credentials"
  | "security-mode"
  | "workflow-learning"
  | "workspace-trust"
  | "optional-capabilities"
  | "verification"
  | "exit"
  | "config-safety";

export type SetupEditorSensitiveSurface =
  | "config-summary"
  | "provider-selection"
  | "credential-reference"
  | "security-policy"
  | "workflow-learning"
  | "workspace-trust"
  | "optional-capability"
  | "setup-verification"
  | "config-repair"
  | "none";

export type SetupEditorSectionStatus =
  | "ready"
  | "warning"
  | "blocked"
  | "repair-required"
  | "skipped"
  | "unknown";

export type SetupEditorSection = {
  readonly id: SetupEditorSectionId;
  readonly copyKey: `setupEditor.sections.${string}`;
  readonly required: boolean;
  readonly sensitiveSurface: SetupEditorSensitiveSurface;
  readonly status: SetupEditorSectionStatus;
  readonly data: Record<string, unknown>;
  readonly warnings: readonly string[];
  readonly blockers: readonly string[];
  readonly actions: readonly SetupEditorActionDraft[];
};

export type SetupEditorPlan = {
  readonly kind: "guided-setup-editor-plan";
  readonly name: "Guided Setup Editor Architecture";
  readonly mode: SetupEditorPlanMode;
  readonly sourceState: SetupEntryState["kind"];
  readonly safeForNormalConfigEditing: boolean;
  readonly preservesUnrelatedConfig: true;
  readonly configSummary: {
    readonly configSources: readonly string[];
    readonly configPaths: SetupEntryState["configPaths"];
    readonly model?: SetupEntryState["model"];
    readonly providerReadiness: SetupEntryState["providerReadiness"];
    readonly workspaceTrust: SetupEntryState["workspaceTrust"];
    readonly workspaceVerification: SetupEntryState["workspaceVerification"];
    readonly stateDirectoryWritable: boolean;
  };
  readonly warnings: readonly string[];
  readonly blockers: readonly string[];
  readonly sections: readonly SetupEditorSection[];
  readonly actions: readonly SetupEditorActionDraft[];
};

export function buildSetupEditorPlan(state: SetupEntryState): SetupEditorPlan {
  const mode = editorModeFor(state);
  const safeForNormalConfigEditing = state.kind !== "broken-config";
  const sections = safeForNormalConfigEditing
    ? normalSections(state, mode)
    : brokenConfigSections(state);
  const actions = sections.flatMap((section) => section.actions);

  return {
    kind: "guided-setup-editor-plan",
    name: "Guided Setup Editor Architecture",
    mode,
    sourceState: state.kind,
    safeForNormalConfigEditing,
    preservesUnrelatedConfig: true,
    configSummary: {
      configSources: state.configSources,
      configPaths: state.configPaths,
      model: state.model,
      providerReadiness: state.providerReadiness,
      workspaceTrust: state.workspaceTrust,
      workspaceVerification: state.workspaceVerification,
      stateDirectoryWritable: state.stateDirectoryWritable,
    },
    warnings: state.warnings,
    blockers: state.blockers,
    sections,
    actions,
  };
}

function editorModeFor(state: SetupEntryState): SetupEditorPlanMode {
  switch (state.kind) {
    case "configured-ready":
    case "untrusted-workspace":
      return "configured";
    case "configured-degraded":
      return "configured-degraded";
    case "partial-provider":
    case "missing-secret":
    case "broken-config":
    case "state-not-writable":
    case "new-user":
      return "repair-first";
  }
}

function normalSections(state: SetupEntryState, mode: SetupEditorPlanMode): SetupEditorSection[] {
  return [
    configSummarySection(state),
    modelRouteSection(state, mode),
    credentialsSection(state),
    securityModeSection(state),
    workflowLearningSection(state),
    workspaceTrustSection(state),
    optionalCapabilitiesSection(),
    verificationSection(),
    exitSection(),
  ];
}

function brokenConfigSections(state: SetupEntryState): SetupEditorSection[] {
  return [
    configSummarySection(state),
    section({
      id: "config-safety",
      copyKey: "setupEditor.sections.configSafety",
      required: true,
      sensitiveSurface: "config-repair",
      status: "repair-required",
      data: {
        safeForNormalConfigEditing: false,
        error: state.error,
      },
      warnings: state.warnings,
      blockers: state.blockers,
      actions: [
        setupEditorAction({
          id: "repair-broken-config",
          copyKey: "setupEditor.actions.repairBrokenConfig",
          sectionId: "config-safety",
          effect: "diagnostic-only",
          readOnly: true,
          requiresExplicitApply: true,
        }),
      ],
    }),
    verificationSection(),
    exitSection(),
  ];
}

function configSummarySection(state: SetupEntryState): SetupEditorSection {
  return section({
    id: "config-summary",
    copyKey: "setupEditor.sections.configSummary",
    required: true,
    sensitiveSurface: "config-summary",
    status: state.kind === "broken-config" ? "blocked" : "ready",
    data: {
      configSources: state.configSources,
      configPaths: state.configPaths,
      model: state.model,
      providerReadiness: state.providerReadiness,
      workspaceTrust: state.workspaceTrust,
      workspaceVerification: state.workspaceVerification,
      stateDirectoryWritable: state.stateDirectoryWritable,
    },
    warnings: state.kind === "broken-config" ? state.warnings : [],
    blockers: state.kind === "broken-config" ? state.blockers : [],
    actions: [],
  });
}

function modelRouteSection(state: SetupEntryState, mode: SetupEditorPlanMode): SetupEditorSection {
  const repairRequired = state.kind === "partial-provider" || state.providerReadiness === "missing-config";
  const repairOrReviewWarnings = repairRequired || mode === "configured-degraded";
  return section({
    id: "model-route",
    copyKey: "setupEditor.sections.modelRoute",
    required: true,
    sensitiveSurface: "provider-selection",
    status: repairRequired ? "repair-required" : mode === "configured-degraded" ? "warning" : "ready",
    data: {
      model: state.model,
      providerReadiness: state.providerReadiness,
      providerDiagnosticStatus: state.setupVerification.providerDiagnostic.status,
    },
    warnings: mode === "configured-degraded" || state.kind === "partial-provider" ? state.warnings : [],
    blockers: repairRequired ? state.blockers : [],
    actions: [
      ...(repairOrReviewWarnings
        ? [
            setupEditorAction({
              id: "repair-primary-provider",
              copyKey: "setupEditor.actions.repairPrimaryProvider",
              sectionId: "model-route",
              effect: "draft-config-patch",
              readOnly: false,
              requiresExplicitApply: true,
              patch: scopedPatch(["provider.route"]),
            }),
          ]
        : []),
      setupEditorAction({
        id: "edit-primary-model-route",
        copyKey: "setupEditor.actions.editPrimaryModelRoute",
        sectionId: "model-route",
        effect: "draft-config-patch",
        readOnly: false,
        requiresExplicitApply: true,
        patch: scopedPatch(["provider.route"]),
      }),
    ],
  });
}

function credentialsSection(state: SetupEntryState): SetupEditorSection {
  const missingCredentialRefs = credentialRefs(state);
  const blocked = missingCredentialRefs.length > 0 || state.kind === "missing-secret";
  return section({
    id: "credentials",
    copyKey: "setupEditor.sections.credentials",
    required: blocked,
    sensitiveSurface: "credential-reference",
    status: blocked ? "repair-required" : "ready",
    data: {
      missingCredentialRefs,
      envFilePresent: state.setupVerification.envFilePresent,
      envFileSecure: state.setupVerification.envFileSecure,
    },
    warnings: blocked ? state.warnings : [],
    blockers: blocked ? state.blockers : [],
    actions: [
      ...(blocked
        ? [
            setupEditorAction({
              id: "repair-missing-credential",
              copyKey: "setupEditor.actions.repairMissingCredential",
              sectionId: "credentials",
              effect: "draft-config-patch",
              readOnly: false,
              requiresExplicitApply: true,
              patch: scopedPatch(["provider.credentialReference"]),
              credentialRefs: missingCredentialRefs,
            }),
          ]
        : []),
      setupEditorAction({
        id: "edit-primary-credential-reference",
        copyKey: "setupEditor.actions.editPrimaryCredentialReference",
        sectionId: "credentials",
        effect: "draft-config-patch",
        readOnly: false,
        requiresExplicitApply: true,
        patch: scopedPatch(["provider.credentialReference"]),
        credentialRefs: missingCredentialRefs,
      }),
    ],
  });
}

function securityModeSection(state: SetupEntryState): SetupEditorSection {
  return section({
    id: "security-mode",
    copyKey: "setupEditor.sections.securityMode",
    required: true,
    sensitiveSurface: "security-policy",
    status: "ready",
    data: {
      value: state.setupVerification.securityModeValue,
      label: state.setupVerification.securityModeLabel,
    },
    warnings: [],
    blockers: [],
    actions: [
      setupEditorAction({
        id: "edit-security-mode",
        copyKey: "setupEditor.actions.editSecurityMode",
        sectionId: "security-mode",
        effect: "draft-config-patch",
        readOnly: false,
        requiresExplicitApply: true,
        patch: scopedPatch(["security.approvalMode"]),
        reviewValues: {
          securityMode: state.setupVerification.securityModeValue,
        },
      }),
    ],
  });
}

function workflowLearningSection(state: SetupEntryState): SetupEditorSection {
  return section({
    id: "workflow-learning",
    copyKey: "setupEditor.sections.workflowLearning",
    required: true,
    sensitiveSurface: "workflow-learning",
    status: "ready",
    data: {
      value: state.setupVerification.skillAutonomyValue,
      label: state.setupVerification.skillAutonomyLabel,
    },
    warnings: [],
    blockers: [],
    actions: [
      setupEditorAction({
        id: "edit-workflow-learning",
        copyKey: "setupEditor.actions.editWorkflowLearning",
        sectionId: "workflow-learning",
        effect: "draft-config-patch",
        readOnly: false,
        requiresExplicitApply: true,
        patch: scopedPatch(["skills.autonomy"]),
        reviewValues: {
          workflowLearning: state.setupVerification.skillAutonomyValue,
        },
      }),
    ],
  });
}

function workspaceTrustSection(state: SetupEntryState): SetupEditorSection {
  const untrusted = state.kind === "untrusted-workspace" || state.workspaceTrust === "untrusted";
  return section({
    id: "workspace-trust",
    copyKey: "setupEditor.sections.workspaceTrust",
    required: true,
    sensitiveSurface: "workspace-trust",
    status: untrusted ? "repair-required" : "ready",
    data: {
      workspaceTrust: state.workspaceTrust,
      workspaceVerification: state.workspaceVerification,
    },
    warnings: untrusted ? state.warnings : [],
    blockers: untrusted ? state.blockers : [],
    actions: untrusted
      ? [
          setupEditorAction({
            id: "repair-workspace-trust",
            copyKey: "setupEditor.actions.repairWorkspaceTrust",
            sectionId: "workspace-trust",
            effect: "draft-trust-repair",
            readOnly: false,
            requiresExplicitApply: true,
          }),
        ]
      : [],
  });
}

function optionalCapabilitiesSection(): SetupEditorSection {
  return section({
    id: "optional-capabilities",
    copyKey: "setupEditor.sections.optionalCapabilities",
    required: false,
    sensitiveSurface: "optional-capability",
    status: "skipped",
    data: {
      independentlyReviewable: true,
      capabilities: ["channels", "voice", "vision", "browser"],
    },
    warnings: [],
    blockers: [],
    actions: [
      setupEditorAction({
        id: "review-optional-capabilities",
        copyKey: "setupEditor.actions.reviewOptionalCapabilities",
        sectionId: "optional-capabilities",
        effect: "draft-config-patch",
        readOnly: false,
        requiresExplicitApply: true,
        patch: scopedPatch(["channels", "voice", "vision", "browser"]),
      }),
    ],
  });
}

function verificationSection(): SetupEditorSection {
  return section({
    id: "verification",
    copyKey: "setupEditor.sections.verification",
    required: true,
    sensitiveSurface: "setup-verification",
    status: "ready",
    data: {
      readOnly: true,
    },
    warnings: [],
    blockers: [],
    actions: [
      setupEditorAction({
        id: "run-readonly-verification",
        copyKey: "setupEditor.actions.runReadonlyVerification",
        sectionId: "verification",
        effect: "read-only-verification",
        readOnly: true,
        requiresExplicitApply: false,
      }),
    ],
  });
}

function exitSection(): SetupEditorSection {
  return section({
    id: "exit",
    copyKey: "setupEditor.sections.exit",
    required: false,
    sensitiveSurface: "none",
    status: "ready",
    data: {},
    warnings: [],
    blockers: [],
    actions: [
      setupEditorAction({
        id: "cancel-setup-editor",
        copyKey: "setupEditor.actions.cancelSetupEditor",
        sectionId: "exit",
        effect: "exit",
        readOnly: true,
        requiresExplicitApply: false,
      }),
    ],
  });
}

function credentialRefs(state: SetupEntryState): NonNullable<SetupEditorActionDraft["credentialRefs"]> {
  return [
    ...state.missingCredentials.envVars.map((name) => ({ kind: "env" as const, name, value: "not-included" as const })),
    ...state.missingCredentials.providers.map((provider) => ({ kind: "env" as const, name: `${provider.toUpperCase()}_API_KEY`, value: "not-included" as const })),
  ].sort((a, b) => a.name.localeCompare(b.name));
}

function section(input: SetupEditorSection): SetupEditorSection {
  return input;
}
