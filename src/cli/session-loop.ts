import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import { homedir } from "node:os";
import type { Runtime } from "../runtime/create-runtime.js";
import type { RuntimeEvent } from "../contracts/runtime-event.js";
import type { SessionEvent } from "../contracts/session.js";
import type { ToolResult } from "../contracts/tool.js";
import type { ModelSwitchContext } from "../providers/model-switch-resolver.js";
import { renderSessionRecallResult } from "../session/session-recall-service.js";
import { renderSessionCompactionResult } from "../prompt/session-compression-service.js";
import { createProviderModelSelectionFlow } from "../providers/provider-model-selection-flow.js";
import {
  applyModelSwitchPrimaryRoute,
  resolveEffectiveSessionModelOverride,
  resolveModelSwitchRequest
} from "../providers/model-switch-resolver.js";
import { runCronCommand } from "../cron/cron-command.js";
import { createRuntimeCronRunner, tickCron } from "../cron/cron-runner.js";
import { CronStore } from "../cron/cron-store.js";
import { storeCapabilitySecret, type SetupNeededMetadata } from "../setup/capability-setup.js";
import { defaultImageModel } from "../contracts/image-generation.js";
import { createReadlinePrompt, type Prompt } from "./readline-prompt.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import { renderSlashMenu, renderToolsMenu, buildSlashMenuViewModel, buildSlashCompletionViewModel, buildToolsMenuViewModel, isImplementedSlashCommand } from "./slash-menu.js";
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
import type { SessionStatusRailViewModel, SlashMenuViewModel, ToolActivityRailEvent, ViewModel } from "../contracts/view-model.js";
import type { TerminalCapabilities } from "../contracts/ui.js";
import { measureVisibleWidth } from "../ui/renderers/layout.js";
import { chromeCopy } from "../ui/cli-ui-copy.js";
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
  locale?: import("../contracts/ui.js").UiLocale;
  capabilities?: TerminalCapabilities;
  cliVoice?: {
    recorder?: CliVoiceRecorder;
    envOptions?: CliVoiceEnvironmentOptions;
    playbackCommandExists?: (command: string) => Promise<boolean>;
  };
};

type ContextUsageSnapshot = NonNullable<SessionStatusRailViewModel["contextUsage"]>;
type StatusRailTimerMode = "idle" | "active-turn" | "last-turn";

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

export class BottomChromeToolActivityAnimator implements ToolActivityRailAnimator {
  readonly #output: NodeJS.WritableStream;
  readonly #renderer: { render(viewModel: import("../contracts/view-model.js").ViewModel): string };
  readonly #streamState: { lastWriteEndedWithNewline: boolean };
  #rows: Array<{ event: ToolActivityRailEvent; active: boolean }> = [];
  #renderedRowCount = 0;

  constructor(options: {
    output: NodeJS.WritableStream;
    renderer: { render(viewModel: import("../contracts/view-model.js").ViewModel): string };
    streamState: { lastWriteEndedWithNewline: boolean };
  }) {
    this.#output = options.output;
    this.#renderer = options.renderer;
    this.#streamState = options.streamState;
  }

  start(event: ToolActivityRailEvent): void {
    this.#upsertRow(event, true);
    this.#redrawRows();
  }

  complete(event: ToolActivityRailEvent): void {
    if (this.#rows.length === 0) {
      this.#writeDurableRow(event);
      return;
    }

    this.#upsertRow(event, false);
    this.#redrawRows();

    if (this.#rows.every((row) => !row.active)) {
      this.#rows = [];
      this.#renderedRowCount = 0;
    }
  }

  cancel(): void {
    if (this.#renderedRowCount > 0) {
      this.#clearRows();
      this.#rows = [];
      this.#renderedRowCount = 0;
      this.#streamState.lastWriteEndedWithNewline = true;
    }
  }

  dispose(): void {
    this.#rows = [];
    this.#renderedRowCount = 0;
  }

