import { resolveStateHome } from "../../config/state-home.js";
import { writeEnvSecret } from "../../config/env-secret-store.js";
import {
  loadRuntimeConfig,
  type ImageGenerationProvider,
  type SttProvider,
  type TtsProvider,
} from "../../config/runtime-config.js";
import type { BrowserBackendKind } from "../../contracts/browser.js";
import type { SecurityApprovalMode } from "../../contracts/security.js";
import type { Prompt } from "../../cli/readline-prompt.js";
import { promptForApiKeyInput } from "../../cli/secret-prompt.js";
import {
  createProviderModelSelectionFlow,
  type FlowEngine,
  type ProviderModelSelectionResult,
} from "../../providers/provider-model-selection-flow.js";
import type { SkillAutonomy } from "../../skills/skill-learning.js";
import type {
  SetupApplyEndState,
  SetupApplyExecutor,
  SetupApplyFlowOptions,
  SetupApplyPlanningResult,
} from "../setup-apply-plan.js";
import {
  executeSetupApplyPlan,
  planSetupApply,
} from "../setup-apply-plan.js";
import { buildSetupEditorActionDraftBundle } from "../setup-drafts.js";
import type { SetupDraft, SetupDraftBundle } from "../setup-drafts.js";
import type { SetupEditorActionDraft, SetupEditorActionId } from "../setup-editor-actions.js";
import {
  browserSetupModule,
  telegramSetupModule,
  visionSetupModule,
  voiceSetupModule,
  type SetupModuleContext,
} from "../setup-modules.js";
import type { SetupReviewManifest } from "../setup-review-manifest.js";
import { buildSetupReviewManifest } from "../setup-review-manifest.js";
import {
  collectSetupRoute,
  type CollectSetupRouteOptions,
  type SetupRouteActionId,
  type SetupRouteDecision,
} from "../setup-router.js";
import {
  renderSetupApplyEndState,
  renderSetupApplyPlanningResult,
  renderSetupReviewManifest,
} from "../setup-prompts.js";
import {
  promptConfigEditorAction,
  promptConfigEditorReviewApproval,
  promptBrowserCapability,
  promptModelCandidate,
  promptOptionalCapabilityAction,
  promptProviderCandidate,
  promptSecurityMode,
  promptTelegramCapability,
  promptVisionCapability,
  promptVoiceCapability,
  promptWorkflowLearning,
  promptWorkspaceTrustConfirmation,
  type OptionalCapabilityPromptId,
} from "./prompts.js";
import {
  configEditorActions,
  isConfigEditorActionId,
  renderConfigEditor,
  renderConfigEditorDiagnostics,
  type ConfigEditorRenderedAction,
} from "./render.js";

export type ConfigEditorRunnerOptions = CollectSetupRouteOptions & {
  readonly prompt: Prompt;
  readonly applyExecutor?: SetupApplyExecutor;
  readonly output?: { readonly write: (value: string) => void };
  readonly defaultActionId?: SetupEditorActionId | SetupRouteActionId;
  readonly applyFlowOptions?: SetupApplyFlowOptions;
  readonly flowEngine?: FlowEngine;
};

export type ConfigEditorRunnerResult = {
  readonly completed: boolean;
  readonly exitCode: number;
  readonly output: string;
  readonly initialDecision: SetupRouteDecision;
  readonly finalDecision?: SetupRouteDecision;
  readonly selectedActionId?: string;
  readonly reviewManifest?: SetupReviewManifest;
  readonly applyPlanningResult?: SetupApplyPlanningResult;
  readonly applyEndState?: SetupApplyEndState;
};

type PendingCredentialWrite = {
  readonly envVarName: string;
  readonly value: string;
};

type OptionalCapabilityModule = typeof telegramSetupModule | typeof voiceSetupModule | typeof visionSetupModule | typeof browserSetupModule;

type OptionalCapabilityPromptContext = {
  readonly module: OptionalCapabilityModule;
  readonly title: string;
  readonly configured: boolean;
};

const OPTIONAL_CAPABILITY_MODULES: readonly OptionalCapabilityModule[] = [
  telegramSetupModule,
  voiceSetupModule,
  visionSetupModule,
  browserSetupModule,
];

type LoadedConfig = Awaited<ReturnType<typeof loadRuntimeConfig>>["config"];

