import { resolveStateHome } from "../../config/state-home.js";
import { hasSavedEnvSecret } from "../../config/env-secret-store.js";
import { defaultProfileId, readActiveProfile, resolveProfileStateHome } from "../../config/profile-home.js";
import { loadRuntimeConfig } from "../../config/runtime-config.js";
import type { AuxiliaryModelSlotInput, ProviderId } from "../../contracts/provider.js";
import type { SecurityApprovalMode } from "../../contracts/security.js";
import type { PromptCardStatusLine } from "../../contracts/view-model.js";
import type { Prompt } from "../../cli/prompt-contract.js";
import { withPromptUiContext } from "../../cli/prompt-contract.js";
import { promptUiContextForLocale } from "../../contracts/ui.js";
import { promptForApiKeyInput } from "../../cli/secret-prompt.js";
import type { SetupPanelState } from "../../ui/papyrus/operator-console/index.js";
import {
  createProviderModelSelectionFlow,
  type FlowEngine,
  type ProviderModelSelectionResult,
} from "../../providers/provider-model-selection-flow.js";
import type { FetchLike as OpenAICompatibleFetchLike } from "../../providers/openai-compatible-provider.js";
import {
  selectProviderModelRoute,
  type ProviderModelPromptResult,
  type ProviderModelRoutePromptMode,
} from "../provider-model-route-prompt.js";
import { getProviderMetadata } from "../../providers/provider-metadata.js";
import type { SkillAutonomy } from "../../skills/skill-learning.js";
import type {
  SetupApplyEndState,
  SetupDeferredOAuthWrite,
  SetupDeferredSecretWrite,
  SetupApplyExecutor,
  SetupApplyFlowOptions,
  SetupApplyPlanningResult,
  SetupLaunchHandoffIntent,
} from "../setup-apply-plan.js";
import {
  classifySetupVerificationReport,
  executeSetupApplyPlan,
  planSetupApply,
} from "../setup-apply-plan.js";
import { promptInterfaceLanguageAndStyle } from "../interface-preferences.js";
import { buildSetupEditorActionDraftBundle } from "../setup-drafts.js";
import type { SetupDraft, SetupDraftBundle } from "../setup-drafts.js";
import type { SetupEditorActionDraft, SetupEditorActionId } from "../setup-editor-actions.js";
import type { SetupReviewManifest } from "../setup-review-manifest.js";
import { buildSetupReviewManifest } from "../setup-review-manifest.js";
import {
  collectSetupRoute,
  type CollectSetupRouteOptions,
  type SetupRouteActionId,
  type SetupRouteDecision,
} from "../setup-router.js";
import type { SetupVerificationReport } from "../verification.js";
import type { SetupCopyKey, SetupCopyLocale } from "../setup-copy.js";
import {
  collectOpenAICompatibleEndpointFlow,
  type OpenAICompatibleEndpointFlowResult,
} from "../openai-compatible-endpoint-flow.js";
import {
  formatSetupCopy,
  promptSetupChoice,
  renderSetupApplyEndState,
  renderSetupApplyPlanningResult,
  setupOutputLine,
  setupProviderCredentialQuestion,
  setupPromptContext,
  setupCopyText,
  showSetupCard,
} from "../setup-prompts.js";
import { isolateLtr } from "../../ui/bidi.js";
import {
  createOpenAICompatibleEndpointFlowUi,
  promptConfigEditorAction,
  promptConfigEditorReviewApproval,
  promptAuxiliaryModelTask,
  promptChannelCapability,
  promptCredentialReuseChoice,
  promptFallbackRouteAction,
  promptOptionalCapabilityAction,
  promptSecurityMode,
  promptVoiceCapability,
  promptWorkflowLearning,
  promptWorkspaceTrustConfirmation,
  type ConfigEditorPostApplyActionId,
} from "./prompts.js";
import {
  preserveSetupConsoleOnPromptClose,
  setupConsoleControllerForPrompt,
  withSetupConsolePrompt,
  type SetupConsolePromptAdapterOptions,
} from "./setupConsolePromptAdapter.js";
import {
  configEditorActions,
  configEditorHiddenDirectAction,
  isConfigEditorActionId,
  renderConfigEditor,
  renderConfigEditorDiagnosticsForLocale,
  type ConfigEditorRenderedAction,
} from "./render.js";
import {
  buildOptionalCapabilityDraftBundle,
  channelCapabilityModule,
  collectOptionalCapabilityContext,
  optionalCapabilityModuleForAction,
  optionalCapabilityPromptContext,
  optionalPromptId,
  setupModuleContextFromDecision,
} from "../optional-capability-flow.js";
import {
  maybeOfferGatewayStartAfterChannelSetup,
  readyConfiguredGatewayChannelIds,
  type GatewayActivationChannelId,
  type GatewayServiceActivationOptions,
  type GatewayServiceActivationResult,
} from "../gateway-service-activation.js";
import {
  runWhatsAppSetupFlow,
  type WhatsAppSetupDependencies,
} from "../whatsapp-setup-flow.js";
import {
  buildCodexOAuthTokenRecord,
  CODEX_OAUTH_AUTH_METHOD,
  formatCodexOAuthFailure,
  runCodexOAuthFlowWithDeviceCodeNotice,
} from "../../providers/oauth/codex-setup.js";
import { codexDeviceVerificationUrl, type FetchLike as CodexOAuthFetchLike } from "../../providers/oauth/codex-oauth.js";
import { runDoctor } from "../../doctor/index.js";

export type ConfigEditorRunnerOptions = CollectSetupRouteOptions & {
  readonly prompt: Prompt;
  readonly setupConsole?: SetupConsolePromptAdapterOptions;
  readonly applyExecutor?: SetupApplyExecutor;
  readonly output?: { readonly write: (value: string) => void };
  readonly defaultActionId?: SetupEditorActionId | SetupRouteActionId;
  readonly renderInitialOverview?: boolean;
  readonly applyFlowOptions?: SetupApplyFlowOptions;
  readonly flowEngine?: FlowEngine;
  readonly providerFetch?: CodexOAuthFetchLike;
  readonly gatewayServiceActivation?: {
    readonly serviceActions?: GatewayServiceActivationOptions["serviceActions"];
  };
  readonly whatsappSetupDependencies?: WhatsAppSetupDependencies;
};

export type ConfigEditorRunnerResult = {
  readonly completed: boolean;
  readonly exitCode: number;
  readonly output: string;
  readonly initialDecision: SetupRouteDecision;
  readonly finalDecision?: SetupRouteDecision;
  readonly selectedActionId?: string;
  readonly nextActionId?: ConfigEditorPostApplyActionId;
  readonly postApplyRouteDecision?: SetupRouteDecision;
  readonly limitedModeAccepted?: boolean;
  readonly reviewManifest?: SetupReviewManifest;
  readonly applyPlanningResult?: SetupApplyPlanningResult;
  readonly applyEndState?: SetupApplyEndState;
  readonly gatewayServiceActivationResult?: GatewayServiceActivationResult;
  readonly setupConsoleRenderedOutput?: boolean;
};

type LocalizedConfigEditorRunnerOptions = ConfigEditorRunnerOptions & {
  readonly locale: SetupCopyLocale;
};

type PendingCredentialWrite = SetupDeferredSecretWrite;
type PendingOAuthWrite = SetupDeferredOAuthWrite;

type RunOnceResult = ConfigEditorRunnerResult & {
  readonly repairAgainDecision?: SetupRouteDecision;
  readonly menuBackRequested?: boolean;
};

type ConfigEditorLoopState = {
  readonly repairAgainReentered: boolean;
  readonly menuBackReentryCount: number;
};

type ConfigEditorLoopDecision =
  | {
      readonly kind: "repair-again";
      readonly state: ConfigEditorLoopState;
      readonly initialDecision: SetupRouteDecision;
    }
  | {
      readonly kind: "menu-back";
      readonly state: ConfigEditorLoopState;
    }
  | {
      readonly kind: "return";
      readonly result: RunOnceResult;
    };

type LaunchableApplyEndState = {
  readonly verification: SetupVerificationReport;
  readonly launchHandoffIntent?: SetupLaunchHandoffIntent;
};

export async function runConfigEditor(
  options: ConfigEditorRunnerOptions
): Promise<ConfigEditorRunnerResult> {
  let initialDecision = await collectSetupRoute(options);
  let isFirstRun = true;
  let loopState: ConfigEditorLoopState = {
    repairAgainReentered: false,
    menuBackReentryCount: 0,
  };
  while (loopState.menuBackReentryCount < 4) {
    const result = await runConfigEditorOnce(options, initialDecision, isFirstRun ? options.defaultActionId : undefined);
    isFirstRun = false;

    const loopDecision = decideConfigEditorLoop(result, loopState);
    if (loopDecision.kind === "repair-again") {
      loopState = loopDecision.state;
      initialDecision = loopDecision.initialDecision;
      continue;
    }
    if (loopDecision.kind === "menu-back") {
      loopState = loopDecision.state;
      continue;
    }
    return loopDecision.result;
  }

  const output = "Setup editor re-entry stopped after a bounded setup loop.";
  write(options, `${output}\n`);
  return {
    completed: false,
    exitCode: 1,
    output,
    initialDecision,
    selectedActionId: "repair-again",
  };
}

function decideConfigEditorLoop(
  result: RunOnceResult,
  state: ConfigEditorLoopState
): ConfigEditorLoopDecision {
  if (result.nextActionId === "repair-again" && result.repairAgainDecision !== undefined && !state.repairAgainReentered) {
    return {
      kind: "repair-again",
      state: {
        ...state,
        repairAgainReentered: true,
      },
      initialDecision: result.repairAgainDecision,
    };
  }
  if (result.menuBackRequested === true) {
    return {
      kind: "menu-back",
      state: {
        ...state,
        menuBackReentryCount: state.menuBackReentryCount + 1,
      },
    };
  }
  return {
    kind: "return",
    result,
  };
}

