import { resolveStateHome } from "../../config/state-home.js";
import {
  loadRuntimeConfig,
} from "../../config/runtime-config.js";
import { defaultProfileId, readActiveProfile, resolveProfileStateHome } from "../../config/profile-home.js";
import { ensureDefaultProfileState } from "../../cli/profile-state.js";
import type { Prompt } from "../../cli/readline-prompt.js";
import { promptForApiKeyInput } from "../../cli/secret-prompt.js";
import {
  createProviderModelSelectionFlow,
  type FlowEngine,
} from "../../providers/provider-model-selection-flow.js";
import {
  type FirstRunOnboardingSelections,
  type OptionalCapabilityId,
} from "./plan.js";
import type { OnboardingCredentialSummaryStatus, OnboardingOptionalCapabilitySummaries, OnboardingWizardState } from "./state.js";
import { renderOnboardingWizardSummary } from "./summary.js";
import {
  validateOnboardingWorkspacePath,
  type OnboardingInvalidWorkspaceAction,
} from "./workspace.js";
import { promptInterfaceLanguageAndStyle } from "../interface-preferences.js";
import { buildOnboardingWizardDraftBundle, type SetupDraft, type SetupDraftBundle } from "../setup-drafts.js";
import {
  buildSetupReviewManifest,
  type SetupReviewManifest,
} from "../setup-review-manifest.js";
import {
  executeSetupApplyPlan,
  planSetupApply,
  type SetupApplyEndState,
  type SetupDeferredSecretWrite,
  type SetupApplyExecutor,
  type SetupApplyFlowOptions,
  type SetupApplyPlanningResult,
} from "../setup-apply-plan.js";
import {
  collectSetupEntryState,
  type CollectSetupEntryStateOptions,
  type SetupEntryState,
} from "../setup-entry-state.js";
import type { SetupCopyLocale } from "../setup-copy.js";
import {
  formatSetupCopy,
  promptSetupChoice,
  promptSetupStringWithDefault,
  renderSetupApplyEndState,
  renderSetupApplyPlanningResult,
  setupCopyText,
  showSetupCard,
} from "../setup-prompts.js";
import {
  promptModelCandidate,
  promptProviderCandidate,
  promptVoiceCapability,
} from "../config-editor/prompts.js";
import {
  collectOptionalCapabilityContext,
  setupModuleContextFromConfig,
} from "../optional-capability-flow.js";
import {
  browserSetupModule,
  telegramSetupModule,
  voiceSetupModule,
  type SetupModuleContext,
} from "../setup-modules.js";

export type FirstRunSetupRunnerOptions = CollectSetupEntryStateOptions & {
  readonly prompt: Prompt;
  readonly flowEngine?: FlowEngine;
  readonly defaultSelections?: FirstRunOnboardingSelections;
  readonly applyExecutor?: SetupApplyExecutor;
  readonly applyFlowOptions?: SetupApplyFlowOptions;
  readonly output?: {
    readonly write: (value: string) => void;
  };
};

export type FirstRunSetupRunnerResult = {
  readonly completed: boolean;
  readonly exitCode: number;
  readonly output: string;
  readonly state: SetupEntryState;
  readonly selections: FirstRunOnboardingSelections;
  readonly wizardState: OnboardingWizardState;
  readonly draftBundle: SetupDraftBundle;
  readonly reviewManifest: SetupReviewManifest;
  readonly applyPlanningResult: SetupApplyPlanningResult;
  readonly applyEndState?: SetupApplyEndState;
};

type PendingCredentialWrite = SetupDeferredSecretWrite;

type WorkspaceTrustAction = "trust" | "change-workspace" | "decide-later";

type OnboardingSupportedOptionalCapabilityId = Exclude<OptionalCapabilityId, "vision">;

type OnboardingOptionalCapabilityFlowResult = {
  readonly selected: readonly OnboardingSupportedOptionalCapabilityId[];
  readonly summaries: OnboardingOptionalCapabilitySummaries;
  readonly drafts: readonly SetupDraft[];
  readonly pendingCredentialWrites: readonly PendingCredentialWrite[];
};

