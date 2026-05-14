import type { ActivityLabelsLocale, UiFlavor, UiLanguage } from "../config/runtime-config.js";
import { getDefaultApiKeyEnv } from "../providers/provider-metadata.js";
import type { ProviderId } from "../contracts/provider.js";
import type { SecurityApprovalMode } from "../contracts/security.js";
import type { SkillAutonomy } from "../skills/skill-learning.js";

export type FirstRunOnboardingStepId =
  | "welcome"
  | "interface-language"
  | "workspace-root"
  | "workspace-trust"
  | "primary-provider"
  | "primary-model"
  | "primary-credential"
  | "security-mode"
  | "workflow-learning"
  | "optional-capabilities"
  | "review"
  | "save"
  | "verify"
  | "launch";

export const FIRST_RUN_ONBOARDING_STEP_IDS: readonly FirstRunOnboardingStepId[] = [
  "welcome",
  "interface-language",
  "workspace-root",
  "workspace-trust",
  "primary-provider",
  "primary-model",
  "primary-credential",
  "security-mode",
  "workflow-learning",
  "optional-capabilities",
  "review",
  "save",
  "verify",
  "launch",
] as const;

export type FirstRunOnboardingCopyKey =
  | "onboarding.welcome"
  | "onboarding.interfaceLanguage"
  | "onboarding.workspace.root"
  | "onboarding.workspace.trust"
  | "onboarding.providers.primary"
  | "onboarding.providers.primaryModel"
  | "onboarding.providers.primaryCredential"
  | "onboarding.security"
  | "onboarding.workflowLearning"
  | "onboarding.optionalCapabilities"
  | "onboarding.review"
  | "onboarding.save"
  | "onboarding.verification"
  | "onboarding.launch";

export type FirstRunSensitiveSurface =
  | "none"
  | "interface-preference"
  | "workspace-path"
  | "workspace-trust"
  | "provider-selection"
  | "credential-reference"
  | "security-policy"
  | "workflow-learning"
  | "optional-capability"
  | "setup-review"
  | "config-write"
  | "setup-verification"
  | "agent-launch";

export type FirstRunInputKind =
  | "acknowledgement"
  | "choice"
  | "path"
  | "boolean"
  | "credential-reference"
  | "multi-choice";

export type FirstRunOutputKind =
  | "acknowledged"
  | "language-selection"
  | "workspace-root"
  | "workspace-trust"
  | "provider-selection"
  | "model-selection"
  | "credential-reference"
  | "security-mode"
  | "workflow-learning"
  | "optional-capabilities"
  | "review-summary"
  | "config-draft"
  | "verification-request"
  | "launch-request";

export type FirstRunValidationRule = {
  readonly id: string;
  readonly required: boolean;
  readonly copyKey: string;
};

export type FirstRunSkipRule =
  | {
      readonly id: "local-provider-skips-hosted-credential";
      readonly when: "primary-provider-local";
      readonly copyKey: "onboarding.providers.primaryCredential.localProviderSkip";
    }
  | {
      readonly id: "optional-capabilities-skipped";
      readonly when: "optional-capabilities-none";
      readonly copyKey: "onboarding.optionalCapabilities.skipped";
    };

export type FirstRunNextStepBehavior = {
  readonly defaultNext?: FirstRunOnboardingStepId;
  readonly branches?: readonly {
    readonly when: string;
    readonly next: FirstRunOnboardingStepId;
  }[];
};

export type FirstRunStepInput = {
  readonly id: string;
  readonly kind: FirstRunInputKind;
  readonly required: boolean;
  readonly sensitiveSurface: FirstRunSensitiveSurface;
  readonly optionSource?: string;
};

export type FirstRunStepOutput = {
  readonly id: string;
  readonly kind: FirstRunOutputKind;
  readonly sensitiveSurface: FirstRunSensitiveSurface;
};

export type FirstRunOnboardingStep = {
  readonly id: FirstRunOnboardingStepId;
  readonly copyKey: FirstRunOnboardingCopyKey;
  readonly copyLocale: UiLanguage;
  readonly required: boolean;
  readonly sensitiveSurface: FirstRunSensitiveSurface;
  readonly inputs: readonly FirstRunStepInput[];
  readonly outputs: readonly FirstRunStepOutput[];
  readonly validation: readonly FirstRunValidationRule[];
  readonly skipRules: readonly FirstRunSkipRule[];
  readonly next: FirstRunNextStepBehavior;
};

export type OptionalCapabilityId = "channels" | "voice" | "vision" | "browser";