export async function runConfigEditor(
  options: ConfigEditorRunnerOptions
): Promise<ConfigEditorRunnerResult> {
  const initialDecision = await collectSetupRoute(options);
  const session = initialDecision.setupEditorPlanSession;

  if (session === undefined) {
    const output = "Guided setup editor is available only for configured, degraded, or repair setup states.";
    write(options, `${output}\n`);
    return {
      completed: false,
      exitCode: 1,
      output,
      initialDecision,
    };
  }

  const actions = configEditorActions(initialDecision, session);
  const rendered = renderConfigEditor({ decision: initialDecision, session, actions });
  write(options, `${rendered}\n`);

  const selectedAction = await selectAction(options, actions);
  if (selectedAction === undefined) {
    const output = "No setup editor actions are available.";
    write(options, `${output}\n`);
    return {
      completed: false,
      exitCode: 1,
      output,
      initialDecision,
    };
  }

  if (!isConfigEditorActionId(selectedAction.id, actions)) {
    const output = `Action ${selectedAction.id} is not available in the guided setup editor.`;
    write(options, `${output}\n`);
    return {
      completed: false,
      exitCode: 1,
      output,
      initialDecision,
      selectedActionId: selectedAction.id,
    };
  }

  const allowedAction = actions.find((action) => action.id === selectedAction.id);
  if (allowedAction === undefined) {
    throw new Error(`Allowed setup editor action ${selectedAction.id} was not found.`);
  }

  return handleAction(options, initialDecision, session, allowedAction);
}

async function selectAction(
  options: ConfigEditorRunnerOptions,
  actions: readonly ConfigEditorRenderedAction[]
): Promise<ConfigEditorRenderedAction | { readonly id: string } | undefined> {
  if (options.defaultActionId !== undefined) {
    const normalizedActionId = normalizeConfigEditorActionId(options.defaultActionId);
    return actions.find((action) => action.id === normalizedActionId) ?? { id: normalizedActionId };
  }

  return promptConfigEditorAction(options.prompt, actions);
}

async function handleAction(
  options: ConfigEditorRunnerOptions,
  initialDecision: SetupRouteDecision,
  session: NonNullable<SetupRouteDecision["setupEditorPlanSession"]>,
  action: ConfigEditorRenderedAction
): Promise<ConfigEditorRunnerResult> {
  switch (action.id) {
    case "verify-setup": {
      const finalDecision = await collectSetupRoute({ ...options, selection: "verify" });
      const output = "Read-only setup verification route prepared.";
      write(options, `${output}\n`);
      return {
        completed: true,
        exitCode: 0,
        output,
        initialDecision,
        finalDecision,
        selectedActionId: action.id,
      };
    }
    case "show-diagnostics": {
      const output = renderConfigEditorDiagnostics(initialDecision);
      write(options, `${output}\n`);
      return {
        completed: true,
        exitCode: 0,
        output,
        initialDecision,
        selectedActionId: action.id,
      };
    }
    case "exit": {
      const output = "Exited setup editor without applying changes.";
      write(options, `${output}\n`);
      return {
        completed: true,
        exitCode: 0,
        output,
        initialDecision,
        selectedActionId: action.id,
      };
    }
    case "repair-workspace-trust":
      return handleWorkspaceTrustAction(options, initialDecision, session, action);
    case "edit-security-mode":
      return handleSecurityModeAction(options, initialDecision, session, action);
    case "edit-workflow-learning":
      return handleWorkflowLearningAction(options, initialDecision, session, action);
    case "edit-primary-model-route":
    case "repair-primary-provider":
      return handleProviderRouteAction(options, initialDecision, session, action);
    case "edit-primary-credential-reference":
    case "repair-missing-credential":
      return handleCredentialAction(options, initialDecision, session, action);
    case "review-optional-capabilities":
      return handleOptionalCapabilitiesAction(options, initialDecision, session, action);
    default: {
      const output = `Action ${action.id} is not implemented in the guided setup editor.`;
      write(options, `${output}\n`);
      return {
        completed: false,
        exitCode: 1,
        output,
        initialDecision,
        selectedActionId: action.id,
      };
    }
  }
}

async function handleWorkspaceTrustAction(
  options: ConfigEditorRunnerOptions,
  initialDecision: SetupRouteDecision,
  session: NonNullable<SetupRouteDecision["setupEditorPlanSession"]>,
  action: ConfigEditorRenderedAction
): Promise<ConfigEditorRunnerResult> {
  const editorAction = requireEditorAction(action);
  const trustStorePath = options.trustStorePath ?? resolveStateHome({ homeDir: options.homeDir }).trustJsonPath;
  write(options, `Workspace: ${options.workspaceRoot}\nTrust store: ${trustStorePath}\n`);
  const confirmed = await promptWorkspaceTrustConfirmation(options.prompt, {
    workspaceRoot: options.workspaceRoot,
    trustStorePath,
  });
  if (!confirmed) {
    const output = "Workspace trust was not changed.";
    write(options, `${output}\n`);
    return {
      completed: true,
      exitCode: 0,
      output,
      initialDecision,
      selectedActionId: action.id,
    };
  }

  return reviewAndApplyAction(options, initialDecision, session, editorAction, {
    trustStorePath,
  });
}

