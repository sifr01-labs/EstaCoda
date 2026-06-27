import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import { join } from "node:path";
import type { Runtime } from "../runtime/create-runtime.js";
import type { RuntimeEvent } from "../contracts/runtime-event.js";
import type { SessionEvent } from "../contracts/session.js";
import type { ToolResult } from "../contracts/tool.js";
import type { ProviderExecutionSummary } from "../contracts/provider.js";
import type { ModelSwitchContext } from "../providers/model-switch-resolver.js";
import { renderSessionRecallResult } from "../session/session-recall-service.js";
import { renderSessionCompactionResult } from "../prompt/session-compression-service.js";
import { createProviderModelSelectionFlow } from "../providers/provider-model-selection-flow.js";
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
import { toolIcon } from "./tool-activity-renderer.js";
import {
  ToolActivityViewModelBuilder,
  buildSecurityAuditViewModel,
  buildSetupNeededViewModel,
} from "./tool-activity-view-models.js";
import { papyrusApprovalPromptAdapter, type ApprovalPromptAdapter } from "./approval-prompt-adapter.js";
import { RawPromptRenderLoop } from "./rawPromptRenderLoop.js";
import {
  buildActiveTurnSpinnerViewModel,
  buildAssistantResponseViewModel,
  buildKeyValueBlockViewModel,
  buildStartupDashboardViewModel,
  buildSessionStatusRailViewModel,
  buildUserPromptRailViewModel,
  buildToolActivityRailViewModel,
} from "../ui/view-models/builders.js";
import { createSessionRenderer, type SessionRenderer } from "./session-renderer.js";
import type { ResolvedTokens } from "../contracts/ui-tokens.js";
import type { SessionStatusRailViewModel, StartupDashboardViewModel, StatusViewModel, ToolActivityRailEvent, ViewModel } from "../contracts/view-model.js";
import type { TerminalCapabilities } from "../contracts/ui.js";
import {
  applyActiveWorkRuntimeEvent,
  createActiveWorkRuntimeState,
  createSubmittedSteerTranscriptBlock,
  createOperatorConsoleRuntimeHost,
  formatActiveWorkSummary,
  mapStartupDashboardViewModelToOperatorConsoleState,
  renderOperatorConsoleLines,
  routeSteerKey,
  type ActiveWorkRuntimeEvent,
  type OperatorConsoleRuntimeHost,
  type QueuedSteerState,
  type StatusRailState,
  type SteerState,
  type ToolActivityState,
} from "../ui/papyrus/operator-console/index.js";
import { createLineEditorState } from "../ui/input/lineEditor.js";
import { parseKeypress, type ParsedKeypress } from "../ui/input/parseKeypress.js";
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
import { beginExplicitWorkflowRun, beginSkillPlaybookWorkflowRun } from "../workflow/workflow-begin.js";
import { summarizeProviderExecution } from "../runtime/provider-execution-summary.js";

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
  cliVoice?: {
    recorder?: CliVoiceRecorder;
    envOptions?: CliVoiceEnvironmentOptions;
    playbackCommandExists?: (command: string) => Promise<boolean>;
  };
};

const OPERATOR_CONSOLE_ACTIVE_WORK_TERMINAL_HEIGHT = 16;

type ContextUsageSnapshot = NonNullable<SessionStatusRailViewModel["contextUsage"]>;
type ContextUsageSource = Extract<RuntimeEvent, { kind: "context-usage" }>["source"];
type RuntimeModelInfo = ReturnType<NonNullable<Runtime["getModelInfo"]>>;
type StatusRailTimerMode = "idle" | "active-turn" | "last-turn";
type ProviderServingStatus = "primary" | "fallback" | "failed";

type ProviderRouteServingState = {
  readonly status: ProviderServingStatus;
  readonly primary?: {
    readonly provider: string;
    readonly model: string;
  };
  readonly actual?: {
    readonly provider: string;
    readonly model: string;
  };
  readonly reason?: string;
};

type StatusRailTiming = {
  readonly now: () => number;
  readonly sessionStartedAtMs: number;
  readonly mode: StatusRailTimerMode;
  readonly activeTurnStartedAtMs?: number;
  readonly lastCompletedTurnSeconds?: number;
};

type SubmittedCliInput = {
  text: string;
  echoedPromptPrefix: string;
  echoedText: string;
  clearSubmittedPrompt: boolean;
};

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
  contextWindow?: number;
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
    contextWindow: input.contextWindow,
    capabilities: input.capabilities,
    operatorConsoleRuntimeHost: input.operatorConsoleRuntimeHost,
  });
  return `\x1b[2J\x1b[H${startupText}`;
}