export type FirstRunCredentialReference =
  | {
      readonly kind: "none";
    }
  | {
      readonly kind: "env";
      readonly name: string;
    };

export type FirstRunOnboardingSelections = {
  readonly language?: UiLanguage;
  readonly interfaceFlavor?: UiFlavor;
  readonly activityLabels?: ActivityLabelsLocale;
  readonly workspaceRoot?: string;
  readonly workspaceTrusted?: boolean;
  readonly primaryProvider?: ProviderId;
  readonly primaryModel?: string;
  readonly primaryCredential?: FirstRunCredentialReference;
  readonly securityMode?: SecurityApprovalMode;
  readonly workflowLearning?: SkillAutonomy;
  readonly optionalCapabilities?: readonly OptionalCapabilityId[];
  readonly optionalCapabilitiesSkipped?: boolean;
  readonly reviewAccepted?: boolean;
  readonly saveAccepted?: boolean;
  readonly verifySelected?: boolean;
  readonly launchSelected?: boolean;
};

export type FirstRunOnboardingState = {
  readonly currentStepId: FirstRunOnboardingStepId;
  readonly selections: FirstRunOnboardingSelections;
};

export type FirstRunOnboardingPlan = {
  readonly kind: "first-run-onboarding-plan";
  readonly copyLocale: UiLanguage;
  readonly currentStepId: FirstRunOnboardingStepId;
  readonly selections: FirstRunOnboardingSelections;
  readonly steps: readonly FirstRunOnboardingStep[];
};

export type BuildFirstRunOnboardingPlanOptions = {
  readonly currentStepId?: FirstRunOnboardingStepId;
  readonly selections?: FirstRunOnboardingSelections;
};

export function createFirstRunOnboardingState(
  selections: FirstRunOnboardingSelections = {},
  currentStepId: FirstRunOnboardingStepId = "welcome"
): FirstRunOnboardingState {
  return {
    currentStepId,
    selections: normalizeSelections(selections),
  };
}

export function updateFirstRunOnboardingState(
  state: FirstRunOnboardingState,
  patch: FirstRunOnboardingSelections
): FirstRunOnboardingState {
  const selections = normalizeSelections({ ...state.selections, ...patch });
  return {
    currentStepId: state.currentStepId,
    selections,
  };
}

export function buildFirstRunOnboardingPlan(
  options: BuildFirstRunOnboardingPlanOptions = {}
): FirstRunOnboardingPlan {
  const selections = normalizeSelections(options.selections ?? {});
  const copyLocale = selections.language ?? "en";
  const steps = FIRST_RUN_ONBOARDING_STEP_IDS.map((id) => createStep(id, selections));
  return {
    kind: "first-run-onboarding-plan",
    copyLocale,
    currentStepId: options.currentStepId ?? "welcome",
    selections,
    steps,
  };
}

export function getActiveFirstRunSteps(plan: FirstRunOnboardingPlan): readonly FirstRunOnboardingStep[] {
  return plan.steps.filter((step) => !isFirstRunStepSkipped(step, plan));
}

export function getNextFirstRunStepId(
  plan: FirstRunOnboardingPlan,
  stepId: FirstRunOnboardingStepId
): FirstRunOnboardingStepId | undefined {
  const activeStepIds = getActiveFirstRunSteps(plan).map((step) => step.id);
  const index = activeStepIds.indexOf(stepId);
  if (index === -1) return undefined;
  return activeStepIds[index + 1];
}

export function isFirstRunStepSkipped(
  step: FirstRunOnboardingStep,
  plan: FirstRunOnboardingPlan
): boolean {
  return step.skipRules.some((rule) => {
    switch (rule.when) {
      case "primary-provider-local":
        return plan.steps.some((candidate) => candidate.id === "primary-provider") &&
          plan.selections.primaryProvider === "local";
      case "optional-capabilities-none":
        return false;
    }
  });
}

export function advanceFirstRunOnboardingState(state: FirstRunOnboardingState): FirstRunOnboardingState {
  const plan = buildFirstRunOnboardingPlan({
    currentStepId: state.currentStepId,
    selections: state.selections,
  });
  return {
    currentStepId: getNextFirstRunStepId(plan, state.currentStepId) ?? state.currentStepId,
    selections: state.selections,
  };
}

export function getRequiredCredentialReference(
  selections: FirstRunOnboardingSelections
): FirstRunCredentialReference | undefined {
  if (selections.primaryProvider === undefined || selections.primaryProvider === "local") {
    return undefined;
  }
  return selections.primaryCredential ?? { kind: "env", name: getDefaultApiKeyEnv(selections.primaryProvider) };
}