async function handleSecurityModeAction(
  options: ConfigEditorRunnerOptions,
  initialDecision: SetupRouteDecision,
  session: NonNullable<SetupRouteDecision["setupEditorPlanSession"]>,
  action: ConfigEditorRenderedAction
): Promise<ConfigEditorRunnerResult> {
  const editorAction = requireEditorAction(action);
  const securityMode = await promptSecurityMode(
    options.prompt,
    securityModeValue(initialDecision.state.setupVerification.securityModeValue)
  );

  return reviewAndApplyAction(options, initialDecision, session, {
    ...editorAction,
    reviewValues: {
      ...editorAction.reviewValues,
      securityMode,
    },
  });
}

async function handleWorkflowLearningAction(
  options: ConfigEditorRunnerOptions,
  initialDecision: SetupRouteDecision,
  session: NonNullable<SetupRouteDecision["setupEditorPlanSession"]>,
  action: ConfigEditorRenderedAction
): Promise<ConfigEditorRunnerResult> {
  const editorAction = requireEditorAction(action);
  const workflowLearning = await promptWorkflowLearning(
    options.prompt,
    skillAutonomyValue(initialDecision.state.setupVerification.skillAutonomyValue)
  );

  return reviewAndApplyAction(options, initialDecision, session, {
    ...editorAction,
    reviewValues: {
      ...editorAction.reviewValues,
      workflowLearning,
    },
  });
}

async function handleOptionalCapabilitiesAction(
  options: ConfigEditorRunnerOptions,
  initialDecision: SetupRouteDecision,
  session: NonNullable<SetupRouteDecision["setupEditorPlanSession"]>,
  action: ConfigEditorRenderedAction
): Promise<ConfigEditorRunnerResult> {
  requireEditorAction(action);
  const stateHome = resolveStateHome({ homeDir: options.homeDir });
  const loaded = await loadRuntimeConfig(options);
  const baseContext = setupModuleContextFromConfig(options, initialDecision, stateHome, loaded.config);
  const selectedDrafts: SetupDraft[] = [];

  for (const promptContext of optionalCapabilityPromptContexts(baseContext)) {
    const selected = await promptOptionalCapabilityAction(options.prompt, {
      id: optionalPromptId(promptContext.module.id),
      title: promptContext.title,
      configured: promptContext.configured,
    });
    if (selected === "unchanged") continue;

    if (selected === "skip") {
      const configuration = promptContext.module.configure(baseContext, { skip: true });
      selectedDrafts.push(...promptContext.module.toDrafts(baseContext, configuration));
      continue;
    }

    const enabledContext = await collectOptionalCapabilityContext(options, baseContext, promptContext.module);
    const configuration = promptContext.module.configure(enabledContext);
    selectedDrafts.push(...promptContext.module.toDrafts(enabledContext, configuration));
  }

  if (selectedDrafts.length === 0) {
    const output = "Optional capabilities left unchanged. No setup changes were drafted.";
    write(options, `${output}\n`);
    return {
      completed: true,
      exitCode: 0,
      output,
      initialDecision,
      selectedActionId: action.id,
    };
  }

  const bundle: SetupDraftBundle = {
    kind: "setup-draft-bundle",
    sourceKind: "setup-module-session",
    sourceId: "setup-editor.optional-capabilities",
    drafts: selectedDrafts,
    blockers: [...new Set(selectedDrafts.flatMap((draft) => draft.blockers))].sort(),
    warnings: [...new Set(selectedDrafts.flatMap((draft) => draft.warnings))].sort(),
    safeToApplyLater: selectedDrafts.every((draft) => draft.blockers.length === 0),
    metadata: {
      draftCount: selectedDrafts.length,
      requiresReviewCount: selectedDrafts.filter((draft) => draft.requiresReview).length,
      readOnlyCount: selectedDrafts.filter((draft) => draft.readOnly).length,
    },
  };
  const verificationBundle = verificationDraftBundle(options, initialDecision, session, stateHome);
  return reviewAndApplyBundles(options, initialDecision, action.id, [
    bundle,
    ...(verificationBundle === undefined ? [] : [verificationBundle]),
  ]);
}

