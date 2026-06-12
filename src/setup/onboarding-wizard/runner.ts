import { resolveStateHome } from "../../config/state-home.js";
import {
  loadRuntimeConfig,
} from "../../config/runtime-config.js";
import { defaultProfileId, readActiveProfile, resolveProfileStateHome } from "../../config/profile-home.js";
import { ensureDefaultProfileState } from "../../cli/profile-state.js";
import type { Prompt } from "../../cli/readline-prompt.js";
import { withPromptUiContext } from "../../cli/readline-prompt.js";
import { promptUiContextForLocale } from "../../contracts/ui.js";
import { promptForApiKeyInput } from "../../cli/secret-prompt.js";
import {
  createProviderModelSelectionFlow,
  type FlowEngine,
} from "../../providers/provider-model-selection-flow.js";
import type {
  OnboardingCredentialSummaryStatus,
  OnboardingOptionalCapabilitySummaryStatus,
  OnboardingOptionalCapabilitySummaries,
  OnboardingSupportedOptionalCapabilityId,
  OnboardingWizardSelections,
  OnboardingWizardState,
} from "./state.js";
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
  setupProviderCredentialQuestion,
  setupPromptWithDefault,
  setupPromptContext,
  setupCopyText,
  showSetupCard,
} from "../setup-prompts.js";
import {
  promptModelCandidate,
  promptChannelCapability,
  promptProviderCandidate,
  promptVoiceCapability,
} from "../config-editor/prompts.js";
import {
  collectOptionalCapabilityContext,
  setupModuleContextFromConfig,
} from "../optional-capability-flow.js";
import {
  maybeOfferGatewayStartAfterChannelSetup,
  type GatewayServiceActivationOptions,
  type GatewayServiceActivationResult,
} from "../gateway-service-activation.js";
import {
  browserSetupModule,
  telegramSetupModule,
  whatsappSetupModule,
  voiceSetupModule,
  type SetupModuleContext,
} from "../setup-modules.js";
import {
  runWhatsAppSetupFlow,
  type WhatsAppSetupDependencies,
} from "../whatsapp-setup-flow.js";

export type FirstRunSetupRunnerOptions = CollectSetupEntryStateOptions & {
  readonly prompt: Prompt;
  readonly flowEngine?: FlowEngine;
  readonly defaultSelections?: OnboardingWizardSelections;
  readonly applyExecutor?: SetupApplyExecutor;
  readonly applyFlowOptions?: SetupApplyFlowOptions;
  readonly gatewayServiceActivation?: {
    readonly serviceActions?: GatewayServiceActivationOptions["serviceActions"];
  };
  readonly whatsappSetupDependencies?: WhatsAppSetupDependencies;
  readonly output?: {
    readonly write: (value: string) => void;
  };
};

export type FirstRunSetupRunnerResult = {
  readonly completed: boolean;
  readonly exitCode: number;
  readonly output: string;
  readonly launchRequested?: boolean;
  readonly state: SetupEntryState;
  readonly selections: OnboardingWizardSelections;
  readonly wizardState: OnboardingWizardState;
  readonly draftBundle: SetupDraftBundle;
  readonly reviewManifest: SetupReviewManifest;
  readonly applyPlanningResult: SetupApplyPlanningResult;
  readonly applyEndState?: SetupApplyEndState;
  readonly gatewayServiceActivationResult?: GatewayServiceActivationResult;
};

type PendingCredentialWrite = SetupDeferredSecretWrite;

type WorkspaceTrustAction = "trust" | "change-workspace" | "decide-later";