function normalizeSelections(selections: FirstRunOnboardingSelections): FirstRunOnboardingSelections {
  if (selections.primaryProvider === "local") {
    return {
      ...selections,
      primaryCredential: { kind: "none" },
    };
  }
  return selections;
}

function createStep(
  id: FirstRunOnboardingStepId,
  selections: FirstRunOnboardingSelections
): FirstRunOnboardingStep {
  const copyLocale = copyLocaleForStep(id, selections);
  const next = nextFor(id);

  switch (id) {
    case "welcome":
      return step({
        id,
        copyKey: "onboarding.welcome",
        copyLocale,
        required: true,
        sensitiveSurface: "none",
        inputs: [input("acknowledge", "acknowledgement", true, "none")],
        outputs: [output("acknowledged", "acknowledged", "none")],
        validation: [validation("welcome-acknowledged", true, "onboarding.welcome.validation.acknowledged")],
        next,
      });
    case "interface-language":
      return step({
        id,
        copyKey: "onboarding.interfaceLanguage",
        copyLocale,
        required: true,
        sensitiveSurface: "interface-preference",
        inputs: [
          input("language", "choice", true, "interface-preference", "ui.language"),
          input("interfaceFlavor", "choice", true, "interface-preference", "ui.flavor"),
        ],
        outputs: [output("interface", "language-selection", "interface-preference")],
        validation: [validation("language-selected", true, "onboarding.interfaceLanguage.validation.languageSelected")],
        next,
      });
    case "workspace-root":
      return step({
        id,
        copyKey: "onboarding.workspace.root",
        copyLocale,
        required: true,
        sensitiveSurface: "workspace-path",
        inputs: [input("workspaceRoot", "path", true, "workspace-path")],
        outputs: [output("workspaceRoot", "workspace-root", "workspace-path")],
        validation: [validation("workspace-root-selected", true, "onboarding.workspace.root.validation.selected")],
        next,
      });
    case "workspace-trust":
      return step({
        id,
        copyKey: "onboarding.workspace.trust",
        copyLocale,
        required: true,
        sensitiveSurface: "workspace-trust",
        inputs: [input("workspaceTrusted", "boolean", true, "workspace-trust")],
        outputs: [output("workspaceTrust", "workspace-trust", "workspace-trust")],
        validation: [validation("workspace-trust-explicit", true, "onboarding.workspace.trust.validation.explicit")],
        next,
      });
    case "primary-provider":
      return step({
        id,
        copyKey: "onboarding.providers.primary",
        copyLocale,
        required: true,
        sensitiveSurface: "provider-selection",
        inputs: [input("primaryProvider", "choice", true, "provider-selection", "providers.primary")],
        outputs: [output("primaryProvider", "provider-selection", "provider-selection")],
        validation: [validation("provider-selected", true, "onboarding.providers.primary.validation.selected")],
        next,
      });
    case "primary-model":
      return step({
        id,
        copyKey: "onboarding.providers.primaryModel",
        copyLocale,
        required: true,
        sensitiveSurface: "provider-selection",
        inputs: [input("primaryModel", "choice", true, "provider-selection", "providers.primary.models")],
        outputs: [output("primaryModel", "model-selection", "provider-selection")],
        validation: [validation("model-selected", true, "onboarding.providers.primaryModel.validation.selected")],
        next,
      });
    case "primary-credential":
      return step({
        id,
        copyKey: "onboarding.providers.primaryCredential",
        copyLocale,
        required: selections.primaryProvider !== "local",
        sensitiveSurface: "credential-reference",
        inputs: [input("primaryCredential", "credential-reference", selections.primaryProvider !== "local", "credential-reference")],
        outputs: [output("primaryCredential", "credential-reference", "credential-reference")],
        validation: [validation("hosted-provider-credential-reference", selections.primaryProvider !== "local", "onboarding.providers.primaryCredential.validation.reference")],
        skipRules: [
          {
            id: "local-provider-skips-hosted-credential",
            when: "primary-provider-local",
            copyKey: "onboarding.providers.primaryCredential.localProviderSkip",
          },
        ],
        next,
      });
    case "security-mode":
      return step({
        id,
        copyKey: "onboarding.security",
        copyLocale,
        required: true,
        sensitiveSurface: "security-policy",
        inputs: [input("securityMode", "choice", true, "security-policy", "security.approvalMode")],
        outputs: [output("securityMode", "security-mode", "security-policy")],
        validation: [validation("security-mode-selected", true, "onboarding.security.validation.selected")],
        next,
      });
    case "workflow-learning":
      return step({
        id,
        copyKey: "onboarding.workflowLearning",
        copyLocale,
        required: true,
        sensitiveSurface: "workflow-learning",
        inputs: [input("workflowLearning", "choice", true, "workflow-learning", "skills.autonomy")],
        outputs: [output("workflowLearning", "workflow-learning", "workflow-learning")],
        validation: [validation("workflow-learning-selected", true, "onboarding.workflowLearning.validation.selected")],
        next,
      });
    case "optional-capabilities":
      return step({
        id,
        copyKey: "onboarding.optionalCapabilities",
        copyLocale,
        required: false,
        sensitiveSurface: "optional-capability",
        inputs: [input("optionalCapabilities", "multi-choice", false, "optional-capability", "capabilities.optional")],
        outputs: [output("optionalCapabilities", "optional-capabilities", "optional-capability")],
        validation: [validation("optional-capabilities-independently-skippable", false, "onboarding.optionalCapabilities.validation.skippable")],
        skipRules: [
          {
            id: "optional-capabilities-skipped",
            when: "optional-capabilities-none",
            copyKey: "onboarding.optionalCapabilities.skipped",
          },
        ],
        next,
      });
    case "review":
      return step({
        id,
        copyKey: "onboarding.review",
        copyLocale,
        required: true,
        sensitiveSurface: "setup-review",
        inputs: [input("reviewAccepted", "boolean", true, "setup-review")],
        outputs: [output("reviewSummary", "review-summary", "setup-review")],
        validation: [validation("review-accepted", true, "onboarding.review.validation.accepted")],
        next,
      });
    case "save":
      return step({
        id,
        copyKey: "onboarding.save",
        copyLocale,
        required: true,
        sensitiveSurface: "config-write",
        inputs: [input("saveAccepted", "boolean", true, "config-write")],
        outputs: [output("configDraft", "config-draft", "config-write")],
        validation: [validation("save-confirmed", true, "onboarding.save.validation.confirmed")],
        next,
      });
    case "verify":
      return step({
        id,
        copyKey: "onboarding.verification",
        copyLocale,
        required: true,
        sensitiveSurface: "setup-verification",
        inputs: [input("verifySelected", "boolean", true, "setup-verification")],
        outputs: [output("verificationRequest", "verification-request", "setup-verification")],
        validation: [validation("verification-selected", true, "onboarding.verification.validation.selected")],
        next,
      });
    case "launch":
      return step({
        id,
        copyKey: "onboarding.launch",
        copyLocale,
        required: false,
        sensitiveSurface: "agent-launch",
        inputs: [input("launchSelected", "boolean", false, "agent-launch")],
        outputs: [output("launchRequest", "launch-request", "agent-launch")],
        validation: [validation("launch-explicit", false, "onboarding.launch.validation.explicit")],
        next,
      });
  }
}