async function handleProviderRouteAction(
  options: ConfigEditorRunnerOptions,
  initialDecision: SetupRouteDecision,
  session: NonNullable<SetupRouteDecision["setupEditorPlanSession"]>,
  action: ConfigEditorRenderedAction
): Promise<ConfigEditorRunnerResult> {
  const editorAction = requireEditorAction(action);
  const resolved = await selectResolvedProviderRoute(options, initialDecision);
  if (resolved.kind === "diagnostic") {
    return diagnosticResult(options, initialDecision, action.id, resolved.output);
  }

  return reviewAndApplyResolvedRoute(options, initialDecision, session, editorAction, resolved.selection);
}

async function handleCredentialAction(
  options: ConfigEditorRunnerOptions,
  initialDecision: SetupRouteDecision,
  session: NonNullable<SetupRouteDecision["setupEditorPlanSession"]>,
  action: ConfigEditorRenderedAction
): Promise<ConfigEditorRunnerResult> {
  const editorAction = requireEditorAction(action);
  const resolved = await resolveActiveProviderRoute(options, initialDecision);
  if (resolved.kind === "diagnostic") {
    return diagnosticResult(options, initialDecision, action.id, resolved.output);
  }

  return reviewAndApplyResolvedRoute(options, initialDecision, session, editorAction, resolved.selection, {
    credentialOnly: true,
  });
}

async function reviewAndApplyAction(
  options: ConfigEditorRunnerOptions,
  initialDecision: SetupRouteDecision,
  session: NonNullable<SetupRouteDecision["setupEditorPlanSession"]>,
  editorAction: SetupEditorActionDraft,
  overrides: {
    readonly trustStorePath?: string;
  } = {}
): Promise<ConfigEditorRunnerResult> {
  const verificationAction = session.plan.actions.find((candidate) => candidate.id === "run-readonly-verification");
  const draftActions = verificationAction === undefined
    ? [editorAction]
    : [editorAction, verificationAction];
  const stateHome = resolveStateHome({ homeDir: options.homeDir });
  const draftBundle = buildSetupEditorActionDraftBundle(session, draftActions, {
    configPath: options.userConfigPath ?? initialDecision.state.configSources[0] ?? stateHome.configPath,
    workspaceRoot: options.workspaceRoot,
    trustStorePath: overrides.trustStorePath ?? options.trustStorePath ?? stateHome.trustJsonPath,
  });
  const reviewManifest = buildSetupReviewManifest([draftBundle]);
  return reviewAndApplyManifest(options, initialDecision, editorAction.id, reviewManifest);
}

function verificationDraftBundle(
  options: ConfigEditorRunnerOptions,
  initialDecision: SetupRouteDecision,
  session: NonNullable<SetupRouteDecision["setupEditorPlanSession"]>,
  stateHome: ReturnType<typeof resolveStateHome>
): SetupDraftBundle | undefined {
  const verificationAction = session.plan.actions.find((candidate) => candidate.id === "run-readonly-verification");
  if (verificationAction === undefined) return undefined;
  return buildSetupEditorActionDraftBundle(session, [verificationAction], {
    configPath: options.userConfigPath ?? initialDecision.state.configSources[0] ?? stateHome.configPath,
    workspaceRoot: options.workspaceRoot,
    trustStorePath: options.trustStorePath ?? stateHome.trustJsonPath,
  });
}

async function reviewAndApplyBundles(
  options: ConfigEditorRunnerOptions,
  initialDecision: SetupRouteDecision,
  selectedActionId: string,
  bundles: readonly SetupDraftBundle[]
): Promise<ConfigEditorRunnerResult> {
  const reviewManifest = buildSetupReviewManifest(bundles);
  return reviewAndApplyManifest(options, initialDecision, selectedActionId, reviewManifest);
}

async function reviewAndApplyManifest(
  options: ConfigEditorRunnerOptions,
  initialDecision: SetupRouteDecision,
  selectedActionId: string,
  reviewManifest: SetupReviewManifest
): Promise<ConfigEditorRunnerResult> {
  const reviewText = renderSetupReviewManifest(reviewManifest, "en");
  write(options, `${reviewText}\n`);
  const reviewAccepted = await promptConfigEditorReviewApproval(options.prompt);
  const applyPlanningResult = planSetupApply(reviewAccepted
    ? { kind: "approved-review-result", manifest: reviewManifest }
    : { kind: "cancelled-review-result", manifest: reviewManifest, reason: "User cancelled review." });
  const applyEndState = applyPlanningResult.kind === "apply-plan-ready" && options.applyExecutor !== undefined
    ? await executeSetupApplyPlan(applyPlanningResult.applyPlan, options.applyExecutor, options.applyFlowOptions)
    : undefined;
  const output = applyEndState === undefined
    ? renderSetupApplyPlanningResult(applyPlanningResult, "en")
    : renderSetupApplyEndState(applyEndState, "en");
  write(options, `${output}\n`);
  const completed = applyEndState === undefined
    ? applyPlanningResult.kind === "apply-plan-ready"
    : applyEndState.kind !== "blocked" && applyEndState.kind !== "cancelled";

  return {
    completed,
    exitCode: completed ? 0 : 1,
    output,
    initialDecision,
    selectedActionId,
    reviewManifest,
    applyPlanningResult,
    applyEndState,
  };
}