export function __decideConfigEditorLoopForTest(input: {
  readonly result: ConfigEditorRunnerResult & {
    readonly repairAgainDecision?: SetupRouteDecision;
    readonly menuBackRequested?: boolean;
  };
  readonly repairAgainReentered: boolean;
  readonly menuBackReentryCount: number;
}):
  | {
      readonly kind: "repair-again";
      readonly state: {
        readonly repairAgainReentered: boolean;
        readonly menuBackReentryCount: number;
      };
      readonly initialDecision: SetupRouteDecision;
    }
  | {
      readonly kind: "menu-back";
      readonly state: {
        readonly repairAgainReentered: boolean;
        readonly menuBackReentryCount: number;
      };
    }
  | { readonly kind: "return" } {
  const decision = decideConfigEditorLoop(input.result, {
    repairAgainReentered: input.repairAgainReentered,
    menuBackReentryCount: input.menuBackReentryCount,
  });
  if (decision.kind === "return") {
    return { kind: "return" };
  }
  return decision;
}

async function runConfigEditorOnce(
  options: ConfigEditorRunnerOptions,
  initialDecision: SetupRouteDecision,
  defaultActionId: SetupEditorActionId | SetupRouteActionId | undefined
): Promise<RunOnceResult> {
  const locale = await resolveConfigEditorLocale(options);
  const localizedOptions: LocalizedConfigEditorRunnerOptions = {
    ...options,
    locale,
    prompt: setupEditorPromptForLocale(options, locale),
  };
  const session = initialDecision.setupEditorPlanSession;

  if (session === undefined) {
    const output = setupCopyText(locale, "setupEditor.result.unsupportedState");
    write(options, `${output}\n`);
    return {
      completed: false,
      exitCode: 1,
      output,
      initialDecision,
    };
  }

  const actions = configEditorActions(initialDecision, session, {
    workspacePath: options.workspaceRoot,
  }, locale);
  if (options.renderInitialOverview !== false) {
    const rendered = renderConfigEditor({ decision: initialDecision, session, actions, locale });
    write(options, `${rendered}\n`);
  }

  const selectedAction = await selectAction(localizedOptions, initialDecision, actions, defaultActionId);
  if (selectedAction === undefined) {
    const output = setupCopyText(locale, "setupEditor.result.noActions");
    write(options, `${output}\n`);
    return {
      completed: false,
      exitCode: 1,
      output,
      initialDecision,
    };
  }

  const allowedAction = actions.find((action) => action.id === selectedAction.id)
    ?? (defaultActionId === undefined
      ? undefined
      : configEditorHiddenDirectAction(session, selectedAction.id, {
        workspacePath: options.workspaceRoot,
      }, locale));
  if (allowedAction === undefined) {
    const output = formatSetupCopy(locale, "setupEditor.result.unavailableAction", {
      actionId: selectedAction.id,
    });
    write(options, `${output}\n`);
    return {
      completed: false,
      exitCode: 1,
      output,
      initialDecision,
      selectedActionId: selectedAction.id,
    };
  }

  return handleAction(localizedOptions, initialDecision, session, allowedAction);
}

function setupEditorPromptForLocale(
  options: ConfigEditorRunnerOptions,
  locale: SetupCopyLocale
): Prompt {
  const localizedPrompt = withPromptUiContext(options.prompt, promptUiContextForLocale(locale));
  return options.setupConsole === undefined
    ? localizedPrompt
    : withSetupConsolePrompt(localizedPrompt, options.setupConsole);
}

async function resolveConfigEditorLocale(options: ConfigEditorRunnerOptions): Promise<SetupCopyLocale> {
  try {
    const loaded = await loadRuntimeConfig(options);
    return loaded.config.ui?.language === "ar" ? "ar" : "en";
  } catch {
    return "en";
  }
}

async function selectAction(
  options: LocalizedConfigEditorRunnerOptions,
  _initialDecision: SetupRouteDecision,
  actions: readonly ConfigEditorRenderedAction[],
  defaultActionId: SetupEditorActionId | SetupRouteActionId | undefined
): Promise<ConfigEditorRenderedAction | { readonly id: string } | undefined> {
  if (defaultActionId !== undefined) {
    const normalizedActionId = normalizeConfigEditorActionId(defaultActionId);
    return actions.find((action) => action.id === normalizedActionId) ?? { id: normalizedActionId };
  }

  return promptConfigEditorAction(options.prompt, actions, undefined, options.locale);
}

function setupEditorStatusLines(
  options: LocalizedConfigEditorRunnerOptions,
  decision: SetupRouteDecision
): readonly PromptCardStatusLine[] {
  const locale = options.locale;
  const direction = locale === "ar" ? "rtl" : "ltr";
  const statusLines: PromptCardStatusLine[] = [
    {
      text: setupEditorModeStatus(locale, decision),
      tone: setupEditorModeStatusTone(decision),
      direction,
    },
    {
      text: setupEditorStatusPair(
        locale,
        "setupEditor.status.workspace",
        decision.state.setupVerification.workspaceTrusted
          ? setupCopyText(locale, "setupEditor.status.workspace.trusted")
          : setupCopyText(locale, "setupEditor.status.workspace.notTrusted")
      ),
      tone: decision.state.setupVerification.workspaceTrusted ? "active" : "warning",
      direction,
    },
    {
      text: setupEditorStatusPair(
        locale,
        "setupEditor.status.profile",
        setupEditorTechnicalToken(locale, options.profileId ?? defaultProfileId())
      ),
      tone: "muted",
      direction,
    },
  ];

  const model = decision.state.model;
  if (model !== undefined) {
    statusLines.push({
      text: setupEditorStatusPair(
        locale,
        "setupEditor.status.current",
        setupEditorTechnicalToken(locale, `${model.provider}/${model.id}`)
      ),
      tone: "active",
      direction,
    });
  }

  return statusLines;
}

function setupEditorModeStatus(locale: SetupCopyLocale, decision: SetupRouteDecision): string {
  if (decision.kind === "repair-first-menu") {
    return setupCopyText(locale, "setupEditor.status.repairMode");
  }
  if (decision.kind === "configured-degraded-menu") {
    return setupCopyText(locale, "setupEditor.status.degradedSetup");
  }
  if (decision.kind === "verify-readonly") {
    return setupCopyText(locale, "setupEditor.status.readOnlyDiagnostics");
  }
  return setupCopyText(locale, "setupEditor.status.noChangesApplied");
}

function setupEditorModeStatusTone(decision: SetupRouteDecision): PromptCardStatusLine["tone"] {
  return decision.kind === "repair-first-menu" || decision.kind === "configured-degraded-menu"
    ? "warning"
    : "muted";
}

function setupEditorStatusPair(
  locale: SetupCopyLocale,
  labelKey: SetupCopyKey,
  value: string
): string {
  return `${setupCopyText(locale, labelKey)}: ${value}`;
}

function setupEditorTechnicalToken(locale: SetupCopyLocale, value: string): string {
  return locale === "ar" ? isolateLtr(value) : value;
}