function copyLocaleForStep(id: FirstRunOnboardingStepId, selections: FirstRunOnboardingSelections): UiLanguage {
  if (id === "welcome" || id === "interface-language") {
    return "en";
  }
  return selections.language ?? "en";
}

function nextFor(id: FirstRunOnboardingStepId): FirstRunNextStepBehavior {
  const index = FIRST_RUN_ONBOARDING_STEP_IDS.indexOf(id);
  const defaultNext = FIRST_RUN_ONBOARDING_STEP_IDS[index + 1];
  if (id === "primary-model") {
    return {
      defaultNext: "primary-credential",
      branches: [{ when: "primary-provider-local", next: "security-mode" }],
    };
  }
  return defaultNext === undefined ? {} : { defaultNext };
}

function step(inputStep: Omit<FirstRunOnboardingStep, "skipRules"> & {
  readonly skipRules?: readonly FirstRunSkipRule[];
}): FirstRunOnboardingStep {
  return {
    ...inputStep,
    skipRules: inputStep.skipRules ?? [],
  };
}

function input(
  id: string,
  kind: FirstRunInputKind,
  required: boolean,
  sensitiveSurface: FirstRunSensitiveSurface,
  optionSource?: string
): FirstRunStepInput {
  return {
    id,
    kind,
    required,
    sensitiveSurface,
    ...(optionSource === undefined ? {} : { optionSource }),
  };
}

function output(
  id: string,
  kind: FirstRunOutputKind,
  sensitiveSurface: FirstRunSensitiveSurface
): FirstRunStepOutput {
  return { id, kind, sensitiveSurface };
}

function validation(id: string, required: boolean, copyKey: string): FirstRunValidationRule {
  return { id, required, copyKey };
}
