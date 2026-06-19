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
import { createReadlinePrompt, type Prompt, type PromptOptions, type PromptSpecialKeyControl } from "./readline-prompt.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import { renderSlashMenu, renderToolsMenu, buildSlashMenuViewModel, buildSlashCompletionViewModel, buildToolsMenuViewModel, buildSkillsMenuViewModel, isImplementedSlashCommand } from "./slash-menu.js";
import { renderSessionHelp, buildSessionHelpViewModel } from "./session-help.js";
import { commandRegistry } from "./command-registry.js";
import { toolIcon } from "./tool-activity-renderer.js";
import {
  ToolActivityViewModelBuilder,
  buildApprovalPromptViewModel,
  buildSecurityAuditViewModel,
  buildSetupNeededViewModel,
} from "./tool-activity-view-models.js";
import {
  buildActiveTurnSpinnerViewModel,
  buildAssistantResponseViewModel,
  buildStartupDashboardViewModel,
  buildSessionStatusRailViewModel,
  buildUserPromptRailViewModel,
  buildToolActivityRailViewModel,
} from "../ui/view-models/builders.js";
import { createSessionRenderer, type SessionRenderer } from "./session-renderer.js";
import type { ResolvedTokens } from "../contracts/ui-tokens.js";
import { PromptChromeController } from "./prompt-chrome-controller.js";
import { BottomChromeController, type BottomChromeState } from "./bottom-chrome-controller.js";
import type { SessionStatusRailViewModel, ShortcutHintRailViewModel, SlashMenuViewModel, ToolActivityRailEvent, ViewModel } from "../contracts/view-model.js";
import type { TerminalCapabilities } from "../contracts/ui.js";
import { measureVisibleWidth, truncateVisible, wrapText } from "../ui/renderers/layout.js";
import { chromeCopy } from "../ui/cli-ui-copy.js";
import { promptUiContextForLocale } from "../contracts/ui.js";
import { resolveHomeDir } from "../config/home-dir.js";
import { resolveProfileStateHome } from "../config/profile-home.js";
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
import { ActiveTurnCommandController } from "./active-turn-command-controller.js";
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
  cliVoice?: {
    recorder?: CliVoiceRecorder;
    envOptions?: CliVoiceEnvironmentOptions;
    playbackCommandExists?: (command: string) => Promise<boolean>;
  };
};

const PROMPT_REGION_SLASH_PANEL_ROWS = 10;
const MAX_ACTIVE_TURN_PREVIEW_LINES = 4;
const MAX_ACTIVE_TURN_QUEUED_LINES = 3;

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

type TranscriptChrome = {
  readonly enabled: boolean;
  clearInlineSpinner(): void;
  suspendChromeForTranscript<T>(fn: () => T | Promise<T>): Promise<T>;
  suspendForPrompt?<T>(fn: () => T | Promise<T>): Promise<T>;
};

type RuntimeEventChrome = {
  readonly enabled: boolean;
  clearInlineSpinner(): void;
};

type ToolActivityRailAnimator = {
  start(event: ToolActivityRailEvent): void;
  complete(event: ToolActivityRailEvent): void;
  cancel(): void;
  dispose(): void;
};

export class ToolActivityAnimator implements ToolActivityRailAnimator {
  readonly #output: NodeJS.WritableStream;
  readonly #renderer: { render(viewModel: import("../contracts/view-model.js").ViewModel): string };
  readonly #streamState: { lastWriteEndedWithNewline: boolean };
  readonly #enabled: boolean;
  readonly #tickMs = 200;
  #timer?: ReturnType<typeof setInterval>;
  #rows: Array<{ event: ToolActivityRailEvent; active: boolean }> = [];
  #renderedRowCount = 0;

  constructor(options: {
    output: NodeJS.WritableStream;
    renderer: { render(viewModel: import("../contracts/view-model.js").ViewModel): string };
    streamState: { lastWriteEndedWithNewline: boolean };
    enabled: boolean;
  }) {
    this.#output = options.output;
    this.#renderer = options.renderer;
    this.#streamState = options.streamState;
    this.#enabled = options.enabled;
  }

  start(event: ToolActivityRailEvent): void {
    if (!this.#enabled) {
      this.#writeDurableRow(event);
      return;
    }
    this.#upsertRow(event, true);
    this.#redrawRows();
    if (this.#timer === undefined) {
      this.#timer = setInterval(() => this.#tick(), this.#tickMs);
    }
  }

  complete(event: ToolActivityRailEvent): void {
    if (!this.#enabled || this.#rows.length === 0) {
      this.#writeDurableRow(event);
      return;
    }
    this.#upsertRow(event, false);
    this.#redrawRows();
    if (!this.#hasActiveRows()) {
      this.#stopTimer();
      this.#rows = [];
      this.#renderedRowCount = 0;
    }
  }

  cancel(): void {
    this.#stopTimer();
    if (this.#enabled && this.#renderedRowCount > 0) {
      this.#clearRows();
    }
    this.#rows = [];
    this.#renderedRowCount = 0;
  }

  dispose(): void {
    this.#stopTimer();
    this.#rows = [];
    this.#renderedRowCount = 0;
  }

  #tick(): void {
    if (!this.#hasActiveRows() || this.#renderedRowCount === 0) return;
    this.#redrawRows();
  }

  #upsertRow(event: ToolActivityRailEvent, active: boolean): void {
    const index = this.#findRowIndex(event);
    const row = { event, active };
    if (index === -1) {
      this.#rows.push(row);
    } else {
      this.#rows[index] = row;
    }
  }

  #findRowIndex(event: ToolActivityRailEvent): number {
    const key = toolActivityRowKey(event);
    const exactIndex = this.#rows.findIndex((row) => toolActivityRowKey(row.event) === key);
    if (exactIndex !== -1 || event.target !== undefined || event.activityId !== undefined) {
      return exactIndex;
    }
    return this.#rows.findIndex((row) => row.active && row.event.tool === event.tool);
  }

  #hasActiveRows(): boolean {
    return this.#rows.some((row) => row.active);
  }

  #redrawRows(): void {
    // The animated terminal path owns a contiguous tool block at the bottom of the transcript;
    // unrelated output must clear/cancel it before writing.
    this.#clearRows();
    const vm = buildToolActivityRailViewModel({ events: this.#rows.map((row) => row.event) });
    this.#output.write(`${this.#renderer.render(vm)}\n`);
    this.#renderedRowCount = this.#rows.length;
    this.#streamState.lastWriteEndedWithNewline = true;
  }

  #clearRows(): void {
    if (this.#renderedRowCount === 0) {
      return;
    }
    if (this.#renderedRowCount === 1) {
      this.#output.write(`\x1b[1A\x1b[2K\r`);
      return;
    }
    this.#output.write(clearTranscriptBlock(this.#renderedRowCount));
  }

  #writeDurableRow(event: ToolActivityRailEvent): void {
    const vm = buildToolActivityRailViewModel({ events: [event] });
    this.#output.write(`${this.#renderer.render(vm)}\n`);
    this.#streamState.lastWriteEndedWithNewline = true;
  }

  #stopTimer(): void {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }
}