type OnboardingOptionalCapabilityFlowResult = {
  readonly selected: readonly OnboardingSupportedOptionalCapabilityId[];
  readonly summaries: OnboardingOptionalCapabilitySummaries;
  readonly drafts: readonly SetupDraft[];
  readonly pendingCredentialWrites: readonly PendingCredentialWrite[];
  readonly channelSummaries?: {
    readonly whatsapp?: OnboardingOptionalCapabilitySummaryStatus;
  };
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
  const initialPromptContext = setupPromptContext(prompt, initialLocale);

  await showSetupCard(initialPromptContext, {
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
  const localizedOptions: FirstRunSetupRunnerOptions = {
    ...options,
    prompt: withPromptUiContext(prompt, promptUiContextForLocale(language)),
  };
  const promptContext = setupPromptContext(localizedOptions.prompt, language);

  const workspaceSelection = await promptForWorkspaceAndTrust(localizedOptions, language);
  const workspaceRoot = workspaceSelection.workspaceRoot;
  const workspaceTrusted = workspaceSelection.workspaceTrusted;


  const providerCandidates = await flowEngine.listProviderCandidates();
  if (providerCandidates.length === 0) {
    throw new Error("No setup-visible provider candidates are available.");
  }
  const primaryProviderCandidate = await promptProviderCandidate(localizedOptions.prompt, {
    candidates: providerCandidates,
    currentProviderId: options.defaultSelections?.primaryProvider,
  }, language);
  const primaryProvider = primaryProviderCandidate.id;


  const modelCandidates = await flowEngine.listModelCandidates(primaryProvider);
  if (modelCandidates.length === 0) {
    throw new Error(`No setup-visible models are available for ${primaryProviderCandidate.displayName}.`);
  }
  const primaryModelCandidate = await promptModelCandidate(localizedOptions.prompt, {
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

  let primaryCredential: OnboardingWizardSelections["primaryCredential"];
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
        prompt: localizedOptions.prompt,
        providerId: primaryProvider,
        envVarName,
        question: setupProviderCredentialQuestion(language, {
          providerName: primaryProviderCandidate.displayName,
          envVarName,
        }),
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

  const securityMode = await promptSetupChoice(promptContext, {
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

  const workflowLearning = await promptSetupChoice(promptContext, {
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
  const optionalCapabilityFlow = await chooseOptionalCapabilities(localizedOptions, language, {
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

  const selections: OnboardingWizardSelections = {
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
  };

  const wizardState = onboardingWizardStateFromSelections(selections, credentialStatus, optionalCapabilityFlow);
  const draftBundle = buildOnboardingWizardDraftBundle(wizardState, {
    configPath,
    workspaceRoot,
    trustStorePath: stateHome.trustJsonPath,
  });
  const reviewManifest = buildSetupReviewManifest([draftBundle]);
  const summaryText = renderOnboardingWizardSummary(wizardState, language);
  write(options, `${summaryText}\n`);

  const reviewAccepted = await promptSetupChoice(promptContext, {
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
        mode: "firstRunTolerant",
        ...(pendingCredentialWrites.length > 0
          ? { deferredSecretWrites: pendingCredentialWrites }
          : {}),
      })
    : undefined;
  const renderedApplyOutput = applyEndState === undefined
    ? renderSetupApplyPlanningResult(applyPlanningResult, language)
    : renderOnboardingApplyEndState(applyEndState, language);
  const completed = applyEndState === undefined
    ? applyPlanningResult.kind === "apply-plan-ready"
    : applyEndState.kind !== "blocked" && applyEndState.kind !== "cancelled";
  const gatewayServiceActivationResult = applyEndState === undefined
    ? undefined
    : await maybeOfferGatewayStartAfterChannelSetup({
        prompt: localizedOptions.prompt,
        locale: language,
        homeDir: options.homeDir,
        workspaceRoot,
        profileId,
        reviewManifest,
        readinessGate: completed && workspaceTrusted && isPostSetupLaunchOfferableEndState(applyEndState),
        serviceActions: options.gatewayServiceActivation?.serviceActions,
      });
  const gatewayServiceActivationOutput = gatewayServiceActivationResult !== undefined && "output" in gatewayServiceActivationResult
    ? gatewayServiceActivationResult.output
    : undefined;
  if (gatewayServiceActivationOutput !== undefined) {
    write(options, `${gatewayServiceActivationOutput}\n`);
  }
  const launchRequested = await promptForPostSetupLaunchRequest({
    options,
    prompt: localizedOptions.prompt,
    locale: language,
    completed,
    workspaceTrusted,
    applyEndState,
  });
  const output = workspaceTrusted || !completed
    ? [renderedApplyOutput, gatewayServiceActivationOutput].filter((line): line is string => line !== undefined).join("\n")
    : setupCopyText(language, "onboarding.workspace.trust.deferredFinal");

  return {
    completed,
    exitCode: completed ? 0 : 1,
    output,
    launchRequested,
    state,
    selections: finalSelections,
    wizardState,
    draftBundle,
    reviewManifest,
    applyPlanningResult,
    applyEndState,
    gatewayServiceActivationResult,
  };
}

async function promptForPostSetupLaunchRequest(input: {
  readonly options: FirstRunSetupRunnerOptions;
  readonly prompt: Prompt;
  readonly locale: SetupCopyLocale;
  readonly completed: boolean;
  readonly workspaceTrusted: boolean;
  readonly applyEndState?: SetupApplyEndState;
}): Promise<boolean | undefined> {
  if (
    !input.completed ||
    !input.workspaceTrusted ||
    input.applyEndState === undefined ||
    !isPostSetupLaunchOfferableEndState(input.applyEndState)
  ) {
    return undefined;
  }

  return promptSetupChoice(setupPromptContext(input.prompt, input.locale), {
    title: setupCopyText(input.locale, "onboarding.launch.startNow"),
    message: `${setupCopyText(input.locale, "onboarding.launch.startNow")}\n`,
    choices: [
      {
        id: "yes",
        label: setupCopyText(input.locale, "onboarding.launch.startNow.yes"),
        value: true,
      },
      {
        id: "no",
        label: setupCopyText(input.locale, "onboarding.launch.startNow.no"),
        value: false,
      },
    ],
    defaultValue: false,
  });
}

function renderOnboardingApplyEndState(
  endState: SetupApplyEndState,
  locale: SetupCopyLocale
): string {
  const base = renderSetupApplyEndState(endState, locale);
  const warningOutput = renderOnboardingOptionalCapabilityWarnings(endState, locale);
  return [base, warningOutput].filter((line): line is string => line !== undefined).join("\n");
}

function renderOnboardingOptionalCapabilityWarnings(
  endState: SetupApplyEndState,
  locale: SetupCopyLocale
): string | undefined {
  const warnings = "warnings" in endState ? endState.warnings ?? [] : [];
  if (warnings.length === 0) return undefined;
  return [
    `${setupCopyText(locale, "setupApply.warnings.title")}:`,
    ...warnings.map((warning) => `- ${warning.message}`),
  ].join("\n");
}

function isPostSetupLaunchOfferableEndState(endState: SetupApplyEndState): boolean {
  return endState.kind === "verified-ready" ||
    (endState.kind === "saved-not-launched" && endState.verification !== undefined);
}

function onboardingWizardStateFromSelections(
  selections: OnboardingWizardSelections,
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
    await showSetupCard(setupPromptContext(options.prompt, language), {
      title: setupCopyText(language, "onboarding.workspace.title"),
      bodyLines: [setupCopyText(language, "onboarding.workspace.root")],
      technicalLines: [defaultWorkspaceRoot],
      options: [{ id: "workspace", label: defaultWorkspaceRoot, technical: true }],
    });
    const requestedWorkspaceRoot = await promptSetupStringWithDefault(
      options.prompt,
      setupPromptWithDefault(language, setupCopyText(language, "onboarding.workspace.root"), defaultWorkspaceRoot),
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
    readonly primaryProvider: OnboardingWizardSelections["primaryProvider"];
    readonly primaryModel: OnboardingWizardSelections["primaryModel"];
    readonly securityMode: OnboardingWizardSelections["securityMode"];
    readonly workflowLearning: OnboardingWizardSelections["workflowLearning"];
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
  const channelSummaries: { whatsapp?: OnboardingOptionalCapabilitySummaryStatus } = {};

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
      draftMap.set(action, [...(draftMap.get(action) ?? []), ...collected.drafts]);
      pendingCredentialWrites.push(...collected.pendingCredentialWrites);
    }
    if (collected.channelSummaries?.whatsapp !== undefined) {
      channelSummaries.whatsapp = collected.channelSummaries.whatsapp;
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

  return onboardingOptionalCapabilityResult(context, selected, draftMap, pendingCredentialWrites, channelSummaries);
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
  if (
    telegramSetupModule.detect(context).status !== "configured" ||
    whatsappSetupModule.detect(context).status !== "configured"
  ) {
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
      readonly channelSummaries?: {
        readonly whatsapp?: OnboardingOptionalCapabilitySummaryStatus;
      };
    }
  | {
      readonly kind: "skip" | "unchanged";
      readonly channelSummaries?: {
        readonly whatsapp?: OnboardingOptionalCapabilitySummaryStatus;
      };
    }
> {
  if (action === "channels") {
    const channel = await promptChannelCapability(options.prompt, locale);
    if (channel === "whatsapp") {
      return collectOnboardingWhatsAppSetup(options, locale, context);
    }
    const module = telegramSetupModule;
    const collected = await collectOptionalCapabilityContext({
      homeDir: options.homeDir,
      profileId: options.profileId,
      workspaceRoot: context.workspaceRoot ?? options.workspaceRoot,
      trustStorePath: context.trustStorePath,
      configPath: context.configPath,
      prompt: options.prompt,
      locale,
    }, context, module);

    if (collected.kind !== "configured") {
      return collected;
    }

    const configuration = module.configure(collected.context);
    return {
      kind: "configured",
      context: collected.context,
      drafts: module.toDrafts(collected.context, configuration),
      pendingCredentialWrites: collected.pendingCredentialWrite === undefined
        ? []
        : [collected.pendingCredentialWrite],
    };
  }

  const module = action === "voice" ? voiceSetupModule : browserSetupModule;
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

async function collectOnboardingWhatsAppSetup(
  options: FirstRunSetupRunnerOptions,
  locale: SetupCopyLocale,
  context: SetupModuleContext
): Promise<
  | {
      readonly kind: "configured";
      readonly context: SetupModuleContext;
      readonly drafts: readonly SetupDraft[];
      readonly pendingCredentialWrites: readonly PendingCredentialWrite[];
      readonly channelSummaries?: { readonly whatsapp?: OnboardingOptionalCapabilitySummaryStatus };
    }
  | {
      readonly kind: "skip" | "unchanged";
      readonly channelSummaries?: { readonly whatsapp?: OnboardingOptionalCapabilitySummaryStatus };
    }
> {
  const profileId = options.profileId ?? readActiveProfile({ homeDir: options.homeDir }).profileId ?? defaultProfileId();
  const stateHome = resolveStateHome({ homeDir: options.homeDir });
  const result = await runWhatsAppSetupFlow({
    workspaceRoot: context.workspaceRoot ?? options.workspaceRoot,
    homeDir: stateHome.homeDir,
    profileId,
    prompt: options.prompt,
    output: {
      write: (chunk) => {
        write(options, chunk);
      },
    },
    dependencies: options.whatsappSetupDependencies,
    source: "onboarding",
    locale,
  });
  write(options, `${result.output}\n`);

  if (result.exitCode !== 0) {
    const status: OnboardingOptionalCapabilitySummaryStatus = (
      result.failureReason === "dependency_declined" ||
      result.failureReason === "repair_declined" ||
      result.failureReason === "invalid_mode"
    )
      ? "skipped"
      : "incomplete";
    return {
      kind: "skip",
      channelSummaries: { whatsapp: status },
    };
  }

  const loaded = await loadRuntimeConfig({
    workspaceRoot: context.workspaceRoot ?? options.workspaceRoot,
    homeDir: stateHome.homeDir,
    profileId,
  });
  const updatedContext = setupModuleContextFromConfig({
    homeDir: stateHome.homeDir,
    profileId,
    workspaceRoot: context.workspaceRoot ?? options.workspaceRoot,
    trustStorePath: context.trustStorePath,
    configPath: context.configPath,
  }, loaded.config, {
    provider: context.provider?.id,
    model: context.provider?.model,
    workspaceTrusted: context.workspaceTrust?.trusted,
    securityMode: context.securityMode,
    workflowLearning: context.workflowLearning,
  });
  const whatsappStatus: OnboardingOptionalCapabilitySummaryStatus =
    (loaded.config.channels?.whatsapp?.allowedUsers?.length ?? 0) > 0 ? "configured" : "incomplete";
  return {
    kind: "configured",
    context: updatedContext,
    drafts: [],
    pendingCredentialWrites: [],
    channelSummaries: { whatsapp: whatsappStatus },
  };
}

function onboardingOptionalCapabilityResult(
  context: SetupModuleContext,
  selected: ReadonlySet<OnboardingSupportedOptionalCapabilityId>,
  draftMap: ReadonlyMap<OnboardingSupportedOptionalCapabilityId, readonly SetupDraft[]>,
  pendingCredentialWrites: readonly PendingCredentialWrite[],
  channelSummaries: { readonly whatsapp?: OnboardingOptionalCapabilitySummaryStatus } = {}
): OnboardingOptionalCapabilityFlowResult {
  return {
    selected: [...selected],
    summaries: {
      selected: [...selected],
      channels: {
        telegram: telegramSetupModule.detect(context).status === "configured" ? "configured" : "not_set",
        whatsapp: channelSummaries.whatsapp ?? (whatsappSetupModule.detect(context).status === "configured" ? "configured" : "not_set"),
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