async function handleAction(
  options: LocalizedConfigEditorRunnerOptions,
  initialDecision: SetupRouteDecision,
  session: NonNullable<SetupRouteDecision["setupEditorPlanSession"]>,
  action: ConfigEditorRenderedAction
): Promise<RunOnceResult> {
  switch (action.id) {
    case "run-doctor": {
      const result = await runDoctor({
        argv: ["doctor"],
        workspaceRoot: options.workspaceRoot,
        homeDir: options.homeDir,
        profileId: options.profileId,
      });
      write(options, result.output);
      return {
        completed: true,
        exitCode: 0,
        output: result.output,
        initialDecision,
        selectedActionId: action.id,
      };
    }
    case "verify-setup": {
      const finalDecision = await collectSetupRoute({ ...options, selection: "verify" });
      const output = setupCopyText(options.locale, "setupEditor.result.verifyPrepared");
      const setupConsoleRenderedOutput = renderSetupConsoleReadOnlyOutput(options, {
        title: setupCopyText(options.locale, "setupVerification.title"),
        decision: finalDecision,
        output: renderConfigEditorDiagnosticsForLocale(finalDecision, options.locale),
      });
      write(options, `${output}\n`);
      return {
        completed: true,
        exitCode: 0,
        output,
        initialDecision,
        finalDecision,
        selectedActionId: action.id,
        setupConsoleRenderedOutput,
      };
    }
    case "show-diagnostics": {
      const output = renderConfigEditorDiagnosticsForLocale(initialDecision, options.locale);
      const setupConsoleRenderedOutput = renderSetupConsoleReadOnlyOutput(options, {
        title: setupCopyText(options.locale, "setupEditor.diagnostics.title"),
        decision: initialDecision,
        output,
      });
      write(options, `${output}\n`);
      return {
        completed: true,
        exitCode: 0,
        output,
        initialDecision,
        selectedActionId: action.id,
        setupConsoleRenderedOutput,
      };
    }
    case "exit": {
      const output = setupCopyText(options.locale, "setupEditor.result.exitWithoutChanges");
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
    case "edit-language":
      return handleLanguageAction(options, initialDecision, session, action);
    case "edit-primary-model-route":
    case "repair-primary-provider":
      return handleProviderRouteAction(options, initialDecision, session, action);
    case "add-custom-provider-route":
      return handleCustomProviderRouteAction(options, initialDecision, session, action);
    case "edit-fallback-model-route":
      return handleFallbackRouteAction(options, initialDecision, session, action);
    case "edit-auxiliary-model-route":
      return handleAuxiliaryRouteAction(options, initialDecision, session, action);
    case "edit-primary-credential-reference":
    case "repair-missing-credential":
      return handleCredentialAction(options, initialDecision, session, action);
    case "configure-channels":
    case "configure-voice":
    case "configure-image-generation":
    case "configure-web-search":
    case "configure-browser":
      return handleOptionalCapabilityAction(options, initialDecision, session, action);
    default: {
      const output = formatSetupCopy(options.locale, "setupEditor.result.unimplementedAction", {
        actionId: action.id,
      });
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

function renderSetupConsoleReadOnlyOutput(
  options: LocalizedConfigEditorRunnerOptions,
  input: {
    readonly title: string;
    readonly decision: SetupRouteDecision;
    readonly output: string;
  }
): boolean {
  const controller = setupConsoleControllerForPrompt(options.prompt);
  if (controller === undefined) return false;

  const panel = readOnlyOutputPanel(options, input);
  controller.render(panel);
  preserveSetupConsoleOnPromptClose(options.prompt);
  return true;
}

function readOnlyOutputPanel(
  options: LocalizedConfigEditorRunnerOptions,
  input: {
    readonly title: string;
    readonly decision: SetupRouteDecision;
    readonly output: string;
  }
): SetupPanelState {
  const outputLines = input.output
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  const contentLines = outputLines[0] === input.title ? outputLines.slice(1) : outputLines;
  const rows = contentLines.map((line, index) => readOnlyOutputRow(line, index));
  return {
    kind: "table",
    layout: "choiceMenu",
    title: input.title,
    description: setupCopyText(options.locale, "setupEditor.readOnlyPanel.description"),
    statusLines: setupEditorReadOnlyStatusLines(options, input.decision),
    locale: options.locale,
    rows: rows.length > 0 ? rows : [readOnlyOutputRow(setupCopyText(options.locale, "setupEditor.status.readOnlyDiagnostics"), 0)],
    footer: setupCopyText(options.locale, "setupEditor.readOnlyPanel.footer"),
  };
}

function setupEditorReadOnlyStatusLines(
  options: LocalizedConfigEditorRunnerOptions,
  decision: SetupRouteDecision
): readonly PromptCardStatusLine[] {
  const direction = options.locale === "ar" ? "rtl" : "ltr";
  return [
    {
      text: setupCopyText(options.locale, "setupEditor.status.readOnlyDiagnostics"),
      tone: "muted",
      direction,
    },
    ...setupEditorStatusLines(options, decision).slice(1),
  ];
}

function readOnlyOutputRow(
  line: string,
  index: number
): SetupPanelState["rows"][number] {
  const labeled = /^([^:]{1,28}):\s*(.*)$/u.exec(line);
  if (labeled !== null) {
    return {
      id: `line-${index}`,
      provider: labeled[1]!.trim(),
      model: "",
      status: labeled[2]!.trim(),
      notes: "",
    };
  }

  return {
    id: `line-${index}`,
    provider: "",
    model: "",
    status: line,
    notes: "",
  };
}

async function handleWorkspaceTrustAction(
  options: LocalizedConfigEditorRunnerOptions,
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
  }, options.locale);
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
  options: LocalizedConfigEditorRunnerOptions,
  initialDecision: SetupRouteDecision,
  session: NonNullable<SetupRouteDecision["setupEditorPlanSession"]>,
  action: ConfigEditorRenderedAction
): Promise<ConfigEditorRunnerResult> {
  const editorAction = requireEditorAction(action);
  const securityMode = await promptSecurityMode(
    options.prompt,
    securityModeValue(initialDecision.state.setupVerification.securityModeValue),
    options.locale,
    { allowBack: true }
  );
  if (securityMode.kind === "back") {
    return menuBackResult(initialDecision, action.id);
  }

  return reviewAndApplyAction(options, initialDecision, session, {
    ...editorAction,
    reviewValues: {
      ...editorAction.reviewValues,
      securityMode: securityMode.value,
    },
  });
}

async function handleWorkflowLearningAction(
  options: LocalizedConfigEditorRunnerOptions,
  initialDecision: SetupRouteDecision,
  session: NonNullable<SetupRouteDecision["setupEditorPlanSession"]>,
  action: ConfigEditorRenderedAction
): Promise<ConfigEditorRunnerResult> {
  const editorAction = requireEditorAction(action);
  const workflowLearning = await promptWorkflowLearning(
    options.prompt,
    skillAutonomyValue(initialDecision.state.setupVerification.skillAutonomyValue),
    options.locale,
    { allowBack: true }
  );
  if (workflowLearning.kind === "back") {
    return menuBackResult(initialDecision, action.id);
  }

  return reviewAndApplyAction(options, initialDecision, session, {
    ...editorAction,
    reviewValues: {
      ...editorAction.reviewValues,
      workflowLearning: workflowLearning.value,
    },
  });
}

async function handleLanguageAction(
  options: LocalizedConfigEditorRunnerOptions,
  initialDecision: SetupRouteDecision,
  session: NonNullable<SetupRouteDecision["setupEditorPlanSession"]>,
  action: ConfigEditorRenderedAction
): Promise<RunOnceResult> {
  const editorAction = requireEditorAction(action);
  const loaded = await loadRuntimeConfig(options);
  const ui = loaded.config.ui;
  const languageResult = await promptInterfaceLanguageAndStyle(options.prompt, {
    initialLocale: options.locale,
    currentLanguage: ui?.language ?? "en",
    currentFlavor: ui?.flavor,
    showCurrentState: true,
    allowBack: true,
  });
  if (languageResult.kind === "back") {
    return {
      completed: false,
      exitCode: 0,
      output: "",
      initialDecision,
      selectedActionId: action.id,
      menuBackRequested: true,
    };
  }
  const preferences = languageResult.selection;

  return reviewAndApplyAction(options, initialDecision, session, {
    ...editorAction,
    reviewValues: {
      ...editorAction.reviewValues,
      language: preferences.language,
      flavor: preferences.flavor,
      activityLabels: preferences.activityLabels,
    },
  });
}

async function handleOptionalCapabilityAction(
  options: LocalizedConfigEditorRunnerOptions,
  initialDecision: SetupRouteDecision,
  session: NonNullable<SetupRouteDecision["setupEditorPlanSession"]>,
  action: ConfigEditorRenderedAction
): Promise<ConfigEditorRunnerResult> {
  requireEditorAction(action);
  const stateHome = resolveStateHome({ homeDir: options.homeDir });
  const loaded = await loadRuntimeConfig(options);
  const baseContext = setupModuleContextFromDecision({
    homeDir: options.homeDir,
    profileId: options.profileId,
    workspaceRoot: options.workspaceRoot,
    trustStorePath: options.trustStorePath ?? stateHome.trustJsonPath,
    configPath: activeProfileConfigPath(options),
  }, initialDecision, loaded.config);
  while (true) {
    const selectedChannelResult = action.id === "configure-channels"
      ? await promptChannelCapability(options.prompt, options.locale, { allowBack: true })
      : undefined;
    if (selectedChannelResult?.kind === "back") {
      return menuBackResult(initialDecision, action.id);
    }
    const selectedChannel = typeof selectedChannelResult === "object"
      ? selectedChannelResult.value
      : selectedChannelResult;
    if (selectedChannel === "whatsapp") {
      return handleWhatsAppSetupFlowAction(options, initialDecision, action.id);
    }

    const selectedVoiceModeResult = action.id === "configure-voice"
      ? await promptVoiceCapability(options.prompt, options.locale, { allowBack: true })
      : undefined;
    if (selectedVoiceModeResult?.kind === "back") {
      return menuBackResult(initialDecision, action.id);
    }
    const selectedVoiceMode = typeof selectedVoiceModeResult === "object"
      ? selectedVoiceModeResult.value
      : selectedVoiceModeResult;

    const module = selectedChannel === undefined
      ? optionalCapabilityModuleForAction(action.id)
      : channelCapabilityModule(selectedChannel);
    const promptContext = optionalCapabilityPromptContext(
      baseContext,
      module,
      options.locale
    );
    const selectedDrafts: SetupDraft[] = [];
    const pendingCredentialWrites: PendingCredentialWrite[] = [];

    if (action.id === "configure-image-generation") {
      const collected = await collectOptionalCapabilityContext(options, baseContext, promptContext.module, selectedVoiceMode, {
        allowBack: true,
      });
      if (collected.kind === "back") {
        return menuBackResult(initialDecision, action.id);
      }
      if (collected.kind === "configured") {
        if (collected.pendingCredentialWrites !== undefined) {
          pendingCredentialWrites.push(...collected.pendingCredentialWrites);
        }
        const configuration = promptContext.module.configure(collected.context);
        selectedDrafts.push(...promptContext.module.toDrafts(collected.context, configuration));
      }
      if (selectedDrafts.length === 0) {
        const output = `${promptContext.title} left unchanged. No setup changes were drafted.`;
        write(options, `${output}\n`);
        return {
          completed: true,
          exitCode: 0,
          output,
          initialDecision,
          selectedActionId: action.id,
        };
      }

      const bundle = buildOptionalCapabilityDraftBundle(
        `setup-editor.optional-capabilities.${promptContext.module.id}`,
        selectedDrafts
      );
      const verificationBundle = verificationDraftBundle(options, initialDecision, session, stateHome);
      return reviewAndApplyBundles(options, initialDecision, action.id, [
        bundle,
        ...(verificationBundle === undefined ? [] : [verificationBundle]),
      ], { pendingCredentialWrites });
    }

    while (true) {
      const selectedResult = await promptOptionalCapabilityAction(options.prompt, {
        id: optionalPromptId(promptContext.module.id),
        title: promptContext.title,
        configured: promptContext.configured,
      }, options.locale, { allowBack: true });
      if (selectedResult.kind === "back") {
        if (action.id === "configure-channels" || action.id === "configure-voice") {
          break;
        }
        return menuBackResult(initialDecision, action.id);
      }
      const selected = selectedResult.value;

      if (selected === "skip") {
        const configuration = promptContext.module.configure(baseContext, { skip: true });
        selectedDrafts.push(...promptContext.module.toDrafts(baseContext, configuration));
      }

      if (selected === "enable") {
        const collected = await collectOptionalCapabilityContext(options, baseContext, promptContext.module, selectedVoiceMode, {
          allowBack: true,
        });
        if (collected.kind === "back") {
          if (action.id === "configure-voice") {
            break;
          }
          if (action.id === "configure-web-search") {
            return menuBackResult(initialDecision, action.id);
          }
          continue;
        }
        if (collected.kind === "skip") {
          const configuration = promptContext.module.configure(baseContext, { skip: true });
          selectedDrafts.push(...promptContext.module.toDrafts(baseContext, configuration));
        }

        if (collected.kind === "configured") {
          if (collected.pendingCredentialWrites !== undefined) {
            pendingCredentialWrites.push(...collected.pendingCredentialWrites);
          }
          const configuration = promptContext.module.configure(collected.context);
          selectedDrafts.push(...promptContext.module.toDrafts(collected.context, configuration));
        }
      }

      if (selectedDrafts.length === 0) {
        const output = `${promptContext.title} left unchanged. No setup changes were drafted.`;
        write(options, `${output}\n`);
        return {
          completed: true,
          exitCode: 0,
          output,
          initialDecision,
          selectedActionId: action.id,
        };
      }

      const bundle = buildOptionalCapabilityDraftBundle(
        `setup-editor.optional-capabilities.${promptContext.module.id}`,
        selectedDrafts
      );
      const verificationBundle = verificationDraftBundle(options, initialDecision, session, stateHome);
      return reviewAndApplyBundles(options, initialDecision, action.id, [
        bundle,
        ...(verificationBundle === undefined ? [] : [verificationBundle]),
      ], { pendingCredentialWrites });
    }
  }
}

async function handleWhatsAppSetupFlowAction(
  options: LocalizedConfigEditorRunnerOptions,
  initialDecision: SetupRouteDecision,
  selectedActionId: string
): Promise<ConfigEditorRunnerResult> {
  const previouslyReadyGatewayChannelIds = await readyConfiguredGatewayChannelIds({
    homeDir: options.homeDir,
    profileId: options.profileId,
    workspaceRoot: options.workspaceRoot,
  });
  const stateHome = resolveStateHome({ homeDir: options.homeDir });
  const profileId = options.profileId ?? readActiveProfile({ homeDir: stateHome.homeDir }).profileId ?? defaultProfileId();
  const streamedOutput: string[] = [];
  const result = await runWhatsAppSetupFlow({
    workspaceRoot: options.workspaceRoot,
    homeDir: stateHome.homeDir,
    profileId,
    prompt: options.prompt,
    output: {
      write: (chunk) => {
        streamedOutput.push(chunk);
        write(options, chunk);
      },
    },
    dependencies: options.whatsappSetupDependencies,
    source: "setup-editor",
  });
  const setupOutput = combineStreamedSetupOutput(streamedOutput, result.output);
  write(options, `${result.output}\n`);

  if (result.exitCode !== 0) {
    return {
      completed: true,
      exitCode: 0,
      output: setupOutput,
      initialDecision,
      selectedActionId,
    };
  }

  const finalDecision = await collectSetupRoute(options);
  const reviewManifest = await setupEditorWhatsAppReviewManifest(options, finalDecision);
  const gatewayServiceActivationResult = await maybeOfferGatewayStartAfterChannelSetup({
    prompt: options.prompt,
    locale: options.locale,
    homeDir: options.homeDir,
    workspaceRoot: options.workspaceRoot,
    profileId: options.profileId,
    reviewManifest,
    readinessGate: true,
    previouslyReadyChannelIds: previouslyReadyGatewayChannelIds,
    serviceActions: options.gatewayServiceActivation?.serviceActions,
  });
  const gatewayServiceActivationOutput = "output" in gatewayServiceActivationResult
    ? gatewayServiceActivationResult.output
    : undefined;
  if (gatewayServiceActivationOutput !== undefined) {
    write(options, `${gatewayServiceActivationOutput}\n`);
  }
  const output = [setupOutput, gatewayServiceActivationOutput].filter((line): line is string => line !== undefined).join("\n");
  return {
    completed: true,
    exitCode: 0,
    output,
    initialDecision,
    finalDecision,
    selectedActionId,
    reviewManifest,
    gatewayServiceActivationResult,
  };
}

function combineStreamedSetupOutput(streamedOutput: readonly string[], renderedOutput: string): string {
  const streamed = streamedOutput.join("");
  if (streamed.length === 0) return renderedOutput;
  if (renderedOutput.length === 0) return streamed;
  return `${streamed}${streamed.endsWith("\n") ? "" : "\n"}${renderedOutput}`;
}

async function setupEditorWhatsAppReviewManifest(
  options: LocalizedConfigEditorRunnerOptions,
  decision: SetupRouteDecision
): Promise<SetupReviewManifest> {
  const stateHome = resolveStateHome({ homeDir: options.homeDir });
  const loaded = await loadRuntimeConfig(options);
  const context = setupModuleContextFromDecision({
    homeDir: options.homeDir,
    profileId: options.profileId,
    workspaceRoot: options.workspaceRoot,
    trustStorePath: options.trustStorePath ?? stateHome.trustJsonPath,
    configPath: activeProfileConfigPath(options),
  }, decision, loaded.config);
  const module = channelCapabilityModule("whatsapp");
  const configuration = module.configure(context);
  return buildSetupReviewManifest([
    buildOptionalCapabilityDraftBundle(
      "setup-editor.optional-capabilities.whatsapp",
      module.toDrafts(context, configuration)
    ),
  ]);
}

async function handleProviderRouteAction(
  options: LocalizedConfigEditorRunnerOptions,
  initialDecision: SetupRouteDecision,
  session: NonNullable<SetupRouteDecision["setupEditorPlanSession"]>,
  action: ConfigEditorRenderedAction
): Promise<RunOnceResult> {
  const editorAction = requireEditorAction(action);
  const loaded = await loadRuntimeConfig(options);
  const resolved = await selectResolvedProviderRoute(options, "primary", {
    currentProviderId: loaded.primaryModelRoute.provider,
    currentModelId: loaded.primaryModelRoute.id,
  });
  if (resolved.kind !== "selected") {
    return handleProviderRoutePromptExit(options, initialDecision, action.id, resolved);
  }

  if (resolved.selection.credentialAction.kind === "endpoint") {
    return reviewAndApplyOpenAICompatibleEndpointFlow(options, initialDecision, session, editorAction, resolved.selection, {
      providerId: loaded.primaryModelRoute.provider,
      modelId: loaded.primaryModelRoute.id,
      baseUrl: loaded.primaryModelRoute.baseUrl,
    });
  }

  return reviewAndApplyResolvedRoute(options, initialDecision, session, editorAction, resolved.selection);
}

async function reviewAndApplyOpenAICompatibleEndpointFlow(
  options: LocalizedConfigEditorRunnerOptions,
  initialDecision: SetupRouteDecision,
  session: NonNullable<SetupRouteDecision["setupEditorPlanSession"]>,
  editorAction: SetupEditorActionDraft,
  resolution: ProviderModelSelectionResult,
  currentRoute?: {
    readonly providerId: string;
    readonly modelId: string;
    readonly baseUrl?: string;
  }
): Promise<RunOnceResult> {
  if (resolution.credentialAction.kind !== "endpoint") {
    throw new Error("OpenAI-compatible endpoint setup requires an endpoint credential action.");
  }
  return collectAndApplyOpenAICompatibleEndpointFlow(options, initialDecision, session, editorAction, {
    providerId: resolution.provider,
    defaultBaseUrl: resolution.credentialAction.baseUrl ?? resolution.baseUrl ?? "http://localhost:11434/v1",
    defaultApiKeyEnv: resolution.credentialAction.apiKeyEnv,
    currentRoute,
  });
}

async function handleCustomProviderRouteAction(
  options: LocalizedConfigEditorRunnerOptions,
  initialDecision: SetupRouteDecision,
  session: NonNullable<SetupRouteDecision["setupEditorPlanSession"]>,
  action: ConfigEditorRenderedAction
): Promise<RunOnceResult> {
  const editorAction = requireEditorAction(action);
  const loaded = await loadRuntimeConfig(options);
  const customProvider = await collectCustomOpenAICompatibleProviderId(options, loaded.config);
  if (customProvider.kind === "cancel") {
    const output = setupCopyText(options.locale, "setupEditor.result.exitWithoutChanges");
    write(options, `${output}\n`);
    return {
      completed: true,
      exitCode: 0,
      output,
      initialDecision,
      selectedActionId: editorAction.id,
    };
  }

  return collectAndApplyOpenAICompatibleEndpointFlow(options, initialDecision, session, editorAction, {
    providerId: customProvider.providerId,
    defaultBaseUrl: customProvider.defaultBaseUrl,
    defaultApiKeyEnv: customProvider.defaultApiKeyEnv,
    currentRoute: {
      providerId: loaded.primaryModelRoute.provider,
      modelId: loaded.primaryModelRoute.id,
      baseUrl: loaded.primaryModelRoute.baseUrl,
    },
  });
}

type CustomOpenAICompatibleProviderIdResult =
  | {
      readonly kind: "selected";
      readonly providerId: ProviderId;
      readonly defaultBaseUrl: string;
      readonly defaultApiKeyEnv: string;
    }
  | { readonly kind: "cancel" };

async function collectCustomOpenAICompatibleProviderId(
  options: LocalizedConfigEditorRunnerOptions,
  config: Awaited<ReturnType<typeof loadRuntimeConfig>>["config"]
): Promise<CustomOpenAICompatibleProviderIdResult> {
  const target = setupPromptContext(options.prompt, options.locale);
  let error: string | undefined;

  for (;;) {
    await showSetupCard(target, {
      title: setupCopyText(options.locale, "setupEditor.prompt.openaiCompatible.custom.title"),
      bodyLines: [
        setupCopyText(options.locale, "setupEditor.prompt.openaiCompatible.endpoint.body"),
        ...(error === undefined ? [] : [error]),
      ],
      options: [],
    });

    const providerId = (await options.prompt(setupOutputLine(
      options.locale,
      `${setupCopyText(options.locale, "setupEditor.prompt.openaiCompatible.custom.providerId")} `
    ))).trim();
    if (providerId.length === 0) {
      return { kind: "cancel" };
    }

    if (!isValidCustomProviderId(providerId)) {
      error = formatSetupCopy(options.locale, "setupEditor.prompt.openaiCompatible.custom.invalidProviderId", {
        providerId,
      });
      continue;
    }

    const existingProvider = config.providers?.[providerId];
    const existingBaseUrl = existingProvider?.baseUrl;
    const defaultApiKeyEnv = existingProvider?.apiKeyEnv ?? "OPENAI_COMPATIBLE_API_KEY";
    if (existingBaseUrl !== undefined && existingBaseUrl.length > 0) {
      const conflictChoice = await promptSetupChoice(target, {
        title: setupCopyText(options.locale, "setupEditor.prompt.openaiCompatible.custom.title"),
        message: `${formatSetupCopy(options.locale, "setupEditor.prompt.openaiCompatible.custom.conflict", {
          providerId,
          baseUrl: existingBaseUrl,
        })}\n`,
        choices: [
          {
            id: "edit-existing-provider",
            label: setupCopyText(options.locale, "setupEditor.prompt.openaiCompatible.custom.editExisting"),
            description: formatSetupCopy(options.locale, "setupEditor.prompt.openaiCompatible.endpoint.destination", {
              baseUrl: existingBaseUrl,
            }),
            value: "edit-existing" as const,
          },
          {
            id: "use-different-provider-id",
            label: setupCopyText(options.locale, "setupEditor.prompt.openaiCompatible.custom.useDifferentId"),
            description: setupCopyText(options.locale, "setupEditor.prompt.openaiCompatible.custom.providerId"),
            value: "use-different" as const,
          },
          {
            id: "cancel-custom-provider",
            label: setupCopyText(options.locale, "setupEditor.review.cancel"),
            description: setupCopyText(options.locale, "setupEditor.review.cancel.description"),
            value: "cancel" as const,
          },
        ],
        defaultValue: "edit-existing" as const,
      });
      if (conflictChoice === "cancel") {
        return { kind: "cancel" };
      }
      if (conflictChoice === "use-different") {
        error = undefined;
        continue;
      }
      return {
        kind: "selected",
        providerId,
        defaultBaseUrl: existingBaseUrl,
        defaultApiKeyEnv,
      };
    }

    return {
      kind: "selected",
      providerId,
      defaultBaseUrl: "http://localhost:11434/v1",
      defaultApiKeyEnv,
    };
  }
}

function isValidCustomProviderId(providerId: string): providerId is ProviderId {
  return /^[a-zA-Z0-9._-]{1,64}$/u.test(providerId);
}

async function collectAndApplyOpenAICompatibleEndpointFlow(
  options: LocalizedConfigEditorRunnerOptions,
  initialDecision: SetupRouteDecision,
  session: NonNullable<SetupRouteDecision["setupEditorPlanSession"]>,
  editorAction: SetupEditorActionDraft,
  input: {
    readonly providerId: ProviderId;
    readonly defaultBaseUrl: string;
    readonly defaultApiKeyEnv?: string;
    readonly currentRoute?: {
      readonly providerId: string;
      readonly modelId: string;
      readonly baseUrl?: string;
    };
  }
): Promise<RunOnceResult> {
  const flowResult = await collectOpenAICompatibleEndpointFlow({
    providerId: input.providerId,
    defaultBaseUrl: input.defaultBaseUrl,
    defaultApiKeyEnv: input.defaultApiKeyEnv,
    currentRoute: input.currentRoute,
    locale: options.locale,
    ui: createOpenAICompatibleEndpointFlowUi(options.prompt, options.locale),
    fetch: openAICompatibleSetupFetch(options),
    initialEnv: process.env,
  });

  if (flowResult.kind !== "ready") {
    if (flowResult.kind === "back") {
      return menuBackResult(initialDecision, editorAction.id);
    }
    const output = setupCopyText(options.locale, "setupEditor.result.exitWithoutChanges");
    write(options, `${output}\n`);
    return {
      completed: true,
      exitCode: 0,
      output,
      initialDecision,
      selectedActionId: editorAction.id,
    };
  }

  return reviewAndApplyOpenAICompatibleEndpointResult(options, initialDecision, session, editorAction, flowResult);
}

async function reviewAndApplyOpenAICompatibleEndpointResult(
  options: LocalizedConfigEditorRunnerOptions,
  initialDecision: SetupRouteDecision,
  session: NonNullable<SetupRouteDecision["setupEditorPlanSession"]>,
  editorAction: SetupEditorActionDraft,
  flowResult: Extract<OpenAICompatibleEndpointFlowResult, { readonly kind: "ready" }>
): Promise<RunOnceResult> {
  const verificationAction = session.plan.actions.find((candidate) => candidate.id === "run-readonly-verification");
  const routeAction = endpointRouteActionForEditorAction(editorAction, flowResult.routeAction);
  const draftActions = [
    routeAction,
    ...(flowResult.credentialAction === undefined ? [] : [flowResult.credentialAction]),
    ...(verificationAction === undefined ? [] : [verificationAction]),
  ];
  const stateHome = resolveStateHome({ homeDir: options.homeDir });
  const profileConfigPath = activeProfileConfigPath(options);
  const draftBundle = buildSetupEditorActionDraftBundle(session, draftActions, {
    configPath: profileConfigPath,
    workspaceRoot: options.workspaceRoot,
    trustStorePath: options.trustStorePath ?? stateHome.trustJsonPath,
  });
  const reviewManifest = buildSetupReviewManifest([draftBundle]);
  const reviewAccepted = await promptConfigEditorReviewApproval(options.prompt, {
    selectedActionId: editorAction.id,
    reviewManifest,
  }, options.locale);
  const applyPlanningResult = planSetupApply(reviewAccepted
    ? { kind: "approved-review-result", manifest: reviewManifest }
    : { kind: "cancelled-review-result", manifest: reviewManifest, reason: "User cancelled review." });

  return finalizeReviewedApply({
    options,
    initialDecision,
    selectedActionId: editorAction.id,
    reviewManifest,
    applyPlanningResult,
    deferredSecretWrites: flowResult.pendingCredentialWrite === undefined
      ? undefined
      : [flowResult.pendingCredentialWrite],
  });
}

function endpointRouteActionForEditorAction(
  editorAction: SetupEditorActionDraft,
  endpointRouteAction: SetupEditorActionDraft
): SetupEditorActionDraft {
  if (editorAction.id === "edit-fallback-model-route" || editorAction.id === "edit-auxiliary-model-route") {
    return {
      ...editorAction,
      reviewValues: {
        ...editorAction.reviewValues,
        ...endpointRouteAction.reviewValues,
      },
    };
  }
  return endpointRouteAction;
}

async function handleFallbackRouteAction(
  options: LocalizedConfigEditorRunnerOptions,
  initialDecision: SetupRouteDecision,
  session: NonNullable<SetupRouteDecision["setupEditorPlanSession"]>,
  action: ConfigEditorRenderedAction
): Promise<RunOnceResult> {
  const editorAction = requireEditorAction(action);
  const loaded = await loadRuntimeConfig(options);
  const fallbacks = loaded.config.model?.fallbacks ?? [];
  const choiceResult = fallbacks.length === 0
    ? { id: "fallback-add" as const, fallbackOperation: "add" as const }
    : await promptFallbackRouteAction(options.prompt, fallbacks, options.locale, { allowBack: true });
  if ("kind" in choiceResult && choiceResult.kind === "back") {
    return menuBackResult(initialDecision, action.id);
  }
  const choice = "kind" in choiceResult ? choiceResult.value : choiceResult;
  const currentFallback = choice.fallbackOperation === "replace" ? choice.fallback : undefined;
  const resolved = await selectResolvedProviderRoute(options, "fallback", {
    currentProviderId: currentFallback?.provider,
    currentModelId: currentFallback?.id,
  });
  if (resolved.kind !== "selected") {
    return handleProviderRoutePromptExit(options, initialDecision, action.id, resolved);
  }

  const selectedAction: SetupEditorActionDraft = {
    ...editorAction,
    reviewValues: {
      ...editorAction.reviewValues,
      fallbackOperation: choice.fallbackOperation,
      ...(choice.fallbackOperation === "replace"
        ? {
            fallbackIndex: choice.fallbackIndex,
            previousProvider: choice.fallback.provider,
            previousModel: choice.fallback.id,
          }
        : {}),
    },
  };
  if (resolved.selection.credentialAction.kind === "endpoint") {
    return collectAndApplyOpenAICompatibleEndpointFlow(options, initialDecision, session, selectedAction, {
      providerId: resolved.selection.provider,
      defaultBaseUrl: resolved.selection.credentialAction.baseUrl ?? resolved.selection.baseUrl ?? "http://localhost:11434/v1",
      defaultApiKeyEnv: resolved.selection.credentialAction.apiKeyEnv,
      currentRoute: currentFallback === undefined
        ? undefined
        : {
            providerId: currentFallback.provider,
            modelId: currentFallback.id,
            baseUrl: currentFallback.baseUrl,
          },
    });
  }

  return reviewAndApplyResolvedRoute(options, initialDecision, session, selectedAction, resolved.selection);
}

async function handleAuxiliaryRouteAction(
  options: LocalizedConfigEditorRunnerOptions,
  initialDecision: SetupRouteDecision,
  session: NonNullable<SetupRouteDecision["setupEditorPlanSession"]>,
  action: ConfigEditorRenderedAction
): Promise<RunOnceResult> {
  const editorAction = requireEditorAction(action);
  const auxiliaryTaskResult = await promptAuxiliaryModelTask(options.prompt, options.locale, { allowBack: true });
  if (auxiliaryTaskResult.kind === "back") {
    return menuBackResult(initialDecision, action.id);
  }
  const auxiliaryTask = auxiliaryTaskResult.value;
  const loaded = await loadRuntimeConfig(options);
  const currentAuxiliaryRoute = auxiliaryRouteFromSlot(loaded.config.auxiliaryModels?.[auxiliaryTask]);
  const resolved = await selectResolvedProviderRoute(options, "auxiliary", {
    currentProviderId: currentAuxiliaryRoute?.provider,
    currentModelId: currentAuxiliaryRoute?.id,
  });
  if (resolved.kind !== "selected") {
    return handleProviderRoutePromptExit(options, initialDecision, action.id, resolved);
  }

  const selectedAction: SetupEditorActionDraft = {
    ...editorAction,
    reviewValues: {
      ...editorAction.reviewValues,
      auxiliaryTask,
    },
  };
  if (resolved.selection.credentialAction.kind === "endpoint") {
    return collectAndApplyOpenAICompatibleEndpointFlow(options, initialDecision, session, selectedAction, {
      providerId: resolved.selection.provider,
      defaultBaseUrl: resolved.selection.credentialAction.baseUrl ?? resolved.selection.baseUrl ?? "http://localhost:11434/v1",
      defaultApiKeyEnv: resolved.selection.credentialAction.apiKeyEnv,
      currentRoute: currentAuxiliaryRoute === undefined
        ? undefined
        : {
            providerId: currentAuxiliaryRoute.provider,
            modelId: currentAuxiliaryRoute.id,
            baseUrl: currentAuxiliaryRoute.baseUrl,
          },
    });
  }

  return reviewAndApplyResolvedRoute(options, initialDecision, session, selectedAction, resolved.selection);
}

function auxiliaryRouteFromSlot(
  slot: AuxiliaryModelSlotInput | undefined
): { readonly provider: string; readonly id: string; readonly baseUrl?: string } | undefined {
  if (slot === undefined) {
    return undefined;
  }
  if (typeof slot === "string") {
    const separator = slot.indexOf("/");
    if (separator <= 0 || separator === slot.length - 1) {
      return undefined;
    }
    return {
      provider: slot.slice(0, separator),
      id: slot.slice(separator + 1),
    };
  }
  if (slot.provider === undefined || slot.provider === "auto" || slot.provider === "main" || slot.id === undefined) {
    return undefined;
  }
  return {
    provider: slot.provider,
    id: slot.id,
    baseUrl: slot.baseUrl,
  };
}

async function handleCredentialAction(
  options: LocalizedConfigEditorRunnerOptions,
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
  options: LocalizedConfigEditorRunnerOptions,
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
  const profileConfigPath = activeProfileConfigPath(options);
  const draftBundle = buildSetupEditorActionDraftBundle(session, draftActions, {
    configPath: profileConfigPath,
    workspaceRoot: options.workspaceRoot,
    trustStorePath: overrides.trustStorePath ?? options.trustStorePath ?? stateHome.trustJsonPath,
  });
  const reviewManifest = buildSetupReviewManifest([draftBundle]);
  return reviewAndApplyManifest(options, initialDecision, editorAction.id, reviewManifest);
}

function verificationDraftBundle(
  options: LocalizedConfigEditorRunnerOptions,
  initialDecision: SetupRouteDecision,
  session: NonNullable<SetupRouteDecision["setupEditorPlanSession"]>,
  stateHome: ReturnType<typeof resolveStateHome>
): SetupDraftBundle | undefined {
  const verificationAction = session.plan.actions.find((candidate) => candidate.id === "run-readonly-verification");
  if (verificationAction === undefined) return undefined;
  const profileConfigPath = activeProfileConfigPath(options);
  return buildSetupEditorActionDraftBundle(session, [verificationAction], {
    configPath: profileConfigPath,
    workspaceRoot: options.workspaceRoot,
    trustStorePath: options.trustStorePath ?? stateHome.trustJsonPath,
  });
}

async function reviewAndApplyBundles(
  options: LocalizedConfigEditorRunnerOptions,
  initialDecision: SetupRouteDecision,
  selectedActionId: string,
  bundles: readonly SetupDraftBundle[],
  sideEffects: {
    readonly pendingCredentialWrites?: readonly PendingCredentialWrite[];
    readonly pendingOAuthWrites?: readonly PendingOAuthWrite[];
  } = {}
): Promise<ConfigEditorRunnerResult> {
  const reviewManifest = buildSetupReviewManifest(bundles);
  return reviewAndApplyManifest(options, initialDecision, selectedActionId, reviewManifest, sideEffects);
}

async function reviewAndApplyManifest(
  options: LocalizedConfigEditorRunnerOptions,
  initialDecision: SetupRouteDecision,
  selectedActionId: string,
  reviewManifest: SetupReviewManifest,
  sideEffects: {
    readonly pendingCredentialWrites?: readonly PendingCredentialWrite[];
    readonly pendingOAuthWrites?: readonly PendingOAuthWrite[];
  } = {}
): Promise<ConfigEditorRunnerResult> {
  const reviewAccepted = await promptConfigEditorReviewApproval(options.prompt, {
    selectedActionId,
    reviewManifest,
  }, options.locale);
  const applyPlanningResult = planSetupApply(reviewAccepted
    ? { kind: "approved-review-result", manifest: reviewManifest }
    : { kind: "cancelled-review-result", manifest: reviewManifest, reason: "User cancelled review." });
  return finalizeReviewedApply({
    options,
    initialDecision,
    selectedActionId,
    reviewManifest,
    applyPlanningResult,
    deferredSecretWrites: sideEffects.pendingCredentialWrites,
    deferredOAuthWrites: sideEffects.pendingOAuthWrites,
  });
}

async function finalizeReviewedApply(input: {
  readonly options: LocalizedConfigEditorRunnerOptions;
  readonly initialDecision: SetupRouteDecision;
  readonly selectedActionId: string;
  readonly reviewManifest: SetupReviewManifest;
  readonly applyPlanningResult: SetupApplyPlanningResult;
  readonly deferredSecretWrites?: readonly SetupDeferredSecretWrite[];
  readonly deferredOAuthWrites?: readonly SetupDeferredOAuthWrite[];
}): Promise<RunOnceResult> {
  const { options, initialDecision, selectedActionId, reviewManifest, applyPlanningResult } = input;
  const previouslyReadyGatewayChannelIds = applyPlanningResult.kind === "apply-plan-ready" && options.applyExecutor !== undefined
    ? await readyConfiguredGatewayChannelIds({
        homeDir: options.homeDir,
        profileId: options.profileId,
        workspaceRoot: options.workspaceRoot,
      })
    : undefined;
  const applyEndState = applyPlanningResult.kind === "apply-plan-ready" && options.applyExecutor !== undefined
    ? await executeSetupApplyPlan(applyPlanningResult.applyPlan, options.applyExecutor, {
        ...options.applyFlowOptions,
        mode: "strict",
        allowAutomaticLaunch: false,
        ...(input.deferredSecretWrites !== undefined && input.deferredSecretWrites.length > 0
          ? { deferredSecretWrites: input.deferredSecretWrites }
          : {}),
        ...(input.deferredOAuthWrites !== undefined && input.deferredOAuthWrites.length > 0
          ? { deferredOAuthWrites: input.deferredOAuthWrites }
          : {}),
      })
    : undefined;
  const output = applyEndState === undefined
    ? renderSetupApplyPlanningResult(applyPlanningResult, options.locale)
    : renderSetupApplyEndState(applyEndState, options.locale);
  write(options, `${output}\n`);

  if (applyEndState === undefined) {
    const completed = applyPlanningResult.kind === "apply-plan-ready";
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

  const postApply = await handlePostApplyHandoff({
    options,
    initialDecision,
    selectedActionId,
    reviewManifest,
    applyPlanningResult,
    applyEndState,
    renderedApplyOutput: output,
    previouslyReadyGatewayChannelIds,
  });
  return postApply;
}

async function handlePostApplyHandoff(input: {
  readonly options: LocalizedConfigEditorRunnerOptions;
  readonly initialDecision: SetupRouteDecision;
  readonly selectedActionId: string;
  readonly reviewManifest: SetupReviewManifest;
  readonly applyPlanningResult: SetupApplyPlanningResult;
  readonly applyEndState: SetupApplyEndState;
  readonly renderedApplyOutput: string;
  readonly previouslyReadyGatewayChannelIds?: readonly GatewayActivationChannelId[];
}): Promise<RunOnceResult> {
  const {
    options,
    initialDecision,
    selectedActionId,
    reviewManifest,
    applyPlanningResult,
    applyEndState,
    renderedApplyOutput,
    previouslyReadyGatewayChannelIds,
  } = input;
  const completedWithoutPrompt = applyEndState.kind === "cancelled";
  if (completedWithoutPrompt) {
    return {
      completed: false,
      exitCode: 1,
      output: renderedApplyOutput,
      initialDecision,
      selectedActionId,
      reviewManifest,
      applyPlanningResult,
      applyEndState,
    };
  }

  const postApplyRouteDecision = await collectSetupRoute(options);
  const handoffState = postApplyHandoffState(applyEndState, postApplyRouteDecision);
  const gatewayServiceActivationResult = await maybeOfferGatewayStartAfterChannelSetup({
    prompt: options.prompt,
    locale: options.locale,
    homeDir: options.homeDir,
    workspaceRoot: options.workspaceRoot,
    profileId: options.profileId,
    reviewManifest,
    readinessGate: handoffState !== "blocked",
    previouslyReadyChannelIds: previouslyReadyGatewayChannelIds,
    serviceActions: options.gatewayServiceActivation?.serviceActions,
  });
  const gatewayServiceActivationOutput = "output" in gatewayServiceActivationResult
    ? gatewayServiceActivationResult.output
    : undefined;
  if (gatewayServiceActivationOutput !== undefined) {
    write(options, `${gatewayServiceActivationOutput}\n`);
  }
  const handoffWarningOutput = handoffState === "degraded"
    ? renderConcreteVerificationWarnings(applyEndState, options.locale)
    : undefined;
  if (handoffWarningOutput !== undefined) {
    write(options, `${handoffWarningOutput}\n`);
  }

  const exitOutput = [
    renderedApplyOutput,
    gatewayServiceActivationOutput,
    handoffWarningOutput,
  ].filter((line): line is string => line !== undefined).join("\n");
  return {
    completed: applyEndState.kind !== "blocked",
    exitCode: applyEndState.kind === "blocked" ? 1 : 0,
    output: exitOutput,
    initialDecision,
    finalDecision: postApplyRouteDecision,
    postApplyRouteDecision,
    selectedActionId,
    reviewManifest,
    applyPlanningResult,
    applyEndState,
    gatewayServiceActivationResult,
  };
}

function renderConcreteVerificationWarnings(
  endState: SetupApplyEndState,
  locale: SetupCopyLocale
): string | undefined {
  const launchableEndState = launchableApplyEndState(endState);
  if (launchableEndState === undefined) return undefined;
  const warnings = [
    ...launchableEndState.verification.warnings,
    ...launchableEndState.verification.providerDiagnostic.warnings,
  ].filter((warning, index, allWarnings) => warning.trim().length > 0 && allWarnings.indexOf(warning) === index);
  if (warnings.length === 0) return undefined;
  return [
    `${setupCopyText(locale, "setupEditor.postApply.warningList")}:`,
    ...warnings.map((warning) => `- ${warning}`),
  ].join("\n");
}

function postApplyHandoffState(
  applyEndState: SetupApplyEndState,
  postApplyRouteDecision: SetupRouteDecision
): "ready" | "degraded" | "blocked" {
  if (applyEndState.kind === "verified-ready" && routeAllowsLaunch(postApplyRouteDecision)) {
    return "ready";
  }
  if (applyEndState.kind === "verified-degraded" && !routeBlocksLaunch(postApplyRouteDecision)) {
    return "degraded";
  }
  if (
    applyEndState.kind === "saved-not-launched" &&
    applyEndState.verification !== undefined &&
    classifySetupVerificationReport(applyEndState.verification) === "ready" &&
    routeAllowsLaunch(postApplyRouteDecision)
  ) {
    return "ready";
  }
  return "blocked";
}

function routeAllowsLaunch(decision: SetupRouteDecision): boolean {
  return decision.kind === "configured-menu" && decision.state.kind === "configured-ready";
}

function routeBlocksLaunch(decision: SetupRouteDecision): boolean {
  return decision.state.kind === "broken-config" ||
    decision.state.kind === "missing-secret" ||
    decision.state.kind === "state-not-writable" ||
    decision.state.kind === "untrusted-workspace" ||
    decision.state.kind === "partial-provider";
}

function launchableApplyEndState(endState: SetupApplyEndState): LaunchableApplyEndState | undefined {
  if (
    endState.kind === "verified-ready" ||
    endState.kind === "verified-degraded" ||
    endState.kind === "saved-not-launched" ||
    endState.kind === "launched"
  ) {
    return endState.verification === undefined
      ? undefined
      : {
          verification: endState.verification,
          launchHandoffIntent: endState.launchHandoffIntent,
        };
  }
  return undefined;
}

function launchHandoffIntentForApplyEndState(endState: LaunchableApplyEndState): SetupLaunchHandoffIntent {
  if ("launchHandoffIntent" in endState && endState.launchHandoffIntent !== undefined) {
    return endState.launchHandoffIntent;
  }
  return {
    kind: "launch-handoff-intent",
    sourceLineIds: [],
    preference: "offer-after-verify",
    requiresVerifiedReadyOrAcceptedDegraded: true,
  };
}

function activeProfileConfigPath(options: Pick<ConfigEditorRunnerOptions, "homeDir" | "profileId">): string {
  const profileId = options.profileId ?? readActiveProfile({ homeDir: options.homeDir }).profileId ?? defaultProfileId();
  return resolveProfileStateHome({ homeDir: options.homeDir, profileId }).configPath;
}

function openAICompatibleSetupFetch(
  options: Pick<ConfigEditorRunnerOptions, "providerFetch">
): OpenAICompatibleFetchLike | undefined {
  if (options.providerFetch === undefined) return undefined;
  return async (url, init) => {
    const response = await options.providerFetch!(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
    });
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      json: response.json,
      text: async () => "",
      body: null,
    };
  };
}

async function reviewAndApplyResolvedRoute(
  options: LocalizedConfigEditorRunnerOptions,
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
    baseUrl: credentialResult.baseUrl ?? resolution.baseUrl,
    apiKeyEnv: credentialResult.envVarName,
    contextWindowTokens: resolution.profile.contextWindowTokens,
    apiMode: resolution.apiMode,
    authMethod: resolution.authMethod,
    oauthCredentialStatus: credentialResult.oauthCredentialStatus,
  };
  const selectedAction: SetupEditorActionDraft = {
    ...editorAction,
    reviewValues,
  };
  const verificationAction = session.plan.actions.find((candidate) => candidate.id === "run-readonly-verification");
  const routeOrSelectedAction = behavior.credentialOnly === true && credentialResult.routeAction !== undefined
    ? {
        ...credentialResult.routeAction,
        reviewValues,
      }
    : selectedAction;
  const includeCredentialAction = credentialResult.credentialAction !== undefined &&
    (behavior.credentialOnly !== true || credentialResult.routeAction !== undefined);
  const draftActions = [
    routeOrSelectedAction,
    ...(includeCredentialAction ? [credentialResult.credentialAction] : []),
    ...(verificationAction === undefined ? [] : [verificationAction]),
  ];
  const stateHome = resolveStateHome({ homeDir: options.homeDir });
  const profileConfigPath = activeProfileConfigPath(options);
  const draftBundle = buildSetupEditorActionDraftBundle(session, draftActions, {
    configPath: profileConfigPath,
    workspaceRoot: options.workspaceRoot,
    trustStorePath: options.trustStorePath ?? stateHome.trustJsonPath,
  });
  const reviewManifest = buildSetupReviewManifest([draftBundle]);
  const reviewAccepted = await promptConfigEditorReviewApproval(options.prompt, {
    selectedActionId: editorAction.id,
    reviewManifest,
  }, options.locale);
  const applyPlanningResult = planSetupApply(reviewAccepted
    ? { kind: "approved-review-result", manifest: reviewManifest }
    : { kind: "cancelled-review-result", manifest: reviewManifest, reason: "User cancelled review." });

  return finalizeReviewedApply({
    options,
    initialDecision,
    selectedActionId: editorAction.id,
    reviewManifest,
    applyPlanningResult,
    deferredSecretWrites: credentialResult.pendingCredentialWrite === undefined
      ? undefined
      : [credentialResult.pendingCredentialWrite],
    deferredOAuthWrites: credentialResult.pendingOAuthWrite === undefined
      ? undefined
      : [credentialResult.pendingOAuthWrite],
  });
}