export async function runFirstRunSetup(
  options: FirstRunSetupRunnerOptions
): Promise<FirstRunSetupRunnerResult> {
  const prompt = options.prompt;
  const state = await collectSetupEntryState(options);
  await ensureDefaultProfileState({ homeDir: options.homeDir, profileId: options.profileId ?? defaultProfileId() });
  const stateHome = resolveStateHome({ homeDir: options.homeDir });
  const flowEngine = options.flowEngine ?? await createDefaultFlowEngine(options);
  const initialLocale = options.defaultSelections?.language ?? "en";

  await showSetupCard(prompt, initialLocale, {
    title: setupCopyText(initialLocale, "onboarding.welcome.title"),
    bodyLines: [setupCopyText(initialLocale, "onboarding.welcome")],
    options: [{ id: "begin", label: setupCopyText(initialLocale, "onboarding.common.begin") }],
  });

  const interfaceChoice = await promptInterfaceLanguageAndStyle(prompt, {
    initialLocale,
    currentLanguage: options.defaultSelections?.language ?? "en",
    currentFlavor: options.defaultSelections?.interfaceFlavor,
  });
  const language = interfaceChoice.language;

  const workspaceSelection = await promptForWorkspaceAndTrust(options, language);
  const workspaceRoot = workspaceSelection.workspaceRoot;
  const workspaceTrusted = workspaceSelection.workspaceTrusted;


  const providerCandidates = await flowEngine.listProviderCandidates();
  if (providerCandidates.length === 0) {
    throw new Error("No setup-visible provider candidates are available.");
  }
  const primaryProviderCandidate = await promptProviderCandidate(prompt, {
    candidates: providerCandidates,
    currentProviderId: options.defaultSelections?.primaryProvider,
  }, language);
  const primaryProvider = primaryProviderCandidate.id;


  const modelCandidates = await flowEngine.listModelCandidates(primaryProvider);
  if (modelCandidates.length === 0) {
    throw new Error(`No setup-visible models are available for ${primaryProviderCandidate.displayName}.`);
  }
  const primaryModelCandidate = await promptModelCandidate(prompt, {
    providerId: primaryProvider,
    candidates: modelCandidates,
    currentModelId: options.defaultSelections?.primaryModel,
  }, language);
  const primaryModel = primaryModelCandidate.id;

  const resolution = await flowEngine.resolveSelection(primaryProvider, primaryModel);
  if (resolution.kind === "diagnostic") {
    throw new Error(`Provider/model selection failed: ${resolution.reason}`);
  }

  const primaryBaseUrl = resolution.baseUrl;
  const primaryContextWindowTokens = resolution.profile.contextWindowTokens;
  const primaryApiMode = resolution.apiMode;
  const primaryAuthMethod = resolution.authMethod;

  let primaryCredential: FirstRunOnboardingSelections["primaryCredential"];
  const pendingCredentialWrites: PendingCredentialWrite[] = [];
  let credentialStatus: OnboardingCredentialSummaryStatus = "not_set";

  switch (resolution.credentialAction.kind) {
    case "none": {
      primaryCredential = { kind: "none" };
      write(options, `${setupCopyText(language, "onboarding.providers.primaryCredential.localProviderSkip")}\n`);
      break;
    }
    case "reuse": {
      const ref = resolution.credentialAction.reference;
      if (!ref.startsWith("env:")) {
        throw new Error(`Malformed reuse credential reference: ${ref}`);
      }
      const envVarName = ref.slice(4);
      primaryCredential = { kind: "env", name: envVarName };
      credentialStatus = "existing_detected";
      write(options, `Using existing credential from ${envVarName}.\n`);
      break;
    }
    case "collect": {
      const envVarName = resolution.credentialAction.envVarName;
      primaryCredential = { kind: "env", name: envVarName };
      const promptResult = await promptForApiKeyInput({
        prompt,
        providerId: primaryProvider,
        envVarName,
        question: `${setupCopyText(language, "onboarding.providers.primaryCredential")} [${envVarName}]: `,
      });

      if (promptResult.kind === "skipped") {
        write(options, `Config will expect ${envVarName} to be available externally.\n`);
      } else {
        credentialStatus = "new_pending";
        pendingCredentialWrites.push({
          envVarName: promptResult.envVarName,
          value: promptResult.value,
        });
      }
      break;
    }

  }

  const securityMode = await promptSetupChoice(prompt, {
    title: setupCopyText(language, "onboarding.security.title"),
    message: `${setupCopyText(language, "onboarding.security")}\n`,
    choices: [
      {
        id: "adaptive",
        label: setupCopyText(language, "onboarding.security.options.adaptive.label"),
        description: setupCopyText(language, "onboarding.security.options.adaptive.description"),
        value: "adaptive" as const,
      },
      {
        id: "strict",
        label: setupCopyText(language, "onboarding.security.options.strict.label"),
        description: setupCopyText(language, "onboarding.security.options.strict.description"),
        value: "strict" as const,
      },
      {
        id: "open",
        label: setupCopyText(language, "onboarding.security.options.open.label"),
        description: setupCopyText(language, "onboarding.security.options.open.description"),
        value: "open" as const,
      },
    ],
    defaultValue: options.defaultSelections?.securityMode ?? "adaptive",
  });

  const workflowLearning = await promptSetupChoice(prompt, {
    title: setupCopyText(language, "onboarding.workflowLearning.title"),
    message: `${setupCopyText(language, "onboarding.workflowLearning")}\n`,
    choices: [
      {
        id: "suggest",
        label: setupCopyText(language, "onboarding.workflowLearning.options.suggest.label"),
        description: setupCopyText(language, "onboarding.workflowLearning.options.suggest.description"),
        value: "suggest" as const,
      },
      {
        id: "none",
        label: setupCopyText(language, "onboarding.workflowLearning.options.none.label"),
        description: setupCopyText(language, "onboarding.workflowLearning.options.none.description"),
        value: "none" as const,
      },
      {
        id: "proactive",
        label: setupCopyText(language, "onboarding.workflowLearning.options.proactive.label"),
        description: setupCopyText(language, "onboarding.workflowLearning.options.proactive.description"),
        value: "proactive" as const,
      },
      {
        id: "autonomous",
        label: setupCopyText(language, "onboarding.workflowLearning.options.autonomous.label"),
        description: setupCopyText(language, "onboarding.workflowLearning.options.autonomous.description"),
        value: "autonomous" as const,
      },
    ],
    defaultValue: options.defaultSelections?.workflowLearning ?? "suggest",
  });

  const profileId = options.profileId ?? readActiveProfile({ homeDir: options.homeDir }).profileId ?? defaultProfileId();
  const configPath = resolveProfileStateHome({ homeDir: options.homeDir, profileId }).configPath;
  const optionalCapabilityFlow = await chooseOptionalCapabilities(options, language, {
    configPath,
    profileId,
    workspaceRoot,
    workspaceTrusted,
    primaryProvider,
    primaryModel,
    securityMode,
    workflowLearning,
  });
  pendingCredentialWrites.push(...optionalCapabilityFlow.pendingCredentialWrites);
  const optionalCapabilities = optionalCapabilityFlow.selected;
  const launchSelected = workspaceTrusted
    ? await promptSetupChoice(prompt, {
        title: setupCopyText(language, "onboarding.launch.preferenceTitle"),
        message: `${setupCopyText(language, "onboarding.launch")}\n`,
        choices: [
          {
            id: "skip",
            label: setupCopyText(language, "onboarding.launch.skipAction.label"),
            description: setupCopyText(language, "onboarding.launch.skipAction.description"),
            value: false,
          },
          {
            id: "offer",
            label: setupCopyText(language, "onboarding.launch.offerAction.label"),
            description: setupCopyText(language, "onboarding.launch.offerAction.description"),
            value: true,
          },
        ],
        defaultValue: options.defaultSelections?.launchSelected ?? false,
      })
    : false;

  const selections: FirstRunOnboardingSelections = {
    language,
    interfaceFlavor: interfaceChoice.flavor,
    activityLabels: interfaceChoice.activityLabels,
    workspaceRoot,
    workspaceTrusted,
    primaryProvider,
    primaryModel,
    primaryBaseUrl,
    primaryContextWindowTokens,
    primaryApiMode,
    primaryAuthMethod,
    primaryCredential,
    securityMode,
    workflowLearning,
    optionalCapabilities,
    optionalCapabilitiesSkipped: optionalCapabilities.length === 0,
    verifySelected: true,
    launchSelected,
  };

  const wizardState = onboardingWizardStateFromSelections(selections, credentialStatus, optionalCapabilityFlow);
  const draftBundle = buildOnboardingWizardDraftBundle(wizardState, {
    configPath,
    workspaceRoot,
    trustStorePath: stateHome.trustJsonPath,
  });
  const reviewManifest = buildSetupReviewManifest([draftBundle]);
  const summaryText = renderOnboardingWizardSummary(wizardState);
  write(options, `${summaryText}\n`);

  const reviewAccepted = await promptSetupChoice(prompt, {
    title: setupCopyText(language, "onboarding.summary.confirmTitle"),
    message: `${summaryText}\n\n${setupCopyText(language, "onboarding.summary.confirmMessage")}\n`,
    choices: [
      {
        id: "confirm",
        label: setupCopyText(language, "onboarding.summary.confirmAction"),
        description: setupCopyText(language, "setupApply.review.approved"),
        value: true,
      },
      {
        id: "cancel",
        label: setupCopyText(language, "onboarding.summary.cancelAction"),
        description: setupCopyText(language, "setupApply.review.cancelled"),
        value: false,
      },
    ],
    defaultValue: options.defaultSelections?.reviewAccepted ?? true,
  });

  const finalSelections = {
    ...selections,
    reviewAccepted,
    saveAccepted: reviewAccepted,
  };
  const applyPlanningResult = planSetupApply(reviewAccepted
    ? { kind: "approved-review-result", manifest: reviewManifest }
    : { kind: "cancelled-review-result", manifest: reviewManifest, reason: "User cancelled summary confirmation." });
  const applyEndState = applyPlanningResult.kind === "apply-plan-ready" && options.applyExecutor !== undefined
      ? await executeSetupApplyPlan(applyPlanningResult.applyPlan, options.applyExecutor, {
        ...options.applyFlowOptions,
        ...(pendingCredentialWrites.length > 0
          ? { deferredSecretWrites: pendingCredentialWrites }
          : {}),
      })
    : undefined;
  const renderedApplyOutput = applyEndState === undefined
    ? renderSetupApplyPlanningResult(applyPlanningResult, language)
    : renderSetupApplyEndState(applyEndState, language);
  const completed = applyEndState === undefined
    ? applyPlanningResult.kind === "apply-plan-ready"
    : applyEndState.kind !== "blocked" && applyEndState.kind !== "cancelled";
  const output = workspaceTrusted || !completed
    ? renderedApplyOutput
    : setupCopyText(language, "onboarding.workspace.trust.deferredFinal");

  return {
    completed,
    exitCode: completed ? 0 : 1,
    output,
    state,
    selections: finalSelections,
    wizardState,
    draftBundle,
    reviewManifest,
    applyPlanningResult,
    applyEndState,
  };
}

