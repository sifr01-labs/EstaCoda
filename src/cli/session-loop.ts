import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import { join } from "node:path";
import type { Readable } from "node:stream";
import type { Runtime } from "../runtime/create-runtime.js";
import type { RuntimeEvent } from "../contracts/runtime-event.js";
import type { SessionEvent } from "../contracts/session.js";
import type { ToolResult } from "../contracts/tool.js";
import type { ProviderExecutionSummary, ProviderId } from "../contracts/provider.js";
import type { ModelSwitchContext } from "../providers/model-switch-resolver.js";
import { renderSessionRecallResult } from "../session/session-recall-service.js";
import {
  renderSessionCompactionResult as renderLegacySessionCompactionResult,
  type CompactResult,
} from "../prompt/session-compression-service.js";
import { createProviderModelSelectionFlow, type FlowEngine } from "../providers/provider-model-selection-flow.js";
import {
  applyModelSwitchPrimaryRoute,
  resolveEffectiveSessionModelOverride,
  resolveModelSwitchRequest
} from "../providers/model-switch-resolver.js";
import { cronCommandNeedsRuntimeControlValidation, cronCommandNeedsWorkdirValidation, runCronCommand } from "../cron/cron-command.js";
import { createRuntimeCronRunner, tickCron } from "../cron/cron-runner.js";
import { createIsolatedCronRuntime, type CronRuntimeFactory } from "../cron/cron-runtime-factory.js";
import { availableToolsetsFromTools } from "../cron/cron-runtime-validation.js";
import { CronStore } from "../cron/cron-store.js";
import { WorkspaceTrustStore } from "../security/workspace-trust-store.js";
import { storeCapabilitySecret, type SetupNeededMetadata } from "../capabilities/capability-setup.js";
import { defaultImageModel } from "../contracts/image-generation.js";
import type { Prompt, PromptOptions } from "./prompt-contract.js";
import { createInteractivePrompt } from "./create-interactive-prompt.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import { buildToolsMenuViewModel, buildSkillsMenuViewModel } from "./slash-menu.js";
import { renderSessionHelp, buildSessionHelpViewModel } from "./session-help.js";
import { commandRegistry } from "./command-registry.js";
import { toolDisplayIcon, toolDisplayLabel } from "../ui/tool-display.js";
import {
  ToolActivityViewModelBuilder,
  buildSecurityAuditViewModel,
  buildSetupNeededViewModel,
} from "./tool-activity-view-models.js";
import { papyrusApprovalPromptAdapter, type ApprovalPromptAdapter } from "./approval-prompt-adapter.js";
import {
  buildActiveTurnSpinnerViewModel,
  buildAssistantResponseViewModel,
  buildKeyValueBlockViewModel,
  buildStartupDashboardViewModel,
  buildUserPromptRailViewModel,
  buildToolActivityRailViewModel,
} from "../ui/view-models/builders.js";
import { createSessionRenderer, type SessionRenderer } from "./session-renderer.js";
import type { ResolvedTokens } from "../contracts/ui-tokens.js";
import type { StartupDashboardViewModel, StatusViewModel, ViewModel } from "../contracts/view-model.js";
import type { TerminalCapabilities } from "../contracts/ui.js";
import {
  createSubmittedSteerTranscriptBlock,
  ActiveWorkRuntimeEventMapper,
  formatPlainDelegationProgressEvent,
  createOperatorConsoleRuntimeHost,
  createOperatorConsoleStyle,
  mapStartupDashboardViewModelToOperatorConsoleState,
  renderContextCompactionSurface,
  renderContextCompactionStatusSurface,
  renderCompletedActiveWorkSurface,
  renderOperatorConsoleLines,
  routeSteerKey,
  type ContextCompactionStatusSurfaceState,
  type ContextCompactionSurfaceState,
  type OperatorConsoleStyle,
  type OperatorConsoleRuntimeHost,
  type QueuedSteerState,
  type SteerState,
  type TurnActivityState,
} from "../ui/papyrus/operator-console/index.js";
import type { ParsedKeypress } from "../ui/input/parseKeypress.js";
import { createKeypressStreamDispatcher } from "../ui/input/keyPressStreamDispatcher.js";
import { createTerminalLifecycle } from "../ui/input/terminalLifecycle.js";
import { centerVisibleBlock, measureVisibleWidth, truncateVisible } from "../ui/renderers/layout.js";
import { chromeCopy } from "../ui/cli-ui-copy.js";
import { resolveShellHistoryMode } from "./shell-history-mode.js";
import { resolveClipboardMode } from "./clipboard-mode.js";
import { resolveMcpSuggestionsMode } from "./mcp-suggestions-mode.js";
import { resolveSkillSuggestionsMode } from "./skill-suggestions-mode.js";
import { resolveInputKeymapMode } from "./input-keymap-mode.js";
import { promptUiContextForLocale } from "../contracts/ui.js";
import { resolveHomeDir } from "../config/home-dir.js";
import { resolveGlobalStateHome, resolveProfileStateHome } from "../config/profile-home.js";
import { loadRuntimeConfig, saveRuntimeConfig } from "../config/runtime-config.js";
import { getPackageVersion } from "./version-command.js";
import {
  playCliTtsResponse,
  readCliVoiceMode,
  recordAndTranscribeCliVoice,
  type CliVoiceEnvironmentOptions,
  type CliVoiceRecorder,
  type CliVoiceMode
} from "./voice-mode.js";
import { createFilePasteReferenceStore } from "./paste-interceptor.js";
import { detectTaskBackgroundHost, executeTaskCommand } from "./task-commands.js";
import { summarizeProviderExecution } from "../runtime/provider-execution-summary.js";
import { LiveOperatorConsoleController } from "./live-operator-console-controller.js";
import {
  configuredModelForRuntime,
  elapsedSeconds,
  modelContextWindow,
  operatorConsoleStatusRailState,
  providerServingStateFromSummary,
  providerServingTransitionAlert,
  sessionStatusRailViewModel,
  type ContextUsageSnapshot,
  type ProviderRouteServingState,
  type StatusRailTiming,
} from "./session-status-rail.js";
import {
  isSetupConsoleExit,
  withSetupConsolePrompt,
  type SetupConsolePromptAdapterOptions,
} from "../setup/config-editor/setupConsolePromptAdapter.js";
import { runConfigEditor } from "../setup/config-editor/runner.js";
import { createReviewedSetupApplyExecutor } from "../setup/review/apply-executor.js";
import { buildProvidersStatusViewModel } from "./provider-status-view-models.js";
import { selectProviderModelRoute } from "../setup/provider-model-route-prompt.js";
import { isMemoryCurationModeMutation, runMemoryOperatorCommand } from "../memory/memory-operator-commands.js";
import type { SessionFinalizationReason } from "../session/session-finalization-queue.js";
import type { TaskStatusProjection } from "../workflow/task-operator-service.js";
import type { PendingTaskApproval } from "../workflow/task-approval-service.js";
import type { ApprovalIntent } from "../ui/papyrus/operator-console/approvalSurface.js";
import type {
  ApprovalCardState,
  TaskCardState
} from "../ui/papyrus/operator-console/operatorConsoleState.js";
import type { SessionCostSummary, TurnUsageSummary, UsageCostSummary } from "../contracts/usage-cost.js";
import { mergeUsageCostSummaries, unavailableUsageCostSummary } from "../providers/provider-usage-projection.js";
import { formatUsageCost, formatUsageCostNotice } from "../ui/usage-cost-format.js";
import { isolateLtr, isolateRtl } from "../ui/bidi.js";

export type SessionLoopOptions = {
  runtime: Runtime;
  refreshRuntime?: (options?: { preserveSession?: boolean }) => Promise<Runtime>;
  switchRuntime?: (sessionId: string) => Promise<Runtime>;
  modelSwitchContext?: () => Promise<ModelSwitchContext>;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  prompt?: Prompt;
  close?: () => void;
  now?: () => number;
  workspaceRoot?: string;
  homeDir?: string;
  cronRuntimeFactory?: CronRuntimeFactory;
  locale?: import("../contracts/ui.js").UiLocale;
  showResponseProgress?: boolean;
  capabilities?: TerminalCapabilities;
  env?: Record<string, string | undefined>;
  approvalPromptAdapter?: ApprovalPromptAdapter;
  operatorConsole?: {
    readonly enabled?: boolean;
    readonly runtimeHost?: OperatorConsoleRuntimeHost;
  };
  taskApprovals?: {
    listPending(authorizedSessionId: string): readonly PendingTaskApproval[];
    resolve(input: {
      approvalId: string;
      authorizedSessionId: string;
      decision: "approved" | "denied";
    }): Promise<void>;
  };
  cliVoice?: {
    recorder?: CliVoiceRecorder;
    envOptions?: CliVoiceEnvironmentOptions;
    playbackCommandExists?: (command: string) => Promise<boolean>;
  };
};

const OPERATOR_CONSOLE_FALLBACK_TERMINAL_HEIGHT = 24;
const OPERATOR_CONSOLE_TASK_REFRESH_INTERVAL_MS = 750;
const SESSION_COST_REFRESH_INTERVAL_MS = 750;
const COMPACTION_PROMPT_PLACEHOLDER = "Compacting session history... Ctrl+C to cancel";

type StatusRailTimerMode = "idle" | "active-turn" | "last-turn";

type SubmittedCliInput = {
  text: string;
  displayText?: string;
  echoedPromptPrefix: string;
  echoedText: string;
  clearSubmittedPrompt: boolean;
};

type SessionCompactionResultRenderer = (
  result: CompactResult,
  options?: { readonly focusTopic?: string }
) => string;

type SessionCompactionStatusRenderer = (
  status: ContextCompactionStatusSurfaceState
) => string;

async function buildSessionStartupViewModel(runtime: Runtime): Promise<ViewModel> {
  const legacyStartup = runtime.getStartup();

  try {
    const [readiness, packageVersion] = await Promise.all([
      runtime.getStartupReadiness(),
      getPackageVersion(),
    ]);
    const version = packageVersion === "unknown" ? packageVersion : `v${packageVersion}`;
    return buildStartupDashboardViewModel({
      agentName: legacyStartup.agentName,
      taglines: legacyStartup.taglines,
      version,
      sessionId: runtime.sessionId,
      model: readiness.model,
      workspaceTrust: readiness.workspaceTrust,
      workspaceVerification: readiness.workspaceVerification,
      workspaceDirectory: readiness.workspaceDirectory,
      securityMode: readiness.securityMode ?? "unknown",
      skillAutonomy: readiness.skillAutonomy,
      providerReadiness: readiness.providerReadiness,
      versionStatus: readiness.versionStatus,
      availableCommands: [],
      warnings: [...legacyStartup.warnings, ...readiness.warnings],
    });
  } catch {
    return legacyStartup;
  }
}

function formatStartupScreenText(input: {
  viewModel: ViewModel;
  rendered: string;
  capabilities: TerminalCapabilities;
}): string {
  if (
    input.viewModel.kind !== "startupDashboard" ||
    !input.capabilities.isTTY ||
    input.capabilities.isCI ||
    input.capabilities.isDumb ||
    !input.capabilities.supportsColor
  ) {
    return input.rendered;
  }

  return `\x1b[2J\x1b[H${centerVisibleBlock(input.rendered, input.capabilities.terminalWidth)}`;
}

function renderStartupScreenText(input: {
  viewModel: ViewModel;
  rendered: string;
  capabilities: TerminalCapabilities;
  operatorConsoleRuntimeHost?: OperatorConsoleRuntimeHost;
  contextUsage?: ContextUsageSnapshot;
  style?: OperatorConsoleStyle;
}): string {
  if (!canRenderStartupThroughOperatorConsole(input)) {
    return formatStartupScreenText({
      viewModel: input.viewModel,
      rendered: input.rendered,
      capabilities: input.capabilities,
    });
  }

  const startupText = renderOperatorConsoleStartupDashboard({
    viewModel: input.viewModel,
    contextUsage: input.contextUsage,
    capabilities: input.capabilities,
    operatorConsoleRuntimeHost: input.operatorConsoleRuntimeHost,
    style: input.style,
  });
  return `\x1b[2J\x1b[H${startupText}`;
}

function canRenderStartupThroughOperatorConsole(input: {
  viewModel: ViewModel;
  capabilities: TerminalCapabilities;
  operatorConsoleRuntimeHost?: OperatorConsoleRuntimeHost;
  style?: OperatorConsoleStyle;
}): input is {
  viewModel: StartupDashboardViewModel;
  capabilities: TerminalCapabilities;
  operatorConsoleRuntimeHost: OperatorConsoleRuntimeHost;
  style?: OperatorConsoleStyle;
} {
  return input.operatorConsoleRuntimeHost !== undefined &&
    input.viewModel.kind === "startupDashboard" &&
    input.capabilities.isTTY &&
    !input.capabilities.isCI &&
    !input.capabilities.isDumb &&
    input.capabilities.supportsColor;
}

function renderOperatorConsoleStartupDashboard(input: {
  viewModel: StartupDashboardViewModel;
  contextUsage?: ContextUsageSnapshot;
  capabilities: TerminalCapabilities;
  operatorConsoleRuntimeHost: OperatorConsoleRuntimeHost;
  style?: OperatorConsoleStyle;
}): string {
  const host = input.operatorConsoleRuntimeHost;
  host.clear();
  host.setTerminal({
    width: input.capabilities.terminalWidth,
    height: 40,
    isTty: input.capabilities.isTTY,
  });
  host.setStyle(input.style);
  host.setStartupDashboard(mapStartupDashboardViewModelToOperatorConsoleState({
    viewModel: input.viewModel,
    contextUsage: input.contextUsage,
  }));
  const frame = host.render();
  const startupText = renderOperatorConsoleLines(frame.state, frame.layout)
    .filter((line) => line.region === "startupDashboard")
    .map((line) => line.text)
    .join("\n");
  host.clear();
  return startupText;
}