async function selectResolvedProviderRoute(
  options: LocalizedConfigEditorRunnerOptions,
  mode: ProviderModelRoutePromptMode,
  currentRoute: {
    readonly currentProviderId?: string;
    readonly currentModelId?: string;
  } = {}
): Promise<ProviderModelPromptResult> {
  const flowEngine = options.flowEngine ?? await createDefaultFlowEngine(options);
  return selectProviderModelRoute({
    prompt: options.prompt,
    flowEngine,
    locale: options.locale,
    currentProviderId: currentRoute.currentProviderId,
    currentModelId: currentRoute.currentModelId,
    endpointFirstProviderIds: mode === "primary" || mode === "fallback" || mode === "auxiliary"
      ? ["local", "openai-compatible"]
      : [],
    allowBack: true,
    allowCancel: true,
    mode,
    openAiCodexChoice: mode === "primary" || mode === "fallback",
  });
}

async function resolveActiveProviderRoute(
  options: LocalizedConfigEditorRunnerOptions,
  initialDecision: SetupRouteDecision
): Promise<
  | { readonly kind: "selected"; readonly selection: ProviderModelSelectionResult }
  | { readonly kind: "diagnostic"; readonly output: string }
> {
  const activeRoute = initialDecision.state.model;
  if (activeRoute === undefined) {
    return {
      kind: "diagnostic",
      output: setupCopyText(options.locale, "setupEditor.result.activeModelMissing"),
    };
  }

  const flowEngine = options.flowEngine ?? await createDefaultFlowEngine(options);
  const providers = await flowEngine.listProviderCandidates();
  const provider = providers.find((candidate) => candidate.id === activeRoute.provider);
  if (provider === undefined) {
    return {
      kind: "diagnostic",
      output: formatSetupCopy(options.locale, "setupEditor.result.activeModelUnavailable", {
        providerId: activeRoute.provider,
        modelId: activeRoute.id,
      }),
    };
  }

  const models = await flowEngine.listModelCandidates(provider.id);
  const model = models.find((candidate) => candidate.id === activeRoute.id);
  if (model === undefined) {
    return {
      kind: "diagnostic",
      output: formatSetupCopy(options.locale, "setupEditor.result.activeModelUnavailable", {
        providerId: activeRoute.provider,
        modelId: activeRoute.id,
      }),
    };
  }

  const resolved = await flowEngine.resolveSelection(provider.id, model.id);
  if (resolved.kind === "diagnostic") {
    return {
      kind: "diagnostic",
      output: formatSetupCopy(options.locale, "setupEditor.result.activeModelCredentialUnsupported", {
        providerId: activeRoute.provider,
        modelId: activeRoute.id,
        reason: resolved.reason,
      }),
    };
  }

  return { kind: "selected", selection: resolved };
}