function onboardingWizardStateFromSelections(
  selections: FirstRunOnboardingSelections,
  credentialStatus: OnboardingCredentialSummaryStatus,
  optionalCapabilityFlow: OnboardingOptionalCapabilityFlowResult
): OnboardingWizardState {
  const credentialEnvVarName = selections.primaryCredential?.kind === "env"
    ? selections.primaryCredential.name
    : undefined;

  return {
    interfacePreferences: {
      language: selections.language,
      flavor: selections.interfaceFlavor,
      activityLabels: selections.activityLabels,
    },
    workspace: {
      path: selections.workspaceRoot,
      trustStatus: selections.workspaceTrusted === true ? "trusted" : "untrusted",
    },
    primaryRoute: {
      provider: selections.primaryProvider,
      model: selections.primaryModel,
      baseUrl: selections.primaryBaseUrl,
      contextWindowTokens: selections.primaryContextWindowTokens,
      apiMode: selections.primaryApiMode,
      authMethod: selections.primaryAuthMethod,
    },
    credential: {
      status: credentialStatus,
      envVarName: credentialEnvVarName,
    },
    securityMode: selections.securityMode,
    agentEvolution: selections.workflowLearning,
    optionalCapabilities: optionalCapabilityFlow.summaries,
    optionalCapabilityDrafts: optionalCapabilityFlow.drafts,
    launchSelected: selections.launchSelected,
  };
}