export async function runSessionLoop(options: SessionLoopOptions): Promise<void> {
  const output = options.output ?? defaultOutput;
  const renderer = createSessionRenderer({ output, locale: options.locale, capabilities: options.capabilities });
  const cliInput = (options.input as NodeJS.ReadStream | undefined) ?? defaultInput;
  const approvalPromptAdapter = options.approvalPromptAdapter ?? papyrusApprovalPromptAdapter;
  let runtime = options.runtime;
  const now = options.now ?? (() => Date.now());
  const sessionStartedAtMs = now();
  let activityBuilder = new ToolActivityViewModelBuilder({
    tools: runtime.tools()
  });
  let activeWorkEventMapper = new ActiveWorkRuntimeEventMapper({
    locale: renderer.locale === "ar" ? "ar" : "en",
  });
  let activeTurn: AbortController | undefined;
  let clearActiveTurnChrome: () => void = () => undefined;
  let activeTurnCancelMessage = "Cancelling current turn. Press Ctrl+C again or type /exit to leave.";
  const operatorConsoleEnabled = options.operatorConsole?.enabled === true
    && renderer.capabilities.isTTY
    && !renderer.capabilities.isCI
    && !renderer.capabilities.isDumb;
  const operatorConsoleStyle = createOperatorConsoleStyle({
    tokens: renderer.tokens,
    capabilities: renderer.capabilities,
  });
  const operatorConsoleRuntimeHost = operatorConsoleEnabled
    ? options.operatorConsole?.runtimeHost ?? createOperatorConsoleRuntimeHost({
      locale: renderer.locale === "ar" ? "ar" : "en",
      terminal: {
        width: renderer.capabilities.terminalWidth,
        height: operatorConsoleTerminalHeight(output),
        isTty: renderer.capabilities.isTTY,
      },
      style: operatorConsoleStyle,
    })
    : undefined;
  operatorConsoleRuntimeHost?.setStyle(operatorConsoleStyle);
  let latestContextUsage: ContextUsageSnapshot | undefined;
  let latestSessionCost: SessionCostSummary | undefined;
  let sessionCostRefresh: Promise<void> | undefined;
  let sessionCostRefreshedAtMs = Number.NEGATIVE_INFINITY;
  const refreshSessionCost = (force = false): Promise<void> => {
    if (sessionCostRefresh !== undefined) {
      return force ? sessionCostRefresh.then(() => refreshSessionCost(true)) : sessionCostRefresh;
    }
    const timestamp = Date.now();
    if (!force && timestamp - sessionCostRefreshedAtMs < SESSION_COST_REFRESH_INTERVAL_MS) {
      return Promise.resolve();
    }
    const targetRuntime = runtime;
    sessionCostRefresh = (async () => {
      try {
        const cost = await targetRuntime.currentSessionCost?.();
        if (runtime === targetRuntime) latestSessionCost = cost;
      } catch {
        if (runtime === targetRuntime) latestSessionCost = unavailableUsageCostSummary("session-cost-read-failed");
      }
    })().finally(() => {
      if (runtime === targetRuntime) sessionCostRefreshedAtMs = Date.now();
      sessionCostRefresh = undefined;
    });
    return sessionCostRefresh;
  };
  let timerMode: StatusRailTimerMode = "idle";
  let activeTurnStartedAtMs: number | undefined;
  let lastCompletedTurnSeconds: number | undefined;
  let pendingCompactionPostTokens: number | undefined;
  let lastProviderExecutionSummary: ProviderExecutionSummary | undefined;
  let providerServingState: ProviderRouteServingState | undefined;
  const railTiming = (): StatusRailTiming => ({
    now,
    sessionStartedAtMs,
    mode: timerMode,
    activeTurnStartedAtMs,
    lastCompletedTurnSeconds
  });
  const getOperatorConsoleStatus = () => {
    void refreshSessionCost();
    return operatorConsoleStatusRailState({
      runtime,
      renderer,
      contextUsage: latestContextUsage,
      sessionCost: latestSessionCost,
      timing: railTiming(),
      providerExecutionSummary: lastProviderExecutionSummary
    });
  };
  let cachedTaskRuntime: Runtime | undefined;
  let cachedTaskCards: readonly TaskCardState[] = [];
  let cachedTaskCardsAtMs = Number.NEGATIVE_INFINITY;
  const getOperatorConsoleTasks = () => {
    void refreshSessionCost();
    const timestamp = Date.now();
    if (cachedTaskRuntime === runtime && timestamp - cachedTaskCardsAtMs < OPERATOR_CONSOLE_TASK_REFRESH_INTERVAL_MS) {
      return cachedTaskCards;
    }
    cachedTaskRuntime = runtime;
    cachedTaskCardsAtMs = timestamp;
    cachedTaskCards = operatorConsoleTaskCards(runtime);
    return cachedTaskCards;
  };
  const getOperatorConsoleApprovals = (): readonly ApprovalCardState[] => {
    try {
      return (options.taskApprovals?.listPending(runtime.sessionId) ?? [])
        .map((approval) => taskApprovalToCard(approval, renderer.locale === "ar" ? "ar" : "en"));
    } catch {
      return [];
    }
  };
  const onOperatorConsoleApprovalIntent = async (intent: ApprovalIntent): Promise<void> => {
    if (intent.type !== "approve" && intent.type !== "reject") return;
    const taskApprovals = options.taskApprovals;
    if (taskApprovals === undefined) throw new Error("Interactive Task approvals are unavailable.");
    await taskApprovals.resolve({
      approvalId: intent.approvalId,
      authorizedSessionId: runtime.sessionId,
      decision: intent.type === "approve" ? "approved" : "denied"
    });
  };
  const prompt = options.prompt ?? createInteractivePrompt({
    input: cliInput,
    output: output as NodeJS.WriteStream,
    env: options.env,
    uiContext: promptUiContextForLocale(renderer.locale),
    useOperatorConsole: operatorConsoleEnabled,
    ...(operatorConsoleRuntimeHost === undefined
      ? {}
      : {
        operatorConsole: {
          enabled: true,
          locale: renderer.locale === "ar" ? "ar" : "en",
          terminal: {
            width: renderer.capabilities.terminalWidth,
            height: operatorConsoleTerminalHeight(output),
            isTty: renderer.capabilities.isTTY,
          },
          getStatus: getOperatorConsoleStatus,
          getTasks: getOperatorConsoleTasks,
          getApprovals: getOperatorConsoleApprovals,
          onApprovalIntent: onOperatorConsoleApprovalIntent,
          style: operatorConsoleStyle,
        },
      }),
  });
  const close = options.close ?? (() => prompt.close?.());
  const onSigint = () => {
    if (activeTurn !== undefined) {
      clearActiveTurnChrome();
      activeTurn.abort("SIGINT");
      output.write(`\n${activeTurnCancelMessage}\n`);
      return;
    }

    enqueueRuntimeFinalization(runtime, "sigint", output);
    output.write("\nEnding EstaCoda session.\n");
    close();
  };

  let stopIdleStatusTicker: () => void = () => undefined;
  process.on("SIGINT", onSigint);

  try {
    latestContextUsage = await initialContextUsageForRuntime(runtime);
    await refreshSessionCost(true);
    const resetTurnRailState = () => {
      timerMode = "idle";
      activeTurnStartedAtMs = undefined;
      lastCompletedTurnSeconds = undefined;
      pendingCompactionPostTokens = undefined;
    };
    const markContextUsageUnknown = () => {
      const total = modelContextWindow(runtime) ?? latestContextUsage?.total;
      latestContextUsage = total === undefined ? undefined : { total };
    };
    const applyCompactionRailReset = () => {
      resetTurnRailState();
      markContextUsageUnknown();
    };
    const startupVm = await buildSessionStartupViewModel(runtime);
    const renderedStartupText = renderer.render(startupVm);
    const startupText = renderStartupScreenText({
      viewModel: startupVm,
      rendered: renderedStartupText,
      capabilities: renderer.capabilities,
      operatorConsoleRuntimeHost,
      contextUsage: latestContextUsage,
      style: operatorConsoleStyle,
    });
    const promptPrefix = renderer.tokens.contract.branding.promptPrefix ?? `${renderer.tokens.contract.glyph.prompt} `;
    const useColor = renderer.capabilities.supportsColor && renderer.tokens.contract.behavior.allowAnsiColor;
    const useUnicode = renderer.capabilities.supportsUnicode;
    const termWidth = renderer.capabilities.terminalWidth;
    const managedTty = renderer.capabilities.isTTY && !renderer.capabilities.isCI && !renderer.capabilities.isDumb;
    let idleStatusTicker: ReturnType<typeof setInterval> | undefined;
    const writeSessionStatusRail = () => {
      if (!managedTty || operatorConsoleRuntimeHost !== undefined) return;
      void refreshSessionCost();
      output.write(`${renderer.render(sessionStatusRailViewModel({
        runtime,
        renderer,
        contextUsage: latestContextUsage,
        sessionCost: latestSessionCost,
        timing: railTiming(),
        providerExecutionSummary: lastProviderExecutionSummary
      }))}\n`);
    };
    stopIdleStatusTicker = () => {
      if (idleStatusTicker === undefined) return;
      clearInterval(idleStatusTicker);
      idleStatusTicker = undefined;
    };
    output.write(`${startupText}\n\n`);
    if (!managedTty) {
      output.write(`${chromeCopy(renderer.locale).startupPromptHint}\n\n`);
    }
    while (true) {
      const inputPlaceholder = managedTty
        ? promptInputPlaceholder(renderer, operatorConsoleEnabled ? "" : promptPrefix, useColor, termWidth)
        : undefined;
      let submittedInput: SubmittedCliInput;
      let turnVoiceMode: CliVoiceMode = "off";

      if (!operatorConsoleEnabled) {
        const topRule = renderHorizontalRule(renderer.tokens, useColor, useUnicode, termWidth);
        output.write(`${topRule}\n`);
        writeSessionStatusRail();
        if (managedTty && idleStatusTicker === undefined) {
          idleStatusTicker = setInterval(writeSessionStatusRail, 1000);
        }
      }

      turnVoiceMode = await currentCliVoiceMode({
        runtime,
        homeDir: options.homeDir
      });
      submittedInput = await readNextCliInput({
        voiceMode: turnVoiceMode,
        prompt,
        promptPrefix,
        renderer,
        useColor,
        runtime,
        output,
        homeDir: options.homeDir,
        workspaceRoot: options.workspaceRoot,
        cliVoice: options.cliVoice,
        inputPlaceholder,
      });
      stopIdleStatusTicker();

      const text = submittedInput.text;

      if (submittedInput.clearSubmittedPrompt === true) {
        if (!operatorConsoleEnabled) {
          const topRule = renderHorizontalRule(renderer.tokens, useColor, useUnicode, termWidth);
          output.write(`${topRule}\n`);
        }
      }

      if (text.length === 0) {
        continue;
      }

      if (text === "/exit") {
        enqueueRuntimeFinalization(runtime, "cli-exit", output);
        output.write("Ending EstaCoda session.\n");
        return;
      }

      if (text.startsWith("/")) {
        let slashLiveFrame: LiveOperatorConsoleController | undefined;
        let slashAbortController: AbortController | undefined;
        if (operatorConsoleRuntimeHost !== undefined && isCompactSlashCommand(text)) {
          slashAbortController = new AbortController();
          activeTurn = slashAbortController;
          activeTurnCancelMessage = "Cancelling compaction. Press Ctrl+C again or type /exit to leave.";
          slashLiveFrame = new LiveOperatorConsoleController({
            output,
            runtimeHost: operatorConsoleRuntimeHost,
            terminal: {
              width: termWidth,
              height: operatorConsoleTerminalHeight(output),
              isTty: renderer.capabilities.isTTY,
            },
            capabilities: {
              supportsAnimation: renderer.capabilities.supportsAnimation,
            },
            getStatus: getOperatorConsoleStatus,
            getTasks: getOperatorConsoleTasks,
            turnStartedAtMs: now(),
            promptPlaceholder: COMPACTION_PROMPT_PLACEHOLDER,
          });
          clearActiveTurnChrome = () => slashLiveFrame?.clear();
          slashLiveFrame.setTurnActivity({ phase: "background", backgroundKind: "compactingTranscript" });
        }
        const slashPrompt = operatorConsoleEnabled
          ? withSetupConsolePrompt(prompt, {
              input: cliInput as unknown as Readable,
              output: output as unknown as SetupConsolePromptAdapterOptions["output"],
              style: operatorConsoleStyle,
            })
          : prompt;
        let shouldExit: Awaited<ReturnType<typeof handleSlashCommand>>;
        try {
          shouldExit = await handleSlashCommand({
            text,
            runtime,
            output,
            renderer,
            refreshRuntime: options.refreshRuntime,
            switchRuntime: options.switchRuntime,
            modelSwitchContext: options.modelSwitchContext,
            prompt: slashPrompt,
            env: options.env,
            workspaceRoot: options.workspaceRoot,
            homeDir: options.homeDir,
            cronRuntimeFactory: options.cronRuntimeFactory,
            renderSessionCompactionResult: operatorConsoleEnabled
              ? (result, renderOptions) => renderPapyrusSessionCompactionResult(result, {
                  width: termWidth,
                  style: operatorConsoleStyle,
                  ...(renderOptions?.focusTopic === undefined ? {} : { focusTopic: renderOptions.focusTopic }),
                })
              : undefined,
            renderSessionCompactionStatus: operatorConsoleEnabled
              ? (status) => renderPapyrusSessionCompactionStatus(status, {
                  width: termWidth,
                  style: operatorConsoleStyle,
                })
              : undefined,
            ...(slashAbortController === undefined ? {} : { signal: slashAbortController.signal }),
            onBeforeSessionCompactionOutput: () => {
              slashLiveFrame?.clear();
              slashLiveFrame = undefined;
            },
            onSessionCompacted: () => applyCompactionRailReset()
          });
        } catch (error) {
          slashLiveFrame?.clear();
          if (isSetupConsoleExit(error)) {
            continue;
          }
          throw error;
        } finally {
          slashLiveFrame?.clear();
          if (activeTurn === slashAbortController) {
            activeTurn = undefined;
            activeTurnCancelMessage = "Cancelling current turn. Press Ctrl+C again or type /exit to leave.";
            clearActiveTurnChrome = () => undefined;
          }
        }

        if (typeof shouldExit !== "boolean") {
          await sessionCostRefresh;
          await runtime.dispose();
          runtime = shouldExit.runtime;
          latestContextUsage = await initialContextUsageForRuntime(runtime);
          latestSessionCost = undefined;
          sessionCostRefreshedAtMs = Number.NEGATIVE_INFINITY;
          await refreshSessionCost(true);
          lastProviderExecutionSummary = undefined;
          providerServingState = undefined;
          resetTurnRailState();
          activityBuilder = new ToolActivityViewModelBuilder({
            tools: runtime.tools()
          });
          activeWorkEventMapper = new ActiveWorkRuntimeEventMapper({
            locale: renderer.locale === "ar" ? "ar" : "en",
          });
          output.write(`${shouldExit.notice(runtime)}\n\n`);
          continue;
        }

        if (shouldExit) {
          return;
        }

        continue;
      }

      // Render submitted non-slash user prompts as lightweight transcript rails
      const userPromptRail = buildUserPromptRailViewModel({ text: submittedInput.displayText ?? text });
      const userPromptRailText = renderer.render(userPromptRail);
      output.write(`${userPromptRailText}\n`);

      let retryText: string | undefined = text;
      let wroteUserPromptRail = false;
      let pendingSteeringNote: string | undefined;
      let steeringRetryUsed = false;
      const mainAgentUsageParts: UsageCostSummary[] = [];
      const auxiliaryUsageParts: UsageCostSummary[] = [];
      const delegatedUsageParts: UsageCostSummary[] = [];
      const totalUsageParts: UsageCostSummary[] = [];
      const delegatedTaskStates = new Map<string, string | undefined>();
      while (retryText !== undefined) {
        activeTurn = new AbortController();
        activeTurnCancelMessage = "Cancelling current turn. Press Ctrl+C again or type /exit to leave.";
        const turnStartedAtMs = now();
        activeTurnStartedAtMs = turnStartedAtMs;
        lastCompletedTurnSeconds = undefined;
        timerMode = "active-turn";
        const streamState = { lastWriteEndedWithNewline: true };
        const turnOutput = { spinnerPhase: undefined as string | undefined, hasOutput: false, lastOutputWasSpinner: false };
        let operatorConsoleSteerState: SteerState | undefined;
        let operatorConsoleSteerSequence = 0;
        let disposeOperatorConsoleSteerInput: (() => void) | undefined;
        const operatorConsoleLiveFrame = operatorConsoleRuntimeHost === undefined
          ? undefined
          : new LiveOperatorConsoleController({
            output,
            runtimeHost: operatorConsoleRuntimeHost,
            terminal: {
              width: termWidth,
              height: operatorConsoleTerminalHeight(output),
              isTty: renderer.capabilities.isTTY,
            },
            capabilities: {
              supportsAnimation: renderer.capabilities.supportsAnimation,
            },
            getStatus: getOperatorConsoleStatus,
            getTasks: getOperatorConsoleTasks,
            turnStartedAtMs,
          });
        let turnWasCancelled = false;

        function clearOperatorConsoleLiveFrame(): void {
          operatorConsoleLiveFrame?.clear();
        }

        function refreshOperatorConsoleTransientSurface(): void {
          operatorConsoleLiveFrame?.refresh();
        }

        function setOperatorConsoleSteerState(state: SteerState | undefined): void {
          operatorConsoleSteerState = state;
          operatorConsoleLiveFrame?.setSteer(state);
        }

        function writeTurnBoundaryRows(rows: readonly string[], options: { readonly redrawLiveFrame?: boolean } = {}): void {
          if (rows.length === 0) return;
          const writeRows = () => {
            if (!streamState.lastWriteEndedWithNewline) {
              output.write("\n");
            }
            output.write(`${rows.join("\n")}\n`);
            streamState.lastWriteEndedWithNewline = true;
          };
          if (operatorConsoleLiveFrame === undefined) {
            writeRows();
            return;
          }
          operatorConsoleLiveFrame.withDurableWrite(writeRows, { redraw: options.redrawLiveFrame === true });
        }

        function isToolActivityRuntimeEvent(
          event: RuntimeEvent
        ): event is Extract<RuntimeEvent, { kind: "tool-start" | "tool-result" }> {
          return event.kind === "tool-start" || event.kind === "tool-result";
        }

        function createQueuedSteerState(text: string): QueuedSteerState {
          operatorConsoleSteerSequence += 1;
          return {
            id: `active-turn-steer-${turnStartedAtMs}-${operatorConsoleSteerSequence}`,
            text,
            status: "queued",
            submittedAtMs: now(),
          };
        }

        function writeSubmittedSteerTranscript(text: string): void {
          const block = createSubmittedSteerTranscriptBlock({
            id: `active-turn-steer-transcript-${turnStartedAtMs}-${operatorConsoleSteerSequence}`,
            text,
            createdAtMs: now(),
          });
          writeTurnBoundaryRows(block.text.split("\n"), { redrawLiveFrame: true });
        }

        function currentDraftSteerState(draft: string): SteerState {
          return {
            draft,
            cursorOffset: draft.length,
            mode: "drafting",
          };
        }

        function currentQueuedSteerState(queued: QueuedSteerState): SteerState {
          return {
            draft: "",
            cursorOffset: 0,
            mode: "queued",
            queued,
          };
        }

        function handleOperatorConsoleSteerKey(event: ParsedKeypress): void {
          if (event.type === "key" && event.ctrl === true && event.key === "c") {
            process.emit("SIGINT");
            return;
          }

          const current = operatorConsoleSteerState;
          const queued = current?.queued?.status === "queued" ? current.queued : undefined;

          if (event.type === "key" && event.key === "escape") {
            if (queued !== undefined) {
              pendingSteeringNote = undefined;
              setOperatorConsoleSteerState(undefined);
              return;
            }
            if (current?.mode === "drafting") {
              setOperatorConsoleSteerState(undefined);
            }
            return;
          }

          if (event.type === "key" && event.key === "backspace") {
            if (current?.mode !== "drafting") return;
            const nextDraft = current.draft.slice(0, -1);
            setOperatorConsoleSteerState(nextDraft.length === 0 ? undefined : currentDraftSteerState(nextDraft));
            return;
          }

          if (event.type === "key" && event.ctrl === true && event.key === "u") {
            if (current?.mode === "drafting") {
              setOperatorConsoleSteerState(undefined);
            }
            return;
          }

          if (event.type === "key" && event.key === "enter") {
            if (current === undefined) return;
            const intent = routeSteerKey(current, event);
            if (intent.type !== "submit") return;
            if (queued !== undefined || steeringRetryUsed || pendingSteeringNote !== undefined) {
              setOperatorConsoleSteerState(currentQueuedSteerState(queued ?? createQueuedSteerState(pendingSteeringNote ?? intent.text)));
              return;
            }
            const queuedSteer = createQueuedSteerState(intent.text);
            pendingSteeringNote = intent.text;
            setOperatorConsoleSteerState(currentQueuedSteerState(queuedSteer));
            writeSubmittedSteerTranscript(intent.text);
            activeTurn?.abort("CLI steer");
            return;
          }

          if (event.type !== "text" && event.type !== "paste") {
            return;
          }
          if (queued !== undefined) {
            setOperatorConsoleSteerState(currentQueuedSteerState(queued));
            return;
          }
          const nextDraft = `${current?.mode === "drafting" ? current.draft : ""}${event.text}`;
          setOperatorConsoleSteerState(currentDraftSteerState(nextDraft));
        }

        function startOperatorConsoleSteerInput(): (() => void) | undefined {
          if (
            operatorConsoleRuntimeHost === undefined ||
            cliInput.isTTY !== true ||
            renderer.capabilities.isCI ||
            renderer.capabilities.isDumb
          ) {
            return undefined;
          }

          const lifecycle = createTerminalLifecycle({
            stdin: cliInput,
            stdout: output as NodeJS.WriteStream,
            hideCursor: false,
          });
          const keypressDispatcher = createKeypressStreamDispatcher({
            onEvents: (events: readonly ParsedKeypress[]) => {
              for (const event of events) {
                handleOperatorConsoleSteerKey(event);
              }
            },
          });

          const onData = (chunk: string | Buffer | Uint8Array) => {
            keypressDispatcher.handle(chunk);
          };
          lifecycle.start();
          cliInput.on("data", onData);
          cliInput.resume();
          return () => {
            keypressDispatcher.dispose();
            cliInput.off("data", onData);
            lifecycle.stop();
          };
        }

        const renderSpinner = (phase: string) => {
          if (operatorConsoleLiveFrame !== undefined) {
            turnOutput.spinnerPhase = phase;
            operatorConsoleLiveFrame.setTurnActivity(operatorConsoleTurnActivityForPhase(phase));
            return;
          }
          if (turnOutput.spinnerPhase === phase) {
            return;
          }
          const spinnerText = renderer.render(buildActiveTurnSpinnerViewModel({ phase }));
          output.write(`${spinnerText}\n`);
          streamState.lastWriteEndedWithNewline = true;
          turnOutput.spinnerPhase = phase;
          turnOutput.hasOutput = true;
          turnOutput.lastOutputWasSpinner = false;
        };

        const clearSpinner = () => {
          operatorConsoleLiveFrame?.clearTurnActivity();
          clearOperatorConsoleLiveFrame();
          turnOutput.spinnerPhase = undefined;
          turnOutput.lastOutputWasSpinner = false;
        };
        clearActiveTurnChrome = clearSpinner;

        if (!wroteUserPromptRail) {
          output.write("\n");
          wroteUserPromptRail = true;
        }
        renderSpinner("thinking");

        disposeOperatorConsoleSteerInput = startOperatorConsoleSteerInput();
        const responsePromise = runtime.handle({
            text: retryText,
            channel: "cli",
            signal: activeTurn.signal,
            onDelta: operatorConsoleLiveFrame === undefined
              ? undefined
              : (delta) => {
                  operatorConsoleLiveFrame.appendStreamingText(delta);
                },
            onSegmentBreak: operatorConsoleLiveFrame === undefined
              ? undefined
              : (reason) => {
                  operatorConsoleLiveFrame.flushStreamingSegment(reason);
                },
	            onEvent: (event) => {
	              if (event.kind === "context-window-usage") {
	                latestContextUsage = { filled: event.usedTokens, total: event.totalTokens };
	                refreshOperatorConsoleTransientSurface();
	                writeSessionStatusRail();
	              }
	              if (event.kind === "session-compacted") {
                pendingCompactionPostTokens = event.postTokens;
	                markContextUsageUnknown();
	                refreshOperatorConsoleTransientSurface();
	                writeSessionStatusRail();
	              }
	              if (event.kind === "agent-cancelled") {
	                turnWasCancelled = true;
	                operatorConsoleLiveFrame?.resetStreaming();
	              }
	              if (operatorConsoleLiveFrame !== undefined && event.kind === "provider-result" && event.willFallback) {
	                operatorConsoleLiveFrame.resetStreaming();
	              }
              let newPhase: string | undefined;
              if (operatorConsoleLiveFrame !== undefined && event.kind === "delegation-progress") {
                operatorConsoleLiveFrame.applyActiveWorkEvent(activeWorkEventMapper.buildDelegationProgress(event));
                newPhase = "tool";
              } else if (operatorConsoleLiveFrame !== undefined && isToolActivityRuntimeEvent(event)) {
                const activeWorkEvent = activeWorkEventMapper.build(event);
                operatorConsoleLiveFrame.applyActiveWorkEvent(activeWorkEvent);
                newPhase = activeWorkEvent.toolName === "delegate_task" ? "tool" : "provider";
              } else if (operatorConsoleLiveFrame !== undefined) {
                  const operatorConsolePhase = operatorConsoleTransientPhaseForRuntimeEvent(event);
                  if (operatorConsolePhase === null) {
                    clearOperatorConsoleLiveFrame();
                    newPhase = renderRuntimeEvent(output, event, activityBuilder, renderer, streamState, undefined, turnOutput, renderer.locale === "ar" ? "ar" : "en");
                  } else {
                    newPhase = operatorConsolePhase;
                  }
	              } else {
	                newPhase = renderRuntimeEvent(output, event, activityBuilder, renderer, streamState, undefined, turnOutput, renderer.locale === "ar" ? "ar" : "en");
	              }
              if (newPhase !== undefined) {
                renderSpinner(newPhase);
              }
            }
          })
	          .finally(() => {
	            activeTurn = undefined;
	            activeTurnStartedAtMs = undefined;
	            disposeOperatorConsoleSteerInput?.();
	            disposeOperatorConsoleSteerInput = undefined;
	            operatorConsoleSteerState = undefined;
	            operatorConsoleLiveFrame?.setSteer(undefined);
	            clearSpinner();
	            clearActiveTurnChrome = () => undefined;
	          });
        const response = await responsePromise;
        if (response.turnUsage !== undefined) {
          mainAgentUsageParts.push(response.turnUsage.mainAgent);
          auxiliaryUsageParts.push(response.turnUsage.auxiliaryModels);
          delegatedUsageParts.push(response.turnUsage.delegatedWork);
          totalUsageParts.push(response.turnUsage.total);
        }
        recordDelegatedTaskStates(response.toolExecutions, delegatedTaskStates);
        const delegatedWorkActive = hasActiveDelegatedTask(delegatedTaskStates, runtime);
        const deliveredTurnUsage = combinedTurnUsage(
          response.turnUsage,
          mainAgentUsageParts,
          auxiliaryUsageParts,
          delegatedUsageParts,
          totalUsageParts,
          delegatedWorkActive
        );
        await refreshSessionCost(true);
        const willRetryForSteering = pendingSteeringNote !== undefined && !steeringRetryUsed;
        const completedActiveWork = operatorConsoleLiveFrame?.completeActiveWork();
        const completedCostRendered = completedActiveWork !== undefined && !willRetryForSteering;
        if (completedCostRendered && completedActiveWork !== undefined) {
          const completedRows = renderCompletedActiveWorkSurface(completedActiveWork, {
            width: termWidth,
            locale: renderer.locale,
            style: operatorConsoleStyle,
            turnUsage: deliveredTurnUsage,
          });
          writeTurnBoundaryRows(completedRows.length === 0 ? [] : completedRows);
          operatorConsoleLiveFrame?.resetActiveWork();
        }
        lastProviderExecutionSummary = response.providerExecution === undefined
          ? undefined
          : summarizeProviderExecution({
              configuredModel: configuredModelForRuntime(runtime),
              execution: response.providerExecution,
            });
	        if (pendingCompactionPostTokens !== undefined) {
	          resetTurnRailState();
	          pendingCompactionPostTokens = undefined;
	        } else {
	          lastCompletedTurnSeconds = elapsedSeconds(turnStartedAtMs, now());
	          timerMode = "last-turn";
	        }
	        writeSessionStatusRail();
	        if (willRetryForSteering && pendingSteeringNote !== undefined) {
	          operatorConsoleLiveFrame?.resetStreaming();
	          const steeringNote = pendingSteeringNote;
	          pendingSteeringNote = undefined;
	          steeringRetryUsed = true;
	          retryText = buildSteeredRetryText(text, steeringNote);
	          continue;
	        }

        const providerServingAlert = lastProviderExecutionSummary === undefined
          ? undefined
          : providerServingTransitionAlert(providerServingState, lastProviderExecutionSummary);
	        if (lastProviderExecutionSummary !== undefined) {
	          providerServingState = providerServingStateFromSummary(lastProviderExecutionSummary);
	        }
	        writeSessionStatusRail();

	        const hasVisibleStreamingOutput = operatorConsoleLiveFrame?.hasStreamingOutput() === true;
	        const assistantVm = buildAssistantResponseViewModel({
	          label: response.label,
          text: response.text,
          matchedSkills: response.matchedSkills,
	          progress: options.showResponseProgress === true ? response.progress : undefined,
	        });
	        if (hasVisibleStreamingOutput) {
	          clearOperatorConsoleLiveFrame();
	          operatorConsoleLiveFrame?.discardStreaming();
	        }
	        if (providerServingAlert !== undefined) {
	          output.write(`${providerServingAlert}\n`);
	        }
	        output.write(renderer.render(assistantVm));
        if (!completedCostRendered && deliveredTurnUsage !== undefined) {
          output.write(`\n${formatTurnCostLines(deliveredTurnUsage, renderer.locale === "ar" ? "ar" : "en").join("\n")}\n`);
        }
        for (const notice of delegatedTaskNotices(response.toolExecutions, runtime, renderer.locale === "ar" ? "ar" : "en")) {
          output.write(`${notice}\n`);
        }
        mainAgentUsageParts.length = 0;
        auxiliaryUsageParts.length = 0;
        delegatedUsageParts.length = 0;
        totalUsageParts.length = 0;
        delegatedTaskStates.clear();
        if (turnVoiceMode === "tts") {
          const playback = await playCliResponseIfEnabled({
            runtime,
            text: response.text,
            homeDir: options.homeDir,
            workspaceRoot: options.workspaceRoot,
            commandExists: options.cliVoice?.playbackCommandExists,
            signal: activeTurn?.signal
	          });
	          if (playback !== undefined && playback.played === false && playback.reason !== "empty-response") {
	            output.write(`\nCLI voice playback skipped: ${playback.reason}\n`);
	          } else if (playback !== undefined && playback.played === true) {
	            output.write(`\nCLI voice playback: ${playback.player}\n`);
	          }
	        }

        const setupResolution = await maybeHandleSetupNeeded({
          runtime,
          prompt,
	          output,
	          renderer,
	          homeDir: options.homeDir,
	          execution: response.toolExecutions.find(hasSetupNeededResult)
	        });

	        if (setupResolution.handled) {
	          output.write(`${setupResolution.message}\n\n`);
	          retryText = undefined;
	          continue;
	        }

        const approvalResolution = await maybeHandleApprovalGate({
          runtime,
	          prompt,
          input: cliInput,
	          output,
	          renderer,
	          approvalPromptAdapter,
	          locale: renderer.locale === "ar" ? "ar" : "en",
	          operatorConsoleHost: operatorConsoleRuntimeHost,
	          execution: response.toolExecutions.find((execution) => execution.decision === "ask")
        });

	        if (approvalResolution.retry === false) {
	          if (approvalResolution.message !== undefined) {
	            output.write(`${approvalResolution.message}\n`);
	          }
	          output.write("\n");
	          retryText = undefined;
	          continue;
	        }

	        output.write(`${approvalResolution.message}\n\n`);
	        retryText = text;
      }
    }
	  } finally {
	    process.removeListener("SIGINT", onSigint);
	    stopIdleStatusTicker();
	    await runtime.dispose();
	    close();
	  }
}