function setupModuleContextFromConfig(
  options: ConfigEditorRunnerOptions,
  initialDecision: SetupRouteDecision,
  stateHome: ReturnType<typeof resolveStateHome>,
  config: LoadedConfig
): SetupModuleContext {
  const telegram = recordValue(recordValue(config.channels)?.telegram);
  const browser = recordValue(config.browser);
  const voice = voiceContext(config);
  const vision = visionContext(config);

  return {
    configPath: options.userConfigPath ?? initialDecision.state.configSources[0] ?? stateHome.configPath,
    workspaceRoot: options.workspaceRoot,
    trustStorePath: options.trustStorePath ?? stateHome.trustJsonPath,
    provider: {
      id: initialDecision.state.model?.provider,
      model: initialDecision.state.model?.id,
    },
    workspaceTrust: {
      trusted: initialDecision.state.workspaceTrust === "trusted",
    },
    securityMode: securityModeValue(initialDecision.state.setupVerification.securityModeValue),
    workflowLearning: skillAutonomyValue(initialDecision.state.setupVerification.skillAutonomyValue),
    telegram: telegram === undefined
      ? undefined
      : {
          enabled: booleanValue(telegram.enabled),
          botTokenEnv: stringValue(telegram.botTokenEnv),
          allowedUserIds: stringArrayValue(telegram.allowedUserIds),
          allowedChatIds: stringArrayValue(telegram.allowedChatIds),
        },
    browser: browser === undefined
      ? undefined
      : {
          backend: browserBackendValue(browser.backend),
          cdpUrl: stringValue(browser.cdpUrl),
          launchCommand: stringValue(browser.launchCommand),
          autoLaunch: booleanValue(browser.autoLaunch),
        },
    voice,
    vision,
  };
}

function optionalCapabilityPromptContexts(context: SetupModuleContext): OptionalCapabilityPromptContext[] {
  return OPTIONAL_CAPABILITY_MODULES.map((module) => {
    const detection = module.detect(context);
    return {
      module,
      title: optionalCapabilityTitle(module.id),
      configured: detection.status === "configured",
    };
  });
}

async function collectOptionalCapabilityContext(
  options: ConfigEditorRunnerOptions,
  baseContext: SetupModuleContext,
  module: OptionalCapabilityModule
): Promise<SetupModuleContext> {
  switch (module.id) {
    case "telegram": {
      const values = await promptTelegramCapability(options.prompt, {
        botTokenEnv: baseContext.telegram?.botTokenEnv,
        allowedUserIds: baseContext.telegram?.allowedUserIds,
        allowedChatIds: baseContext.telegram?.allowedChatIds,
      });
      return {
        ...baseContext,
        telegram: {
          enabled: true,
          ...values,
        },
      };
    }
    case "voice": {
      const values = await promptVoiceCapability(options.prompt, baseContext.voice ?? {});
      return {
        ...baseContext,
        voice: values,
      };
    }
    case "vision": {
      const values = await promptVisionCapability(options.prompt, baseContext.vision ?? {});
      return {
        ...baseContext,
        vision: values,
      };
    }
    case "browser": {
      const values = await promptBrowserCapability(options.prompt, baseContext.browser ?? {});
      return {
        ...baseContext,
        browser: values,
      };
    }
    default:
      throw new Error(`Unsupported optional capability module: ${module.id}`);
  }
}

function optionalPromptId(moduleId: string): OptionalCapabilityPromptId {
  if (moduleId === "telegram" || moduleId === "voice" || moduleId === "vision" || moduleId === "browser") {
    return moduleId;
  }
  throw new Error(`Unsupported optional capability module: ${moduleId}`);
}

function optionalCapabilityTitle(moduleId: string): string {
  switch (moduleId) {
    case "telegram":
      return "Telegram/channels";
    case "voice":
      return "Voice";
    case "vision":
      return "Vision and image generation";
    case "browser":
      return "Browser";
    default:
      return moduleId;
  }
}