async function resolveCredentialForReview(
  options: LocalizedConfigEditorRunnerOptions,
  resolution: ProviderModelSelectionResult
): Promise<
  | {
      readonly kind: "ready";
      readonly envVarName?: string;
      readonly baseUrl?: string;
      readonly credentialAction?: SetupEditorActionDraft;
      readonly routeAction?: SetupEditorActionDraft;
      readonly pendingCredentialWrite?: PendingCredentialWrite;
      readonly pendingOAuthWrite?: PendingOAuthWrite;
      readonly oauthCredentialStatus?: "ready" | "pending";
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
      const profileId = options.profileId ?? readActiveProfile({ homeDir: options.homeDir }).profileId ?? defaultProfileId();
      const savedSecret = await hasSavedEnvSecret({
        homeDir: options.homeDir,
        profileId,
        key: envVarName,
      });

      if (savedSecret.exists) {
        const reuseChoice = await promptCredentialReuseChoice(options.prompt, options.locale);
        if (reuseChoice === "new") {
          const promptResult = await promptForApiKeyInput({
            prompt: options.prompt,
            providerId: resolution.provider,
            envVarName,
            question: setupProviderCredentialQuestion(options.locale, {
              providerName: credentialProviderDisplayName(resolution.provider),
              envVarName,
            }),
          });
          if (promptResult.kind === "skipped") {
            return {
              kind: "diagnostic",
              output: `No API key was entered for ${envVarName}. The saved credential was left unchanged.`,
            };
          }
          return {
            kind: "ready",
            envVarName,
            credentialAction: credentialReferenceAction(resolution, envVarName),
            pendingCredentialWrite: { envVarName: promptResult.envVarName, value: promptResult.value },
          };
        }
      }

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
        question: setupProviderCredentialQuestion(options.locale, {
          providerName: credentialProviderDisplayName(resolution.provider),
          envVarName,
        }),
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
    case "endpoint":
      return resolveEndpointCredentialForReview(options, resolution);
    case "oauth":
      return resolveOAuthCredentialForReview(options, resolution);
  }
}