async function currentCliVoiceMode(input: {
  runtime: Runtime;
  homeDir?: string;
}): Promise<CliVoiceMode> {
  const profileId = await runtimeProfileId(input.runtime);
  const profilePaths = resolveProfileStateHome({ homeDir: resolveHomeDir(input.homeDir), profileId });
  return await readCliVoiceMode(profilePaths);
}

async function readNextCliInput(input: {
  voiceMode: CliVoiceMode;
  prompt: Prompt;
  promptPrefix: string;
  renderer: { tokens: ResolvedTokens };
  useColor: boolean;
  runtime: Runtime;
  output: NodeJS.WritableStream;
  homeDir?: string;
  workspaceRoot?: string;
  cliVoice?: SessionLoopOptions["cliVoice"];
  inputPlaceholder?: string;
  onPromptResolved?: () => void;
  onPromptRowsChange?: (rows: number) => void;
}): Promise<SubmittedCliInput> {
  if (input.voiceMode === "off") {
    const echoedPromptPrefix = colorPromptPrefix(input.promptPrefix, input.renderer.tokens, input.useColor);
    const profileId = await runtimeProfileId(input.runtime);
    const profilePaths = resolveProfileStateHome({ homeDir: resolveHomeDir(input.homeDir), profileId });
    const promptOptions: PromptOptions = {
      onRowsChange: input.onPromptRowsChange,
      placeholder: input.inputPlaceholder,
      pasteReferenceStore: createFilePasteReferenceStore({
        directory: join(profilePaths.tempPath, "pastes"),
      }),
    };
    const submission = input.prompt.submit === undefined
      ? { text: await input.prompt(echoedPromptPrefix, promptOptions) }
      : await input.prompt.submit(echoedPromptPrefix, promptOptions);
    input.onPromptResolved?.();
    const text = submission.text.trim();
    const displayText = (submission.displayText ?? submission.text).trim();
    return {
      text,
      ...(displayText === text ? {} : { displayText }),
      echoedPromptPrefix,
      echoedText: submission.text,
      clearSubmittedPrompt: text.length > 0
    };
  }

  const promptPrefix = `${input.promptPrefix}[voice:${input.voiceMode}] `;
  const echoedPromptPrefix = colorPromptPrefix(promptPrefix, input.renderer.tokens, input.useColor);
  const rawTyped = await input.prompt(echoedPromptPrefix, { onRowsChange: input.onPromptRowsChange });
  input.onPromptResolved?.();
  const typed = rawTyped.trim();
  if (typed.length > 0) {
    return {
      text: typed,
      echoedPromptPrefix,
      echoedText: rawTyped,
      clearSubmittedPrompt: true
    };
  }

  const profileId = await runtimeProfileId(input.runtime);
  const homeDir = resolveHomeDir(input.homeDir);
  const profilePaths = resolveProfileStateHome({ homeDir, profileId });
  const config = await loadRuntimeConfig({
    workspaceRoot: input.workspaceRoot ?? process.cwd(),
    homeDir,
    profileId
  });

  input.output.write("Recording CLI voice input...\n");
  const captured = await recordAndTranscribeCliVoice({
    config,
    profilePaths,
    recorder: input.cliVoice?.recorder,
    envOptions: input.cliVoice?.envOptions,
    transcriber: async ({ path, signal }) => {
      const result = input.runtime.transcribeAudio === undefined
        ? undefined
        : await input.runtime.transcribeAudio({ path, signal });
      if (result === undefined) {
        return { ok: false, content: "This runtime cannot transcribe CLI voice input." };
      }
      if (!result.ok) {
        return result;
      }
      return {
        ok: true,
        text: result.text,
        model: result.model,
        language: result.language
      };
    }
  });
  if (!captured.ok) {
    input.output.write(`CLI voice unavailable: ${captured.content}\n`);
    return {
      text: "",
      echoedPromptPrefix,
      echoedText: "",
      clearSubmittedPrompt: false
    };
  }

  input.output.write(`Transcript: ${captured.transcript}\n`);
  return {
    text: captured.transcript.trim(),
    echoedPromptPrefix,
    echoedText: "",
    clearSubmittedPrompt: false
  };
}