  #redrawRows(): void {
    this.#clearRows();
    const vm = buildToolActivityRailViewModel({ events: this.#rows.map((row) => row.event) });
    this.#output.write(`${this.#renderer.render(vm)}\n`);
    this.#renderedRowCount = this.#rows.length;
    this.#streamState.lastWriteEndedWithNewline = true;
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
  const prompt = options.prompt ?? createReadlinePrompt(options.input as NodeJS.ReadStream | undefined ?? defaultInput, output as NodeJS.WriteStream);
  const close = options.close ?? (() => prompt.close?.());
  const bottomChrome = new BottomChromeController({
    output,
    capabilities: renderer.capabilities,
    renderViewModel: (vm) => renderer.render(vm),
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
    let latestContextUsage: ContextUsageSnapshot | undefined;
    let timerMode: StatusRailTimerMode = "idle";
    let activeTurnStartedAtMs: number | undefined;
    let lastCompletedTurnSeconds: number | undefined;
    let pendingCompactionPostTokens: number | undefined;
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
    output.write(`${chromeCopy(renderer.locale).startupPromptHint}\n\n`);

    const promptPrefix = renderer.tokens.contract.branding.promptPrefix ?? `${renderer.tokens.contract.glyph.prompt} `;
    const useColor = renderer.capabilities.supportsColor && renderer.tokens.contract.behavior.allowAnsiColor;
    const useUnicode = renderer.capabilities.supportsUnicode;
    const termWidth = renderer.capabilities.terminalWidth;
    let clearBottomChromeTranscriptSpinner: () => void = () => undefined;
    let bottomChromeOutputSuspended = false;
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

    while (true) {
      let livePromptRows = 1;
      if (bottomChrome.enabled) {
        const idleBottomState = () => buildBottomChromeState({
          runtime,
          renderer,
          slashMenu: pendingSlashCompletion,
          contextUsage: latestContextUsage,
          timing: railTiming()
        });
        bottomChrome.updateState(idleBottomState());
        bottomChrome.startReadlineTicker(idleBottomState, () => livePromptRows);
      } else if (chrome.enabled) {
        chrome.renderChrome(buildPromptChromeState(runtime, renderer, undefined, pendingSlashCompletion, latestContextUsage, railTiming()));
      } else {
        const topRule = renderHorizontalRule(renderer.tokens, useColor, useUnicode, termWidth);
        output.write(`${topRule}\n`);
      }

      const voiceMode = await currentCliVoiceMode({
        runtime,
        homeDir: options.homeDir
      });
      const submittedInput = await readNextCliInput({
        voiceMode,
        prompt,
        promptPrefix,
        renderer,
        useColor,
        runtime,
        output,
        homeDir: options.homeDir,
        workspaceRoot: options.workspaceRoot,
        cliVoice: options.cliVoice,
        onPromptResolved: () => {
          if (bottomChrome.enabled) {
            bottomChrome.stopTicker();
          }
        },
        onPromptRowsChange: (rows) => {
          livePromptRows = rows;
        }
      });
      const text = submittedInput.text;

      const submittedPromptRows = submittedPromptLineCount(renderer.capabilities, submittedInput);
      if (bottomChrome.enabled) {
        bottomChrome.stopTicker();
        bottomChrome.clearForReadline(submittedPromptRows);
      } else if (chrome.enabled) {
        chrome.clearChrome(submittedPromptRows);
      } else {
        const topRule = renderHorizontalRule(renderer.tokens, useColor, useUnicode, termWidth);
        output.write(`${topRule}\n`);
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
          pendingSlashCompletion = buildSlashCompletionViewModel(runtime, text);
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
          onSessionCompacted: ({ postTokens }) => applyCompactionRailReset(postTokens)
        });

        if (typeof shouldExit !== "boolean") {
          await runtime.dispose();
          runtime = shouldExit.runtime;
          latestContextUsage = undefined;
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
      while (retryText !== undefined) {
        activeTurn = new AbortController();
        const turnStartedAtMs = now();
        activeTurnStartedAtMs = turnStartedAtMs;
        lastCompletedTurnSeconds = undefined;
        timerMode = "active-turn";
        const streamState = { lastWriteEndedWithNewline: true };
        const turnOutput = { spinnerPhase: undefined as string | undefined, hasOutput: false, lastOutputWasSpinner: false };
        let bottomChromeTranscriptSpinnerLineCount = 0;
        let bottomChromeTranscriptSpinnerTicker: ReturnType<typeof setInterval> | undefined;
        let bottomChromeTranscriptSpinnerPhase: string | undefined;
        let currentPhase: string | undefined;
        let turnWasCancelled = false;
        const runningBottomState = () => buildBottomChromeState({
          runtime,
          renderer,
          contextUsage: latestContextUsage,
          timing: railTiming(),
          phase: currentPhase,
          promptText: text
        });

        currentAnimator = new ToolActivityAnimator({
          output,
          renderer,
          streamState,
          enabled: !bottomChrome.enabled && renderer.capabilities.isTTY && renderer.capabilities.supportsAnimation && !renderer.capabilities.isCI && !renderer.capabilities.isDumb,
        });
        const bottomChromeToolActivityAnimator = new BottomChromeToolActivityAnimator({
          output,
          renderer,
          streamState,
        });

        const supportsBottomChromeTranscriptSpinnerAnimation =
          renderer.capabilities.supportsAnimation
          && !renderer.capabilities.isCI
          && !renderer.capabilities.isDumb;

        const clearBottomChromeTranscriptSpinnerLine = () => {
          if (!bottomChrome.enabled || bottomChromeTranscriptSpinnerLineCount === 0) {
            return;
          }
          const clear = () => {
            output.write(clearTranscriptBlock(bottomChromeTranscriptSpinnerLineCount));
          };
          if (bottomChromeOutputSuspended) {
            clear();
          } else {
            bottomChrome.writeAboveChromeSync(clear);
          }
          bottomChromeTranscriptSpinnerLineCount = 0;
          streamState.lastWriteEndedWithNewline = true;
          turnOutput.lastOutputWasSpinner = false;
        };

        const stopBottomChromeTranscriptSpinner = () => {
          if (bottomChromeTranscriptSpinnerTicker !== undefined) {
            clearInterval(bottomChromeTranscriptSpinnerTicker);
            bottomChromeTranscriptSpinnerTicker = undefined;
          }
          bottomChromeTranscriptSpinnerPhase = undefined;
          clearBottomChromeTranscriptSpinnerLine();
        };
        clearBottomChromeTranscriptSpinner = stopBottomChromeTranscriptSpinner;

        const renderBottomChromeTranscriptSpinnerFrame = () => {
          if (!bottomChrome.enabled || bottomChromeTranscriptSpinnerPhase === undefined) {
            return;
          }
          const spinnerText = renderer.render(buildActiveTurnSpinnerViewModel({ phase: bottomChromeTranscriptSpinnerPhase }));
          const spinnerLines = spinnerText.split("\n").filter((line) => line.length > 0);
          bottomChrome.writeAboveChromeSync(() => {
            if (bottomChromeTranscriptSpinnerLineCount > 0) {
              output.write(clearTranscriptBlock(bottomChromeTranscriptSpinnerLineCount));
            }
            output.write(`${spinnerLines.join("\n")}\n`);
          });
          bottomChromeTranscriptSpinnerLineCount = Math.max(1, spinnerLines.length);
          streamState.lastWriteEndedWithNewline = true;
          turnOutput.hasOutput = true;
          turnOutput.lastOutputWasSpinner = true;
        };

        const startBottomChromeTranscriptSpinner = (phase: string) => {
          bottomChromeTranscriptSpinnerPhase = phase;
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
            bottomChrome.updateState(runningBottomState());
            startBottomChromeTranscriptSpinner(phase);
            turnOutput.spinnerPhase = phase;
            return;
          }
          if (chrome.enabled) {
            chrome.renderInlineSpinner(phase, (p) => {
              const activeSpinner = buildActiveTurnSpinnerViewModel({ phase: p });
              const statusRail = buildPromptChromeState(runtime, renderer, undefined, undefined, latestContextUsage, railTiming()).statusRail;
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
            bottomChrome.stopTicker();
            stopBottomChromeTranscriptSpinner();
            currentPhase = undefined;
          } else if (chrome.enabled) {
            chrome.clearInlineSpinner();
          }
          turnOutput.spinnerPhase = undefined;
          turnOutput.lastOutputWasSpinner = false;
        };

        if (bottomChrome.enabled) {
          bottomChrome.startTicker(runningBottomState);
          bottomChrome.updateState(runningBottomState());
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

        const response = await runtime.handle({
            text: retryText,
            channel: "cli",
            signal: activeTurn.signal,
            onEvent: (event) => {
              if (event.kind === "context-usage") {
                latestContextUsage = { filled: event.filled, total: event.total };
                if ((bottomChrome.enabled || chrome.enabled) && turnOutput.spinnerPhase !== undefined) {
                  renderSpinner(turnOutput.spinnerPhase);
                }
              }
              if (event.kind === "session-compacted") {
                pendingCompactionPostTokens = event.postTokens;
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
              if (bottomChrome.enabled) {
                bottomChrome.writeAboveChromeSync(() => {
                  bottomChromeOutputSuspended = true;
                  try {
                    newPhase = renderRuntimeEvent(output, event, activityBuilder, renderer, streamState, runtimeEventBottomChrome, turnOutput, bottomChromeToolActivityAnimator);
                  } finally {
                    bottomChromeOutputSuspended = false;
                  }
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
            clearSpinner();
            currentAnimator?.dispose();
            currentAnimator = undefined;
            clearBottomChromeTranscriptSpinner = () => undefined;
          });
        if (pendingCompactionPostTokens !== undefined) {
          applyCompactionRailReset(pendingCompactionPostTokens);
          pendingCompactionPostTokens = undefined;
        } else {
          lastCompletedTurnSeconds = elapsedSeconds(turnStartedAtMs, now());
          timerMode = "last-turn";
        }
        if (bottomChrome.enabled) {
          bottomChrome.updateState(buildBottomChromeState({
            runtime,
            renderer,
            contextUsage: latestContextUsage,
            timing: railTiming(),
            promptText: turnWasCancelled ? undefined : text
          }));
        }

        const assistantVm = buildAssistantResponseViewModel({
          label: response.label,
          text: response.text,
          matchedSkills: response.matchedSkills,
          progress: response.progress,
        });
        writeAboveChrome(() => {
          output.write(renderer.render(assistantVm));
        });
        if (voiceMode === "tts") {
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
  const profilePaths = resolveProfileStateHome({ homeDir: input.homeDir ?? homedir(), profileId });
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
  onPromptResolved?: () => void;
  onPromptRowsChange?: (rows: number) => void;
}): Promise<SubmittedCliInput> {
  if (input.voiceMode === "off") {
    const echoedPromptPrefix = colorPromptPrefix(input.promptPrefix, input.renderer.tokens, input.useColor);
    const rawText = await input.prompt(echoedPromptPrefix, { onRowsChange: input.onPromptRowsChange });
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
  const profilePaths = resolveProfileStateHome({ homeDir: input.homeDir ?? homedir(), profileId });
  const config = await loadRuntimeConfig({
    workspaceRoot: input.workspaceRoot ?? process.cwd(),
    homeDir: input.homeDir,
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

async function playCliResponseIfEnabled(input: {
  runtime: Runtime;
  text: string;
  homeDir?: string;
  workspaceRoot?: string;
  commandExists?: (command: string) => Promise<boolean>;
  signal?: AbortSignal;
}): Promise<Extract<Awaited<ReturnType<typeof playCliTtsResponse>>, { ok: true }> | undefined> {
  const profileId = await runtimeProfileId(input.runtime);
  const profilePaths = resolveProfileStateHome({ homeDir: input.homeDir ?? homedir(), profileId });
  const config = await loadRuntimeConfig({
    workspaceRoot: input.workspaceRoot ?? process.cwd(),
    homeDir: input.homeDir,
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
  renderer: { render(viewModel: import("../contracts/view-model.js").ViewModel): string };
  workspaceRoot?: string;
  homeDir?: string;
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
      input.output.write(`${input.renderer.render(buildSlashMenuViewModel(input.runtime, args.join(" ")))}\n\n`);
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
      const result = await runCronCommand({
        args,
        store,
        tick: async () => {
          const results = await tickCron({
            store,
            runner: createRuntimeCronRunner({
              runtimeFactory: async () => input.runtime,
              wrapResponse: true,
              disposeRuntime: false,
              workspaceRoot: input.workspaceRoot
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
    case "flow": {
      const result = await handleTaskFlowCommand(input, args);
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
      const profilePaths = resolveProfileStateHome({ homeDir: input.homeDir ?? homedir(), profileId });
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
    notice: (runtime) => [
      `Session model override set: ${resolution.displayName}`,
      "Scope: session",
      "Fallback routes unchanged.",
      "",
      runtime.describe()
    ].join("\n")
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
    homeDir: input.homeDir ?? homedir(),
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
    title: "Choose session model provider",
    options: [
      ...providers.map((candidate) => ({
        value: candidate.id,
        label: candidate.displayName,
        description: candidate.baseUrl ?? candidate.id
      })),
      { value: cancel, label: "Cancel", description: "Keep the current session model" }
    ],
    fallbackPrompt: "Provider number > ",
    selectedLabel: "Provider"
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
    title: "Choose session model",
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
    selectedLabel: "Model"
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

async function handleTaskFlowCommand(input: {
  runtime: Runtime;
  output: NodeJS.WritableStream;
}, args: string[]): Promise<string> {
  if (input.runtime.taskflow === undefined) {
    return "TaskFlow is not available. It requires SQLite session persistence.";
  }

  const { taskflow } = input.runtime;
  const [subcommand = "", ...rest] = args;

  switch (subcommand) {
    case "":
    case "help":
      return [
        "TaskFlow operator commands (v0.8)",
        "  /flow status [flowId]           Show flow status (active flow if omitted)",
        "  /flow pause <flowId> [reason]   Request pause at next safe boundary",
        "  /flow resume <flowId>           Resume a paused/interrupted/waiting flow",
        "  /flow interrupt <flowId> [r]    Interrupt a running flow",
        "  /flow cancel <flowId> [reason]  Cancel a flow",
        "  /flow steer <flowId> <text...>  Inject operator guidance into a flow",
        "  /flow approve <stepId>          Approve a pending approval gate",
        "  /flow reject <stepId> [reason]  Reject a pending approval gate",
        "  /flow retry <stepId>            Retry a failed step",
        "  /flow skip <stepId> [reason]    Skip a skippable step",
        "  /flow checkpoint <flowId> <n>   Create a named checkpoint",
        "  /flow trace [flowId] [limit]    Show flow trace",
        "  /flow compact <flowId>          Compact flow events",
        "  /flow set <flowId>              Set active flow for this session",
        "  /flow unset                     Clear active flow"
      ].join("\n");

    case "status": {
      const flowId = rest[0] ?? taskflow.activeFlowId ?? undefined;
      if (flowId === undefined) return "No active flow. Use /flow set <flowId> or pass a flow ID.";
      const result = await taskflow.dispatcher.dispatch({ command: "/status", flowId });
      return result.ok ? result.message : `Error: ${result.error}`;
    }

    case "pause": {
      const flowId = rest[0];
      if (flowId === undefined) return "Usage: /flow pause <flowId> [reason]";
      const result = await taskflow.dispatcher.dispatch({
        command: "/pause",
        flowId,
        reason: rest.slice(1).join(" ") || undefined,
        operator: "cli"
      });
      return result.ok ? result.message : `Error: ${result.error}`;
    }

    case "resume": {
      const flowId = rest[0];
      if (flowId === undefined) return "Usage: /flow resume <flowId>";
      const result = await taskflow.dispatcher.dispatch({
        command: "/resume",
        flowId,
        operator: "cli"
      });
      return result.ok ? result.message : `Error: ${result.error}`;
    }

    case "interrupt": {
      const flowId = rest[0];
      if (flowId === undefined) return "Usage: /flow interrupt <flowId> [reason]";
      const result = await taskflow.dispatcher.dispatch({
        command: "/interrupt",
        flowId,
        reason: rest.slice(1).join(" ") || undefined,
        operator: "cli"
      });
      return result.ok ? result.message : `Error: ${result.error}`;
    }

    case "cancel": {
      const flowId = rest[0];
      if (flowId === undefined) return "Usage: /flow cancel <flowId> [reason]";
      const result = await taskflow.dispatcher.dispatch({
        command: "/cancel",
        flowId,
        reason: rest.slice(1).join(" ") || undefined,
        operator: "cli"
      });
      return result.ok ? result.message : `Error: ${result.error}`;
    }

    case "steer": {
      const flowId = rest[0];
      if (flowId === undefined) return "Usage: /flow steer <flowId> <guidance>";
      const guidance = rest.slice(1).join(" ");
      if (guidance.length === 0) return "Usage: /flow steer <flowId> <guidance>";
      const result = await taskflow.dispatcher.dispatch({
        command: "/steer",
        flowId,
        guidance,
        operator: "cli"
      });
      return result.ok ? result.message : `Error: ${result.error}`;
    }

    case "approve": {
      const stepId = rest[0];
      if (stepId === undefined) return "Usage: /flow approve <stepId>";
      const result = await taskflow.dispatcher.dispatch({
        command: "/approve",
        stepId,
        operator: "cli"
      });
      return result.ok ? result.message : `Error: ${result.error}`;
    }

    case "reject": {
      const stepId = rest[0];
      if (stepId === undefined) return "Usage: /flow reject <stepId> [reason]";
      const result = await taskflow.dispatcher.dispatch({
        command: "/reject",
        stepId,
        reason: rest.slice(1).join(" ") || undefined,
        operator: "cli"
      });
      return result.ok ? result.message : `Error: ${result.error}`;
    }

    case "retry": {
      const stepId = rest[0];
      if (stepId === undefined) return "Usage: /flow retry <stepId>";
      const result = await taskflow.dispatcher.dispatch({
        command: "/retry",
        stepId,
        operator: "cli"
      });
      return result.ok ? result.message : `Error: ${result.error}`;
    }

    case "skip": {
      const stepId = rest[0];
      if (stepId === undefined) return "Usage: /flow skip <stepId> [reason]";
      const result = await taskflow.dispatcher.dispatch({
        command: "/skip",
        stepId,
        reason: rest.slice(1).join(" ") || undefined,
        operator: "cli"
      });
      return result.ok ? result.message : `Error: ${result.error}`;
    }

    case "checkpoint": {
      const flowId = rest[0];
      if (flowId === undefined) return "Usage: /flow checkpoint <flowId> <name>";
      const name = rest.slice(1).join(" ");
      if (name.length === 0) return "Usage: /flow checkpoint <flowId> <name>";
      const result = await taskflow.dispatcher.dispatch({
        command: "/checkpoint",
        flowId,
        name,
        operator: "cli"
      });
      return result.ok ? result.message : `Error: ${result.error}`;
    }

    case "trace": {
      const flowId = rest[0] ?? taskflow.activeFlowId ?? undefined;
      const limit = flowId !== undefined && rest[1] !== undefined ? parseInt(rest[1], 10) : undefined;
      if (flowId === undefined) return "No active flow. Use /flow set <flowId> or pass a flow ID.";
      const result = await taskflow.dispatcher.dispatch({
        command: "/trace",
        flowId,
        limit: Number.isNaN(limit) ? undefined : limit
      });
      return result.ok ? result.message : `Error: ${result.error}`;
    }

    case "compact": {
      const flowId = rest[0];
      if (flowId === undefined) return "Usage: /flow compact <flowId>";
      const result = await taskflow.dispatcher.dispatch({
        command: "/compact",
        flowId,
        operator: "cli"
      });
      return result.ok ? result.message : `Error: ${result.error}`;
    }

    case "set": {
      const flowId = rest[0];
      if (flowId === undefined) return "Usage: /flow set <flowId>";
      const flow = await taskflow.store.getFlow(flowId);
      if (flow === null) return `Flow not found: ${flowId}`;
      taskflow.setActiveFlowId(flowId);
      return `Active flow set to ${flowId} (status: ${flow.status}).`;
    }

    case "unset": {
      taskflow.setActiveFlowId(null);
      return "Active flow cleared. Normal agent mode.";
    }

    default:
      return `Unknown flow command: ${subcommand}\nUse /flow help for available commands.`;
  }
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

function buildPromptChromeState(
  runtime: Runtime,
  renderer: SessionRenderer,
  activeSpinner?: import("../contracts/view-model.js").ActiveTurnSpinnerViewModel,
  slashMenu?: SlashMenuViewModel,
  contextUsage?: ContextUsageSnapshot,
  timing?: StatusRailTiming
) {
  const modelInfo = typeof runtime.getModelInfo === "function" ? runtime.getModelInfo() : undefined;
  const modelId = modelInfo?.kind === "kv"
    ? String(modelInfo.entries.find((e) => e.key === "model")?.value ?? "unknown")
    : "unknown";
  const contextWindow = modelContextWindow(runtime, modelInfo);
  const sessionElapsedMs = timing === undefined
    ? undefined
    : Math.max(0, timing.now() - timing.sessionStartedAtMs);
  const currentTurnSeconds = currentTurnSecondsForTiming(timing);
  const showTurnState = timing === undefined || timing.mode === "idle";

  return {
    statusRail: buildSessionStatusRailViewModel({
      modelLabel: modelId,
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
  contextUsage?: ContextUsageSnapshot;
  timing?: StatusRailTiming;
  phase?: string;
  promptText?: string;
}): BottomChromeState {
  const chromeState = buildPromptChromeState(
    input.runtime,
    input.renderer,
    undefined,
    input.slashMenu,
    input.contextUsage,
    input.timing
  );
  return {
    statusRail: chromeState.statusRail,
    activeSpinner: chromeState.activeSpinner,
    slashMenu: chromeState.slashMenu,
    prompt: input.promptText === undefined
      ? undefined
      : { text: input.promptText, readOnly: true }
  };
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
