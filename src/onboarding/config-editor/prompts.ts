import type { Prompt } from "../../cli/readline-prompt.js";
import type { SecurityApprovalMode } from "../../contracts/security.js";
import type { ModelCandidate, ProviderCandidate } from "../../providers/provider-model-selection-flow.js";
import type { SkillAutonomy } from "../../skills/skill-learning.js";
import {
  promptSetupChoice,
  setupCopyText,
} from "../setup-prompts.js";
import type { ConfigEditorRenderedAction } from "./render.js";

export async function promptConfigEditorAction(
  prompt: Prompt,
  actions: readonly ConfigEditorRenderedAction[],
  defaultActionId?: string
): Promise<ConfigEditorRenderedAction | undefined> {
  if (actions.length === 0) {
    return undefined;
  }

  const defaultAction = actions.find((action) => action.id === defaultActionId) ?? actions[0];
  return promptSetupChoice(prompt, {
    title: "Guided setup editor",
    message: "Choose a setup action.\n",
    choices: actions.map((action) => ({
      id: action.id,
      label: action.label,
      description: action.description,
      value: action,
    })),
    defaultValue: defaultAction,
  });
}

export async function promptSecurityMode(
  prompt: Prompt,
  currentValue: SecurityApprovalMode
): Promise<SecurityApprovalMode> {
  return promptSetupChoice(prompt, {
    title: setupCopyText("en", "onboarding.security.title"),
    message: `${setupCopyText("en", "onboarding.security")}\n`,
    choices: [
      {
        id: "strict",
        label: setupCopyText("en", "onboarding.security.options.strict.label"),
        description: setupCopyText("en", "onboarding.security.options.strict.description"),
        value: "strict" as const,
      },
      {
        id: "adaptive",
        label: setupCopyText("en", "onboarding.security.options.adaptive.label"),
        description: setupCopyText("en", "onboarding.security.options.adaptive.description"),
        value: "adaptive" as const,
      },
      {
        id: "open",
        label: setupCopyText("en", "onboarding.security.options.open.label"),
        description: setupCopyText("en", "onboarding.security.options.open.description"),
        value: "open" as const,
      },
    ],
    defaultValue: currentValue,
  });
}

export async function promptWorkflowLearning(
  prompt: Prompt,
  currentValue: SkillAutonomy
): Promise<SkillAutonomy> {
  return promptSetupChoice(prompt, {
    title: setupCopyText("en", "onboarding.workflowLearning.title"),
    message: `${setupCopyText("en", "onboarding.workflowLearning")}\n`,
    choices: [
      {
        id: "none",
        label: setupCopyText("en", "onboarding.workflowLearning.options.none.label"),
        description: setupCopyText("en", "onboarding.workflowLearning.options.none.description"),
        value: "none" as const,
      },
      {
        id: "suggest",
        label: setupCopyText("en", "onboarding.workflowLearning.options.suggest.label"),
        description: setupCopyText("en", "onboarding.workflowLearning.options.suggest.description"),
        value: "suggest" as const,
      },
      {
        id: "proactive",
        label: setupCopyText("en", "onboarding.workflowLearning.options.proactive.label"),
        description: setupCopyText("en", "onboarding.workflowLearning.options.proactive.description"),
        value: "proactive" as const,
      },
      {
        id: "autonomous",
        label: setupCopyText("en", "onboarding.workflowLearning.options.autonomous.label"),
        description: setupCopyText("en", "onboarding.workflowLearning.options.autonomous.description"),
        value: "autonomous" as const,
      },
    ],
    defaultValue: currentValue,
  });
}

export async function promptWorkspaceTrustConfirmation(
  prompt: Prompt,
  input: {
    readonly workspaceRoot: string;
    readonly trustStorePath: string;
  }
): Promise<boolean> {
  return promptSetupChoice(prompt, {
    title: setupCopyText("en", "onboarding.workspace.trust.title"),
    message: [
      setupCopyText("en", "onboarding.workspace.trust"),
      `Workspace: ${input.workspaceRoot}`,
      `Trust store: ${input.trustStorePath}`,
      "",
    ].join("\n"),
    choices: [
      {
        id: "trust",
        label: setupCopyText("en", "onboarding.workspace.trustAction.label"),
        description: setupCopyText("en", "onboarding.workspace.trustAction.description"),
        value: true,
      },
      {
        id: "cancel",
        label: setupCopyText("en", "onboarding.review.cancelAction"),
        description: setupCopyText("en", "setupApply.review.cancelled"),
        value: false,
      },
    ],
    defaultValue: false,
  });
}

export async function promptProviderCandidate(
  prompt: Prompt,
  input: {
    readonly candidates: readonly ProviderCandidate[];
    readonly currentProviderId?: string;
  }
): Promise<ProviderCandidate> {
  return promptSetupChoice(prompt, {
    title: setupCopyText("en", "onboarding.providers.primary.title"),
    message: `${setupCopyText("en", "onboarding.providers.primary")}\n`,
    choices: input.candidates.map((candidate) => ({
      id: candidate.id,
      label: candidate.displayName,
      description: candidate.baseUrl
        ? `${candidate.baseUrl} (${candidate.modelsCount} models)`
        : `${candidate.modelsCount} models`,
      value: candidate,
    })),
    defaultValue: input.candidates.find((candidate) => candidate.id === input.currentProviderId) ?? input.candidates[0],
  });
}

export async function promptModelCandidate(
  prompt: Prompt,
  input: {
    readonly providerId: string;
    readonly candidates: readonly ModelCandidate[];
    readonly currentModelId?: string;
  }
): Promise<ModelCandidate> {
  return promptSetupChoice(prompt, {
    title: setupCopyText("en", "onboarding.providers.primaryModel.title"),
    message: `${setupCopyText("en", "onboarding.providers.primaryModel").replace("{providerId}", input.providerId)}\n`,
    choices: input.candidates.map((candidate) => ({
      id: candidate.id,
      label: candidate.id,
      description: [
        candidate.profile.supportsTools ? setupCopyText("en", "onboarding.catalog.model.features.tools") : undefined,
        candidate.profile.supportsVision ? setupCopyText("en", "onboarding.catalog.model.features.vision") : undefined,
        candidate.profile.supportsReasoning ? setupCopyText("en", "onboarding.catalog.model.features.reasoning") : undefined,
        candidate.profile.status,
      ].filter((part): part is string => part !== undefined).join(", "),
      value: candidate,
    })),
    defaultValue: input.candidates.find((candidate) => candidate.id === input.currentModelId) ?? input.candidates[0],
  });
}

export async function promptConfigEditorReviewApproval(
  prompt: Prompt
): Promise<boolean> {
  return promptSetupChoice(prompt, {
    title: setupCopyText("en", "onboarding.review"),
    message: `${setupCopyText("en", "onboarding.review.validation.accepted")}\n`,
    choices: [
      {
        id: "approve",
        label: setupCopyText("en", "onboarding.review.approveAction"),
        description: setupCopyText("en", "setupApply.review.approved"),
        value: true,
      },
      {
        id: "cancel",
        label: setupCopyText("en", "onboarding.review.cancelAction"),
        description: setupCopyText("en", "setupApply.review.cancelled"),
        value: false,
      },
    ],
    defaultValue: true,
  });
}