function buildSteeredRetryText(originalText: string, note: string): string {
  return `${originalText}\n\n[Steering note while previous turn was interrupted]\n${note}`;
}

function isCompactSlashCommand(text: string): boolean {
  const [command = ""] = text.slice(1).trim().split(/\s+/u);
  return commandRegistry.resolve(command)?.name === "compact";
}

async function playCliResponseIfEnabled(input: {
  runtime: Runtime;
  text: string;
  homeDir?: string;
  workspaceRoot?: string;
  commandExists?: (command: string) => Promise<boolean>;
  signal?: AbortSignal;
}): Promise<Extract<Awaited<ReturnType<typeof playCliTtsResponse>>, { ok: true }> | undefined> {
  const profileId = await runtimeProfileId(input.runtime);
  const homeDir = resolveHomeDir(input.homeDir);
  const profilePaths = resolveProfileStateHome({ homeDir, profileId });
  const pythonStateRoot = resolveGlobalStateHome({ homeDir }).stateRoot;
  const config = await loadRuntimeConfig({
    workspaceRoot: input.workspaceRoot ?? process.cwd(),
    homeDir,
    profileId
  });
  const result = await playCliTtsResponse({
    text: input.text,
    config,
    profilePaths,
    pythonStateRoot,
    commandExists: input.commandExists,
    signal: input.signal
  });
  if (!result.ok) {
    return { ok: true, played: false, reason: result.content };
  }
  return result;
}