async function promptForWorkspaceAndTrust(
  options: FirstRunSetupRunnerOptions,
  language: SetupCopyLocale
): Promise<{
  readonly workspaceRoot: string;
  readonly workspaceTrusted: boolean;
}> {
  while (true) {
    const workspaceRoot = await promptForCanonicalWorkspaceRoot(options, language);
    const action = await promptSetupChoice<WorkspaceTrustAction>(options.prompt, {
      title: setupCopyText(language, "onboarding.workspace.trust.title"),
      message: `${formatSetupCopy(language, "onboarding.workspace.trust", { workspacePath: workspaceRoot })}\n`,
      choices: [
        {
          id: "trust",
          label: setupCopyText(language, "onboarding.workspace.trustAction.label"),
          description: setupCopyText(language, "onboarding.workspace.trustAction.description"),
          value: "trust",
        },
        {
          id: "change-workspace",
          label: setupCopyText(language, "onboarding.workspace.changeWorkspaceAction.label"),
          description: setupCopyText(language, "onboarding.workspace.changeWorkspaceAction.description"),
          value: "change-workspace",
        },
        {
          id: "decide-later",
          label: setupCopyText(language, "onboarding.workspace.deferTrustAction.label"),
          description: setupCopyText(language, "onboarding.workspace.deferTrustAction.description"),
          value: "decide-later",
        },
      ],
      defaultValue: options.defaultSelections?.workspaceTrusted === false ? "decide-later" : "trust",
    });

    if (action === "change-workspace") {
      continue;
    }

    return {
      workspaceRoot,
      workspaceTrusted: action === "trust",
    };
  }
}