function canRenderStartupThroughOperatorConsole(input: {
  viewModel: ViewModel;
  capabilities: TerminalCapabilities;
  operatorConsoleRuntimeHost?: OperatorConsoleRuntimeHost;
}): input is {
  viewModel: StartupDashboardViewModel;
  capabilities: TerminalCapabilities;
  operatorConsoleRuntimeHost: OperatorConsoleRuntimeHost;
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
  contextWindow?: number;
  capabilities: TerminalCapabilities;
  operatorConsoleRuntimeHost: OperatorConsoleRuntimeHost;
}): string {
  const host = input.operatorConsoleRuntimeHost;
  host.clear();
  host.setTerminal({
    width: input.capabilities.terminalWidth,
    height: 40,
    isTty: input.capabilities.isTTY,
  });
  host.setStartupDashboard(mapStartupDashboardViewModelToOperatorConsoleState({
    viewModel: input.viewModel,
    contextWindow: input.contextWindow,
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
  let activeTurn: AbortController | undefined;
  let clearActiveTurnChrome: () => void = () => undefined;
  const operatorConsoleEnabled = options.operatorConsole?.enabled === true
    && renderer.capabilities.isTTY
    && !renderer.capabilities.isCI
    && !renderer.capabilities.isDumb;
  const operatorConsoleRuntimeHost = operatorConsoleEnabled
    ? options.operatorConsole?.runtimeHost ?? createOperatorConsoleRuntimeHost({
      locale: renderer.locale === "ar" ? "ar" : "en",
      terminal: {
        width: renderer.capabilities.terminalWidth,
        height: OPERATOR_CONSOLE_ACTIVE_WORK_TERMINAL_HEIGHT,
        isTty: renderer.capabilities.isTTY,
      },
    })
    : undefined;
  const prompt = options.prompt ?? createInteractivePrompt({
    input: cliInput,
    output: output as NodeJS.WriteStream,
    env: options.env,
    uiContext: promptUiContextForLocale(renderer.locale),
    useOperatorConsole: operatorConsoleEnabled,
  });
  const close = options.close ?? (() => prompt.close?.());
  const onSigint = () => {
    if (activeTurn !== undefined) {
      clearActiveTurnChrome();
      activeTurn.abort("SIGINT");
      output.write("\nCancelling current turn. Press Ctrl+C again or type /exit to leave.\n");
      return;
    }

    output.write("\nEnding EstaCoda session.\n");
    close();
  };

  let stopIdleStatusTicker: () => void = () => undefined;
  process.once("SIGINT", onSigint);

  try {
    let latestContextUsage: ContextUsageSnapshot | undefined;
    let activeTurnContextUsageSource: ContextUsageSource | undefined;
    let timerMode: StatusRailTimerMode = "idle";
    let activeTurnStartedAtMs: number | undefined;
    let lastCompletedTurnSeconds: number | undefined;
    let pendingCompactionPostTokens: number | undefined;
    let lastProviderExecutionSummary: ProviderExecutionSummary | undefined;
    let providerServingState: ProviderRouteServingState | undefined;
    const resetTurnRailState = () => {
      timerMode = "idle";
      activeTurnStartedAtMs = undefined;
      lastCompletedTurnSeconds = undefined;
      pendingCompactionPostTokens = undefined;
    };
    const railTiming = (): StatusRailTiming => ({
      now,
      sessionStartedAtMs,
      mode: timerMode,
      activeTurnStartedAtMs,
      lastCompletedTurnSeconds
    });
    const applyCompactionRailReset = (postTokens?: number) => {
      resetTurnRailState();
      activeTurnContextUsageSource = undefined;
      const contextWindow = modelContextWindow(runtime);
      if (postTokens === undefined) {
        latestContextUsage = undefined;
        return;
      }
      const total = contextWindow ?? latestContextUsage?.total;
      latestContextUsage = total === undefined ? undefined : { filled: postTokens, total };
    };
    const startupVm = await buildSessionStartupViewModel(runtime);
    const renderedStartupText = renderer.render(startupVm);
    const startupText = renderStartupScreenText({
      viewModel: startupVm,
      rendered: renderedStartupText,
      capabilities: renderer.capabilities,
      operatorConsoleRuntimeHost,
      contextWindow: modelContextWindow(runtime),
    });
    const promptPrefix = renderer.tokens.contract.branding.promptPrefix ?? `${renderer.tokens.contract.glyph.prompt} `;
    const useColor = renderer.capabilities.supportsColor && renderer.tokens.contract.behavior.allowAnsiColor;
    const useUnicode = renderer.capabilities.supportsUnicode;
    const termWidth = renderer.capabilities.terminalWidth;
    const managedTty = renderer.capabilities.isTTY && !renderer.capabilities.isCI && !renderer.capabilities.isDumb;
    let idleStatusTicker: ReturnType<typeof setInterval> | undefined;
    const writeSessionStatusRail = () => {
      if (!managedTty || operatorConsoleRuntimeHost !== undefined) return;
      output.write(`${renderer.render(sessionStatusRailViewModel({
        runtime,
        renderer,
        contextUsage: latestContextUsage,
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
        ? promptInputPlaceholder(renderer, promptPrefix, useColor, termWidth)
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
        output.write("Ending EstaCoda session.\n");
        return;
      }

      if (text.startsWith("/")) {
        const shouldExit = await handleSlashCommand({
          text,
          runtime,
          output,
          renderer,
          refreshRuntime: options.refreshRuntime,
          switchRuntime: options.switchRuntime,
          modelSwitchContext: options.modelSwitchContext,
          prompt,
          env: options.env,
          workspaceRoot: options.workspaceRoot,
          homeDir: options.homeDir,
          cronRuntimeFactory: options.cronRuntimeFactory,
          onSessionCompacted: ({ postTokens }) => applyCompactionRailReset(postTokens)
        });

        if (typeof shouldExit !== "boolean") {
          await runtime.dispose();
          runtime = shouldExit.runtime;
          latestContextUsage = undefined;
          activeTurnContextUsageSource = undefined;
          lastProviderExecutionSummary = undefined;
          providerServingState = undefined;
          resetTurnRailState();
          activityBuilder = new ToolActivityViewModelBuilder({
            tools: runtime.tools()
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
      const userPromptRail = buildUserPromptRailViewModel({ text });
      const userPromptRailText = renderer.render(userPromptRail);
      if (!operatorConsoleEnabled) {
        output.write(`${userPromptRailText}\n`);
      }

      let retryText: string | undefined = text;
      let wroteUserPromptRail = false;
      let pendingSteeringNote: string | undefined;
      let steeringRetryUsed = false;
      while (retryText !== undefined) {
        activeTurn = new AbortController();
        activeTurnContextUsageSource = undefined;
        const turnStartedAtMs = now();
        activeTurnStartedAtMs = turnStartedAtMs;
        lastCompletedTurnSeconds = undefined;
        timerMode = "active-turn";
        const streamState = { lastWriteEndedWithNewline: true };
        const turnOutput = { spinnerPhase: undefined as string | undefined, hasOutput: false, lastOutputWasSpinner: false };
        let operatorConsoleActiveWorkState = createActiveWorkRuntimeState();
        let operatorConsoleSteerState: SteerState | undefined;
        let operatorConsoleSteerSequence = 0;
        let disposeOperatorConsoleSteerInput: (() => void) | undefined;
        const operatorConsoleActiveTurnRenderLoop = operatorConsoleRuntimeHost === undefined
          ? undefined
          : new RawPromptRenderLoop(output, {
            operatorConsoleHostFactory: () => operatorConsoleRuntimeHost,
          });
        let turnWasCancelled = false;

        function operatorConsoleSteerVisible(state: SteerState | undefined): boolean {
          return state?.mode === "drafting" || state?.mode === "queued";
        }

        function renderOperatorConsoleLiveFrame(state: ToolActivityState): void {
          const steerVisible = operatorConsoleSteerVisible(operatorConsoleSteerState);
          if (
            operatorConsoleRuntimeHost === undefined ||
            operatorConsoleActiveTurnRenderLoop === undefined ||
            (state.items.length === 0 && !steerVisible)
          ) {
            clearOperatorConsoleLiveFrame();
            return;
          }
          operatorConsoleActiveTurnRenderLoop.render({
            prompt: "",
            state: createLineEditorState(operatorConsoleSteerState?.mode === "drafting" ? operatorConsoleSteerState.draft : ""),
            operatorConsole: {
              enabled: true,
              terminal: {
                width: termWidth,
                height: OPERATOR_CONSOLE_ACTIVE_WORK_TERMINAL_HEIGHT,
                isTty: renderer.capabilities.isTTY,
              },
              status: operatorConsoleStatusRailState({
                runtime,
                renderer,
                contextUsage: latestContextUsage,
                timing: railTiming(),
                providerExecutionSummary: lastProviderExecutionSummary
              }),
              activeWork: state,
              steer: operatorConsoleSteerState,
              promptMode: steerVisible ? "steer" : "prompt",
            },
          });
        }

        function clearOperatorConsoleLiveFrame(): void {
          operatorConsoleActiveTurnRenderLoop?.clear();
        }

        function refreshOperatorConsoleTransientSurface(): void {
          renderOperatorConsoleLiveFrame(operatorConsoleActiveWorkState);
        }

        function setOperatorConsoleSteerState(state: SteerState | undefined): void {
          operatorConsoleSteerState = state;
          if (state === undefined) {
            operatorConsoleRuntimeHost?.setSteer(undefined);
          }
          refreshOperatorConsoleTransientSurface();
        }

        function activeWorkEventFromToolRail(
          railEvent: ToolActivityRailEvent,
          runtimeEvent: Extract<RuntimeEvent, { kind: "tool-start" | "tool-result" }>
        ): ActiveWorkRuntimeEvent {
          return {
            id: railEvent.activityId,
            toolName: railEvent.tool,
            status: railEvent.status,
            summary: railEvent.label,
            target: railEvent.target,
            durationMs: railEvent.elapsedMs,
            detailsRef: railEvent.activityId,
            riskClass: railEvent.riskClass,
            fileChangeInspected: runtimeEvent.kind === "tool-result" && runtimeEvent.fileChangePreview !== undefined,
          };
        }

        function writeTurnBoundaryRows(rows: readonly string[], options: { readonly redrawLiveFrame?: boolean } = {}): void {
          if (rows.length === 0) return;
          clearOperatorConsoleLiveFrame();
          if (!streamState.lastWriteEndedWithNewline) {
            output.write("\n");
          }
          output.write(`${rows.join("\n")}\n`);
          streamState.lastWriteEndedWithNewline = true;
          if (options.redrawLiveFrame === true) {
            refreshOperatorConsoleTransientSurface();
          }
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

          const wasRaw = cliInput.isRaw === true;
          const onData = (chunk: string | Buffer | Uint8Array) => {
            const textChunk = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
            for (const event of parseKeypress(textChunk)) {
              handleOperatorConsoleSteerKey(event);
            }
          };
          cliInput.on("data", onData);
          cliInput.setRawMode?.(true);
          cliInput.resume();
          return () => {
            cliInput.off("data", onData);
            if (!wasRaw) {
              cliInput.setRawMode?.(false);
            }
          };
        }

        const renderSpinner = (phase: string) => {
          if (turnOutput.spinnerPhase === phase) {
            return;
          }
          if (operatorConsoleActiveTurnRenderLoop !== undefined) {
            turnOutput.spinnerPhase = phase;
            refreshOperatorConsoleTransientSurface();
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
	            onEvent: (event) => {
	              if (event.kind === "context-usage") {
                const currentPriority = activeTurnContextUsageSource === undefined
                  ? 0
                  : contextUsagePriority(activeTurnContextUsageSource);
                const incomingPriority = contextUsagePriority(event.source);
	                if (incomingPriority >= currentPriority) {
	                  latestContextUsage = { filled: event.filled, total: event.total };
	                  activeTurnContextUsageSource = event.source;
	                  refreshOperatorConsoleTransientSurface();
	                  writeSessionStatusRail();
	                }
	              }
	              if (event.kind === "session-compacted") {
                pendingCompactionPostTokens = event.postTokens;
                activeTurnContextUsageSource = undefined;
	                const contextWindow = modelContextWindow(runtime);
	                const total = contextWindow ?? latestContextUsage?.total;
	                latestContextUsage = total === undefined ? undefined : { filled: event.postTokens, total };
	                refreshOperatorConsoleTransientSurface();
	                writeSessionStatusRail();
	              }
	              if (event.kind === "agent-cancelled") {
	                turnWasCancelled = true;
	              }
	              let newPhase: string | undefined;
	              if (operatorConsoleRuntimeHost !== undefined && isToolActivityRuntimeEvent(event)) {
	                const railEvent = activityBuilder.buildToolActivityRailEvent(event);
	                operatorConsoleActiveWorkState = applyActiveWorkRuntimeEvent(
	                  operatorConsoleActiveWorkState,
	                  activeWorkEventFromToolRail(railEvent, event)
	                );
	                refreshOperatorConsoleTransientSurface();
	                newPhase = "tool";
	              } else {
                  if (operatorConsoleActiveTurnRenderLoop !== undefined) {
                    clearOperatorConsoleLiveFrame();
                  }
	                newPhase = renderRuntimeEvent(output, event, activityBuilder, renderer, streamState, undefined, turnOutput);
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
	            operatorConsoleRuntimeHost?.setSteer(undefined);
	            clearSpinner();
	            clearActiveTurnChrome = () => undefined;
	          });
        const response = await responsePromise;
        if (operatorConsoleRuntimeHost !== undefined && operatorConsoleActiveWorkState.items.length > 0) {
          writeTurnBoundaryRows([formatActiveWorkSummary(operatorConsoleActiveWorkState)]);
          operatorConsoleActiveWorkState = createActiveWorkRuntimeState();
          operatorConsoleRuntimeHost.setActiveWork(operatorConsoleActiveWorkState);
        }
        lastProviderExecutionSummary = response.providerExecution === undefined
          ? undefined
          : summarizeProviderExecution({
              configuredModel: configuredModelForRuntime(runtime),
              execution: response.providerExecution,
            });
	        if (pendingCompactionPostTokens !== undefined) {
	          applyCompactionRailReset(pendingCompactionPostTokens);
	          pendingCompactionPostTokens = undefined;
	        } else {
	          lastCompletedTurnSeconds = elapsedSeconds(turnStartedAtMs, now());
	          timerMode = "last-turn";
	        }
	        writeSessionStatusRail();
	        if (pendingSteeringNote !== undefined && !steeringRetryUsed) {
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

	        const assistantVm = buildAssistantResponseViewModel({
	          label: response.label,
          text: response.text,
          matchedSkills: response.matchedSkills,
	          progress: options.showResponseProgress === true ? response.progress : undefined,
	        });
	        if (providerServingAlert !== undefined) {
	          output.write(`${providerServingAlert}\n`);
	        }
	        output.write(renderer.render(assistantVm));
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
    const rawText = await input.prompt(echoedPromptPrefix, promptOptions);
    input.onPromptResolved?.();
    const text = rawText.trim();
    return {
      text,
      echoedPromptPrefix,
      echoedText: rawText,
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
    capabilities?: TerminalCapabilities;
  };
  workspaceRoot?: string;
  homeDir?: string;
  cronRuntimeFactory?: CronRuntimeFactory;
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
    case "reset":
      if (input.refreshRuntime === undefined) {
        input.output.write("This session cannot reset itself here. Start a new EstaCoda session to refresh skills and config.\n\n");
        return false;
      }

      return {
        runtime: await input.refreshRuntime({ preserveSession: false }),
        notice: (runtime) => [
          `Started fresh session ${runtime.sessionId}.`,
          "Skills and config were refreshed for this new session.",
          "",
          runtime.describe()
        ].join("\n")
      };
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
      input.output.write(`${await renderMemoryPromotions(input.runtime)}\n\n`);
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
        const result = await renderSessionCompaction(input.runtime, args.join(" "));
        if (result.didCompress && result.postTokens !== undefined) {
          input.onSessionCompacted?.({ postTokens: result.postTokens });
        }
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
    case "workflow": {
      const result = await handleWorkflowCommand(input, args);
      input.output.write(`${result}\n\n`);
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
      input.output.write("Ending EstaCoda session.\n");
      return true;
    default:
      input.output.write(`Unknown command: /${command}\nUse /help to see available commands.\n\n`);
      return false;
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
    modelsDevOptions: context.modelsDevOptions,
    allowNetwork: false,
    mode: "normal"
  });

  const providers = await flow.listProviderCandidates();
  if (providers.length === 0) {
    input.output.write("No configured runnable model providers are ready. Run estacoda model setup from a terminal.\n\n");
    return false;
  }

  const cancel = "__cancel__";
  const provider = await input.prompt.select<string>({
    title: "Select provider",
    body: "Select the provider to use for this session only.",
    options: [
      ...providers.map((candidate) => ({
        value: candidate.id,
        label: candidate.displayName,
        description: candidate.baseUrl ?? candidate.id
      })),
      { value: cancel, label: "Cancel", description: "Keep the current session model" }
    ],
    fallbackPrompt: "Provider number > ",
    selectedLabel: "Provider",
    surface: "promptCard"
  });
  if (provider === cancel) {
    input.output.write("No changes were made.\n\n");
    return false;
  }

  const models = await flow.listModelCandidates(provider);
  if (models.length === 0) {
    input.output.write(`No runnable models are configured for ${provider}. Run estacoda model setup ${provider} from a terminal.\n\n`);
    return false;
  }

  const model = await input.prompt.select<string>({
    title: "Select model",
    body: "Select the model to use for this session only.",
    options: [
      ...models.map((candidate) => ({
        value: candidate.id,
        label: candidate.id,
        description: [
          candidate.profile.supportsTools ? "tools" : undefined,
          candidate.profile.supportsVision ? "vision" : undefined,
          `${candidate.profile.contextWindowTokens} tokens`
        ].filter((part) => part !== undefined).join(" · ")
      })),
      { value: cancel, label: "Cancel", description: "Keep the current session model" }
    ],
    fallbackPrompt: "Model number > ",
    selectedLabel: "Model",
    surface: "promptCard"
  });
  if (model === cancel) {
    input.output.write("No changes were made.\n\n");
    return false;
  }

  return handleSessionModelSet(input, `${provider}/${model}`);
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

async function handleWorkflowCommand(input: {
  runtime: Runtime;
  output: NodeJS.WritableStream;
}, args: string[]): Promise<string> {
  if (input.runtime.workflow === undefined) {
    return "Workflow is not available. It requires SQLite session persistence.";
  }

  const { workflow } = input.runtime;
  const [subcommand = "", ...rest] = args;

  switch (subcommand) {
    case "":
    case "help":
      return [
        "Workflow operator commands (v0.8)",
        "  /workflow begin <objective>        Create, start, and activate a workflow",
        "  /workflow begin --skill <name> <objective>",
        "                                      Create a workflow from a skill playbook",
        "  /workflow status [runId]           Show workflow status (active workflow if omitted)",
        "  /workflow pause <runId> [reason]   Request pause at next safe boundary",
        "  /workflow resume <runId>           Resume a paused/interrupted/waiting workflow",
        "  /workflow interrupt <runId> [r]    Interrupt a running workflow",
        "  /workflow cancel <runId> [reason]  Cancel a workflow",
        "  /workflow steer <runId> <text...>  Inject operator guidance into a workflow",
        "  /workflow approve <stepId>         Approve a pending approval gate",
        "  /workflow reject <stepId> [reason] Reject a pending approval gate",
        "  /workflow retry <stepId>           Retry a failed step",
        "  /workflow skip <stepId> [reason]   Skip a skippable step",
        "  /workflow checkpoint <runId> <n>   Create a named checkpoint",
        "  /workflow trace [runId] [limit]    Show workflow trace",
        "  /workflow summarize <runId>        Summarize workflow events",
        "  /workflow activate <runId>         Activate workflow for this session",
        "  /workflow deactivate               Clear active workflow"
      ].join("\n");

    case "begin": {
      const parsed = parseInteractiveWorkflowBeginArgs(rest);
      if (parsed.error !== undefined) return parsed.error;
      if (parsed.objective.length === 0) {
        return parsed.skillName === undefined
          ? "Usage: /workflow begin <objective>"
          : "Usage: /workflow begin --skill <skillName> <objective>";
      }
      const resolveSkill = input.runtime.resolveSkill;
      if (parsed.skillName !== undefined && resolveSkill === undefined) {
        return "Skill-backed workflow begin is not available in this runtime.";
      }
      const skill = parsed.skillName === undefined ? undefined : resolveSkill?.(parsed.skillName);
      if (parsed.skillName !== undefined && skill === undefined) return `Skill not found: ${parsed.skillName}`;
      const result = skill === undefined
        ? await beginExplicitWorkflowRun({
            engine: workflow.engine,
            sessionId: input.runtime.sessionId,
            objective: parsed.objective
          })
        : await beginSkillPlaybookWorkflowRun({
            engine: workflow.engine,
            sessionId: input.runtime.sessionId,
            objective: parsed.objective,
            skill
          });
      workflow.setActiveRunId(result.run.id);
      return [
        `Created workflow: ${result.run.id}`,
        `Started workflow: ${result.run.id}`,
        `Activated workflow: ${result.run.id}`
      ].join("\n");
    }

    case "status": {
      const runId = rest[0] ?? workflow.activeRunId ?? undefined;
      if (runId === undefined) return "No active workflow. Use /workflow activate <runId> or pass a run ID.";
      const result = await workflow.dispatcher.dispatch({ command: "/status", runId: runId });
      return result.ok ? result.message : `Error: ${result.error}`;
    }

    case "pause": {
      const runId = rest[0];
      if (runId === undefined) return "Usage: /workflow pause <runId> [reason]";
      const result = await workflow.dispatcher.dispatch({
        command: "/pause",
        runId: runId,
        reason: rest.slice(1).join(" ") || undefined,
        operator: "cli"
      });
      return result.ok ? result.message : `Error: ${result.error}`;
    }

    case "resume": {
      const runId = rest[0];
      if (runId === undefined) return "Usage: /workflow resume <runId>";
      const result = await workflow.dispatcher.dispatch({
        command: "/resume",
        runId: runId,
        operator: "cli"
      });
      return result.ok ? result.message : `Error: ${result.error}`;
    }

    case "interrupt": {
      const runId = rest[0];
      if (runId === undefined) return "Usage: /workflow interrupt <runId> [reason]";
      const result = await workflow.dispatcher.dispatch({
        command: "/interrupt",
        runId: runId,
        reason: rest.slice(1).join(" ") || undefined,
        operator: "cli"
      });
      return result.ok ? result.message : `Error: ${result.error}`;
    }

    case "cancel": {
      const runId = rest[0];
      if (runId === undefined) return "Usage: /workflow cancel <runId> [reason]";
      const result = await workflow.dispatcher.dispatch({
        command: "/cancel",
        runId: runId,
        reason: rest.slice(1).join(" ") || undefined,
        operator: "cli"
      });
      return result.ok ? result.message : `Error: ${result.error}`;
    }

    case "steer": {
      const runId = rest[0];
      if (runId === undefined) return "Usage: /workflow steer <runId> <guidance>";
      const guidance = rest.slice(1).join(" ");
      if (guidance.length === 0) return "Usage: /workflow steer <runId> <guidance>";
      const result = await workflow.dispatcher.dispatch({
        command: "/steer",
        runId: runId,
        guidance,
        operator: "cli"
      });
      return result.ok ? result.message : `Error: ${result.error}`;
    }

    case "approve": {
      const stepId = rest[0];
      if (stepId === undefined) return "Usage: /workflow approve <stepId>";
      const result = await workflow.dispatcher.dispatch({
        command: "/approve",
        stepId,
        operator: "cli"
      });
      return result.ok ? result.message : `Error: ${result.error}`;
    }

    case "reject": {
      const stepId = rest[0];
      if (stepId === undefined) return "Usage: /workflow reject <stepId> [reason]";
      const result = await workflow.dispatcher.dispatch({
        command: "/reject",
        stepId,
        reason: rest.slice(1).join(" ") || undefined,
        operator: "cli"
      });
      return result.ok ? result.message : `Error: ${result.error}`;
    }

    case "retry": {
      const stepId = rest[0];
      if (stepId === undefined) return "Usage: /workflow retry <stepId>";
      const result = await workflow.dispatcher.dispatch({
        command: "/retry",
        stepId,
        operator: "cli"
      });
      return result.ok ? result.message : `Error: ${result.error}`;
    }

    case "skip": {
      const stepId = rest[0];
      if (stepId === undefined) return "Usage: /workflow skip <stepId> [reason]";
      const result = await workflow.dispatcher.dispatch({
        command: "/skip",
        stepId,
        reason: rest.slice(1).join(" ") || undefined,
        operator: "cli"
      });
      return result.ok ? result.message : `Error: ${result.error}`;
    }

    case "checkpoint": {
      const runId = rest[0];
      if (runId === undefined) return "Usage: /workflow checkpoint <runId> <name>";
      const name = rest.slice(1).join(" ");
      if (name.length === 0) return "Usage: /workflow checkpoint <runId> <name>";
      const result = await workflow.dispatcher.dispatch({
        command: "/checkpoint",
        runId: runId,
        name,
        operator: "cli"
      });
      return result.ok ? result.message : `Error: ${result.error}`;
    }

    case "trace": {
      const runId = rest[0] ?? workflow.activeRunId ?? undefined;
      const limit = runId !== undefined && rest[1] !== undefined ? parseInt(rest[1], 10) : undefined;
      if (runId === undefined) return "No active workflow. Use /workflow activate <runId> or pass a run ID.";
      const result = await workflow.dispatcher.dispatch({
        command: "/trace",
        runId: runId,
        limit: Number.isNaN(limit) ? undefined : limit
      });
      return result.ok ? result.message : `Error: ${result.error}`;
    }

    case "summarize": {
      const runId = rest[0];
      if (runId === undefined) return "Usage: /workflow summarize <runId>";
      const result = await workflow.dispatcher.dispatch({
        command: "/compact",
        runId: runId,
        operator: "cli"
      });
      return result.ok ? result.message : `Error: ${result.error}`;
    }

    case "activate": {
      const runId = rest[0];
      if (runId === undefined) return "Usage: /workflow activate <runId>";
      const run = await workflow.store.getWorkflowRun(runId);
      if (run === null) return `Workflow run not found: ${runId}`;
      workflow.setActiveRunId(runId);
      return `Activated workflow: ${runId}`;
    }

    case "deactivate": {
      workflow.setActiveRunId(null);
      return "Active workflow cleared. Normal agent mode.";
    }

    default:
      return `Unknown workflow command: ${subcommand}\nUse /workflow help for available commands.`;
  }
}

function parseInteractiveWorkflowBeginArgs(args: string[]): { skillName?: string; objective: string; error?: string } {
  const objectiveParts: string[] = [];
  let skillName: string | undefined;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--skill") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) {
        return { objective: "", error: "Usage: /workflow begin --skill <skillName> <objective>" };
      }
      skillName = value;
      index++;
      continue;
    }
    objectiveParts.push(arg);
  }

  return {
    skillName,
    objective: objectiveParts.join(" ").trim()
  };
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

  const provider = setup.provider === "byteplus" ? "byteplus" : "fal";
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
  output.write(`${toolIcon(input.tool)} calling ${input.tool}\n`);
  const execution = await runtime.executeTool?.(input);
  if (execution === undefined) {
    output.write(`${toolIcon(input.tool)} ${input.tool} unavailable\n`);
    return;
  }

  output.write(`${toolIcon(input.tool)} ${input.tool} ${execution.result?.ok === true ? "done" : "failed"}\n`);
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
  focusTopic: string
): Promise<{ readonly output: string; readonly didCompress: boolean; readonly postTokens?: number }> {
  const topic = focusTopic.trim();
  if (runtime.compactSession === undefined) {
    return { output: "Session compaction is not available in this runtime.", didCompress: false };
  }

  try {
    const normalizedTopic = topic.length === 0 ? undefined : topic;
    const result = await runtime.compactSession({
      focusTopic: normalizedTopic,
      preserveTranscript: false
    });
    return {
      output: renderSessionCompactionResult(result, { focusTopic: normalizedTopic }),
      didCompress: result.didCompress,
      postTokens: result.diagnostics.postTokens
    };
  } catch (error) {
    return {
      output: `Session compaction failed: ${error instanceof Error ? error.message : String(error)}`,
      didCompress: false
    };
  }
}

async function runtimeProfileId(runtime: Runtime): Promise<string> {
  return (await runtime.sessionDb.getSession(runtime.sessionId))?.profileId ?? "default";
}

async function renderMemoryPromotions(runtime: Runtime): Promise<string> {
  const promotions = await runtime.inspectMemoryPromotions();
  if (promotions.length === 0) {
    return "No promoted memory conclusions found.";
  }

  return [
    "Promoted memory conclusions",
    ...promotions.map((record, index) => {
      const state = record.active ? "active" : record.forgottenAt !== undefined ? "forgotten" : "inactive";
      const source = record.sourceSessionIds.length === 0 ? "no session provenance" : `${record.sourceSessionIds.length} session${record.sourceSessionIds.length === 1 ? "" : "s"}`;
      return `${index + 1}. ${record.content} [${state}; occurrences:${record.occurrences}; ${source}]`;
    })
  ].join("\n");
}

export function renderRuntimeEvent(
  output: NodeJS.WritableStream,
  event: RuntimeEvent,
  activityBuilder: ToolActivityViewModelBuilder,
  renderer: { render(viewModel: import("../contracts/view-model.js").ViewModel): string },
  streamState: { lastWriteEndedWithNewline: boolean },
  _legacyChrome: unknown,
  turnOutput: { spinnerPhase?: string; hasOutput: boolean; lastOutputWasSpinner: boolean }
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
    case "context-usage":
      return undefined;
    case "session-compacted":
      return undefined;
    case "agent-cancelled":
      clearActiveSpinnerLine();
      safeWrite(`\ncancelled: ${event.reason}\n`);
      return undefined;
    case "agent-final":
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

function contextUsagePriority(source: ContextUsageSource): number {
  switch (source) {
    case "provider-actual":
      return 3;
    case "assembled-prompt":
      return 2;
    case "live-estimate":
      return 1;
  }
}

function operatorConsoleStatusRailState(input: {
  runtime: Runtime;
  renderer: SessionRenderer;
  contextUsage?: ContextUsageSnapshot;
  timing?: StatusRailTiming;
  providerExecutionSummary?: ProviderExecutionSummary;
}): StatusRailState {
  const { runtime, timing, providerExecutionSummary } = input;
  const modelInfo = typeof runtime.getModelInfo === "function" ? runtime.getModelInfo() : undefined;
  const configuredModel = configuredModelFromInfo(modelInfo);
  const providerRail = providerExecutionRailState(configuredModel, providerExecutionSummary);
  const contextWindow = modelContextWindow(runtime, modelInfo);
  const sessionElapsedMs = timing === undefined
    ? undefined
    : Math.max(0, timing.now() - timing.sessionStartedAtMs);
  const contextUsage = input.contextUsage ?? (contextWindow !== undefined
    ? { filled: 0, total: contextWindow }
    : undefined);

  return {
    model: {
      label: providerRail.servingModelLabel ?? providerRail.modelLabel,
      state: providerRail.modelState === "failed" ? "degraded" : timing?.mode === "active-turn" ? "working" : "idle",
    },
    context: {
      usedTokens: contextUsage?.filled ?? 0,
      ...(contextUsage?.total === undefined ? {} : { totalTokens: contextUsage.total }),
      ...(contextUsage === undefined ? {} : { percent: contextUsage.total > 0 ? Math.round((contextUsage.filled / contextUsage.total) * 100) : 0 }),
    },
    sessionTimer: {
      elapsedMs: sessionElapsedMs ?? 0,
      startedAtMs: timing?.sessionStartedAtMs,
    },
  };
}

function sessionStatusRailViewModel(input: {
  runtime: Runtime;
  renderer: SessionRenderer;
  contextUsage?: ContextUsageSnapshot;
  timing?: StatusRailTiming;
  providerExecutionSummary?: ProviderExecutionSummary;
}): SessionStatusRailViewModel {
  const modelInfo = typeof input.runtime.getModelInfo === "function" ? input.runtime.getModelInfo() : undefined;
  const configuredModel = configuredModelFromInfo(modelInfo);
  const providerRail = providerExecutionRailState(configuredModel, input.providerExecutionSummary);
  const contextWindow = modelContextWindow(input.runtime, modelInfo);
  const sessionElapsedMs = input.timing === undefined
    ? undefined
    : Math.max(0, input.timing.now() - input.timing.sessionStartedAtMs);
  const currentTurnSeconds = currentTurnSecondsForTiming(input.timing);
  const showTurnState = input.timing === undefined || input.timing.mode === "idle";

  return buildSessionStatusRailViewModel({
    ...providerRail,
    turnState: "idle",
    showTurnState,
    sessionElapsedMs,
    currentTurnSeconds,
    contextUsage: input.contextUsage ?? (contextWindow !== undefined
      ? { filled: 0, total: contextWindow }
      : undefined),
  });
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

function currentTurnSecondsForTiming(timing: StatusRailTiming | undefined): number | undefined {
  if (timing === undefined) {
    return undefined;
  }
  if (timing.mode === "active-turn" && timing.activeTurnStartedAtMs !== undefined) {
    return elapsedSeconds(timing.activeTurnStartedAtMs, timing.now());
  }
  if (timing.mode === "last-turn") {
    return timing.lastCompletedTurnSeconds;
  }
  return undefined;
}

function elapsedSeconds(startedAtMs: number, finishedAtMs: number): number {
  return Math.max(0, Math.floor((finishedAtMs - startedAtMs) / 1000));
}

function configuredModelForRuntime(runtime: Runtime): { provider: string; id: string } | undefined {
  const modelInfo = typeof runtime.getModelInfo === "function" ? runtime.getModelInfo() : undefined;
  const configured = configuredModelFromInfo(modelInfo);
  if (configured.id === "unknown" && configured.provider === undefined) {
    return undefined;
  }
  return {
    provider: configured.provider ?? "unknown",
    id: configured.id,
  };
}

function configuredModelFromInfo(modelInfo?: RuntimeModelInfo): {
  provider?: string;
  id: string;
  label: string;
} {
  if (modelInfo?.kind !== "kv") {
    return { id: "unknown", label: "unknown" };
  }

  const model = String(modelInfo.entries.find((entry) => entry.key === "model")?.value ?? "unknown");
  const providerValue = modelInfo.entries.find((entry) => entry.key === "provider")?.value;
  const provider = providerValue === undefined ? undefined : String(providerValue);
  return {
    provider,
    id: model,
    label: model,
  };
}

function providerExecutionRailState(
  configuredModel: { label: string },
  summary?: ProviderExecutionSummary
): {
  modelLabel: string;
  modelState: NonNullable<SessionStatusRailViewModel["modelState"]>;
  configuredModelLabel?: string;
  servingModelLabel?: string;
} {
  if (summary === undefined || summary.status === "not-run") {
    return {
      modelLabel: configuredModel.label,
      modelState: "configured",
    };
  }

  if (summary.status === "failed") {
    return {
      modelLabel: configuredModel.label,
      modelState: "failed",
    };
  }

  if (summary.actual === undefined) {
    return {
      modelLabel: configuredModel.label,
      modelState: "configured",
    };
  }

  return {
    modelLabel: summary.actual.model,
    modelState: summary.status === "fallback-success" ? "fallback-serving" : "primary-serving",
    configuredModelLabel: summary.configuredPrimary?.model,
    servingModelLabel: summary.actual.model,
  };
}

function providerServingTransitionAlert(
  previous: ProviderRouteServingState | undefined,
  summary: ProviderExecutionSummary
): string | undefined {
  const next = providerServingStateFromSummary(summary);
  if (next === undefined) {
    return undefined;
  }

  if (next.status === "primary") {
    if (previous?.status === "fallback" || previous?.status === "failed") {
      return `primary model available again: ${routeModelLabel(next.actual ?? next.primary)}`;
    }
    return undefined;
  }

  if (next.status === "fallback") {
    if (previous?.status === "failed") {
      return `provider recovered via fallback: ${routeModelLabel(next.actual)}; primary ${routeModelLabel(next.primary)} failed with ${formatProviderFailureReason(next.reason)}`;
    }
    if (previous?.status !== "fallback") {
      return `primary model failed: ${routeModelLabel(next.primary)} ${formatProviderFailureReason(next.reason)}; using fallback ${routeModelLabel(next.actual)}`;
    }
    return undefined;
  }

  if (previous?.status !== "failed") {
    return `provider failed: ${routeModelLabel(next.primary ?? next.actual)} ${formatProviderFailureReason(next.reason)}`;
  }

  return undefined;
}

function providerServingStateFromSummary(
  summary: ProviderExecutionSummary
): ProviderRouteServingState | undefined {
  if (summary.status === "not-run") {
    return undefined;
  }

  if (summary.status === "failed") {
    const primary = firstProviderSummaryRoute(summary) ?? summary.configuredPrimary;
    return {
      status: "failed",
      primary,
      reason: summary.primaryFailureClass ?? firstProviderFailureReason(summary),
    };
  }

  if (summary.actual === undefined) {
    return undefined;
  }

  if (summary.status === "fallback-success") {
    return {
      status: "fallback",
      primary: firstProviderSummaryRoute(summary) ?? summary.configuredPrimary,
      actual: summary.actual,
      reason: summary.primaryFailureClass ?? firstProviderFailureReason(summary),
    };
  }

  return {
    status: "primary",
    primary: summary.configuredPrimary,
    actual: summary.actual,
  };
}

function firstProviderSummaryRoute(
  summary: ProviderExecutionSummary
): { provider: string; model: string } | undefined {
  const attempt = summary.attempts.find((candidate) => candidate.attemptedRouteIndex === 0) ?? summary.attempts[0];
  return attempt === undefined
    ? undefined
    : {
        provider: attempt.provider,
        model: attempt.model,
      };
}

function firstProviderFailureReason(summary: ProviderExecutionSummary): string | undefined {
  return summary.attempts.find((attempt) => !attempt.ok)?.errorClass;
}

function routeModelLabel(route: { model: string } | undefined): string {
  return route?.model ?? "unknown";
}

function formatProviderFailureReason(reason: string | undefined): string {
  return reason ?? "unknown";
}

function modelContextWindow(
  runtime: Runtime,
  modelInfo = typeof runtime.getModelInfo === "function" ? runtime.getModelInfo() : undefined
): number | undefined {
  const contextWindow = modelInfo?.kind === "kv"
    ? Number(modelInfo.entries.find((e) => e.key === "context window")?.value)
    : Number.NaN;
  return Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : undefined;
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