async function resolveOAuthCredentialForReview(
  options: LocalizedConfigEditorRunnerOptions,
  resolution: ProviderModelSelectionResult
): Promise<
  | {
      readonly kind: "ready";
      readonly credentialAction: SetupEditorActionDraft;
      readonly pendingOAuthWrite?: PendingOAuthWrite;
      readonly oauthCredentialStatus: "ready" | "pending";
    }
  | { readonly kind: "diagnostic"; readonly output: string }
> {
  if (resolution.credentialAction.kind !== "oauth") {
    throw new Error("OAuth credential review requires an OAuth credential action.");
  }
  if (resolution.provider !== "codex" || resolution.credentialAction.authMethod !== CODEX_OAUTH_AUTH_METHOD) {
    return {
      kind: "diagnostic",
      output: `OAuth setup for ${resolution.provider}/${resolution.model} is not supported by the setup editor.`,
    };
  }

  if (resolution.credentialAction.status === "ready") {
    return {
      kind: "ready",
      credentialAction: oauthCredentialReferenceAction(resolution, "ready"),
      oauthCredentialStatus: "ready",
    };
  }

  const oauthChoice = await promptCodexOAuthSetupChoice(options);
  if (oauthChoice === "cancel") {
    return {
      kind: "diagnostic",
      output: "Codex OAuth authentication was cancelled. No changes were drafted.",
    };
  }

  const hasLiveDeviceCodeNotice = options.prompt.onboardingCard !== undefined;
  showCodexOAuthRequestingDeviceCode(options);
  const { flowResult, deviceCodeShown } = await runCodexOAuthFlowWithDeviceCodeNotice({
    fetchLike: options.providerFetch,
    output: hasLiveDeviceCodeNotice ? undefined : {
      write: (chunk) => write(options, chunk),
    },
    onDeviceCodeNotice: hasLiveDeviceCodeNotice
      ? (notice) => {
          showCodexOAuthDeviceCodeNotice(options, notice.userCode);
        }
      : undefined,
  });
  if (flowResult.kind === "cancelled") {
    return {
      kind: "diagnostic",
      output: "Codex OAuth authentication was cancelled. No changes were drafted.",
    };
  }
  if (flowResult.kind === "timeout") {
    return {
      kind: "diagnostic",
      output: formatCodexOAuthFailure("timeout", flowResult.reason, deviceCodeShown),
    };
  }
  if (flowResult.kind === "error") {
    return {
      kind: "diagnostic",
      output: formatCodexOAuthFailure("error", flowResult.reason, deviceCodeShown),
    };
  }

  return {
    kind: "ready",
    credentialAction: oauthCredentialReferenceAction(resolution, "pending"),
    pendingOAuthWrite: {
      providerId: "codex",
      authMethod: CODEX_OAUTH_AUTH_METHOD,
      tokenRecord: buildCodexOAuthTokenRecord(flowResult.tokens),
    },
    oauthCredentialStatus: "pending",
  };
}

