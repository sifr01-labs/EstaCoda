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
import { isolateLtr } from "../../ui/bidi.js";
import {
  createProviderModelSelectionFlow,
  type FlowEngine,
  type ProviderModelSelectionResult,
} from "../../providers/provider-model-selection-flow.js";
import { getProviderMetadata } from "../../providers/provider-metadata.js";
import { selectProviderModelRoute } from "../provider-model-route-prompt.js";
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
import { promptInterfaceLanguageAndStyle, type InterfaceLanguageAndStyleSelection } from "../interface-preferences.js";
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
  promptSetupChoiceResult,
  promptSetupStringWithDefault,
  renderSetupApplyEndState,
  renderSetupApplyPlanningResult,
  setupNavigationChoice,
  setupProviderCredentialQuestion,
  setupPromptWithDefault,
  setupPromptContext,
  type SetupChoiceResult,
  type SetupPromptContext,
  setupCopyText,
  showSetupCard,
} from "../setup-prompts.js";
import {
  promptChannelCapability,
  promptVoiceCapability,
} from "../config-editor/prompts.js";
import {
  collectOptionalCapabilityContext,
  channelCapabilityModule,
  setupModuleContextFromConfig,
} from "../optional-capability-flow.js";
import {
  maybeOfferGatewayStartAfterChannelSetup,
  type GatewayServiceActivationOptions,
  type GatewayServiceActivationResult,
} from "../gateway-service-activation.js";
import {
  browserSetupModule,
  webSearchSetupModule,
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

type CredentialAction = "enter-api-key" | "reuse-existing-env" | "configure-later";

type SummaryAction = "confirm" | "back" | "cancel";

type OnboardingStep =
  | "language"
  | "workspace"
  | "workspace-trust"
  | "primary-route"
  | "credential"
  | "security"
  | "agent-evolution"
  | "optional-start"
  | "optional-menu"
  | "summary";

type OnboardingOptionalCapabilityFlowResult = {
  readonly selected: readonly OnboardingSupportedOptionalCapabilityId[];
  readonly summaries: OnboardingOptionalCapabilitySummaries;
  readonly drafts: readonly SetupDraft[];
  readonly pendingCredentialWrites: readonly PendingCredentialWrite[];
  readonly channelSummaries?: {
    readonly discord?: OnboardingOptionalCapabilitySummaryStatus;
    readonly whatsapp?: OnboardingOptionalCapabilitySummaryStatus;
    readonly webSearch?: OnboardingOptionalCapabilitySummaryStatus;
  };
  readonly context: SetupModuleContext;
};

type OptionalCapabilitiesScreen = "start" | "capability-menu";

type OnboardingOptionalCapabilityNavigationResult =
  | {
      readonly kind: "completed";
      readonly flow: OnboardingOptionalCapabilityFlowResult;
      readonly summaryBackTarget: OnboardingStep;
    }
  | {
      readonly kind: "back";
    };

type OnboardingWizardDraft = {
  localizedOptions?: FirstRunSetupRunnerOptions;
  promptContext?: SetupPromptContext;
  interfaceChoice?: InterfaceLanguageAndStyleSelection;
  workspaceRoot?: string;
  workspaceTrusted?: boolean;
  primaryRoute?: ProviderModelSelectionResult;
  primaryCredential?: OnboardingWizardSelections["primaryCredential"];
  credentialStatus: OnboardingCredentialSummaryStatus;
  primaryPendingCredentialWrites: PendingCredentialWrite[];
  optionalPendingCredentialWrites: PendingCredentialWrite[];
  securityMode?: NonNullable<OnboardingWizardSelections["securityMode"]>;
  workflowLearning?: NonNullable<OnboardingWizardSelections["workflowLearning"]>;
  profileId?: string;
  configPath?: string;
  optionalCapabilityFlow?: OnboardingOptionalCapabilityFlowResult;
  selections?: OnboardingWizardSelections;
  wizardState?: OnboardingWizardState;
  draftBundle?: SetupDraftBundle;
  reviewManifest?: SetupReviewManifest;
  summaryText?: string;
  reviewAccepted?: boolean;
  finalSelections?: OnboardingWizardSelections;
  summaryBackTarget?: OnboardingStep;
  optionalInitialScreen?: OptionalCapabilitiesScreen;
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

  const draft: OnboardingWizardDraft = {
    credentialStatus: "not_set",
    primaryPendingCredentialWrites: [],
    optionalPendingCredentialWrites: [],
  };
  let step: OnboardingStep = "language";
  let setupReviewReady = false;

  while (!setupReviewReady) {
    switch (step) {
      case "language": {
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
        draft.interfaceChoice = interfaceChoice;
        draft.localizedOptions = localizedOptions;
        draft.promptContext = setupPromptContext(localizedOptions.prompt, language);
        step = "workspace";
        break;
      }

      case "workspace": {
        const interfaceChoice = requireDraftValue(draft.interfaceChoice, "interface choice");
        const localizedOptions = requireDraftValue(draft.localizedOptions, "localized setup options");
        draft.workspaceRoot = await promptForCanonicalWorkspaceRoot(localizedOptions, interfaceChoice.language, draft.workspaceRoot);
        step = "workspace-trust";
        break;
      }

      case "workspace-trust": {
        const interfaceChoice = requireDraftValue(draft.interfaceChoice, "interface choice");
        const localizedOptions = requireDraftValue(draft.localizedOptions, "localized setup options");
        const workspaceRoot = requireDraftValue(draft.workspaceRoot, "workspace root");
        const action = await promptForWorkspaceTrustAction(localizedOptions, interfaceChoice.language, workspaceRoot);
        if (action.kind === "back") {
          step = "language";
          break;
        }
        const trustAction = action.value;
        if (trustAction === "change-workspace") {
          step = "workspace";
          break;
        }
        draft.workspaceTrusted = trustAction === "trust";
        step = "primary-route";
        break;
      }

      case "primary-route": {
        const interfaceChoice = requireDraftValue(draft.interfaceChoice, "interface choice");
        const localizedOptions = requireDraftValue(draft.localizedOptions, "localized setup options");
        const routeSelection = await selectProviderModelRoute({
          prompt: localizedOptions.prompt,
          flowEngine,
          locale: interfaceChoice.language,
          currentProviderId: draft.primaryRoute?.provider ?? options.defaultSelections?.primaryProvider,
          currentModelId: draft.primaryRoute?.model ?? options.defaultSelections?.primaryModel,
          allowBack: true,
          allowCancel: false,
          mode: "onboarding",
        });
        if (routeSelection.kind === "back") {
          step = "workspace-trust";
          break;
        }
        if (routeSelection.kind !== "selected") {
          throw new Error(routeSelection.kind === "diagnostic"
            ? routeSelection.output
            : "Provider/model selection was not completed.");
        }
        draft.primaryRoute = routeSelection.selection;
        step = "credential";
        break;
      }

      case "credential": {
        const interfaceChoice = requireDraftValue(draft.interfaceChoice, "interface choice");
        const localizedOptions = requireDraftValue(draft.localizedOptions, "localized setup options");
        const resolution = requireDraftValue(draft.primaryRoute, "primary provider/model route");
        draft.credentialStatus = "not_set";
        draft.primaryPendingCredentialWrites = [];

        switch (resolution.credentialAction.kind) {
          case "none": {
            draft.primaryCredential = { kind: "none" };
            write(options, `${setupCopyText(interfaceChoice.language, "onboarding.providers.primaryCredential.localProviderSkip")}\n`);
            break;
          }
          case "reuse": {
            const ref = resolution.credentialAction.reference;
            if (!ref.startsWith("env:")) {
              throw new Error(`Malformed reuse credential reference: ${ref}`);
            }
            const envVarName = ref.slice(4);
            const action = await promptOnboardingCredentialAction(localizedOptions.prompt, interfaceChoice.language, {
              envVarName,
              allowReuseExistingEnv: true,
              defaultValue: "reuse-existing-env",
            });
            if (action.kind === "back") {
              step = "primary-route";
              continue;
            }
            draft.primaryCredential = { kind: "env", name: envVarName };
            if (action.value === "enter-api-key") {
              const promptResult = await promptForApiKeyInput({
                prompt: localizedOptions.prompt,
                providerId: resolution.provider,
                envVarName,
                question: setupProviderCredentialQuestion(interfaceChoice.language, {
                  providerName: getProviderMetadata(resolution.provider).displayName,
                  envVarName,
                }),
              });

              if (promptResult.kind === "skipped") {
                write(options, `Config will expect ${envVarName} to be available externally.\n`);
              } else {
                draft.credentialStatus = "new_pending";
                draft.primaryPendingCredentialWrites.push({
                  envVarName: promptResult.envVarName,
                  value: promptResult.value,
                });
              }
            } else if (action.value === "reuse-existing-env") {
              draft.credentialStatus = "existing_detected";
              write(options, `Using existing credential from ${envVarName}.\n`);
            } else {
              write(options, `Config will expect ${envVarName} to be available externally.\n`);
            }
            break;
          }
          case "collect": {
            const envVarName = resolution.credentialAction.envVarName;
            const action = await promptOnboardingCredentialAction(localizedOptions.prompt, interfaceChoice.language, {
              envVarName,
              allowReuseExistingEnv: false,
              defaultValue: "enter-api-key",
            });
            if (action.kind === "back") {
              step = "primary-route";
              continue;
            }
            draft.primaryCredential = { kind: "env", name: envVarName };
            if (action.value === "configure-later") {
              write(options, `Config will expect ${envVarName} to be available externally.\n`);
              break;
            }

            const promptResult = await promptForApiKeyInput({
              prompt: localizedOptions.prompt,
              providerId: resolution.provider,
              envVarName,
              question: setupProviderCredentialQuestion(interfaceChoice.language, {
                providerName: getProviderMetadata(resolution.provider).displayName,
                envVarName,
              }),
            });
            if (promptResult.kind === "skipped") {
              write(options, `Config will expect ${envVarName} to be available externally.\n`);
            } else {
              draft.credentialStatus = "new_pending";
              draft.primaryPendingCredentialWrites.push({
                envVarName: promptResult.envVarName,
                value: promptResult.value,
              });
            }
            break;
          }
          case "endpoint": {
            const baseUrl = await promptOnboardingLocalEndpointBaseUrl(
              localizedOptions,
              interfaceChoice.language,
              resolution.credentialAction.baseUrl ?? resolution.baseUrl ?? ""
            );
            draft.primaryRoute = {
              ...resolution,
              baseUrl,
            };
            const envVarName = resolution.credentialAction.apiKeyEnv;
            const promptResult = await promptForApiKeyInput({
              prompt: localizedOptions.prompt,
              providerId: resolution.provider,
              envVarName,
              question: formatSetupCopy(interfaceChoice.language, "onboarding.providers.localEndpoint.apiKeyOptional", {
                envVar: envVarName,
              }),
            });
            if (promptResult.kind === "skipped") {
              draft.primaryCredential = { kind: "none" };
            } else {
              draft.primaryCredential = { kind: "env", name: envVarName };
              draft.credentialStatus = "new_pending";
              draft.primaryPendingCredentialWrites.push({
                envVarName: promptResult.envVarName,
                value: promptResult.value,
              });
            }
            break;
          }
          case "oauth": {
            write(options, `OAuth setup for ${resolution.provider}/${resolution.model} is not available in onboarding. Run estacoda model setup ${resolution.provider}.\n`);
            step = "primary-route";
            continue;
          }
        }

        step = "security";
        break;
      }

      case "security": {
        const interfaceChoice = requireDraftValue(draft.interfaceChoice, "interface choice");
        const promptContext = requireDraftValue(draft.promptContext, "setup prompt context");
        const securityResult = await promptSetupChoiceResult(promptContext, {
          title: setupCopyText(interfaceChoice.language, "onboarding.security.title"),
          message: `${setupCopyText(interfaceChoice.language, "onboarding.security")}\n`,
          choices: [
            {
              id: "adaptive",
              label: setupCopyText(interfaceChoice.language, "onboarding.security.options.adaptive.label"),
              description: setupCopyText(interfaceChoice.language, "onboarding.security.options.adaptive.description"),
              value: "adaptive" as const,
            },
            {
              id: "strict",
              label: setupCopyText(interfaceChoice.language, "onboarding.security.options.strict.label"),
              description: setupCopyText(interfaceChoice.language, "onboarding.security.options.strict.description"),
              value: "strict" as const,
            },
            {
              id: "open",
              label: setupCopyText(interfaceChoice.language, "onboarding.security.options.open.label"),
              description: setupCopyText(interfaceChoice.language, "onboarding.security.options.open.description"),
              value: "open" as const,
            },
          ],
          defaultValue: draft.securityMode ?? options.defaultSelections?.securityMode ?? "adaptive",
          allowBack: true,
        });
        if (securityResult.kind === "back") {
          step = draft.primaryRoute?.credentialAction.kind === "none" ? "primary-route" : "credential";
          break;
        }
        draft.securityMode = securityResult.value;
        step = "agent-evolution";
        break;
      }

      case "agent-evolution": {
        const interfaceChoice = requireDraftValue(draft.interfaceChoice, "interface choice");
        const promptContext = requireDraftValue(draft.promptContext, "setup prompt context");
        const workflowResult = await promptSetupChoiceResult(promptContext, {
          title: setupCopyText(interfaceChoice.language, "onboarding.workflowLearning.title"),
          message: `${setupCopyText(interfaceChoice.language, "onboarding.workflowLearning")}\n`,
          choices: [
            {
              id: "suggest",
              label: setupCopyText(interfaceChoice.language, "onboarding.workflowLearning.options.suggest.label"),
              description: setupCopyText(interfaceChoice.language, "onboarding.workflowLearning.options.suggest.description"),
              value: "suggest" as const,
            },
            {
              id: "proactive",
              label: setupCopyText(interfaceChoice.language, "onboarding.workflowLearning.options.proactive.label"),
              description: setupCopyText(interfaceChoice.language, "onboarding.workflowLearning.options.proactive.description"),
              value: "proactive" as const,
            },
            {
              id: "autonomous",
              label: setupCopyText(interfaceChoice.language, "onboarding.workflowLearning.options.autonomous.label"),
              description: setupCopyText(interfaceChoice.language, "onboarding.workflowLearning.options.autonomous.description"),
              value: "autonomous" as const,
            },
            {
              id: "none",
              label: setupCopyText(interfaceChoice.language, "onboarding.workflowLearning.options.none.label"),
              description: setupCopyText(interfaceChoice.language, "onboarding.workflowLearning.options.none.description"),
              value: "none" as const,
            },
          ],
          defaultValue: draft.workflowLearning ?? options.defaultSelections?.workflowLearning ?? "suggest",
          allowBack: true,
        });
        if (workflowResult.kind === "back") {
          step = "security";
          break;
        }
        draft.workflowLearning = workflowResult.value;
        step = "optional-start";
        break;
      }

      case "optional-start": {
        const profileId = options.profileId ?? readActiveProfile({ homeDir: options.homeDir }).profileId ?? defaultProfileId();
        draft.profileId = profileId;
        draft.configPath = resolveProfileStateHome({ homeDir: options.homeDir, profileId }).configPath;
        step = "optional-menu";
        break;
      }

      case "optional-menu": {
        const interfaceChoice = requireDraftValue(draft.interfaceChoice, "interface choice");
        const localizedOptions = requireDraftValue(draft.localizedOptions, "localized setup options");
        const configPath = requireDraftValue(draft.configPath, "profile config path");
        const profileId = requireDraftValue(draft.profileId, "profile id");
        const workspaceRoot = requireDraftValue(draft.workspaceRoot, "workspace root");
        const workspaceTrusted = requireDraftValue(draft.workspaceTrusted, "workspace trust decision");
        const primaryRoute = requireDraftValue(draft.primaryRoute, "primary provider/model route");
        const securityMode = requireDraftValue(draft.securityMode, "security mode");
        const workflowLearning = requireDraftValue(draft.workflowLearning, "Agent Evolution mode");
        const optionalCapabilityFlow = await chooseOptionalCapabilities(localizedOptions, interfaceChoice.language, {
          configPath,
          profileId,
          workspaceRoot,
          workspaceTrusted,
          primaryProvider: primaryRoute.provider,
          primaryModel: primaryRoute.model,
          securityMode,
          workflowLearning,
          initialFlow: draft.optionalCapabilityFlow,
          initialScreen: draft.optionalInitialScreen ?? "start",
        });
        draft.optionalInitialScreen = undefined;
        if (optionalCapabilityFlow.kind === "back") {
          step = "agent-evolution";
          break;
        }
        draft.optionalCapabilityFlow = optionalCapabilityFlow.flow;
        draft.optionalPendingCredentialWrites = [...optionalCapabilityFlow.flow.pendingCredentialWrites];
        draft.summaryBackTarget = optionalCapabilityFlow.summaryBackTarget;
        step = "summary";
        break;
      }

      case "summary": {
        const interfaceChoice = requireDraftValue(draft.interfaceChoice, "interface choice");
        const promptContext = requireDraftValue(draft.promptContext, "setup prompt context");
        const workspaceRoot = requireDraftValue(draft.workspaceRoot, "workspace root");
        const workspaceTrusted = requireDraftValue(draft.workspaceTrusted, "workspace trust decision");
        const primaryRoute = requireDraftValue(draft.primaryRoute, "primary provider/model route");
        const primaryCredential = requireDraftValue(draft.primaryCredential, "primary credential");
        const securityMode = requireDraftValue(draft.securityMode, "security mode");
        const workflowLearning = requireDraftValue(draft.workflowLearning, "Agent Evolution mode");
        const optionalCapabilityFlow = requireDraftValue(draft.optionalCapabilityFlow, "optional capability flow");
        const configPath = requireDraftValue(draft.configPath, "profile config path");

        const selections: OnboardingWizardSelections = {
          language: interfaceChoice.language,
          interfaceFlavor: interfaceChoice.flavor,
          activityLabels: interfaceChoice.activityLabels,
          workspaceRoot,
          workspaceTrusted,
          primaryProvider: primaryRoute.provider,
          primaryModel: primaryRoute.model,
          primaryBaseUrl: primaryRoute.baseUrl,
          primaryContextWindowTokens: primaryRoute.profile.contextWindowTokens,
          primaryApiMode: primaryRoute.apiMode,
          primaryAuthMethod: primaryRoute.authMethod,
          primaryCredential,
          securityMode,
          workflowLearning,
          optionalCapabilities: optionalCapabilityFlow.selected,
        };

        const wizardState = onboardingWizardStateFromSelections(selections, draft.credentialStatus, optionalCapabilityFlow);
        const draftBundle = buildOnboardingWizardDraftBundle(wizardState, {
          configPath,
          workspaceRoot,
          trustStorePath: stateHome.trustJsonPath,
        });
        const reviewManifest = buildSetupReviewManifest([draftBundle]);
        const summaryText = renderOnboardingWizardSummary(wizardState, interfaceChoice.language);
        write(options, `${summaryText}\n`);

        const summaryAction = await promptOnboardingSummaryAction(promptContext, interfaceChoice.language, summaryText, options.defaultSelections?.reviewAccepted ?? true);
        if (summaryAction === "back") {
          draft.optionalInitialScreen = draft.summaryBackTarget === "optional-menu" ? "capability-menu" : "start";
          step = draft.summaryBackTarget ?? "optional-start";
          break;
        }

        const reviewAccepted = summaryAction === "confirm";
        draft.selections = selections;
        draft.wizardState = wizardState;
        draft.draftBundle = draftBundle;
        draft.reviewManifest = reviewManifest;
        draft.summaryText = summaryText;
        draft.reviewAccepted = reviewAccepted;
        draft.finalSelections = {
          ...selections,
          reviewAccepted,
          saveAccepted: reviewAccepted,
        };
        setupReviewReady = true;
        break;
      }
    }
  }

  const interfaceChoice = requireDraftValue(draft.interfaceChoice, "interface choice");
  const language = interfaceChoice.language;
  const localizedOptions = requireDraftValue(draft.localizedOptions, "localized setup options");
  const workspaceRoot = requireDraftValue(draft.workspaceRoot, "workspace root");
  const workspaceTrusted = requireDraftValue(draft.workspaceTrusted, "workspace trust decision");
  const profileId = requireDraftValue(draft.profileId, "profile id");
  const reviewManifest = requireDraftValue(draft.reviewManifest, "setup review manifest");
  const reviewAccepted = requireDraftValue(draft.reviewAccepted, "setup review decision");
  const finalSelections = requireDraftValue(draft.finalSelections, "final onboarding selections");
  const wizardState = requireDraftValue(draft.wizardState, "onboarding wizard state");
  const draftBundle = requireDraftValue(draft.draftBundle, "onboarding draft bundle");
  const applyPlanningResult = planSetupApply(reviewAccepted
    ? { kind: "approved-review-result", manifest: reviewManifest }
    : { kind: "cancelled-review-result", manifest: reviewManifest, reason: "User cancelled summary confirmation." });
  const pendingCredentialWrites = [
    ...draft.primaryPendingCredentialWrites,
    ...draft.optionalPendingCredentialWrites,
  ];
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

async function promptOnboardingLocalEndpointBaseUrl(
  options: FirstRunSetupRunnerOptions,
  locale: SetupCopyLocale,
  defaultBaseUrl: string
): Promise<string> {
  let question = formatSetupCopy(locale, "onboarding.providers.localEndpoint.baseUrl", {
    baseUrl: defaultBaseUrl,
  });
  for (;;) {
    const raw = (await options.prompt(question)).trim();
    const baseUrl = raw.length > 0 ? raw : defaultBaseUrl;
    if (isValidEndpointBaseUrl(baseUrl)) {
      return baseUrl;
    }
    question = `${formatSetupCopy(locale, "onboarding.providers.localEndpoint.invalidBaseUrl", {
      baseUrl: defaultBaseUrl,
    })}\n${formatSetupCopy(locale, "onboarding.providers.localEndpoint.baseUrl", {
      baseUrl: defaultBaseUrl,
    })}`;
  }
}

function isValidEndpointBaseUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
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

async function promptForWorkspaceTrustAction(
  options: FirstRunSetupRunnerOptions,
  language: SetupCopyLocale,
  workspaceRoot: string
): Promise<SetupChoiceResult<WorkspaceTrustAction>> {
  return promptSetupChoiceResult<WorkspaceTrustAction>(options.prompt, {
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
    allowBack: true,
  });
}

async function promptOnboardingCredentialAction(
  prompt: Prompt,
  locale: SetupCopyLocale,
  input: {
    readonly envVarName: string;
    readonly allowReuseExistingEnv: boolean;
    readonly defaultValue: CredentialAction;
  }
): Promise<SetupChoiceResult<CredentialAction>> {
  const envVarName = locale === "ar" ? isolateLtr(input.envVarName) : input.envVarName;
  const reuseChoices = input.allowReuseExistingEnv
    ? [{
        id: "reuse-existing-env",
        label: locale === "ar" ? "استخدام متغير بيئة موجود" : "Reuse existing env var",
        description: envVarName,
        technical: true,
        value: "reuse-existing-env" as const,
      }]
    : [];

  return promptSetupChoiceResult(prompt, {
    title: locale === "ar" ? "بيانات الاعتماد" : "Credential handling",
    message: `${setupProviderCredentialPromptMessage(locale, input.envVarName)}\n`,
    choices: [
      {
        id: "enter-api-key",
        label: locale === "ar" ? "إدخال مفتاح API" : "Enter API key",
        description: locale === "ar" ? "احفظ المفتاح بعد مراجعة خطة الإعداد." : "Store the key after the setup review is approved.",
        value: "enter-api-key" as const,
      },
      ...reuseChoices,
      {
        id: "configure-later",
        label: locale === "ar" ? "الضبط لاحقًا" : "Configure later",
        description: locale === "ar"
          ? `سيستخدم الإعداد ${envVarName} عندما يتوفر خارج المعالج.`
          : `Config will use ${envVarName} when it is available outside the wizard.`,
        technical: true,
        value: "configure-later" as const,
      },
    ],
    defaultValue: input.defaultValue,
    allowBack: true,
  });
}

function setupProviderCredentialPromptMessage(locale: SetupCopyLocale, envVarName: string): string {
  const renderedEnvVarName = locale === "ar" ? isolateLtr(envVarName) : envVarName;
  return locale === "ar"
    ? `اختر كيفية التعامل مع متغير بيانات الاعتماد ${renderedEnvVarName}.`
    : `Choose how to handle the credential environment variable ${renderedEnvVarName}.`;
}

async function promptOnboardingSummaryAction(
  promptContext: SetupPromptContext,
  locale: SetupCopyLocale,
  summaryText: string,
  defaultReviewAccepted: boolean
): Promise<SummaryAction> {
  return promptSetupChoice(promptContext, {
    title: setupCopyText(locale, "onboarding.summary.confirmTitle"),
    message: `${summaryText}\n\n${setupCopyText(locale, "onboarding.summary.confirmMessage")}\n`,
    choices: [
      {
        id: "confirm",
        label: setupCopyText(locale, "onboarding.summary.confirmAction"),
        description: setupCopyText(locale, "setupApply.review.approved"),
        value: "confirm" as const,
      },
      setupNavigationChoice({
        id: "back",
        label: locale === "ar" ? "رجوع" : "Back",
        description: setupCopyText(locale, "onboarding.providers.navigation.back.description"),
        value: "back" as const,
      }),
      setupNavigationChoice({
        id: "cancel",
        label: setupCopyText(locale, "onboarding.summary.cancelAction"),
        description: setupCopyText(locale, "setupApply.review.cancelled"),
        value: "cancel" as const,
      }),
    ],
    defaultValue: defaultReviewAccepted ? "confirm" : "cancel",
  });
}

async function promptForCanonicalWorkspaceRoot(
  options: FirstRunSetupRunnerOptions,
  language: SetupCopyLocale,
  currentWorkspaceRoot?: string
): Promise<string> {
  let defaultWorkspaceRoot = currentWorkspaceRoot ?? options.defaultSelections?.workspaceRoot ?? options.workspaceRoot;

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
    readonly initialFlow?: OnboardingOptionalCapabilityFlowResult;
    readonly initialScreen?: OptionalCapabilitiesScreen;
  }
): Promise<OnboardingOptionalCapabilityNavigationResult> {
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
  context = contextInput.initialFlow?.context ?? context;
  const selected = new Set<OnboardingSupportedOptionalCapabilityId>(contextInput.initialFlow?.selected ?? []);
  const draftMap = new Map<string, SetupDraft>((contextInput.initialFlow?.drafts ?? []).map((draft) => [draft.id, draft]));
  const pendingCredentialWriteMap = new Map<string, PendingCredentialWrite>(
    (contextInput.initialFlow?.pendingCredentialWrites ?? []).map((write) => [write.envVarName, write])
  );
  const capabilitySummaries: {
    discord?: OnboardingOptionalCapabilitySummaryStatus;
    whatsapp?: OnboardingOptionalCapabilitySummaryStatus;
    browser?: OnboardingOptionalCapabilitySummaryStatus;
    webSearch?: OnboardingOptionalCapabilitySummaryStatus;
  } = {
    discord: contextInput.initialFlow?.channelSummaries?.discord,
    whatsapp: contextInput.initialFlow?.channelSummaries?.whatsapp,
    browser: contextInput.initialFlow?.summaries.browser,
    webSearch: contextInput.initialFlow?.channelSummaries?.webSearch,
  };
  let screen = contextInput.initialScreen ?? "start";

  while (true) {
    if (screen === "start") {
      const configureNow = await promptOptionalCapabilitiesStart(options.prompt, locale, (options.defaultSelections?.optionalCapabilities?.length ?? 0) > 0);
      if (configureNow.kind === "back") {
        return { kind: "back" };
      }
      if (!configureNow.value) {
        return {
          kind: "completed",
          flow: onboardingOptionalCapabilityResult(context, selected, draftMap, pendingCredentialWriteMap, capabilitySummaries),
          summaryBackTarget: "optional-start",
        };
      }
      screen = "capability-menu";
    }

    const action = await promptOnboardingOptionalCapabilityAction(options.prompt, locale, context);
    if (action.kind === "back") {
      screen = "start";
      continue;
    }
    if (action.value === "skip") {
      return {
        kind: "completed",
        flow: onboardingOptionalCapabilityResult(context, selected, draftMap, pendingCredentialWriteMap, capabilitySummaries),
        summaryBackTarget: "optional-menu",
      };
    }

    const collected = await collectOnboardingOptionalCapability(options, locale, context, action.value);
    if (collected.kind === "back") {
      screen = "capability-menu";
      continue;
    }
    if (collected.kind === "configured") {
      context = collected.context;
      selected.add(action.value);
      for (const draft of collected.drafts) {
        draftMap.set(draft.id, draft);
      }
      for (const pendingCredentialWrite of collected.pendingCredentialWrites) {
        pendingCredentialWriteMap.set(pendingCredentialWrite.envVarName, pendingCredentialWrite);
      }
    }
    if (collected.channelSummaries?.discord !== undefined) {
      capabilitySummaries.discord = collected.channelSummaries.discord;
    }
    if (collected.channelSummaries?.whatsapp !== undefined) {
      capabilitySummaries.whatsapp = collected.channelSummaries.whatsapp;
    }
    if (collected.channelSummaries?.browser !== undefined) {
      capabilitySummaries.browser = collected.channelSummaries.browser;
    }
    if (collected.channelSummaries?.webSearch !== undefined) {
      capabilitySummaries.webSearch = collected.channelSummaries.webSearch;
    }

    const configureMore = await promptConfigureAnotherOptionalCapability(options.prompt, locale);
    if (configureMore.kind === "back" || configureMore.value) {
      screen = "capability-menu";
      continue;
    }
    return {
      kind: "completed",
      flow: onboardingOptionalCapabilityResult(context, selected, draftMap, pendingCredentialWriteMap, capabilitySummaries),
      summaryBackTarget: "optional-menu",
    };
  }
}

async function promptOptionalCapabilitiesStart(
  prompt: Prompt,
  locale: SetupCopyLocale,
  defaultValue: boolean
): Promise<SetupChoiceResult<boolean>> {
  return promptSetupChoiceResult(prompt, {
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
    defaultValue,
    allowBack: true,
  });
}

async function promptOnboardingOptionalCapabilityAction(
  prompt: Prompt,
  locale: SetupCopyLocale,
  context: SetupModuleContext
): Promise<SetupChoiceResult<OnboardingSupportedOptionalCapabilityId | "skip">> {
  const actions = onboardingOptionalCapabilityActions(context);
  return promptSetupChoiceResult(prompt, {
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
    allowBack: true,
  });
}

async function promptConfigureAnotherOptionalCapability(
  prompt: Prompt,
  locale: SetupCopyLocale
): Promise<SetupChoiceResult<boolean>> {
  return promptSetupChoiceResult(prompt, {
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
    allowBack: true,
  });
}

function onboardingOptionalCapabilityActions(
  _context: SetupModuleContext
): readonly OnboardingSupportedOptionalCapabilityId[] {
  return ["channels", "voice", "browser", "web-search"];
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
    case "web-search":
      return {
        id: "web-search",
        label: setupCopyText(locale, "onboarding.optionalCapabilities.webSearch"),
        description: setupCopyText(locale, "onboarding.optionalCapabilities.webSearch.description"),
        value: "web-search",
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
        readonly discord?: OnboardingOptionalCapabilitySummaryStatus;
        readonly whatsapp?: OnboardingOptionalCapabilitySummaryStatus;
        readonly browser?: OnboardingOptionalCapabilitySummaryStatus;
        readonly webSearch?: OnboardingOptionalCapabilitySummaryStatus;
      };
    }
  | {
      readonly kind: "skip" | "unchanged" | "incomplete";
      readonly channelSummaries?: {
        readonly discord?: OnboardingOptionalCapabilitySummaryStatus;
        readonly whatsapp?: OnboardingOptionalCapabilitySummaryStatus;
        readonly browser?: OnboardingOptionalCapabilitySummaryStatus;
        readonly webSearch?: OnboardingOptionalCapabilitySummaryStatus;
      };
    }
  | {
      readonly kind: "back";
    }
> {
  if (action === "channels") {
    const channelResult = await promptChannelCapability(options.prompt, locale, { allowBack: true });
    if (channelResult.kind === "back") {
      return channelResult;
    }
    const channel = channelResult.value;
    if (channel === "whatsapp") {
      return collectOnboardingWhatsAppSetup(options, locale, context);
    }
    const module = channelCapabilityModule(channel);
    const collected = await collectOptionalCapabilityContext({
      homeDir: options.homeDir,
      profileId: options.profileId,
      workspaceRoot: context.workspaceRoot ?? options.workspaceRoot,
      trustStorePath: context.trustStorePath,
      configPath: context.configPath,
      prompt: options.prompt,
      locale,
    }, context, module, undefined, { allowBack: true });

    if (collected.kind === "back" || collected.kind !== "configured") {
      return collected;
    }

    const configuration = module.configure(collected.context);
    return {
      kind: "configured",
      context: collected.context,
      drafts: module.toDrafts(collected.context, configuration),
      pendingCredentialWrites: collected.pendingCredentialWrites ?? [],
      channelSummaries: channel === "discord" ? { discord: "configured" } : undefined,
    };
  }

  const module = action === "voice"
    ? voiceSetupModule
    : action === "web-search"
      ? webSearchSetupModule
      : browserSetupModule;
  if (action === "voice") {
    while (true) {
      const voiceModeResult = await promptVoiceCapability(options.prompt, locale, { allowBack: true });
      if (voiceModeResult.kind === "back") {
        return voiceModeResult;
      }
      const collected = await collectOptionalCapabilityContext({
        homeDir: options.homeDir,
        profileId: options.profileId,
        workspaceRoot: context.workspaceRoot ?? options.workspaceRoot,
        trustStorePath: context.trustStorePath,
        configPath: context.configPath,
        prompt: options.prompt,
        locale,
      }, context, module, voiceModeResult.value, { allowBack: true });
      if (collected.kind === "back") {
        continue;
      }
      return collectedOnboardingOptionalCapabilityResult(action, module, context, collected);
    }
  }

  const collected = await collectOptionalCapabilityContext({
    homeDir: options.homeDir,
    profileId: options.profileId,
    workspaceRoot: context.workspaceRoot ?? options.workspaceRoot,
    trustStorePath: context.trustStorePath,
    configPath: context.configPath,
    prompt: options.prompt,
    locale,
  }, context, module, undefined, { allowBack: true });

  if (collected.kind === "back") {
    return collected;
  }

  return collectedOnboardingOptionalCapabilityResult(action, module, context, collected);
}

function collectedOnboardingOptionalCapabilityResult(
  action: OnboardingSupportedOptionalCapabilityId,
  module: typeof voiceSetupModule | typeof webSearchSetupModule | typeof browserSetupModule,
  context: SetupModuleContext,
  collected: Exclude<Awaited<ReturnType<typeof collectOptionalCapabilityContext>>, { readonly kind: "back" }>
): Exclude<Awaited<ReturnType<typeof collectOnboardingOptionalCapability>>, { readonly kind: "back" }> {
  if (collected.kind !== "configured") {
    if (action === "web-search" && collected.kind === "skip") {
      return {
        kind: "skip",
        channelSummaries: { webSearch: "skipped" },
      };
    }
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
  const drafts = module.toDrafts(collectedContext, configuration);
  if (action === "browser" && optionalDraftsHaveBlockers(drafts)) {
    return {
      kind: "incomplete",
      channelSummaries: { browser: "incomplete" },
    };
  }
  if (action === "web-search" && optionalDraftsHaveBlockers(drafts)) {
    return {
      kind: "incomplete",
      channelSummaries: { webSearch: "incomplete" },
    };
  }
  if (action === "browser" && collectedContext.browser?.backend === "unconfigured") {
    return {
      kind: "configured",
      context: collectedContext,
      drafts,
      pendingCredentialWrites: collected.pendingCredentialWrites ?? [],
      channelSummaries: { browser: "disabled" },
    };
  }
  if (action === "web-search") {
    return {
      kind: "configured",
      context: collectedContext,
      drafts,
      pendingCredentialWrites: collected.pendingCredentialWrites ?? [],
      channelSummaries: { webSearch: "configured" },
    };
  }
  return {
    kind: "configured",
    context: collectedContext,
    drafts,
    pendingCredentialWrites: collected.pendingCredentialWrites ?? [],
  };
}

function optionalDraftsHaveBlockers(drafts: readonly SetupDraft[]): boolean {
  return drafts.some((draft) => draft.blockers.length > 0);
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
  draftMap: ReadonlyMap<string, SetupDraft>,
  pendingCredentialWriteMap: ReadonlyMap<string, PendingCredentialWrite>,
  capabilitySummaries: {
    readonly discord?: OnboardingOptionalCapabilitySummaryStatus;
    readonly whatsapp?: OnboardingOptionalCapabilitySummaryStatus;
    readonly browser?: OnboardingOptionalCapabilitySummaryStatus;
    readonly webSearch?: OnboardingOptionalCapabilitySummaryStatus;
  } = {}
): OnboardingOptionalCapabilityFlowResult {
  return {
    selected: [...selected],
    summaries: {
      selected: [...selected],
      channels: {
        telegram: channelCapabilityModule("telegram").detect(context).status === "configured" ? "configured" : "not_set",
        discord: capabilitySummaries.discord ?? (channelCapabilityModule("discord").detect(context).status === "configured" ? "configured" : "not_set"),
        whatsapp: capabilitySummaries.whatsapp ?? (whatsappSetupModule.detect(context).status === "configured" ? "configured" : "not_set"),
      },
      voice: {
        stt: context.voice?.sttProvider === undefined ? "not_set" : "configured",
        tts: context.voice?.ttsProvider === undefined ? "not_set" : "configured",
      },
      browser: capabilitySummaries.browser ?? (browserSetupModule.detect(context).status === "configured" ? "configured" : "not_set"),
      webSearch: capabilitySummaries.webSearch ?? (webSearchSetupModule.detect(context).status === "configured" ? "configured" : "not_set"),
    },
    drafts: [...draftMap.values()],
    pendingCredentialWrites: [...pendingCredentialWriteMap.values()],
    channelSummaries: {
      discord: capabilitySummaries.discord,
      whatsapp: capabilitySummaries.whatsapp,
      webSearch: capabilitySummaries.webSearch,
    },
    context,
  };
}

function write(options: FirstRunSetupRunnerOptions, value: string): void {
  options.output?.write(value);
}

function requireDraftValue<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`Onboarding draft missing ${label}.`);
  }
  return value;
}