export async function handleSlashCommand(input: {
  text: string;
  runtime: Runtime;
  refreshRuntime?: (options?: { preserveSession?: boolean }) => Promise<Runtime>;
  switchRuntime?: (sessionId: string) => Promise<Runtime>;
  modelSwitchContext?: () => Promise<ModelSwitchContext>;
  prompt?: Prompt;
  env?: Record<string, string | undefined>;
  output: NodeJS.WritableStream;
  renderer: {
    render(viewModel: import("../contracts/view-model.js").ViewModel): string;
    locale?: "en" | "ar";
    capabilities?: TerminalCapabilities;
    tokens?: ResolvedTokens;
  };
  workspaceRoot?: string;
  homeDir?: string;
  cronRuntimeFactory?: CronRuntimeFactory;
  renderSessionCompactionResult?: SessionCompactionResultRenderer;
  renderSessionCompactionStatus?: SessionCompactionStatusRenderer;
  signal?: AbortSignal;
  onBeforeSessionCompactionOutput?: () => void;
  onSessionCompacted?: (result: { readonly postTokens: number }) => void;
}): Promise<boolean | { runtime: Runtime; notice: (runtime: Runtime) => string }> {
  const [command = "", ...args] = input.text.slice(1).trim().split(/\s+/u);
  const resolved = commandRegistry.resolve(command);
  const canonical = resolved?.name ?? command;

  switch (canonical) {
    case "":
      input.output.write("Use /help to see available commands.\n\n");
      return false;
    case "help":
      input.output.write(`${input.renderer.render(buildSessionHelpViewModel())}\n\n`);
      return false;
    case "status":
      input.output.write(`${input.renderer.render(withOptionalPapyrusCapabilityDiagnostics(
        input.runtime.getStatus(),
        input.env
      ))}\n\n`);
      return false;
    case "model": {
      const modelCommand = parseSessionModelCommand(args);
      if (modelCommand.kind === "clear" && modelCommand.scope === "global") {
        input.output.write([
          "Clearing the global primary model is not supported from /model --global.",
          "Use estacoda model setup from a terminal to choose a new primary model.",
          ""
        ].join("\n"));
        return false;
      }

      if (modelCommand.kind === "clear") {
        await input.runtime.sessionDb.clearSessionModelOverride(input.runtime.sessionId);
        const refreshed = await refreshCurrentRuntime(input);
        if (refreshed === undefined) {
          input.output.write("Cleared the session model override.\nScope: session\nStart a new turn after refreshing the session to use the configured primary model.\n\n");
          return false;
        }
        return {
          runtime: refreshed,
          notice: (runtime) => [
            "Cleared the session model override.",
            "Scope: session",
            "The configured primary route is active again.",
            "",
            runtime.describe()
          ].join("\n")
        };
      }

      if (modelCommand.kind === "set") {
        const modelInput = modelCommand.modelInput;
        if (modelInput.trim().length === 0) {
          input.output.write(modelCommand.scope === "global"
            ? "Usage: /model --global <model-or-alias>\nAlso accepted: /model set --global <model-or-alias>\n\n"
            : "Usage: /model set <model-or-alias>\n\n");
          return false;
        }
        return modelCommand.scope === "global"
          ? handleGlobalModelSet(input, modelInput)
          : handleSessionModelSet(input, modelInput);
      }

      if (input.modelSwitchContext !== undefined) {
        const context = await input.modelSwitchContext();
        const stale = await resolveEffectiveSessionModelOverride(
          await input.runtime.sessionDb.getSessionModelOverride(input.runtime.sessionId),
          context
        );
        if (stale !== undefined && !stale.ok) {
          input.output.write(`Session model override ignored: ${stale.message}\n\n`);
        }
      }

      if (input.modelSwitchContext !== undefined && input.prompt?.select !== undefined) {
        const pickerResult = await handleSessionModelPicker(input);
        if (pickerResult !== undefined) {
          return pickerResult;
        }
      }

      input.output.write(`${input.renderer.render(input.runtime.getModelInfo())}\n\n`);
      return false;
    }
    case "providers":
      return handleProvidersCommand(input, args);
    case "new": {
      if (input.refreshRuntime === undefined) {
        input.output.write("This session cannot reset itself here. Start a new EstaCoda session to refresh skills and config.\n\n");
        return false;
      }

      const nextRuntime = await input.refreshRuntime({ preserveSession: false });
      enqueueRuntimeFinalization(input.runtime, "new-session", input.output);
      return {
        runtime: nextRuntime,
        notice: (runtime) => renderFreshSessionNotice(runtime, input.renderer)
      };
    }
    case "tools":
      input.output.write(`${input.renderer.render(buildToolsMenuViewModel(input.runtime, args.join(" ")))}\n\n`);
      return false;
    case "browser": {
      const result = await handleBrowserCommand(input, args);
      if (typeof result === "string") {
        input.output.write(`${result}\n\n`);
        return false;
      }
      return result;
    }
    case "memory":
      {
        const result = await runMemoryOperatorCommand({
          args,
          homeDir: input.homeDir,
          profileId: await runtimeProfileId(input.runtime),
          runtime: input.runtime,
          signal: input.signal
        });
        input.output.write(`${result.output}\n\n`);
        if (result.ok && isMemoryCurationModeMutation(args) && input.refreshRuntime !== undefined) {
          return {
            runtime: await input.refreshRuntime({ preserveSession: true }),
            notice: (runtime) => [
              "Memory curation mode refreshed for this session.",
              "",
              runtime.describe()
            ].join("\n")
          };
        }
      }
      return false;
    case "skills":
      input.output.write(`${input.renderer.render(buildSkillsMenuViewModel(input.runtime, args.join(" ")))}\n\n`);
      return false;
    case "reload-mcp":
      if (input.refreshRuntime === undefined) {
        input.output.write("This session cannot reload MCP configuration here.\n\n");
        return false;
      }

      return {
        runtime: await input.refreshRuntime({ preserveSession: true }),
        notice: (runtime) => {
          const snapshots = runtime.inspectMcpServers();
          const configured = snapshots.length;
          const ready = snapshots.filter((snapshot) => snapshot.available).length;
          return [
            "Reloaded MCP configuration for this session.",
            configured === 0
              ? "No MCP servers are configured."
              : `MCP servers ready: ${ready}/${configured}.`,
            "",
            runtime.describe()
          ].join("\n");
        }
      };
    case "resume":
      input.output.write(`${await renderLatestResume(input.runtime)}\n\n`);
      return false;
    case "approvals":
      input.output.write(`${await renderApprovalStatus(input.runtime)}\n\n`);
      return false;
    case "security":
      input.output.write(`${await renderSecurityAudit(input.runtime, {
        debug: args.includes("debug") || args.includes("--debug")
      }, input.renderer)}\n\n`);
      return false;
    case "yolo": {
      if (input.runtime.toggleYoloMode === undefined) {
        input.output.write("This session cannot toggle YOLO mode here.\n\n");
        return false;
      }
      const result = input.runtime.toggleYoloMode();
      input.output.write(result.enabled
        ? "⚡ YOLO mode ON — EstaCoda will auto-approve eligible actions for this session. Hard safety blocks still apply.\n\n"
        : `⚠ YOLO mode OFF — risky actions will use ${result.mode} approval mode.\n\n`);
      return false;
    }
    case "cron": {
      const store = new CronStore();
      const profileId = await runtimeProfileId(input.runtime);
      const runtimeConfig = cronCommandNeedsRuntimeControlValidation(args)
        ? await loadRuntimeConfig({
            workspaceRoot: input.workspaceRoot ?? process.cwd(),
            homeDir: input.homeDir,
            profileId
          })
        : undefined;
      const defaultWorkspaceRoot = input.workspaceRoot ?? process.cwd();
      const workdirControls = cronCommandNeedsWorkdirValidation(args)
        ? {
            defaultWorkspaceRoot,
            allowedRoots: [defaultWorkspaceRoot],
            isWorkspaceTrusted: (path: string) => new WorkspaceTrustStore({ homeDir: input.homeDir }).isTrusted(path)
          }
        : undefined;
      const result = await runCronCommand({
        args,
        store,
        runtimeControls: runtimeConfig === undefined
          ? undefined
          : {
              config: runtimeConfig,
              availableToolsets: () => availableToolsetsFromTools(input.runtime.tools())
            },
        workdirControls,
        tick: async () => {
          const trustStore = new WorkspaceTrustStore({ homeDir: input.homeDir });
          const results = await tickCron({
            store,
            runner: createRuntimeCronRunner({
              store,
              runtimeFactory: async (job, context) => createIsolatedCronRuntime({
                job,
                context,
                workspaceRoot: defaultWorkspaceRoot,
                homeDir: input.homeDir,
                profileId,
                sessionDb: input.runtime.sessionDb,
                createRuntime: input.cronRuntimeFactory
              }),
              wrapResponse: true,
              disposeRuntime: true,
              workspaceRoot: defaultWorkspaceRoot,
              allowedWorkdirRoots: [defaultWorkspaceRoot],
              isWorkspaceTrusted: (path) => trustStore.isTrusted(path)
            })
          });
          return results.length === 0
            ? "Cron tick complete. No due jobs."
            : [
                `Cron tick complete. Ran ${results.length} job(s).`,
                ...results.map((entry) => `${entry.job.id}: ${entry.ok ? "succeeded" : "failed"}`)
              ].join("\n");
        }
      });
      input.output.write(`${result.output}\n\n`);
      return false;
    }
    case "revoke": {
      const approvalId = args[0];
      if (approvalId === undefined || approvalId.length === 0) {
        input.output.write("Usage: /revoke <approval-id>\n\n");
        return false;
      }
      if (input.runtime.revokeApproval === undefined) {
        input.output.write("This session does not support persistent approval revocation here.\n\n");
        return false;
      }
      const revoked = await input.runtime.revokeApproval(approvalId);
      input.output.write(`${revoked ? `Revoked persistent approval ${approvalId}.` : `No persistent approval matched ${approvalId}.`}\n\n`);
      return false;
    }
    case "sessions":
      if (args[0] === "recall") {
        input.output.write(`${await renderSessionRecall(input.runtime, args.slice(1).join(" "))}\n\n`);
        return false;
      }
      input.output.write(`${await renderSessionList(input.runtime)}\n\n`);
      return false;
    case "search":
      input.output.write(`${await renderSessionSearch(input.runtime, args.join(" "))}\n\n`);
      return false;
    case "compact":
      {
        const result = await renderSessionCompaction(
          input.runtime,
          args.join(" "),
          input.renderSessionCompactionResult,
          input.renderSessionCompactionStatus,
          input.signal
        );
        if (result.didCompress && result.postTokens !== undefined) {
          input.onSessionCompacted?.({ postTokens: result.postTokens });
        }
        input.onBeforeSessionCompactionOutput?.();
        input.output.write(`${result.output}\n\n`);
      }
      return false;
    case "switch": {
      const target = args[0];
      if (target === undefined || target.length === 0) {
        input.output.write("Usage: /switch <session-id>\n\n");
        return false;
      }
      if (input.switchRuntime === undefined) {
        input.output.write("This session cannot switch sessions here.\n\n");
        return false;
      }
      const targetSession = await input.runtime.sessionDb.getSession(target);
      if (targetSession === undefined) {
        input.output.write(`Session not found: ${target}\n\n`);
        return false;
      }
      const activeProfileId = await runtimeProfileId(input.runtime);
      if (targetSession.profileId !== activeProfileId) {
        input.output.write(`Session not found in active profile: ${target}\n\n`);
        return false;
      }
      return {
        runtime: await input.switchRuntime(target),
        notice: (runtime) => [
          "Switched this session to an existing session.",
          `Session: ${runtime.sessionId}`,
          "",
          runtime.describe()
        ].join("\n")
      };
    }
    case "trust":
      await input.runtime.trustWorkspace();
      input.output.write("Workspace trusted. EstaCoda will proceed with normal local work here.\n\n");
      return false;
    case "untrust":
      await input.runtime.revokeWorkspaceTrust();
      input.output.write("Workspace trust revoked. EstaCoda will ask before workspace writes here.\n\n");
      return false;
    case "workspace.trust.status": {
      const trusted = await input.runtime.isWorkspaceTrusted();
      input.output.write(`Workspace trust: ${trusted ? "trusted" : "not trusted"}\n\n`);
      return false;
    }
    case "doctor":
      input.output.write(`${await renderRuntimeDoctor(input.runtime)}\n\n`);
      return false;
    case "task": {
      if (input.runtime.taskOperator === undefined) {
        input.output.write(input.renderer.locale === "ar"
          ? "أوامر المهام الدائمة غير متاحة في بيئة التشغيل هذه.\n\n"
          : "Durable Task commands are unavailable in this runtime.\n\n");
        return false;
      }
      const taskProfileId = await runtimeProfileId(input.runtime);
      const result = await executeTaskCommand({
        args,
        service: input.runtime.taskOperator,
        locale: input.renderer.locale === "ar" ? "ar" : "en",
        authorizedSessionId: input.runtime.sessionId,
        begin: input.runtime.beginTask === undefined
          ? undefined
          : async (objective, _creatorSessionId, executionPreference) => ({
              task: await input.runtime.beginTask!(objective, { executionPreference }),
              creatorSessionId: input.runtime.sessionId
            }),
        workspaceTrusted: async () => input.runtime.isWorkspaceTrusted(),
        backgroundHost: async () => detectTaskBackgroundHost({
          homeDir: input.homeDir,
          profileId: taskProfileId
        })
      });
      input.output.write(`${result.output}\n\n`);
      return false;
    }
    case "handoff": {
      const surface = args[0] ?? "telegram";
      if (surface !== "telegram") {
        input.output.write(`Unsupported surface: ${surface}. Currently only 'telegram' is supported.\n\n`);
        return false;
      }
      const { FileHandoffStore } = await import("../channels/handoff-store.js");
      const { join } = await import("node:path");
      const profileId = await runtimeProfileId(input.runtime);
      const profilePaths = resolveProfileStateHome({ homeDir: resolveHomeDir(input.homeDir), profileId });
      const store = new FileHandoffStore({ path: join(profilePaths.gatewayStatePath, "handoff-codes.json") });
      await input.runtime.auditMemoryCuration?.({
        trigger: "handoff",
        sessionId: input.runtime.sessionId
      }).catch(() => undefined);
      const handoff = await store.create({
        sessionId: input.runtime.sessionId,
        surfaceType: surface,
        ttlMinutes: 10
      });
      input.output.write([
        `Handoff code for Telegram: ${handoff.code}`,
        `Session: ${input.runtime.sessionId}`,
        `Expires: ${handoff.expiresAt}`,
        "",
        `To attach, send in Telegram: /attach ${handoff.code}`,
        ""
      ].join("\n"));
      return false;
    }
    case "clear":
      input.output.write("\x1Bc");
      return false;
    case "exit":
      enqueueRuntimeFinalization(input.runtime, "cli-exit", input.output);
      input.output.write("Ending EstaCoda session.\n");
      return true;
    default:
      input.output.write(`Unknown command: /${command}\nUse /help to see available commands.\n\n`);
      return false;
  }
}

function enqueueRuntimeFinalization(
  runtime: Runtime,
  reason: SessionFinalizationReason,
  output: Pick<NodeJS.WritableStream, "write">
): void {
  try {
    const enqueue = runtime.enqueueSessionFinalization;
    if (enqueue !== undefined && enqueue(reason) === undefined) {
      output.write("Warning: background memory finalization could not be queued.\n");
    }
  } catch {
    output.write("Warning: background memory finalization could not be queued.\n");
  }
}

function withOptionalPapyrusCapabilityDiagnostics(
  status: StatusViewModel,
  env?: Record<string, string | undefined>
): StatusViewModel {
  const optionalCapabilities = buildKeyValueBlockViewModel({
    title: "Papyrus optional capabilities",
    entries: [
      { key: "shell history suggestions", value: resolveShellHistoryMode({ env }) },
      { key: "clipboard reads", value: resolveClipboardMode({ env }) },
      { key: "MCP resource suggestions", value: resolveMcpSuggestionsMode({ env }) },
      { key: "skill suggestions", value: resolveSkillSuggestionsMode({ env }) },
      { key: "Vim keymap", value: resolveInputKeymapMode({ env }) === "vim" ? "on" : "off" },
    ],
  });

  return {
    ...status,
    sections: [...(status.sections ?? []), optionalCapabilities],
  };
}

type HandleSlashCommandInput = Parameters<typeof handleSlashCommand>[0];
type SlashCommandRuntimeRefresh = Exclude<Awaited<ReturnType<typeof handleSlashCommand>>, boolean>;

type ProvidersCommand =
  | { readonly kind: "status" }
  | { readonly kind: "setup"; readonly scope: "all" | "local" | "custom" }
  | { readonly kind: "invalid"; readonly message: string };

function parseProvidersCommand(args: string[]): ProvidersCommand {
  const normalized = args.map((arg) => arg.toLowerCase());
  if (normalized.length === 0) {
    return { kind: "status" };
  }
  if (
    normalized.length === 1 &&
    (normalized[0] === "local" || normalized[0] === "setup")
  ) {
    return { kind: "setup", scope: normalized[0] === "local" ? "local" : "all" };
  }
  if (
    normalized.length === 2 &&
    ((normalized[0] === "local" && normalized[1] === "setup") ||
      (normalized[0] === "setup" && normalized[1] === "local"))
  ) {
    return { kind: "setup", scope: "local" };
  }
  if (
    normalized[0] === "custom" ||
    (normalized[0] === "setup" && normalized[1] === "custom")
  ) {
    return { kind: "setup", scope: "custom" };
  }
  return {
    kind: "invalid",
    message: "Usage: /providers [local setup|custom add]"
  };
}

async function handleProvidersCommand(
  input: HandleSlashCommandInput,
  args: string[]
): Promise<boolean | SlashCommandRuntimeRefresh> {
  const command = parseProvidersCommand(args);
  if (command.kind === "invalid") {
    input.output.write(`${command.message}\n\n`);
    return false;
  }

  const workspaceRoot = input.workspaceRoot ?? process.cwd();
  const profileId = await runtimeProfileId(input.runtime);

  if (command.kind === "status") {
    const loaded = await loadRuntimeConfig({
      workspaceRoot,
      homeDir: input.homeDir,
      profileId,
    });
    input.output.write(`${input.renderer.render(await buildProvidersStatusViewModel(
      loaded,
      loaded.ui.language
    ))}\n\n`);
    return false;
  }

  if (input.prompt === undefined) {
    input.output.write([
      "This session cannot open reviewed provider setup here.",
      "Run estacoda setup --advanced from a terminal, or use /providers in an interactive session.",
      ""
    ].join("\n"));
    return false;
  }

  const flowEngine = command.scope === "local"
    ? await createProvidersCommandFlowEngine(input, profileId, ["local"])
    : undefined;
  const defaultActionId = command.scope === "custom"
    ? "add-custom-provider-route"
    : "edit-primary-model-route";

  const result = await runConfigEditor({
    workspaceRoot,
    homeDir: input.homeDir,
    profileId,
    prompt: input.prompt,
    output: {
      write: (value) => input.output.write(value),
    },
    applyExecutor: createReviewedSetupApplyExecutor({
      workspaceRoot,
      homeDir: input.homeDir,
      profileId,
      mode: "strict",
    }),
    defaultActionId,
    renderInitialOverview: false,
    ...(flowEngine === undefined ? {} : { flowEngine }),
  });

  if (!shouldRefreshAfterProvidersSetup(result.applyEndState)) {
    return false;
  }

  await input.runtime.sessionDb.appendEvent(input.runtime.sessionId, {
    kind: "context-window-usage-invalidated",
    reason: "model-change"
  });

  const refreshed = await refreshCurrentRuntime(input);
  if (refreshed === undefined) {
    input.output.write("Provider setup was applied. Start a new session before the next turn uses the updated provider route.\n\n");
    return false;
  }

  return {
    runtime: refreshed,
    notice: (runtime) => [
      "Provider setup applied.",
      "The session config snapshot was refreshed.",
      "",
      runtime.describe()
    ].join("\n")
  };
}

async function createProvidersCommandFlowEngine(
  input: HandleSlashCommandInput,
  profileId: string,
  providerIds: readonly ProviderId[]
): Promise<FlowEngine> {
  const loaded = await loadRuntimeConfig({
    workspaceRoot: input.workspaceRoot ?? process.cwd(),
    homeDir: input.homeDir,
    profileId,
  });
  const flow = await createProviderModelSelectionFlow({
    config: loaded.config,
    providerRegistry: loaded.providerRegistry,
    homeDir: input.homeDir,
    profileId,
    allowNetwork: false,
    mode: "setup",
  });
  const allowed = new Set(providerIds);
  return {
    listProviderCandidates: async () =>
      (await flow.listProviderCandidates()).filter((candidate) => allowed.has(candidate.id)),
    listModelCandidates: (providerId) => flow.listModelCandidates(providerId),
    resolveSelection: (providerId, modelId) => flow.resolveSelection(providerId, modelId),
  };
}