async function promptForCanonicalWorkspaceRoot(
  options: FirstRunSetupRunnerOptions,
  language: SetupCopyLocale
): Promise<string> {
  let defaultWorkspaceRoot = options.defaultSelections?.workspaceRoot ?? options.workspaceRoot;

  while (true) {
    await showSetupCard(options.prompt, language, {
      title: setupCopyText(language, "onboarding.workspace.title"),
      bodyLines: [setupCopyText(language, "onboarding.workspace.root")],
      technicalLines: [defaultWorkspaceRoot],
      options: [{ id: "workspace", label: defaultWorkspaceRoot, technical: true }],
    });
    const requestedWorkspaceRoot = await promptSetupStringWithDefault(
      options.prompt,
      `${setupCopyText(language, "onboarding.workspace.root")} [${defaultWorkspaceRoot}]: `,
      defaultWorkspaceRoot
    );
    const validation = await validateOnboardingWorkspacePath(requestedWorkspaceRoot);
    if (validation.ok) {
      return validation.canonicalPath;
    }

    write(options, `${validation.message}\n`);
    const action = await promptSetupChoice<OnboardingInvalidWorkspaceAction>(options.prompt, {
      title: setupCopyText(language, "onboarding.workspace.invalid.title"),
      message: `${validation.message}\n`,
      choices: [
        {
          id: "try-again",
          label: setupCopyText(language, "onboarding.workspace.invalid.tryAgain"),
          value: "try-again",
        },
        {
          id: "use-current",
          label: setupCopyText(language, "onboarding.workspace.invalid.useCurrent"),
          value: "use-current",
        },
        {
          id: "cancel",
          label: setupCopyText(language, "onboarding.workspace.invalid.cancel"),
          value: "cancel",
        },
      ],
      defaultValue: "try-again",
    });

    if (action === "cancel") {
      throw new Error("Setup cancelled during workspace selection.");
    }

    if (action === "use-current") {
      const currentValidation = await validateOnboardingWorkspacePath(options.workspaceRoot);
      if (currentValidation.ok) {
        return currentValidation.canonicalPath;
      }
      write(options, `${currentValidation.message}\n`);
      defaultWorkspaceRoot = options.workspaceRoot;
      continue;
    }

    defaultWorkspaceRoot = requestedWorkspaceRoot;
  }
}

async function createDefaultFlowEngine(options: CollectSetupEntryStateOptions): Promise<FlowEngine> {
  const loaded = await loadRuntimeConfig(options);
  const flow = await createProviderModelSelectionFlow({
    config: loaded.config,
    providerRegistry: loaded.providerRegistry,
    homeDir: options.homeDir,
    allowNetwork: false,
    mode: "setup",
  });

  return flow;
}