type CodexOAuthSetupChoice = "signin" | "cancel";

async function promptCodexOAuthSetupChoice(
  options: LocalizedConfigEditorRunnerOptions
): Promise<CodexOAuthSetupChoice> {
  return promptSetupChoice(options.prompt, {
    title: setupCopyText(options.locale, "setupEditor.prompt.codexOAuth.title"),
    message: `${setupCopyText(options.locale, "setupEditor.prompt.codexOAuth.body")}\n`,
    choices: [
      {
        id: "codex-oauth-signin",
        label: setupCopyText(options.locale, "setupEditor.prompt.codexOAuth.signIn"),
        description: setupCopyText(options.locale, "setupEditor.prompt.codexOAuth.signIn.description"),
        value: "signin",
      },
      {
        id: "codex-oauth-cancel",
        label: setupCopyText(options.locale, "setupEditor.prompt.codexOAuth.cancel"),
        description: setupCopyText(options.locale, "setupEditor.prompt.codexOAuth.cancel.description"),
        group: "navigation",
        value: "cancel",
      },
    ],
    defaultValue: "signin",
  });
}

function showCodexOAuthRequestingDeviceCode(options: LocalizedConfigEditorRunnerOptions): void {
  options.prompt.onboardingCard?.({
    title: setupCopyText(options.locale, "setupEditor.prompt.codexOAuth.title"),
    bodyLines: [setupCopyText(options.locale, "setupEditor.prompt.codexOAuth.requesting")],
    options: [],
    selectedOptionIndex: 0,
    locale: options.locale,
    direction: options.locale === "ar" ? "rtl" : "ltr",
  });
}