function shouldRefreshAfterProvidersSetup(
  applyEndState: Awaited<ReturnType<typeof runConfigEditor>>["applyEndState"]
): boolean {
  return applyEndState !== undefined &&
    applyEndState.kind !== "blocked" &&
    applyEndState.kind !== "cancelled";
}

type SessionModelCommand =
  | { kind: "show"; scope: "session" | "global" }
  | { kind: "set"; scope: "session" | "global"; modelInput: string }
  | { kind: "clear"; scope: "session" | "global" };

function parseSessionModelCommand(args: string[]): SessionModelCommand {
  const scope = args.includes("--global") ? "global" : "session";
  const normalized = args.filter((arg) => arg !== "--global");
  const subcommand = normalized[0];

  if (subcommand === undefined) {
    return { kind: "show", scope };
  }
  if (subcommand === "clear") {
    return { kind: "clear", scope };
  }
  if (subcommand === "set") {
    return { kind: "set", scope, modelInput: normalized.slice(1).join(" ") };
  }
  return { kind: "set", scope, modelInput: normalized.join(" ") };
}

async function handleSessionModelSet(
  input: HandleSlashCommandInput,
  modelInput: string
): Promise<boolean | SlashCommandRuntimeRefresh> {
  if (input.modelSwitchContext === undefined) {
    input.output.write("This session cannot change model overrides here.\n\n");
    return false;
  }

  const context = await input.modelSwitchContext();
  const resolution = await resolveModelSwitchRequest({
    modelInput,
    source: "cli"
  }, context);

  if (!resolution.ok) {
    input.output.write(`${resolution.message}\n${resolution.guidance}\n\n`);
    return false;
  }

  await input.runtime.sessionDb.setSessionModelOverride(input.runtime.sessionId, resolution.override);
  const refreshed = await refreshCurrentRuntime(input);
  if (refreshed === undefined) {
    input.output.write(`Session model override set: ${resolution.displayName}\nScope: session\nRefresh this session before the next turn uses the override.\n\n`);
    return false;
  }

  return {
    runtime: refreshed,
    notice: () => renderSessionModelOverrideNotice(input, resolution.displayName)
  };
}

async function handleGlobalModelSet(
  input: HandleSlashCommandInput,
  modelInput: string
): Promise<boolean | SlashCommandRuntimeRefresh> {
  if (input.modelSwitchContext === undefined) {
    input.output.write("This session cannot change global model config here.\n\n");
    return false;
  }

  const context = await input.modelSwitchContext();
  const resolution = await resolveModelSwitchRequest({
    modelInput,
    source: "cli"
  }, context);

  if (!resolution.ok) {
    input.output.write(`${resolution.message}\n${resolution.guidance}\n\n`);
    return false;
  }

  const trusted = typeof input.runtime.isWorkspaceTrusted === "function"
    ? await input.runtime.isWorkspaceTrusted()
    : false;
  if (!trusted) {
    input.output.write([
      "Global model changes require a trusted workspace/profile.",
      `Run estacoda model setup ${resolution.route.provider} from a terminal, or trust this workspace before using /model --global.`,
      ""
    ].join("\n"));
    return false;
  }

  const profileId = await runtimeProfileId(input.runtime);
  const targetPath = resolveProfileStateHome({
    homeDir: resolveHomeDir(input.homeDir),
    profileId
  }).configPath;
  const mutated = applyModelSwitchPrimaryRoute(context.config, resolution.route);
  await saveRuntimeConfig(targetPath, mutated);
  await input.runtime.sessionDb.clearSessionModelOverride(input.runtime.sessionId);

  const refreshed = await refreshCurrentRuntime(input);
  if (refreshed === undefined) {
    input.output.write(`Global primary model set: ${resolution.displayName}\nScope: global\nFallback routes unchanged.\nRefresh this session before the next turn uses the new primary route.\n\n`);
    return false;
  }

  return {
    runtime: refreshed,
    notice: (runtime) => [
      `Global primary model set: ${resolution.displayName}`,
      "Scope: global",
      "Fallback routes unchanged.",
      "",
      runtime.describe()
    ].join("\n")
  };
}

async function handleSessionModelPicker(
  input: HandleSlashCommandInput
): Promise<boolean | SlashCommandRuntimeRefresh | undefined> {
  if (input.modelSwitchContext === undefined || input.prompt?.select === undefined) {
    return undefined;
  }

  const context = await input.modelSwitchContext();
  const flow = await createProviderModelSelectionFlow({
    config: context.config,
    providerRegistry: context.providerRegistry,
    homeDir: context.homeDir,
    profileId: context.profileId,
    modelsDevOptions: context.modelsDevOptions,
    allowNetwork: false,
    mode: "normal"
  });

  const readyProviders = await flow.listProviderCandidates();
  const cachedFlow: FlowEngine = {
    ...flow,
    listProviderCandidates: async () => readyProviders,
  };
  const currentRoute = runtimeModelRoute(input.runtime);
  const routeSelection = await selectProviderModelRoute({
    prompt: input.prompt,
    flowEngine: cachedFlow,
    locale: context.config.ui?.language === "ar" ? "ar" : "en",
    currentProviderId: currentRoute?.provider,
    currentModelId: currentRoute?.model,
    allowCancel: true,
    mode: "session",
    openAiCodexChoice: readyProviders.some((candidate) => candidate.id === "codex"),
  });

  if (routeSelection.kind === "cancel" || routeSelection.kind === "back") {
    input.output.write("No changes were made.\n\n");
    return false;
  }
  if (routeSelection.kind === "diagnostic") {
    input.output.write(`${routeSelection.output}\n\n`);
    return false;
  }

  return handleSessionModelSet(input, `${routeSelection.selection.provider}/${routeSelection.selection.model}`);
}

function runtimeModelRoute(runtime: Runtime): { readonly provider: string; readonly model: string } | undefined {
  const entries = runtime.getModelInfo().entries;
  const provider = entries.find((entry) => entry.key === "provider")?.value;
  const model = entries.find((entry) => entry.key === "model")?.value;
  return provider === undefined || model === undefined
    ? undefined
    : { provider: String(provider), model: String(model) };
}

async function refreshCurrentRuntime(input: HandleSlashCommandInput): Promise<Runtime | undefined> {
  if (input.switchRuntime !== undefined) {
    return input.switchRuntime(input.runtime.sessionId);
  }
  return input.refreshRuntime?.({ preserveSession: true });
}

function renderSessionModelOverrideNotice(input: HandleSlashCommandInput, displayName: string): string {
  const formatLabel = createNoticeLabelFormatter(input.renderer.capabilities);
  return [
    `${formatLabel("Session model override set:")} ${displayName}`,
    `${formatLabel("Scope:")} session`,
    formatLabel("Fallback routes unchanged.")
  ].join("\n");
}

function createNoticeLabelFormatter(
  capabilities: TerminalCapabilities | undefined
): (value: string) => string {
  const supportsStyledNotice = capabilities !== undefined &&
    capabilities.isTTY &&
    capabilities.supportsColor &&
    !capabilities.isCI &&
    !capabilities.isDumb;
  if (!supportsStyledNotice) return (value) => value;
  return (value) => `\u001b[1m${value}\u001b[22m`;
}

async function renderSecurityAudit(
  runtime: Runtime,
  options: { debug: boolean },
  renderer: { render(viewModel: import("../contracts/view-model.js").ViewModel): string }
): Promise<string> {
  const events = await runtime.sessionDb.listEvents(runtime.sessionId);
  const securityEvents = events
    .filter((event): event is Extract<SessionEvent, { kind: "security-assessed" }> => event.kind === "security-assessed")
    .slice(-8)
    .reverse();

  const vm = buildSecurityAuditViewModel({ events: securityEvents, debug: options.debug });
  return renderer.render(vm);
}

async function maybeHandleApprovalGate(input: {
  runtime: Runtime;
  prompt: (question: string) => Promise<string>;
  output: NodeJS.WritableStream;
  input?: NodeJS.ReadStream;
  renderer: { render(viewModel: import("../contracts/view-model.js").ViewModel): string };
  approvalPromptAdapter: ApprovalPromptAdapter;
  locale?: import("../ui/tool-display.js").ToolDisplayLocale;
  operatorConsoleHost?: OperatorConsoleRuntimeHost;
  execution: ToolExecutionRecord | undefined;
}): Promise<{
  retry: boolean;
  message?: string;
}> {
  const execution = input.execution;
  if (execution === undefined || input.runtime.grantApproval === undefined) {
    return {
      retry: false
    };
  }

  while (true) {
    const allowPersistentApproval = input.runtime.revokeApproval !== undefined;
    const answer = normalizeApprovalPromptAnswer(
      await input.approvalPromptAdapter({
        prompt: input.prompt,
        input: input.input,
        output: input.output,
        renderer: input.renderer,
        execution,
        allowPersistentApproval,
        locale: input.locale,
        operatorConsoleHost: input.operatorConsoleHost,
      })
    );
    if (answer?.kind === "deny") {
      return {
        retry: false,
        message: "Permission denied."
      };
    }

    if (answer?.kind !== "approve") {
      input.output.write("Enter one of: once, session, always, deny.\n\n");
      continue;
    }

    const scope = answer.scope;
    await input.runtime.grantApproval({
      toolName: execution.tool.name,
      riskClass: execution.riskClass,
      targetKey: execution.targetKey,
      targetSummary: execution.targetSummary,
      scope
    });

    return {
      retry: true,
      message: scope === "always"
        ? "Approval granted (persistent for this workspace). Retrying now."
        : `Approval granted (${scope}). Retrying now.`
    };
  }
}

async function maybeHandleSetupNeeded(input: {
  runtime: Runtime;
  prompt: Prompt;
  output: NodeJS.WritableStream;
  renderer: { render(viewModel: import("../contracts/view-model.js").ViewModel): string };
  homeDir?: string;
  execution: ToolExecutionRecord | undefined;
}): Promise<{
  handled: boolean;
  message: string;
}> {
  const execution = input.execution;
  const setup = setupNeededMetadata(execution?.result);
  if (execution === undefined || setup === undefined) {
    return {
      handled: false,
      message: ""
    };
  }

  if (setup.capability !== "image_generation" || execution.tool.name !== "image.generate") {
    const vm = buildSetupNeededViewModel({
      capability: setup.capability,
      provider: setup.provider,
      model: typeof setup.model === "string" ? setup.model : undefined,
      requiredSecret: setup.requiredSecret,
    });
    return {
      handled: true,
      message: input.renderer.render(vm)
    };
  }

  const provider = setup.provider === "byteplus" || setup.provider === "openai" || setup.provider === "fal"
    ? setup.provider
    : "fal";
  const model = typeof setup.model === "string" && setup.model.length > 0
    ? setup.model
    : defaultImageModel(provider);
  const requiredSecret = setup.requiredSecret;

  const vm = buildSetupNeededViewModel({
    capability: "image_generation",
    provider,
    model,
    requiredSecret,
  });

  const secret = await (async () => {
    input.output.write(input.renderer.render(vm));
    input.output.write("\n\n");
    return await input.prompt(`Paste ${requiredSecret} (or type cancel): `, { secret: true });
  })();
  if (secret.trim().length === 0 || ["cancel", "c", "no", "n"].includes(secret.trim().toLowerCase())) {
    return {
      handled: true,
      message: "Image setup cancelled. The original image request was not retried."
    };
  }

  const stored = await storeCapabilitySecret({
    homeDir: input.homeDir,
    envName: requiredSecret,
    secret
  });
  const setupExecution = await input.runtime.executeTool?.({
    tool: "config.image.setup",
    toolInput: {
      provider,
      model,
      apiKeyEnv: stored.envName
    }
  });
  if (setupExecution?.result?.ok !== true) {
    return {
      handled: true,
      message: [
        "Image setup could not be saved.",
        setupExecution?.result?.content ?? "No setup result was returned.",
        "The original image request was not retried."
      ].join("\n")
    };
  }

  const verification = await input.runtime.verifyImageGeneration?.();
  if (verification?.ok !== true) {
    return {
      handled: true,
      message: [
        "Image setup was saved, but verification did not pass.",
        verification?.message ?? "Image verification is unavailable in this runtime.",
        "The original image request was not retried."
      ].join("\n")
    };
  }

  await (async () => {
    input.output.write("Image setup verified. Resuming the original image request...\n");
    await renderManualToolExecution(input.output, input.runtime, {
      tool: execution.tool.name,
      toolInput: execution.input ?? {}
    });
  })();

  return {
    handled: true,
    message: "Image generation resumed after setup."
  };
}

async function renderManualToolExecution(
  output: NodeJS.WritableStream,
  runtime: Runtime,
  input: {
    tool: string;
    toolInput: Record<string, unknown>;
  }
): Promise<void> {
  const toolLabel = toolDisplayLabel(input.tool);
  output.write(`${toolDisplayIcon(input.tool, "cli")} calling ${toolLabel}\n`);
  const execution = await runtime.executeTool?.(input);
  if (execution === undefined) {
    output.write(`${toolDisplayIcon(input.tool, "cli")} ${toolLabel} unavailable\n`);
    return;
  }

  output.write(`${toolDisplayIcon(input.tool, "cli")} ${toolLabel} ${execution.result?.ok === true ? "done" : "failed"}\n`);
  if (execution.result?.content !== undefined && execution.result.content.length > 0) {
    output.write(`${execution.result.content}\n`);
  }
}

function hasSetupNeededResult(execution: ToolExecutionRecord): boolean {
  return setupNeededMetadata(execution.result) !== undefined;
}

function setupNeededMetadata(result: ToolResult | undefined): SetupNeededMetadata | undefined {
  const metadata = result?.metadata;
  if (metadata?.kind !== "setup_needed") {
    return undefined;
  }
  if (typeof metadata.capability !== "string" || typeof metadata.requiredSecret !== "string") {
    return undefined;
  }
  return metadata as SetupNeededMetadata;
}

function normalizeApprovalPromptAnswer(value: string):
  | { kind: "approve"; scope: "once" | "session" | "always" }
  | { kind: "deny" }
  | undefined {
  const answer = value.trim().toLowerCase().replace(/\s+/gu, " ");
  if (answer === "deny" || answer === "reject" || answer === "no" || answer === "n" || answer === "/deny") {
    return { kind: "deny" };
  }

  const slashApprove = answer.match(/^\/approve(?: (.+))?$/u);
  if (slashApprove !== null) {
    const scope = normalizeApprovalScope(slashApprove[1] ?? "");
    return scope === undefined ? undefined : { kind: "approve", scope };
  }

  const scope = normalizeApprovalScope(answer);
  return scope === undefined ? undefined : { kind: "approve", scope };
}