function voiceContext(config: LoadedConfig): SetupModuleContext["voice"] {
  const tts = recordValue(config.tts);
  const stt = recordValue(config.stt);
  const ttsProvider = ttsProviderValue(tts?.provider);
  const sttProvider = sttProviderValue(stt?.provider);
  const ttsProviderConfig = ttsProvider === undefined ? undefined : recordValue(tts?.[ttsProvider]);
  const sttProviderConfig = sttProvider === undefined ? undefined : recordValue(stt?.[sttProvider]);
  if (ttsProvider === undefined && sttProvider === undefined && ttsProviderConfig === undefined && sttProviderConfig === undefined) {
    return undefined;
  }

  return {
    ttsProvider,
    ttsModel: stringValue(ttsProviderConfig?.model),
    ttsApiKeyEnv: stringValue(ttsProviderConfig?.apiKeyEnv ?? ttsProviderConfig?.api_key_env),
    sttProvider,
    sttModel: stringValue(sttProviderConfig?.model),
    sttApiKeyEnv: stringValue(sttProviderConfig?.apiKeyEnv ?? sttProviderConfig?.api_key_env),
  };
}

function visionContext(config: LoadedConfig): SetupModuleContext["vision"] {
  const imageGen = recordValue(config.imageGen ?? config.image_gen);
  if (imageGen === undefined) return undefined;
  const provider = imageProviderValue(imageGen.provider);
  const providerConfig = provider === undefined ? undefined : recordValue(imageGen[provider]);

  return {
    provider,
    model: stringValue(imageGen.model ?? providerConfig?.model),
    apiKeyEnv: stringValue(imageGen.apiKeyEnv ?? imageGen.api_key_env ?? providerConfig?.apiKeyEnv ?? providerConfig?.api_key_env),
    useGateway: booleanValue(imageGen.useGateway ?? imageGen.use_gateway),
  };
}

async function reviewAndApplyResolvedRoute(
  options: ConfigEditorRunnerOptions,
  initialDecision: SetupRouteDecision,
  session: NonNullable<SetupRouteDecision["setupEditorPlanSession"]>,
  editorAction: SetupEditorActionDraft,
  resolution: ProviderModelSelectionResult,
  behavior: {
    readonly credentialOnly?: boolean;
  } = {}
): Promise<ConfigEditorRunnerResult> {
  const credentialResult = await resolveCredentialForReview(options, resolution);
  if (credentialResult.kind === "diagnostic") {
    return diagnosticResult(options, initialDecision, editorAction.id, credentialResult.output);
  }

  const reviewValues = {
    ...editorAction.reviewValues,
    provider: resolution.provider,
    model: resolution.model,
    baseUrl: resolution.baseUrl,
    apiKeyEnv: credentialResult.envVarName,
    contextWindowTokens: resolution.profile.contextWindowTokens,
    apiMode: resolution.apiMode,
    authMethod: resolution.authMethod,
  };
  const selectedAction: SetupEditorActionDraft = {
    ...editorAction,
    reviewValues,
  };
  const verificationAction = session.plan.actions.find((candidate) => candidate.id === "run-readonly-verification");
  const draftActions = [
    selectedAction,
    ...(behavior.credentialOnly === true ? [] : credentialResult.credentialAction === undefined ? [] : [credentialResult.credentialAction]),
    ...(verificationAction === undefined ? [] : [verificationAction]),
  ];
  const stateHome = resolveStateHome({ homeDir: options.homeDir });
  const draftBundle = buildSetupEditorActionDraftBundle(session, draftActions, {
    configPath: options.userConfigPath ?? initialDecision.state.configSources[0] ?? stateHome.configPath,
    workspaceRoot: options.workspaceRoot,
    trustStorePath: options.trustStorePath ?? stateHome.trustJsonPath,
  });
  const reviewManifest = buildSetupReviewManifest([draftBundle]);
  const reviewText = renderSetupReviewManifest(reviewManifest, "en");
  write(options, `${reviewText}\n`);
  const reviewAccepted = await promptConfigEditorReviewApproval(options.prompt);
  const applyPlanningResult = planSetupApply(reviewAccepted
    ? { kind: "approved-review-result", manifest: reviewManifest }
    : { kind: "cancelled-review-result", manifest: reviewManifest, reason: "User cancelled review." });

  if (
    credentialResult.pendingCredentialWrite !== undefined &&
    applyPlanningResult.kind === "apply-plan-ready" &&
    options.applyExecutor !== undefined
  ) {
    await writeEnvSecret({
      homeDir: options.homeDir,
      key: credentialResult.pendingCredentialWrite.envVarName,
      value: credentialResult.pendingCredentialWrite.value,
    });
  }

  const applyEndState = applyPlanningResult.kind === "apply-plan-ready" && options.applyExecutor !== undefined
    ? await executeSetupApplyPlan(applyPlanningResult.applyPlan, options.applyExecutor, options.applyFlowOptions)
    : undefined;
  const output = applyEndState === undefined
    ? renderSetupApplyPlanningResult(applyPlanningResult, "en")
    : renderSetupApplyEndState(applyEndState, "en");
  write(options, `${output}\n`);
  const completed = applyEndState === undefined
    ? applyPlanningResult.kind === "apply-plan-ready"
    : applyEndState.kind !== "blocked" && applyEndState.kind !== "cancelled";

  return {
    completed,
    exitCode: completed ? 0 : 1,
    output,
    initialDecision,
    selectedActionId: editorAction.id,
    reviewManifest,
    applyPlanningResult,
    applyEndState,
  };
}