async function chooseOptionalCapabilities(
  options: FirstRunSetupRunnerOptions,
  locale: SetupCopyLocale,
  contextInput: {
    readonly configPath: string;
    readonly profileId: string;
    readonly workspaceRoot: string;
    readonly workspaceTrusted: boolean;
    readonly primaryProvider: FirstRunOnboardingSelections["primaryProvider"];
    readonly primaryModel: FirstRunOnboardingSelections["primaryModel"];
    readonly securityMode: FirstRunOnboardingSelections["securityMode"];
    readonly workflowLearning: FirstRunOnboardingSelections["workflowLearning"];
  }
): Promise<OnboardingOptionalCapabilityFlowResult> {
  const configureNow = await promptSetupChoice(options.prompt, {
    title: setupCopyText(locale, "onboarding.optionalCapabilities.title"),
    message: [
      setupCopyText(locale, "onboarding.optionalCapabilities.configureNow"),
      setupCopyText(locale, "onboarding.optionalCapabilities.note"),
      "",
    ].join("\n"),
    choices: [
      {
        id: "yes",
        label: setupCopyText(locale, "onboarding.optionalCapabilities.configureNow.yes"),
        value: true,
      },
      {
        id: "no",
        label: setupCopyText(locale, "onboarding.optionalCapabilities.configureNow.no"),
        value: false,
      },
    ],
    defaultValue: (options.defaultSelections?.optionalCapabilities?.length ?? 0) > 0,
  });

  const loaded = await loadRuntimeConfig(options);
  let context = setupModuleContextFromConfig({
    homeDir: options.homeDir,
    profileId: contextInput.profileId,
    workspaceRoot: contextInput.workspaceRoot,
    trustStorePath: resolveStateHome({ homeDir: options.homeDir }).trustJsonPath,
    configPath: contextInput.configPath,
  }, loaded.config, {
    provider: contextInput.primaryProvider,
    model: contextInput.primaryModel,
    workspaceTrusted: contextInput.workspaceTrusted,
    securityMode: contextInput.securityMode,
    workflowLearning: contextInput.workflowLearning,
  });
  const selected = new Set<OnboardingSupportedOptionalCapabilityId>();
  const draftMap = new Map<OnboardingSupportedOptionalCapabilityId, readonly SetupDraft[]>();
  const pendingCredentialWrites: PendingCredentialWrite[] = [];

  if (!configureNow) {
    return onboardingOptionalCapabilityResult(context, selected, draftMap, pendingCredentialWrites);
  }

  while (true) {
    const action = await promptOnboardingOptionalCapabilityAction(options.prompt, locale, context);
    if (action === "skip") {
      break;
    }

    const collected = await collectOnboardingOptionalCapability(options, locale, context, action);
    if (collected.kind === "configured") {
      context = collected.context;
      selected.add(action);
      draftMap.set(action, collected.drafts);
      pendingCredentialWrites.push(...collected.pendingCredentialWrites);
    }

    if (onboardingOptionalCapabilityActions(context).length === 0) {
      break;
    }

    const configureMore = await promptSetupChoice(options.prompt, {
      title: setupCopyText(locale, "onboarding.optionalCapabilities.more.title"),
      message: `${setupCopyText(locale, "onboarding.optionalCapabilities.note")}\n`,
      choices: [
        {
          id: "yes",
          label: setupCopyText(locale, "onboarding.optionalCapabilities.more.yes"),
          value: true,
        },
        {
          id: "skip",
          label: setupCopyText(locale, "onboarding.optionalCapabilities.skip"),
          description: setupCopyText(locale, "onboarding.optionalCapabilities.note"),
          value: false,
        },
      ],
      defaultValue: false,
    });

    if (!configureMore) {
      break;
    }
  }

  return onboardingOptionalCapabilityResult(context, selected, draftMap, pendingCredentialWrites);
}

async function promptOnboardingOptionalCapabilityAction(
  prompt: Prompt,
  locale: SetupCopyLocale,
  context: SetupModuleContext
): Promise<OnboardingSupportedOptionalCapabilityId | "skip"> {
  const actions = onboardingOptionalCapabilityActions(context);
  return promptSetupChoice(prompt, {
    title: setupCopyText(locale, "onboarding.optionalCapabilities.menu.title"),
    message: `${setupCopyText(locale, "onboarding.optionalCapabilities")}\n${setupCopyText(locale, "onboarding.optionalCapabilities.note")}\n`,
    choices: [
      ...actions.map((action) => onboardingOptionalCapabilityChoice(action, locale)),
      {
        id: "skip",
        label: setupCopyText(locale, "onboarding.optionalCapabilities.skip"),
        description: setupCopyText(locale, "onboarding.optionalCapabilities.note"),
        value: "skip" as const,
      },
    ],
    defaultValue: "skip" as const,
  });
}