function normalizeApprovalScope(value: string): "once" | "session" | "always" | undefined {
  if (value === "once" || value === "1") return "once";
  if (value === "session" || value === "2") return "session";
  if (value === "always" || value === "persist" || value === "3") return "always";
  return undefined;
}

async function renderApprovalStatus(runtime: Runtime): Promise<string> {
  const approvals = await runtime.inspectApprovals?.();
  if (approvals === undefined) {
    return "This session does not expose approval state here.";
  }

  return [
    "Approval status",
    "",
    "Session approvals:",
    ...(approvals.session.length === 0
      ? ["none"]
      : approvals.session.map((grant, index) =>
          `${index + 1}. scope=${grant.scope} tool=${grant.toolName} risk=${grant.riskClass}${grant.targetSummary === undefined ? "" : ` target=${grant.targetSummary}`}`
        )),
    "",
    "Persistent approvals:",
    ...(approvals.persistent.length === 0
      ? ["none"]
      : approvals.persistent.map((grant, index) =>
          `${index + 1}. [${grant.id}] tool=${grant.toolName} risk=${grant.riskClass}${grant.targetSummary === undefined ? "" : ` target=${grant.targetSummary}`}`
        )),
    "",
    "Use /revoke <approval-id> to remove a persistent approval."
  ].join("\n");
}

async function renderRuntimeDoctor(runtime: Runtime): Promise<string> {
  const trusted = await runtime.isWorkspaceTrusted();
  const tools = runtime.tools();

  return [
    "EstaCoda session doctor",
    `Session: ${runtime.sessionId}`,
    `Workspace trust: ${trusted ? "trusted" : "not trusted"}`,
    `Tools available: ${tools.length}`,
    `Has web tools: ${tools.some((tool) => tool.toolsets.includes("web")) ? "yes" : "no"}`,
    `Has file tools: ${tools.some((tool) => tool.toolsets.includes("files")) ? "yes" : "no"}`,
    `Has process tools: ${tools.some((tool) => tool.toolsets.includes("shell-write")) ? "yes" : "no"}`,
    trusted ? "Status: ready for proactive local work" : "Status: trust this workspace with /trust for proactive local work"
  ].join("\n");
}

async function handleBrowserCommand(input: {
  runtime: Runtime;
  refreshRuntime?: (options?: { preserveSession?: boolean }) => Promise<Runtime>;
}, args: string[]): Promise<string | { runtime: Runtime; notice: (runtime: Runtime) => string }> {
  const [subcommand = "status", value] = args;

  if (subcommand === "status") {
    const execution = await input.runtime.executeTool?.({
      tool: "browser.status",
      toolInput: {}
    });
    return execution?.result?.content ?? "Browser status is not available in this session.";
  }

  if (subcommand === "connect") {
    const cdpUrl = value ?? "http://127.0.0.1:9222";
    const execution = await input.runtime.executeTool?.({
      tool: "config.browser.setup",
      toolInput: {
        backend: "local-cdp",
        cdpUrl
      }
    });
    if (execution?.result?.ok !== true) {
      return execution?.result?.content ?? "Could not configure local CDP browser backend.";
    }
    if (input.refreshRuntime === undefined) {
      return `${execution.result.content}\nRestart this EstaCoda session to use the new browser backend.`;
    }
    return {
      runtime: await input.refreshRuntime({ preserveSession: true }),
      notice: (runtime) => [
        `Connected browser backend to ${cdpUrl}.`,
        "Refreshed this session so browser tools use the new CDP endpoint.",
        "",
        runtime.describe()
      ].join("\n")
    };
  }

  if (subcommand === "disconnect") {
    const execution = await input.runtime.executeTool?.({
      tool: "config.browser.setup",
      toolInput: {
        backend: "unconfigured"
      }
    });
    if (execution?.result?.ok !== true) {
      return execution?.result?.content ?? "Could not disconnect browser backend.";
    }
    if (input.refreshRuntime === undefined) {
      return `${execution.result.content}\nRestart this EstaCoda session to use the updated browser backend.`;
    }
    return {
      runtime: await input.refreshRuntime({ preserveSession: true }),
      notice: (runtime) => [
        "Disconnected browser backend for this profile.",
        "",
        runtime.describe()
      ].join("\n")
    };
  }

  return [
    "EstaCoda browser",
    "  /browser status",
    "  /browser connect",
    "  /browser connect http://127.0.0.1:9222",
    "  /browser disconnect"
  ].join("\n");
}

async function renderLatestResume(runtime: Runtime): Promise<string> {
  const resumeNote = await runtime.latestResumeNote();

  return resumeNote === undefined
    ? "No interrupted turn is available to resume."
    : [
        "Latest interrupted turn",
        resumeNote
      ].join("\n");
}

async function renderSessionList(runtime: Runtime): Promise<string> {
  const profileId = await runtimeProfileId(runtime);
  const sessions = (await runtime.sessionDb.listSessions(profileId)).slice(0, 10);
  if (sessions.length === 0) {
    return "No sessions found.";
  }

  return [
    "Recent sessions",
    ...sessions.map((session, index) =>
      `${index + 1}. ${session.id}${session.id === runtime.sessionId ? " (active)" : ""}${session.updatedAt ? ` — updated ${session.updatedAt}` : ""}`
    )
  ].join("\n");
}

async function renderSessionSearch(runtime: Runtime, query: string): Promise<string> {
  const normalizedQuery = query.trim();
  if (normalizedQuery.length === 0) {
    return "Usage: /search <query>";
  }

  const profileId = await runtimeProfileId(runtime);
  const matches = await runtime.sessionDb.search(normalizedQuery, {
    profileId,
    limit: 5
  });
  if (matches.length === 0) {
    return `No matching session history for "${normalizedQuery}".`;
  }

  return [
    `Search results for "${normalizedQuery}"`,
    ...matches.map((result, index) =>
      `${index + 1}. [${result.session.id}] ${result.message.role}: ${truncateSingleLine(result.message.content, 100)}`
    )
  ].join("\n");
}

async function renderSessionRecall(runtime: Runtime, query: string): Promise<string> {
  const normalizedQuery = query.trim();
  if (normalizedQuery.length === 0) {
    return "Usage: /session recall <query>";
  }
  if (runtime.recallSession === undefined) {
    return "Session recall is not available in this runtime.";
  }

  return renderSessionRecallResult(await runtime.recallSession(normalizedQuery));
}

async function renderSessionCompaction(
  runtime: Runtime,
  focusTopic: string,
  renderResult: SessionCompactionResultRenderer = renderLegacySessionCompactionResult,
  renderStatus: SessionCompactionStatusRenderer = renderLegacySessionCompactionStatus,
  signal?: AbortSignal
): Promise<{ readonly output: string; readonly didCompress: boolean; readonly postTokens?: number }> {
  const topic = focusTopic.trim();
  if (runtime.compactSession === undefined) {
    return { output: renderStatus({ kind: "unavailable" }), didCompress: false };
  }

  try {
    const normalizedTopic = topic.length === 0 ? undefined : topic;
    const result = await runtime.compactSession({
      focusTopic: normalizedTopic,
      preserveTranscript: false,
      ...(signal === undefined ? {} : { signal })
    });
    return {
      output: renderResult(result, { focusTopic: normalizedTopic }),
      didCompress: result.didCompress,
      postTokens: result.diagnostics.postTokens
    };
  } catch (error) {
    if (isCompactionAbort(error, signal)) {
      return {
        output: renderStatus({ kind: "cancelled" }),
        didCompress: false
      };
    }
    return {
      output: renderStatus({
        kind: "failed",
        detail: formatUnknownError(error)
      }),
      didCompress: false
    };
  }
}

function renderLegacySessionCompactionStatus(status: ContextCompactionStatusSurfaceState): string {
  if (status.kind === "unavailable") {
    return "Session compaction is not available in this runtime.";
  }
  if (status.kind === "cancelled") {
    return "Session compaction cancelled.";
  }
  return `Session compaction failed: ${status.detail ?? "unknown error"}`;
}

function renderPapyrusSessionCompactionResult(
  result: CompactResult,
  options: {
    readonly focusTopic?: string;
    readonly width: number;
    readonly style?: OperatorConsoleStyle;
  }
): string {
  return renderContextCompactionSurface(compactResultToContextCompactionSurfaceState(
    result,
    options.focusTopic === undefined ? {} : { focusTopic: options.focusTopic }
  ), {
    width: options.width,
    style: options.style,
  }).join("\n");
}

function renderPapyrusSessionCompactionStatus(
  status: ContextCompactionStatusSurfaceState,
  options: {
    readonly width: number;
    readonly style?: OperatorConsoleStyle;
  }
): string {
  return renderContextCompactionStatusSurface(status, {
    width: options.width,
    style: options.style,
  }).join("\n");
}

function compactResultToContextCompactionSurfaceState(
  result: CompactResult,
  options: { readonly focusTopic?: string } = {}
): ContextCompactionSurfaceState {
  return {
    didCompress: result.didCompress,
    tone: result.diagnostics.fallbackUsed ? "warning" : "brand",
    messagesBefore: result.diagnostics.sourceMessageCount,
    messagesAfter: result.messages.length,
    tokensBefore: result.diagnostics.preTokens,
    tokensAfter: result.diagnostics.postTokens,
    savedTokens: Math.max(0, Math.round(result.diagnostics.estimatedSavingsTokens)),
    savingsPercent: Math.max(0, Math.round(result.diagnostics.estimatedSavingsRatio * 100)),
    omittedToolResults: Math.max(0, Math.round(result.diagnostics.prunedToolResults)),
    warningCount: compactionWarningCount(result),
    skippedReason: result.diagnostics.reason,
    ...(options.focusTopic === undefined ? {} : { focusTopic: options.focusTopic }),
    ...(result.rotated ? { activeSessionId: result.activeSessionId } : {}),
  };
}

function compactionWarningCount(result: CompactResult): number {
  const warnings = new Set<string>([
    ...(result.diagnostics.fallbackUsed ? ["fallback-summary-used"] : []),
    ...result.diagnostics.warnings,
    ...result.diagnostics.eventWarnings,
  ]);
  return warnings.size;
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isCompactionAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted === true) return true;
  if (error instanceof Error && error.name === "AbortError") return true;
  const message = formatUnknownError(error).trim().toLowerCase();
  return message === "sigint"
    || message.includes("aborted")
    || message.includes("cancelled")
    || message.includes("canceled");
}

async function runtimeProfileId(runtime: Runtime): Promise<string> {
  return (await runtime.sessionDb.getSession(runtime.sessionId))?.profileId ?? "default";
}

export function renderRuntimeEvent(
  output: NodeJS.WritableStream,
  event: RuntimeEvent,
  activityBuilder: ToolActivityViewModelBuilder,
  renderer: { render(viewModel: import("../contracts/view-model.js").ViewModel): string },
  streamState: { lastWriteEndedWithNewline: boolean },
  _legacyChrome: unknown,
  turnOutput: { spinnerPhase?: string; hasOutput: boolean; lastOutputWasSpinner: boolean },
  locale: "en" | "ar" = "en"
): string | undefined {
  function safeWrite(text: string): void {
    const endsWithNewline = text.endsWith("\n");
    // If the last write didn't end with a newline and this write doesn't
    // start with one, we need to create a boundary to avoid interleaving
    // into an active provider-token stream.
    if (!streamState.lastWriteEndedWithNewline && !text.startsWith("\n")) {
      output.write("\n");
    }
    output.write(text);
    streamState.lastWriteEndedWithNewline = endsWithNewline;
    if (text.length > 0) {
      turnOutput.hasOutput = true;
      turnOutput.lastOutputWasSpinner = false;
    }
  }

  function clearActiveSpinnerLine(): void {
    if (turnOutput.spinnerPhase !== undefined && turnOutput.lastOutputWasSpinner) {
      output.write(`\x1b[1A\x1b[2K\r`);
    }
    turnOutput.spinnerPhase = undefined;
    turnOutput.lastOutputWasSpinner = false;
  }

  switch (event.kind) {
    case "agent-start":
      return "thinking";
    case "intent":
      return "routing";
    case "skill":
      safeWrite(`\u2625 skill: ${event.name}\n`);
      return undefined;
    case "tool-start": {
      clearActiveSpinnerLine();
      const railEvent = activityBuilder.buildToolActivityRailEvent(event);
      const railVm = buildToolActivityRailViewModel({ events: [railEvent] });
      safeWrite(`${renderer.render(railVm)}\n`);
      return "tool";
    }
    case "tool-result": {
      clearActiveSpinnerLine();
      const railEvent = activityBuilder.buildToolActivityRailEvent(event);
      const railVm = buildToolActivityRailViewModel({ events: [railEvent] });
      safeWrite(`${renderer.render(railVm)}\n`);
      if (event.fileChangePreview !== undefined) {
        safeWrite(`${renderer.render(event.fileChangePreview)}\n`);
      }
      return "tool";
    }
    case "provider-attempt":
      return "provider";
    case "provider-token": {
      // Provider tokens stream directly; never inject newlines here.
      output.write(event.text);
      if (event.text.length > 0) {
        turnOutput.hasOutput = true;
        turnOutput.lastOutputWasSpinner = false;
      }
      streamState.lastWriteEndedWithNewline = event.text.endsWith("\n");
      return "provider";
    }
    case "provider-tool-call":
      return "tool";
    case "provider-result":
      return event.ok || !event.willFallback ? "finalizing" : "provider";
    case "provider-budget-exhausted":
      clearActiveSpinnerLine();
      safeWrite(`\nprovider budget: ${event.reason}\n`);
      return undefined;
    case "context-estimate":
    case "context-window-usage":
      return undefined;
    case "session-compacted":
      return undefined;
    case "delegation-progress": {
      const line = formatPlainDelegationProgressEvent(event, locale);
      if (line !== undefined) {
        clearActiveSpinnerLine();
        safeWrite(`${line}\n`);
      }
      return "tool";
    }
    case "agent-cancelled":
      clearActiveSpinnerLine();
      safeWrite(`\ncancelled: ${event.reason}\n`);
      return undefined;
    case "agent-final":
      return undefined;
  }
}

function operatorConsoleTransientPhaseForRuntimeEvent(event: RuntimeEvent): string | undefined | null {
  switch (event.kind) {
    case "agent-start":
      return "thinking";
    case "intent":
      return "routing";
    case "provider-attempt":
    case "provider-token":
      return "provider";
    case "provider-tool-call":
    case "delegation-progress":
      return "tool";
    case "provider-result":
      return event.ok || !event.willFallback ? "finalizing" : "provider";
    case "context-estimate":
    case "context-window-usage":
      return undefined;
    case "session-compacted":
      return "background";
    case "agent-final":
      return undefined;
    default:
      return null;
  }
}