async function selectResolvedProviderRoute(
  options: ConfigEditorRunnerOptions,
  initialDecision: SetupRouteDecision
): Promise<
  | { readonly kind: "selected"; readonly selection: ProviderModelSelectionResult }
  | { readonly kind: "diagnostic"; readonly output: string }
> {
  const flowEngine = options.flowEngine ?? await createDefaultFlowEngine(options);
  const providers = await flowEngine.listProviderCandidates();
  if (providers.length === 0) {
    return { kind: "diagnostic", output: "No setup-visible provider candidates are available." };
  }

  const provider = await promptProviderCandidate(options.prompt, {
    candidates: providers,
    currentProviderId: initialDecision.state.model?.provider,
  });
  const models = await flowEngine.listModelCandidates(provider.id);
  if (models.length === 0) {
    return { kind: "diagnostic", output: `No setup-visible models are available for ${provider.displayName}.` };
  }

  const model = await promptModelCandidate(options.prompt, {
    providerId: provider.id,
    candidates: models,
    currentModelId: initialDecision.state.model?.provider === provider.id ? initialDecision.state.model.id : undefined,
  });
  const resolved = await flowEngine.resolveSelection(provider.id, model.id);
  if (resolved.kind === "diagnostic") {
    return { kind: "diagnostic", output: `Provider/model selection failed: ${resolved.reason}` };
  }

  return { kind: "selected", selection: resolved };
}

async function resolveActiveProviderRoute(
  options: ConfigEditorRunnerOptions,
  initialDecision: SetupRouteDecision
): Promise<
  | { readonly kind: "selected"; readonly selection: ProviderModelSelectionResult }
  | { readonly kind: "diagnostic"; readonly output: string }
> {
  const activeRoute = initialDecision.state.model;
  if (activeRoute === undefined) {
    return {
      kind: "diagnostic",
      output: "No active provider/model route is configured. Use provider/model repair to choose a setup-visible route.",
    };
  }

  const flowEngine = options.flowEngine ?? await createDefaultFlowEngine(options);
  const providers = await flowEngine.listProviderCandidates();
  const provider = providers.find((candidate) => candidate.id === activeRoute.provider);
  if (provider === undefined) {
    return {
      kind: "diagnostic",
      output: `The active provider/model route ${activeRoute.provider}/${activeRoute.id} is not available for credential repair. Use provider/model repair to choose a setup-visible route.`,
    };
  }

  const models = await flowEngine.listModelCandidates(provider.id);
  const model = models.find((candidate) => candidate.id === activeRoute.id);
  if (model === undefined) {
    return {
      kind: "diagnostic",
      output: `The active provider/model route ${activeRoute.provider}/${activeRoute.id} is not available for credential repair. Use provider/model repair to choose a setup-visible route.`,
    };
  }

  const resolved = await flowEngine.resolveSelection(provider.id, model.id);
  if (resolved.kind === "diagnostic") {
    return {
      kind: "diagnostic",
      output: `The active provider/model route ${activeRoute.provider}/${activeRoute.id} cannot be repaired through credential-only setup: ${resolved.reason}. Use provider/model repair to choose a setup-visible route.`,
    };
  }

  return { kind: "selected", selection: resolved };
}

async function resolveCredentialForReview(
  options: ConfigEditorRunnerOptions,
  resolution: ProviderModelSelectionResult
): Promise<
  | {
      readonly kind: "ready";
      readonly envVarName?: string;
      readonly credentialAction?: SetupEditorActionDraft;
      readonly pendingCredentialWrite?: PendingCredentialWrite;
    }
  | { readonly kind: "diagnostic"; readonly output: string }