function onboardingOptionalCapabilityActions(
  context: SetupModuleContext
): readonly OnboardingSupportedOptionalCapabilityId[] {
  const actions: OnboardingSupportedOptionalCapabilityId[] = [];
  if (telegramSetupModule.detect(context).status !== "configured") {
    actions.push("channels");
  }
  if (context.voice?.sttProvider === undefined || context.voice.ttsProvider === undefined) {
    actions.push("voice");
  }
  if (browserSetupModule.detect(context).status !== "configured") {
    actions.push("browser");
  }
  return actions;
}

function onboardingOptionalCapabilityChoice(
  action: OnboardingSupportedOptionalCapabilityId,
  locale: SetupCopyLocale
): {
  readonly id: OnboardingSupportedOptionalCapabilityId;
  readonly label: string;
  readonly description: string;
  readonly value: OnboardingSupportedOptionalCapabilityId;
} {
  switch (action) {
    case "channels":
      return {
        id: "channels",
        label: setupCopyText(locale, "setupEditor.actions.configureChannels"),
        description: setupCopyText(locale, "setupEditor.actions.configureChannels.description"),
        value: "channels",
      };
    case "voice":
      return {
        id: "voice",
        label: setupCopyText(locale, "setupEditor.actions.configureVoice"),
        description: setupCopyText(locale, "setupEditor.actions.configureVoice.description"),
        value: "voice",
      };
    case "browser":
      return {
        id: "browser",
        label: setupCopyText(locale, "setupEditor.actions.configureBrowser"),
        description: setupCopyText(locale, "setupEditor.actions.configureBrowser.description"),
        value: "browser",
      };
  }
}

async function collectOnboardingOptionalCapability(
  options: FirstRunSetupRunnerOptions,
  locale: SetupCopyLocale,
  context: SetupModuleContext,
  action: OnboardingSupportedOptionalCapabilityId
): Promise<
  | {
      readonly kind: "configured";
      readonly context: SetupModuleContext;
      readonly drafts: readonly SetupDraft[];
      readonly pendingCredentialWrites: readonly PendingCredentialWrite[];
    }
  | {
      readonly kind: "skip" | "unchanged";
    }
> {
  const module = action === "channels"
    ? telegramSetupModule
    : action === "voice" ? voiceSetupModule : browserSetupModule;
  const voiceMode = action === "voice"
    ? await promptVoiceCapability(options.prompt, locale)
    : undefined;
  const collected = await collectOptionalCapabilityContext({
    homeDir: options.homeDir,
    profileId: options.profileId,
    workspaceRoot: context.workspaceRoot ?? options.workspaceRoot,
    trustStorePath: context.trustStorePath,
    configPath: context.configPath,
    prompt: options.prompt,
    locale,
  }, context, module, voiceMode);

  if (collected.kind !== "configured") {
    return collected;
  }

  const collectedContext = action === "voice"
    ? {
        ...collected.context,
        voice: {
          ...context.voice,
          ...collected.context.voice,
        },
      }
    : collected.context;
  const configuration = module.configure(collectedContext);
  return {
    kind: "configured",
    context: collectedContext,
    drafts: module.toDrafts(collectedContext, configuration),
    pendingCredentialWrites: collected.pendingCredentialWrite === undefined
      ? []
      : [collected.pendingCredentialWrite],
  };
}

function onboardingOptionalCapabilityResult(
  context: SetupModuleContext,
  selected: ReadonlySet<OnboardingSupportedOptionalCapabilityId>,
  draftMap: ReadonlyMap<OnboardingSupportedOptionalCapabilityId, readonly SetupDraft[]>,
  pendingCredentialWrites: readonly PendingCredentialWrite[]
): OnboardingOptionalCapabilityFlowResult {
  return {
    selected: [...selected],
    summaries: {
      selected: [...selected],
      channels: {
        telegram: telegramSetupModule.detect(context).status === "configured" ? "configured" : "not_set",
      },
      voice: {
        stt: context.voice?.sttProvider === undefined ? "not_set" : "configured",
        tts: context.voice?.ttsProvider === undefined ? "not_set" : "configured",
      },
      browser: browserSetupModule.detect(context).status === "configured" ? "configured" : "not_set",
    },
    drafts: [...draftMap.values()].flat(),
    pendingCredentialWrites,
  };
}

function write(options: FirstRunSetupRunnerOptions, value: string): void {
  options.output?.write(value);
}