function operatorConsoleTurnActivityForPhase(phase: string): TurnActivityState | undefined {
  switch (phase) {
    case "thinking":
    case "routing":
    case "provider":
    case "finalizing":
      return { phase };
    case "background":
      return { phase: "background", backgroundKind: "compactingTranscript" };
    case "tool":
      return undefined;
    default:
      return undefined;
  }
}

function truncateSingleLine(value: string, maxLength: number): string {
  const singleLine = value.replace(/\s+/gu, " ").trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }

  return `${singleLine.slice(0, Math.max(0, maxLength - 1))}…`;
}

function combinedTurnUsage(
  current: TurnUsageSummary | undefined,
  mainAgentParts: readonly UsageCostSummary[],
  auxiliaryParts: readonly UsageCostSummary[],
  delegatedParts: readonly UsageCostSummary[],
  totalParts: readonly UsageCostSummary[],
  provisional: boolean
): TurnUsageSummary | undefined {
  if (mainAgentParts.length === 0 || totalParts.length === 0) return undefined;
  return {
    turnId: current?.turnId ?? "combined-turn",
    mainAgent: mergeUsageCostSummaries(mainAgentParts),
    auxiliaryModels: mergeUsageCostSummaries(auxiliaryParts),
    delegatedWork: mergeUsageCostSummaries(delegatedParts),
    total: mergeUsageCostSummaries(totalParts),
    provisional
  };
}

function formatTurnCostLines(usage: TurnUsageSummary, locale: "en" | "ar"): readonly string[] {
  const suffix = usage.provisional ? copyForLocale(locale, " so far", " حتى الآن") : "";
  const pricingNotice = formatUsageCostNotice(usage.total, { locale });
  return [
    `${copyForLocale(locale, "Main agent", "الوكيل الرئيسي")}: ${formatUsageCost(usage.mainAgent, { locale })}`,
    `${copyForLocale(locale, "Auxiliary models", "النماذج المساعدة")}: ${formatUsageCost(usage.auxiliaryModels, { locale })}`,
    `${copyForLocale(locale, "Delegated work", "العمل المفوض")}${suffix}: ${formatUsageCost(usage.delegatedWork, { locale })}`,
    `${copyForLocale(locale, "Turn total", "إجمالي الدور")}${suffix}: ${formatUsageCost(usage.total, { locale })}`,
    ...(pricingNotice === undefined ? [] : [pricingNotice]),
    ...(usage.provisional ? [copyForLocale(locale, "Workers still running", "لا يزال العمال قيد التنفيذ")] : [])
  ];
}

function copyForLocale(locale: "en" | "ar", english: string, arabic: string): string {
  return locale === "ar" ? arabic : english;
}

function recordDelegatedTaskStates(
  executions: readonly ToolExecutionRecord[],
  taskStates: Map<string, string | undefined>
): void {
  for (const execution of executions) {
    if (execution.tool.name !== "delegate_task" || execution.result?.ok !== true) continue;
    const taskId = execution.result.metadata?.taskId;
    if (typeof taskId !== "string" || taskId.length === 0) continue;
    const status = execution.result.metadata?.status;
    taskStates.set(taskId, typeof status === "string" ? status : undefined);
  }
}

function hasActiveDelegatedTask(
  taskStates: ReadonlyMap<string, string | undefined>,
  runtime: Runtime
): boolean {
  for (const [taskId, recordedStatus] of taskStates) {
    if (runtime.taskOperator === undefined) {
      if (recordedStatus === undefined || !["completed", "partial", "failed", "cancelled"].includes(recordedStatus)) {
        return true;
      }
      continue;
    }
    try {
      const status = runtime.taskOperator.status(taskId, runtime.sessionId).status;
      if (!["completed", "partial", "failed", "cancelled"].includes(status)) return true;
    } catch {
      return true;
    }
  }
  return false;
}

function delegatedTaskNotices(
  executions: readonly ToolExecutionRecord[],
  runtime: Runtime,
  locale: "en" | "ar"
): readonly string[] {
  const notices: string[] = [];
  const seen = new Set<string>();
  for (const execution of executions) {
    if (execution.tool.name !== "delegate_task" || execution.result?.ok !== true) continue;
    const taskId = execution.result.metadata?.taskId;
    if (typeof taskId !== "string" || taskId.length === 0 || seen.has(taskId)) continue;
    seen.add(taskId);
    const metadataStatus = execution.result.metadata?.status;
    let status = typeof metadataStatus === "string" ? metadataStatus : "queued";
    try {
      status = runtime.taskOperator?.status(taskId, runtime.sessionId).status ?? status;
    } catch {
      // The durable handle is still valid when its retained card has not refreshed yet.
    }
    notices.push(locale === "ar"
      ? isolateRtl(`مهمة مفوضة ${isolateLtr(taskId)} · ${localizedTaskStatus(status, "ar")}`)
      : `Delegated Task ${taskId} · ${status}`);
  }
  return notices;
}

function localizedTaskStatus(status: string, locale: "en" | "ar"): string {
  if (locale === "en") return status;
  switch (status) {
    case "queued": return "قيد الانتظار";
    case "running": return "قيد التنفيذ";
    case "completed": return "مكتملة";
    case "partial": return "مكتملة جزئياً";
    case "failed": return "فشلت";
    case "cancelled": return "ملغاة";
    case "paused": return "متوقفة مؤقتاً";
    case "waiting-for-approval": return "بانتظار الموافقة";
    default: return isolateLtr(status);
  }
}

async function initialContextUsageForRuntime(runtime: Runtime): Promise<ContextUsageSnapshot | undefined> {
  const actual = await runtime.currentContextWindowUsage?.();
  return actual === undefined
    ? unknownContextUsageForRuntime(runtime)
    : { filled: actual.usedTokens, total: actual.totalTokens };
}

function unknownContextUsageForRuntime(runtime: Runtime): ContextUsageSnapshot | undefined {
  const total = modelContextWindow(runtime);
  return total === undefined ? undefined : { total };
}

function promptInputPlaceholder(
  renderer: SessionRenderer,
  promptPrefix: string,
  useColor: boolean,
  terminalWidth: number
): string {
  const availableWidth = Math.max(0, terminalWidth - measureVisibleWidth(promptPrefix));
  if (availableWidth <= 0) {
    return "";
  }
  const text = truncateVisible(chromeCopy(renderer.locale).inputPlaceholder, availableWidth);
  return colorPromptPlaceholder(text, renderer.tokens, useColor);
}

export function renderHorizontalRule(tokens: ResolvedTokens, useColor: boolean, useUnicode: boolean, width: number): string {
  const ruleChar = useUnicode ? "─" : "-";
  const ruleLen = Math.max(0, width);
  const rule = ruleChar.repeat(ruleLen);
  if (!useColor) return rule;
  return ansiColor(rule, tokens.contract.surface.borderSubtle);
}

export function colorPromptPrefix(prefix: string, tokens: ResolvedTokens, useColor: boolean): string {
  if (!useColor) return prefix;
  return ansiColor(prefix, tokens.contract.palette.action);
}

export function colorPromptPlaceholder(value: string, tokens: ResolvedTokens, useColor: boolean): string {
  if (!useColor) return value;
  return ansiColor(value, tokens.contract.text.muted);
}

function renderFreshSessionNotice(
  runtime: Runtime,
  renderer: {
    readonly capabilities?: TerminalCapabilities;
    readonly tokens?: ResolvedTokens;
  }
): string {
  const status = runtime.getStatus();
  const useUnicode = renderer.capabilities?.supportsUnicode === true;
  const useColor = renderer.capabilities?.supportsColor === true &&
    renderer.tokens?.contract.behavior.allowAnsiColor === true;
  const brandLine = `${useUnicode ? "𓂀  " : ""}${freshSessionAgentName(status.agentName)} ready`;
  const profileSeparator = useUnicode ? "·" : "-";
  const lines = [
    `New session ${runtime.sessionId}`,
    "",
    useColor && renderer.tokens !== undefined
      ? ansiColor(brandLine, renderer.tokens.contract.palette.brand)
      : brandLine,
    `${status.profileId ?? "default"} profile ${profileSeparator} ${status.model.provider}/${status.model.id}`,
    "",
    freshSessionRow(
      "security",
      formatFreshSessionSecurity(status.securityMode, useUnicode)
    ),
    freshSessionRow(
      "skills",
      `${status.skillCount}${status.skillAutonomy === undefined ? "" : ` ${status.skillAutonomy}`}`
    ),
    freshSessionRow("tools", String(status.toolCount)),
    status.mcp.total > 0 ? freshSessionRow("MCP", `${status.mcp.active}/${status.mcp.total}`) : undefined,
  ];

  return lines.filter((line): line is string => line !== undefined).join("\n");
}

function freshSessionRow(label: string, value: string): string {
  return `${label.padEnd(10, " ")} ${value}`;
}

function freshSessionAgentName(agentName: string): string {
  return agentName.replace(/^𓂀\s*/u, "").trimStart();
}

function formatFreshSessionSecurity(mode: string, useUnicode: boolean): string {
  const baseMode = mode.replace(/\s+\(YOLO\)$/u, "");
  return baseMode === "open"
    ? `${formatSecurityMode(baseMode)} | ${useUnicode ? "↯ " : ""}YOLO mode`
    : formatSecurityMode(mode);
}

function formatSecurityMode(mode: string): string {
  return mode.length === 0 ? mode : `${mode[0]?.toUpperCase() ?? ""}${mode.slice(1)}`;
}

function operatorConsoleTerminalHeight(output: NodeJS.WritableStream): number {
  const rows = (output as { readonly rows?: number }).rows;
  if (rows === undefined || !Number.isFinite(rows)) return OPERATOR_CONSOLE_FALLBACK_TERMINAL_HEIGHT;
  return Math.max(1, Math.floor(rows));
}

function operatorConsoleTaskCards(runtime: Runtime): readonly TaskCardState[] {
  if (runtime.taskOperator === undefined) return [];
  try {
    return runtime.taskOperator.list({ authorizedSessionId: runtime.sessionId, limit: 12 }).map(taskProjectionToCard);
  } catch {
    return [];
  }
}

function taskApprovalToCard(
  approval: PendingTaskApproval,
  locale: import("../ui/tool-display.js").ToolDisplayLocale
): ApprovalCardState {
  const summary = locale === "ar"
    ? isolateRtl(`المهمة ${isolateLtr(approval.taskId)} · موافقة لمرة واحدة فقط`)
    : `Task ${approval.taskId} · approve once only`;
  return {
    id: approval.approvalId,
    status: "pending",
    action: toolDisplayLabel(approval.toolName, locale),
    target: approval.targetPreview,
    risk: approval.riskClass,
    summary
  };
}

function taskProjectionToCard(task: TaskStatusProjection): TaskCardState {
  return {
    taskId: task.taskId,
    objective: task.objective,
    status: task.status,
    executionPreference: task.executionPreference,
    execution: task.execution,
    foregroundOwnerActive: task.foregroundOwnerActive,
    backgroundContinuation: task.backgroundContinuation,
    ...(task.executionWaitingReason === undefined ? {} : { executionWaitingReason: task.executionWaitingReason }),
    progress: {
      completed: task.progress.completed,
      skipped: task.progress.skipped,
      total: task.progress.total,
    },
    ...(task.planRevision === undefined ? {} : { planRevision: { ...task.planRevision } }),
    steps: task.steps.map((step) => ({
      stepId: step.stepId,
      title: step.title,
      status: step.status,
      dependsOn: [...step.dependsOn],
      childTaskPolicy: step.childTaskPolicy,
      usage: taskUsageToCard(step.usage),
      attempts: step.attempts.map((attempt) => ({
        attemptId: attempt.attemptId,
        taskId: attempt.taskId,
        attemptNumber: attempt.attemptNumber,
        status: attempt.status,
        elapsedMs: attempt.elapsedMs,
        ...(attempt.currentActivity === undefined ? {} : { currentActivity: attempt.currentActivity }),
        ...(attempt.currentToolCategory === undefined ? {} : { currentToolCategory: attempt.currentToolCategory }),
        usage: taskUsageToCard(attempt.usage)
      })),
      ...(step.activeAttempt === undefined ? {} : {
        activeAttempt: {
          attemptId: step.activeAttempt.attemptId,
          taskId: step.activeAttempt.taskId,
          attemptNumber: step.activeAttempt.attemptNumber,
          status: step.activeAttempt.status,
          elapsedMs: step.activeAttempt.elapsedMs,
          ...(step.activeAttempt.currentActivity === undefined ? {} : { currentActivity: step.activeAttempt.currentActivity }),
          ...(step.activeAttempt.currentToolCategory === undefined ? {} : { currentToolCategory: step.activeAttempt.currentToolCategory }),
          usage: taskUsageToCard(step.activeAttempt.usage)
        },
      }),
    })),
    childTasks: task.childTasks.map((child) => ({ ...child })),
    recentActivity: task.recentActivity.map((activity) => ({ ...activity })),
    ...(task.currentToolCategory === undefined ? {} : { currentToolCategory: task.currentToolCategory }),
    elapsedMs: task.elapsedMs,
    usage: taskUsageToCard(task.usage),
    ...(task.spending === undefined ? {} : { spending: { ...task.spending } }),
    results: task.results.map((result) => ({
      handle: result.handle,
      kind: result.kind,
      disposition: result.disposition,
      status: result.status,
      byteLength: result.byteLength,
      primary: result.primary,
      ...(result.summary === undefined ? {} : { summary: result.summary }),
    })),
    ...(task.waitReason === undefined ? {} : { waitReason: task.waitReason }),
    ...(task.failure === undefined ? {} : { failure: { ...task.failure } }),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function taskUsageToCard(usage: import("../contracts/task.js").TaskUsageTotals): TaskCardState["usage"] {
  return {
    providerCalls: usage.providerCalls,
    totalTokens: usage.totalTokens,
    ...(usage.pricingComplete || usage.estimatedCostUsd > 0
      ? { estimatedCostUsd: usage.estimatedCostUsd }
      : {}),
    usageComplete: usage.usageComplete,
    pricingComplete: usage.pricingComplete
  };
}

function ansiColor(text: string, hex: string): string {
  const { r, g, b } = hexToRgb(hex);
  return `\x1B[38;2;${r};${g};${b}m${text}\x1B[0m`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace("#", "");
  const bigint = Number.parseInt(clean, 16);
  return {
    r: (bigint >> 16) & 255,
    g: (bigint >> 8) & 255,
    b: bigint & 255,
  };
}