> {
  switch (resolution.credentialAction.kind) {
    case "none":
      return { kind: "ready" };
    case "reuse": {
      const ref = resolution.credentialAction.reference;
      if (!ref.startsWith("env:")) {
        return { kind: "diagnostic", output: `Malformed reuse credential reference: ${ref}` };
      }
      const envVarName = ref.slice(4);
      return {
        kind: "ready",
        envVarName,
        credentialAction: credentialReferenceAction(resolution, envVarName),
      };
    }
    case "collect": {
      const envVarName = resolution.credentialAction.envVarName;
      const promptResult = await promptForApiKeyInput({
        prompt: options.prompt,
        providerId: resolution.provider,
        envVarName,
      });
      return {
        kind: "ready",
        envVarName,
        credentialAction: credentialReferenceAction(resolution, envVarName),
        pendingCredentialWrite: promptResult.kind === "entered"
          ? { envVarName: promptResult.envVarName, value: promptResult.value }
          : undefined,
      };
    }
  }
}

function credentialReferenceAction(
  resolution: ProviderModelSelectionResult,
  envVarName: string
): SetupEditorActionDraft {
  return {
    kind: "setup-editor-action-draft",
    id: "edit-primary-credential-reference",
    copyKey: "setupEditor.actions.editPrimaryCredentialReference",
    sectionId: "credentials",
    effect: "draft-config-patch",
    readOnly: false,
    mutatesConfig: false,
    requiresExplicitApply: true,
    preservesUnrelatedConfig: true,
    patch: {
      kind: "scoped-config-patch-intent",
      fields: ["provider.credentialReference"],
      preserveUnrelatedConfig: true,
    },
    credentialRefs: [{ kind: "env", name: envVarName, value: "not-included" }],
    reviewValues: {
      provider: resolution.provider,
      model: resolution.model,
      apiKeyEnv: envVarName,
    },
  };
}

function diagnosticResult(
  options: ConfigEditorRunnerOptions,
  initialDecision: SetupRouteDecision,
  selectedActionId: string,
  output: string
): ConfigEditorRunnerResult {
  write(options, `${output}\n`);
  return {
    completed: false,
    exitCode: 1,
    output,
    initialDecision,
    selectedActionId,
  };
}

function requireEditorAction(action: ConfigEditorRenderedAction): SetupEditorActionDraft {
  if (action.editorAction === undefined) {
    throw new Error(`Setup editor action ${action.id} has no draft metadata.`);
  }
  return action.editorAction;
}

function normalizeConfigEditorActionId(id: SetupEditorActionId | SetupRouteActionId): string {
  switch (id) {
    case "run-readonly-verification":
      return "verify-setup";
    case "cancel-setup-editor":
      return "exit";
    case "trust-workspace":
      return "repair-workspace-trust";
    case "repair-broken-config":
    case "repair-state-directory":
      return "show-diagnostics";
    default:
      return id;
  }
}

function write(options: ConfigEditorRunnerOptions, value: string): void {
  options.output?.write(value);
}

async function createDefaultFlowEngine(options: CollectSetupRouteOptions): Promise<FlowEngine> {
  const loaded = await loadRuntimeConfig(options);
  return createProviderModelSelectionFlow({
    config: loaded.config,
    providerRegistry: loaded.providerRegistry,
    homeDir: options.homeDir,
    allowNetwork: false,
    mode: "setup",
  });
}

function securityModeValue(value: unknown): SecurityApprovalMode {
  return value === "strict" || value === "adaptive" || value === "open" ? value : "adaptive";
}

function skillAutonomyValue(value: unknown): SkillAutonomy {
  return value === "none" || value === "suggest" || value === "proactive" || value === "autonomous"
    ? value
    : "suggest";
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function stringArrayValue(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return values.length > 0 ? values : undefined;
}

function ttsProviderValue(value: unknown): TtsProvider | undefined {
  return value === "edge" ||
    value === "elevenlabs" ||
    value === "openai" ||
    value === "minimax" ||
    value === "mistral" ||
    value === "gemini" ||
    value === "xai" ||
    value === "neutts" ||
    value === "kittentts"
    ? value
    : undefined;
}

function sttProviderValue(value: unknown): SttProvider | undefined {
  return value === "local" || value === "groq" || value === "openai" || value === "mistral"
    ? value
    : undefined;
}

function imageProviderValue(value: unknown): ImageGenerationProvider | undefined {
  return value === "fal" || value === "byteplus" ? value : undefined;
}

function browserBackendValue(value: unknown): BrowserBackendKind | undefined {
  return value === "local-cdp" ||
    value === "browserbase" ||
    value === "firecrawl" ||
    value === "camofox" ||
    value === "mock" ||
    value === "unconfigured"
    ? value
    : undefined;
}

export const runConfigEditorSetup = runConfigEditor;