function showCodexOAuthDeviceCodeNotice(
  options: LocalizedConfigEditorRunnerOptions,
  userCode: string
): void {
  options.prompt.onboardingCard?.({
    title: setupCopyText(options.locale, "setupEditor.prompt.codexOAuth.device.title"),
    bodyLines: [
      formatSetupCopy(options.locale, "setupEditor.prompt.codexOAuth.device.open", {
        url: codexDeviceVerificationUrl(),
      }),
      formatSetupCopy(options.locale, "setupEditor.prompt.codexOAuth.device.code", {
        code: userCode,
      }),
      setupCopyText(options.locale, "setupEditor.prompt.codexOAuth.device.waiting"),
    ],
    options: [],
    selectedOptionIndex: 0,
    locale: options.locale,
    direction: options.locale === "ar" ? "rtl" : "ltr",
  });
}

async function resolveEndpointCredentialForReview(
  options: LocalizedConfigEditorRunnerOptions,
  resolution: ProviderModelSelectionResult
): Promise<{
  readonly kind: "ready";
  readonly envVarName?: string;
  readonly baseUrl: string;
  readonly credentialAction?: SetupEditorActionDraft;
  readonly routeAction: SetupEditorActionDraft;
  readonly pendingCredentialWrite?: PendingCredentialWrite;
}> {
  if (resolution.credentialAction.kind !== "endpoint") {
    throw new Error("Endpoint credential review requires an endpoint action.");
  }
  const defaultBaseUrl = resolution.credentialAction.baseUrl ?? resolution.baseUrl ?? "";
  const baseUrl = await promptLocalEndpointBaseUrl(options, defaultBaseUrl);
  const envVarName = resolution.credentialAction.apiKeyEnv;
  const promptResult = await promptForApiKeyInput({
    prompt: options.prompt,
    providerId: resolution.provider,
    envVarName,
    question: formatSetupCopy(options.locale, "setupEditor.prompt.localEndpoint.apiKeyOptional", {
      envVar: envVarName,
    }),
  });

  return {
    kind: "ready",
    baseUrl,
    envVarName: promptResult.kind === "entered" ? envVarName : undefined,
    routeAction: endpointProviderRouteAction(resolution, baseUrl),
    credentialAction: promptResult.kind === "entered"
      ? credentialReferenceAction(resolution, envVarName)
      : undefined,
    pendingCredentialWrite: promptResult.kind === "entered"
      ? { envVarName: promptResult.envVarName, value: promptResult.value }
      : undefined,
  };
}

async function promptLocalEndpointBaseUrl(
  options: LocalizedConfigEditorRunnerOptions,
  defaultBaseUrl: string
): Promise<string> {
  let question = formatSetupCopy(options.locale, "setupEditor.prompt.localEndpoint.baseUrl", {
    baseUrl: defaultBaseUrl,
  });
  for (;;) {
    const raw = (await options.prompt(question)).trim();
    const baseUrl = raw.length > 0 ? raw : defaultBaseUrl;
    if (isValidEndpointBaseUrl(baseUrl)) {
      return baseUrl;
    }
    question = `${formatSetupCopy(options.locale, "setupEditor.result.localEndpointInvalid", {
      baseUrl: defaultBaseUrl,
    })}\n${formatSetupCopy(options.locale, "setupEditor.prompt.localEndpoint.baseUrl", {
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

function endpointProviderRouteAction(
  resolution: ProviderModelSelectionResult,
  baseUrl: string
): SetupEditorActionDraft {
  return {
    kind: "setup-editor-action-draft",
    id: "repair-primary-provider",
    copyKey: "setupEditor.actions.repairPrimaryProvider",
    sectionId: "model-route",
    effect: "draft-config-patch",
    readOnly: false,
    mutatesConfig: false,
    requiresExplicitApply: true,
    preservesUnrelatedConfig: true,
    patch: {
      kind: "scoped-config-patch-intent",
      fields: ["model.provider", "model.id", "provider.route"],
      preserveUnrelatedConfig: true,
    },
    reviewValues: {
      provider: resolution.provider,
      model: resolution.model,
      baseUrl,
      contextWindowTokens: resolution.profile.contextWindowTokens,
      apiMode: resolution.apiMode,
      authMethod: resolution.authMethod,
    },
  };
}

function credentialProviderDisplayName(providerId: ProviderId): string {
  return getProviderMetadata(providerId).displayName;
}

function credentialReferenceAction(
  resolution: ProviderModelSelectionResult,
  envVarName: string
): SetupEditorActionDraft {
  return {
    kind: "setup-editor-action-draft",
    id: "store-provider-credential-reference",
    copyKey: "setupEditor.actions.storeProviderCredentialReference",
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

function oauthCredentialReferenceAction(
  resolution: ProviderModelSelectionResult,
  status: "ready" | "pending"
): SetupEditorActionDraft {
  return {
    kind: "setup-editor-action-draft",
    id: "store-provider-credential-reference",
    copyKey: "setupEditor.actions.storeProviderCredentialReference",
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
    reviewValues: {
      provider: resolution.provider,
      model: resolution.model,
      credentialSurface: "oauth",
      authMethod: resolution.authMethod,
      oauthCredentialStatus: status,
    },
  };
}

function diagnosticResult(
  options: LocalizedConfigEditorRunnerOptions,
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

function menuBackResult(
  initialDecision: SetupRouteDecision,
  selectedActionId: string
): RunOnceResult {
  return {
    completed: false,
    exitCode: 0,
    output: "",
    initialDecision,
    selectedActionId,
    menuBackRequested: true,
  };
}

function handleProviderRoutePromptExit(
  options: LocalizedConfigEditorRunnerOptions,
  initialDecision: SetupRouteDecision,
  selectedActionId: string,
  result: Exclude<ProviderModelPromptResult, { readonly kind: "selected" }>
): RunOnceResult {
  if (result.kind === "diagnostic") {
    return diagnosticResult(options, initialDecision, selectedActionId, result.output);
  }
  if (result.kind === "back") {
    return menuBackResult(initialDecision, selectedActionId);
  }

  const output = setupCopyText(options.locale, "setupEditor.result.exitWithoutChanges");
  write(options, `${output}\n`);
  return {
    completed: true,
    exitCode: 0,
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
      return "run-doctor";
    case "cancel-setup-editor":
      return "exit";
    case "trust-workspace":
      return "repair-workspace-trust";
    case "repair-broken-config":
    case "repair-state-directory":
      return "run-doctor";
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
    profileId: options.profileId,
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

export const runConfigEditorSetup = runConfigEditor;

export async function __reviewAndApplyResolvedRouteForTest(input: {
  readonly options: ConfigEditorRunnerOptions;
  readonly initialDecision: SetupRouteDecision;
  readonly session: NonNullable<SetupRouteDecision["setupEditorPlanSession"]>;
  readonly editorAction: SetupEditorActionDraft;
  readonly resolution: ProviderModelSelectionResult;
  readonly behavior?: {
    readonly credentialOnly?: boolean;
  };
}): Promise<ConfigEditorRunnerResult> {
  const locale = await resolveConfigEditorLocale(input.options);
  return reviewAndApplyResolvedRoute({
    ...input.options,
    locale,
    prompt: withPromptUiContext(input.options.prompt, promptUiContextForLocale(locale)),
  }, input.initialDecision, input.session, input.editorAction, input.resolution, input.behavior);
}