function toolActivityRowKey(event: ToolActivityRailEvent): string {
  return event.activityId ?? `${event.tool}\0${event.target ?? ""}`;
}

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

export async function runSessionLoop(options: SessionLoopOptions): Promise<void> {
  const output = options.output ?? defaultOutput;
  const renderer = createSessionRenderer({ output, locale: options.locale, capabilities: options.capabilities });
  let runtime = options.runtime;
  const now = options.now ?? (() => Date.now());
  const sessionStartedAtMs = now();
  let activityBuilder = new ToolActivityViewModelBuilder({
    tools: runtime.tools()
  });
  let activeTurn: AbortController | undefined;
  let currentAnimator: ToolActivityAnimator | undefined;
  let clearActiveTurnChrome: () => void = () => undefined;
  const cliInput = (options.input as NodeJS.ReadStream | undefined) ?? defaultInput;
  const prompt = options.prompt ?? createReadlinePrompt({
    input: cliInput,
    output: output as NodeJS.WriteStream,
    uiContext: promptUiContextForLocale(renderer.locale),
  });
  const close = options.close ?? (() => prompt.close?.());
  const bottomChrome = new BottomChromeController({
    output,
    capabilities: renderer.capabilities,
    renderViewModel: (vm) => renderer.render(vm),
    renderHorizontalRule: (width) => renderBottomChromeRule(
      renderer.tokens,
      renderer.capabilities.supportsColor && renderer.tokens.contract.behavior.allowAnsiColor,
      renderer.capabilities.supportsUnicode,
      width
    ),
    enabled: renderer.capabilities.isTTY && !renderer.capabilities.isCI && !renderer.capabilities.isDumb,
  });
  const chrome = new PromptChromeController({
    output,
    capabilities: renderer.capabilities,
    renderViewModel: (vm) => renderer.render(vm),
    enabled: !bottomChrome.enabled && renderer.capabilities.isTTY && !renderer.capabilities.isCI && !renderer.capabilities.isDumb,
  });
  const onSigint = () => {
    currentAnimator?.cancel();
    if (activeTurn !== undefined) {
      clearActiveTurnChrome();
      bottomChrome.clearActiveChrome();
      chrome.clearInlineSpinner();
      chrome.clearChrome();
      activeTurn.abort("SIGINT");
      output.write("\nCancelling current turn. Press Ctrl+C again or type /exit to leave.\n");
      return;
    }

    bottomChrome.dispose();
    chrome.clearInlineSpinner();
    chrome.clearChrome();
    output.write("\nEnding EstaCoda session.\n");
    close();
  };

  process.once("SIGINT", onSigint);

  try {
    let pendingSlashCompletion: SlashMenuViewModel | undefined;
    let slashCompletionLine = "";
    let slashCompletionSelectedIndex = 0;
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
    const startupText = renderer.render(startupVm);
    output.write(`${startupText}\n\n`);
    if (!bottomChrome.enabled) {
      output.write(`${chromeCopy(renderer.locale).startupPromptHint}\n\n`);
    }

    const promptPrefix = renderer.tokens.contract.branding.promptPrefix ?? `${renderer.tokens.contract.glyph.prompt} `;
    const useColor = renderer.capabilities.supportsColor && renderer.tokens.contract.behavior.allowAnsiColor;
    const useUnicode = renderer.capabilities.supportsUnicode;
    const termWidth = renderer.capabilities.terminalWidth;
    let clearBottomChromeTranscriptSpinner: () => void = () => undefined;
    const runtimeEventBottomChrome: RuntimeEventChrome = {
      enabled: true,
      clearInlineSpinner: () => clearBottomChromeTranscriptSpinner()
    };
    const writeAboveChrome = (fn: () => void) => {
      if (bottomChrome.enabled) {
        bottomChrome.writeAboveChromeSync(fn);
        return;
      }
      fn();
    };
    let queuedSubmittedInput: SubmittedCliInput | undefined;

    while (true) {
      let livePromptRows = 1;
      let readlineTransientLines: readonly string[] = [];
      let currentInputLine = "";
      const inputPlaceholder = bottomChrome.enabled
        ? promptInputPlaceholder(renderer, promptPrefix, useColor, termWidth)
        : undefined;
      const idleBottomState = () => buildBottomChromeState({
        runtime,
        renderer,
        slashMenu: pendingSlashCompletion,
        slashMenuMinRows: pendingSlashCompletion === undefined ? undefined : PROMPT_REGION_SLASH_PANEL_ROWS,
        contextUsage: latestContextUsage,
        timing: railTiming(),
        providerExecutionSummary: lastProviderExecutionSummary
      });
      const redrawIdleReadlineChrome = () => {
        if (!bottomChrome.enabled) return;
        bottomChrome.updateManagedRegionAboveReadline({
          state: idleBottomState(),
          transientLines: readlineTransientLines,
          promptLineCount: livePromptRows
        });
      };
      const updateIdleSlashCompletionForLine = (line: string) => {
        currentInputLine = line;
        slashCompletionLine = line;
        if (!line.startsWith("/")) {
          pendingSlashCompletion = undefined;
          slashCompletionSelectedIndex = 0;
          return;
        }
        pendingSlashCompletion = buildPromptRegionSlashCompletionViewModel(runtime, line, slashCompletionSelectedIndex);
        slashCompletionSelectedIndex = pendingSlashCompletion.absoluteSelectedIndex ?? 0;
      };
      const hasSlashCompletionState = () =>
        pendingSlashCompletion !== undefined && currentInputLine.startsWith("/");
      const hasSelectableSlashCompletion = () =>
        hasSlashCompletionState() && (pendingSlashCompletion?.options.length ?? 0) > 0;
      const moveIdleSlashSelection = (delta: -1 | 1): "handled" | undefined => {
        if (!hasSelectableSlashCompletion()) return undefined;
        const totalOptions = pendingSlashCompletion?.totalOptions ?? pendingSlashCompletion?.options.length ?? 0;
        if (totalOptions <= 0) return undefined;
        const currentIndex = pendingSlashCompletion?.absoluteSelectedIndex ?? pendingSlashCompletion?.selectedIndex ?? 0;
        slashCompletionSelectedIndex = Math.min(Math.max(0, currentIndex + delta), totalOptions - 1);
        pendingSlashCompletion = buildPromptRegionSlashCompletionViewModel(
          runtime,
          slashCompletionLine,
          slashCompletionSelectedIndex
        );
        slashCompletionSelectedIndex = pendingSlashCompletion.absoluteSelectedIndex ?? slashCompletionSelectedIndex;
        redrawIdleReadlineChrome();
        return "handled";
      };
      const closeIdleSlashMenu = (): "handled" | undefined => {
        if (!hasSlashCompletionState()) return undefined;
        pendingSlashCompletion = undefined;
        slashCompletionSelectedIndex = 0;
        redrawIdleReadlineChrome();
        return "handled";
      };
      const applyIdleSlashCompletion = (control: PromptSpecialKeyControl): "handled" | undefined => {
        if (!hasSelectableSlashCompletion()) return undefined;
        const selectedOption = pendingSlashCompletion?.options[pendingSlashCompletion.selectedIndex];
        if (selectedOption === undefined) return undefined;
        slashCompletionSelectedIndex = pendingSlashCompletion?.absoluteSelectedIndex ?? pendingSlashCompletion?.selectedIndex ?? 0;
        control.setInputLine(selectedOption.label);
        redrawIdleReadlineChrome();
        return "handled";
      };
      let submittedInput = queuedSubmittedInput;
      queuedSubmittedInput = undefined;
      let turnVoiceMode: CliVoiceMode = "off";

      if (submittedInput === undefined) {
        if (bottomChrome.enabled) {
          bottomChrome.updateState(idleBottomState());
          bottomChrome.startReadlineTicker(idleBottomState, () => livePromptRows);
        } else if (chrome.enabled) {
          chrome.renderChrome(buildPromptChromeState(runtime, renderer, undefined, pendingSlashCompletion, latestContextUsage, railTiming(), lastProviderExecutionSummary));
        } else {
          const topRule = renderHorizontalRule(renderer.tokens, useColor, useUnicode, termWidth);
          output.write(`${topRule}\n`);
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
          onPromptResolved: () => {
            if (bottomChrome.enabled) {
              bottomChrome.stopTicker();
              readlineTransientLines = [];
              redrawIdleReadlineChrome();
            }
          },
          onPromptRowsChange: (rows) => {
            livePromptRows = rows;
          },
          onInputChange: (line) => {
            updateIdleSlashCompletionForLine(line);
            redrawIdleReadlineChrome();
          },
          specialKeyController: {
            shouldHandleSpecialKey: () => hasSlashCompletionState(),
            onSpecialKey: (key, control) => {
              if (key === "down") return moveIdleSlashSelection(1);
              if (key === "up") return moveIdleSlashSelection(-1);
              if (key === "escape") return closeIdleSlashMenu();
              if (key === "tab") return applyIdleSlashCompletion(control);
              return undefined;
            },
          },
          onPastePreview: (_original, displayed) => {
            readlineTransientLines = buildPastePreviewLines(displayed, renderer.capabilities.terminalWidth);
            redrawIdleReadlineChrome();
          }
        });
      } else {
        pendingSlashCompletion = undefined;
      }

      const text = submittedInput.text;

      const submittedPromptRows = submittedPromptLineCount(renderer.capabilities, submittedInput);
      if (submittedInput.clearSubmittedPrompt === true) {
        if (bottomChrome.enabled) {
          bottomChrome.stopTicker();
          bottomChrome.clearForReadline(submittedPromptRows);
        } else if (chrome.enabled) {
          chrome.clearChrome(submittedPromptRows);
        } else {
          const topRule = renderHorizontalRule(renderer.tokens, useColor, useUnicode, termWidth);
          output.write(`${topRule}\n`);
        }
      } else {
        if (bottomChrome.enabled) {
          bottomChrome.stopTicker();
        }
      }

      if (text.length === 0) {
        pendingSlashCompletion = undefined;
        continue;
      }

      if (text === "/exit") {
        pendingSlashCompletion = undefined;
        output.write("Ending EstaCoda session.\n");
        return;
      }

      if (text.startsWith("/")) {
        const [submittedCommand = ""] = text.slice(1).trim().split(/\s+/u);
        const resolvedSubmittedCommand = commandRegistry.resolve(submittedCommand);
        if (
          submittedCommand.length === 0 ||
          resolvedSubmittedCommand === undefined ||
          !isImplementedSlashCommand(resolvedSubmittedCommand.name)
        ) {
          pendingSlashCompletion = buildPromptRegionSlashCompletionViewModel(runtime, text);
          continue;
        }

        pendingSlashCompletion = undefined;
        const shouldExit = await handleSlashCommand({
          text,
          runtime,
          output,
          renderer,
          refreshRuntime: options.refreshRuntime,
          switchRuntime: options.switchRuntime,
          modelSwitchContext: options.modelSwitchContext,
          prompt,
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

      pendingSlashCompletion = undefined;

      // Render submitted non-slash user prompts as lightweight transcript rails
      const userPromptRail = buildUserPromptRailViewModel({ text });
      const userPromptRailText = renderer.render(userPromptRail);
      if (bottomChrome.enabled) {
        clearSubmittedPromptEcho(output, renderer.capabilities, submittedInput);
      } else if (chrome.enabled) {
        await chrome.suspendChromeForTranscript(() => {
          clearSubmittedPromptEcho(output, renderer.capabilities, submittedInput);
          output.write(`${userPromptRailText}\n`);
        });
      } else {
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
        const TOOL_SLOT_COUNT = 5;
        const EMPTY_TOOL_SLOT = "\u00A0";
        let bottomChromeTranscriptSpinnerTicker: ReturnType<typeof setInterval> | undefined;
        let bottomChromeActiveChromeTicker: ReturnType<typeof setInterval> | undefined;
        let bottomChromeTransientSpinnerLines: readonly string[] = [];
        let bottomChromeToolActivityActive = false;
        let bottomChromeToolActivityLines: string[] = [];
        const completedBottomChromeToolRows: string[] = [];
        let completedToolRowsFlushed = false;
        let skippedPreResponseBottomChromeStateUpdate = false;
        let activeTurnPromptLines: string[] = [];
        let activeTurnCommandLines: string[] = [];
        let activeTurnStatusLines: string[] = [];
        let activeTurnSlashCompletion: SlashMenuViewModel | undefined;
        let suppressActiveTurnChromeUpdates = false;
        let currentPhase: string | undefined;
        let turnWasCancelled = false;
        let activeTurnCommandController: ActiveTurnCommandController | undefined;
        const runningBottomState = () => buildBottomChromeState({
          runtime,
          renderer,
          slashMenu: activeTurnSlashCompletion,
          slashMenuMinRows: activeTurnSlashCompletion === undefined ? undefined : PROMPT_REGION_SLASH_PANEL_ROWS,
          contextUsage: latestContextUsage,
          timing: railTiming(),
          providerExecutionSummary: lastProviderExecutionSummary
        });

        currentAnimator = new ToolActivityAnimator({
          output,
          renderer,
          streamState,
          enabled: !bottomChrome.enabled && renderer.capabilities.isTTY && renderer.capabilities.supportsAnimation && !renderer.capabilities.isCI && !renderer.capabilities.isDumb,
        });
        const supportsBottomChromeTranscriptSpinnerAnimation =
          renderer.capabilities.supportsAnimation
          && !renderer.capabilities.isCI
          && !renderer.capabilities.isDumb;

        function activeTurnTransientLines(): string[] {
          if (activeTurnPromptLines.length > 0) return activeTurnPromptLines;
          if (activeTurnCommandLines.length > 0) return activeTurnCommandLines;
          if (activeTurnStatusLines.length > 0) return activeTurnStatusLines;
          return [];
        }

        function setActiveTurnPromptLines(lines: string[]): void {
          activeTurnPromptLines = lines;
          activeTurnCommandLines = [];
          activeTurnStatusLines = [];
        }

        function setActiveTurnCommandLines(lines: string[]): void {
          activeTurnPromptLines = [];
          activeTurnCommandLines = lines;
          activeTurnStatusLines = [];
        }

        function setActiveTurnStatusLines(lines: string[]): void {
          activeTurnPromptLines = [];
          activeTurnCommandLines = [];
          activeTurnStatusLines = lines;
        }

        function clearActiveTurnVisualLines(): void {
          activeTurnPromptLines = [];
          activeTurnCommandLines = [];
          activeTurnStatusLines = [];
        }

        function fixedToolActivitySlots(): string[] {
          if (!bottomChromeToolActivityActive) return [];
          const recent = bottomChromeToolActivityLines.slice(-TOOL_SLOT_COUNT);
          return [
            ...recent,
            ...Array.from({ length: TOOL_SLOT_COUNT - recent.length }, () => EMPTY_TOOL_SLOT),
          ];
        }

        const updateActiveTurnTransientLines = () => {
          if (!bottomChrome.enabled) return;
          bottomChrome.updateTransientLines([
            ...activeTurnTransientLines(),
            ...fixedToolActivitySlots(),
            ...bottomChromeTransientSpinnerLines,
          ]);
        };

        function renderToolActivityLines(event: ToolActivityRailEvent): string[] {
          return renderer.render(buildToolActivityRailViewModel({ events: [event] }))
            .split("\n")
            .filter((line) => line.length > 0);
        }

        function appendRenderedRows(rows: string[], rendered: string): void {
          rows.push(...rendered.split("\n").filter((line) => line.length > 0));
        }

        function writeTurnBoundaryRows(rows: readonly string[]): void {
          if (rows.length === 0) return;
          if (!streamState.lastWriteEndedWithNewline) {
            output.write("\n");
          }
          output.write(`${rows.join("\n")}\n`);
          streamState.lastWriteEndedWithNewline = true;
        }

        function isToolActivityRuntimeEvent(
          event: RuntimeEvent
        ): event is Extract<RuntimeEvent, { kind: "tool-start" | "tool-result" }> {
          return event.kind === "tool-start" || event.kind === "tool-result";
        }

        function flushCompletedToolRowsNoRestore(): void {
          if (
            !bottomChrome.enabled ||
            completedToolRowsFlushed ||
            completedBottomChromeToolRows.length === 0
          ) {
            return;
          }

          completedToolRowsFlushed = true;
          bottomChromeToolActivityActive = false;
          bottomChromeToolActivityLines = [];

          bottomChrome.writeAboveChromeNoRestore(() => {
            writeTurnBoundaryRows(completedBottomChromeToolRows);
          });
        }

        const resetBottomChromeTransientSpinnerState = () => {
          if (bottomChromeTranscriptSpinnerTicker !== undefined) {
            clearInterval(bottomChromeTranscriptSpinnerTicker);
            bottomChromeTranscriptSpinnerTicker = undefined;
          }
          bottomChromeTransientSpinnerLines = [];
          streamState.lastWriteEndedWithNewline = true;
          turnOutput.lastOutputWasSpinner = false;
        };

        const stopBottomChromeTransientSpinner = () => {
          resetBottomChromeTransientSpinnerState();
          updateActiveTurnTransientLines();
        };
        clearBottomChromeTranscriptSpinner = stopBottomChromeTransientSpinner;

        const updateActiveTurnTransientLinesUnlessSuppressed = () => {
          if (suppressActiveTurnChromeUpdates) {
            return;
          }
          updateActiveTurnTransientLines();
        };

        const updateBottomChromeStateInPlaceUnlessSuppressed = () => {
          if (!bottomChrome.enabled || suppressActiveTurnChromeUpdates) {
            return;
          }
          bottomChrome.updateStateInPlace(runningBottomState());
        };

        const stopBottomChromeActiveChromeTicker = () => {
          if (bottomChromeActiveChromeTicker !== undefined) {
            clearInterval(bottomChromeActiveChromeTicker);
            bottomChromeActiveChromeTicker = undefined;
          }
        };

        const renderBottomChromeTranscriptSpinnerFrame = () => {
          if (!bottomChrome.enabled || currentPhase === undefined) {
            return;
          }
          const spinnerText = renderer.render(buildActiveTurnSpinnerViewModel({ phase: currentPhase }));
          bottomChromeTransientSpinnerLines = spinnerText.split("\n").filter((line) => line.length > 0);
          updateActiveTurnTransientLines();
          streamState.lastWriteEndedWithNewline = true;
          turnOutput.hasOutput = true;
          turnOutput.lastOutputWasSpinner = true;
        };

        const startBottomChromeTranscriptSpinner = (phase: string) => {
          currentPhase = phase;
          renderBottomChromeTranscriptSpinnerFrame();
          if (!supportsBottomChromeTranscriptSpinnerAnimation || bottomChromeTranscriptSpinnerTicker !== undefined) {
            return;
          }
          bottomChromeTranscriptSpinnerTicker = setInterval(() => {
            renderBottomChromeTranscriptSpinnerFrame();
          }, 200);
        };

        const renderSpinner = (phase: string) => {
          currentPhase = phase;
          if (bottomChrome.enabled) {
            bottomChrome.updateStateInPlace(runningBottomState());
            startBottomChromeTranscriptSpinner(phase);
            turnOutput.spinnerPhase = phase;
            return;
          }
          if (chrome.enabled) {
            chrome.renderInlineSpinner(phase, (p) => {
              const activeSpinner = buildActiveTurnSpinnerViewModel({ phase: p });
              const statusRail = buildPromptChromeState(runtime, renderer, undefined, undefined, latestContextUsage, railTiming(), lastProviderExecutionSummary).statusRail;
              return [
                statusRail === undefined ? undefined : renderer.render(statusRail),
                renderer.render(activeSpinner)
              ].filter((line) => line !== undefined).join("\n");
            });
            turnOutput.spinnerPhase = phase;
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
          if (bottomChrome.enabled) {
            stopBottomChromeActiveChromeTicker();
            stopBottomChromeTransientSpinner();
            currentPhase = undefined;
          } else if (chrome.enabled) {
            chrome.clearInlineSpinner();
          }
          turnOutput.spinnerPhase = undefined;
          turnOutput.lastOutputWasSpinner = false;
        };
        clearActiveTurnChrome = clearSpinner;

        if (bottomChrome.enabled) {
          bottomChrome.setStateFactory(runningBottomState);
          bottomChrome.updateState(runningBottomState());
          bottomChromeActiveChromeTicker = setInterval(() => {
            bottomChrome.updateStateInPlace(runningBottomState());
          }, 1000);
          if (!wroteUserPromptRail) {
            bottomChrome.writeAboveChromeSync(() => {
              output.write(`${userPromptRailText}\n\n`);
            });
            wroteUserPromptRail = true;
          }
          renderSpinner("thinking");
        } else {
          renderSpinner("thinking");
          output.write("\n");
        }

        activeTurnCommandController = new ActiveTurnCommandController({
          input: cliInput,
          enabled: renderer.capabilities.isTTY && !renderer.capabilities.isCI && !renderer.capabilities.isDumb,
          onActiveInputPreviewChange: (preview) => {
            if (!bottomChrome.enabled) {
              clearActiveTurnVisualLines();
              return;
            }
            if (preview?.kind === "message") {
              setActiveTurnPromptLines(renderActiveTurnLabeledLines({
                label: "> Follow up:",
                text: preview.text,
                terminalWidth: termWidth,
                maxLines: MAX_ACTIVE_TURN_PREVIEW_LINES,
                overflow: "tail",
              }));
            } else if (preview?.kind === "command") {
              setActiveTurnCommandLines(renderActiveTurnCommandPreviewLines({
                command: preview.text,
                renderer,
                terminalWidth: termWidth,
              }));
            } else {
              clearActiveTurnVisualLines();
            }
            updateActiveTurnTransientLinesUnlessSuppressed();
          },
          onStatusMessage: (message) => {
            if (!bottomChrome.enabled) {
              clearActiveTurnVisualLines();
              return;
            }
            setActiveTurnStatusLines(renderActiveTurnLabeledLines({
              label: `${activeTurnGlyph(renderer, "command")} active command:`,
              text: message,
              terminalWidth: termWidth,
              maxLines: 2,
              overflow: "head",
            }));
            updateActiveTurnTransientLinesUnlessSuppressed();
          },
          onInputLineChange: (line) => {
            activeTurnSlashCompletion = line?.startsWith("/") === true
              ? buildActiveTurnSlashCompletionViewModel(runtime, line)
              : undefined;
            updateBottomChromeStateInPlaceUnlessSuppressed();
          },
          onQueueText: (queuedText) => {
            if (queuedSubmittedInput !== undefined) {
              if (bottomChrome.enabled) {
                setActiveTurnStatusLines(renderActiveTurnLabeledLines({
                  label: `${activeTurnGlyph(renderer, "queued")} Queued:`,
                  text: "A message is already queued for the next turn.",
                  terminalWidth: termWidth,
                  maxLines: 2,
                  overflow: "head",
                }));
              } else {
                clearActiveTurnVisualLines();
              }
              updateActiveTurnTransientLinesUnlessSuppressed();
              return;
            }
            queuedSubmittedInput = {
              text: queuedText,
              echoedPromptPrefix: "",
              echoedText: queuedText,
              clearSubmittedPrompt: false
            };
            if (bottomChrome.enabled) {
              setActiveTurnStatusLines(renderActiveTurnLabeledLines({
                label: `${activeTurnGlyph(renderer, "queued")} Queued:`,
                text: queuedText,
                terminalWidth: termWidth,
                maxLines: MAX_ACTIVE_TURN_QUEUED_LINES,
                overflow: "head",
              }));
            } else {
              clearActiveTurnVisualLines();
            }
            updateActiveTurnTransientLines();
          },
          onInterrupt: () => {
            activeTurn?.abort("CLI interrupt");
          },
          onSteer: (note) => {
            if (steeringRetryUsed || pendingSteeringNote !== undefined) {
              if (bottomChrome.enabled) {
                setActiveTurnStatusLines(renderActiveTurnLabeledLines({
                  label: `${activeTurnGlyph(renderer, "command")} active command:`,
                  text: "Steering already queued for this turn.",
                  terminalWidth: termWidth,
                  maxLines: 2,
                  overflow: "head",
                }));
              } else {
                clearActiveTurnVisualLines();
              }
              updateActiveTurnTransientLines();
              return;
            }
            pendingSteeringNote = note;
            if (bottomChrome.enabled) {
              setActiveTurnStatusLines(renderActiveTurnLabeledLines({
                label: `${activeTurnGlyph(renderer, "steer")} Steer:`,
                text: "Steering note queued; interrupting turn.",
                terminalWidth: termWidth,
                maxLines: 2,
                overflow: "head",
              }));
            } else {
              clearActiveTurnVisualLines();
            }
            updateActiveTurnTransientLines();
            activeTurn?.abort("CLI steer");
          },
        });
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
                  if ((bottomChrome.enabled || chrome.enabled) && turnOutput.spinnerPhase !== undefined) {
                    renderSpinner(turnOutput.spinnerPhase);
                  }
                }
              }
              if (event.kind === "session-compacted") {
                pendingCompactionPostTokens = event.postTokens;
                activeTurnContextUsageSource = undefined;
                const contextWindow = modelContextWindow(runtime);
                const total = contextWindow ?? latestContextUsage?.total;
                latestContextUsage = total === undefined ? undefined : { filled: event.postTokens, total };
                if ((bottomChrome.enabled || chrome.enabled) && turnOutput.spinnerPhase !== undefined) {
                  renderSpinner(turnOutput.spinnerPhase);
                }
              }
              if (event.kind === "agent-cancelled") {
                turnWasCancelled = true;
              }
              let newPhase: string | undefined;
              if (bottomChrome.enabled && isToolActivityRuntimeEvent(event)) {
                runtimeEventBottomChrome.clearInlineSpinner();

                const railEvent = activityBuilder.buildToolActivityRailEvent(event);
                const lines = renderToolActivityLines(railEvent);

                bottomChromeToolActivityActive = true;
                bottomChromeToolActivityLines.push(...lines);
                bottomChromeToolActivityLines = bottomChromeToolActivityLines.slice(-TOOL_SLOT_COUNT);

                if (event.kind === "tool-result") {
                  completedBottomChromeToolRows.push(...lines);
                  if (event.fileChangePreview !== undefined) {
                    appendRenderedRows(completedBottomChromeToolRows, renderer.render(event.fileChangePreview));
                  }
                }

                updateActiveTurnTransientLines();
                newPhase = "tool";
              } else if (bottomChrome.enabled) {
                bottomChrome.writeAboveChromeSync(() => {
                  newPhase = renderRuntimeEvent(output, event, activityBuilder, renderer, streamState, runtimeEventBottomChrome, turnOutput);
                });
              } else {
                newPhase = renderRuntimeEvent(output, event, activityBuilder, renderer, streamState, chrome, turnOutput, currentAnimator);
              }
              if (newPhase !== undefined) {
                renderSpinner(newPhase);
              }
            }
          })
          .finally(() => {
            activeTurn = undefined;
            activeTurnStartedAtMs = undefined;
            suppressActiveTurnChromeUpdates = bottomChrome.enabled;
            try {
              activeTurnCommandController?.dispose();
            } finally {
              suppressActiveTurnChromeUpdates = false;
            }
            activeTurnCommandController = undefined;
            clearActiveTurnVisualLines();
            activeTurnSlashCompletion = undefined;
            bottomChromeToolActivityActive = false;
            bottomChromeToolActivityLines = [];
            if (bottomChrome.enabled) {
              stopBottomChromeActiveChromeTicker();
              resetBottomChromeTransientSpinnerState();
              currentPhase = undefined;
              turnOutput.spinnerPhase = undefined;
              turnOutput.lastOutputWasSpinner = false;
            } else {
              clearSpinner();
            }
            currentAnimator?.dispose();
            currentAnimator = undefined;
            clearBottomChromeTranscriptSpinner = () => undefined;
            clearActiveTurnChrome = () => undefined;
          });
        activeTurnCommandController.start();
        const response = await responsePromise;
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
        if (bottomChrome.enabled && completedBottomChromeToolRows.length === 0) {
          updateActiveTurnTransientLines();
          bottomChrome.updateState(buildBottomChromeState({
            runtime,
            renderer,
            contextUsage: latestContextUsage,
            timing: railTiming(),
            providerExecutionSummary: lastProviderExecutionSummary
          }));
        } else if (bottomChrome.enabled) {
          skippedPreResponseBottomChromeStateUpdate = true;
        }

        if (pendingSteeringNote !== undefined && !steeringRetryUsed) {
          const steeringNote = pendingSteeringNote;
          pendingSteeringNote = undefined;
          steeringRetryUsed = true;
          if (bottomChrome.enabled) {
            updateActiveTurnTransientLines();
          }
          retryText = buildSteeredRetryText(text, steeringNote);
          continue;
        }

        const providerServingAlert = lastProviderExecutionSummary === undefined
          ? undefined
          : providerServingTransitionAlert(providerServingState, lastProviderExecutionSummary);
        if (lastProviderExecutionSummary !== undefined) {
          providerServingState = providerServingStateFromSummary(lastProviderExecutionSummary);
        }

        const assistantVm = buildAssistantResponseViewModel({
          label: response.label,
          text: response.text,
          matchedSkills: response.matchedSkills,
          progress: options.showResponseProgress === true ? response.progress : undefined,
        });
        flushCompletedToolRowsNoRestore();
        if (providerServingAlert !== undefined) {
          writeAboveChrome(() => {
            output.write(`${providerServingAlert}\n`);
          });
        }
        writeAboveChrome(() => {
          output.write(renderer.render(assistantVm));
        });
        if (skippedPreResponseBottomChromeStateUpdate && bottomChrome.enabled) {
          bottomChrome.updateState(buildBottomChromeState({
            runtime,
            renderer,
            contextUsage: latestContextUsage,
            timing: railTiming(),
            providerExecutionSummary: lastProviderExecutionSummary
          }));
        }
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
            writeAboveChrome(() => {
              output.write(`\nCLI voice playback skipped: ${playback.reason}\n`);
            });
          } else if (playback !== undefined && playback.played === true) {
            writeAboveChrome(() => {
              output.write(`\nCLI voice playback: ${playback.player}\n`);
            });
          }
        }

        const setupResolution = await maybeHandleSetupNeeded({
          runtime,
          prompt,
          output,
          renderer,
          chrome: bottomChrome.enabled ? bottomChrome : chrome,
          homeDir: options.homeDir,
          execution: response.toolExecutions.find(hasSetupNeededResult)
        });

        if (setupResolution.handled) {
          writeAboveChrome(() => {
            output.write(`${setupResolution.message}\n\n`);
          });
          retryText = undefined;
          continue;
        }

        const approvalResolution = await maybeHandleApprovalGate({
          runtime,
          prompt,
          output,
          renderer,
          chrome: bottomChrome.enabled ? bottomChrome : chrome,
          execution: response.toolExecutions.find((execution) => execution.decision === "ask")
        });

        if (approvalResolution.retry === false) {
          if (approvalResolution.message !== undefined) {
            writeAboveChrome(() => {
              output.write(`${approvalResolution.message}\n`);
            });
          }
          writeAboveChrome(() => {
            output.write("\n");
          });
          retryText = undefined;
          continue;
        }

        writeAboveChrome(() => {
          output.write(`${approvalResolution.message}\n\n`);
        });
        retryText = text;
      }
    }
  } finally {
    process.removeListener("SIGINT", onSigint);
    bottomChrome.dispose();
    chrome.dispose();
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
  onInputChange?: (line: string) => void;
  specialKeyController?: PromptOptions["specialKeyController"];
  onPastePreview?: (original: string, displayed: string) => void;
}): Promise<SubmittedCliInput> {
  if (input.voiceMode === "off") {
    const echoedPromptPrefix = colorPromptPrefix(input.promptPrefix, input.renderer.tokens, input.useColor);
    const profileId = await runtimeProfileId(input.runtime);
    const profilePaths = resolveProfileStateHome({ homeDir: resolveHomeDir(input.homeDir), profileId });
    const promptOptions: PromptOptions = {
      onRowsChange: input.onPromptRowsChange,
      onInputChange: input.onInputChange,
      specialKeyController: input.specialKeyController,
      onPastePreview: input.onPastePreview,
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

function clearSubmittedPromptEcho(
  output: NodeJS.WritableStream,
  capabilities: TerminalCapabilities,
  submittedInput: SubmittedCliInput
): void {
  if (
    submittedInput.clearSubmittedPrompt !== true ||
    !capabilities.isTTY ||
    capabilities.isCI ||
    capabilities.isDumb
  ) {
    return;
  }

  const lineCount = submittedPromptLineCount(capabilities, submittedInput);
  let sequence = "";
  for (let index = 0; index < lineCount; index += 1) {
    sequence += "\x1b[1A\x1b[2K";
  }
  sequence += "\r";
  output.write(sequence);
}

function submittedPromptLineCount(
  capabilities: TerminalCapabilities,
  submittedInput: SubmittedCliInput
): number {
  const terminalWidth = Math.max(1, capabilities.terminalWidth);
  const visibleWidth = measureVisibleWidth(`${submittedInput.echoedPromptPrefix}${submittedInput.echoedText}`);
  return Math.max(1, Math.ceil(Math.max(1, visibleWidth) / terminalWidth));
}

function buildPastePreviewLines(displayed: string, terminalWidth: number): string[] {
  const width = Math.max(1, terminalWidth);
  const lines = displayed.split(/\r\n|\r|\n/u);
  const previewLines = lines.slice(0, 3);
  if (lines.length > previewLines.length) {
    previewLines.push("...");
  }
  return previewLines.flatMap((line) => wrapText(line, width));
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
  const config = await loadRuntimeConfig({
    workspaceRoot: input.workspaceRoot ?? process.cwd(),
    homeDir,
    profileId
  });
  const result = await playCliTtsResponse({
    text: input.text,
    config,
    profilePaths,
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
      input.output.write(`${input.renderer.render(buildSlashMenuViewModel(input.runtime))}\n\n`);
      return false;
    case "help":
      input.output.write(`${input.renderer.render(buildSessionHelpViewModel())}\n\n`);
      return false;
    case "status":
      input.output.write(`${input.renderer.render(input.runtime.getStatus())}\n\n`);
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
      if (renderSlashMenu(input.runtime, command).startsWith("No slash commands or skills match") === false) {
        input.output.write(`${input.renderer.render(buildSlashMenuViewModel(input.runtime, command))}\n\n`);
        return false;
      }

      input.output.write(`Unknown command: /${command}\nUse /help to see available commands.\n\n`);
      return false;
  }
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
  renderer: { render(viewModel: import("../contracts/view-model.js").ViewModel): string };
  chrome: TranscriptChrome;
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
      await promptForApprovalAnswer(input, execution, allowPersistentApproval)
    );
    if (answer?.kind === "deny") {
      return {
        retry: false,
        message: "Permission denied."
      };
    }

    if (answer?.kind !== "approve") {
      await writeDetachedInteraction(input.chrome, () => {
        input.output.write("Enter one of: once, session, always, deny.\n\n");
      });
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
  chrome: TranscriptChrome;
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

  const secret = await writeDetachedInteraction(input.chrome, async () => {
    input.output.write(input.renderer.render(vm));
    input.output.write("\n\n");
    return await input.prompt(`Paste ${requiredSecret} (or type cancel): `, { secret: true });
  });
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

  await writeDetachedInteraction(input.chrome, async () => {
    input.output.write("Image setup verified. Resuming the original image request...\n");
    await renderManualToolExecution(input.output, input.runtime, {
      tool: execution.tool.name,
      toolInput: execution.input ?? {}
    });
  });

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

async function promptForApprovalAnswer(
  input: {
    prompt: (question: string) => Promise<string>;
    output: NodeJS.WritableStream;
    renderer: { render(viewModel: import("../contracts/view-model.js").ViewModel): string };
    chrome: TranscriptChrome;
  },
  execution: ToolExecutionRecord,
  allowPersistentApproval: boolean
): Promise<string> {
  const promptText = "approval > ";
  const cardText = renderApprovalPromptCard(execution, input.renderer, allowPersistentApproval);
  if (input.chrome.suspendForPrompt !== undefined) {
    return await input.chrome.suspendForPrompt(async () => {
      input.output.write(`${cardText}\n`);
      return await input.prompt(promptText);
    });
  }

  input.chrome.clearInlineSpinner();
  if (input.chrome.enabled) {
    await input.chrome.suspendChromeForTranscript(() => {
      input.output.write(`${cardText}\n`);
    });
  } else {
    input.output.write(`${cardText}\n`);
  }
  return await input.prompt(promptText);
}

function renderApprovalPromptCard(
  execution: ToolExecutionRecord,
  renderer: { render(viewModel: import("../contracts/view-model.js").ViewModel): string },
  allowPersistentApproval: boolean
): string {
  const vm = buildApprovalPromptViewModel(execution, { allowPersistentApproval });
  return renderer.render(vm);
}

async function writeDetachedInteraction<T>(
  chrome: TranscriptChrome,
  fn: () => T | Promise<T>
): Promise<T> {
  if (chrome.suspendForPrompt !== undefined) {
    return await chrome.suspendForPrompt(fn);
  }
  if (chrome.enabled) {
    return await chrome.suspendChromeForTranscript(fn);
  }
  return await fn();
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
  chrome: RuntimeEventChrome | undefined,
  turnOutput: { spinnerPhase?: string; hasOutput: boolean; lastOutputWasSpinner: boolean },
  animator?: ToolActivityRailAnimator
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
    if (chrome?.enabled) {
      chrome.clearInlineSpinner();
      return;
    }
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
      if (!chrome?.enabled) {
        safeWrite(`\u2625 skill: ${event.name}\n`);
      }
      return undefined;
    case "tool-start": {
      clearActiveSpinnerLine();
      const railEvent = activityBuilder.buildToolActivityRailEvent(event);
      if (animator !== undefined) {
        animator.start(railEvent);
      } else {
        const railVm = buildToolActivityRailViewModel({ events: [railEvent] });
        safeWrite(`${renderer.render(railVm)}\n`);
      }
      return "tool";
    }
    case "tool-result": {
      clearActiveSpinnerLine();
      const railEvent = activityBuilder.buildToolActivityRailEvent(event);
      if (animator !== undefined) {
        animator.complete(railEvent);
      } else {
        const railVm = buildToolActivityRailViewModel({ events: [railEvent] });
        safeWrite(`${renderer.render(railVm)}\n`);
      }
      if (event.fileChangePreview !== undefined) {
        safeWrite(`${renderer.render(event.fileChangePreview)}\n`);
      }
      return "tool";
    }
    case "provider-attempt":
      return "provider";
    case "provider-token": {
      if (!chrome?.enabled) {
        // Provider tokens stream directly; never inject newlines here.
        output.write(event.text);
        if (event.text.length > 0) {
          turnOutput.hasOutput = true;
          turnOutput.lastOutputWasSpinner = false;
        }
        streamState.lastWriteEndedWithNewline = event.text.endsWith("\n");
      }
      return "provider";
    }
    case "provider-tool-call":
      return "tool";
    case "provider-result":
      if (!event.ok && !event.willFallback) {
        animator?.cancel();
      }
      return event.ok || !event.willFallback ? "finalizing" : "provider";
    case "provider-budget-exhausted":
      animator?.cancel();
      clearActiveSpinnerLine();
      safeWrite(`\nprovider budget: ${event.reason}\n`);
      return undefined;
    case "context-usage":
      return undefined;
    case "session-compacted":
      return undefined;
    case "agent-cancelled":
      animator?.cancel();
      clearActiveSpinnerLine();
      safeWrite(`\ncancelled: ${event.reason}\n`);
      return undefined;
    case "agent-final":
      animator?.dispose();
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

function clearTranscriptBlock(lineCount: number): string {
  const count = Math.max(1, Math.ceil(lineCount));
  return `\x1b[${count}A\x1b[0J`;
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

function buildPromptChromeState(
  runtime: Runtime,
  renderer: SessionRenderer,
  activeSpinner?: import("../contracts/view-model.js").ActiveTurnSpinnerViewModel,
  slashMenu?: SlashMenuViewModel,
  contextUsage?: ContextUsageSnapshot,
  timing?: StatusRailTiming,
  providerExecutionSummary?: ProviderExecutionSummary
) {
  const modelInfo = typeof runtime.getModelInfo === "function" ? runtime.getModelInfo() : undefined;
  const configuredModel = configuredModelFromInfo(modelInfo);
  const providerRail = providerExecutionRailState(configuredModel, providerExecutionSummary);
  const contextWindow = modelContextWindow(runtime, modelInfo);
  const sessionElapsedMs = timing === undefined
    ? undefined
    : Math.max(0, timing.now() - timing.sessionStartedAtMs);
  const currentTurnSeconds = currentTurnSecondsForTiming(timing);
  const showTurnState = timing === undefined || timing.mode === "idle";

  return {
    statusRail: buildSessionStatusRailViewModel({
      ...providerRail,
      turnState: "idle",
      showTurnState,
      sessionElapsedMs,
      currentTurnSeconds,
      contextUsage: contextUsage ?? (contextWindow !== undefined
        ? { filled: 0, total: contextWindow }
        : undefined),
    }),
    activeSpinner,
    slashMenu,
  };
}

function buildBottomChromeState(input: {
  runtime: Runtime;
  renderer: SessionRenderer;
  slashMenu?: SlashMenuViewModel;
  slashMenuMinRows?: number;
  shortcutRail?: ShortcutHintRailViewModel;
  contextUsage?: ContextUsageSnapshot;
  timing?: StatusRailTiming;
  providerExecutionSummary?: ProviderExecutionSummary;
}): BottomChromeState {
  const chromeState = buildPromptChromeState(
    input.runtime,
    input.renderer,
    undefined,
    input.slashMenu,
    input.contextUsage,
    input.timing,
    input.providerExecutionSummary
  );
  return {
    statusRail: chromeState.statusRail,
    activeSpinner: chromeState.activeSpinner,
    shortcutRail: input.slashMenu === undefined ? input.shortcutRail : undefined,
    slashMenu: chromeState.slashMenu,
    slashMenuMinRows: input.slashMenuMinRows,
  };
}

function buildPromptRegionSlashCompletionViewModel(
  runtime: Runtime,
  line: string,
  selectedIndex = 0
): SlashMenuViewModel {
  return buildSlashCompletionViewModel(runtime, line, {
    selectedIndex,
    visibleRows: PROMPT_REGION_SLASH_PANEL_ROWS,
  });
}

function buildActiveTurnSlashCompletionViewModel(runtime: Runtime, line: string): SlashMenuViewModel {
  return buildSlashCompletionViewModel(runtime, line, {
    includeActiveTurnCommands: true,
    visibleRows: PROMPT_REGION_SLASH_PANEL_ROWS,
  });
}

function renderActiveTurnCommandPreviewLines(input: {
  command: string;
  renderer: SessionRenderer;
  terminalWidth: number;
}): string[] {
  if (input.command === "/interrupt") {
    return renderActiveTurnLabeledLines({
      label: `${activeTurnGlyph(input.renderer, "interrupt")} Interrupt`,
      text: "",
      terminalWidth: input.terminalWidth,
      maxLines: 1,
      overflow: "head",
    });
  }

  if (input.command === "/steer" || input.command.startsWith("/steer ")) {
    return renderActiveTurnLabeledLines({
      label: `${activeTurnGlyph(input.renderer, "steer")} Steer:`,
      text: input.command,
      terminalWidth: input.terminalWidth,
      maxLines: MAX_ACTIVE_TURN_PREVIEW_LINES,
      overflow: "tail",
    });
  }

  return renderActiveTurnLabeledLines({
    label: `${activeTurnGlyph(input.renderer, "command")} active command:`,
    text: input.command,
    terminalWidth: input.terminalWidth,
    maxLines: MAX_ACTIVE_TURN_PREVIEW_LINES,
    overflow: "tail",
  });
}

function renderActiveTurnLabeledLines(input: {
  label: string;
  text: string;
  terminalWidth: number;
  maxLines: number;
  overflow: "head" | "tail";
}): string[] {
  const prefix = input.text.length > 0 ? `${input.label} ` : input.label;
  const prefixWidth = measureVisibleWidth(prefix);
  const width = Math.max(1, input.terminalWidth);
  const continuationWidth = Math.max(1, width - prefixWidth);
  const bodyLines = input.text.length === 0 ? [""] : wrapText(input.text, continuationWidth);
  const lines = bodyLines.map((line, index) =>
    index === 0 ? `${prefix}${line}` : `${" ".repeat(prefixWidth)}${line}`
  );
  return capActiveTurnLines(lines, input.maxLines, input.overflow);
}

function capActiveTurnLines(lines: string[], maxLines: number, overflow: "head" | "tail"): string[] {
  const limit = Math.max(1, maxLines);
  if (lines.length <= limit) return lines;
  if (overflow === "head" || limit === 1) return lines.slice(0, limit);
  return [lines[0], ...lines.slice(-(limit - 1))];
}

function activeTurnGlyph(
  renderer: SessionRenderer,
  kind: "queued" | "steer" | "interrupt" | "command"
): string {
  const unicode = renderer.capabilities.supportsUnicode;
  if (kind === "queued") return unicode ? "↳" : "->";
  if (kind === "steer") return unicode ? "↯" : "!";
  if (kind === "interrupt") return unicode ? "✕" : "x";
  return unicode ? "⌘" : "$";
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

export function renderBottomChromeRule(tokens: ResolvedTokens, useColor: boolean, useUnicode: boolean, width: number): string {
  const ruleChar = useUnicode ? "─" : "-";
  const ruleLen = Math.max(0, width);
  const rule = ruleChar.repeat(ruleLen);
  if (!useColor) return rule;
  return ansiColor(rule, tokens.contract.text.secondary);
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
