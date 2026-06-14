import type { ChannelAttachment } from "../contracts/channel.js";
import type { ContextExpansionResult, ProjectContextSnapshot } from "../contracts/context.js";
import type { IntentRoute } from "../contracts/intent.js";
import type { MemoryPromptContext } from "../contracts/memory.js";
import type {
  ModelProfile,
  ProviderFinishReason,
  ProviderLoopRuntimeMetadata,
  ProviderMessage,
  ProviderRequest,
  ProviderResponse,
  ProviderRoutePreferences,
  ProviderUsage,
  ResolvedModelRoute
} from "../contracts/provider.js";
import type { RuntimeEvent, RuntimeEventSink } from "../contracts/runtime-event.js";
import type { SecurityDecision } from "../contracts/security.js";
import type { ReplacementSessionMessage, SessionDB, SessionMessage, StructuredToolHistoryDiagnosticEvent } from "../contracts/session.js";
import type { LoadedSkill, SkillDefinition, SkillCatalogEntry } from "../contracts/skill.js";
import type { ToolCallPlan } from "../contracts/tool-plan.js";
import type { ToolRiskClass } from "../contracts/tool.js";
import type { AgentProfileMode, AgentResponseLanguage, UiFlavor, UiLanguage } from "../config/runtime-config.js";
import { PromptCache } from "../prompt/prompt-cache.js";
import { estimateTextTokensRough } from "../prompt/token-estimator.js";
import {
  assembleProviderContinuationPrompt,
  assembleProviderPrompt,
  type ProviderPromptAssembly
} from "../prompt/prompt-assembly.js";
import { deriveSessionHistoryBudget, packSessionHistory } from "../prompt/history-packer.js";
import type { CompactResult } from "../prompt/session-compression-service.js";
import { SUMMARY_FORMAT_VERSION } from "../prompt/semantic-compressor.js";
import { normalizeProviderMessagesStrict } from "../providers/provider-message-normalizer.js";
import type { PromptBudgetReport, PromptSemanticCompressionReport } from "../contracts/prompt.js";
import type { ProviderAttempt, ProviderExecutionResult, ProviderExecutor, ProviderRuntimeEvent } from "../providers/provider-executor.js";
import type { OpenAICompatibleToolSchema } from "../tools/tool-schema.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import { stableToolCallId } from "../tools/tool-call-planner.js";
import type { TrajectoryRecorder } from "../trajectory/trajectory-recorder.js";
import type { RunRecorder } from "./run-recorder.js";
import type { ToolPlanRunner } from "./tool-plan-runner.js";
import type { SkillSetupContext } from "./agent-loop.js";
import type { SessionRuntimeContext } from "./session-runtime-context.js";
import { emit, isAborted } from "../utils/runtime-helpers.js";

const MAX_PROVIDER_REPLAY_ECHO_CHARS = 32_000;

export type ProviderTurnLoopBudgets = {
  maxProviderIterations: number;
  maxProviderToolCalls: number;
  maxRepeatedToolFailures: number;
  maxProviderWallClockMs: number;
};

export type ProviderTurnLoopOptions = {
  providerExecutor: ProviderExecutor | undefined;
  model: ModelProfile | undefined;
  primaryModelRoute?: ResolvedModelRoute;
  modelFallbackRoutes?: ResolvedModelRoute[];
  providerPreferences: ProviderRoutePreferences;
  sessionDb: SessionDB;
  sessionId: string;
  sessionRuntimeContext?: SessionRuntimeContext;
  profileId: string;
  trajectoryRecorder: TrajectoryRecorder;
  runRecorder: RunRecorder;
  toolPlanRunner: ToolPlanRunner;
  soul: string | undefined;
  memoryPromptContext: MemoryPromptContext | undefined;
  skillsIndex: SkillCatalogEntry[];
  ui: {
    language: UiLanguage;
    flavor: UiFlavor;
    activityLabels: "en" | "ar";
  } | undefined;
  agentProfile: {
    mode: AgentProfileMode;
    responseLanguage: AgentResponseLanguage;
  } | undefined;
  budgets: ProviderTurnLoopBudgets;
};

export class ProviderTurnLoop {
  readonly #providerExecutor: ProviderExecutor | undefined;
  readonly #model: ModelProfile | undefined;
  readonly #primaryModelRoute: ResolvedModelRoute | undefined;
  readonly #modelFallbackRoutes: ResolvedModelRoute[];
  readonly #providerPreferences: ProviderRoutePreferences;
  readonly #sessionDb: SessionDB;
  readonly #sessionId: string;
  readonly #sessionRuntimeContext: SessionRuntimeContext | undefined;
  readonly #trajectoryRecorder: TrajectoryRecorder;
  readonly #runRecorder: RunRecorder;
  readonly #toolPlanRunner: ToolPlanRunner;
  readonly #promptCache: PromptCache;
  readonly #soul: string | undefined;
  readonly #skillsIndex: SkillCatalogEntry[];
  readonly #ui: ProviderTurnLoopOptions["ui"];
  readonly #agentProfile: ProviderTurnLoopOptions["agentProfile"];
  readonly #budgets: ProviderTurnLoopBudgets;
  #lastPromptTokens = 0;
  #lastActualPromptTokens: number | undefined;

  constructor(options: ProviderTurnLoopOptions) {
    this.#providerExecutor = options.providerExecutor;
    this.#model = options.model;
    this.#primaryModelRoute = options.primaryModelRoute;
    this.#modelFallbackRoutes = options.modelFallbackRoutes ?? [];
    this.#providerPreferences = options.providerPreferences;
    this.#sessionDb = options.sessionDb;
    this.#sessionId = options.sessionId;
    this.#sessionRuntimeContext = options.sessionRuntimeContext;
    this.#trajectoryRecorder = options.trajectoryRecorder;
    this.#runRecorder = options.runRecorder;
    this.#toolPlanRunner = options.toolPlanRunner;
    this.#promptCache = new PromptCache();
    this.#soul = options.soul;
    this.#skillsIndex = options.skillsIndex;
    this.#ui = options.ui;
    this.#agentProfile = options.agentProfile;
    this.#budgets = options.budgets;
  }

  canRunProvider(): boolean {
    return this.#providerExecutor !== undefined &&
      this.#model !== undefined &&
      this.#model.provider !== "unconfigured";
  }

  async run(input: {
    userText: string;
    routedText: string;
    selectedSkill: LoadedSkill | SkillDefinition | undefined;
    selectedSkillInstructions: string | undefined;
    selectedSkillResources: LoadedSkill["resources"] | undefined;
    selectedSkillSetup: SkillSetupContext | undefined;
    intent: IntentRoute;
    securityDecision: SecurityDecision;
    toolExecutions: ToolExecutionRecord[];
    context: ContextExpansionResult | undefined;
    projectContext: ProjectContextSnapshot | undefined;
    attachments: ChannelAttachment[] | undefined;
    memoryPromptContext: MemoryPromptContext | undefined;
    providerTools: OpenAICompatibleToolSchema[];
    preflightCompression?: PromptSemanticCompressionReport;
    fallbackText: string;
    onEvent?: RuntimeEventSink;
    onDelta?: (text: string) => void;
    onSegmentBreak?: (reason?: string) => void | Promise<void>;
    toolPlans: ToolCallPlan[];
    trustedWorkspace: boolean;
    initialRiskClass: ToolRiskClass;
    signal?: AbortSignal;
  }): Promise<{
    providerExecution: ProviderExecutionResult | undefined;
    toolExecutions: ToolExecutionRecord[];
    iterations: number;
  }> {
    this.#toolPlanRunner.resetPerTurnBudgets?.();
    const providerToolExecutions: ToolExecutionRecord[] = [];
    let effectiveProviderExecution: ProviderExecutionResult | undefined;
    let previousProviderExecution: ProviderExecutionResult | undefined;
    let iterations = 0;
    const loopStartedAt = Date.now();
    const repeatedFailures = new Map<string, number>();
    let maxObservedRisk = input.initialRiskClass;
    let pendingEmptyResponseNudge = false;
    let postToolEmptyRetried = false;
    let capturedContentWithHousekeepingTools: string | undefined;
    let emptyContentRetries = 0;
    let retryEmptyInitialResponse = false;
    let reasoningOnlyPrefillRetries = 0;
    let pendingReasoningOnlyPrefill = false;
    let retryReasoningOnlyInitialResponse = false;

    for (let iteration = 0; iteration < this.#budgets.maxProviderIterations; iteration += 1) {
      if (isAborted(input.signal)) {
        await this.#runRecorder.recordProviderBudgetExhausted({
          budget: "abort-signal",
          limit: 1,
          observed: 1,
          reason: "Provider loop was cancelled before the next iteration."
        }, input.onEvent);
        await this.#runRecorder.recordClassifiedFailure(
          { kind: "cancellation", reason: "abort signal before iteration" },
          "provider-budget-exhausted"
        );
        break;
      }
      const elapsedMs = Date.now() - loopStartedAt;
      if (elapsedMs > this.#budgets.maxProviderWallClockMs) {
        await this.#runRecorder.recordProviderBudgetExhausted({
          budget: "provider-wall-clock-ms",
          limit: this.#budgets.maxProviderWallClockMs,
          observed: elapsedMs,
          reason: "Provider loop exceeded its wall-clock budget."
        }, input.onEvent);
        await this.#runRecorder.recordClassifiedFailure(
          { kind: "budget", budget: "provider-wall-clock-ms", limit: this.#budgets.maxProviderWallClockMs, observed: elapsedMs, reason: "Provider loop exceeded its wall-clock budget." },
          "provider-budget-exhausted"
        );
        break;
      }
      if (providerToolExecutions.length >= this.#budgets.maxProviderToolCalls) {
        await this.#runRecorder.recordProviderBudgetExhausted({
          budget: "provider-tool-calls",
          limit: this.#budgets.maxProviderToolCalls,
          observed: providerToolExecutions.length,
          reason: "Provider loop reached its tool-call execution budget."
        }, input.onEvent);
        await this.#runRecorder.recordClassifiedFailure(
          { kind: "budget", budget: "provider-tool-calls", limit: this.#budgets.maxProviderToolCalls, observed: providerToolExecutions.length, reason: "Provider loop reached its tool-call execution budget." },
          "provider-budget-exhausted"
        );
        break;
      }
      const phase: "initial" | "continuation" = iteration === 0 || retryEmptyInitialResponse || retryReasoningOnlyInitialResponse
        ? "initial"
        : "continuation";
      retryEmptyInitialResponse = false;
      retryReasoningOnlyInitialResponse = false;

      let execution = phase === "initial"
        ? await this.#completeWithProvider({
            ...input,
            iteration,
            loopStartedAt,
            reasoningOnlyPrefill: pendingReasoningOnlyPrefill
          })
        : await this.#continueProviderAfterTools({
          ...input,
          toolExecutions: [
            ...input.toolExecutions,
            ...providerToolExecutions
          ],
          providerExecution: previousProviderExecution,
          iteration,
          loopStartedAt,
          emptyResponseNudge: pendingEmptyResponseNudge,
          reasoningOnlyPrefill: pendingReasoningOnlyPrefill
        });
      pendingEmptyResponseNudge = false;
      pendingReasoningOnlyPrefill = false;

      if (execution === undefined) {
        break;
      }

      const consumedProviderIterations = providerIterationCost(execution);
      iterations += consumedProviderIterations;

      if (isTruncatedToolCallRefusalExecution(execution)) {
        await this.#runRecorder.recordProviderIteration({
          iteration,
          phase,
          ok: execution.ok,
          toolCalls: 0,
          executedTools: 0,
          exhausted: false
        });
        effectiveProviderExecution = mergeProviderExecutions(effectiveProviderExecution, execution);
        previousProviderExecution = execution;
        if (consumedProviderIterations > 1) {
          iteration += consumedProviderIterations - 1;
        }
        break;
      }

      if (isReasoningOnlyExecution(execution)) {
        if (isReasoningOnlyLengthExhaustion(execution)) {
          execution = reasoningOnlySafeGuidanceExecution(execution, REASONING_ONLY_LENGTH_EXHAUSTION_MESSAGE);
          await this.#runRecorder.recordProviderIteration({
            iteration,
            phase,
            ok: execution.ok,
            toolCalls: 0,
            executedTools: 0,
            exhausted: false
          });
          effectiveProviderExecution = mergeProviderExecutions(effectiveProviderExecution, execution);
          previousProviderExecution = execution;
          if (consumedProviderIterations > 1) {
            iteration += consumedProviderIterations - 1;
          }
          break;
        }

        if (
          reasoningOnlyPrefillRetries < 2 &&
          iteration + consumedProviderIterations < this.#budgets.maxProviderIterations
        ) {
          reasoningOnlyPrefillRetries += 1;
          pendingReasoningOnlyPrefill = true;
          retryReasoningOnlyInitialResponse = phase === "initial";
          await this.#runRecorder.recordProviderIteration({
            iteration,
            phase,
            ok: execution.ok,
            toolCalls: 0,
            executedTools: 0,
            exhausted: false
          });
          effectiveProviderExecution = mergeProviderExecutions(effectiveProviderExecution, execution);
          previousProviderExecution = execution;
          if (consumedProviderIterations > 1) {
            iteration += consumedProviderIterations - 1;
          }
          continue;
        }

        execution = reasoningOnlySafeGuidanceExecution(execution, REASONING_ONLY_EMPTY_RESPONSE_MESSAGE);
        await this.#runRecorder.recordProviderIteration({
          iteration,
          phase,
          ok: execution.ok,
          toolCalls: 0,
          executedTools: 0,
          exhausted: false
        });
        effectiveProviderExecution = mergeProviderExecutions(effectiveProviderExecution, execution);
        previousProviderExecution = execution;
        if (consumedProviderIterations > 1) {
          iteration += consumedProviderIterations - 1;
        }
        break;
      }

      if (execution.ok === true && execution.toolCalls.length > 0) {
        execution = await this.#persistProviderToolCallTurn(execution);
      }

      const beforeExecutions = providerToolExecutions.length;
      const beforePlans = input.toolPlans.length;
      const loopToolExecutionResult = await this.#toolPlanRunner.executePlans({
        providerExecution: execution,
        toolPlans: input.toolPlans,
        trustedWorkspace: input.trustedWorkspace,
        remainingToolCalls: Math.max(0, this.#budgets.maxProviderToolCalls - providerToolExecutions.length),
        riskBaseline: maxObservedRisk,
        signal: input.signal,
        onEvent: input.onEvent
      });
      const loopToolExecutions = loopToolExecutionResult.executions;
      maxObservedRisk = loopToolExecutionResult.maxObservedRisk;
      providerToolExecutions.push(...loopToolExecutions);
      if (loopToolExecutions.some((execution) => !isHousekeepingToolName(execution.tool.name))) {
        capturedContentWithHousekeepingTools = undefined;
      } else if (
        execution.ok === true &&
        loopToolExecutions.length > 0 &&
        execution.response?.content.trim().length
      ) {
        capturedContentWithHousekeepingTools = execution.response.content;
      }
      if (loopToolExecutions.length > 0 && this.#model !== undefined) {
        await emit(input.onEvent, {
          kind: "context-usage",
          filled: normalizeTokenCount(this.#lastPromptTokens + estimateProviderToolFeedbackTokens(loopToolExecutions)),
          total: normalizeTokenCount(this.#model.contextWindowTokens),
          source: "live-estimate"
        });
      }
      const currentPlans = input.toolPlans.slice(beforePlans);
      const hasRecoverableToolFeedback = currentPlans.some((plan) => isRecoverableToolPlanStatus(plan.status));
      const repeatedFailureBudgetExceeded = this.#recordRepeatedToolFailures(loopToolExecutions, repeatedFailures);
      if (repeatedFailureBudgetExceeded !== undefined) {
        await this.#runRecorder.recordProviderBudgetExhausted({
          budget: "repeated-tool-failures",
          limit: this.#budgets.maxRepeatedToolFailures,
          observed: repeatedFailureBudgetExceeded.count,
          reason: `Tool ${repeatedFailureBudgetExceeded.tool} failed repeatedly with the same outcome.`
        }, input.onEvent);
        await this.#runRecorder.recordClassifiedFailure(
          { kind: "budget", budget: "repeated-tool-failures", limit: this.#budgets.maxRepeatedToolFailures, observed: repeatedFailureBudgetExceeded.count, reason: `Tool ${repeatedFailureBudgetExceeded.tool} failed repeatedly with the same outcome.` },
          "provider-budget-exhausted"
        );
      }
      const exhausted = (
        iteration + consumedProviderIterations >= this.#budgets.maxProviderIterations ||
        providerToolExecutions.length >= this.#budgets.maxProviderToolCalls ||
        repeatedFailureBudgetExceeded !== undefined
      ) && execution.toolCalls.length > 0 && loopToolExecutions.length > 0;

      let terminalPostToolEmpty =
        execution.ok === true &&
        execution.toolCalls.length === 0 &&
        phase === "continuation" &&
        providerToolExecutions.length > 0 &&
        execution.response?.content.trim().length === 0;

      if (
        terminalPostToolEmpty &&
        capturedContentWithHousekeepingTools !== undefined &&
        execution.response !== undefined
      ) {
        execution.response.content = capturedContentWithHousekeepingTools;
        capturedContentWithHousekeepingTools = undefined;
        terminalPostToolEmpty = false;
      }

      if (execution.ok === true && execution.response?.content.trim().length) {
        emptyContentRetries = 0;
      }

      await this.#runRecorder.recordProviderIteration({
        iteration,
        phase,
        ok: execution.ok,
        toolCalls: execution.toolCalls.length,
        executedTools: providerToolExecutions.length - beforeExecutions,
        exhausted
      });

      if (
        terminalPostToolEmpty &&
        !postToolEmptyRetried &&
        iteration + consumedProviderIterations < this.#budgets.maxProviderIterations
      ) {
        postToolEmptyRetried = true;
        pendingEmptyResponseNudge = true;
        effectiveProviderExecution = mergeProviderExecutions(effectiveProviderExecution, execution);
        previousProviderExecution = execution;
        if (consumedProviderIterations > 1) {
          iteration += consumedProviderIterations - 1;
        }
        continue;
      }

      const successfulEmptyWithoutTools =
        execution.ok === true &&
        execution.toolCalls.length === 0 &&
        execution.response?.content.trim().length === 0;

      if (
        successfulEmptyWithoutTools &&
        emptyContentRetries < 3 &&
        iteration + consumedProviderIterations < this.#budgets.maxProviderIterations
      ) {
        emptyContentRetries += 1;
        if (phase === "initial") {
          retryEmptyInitialResponse = true;
          effectiveProviderExecution = mergeProviderExecutions(effectiveProviderExecution, execution);
          previousProviderExecution = execution;
          if (consumedProviderIterations > 1) {
            iteration += consumedProviderIterations - 1;
          }
          continue;
        }
      }

      effectiveProviderExecution = mergeProviderExecutions(effectiveProviderExecution, execution);
      previousProviderExecution = execution;

      if (
        execution.ok !== true ||
        execution.toolCalls.length === 0 ||
        (loopToolExecutions.length === 0 && !hasRecoverableToolFeedback) ||
        exhausted
      ) {
        if (exhausted && execution.ok === true) {
          await this.#runRecorder.recordClassifiedFailure(
            { kind: "loop-exhausted", reason: "max iterations or tool calls reached with pending work", iterations: iteration + 1 },
            "provider-iteration"
          );
        }
        break;
      }

      if (consumedProviderIterations > 1) {
        iteration += consumedProviderIterations - 1;
      }
    }

    return {
      providerExecution: effectiveProviderExecution,
      toolExecutions: providerToolExecutions,
      iterations
    };
  }

  #recordRepeatedToolFailures(
    executions: ToolExecutionRecord[],
    repeatedFailures: Map<string, number>
  ): { tool: string; count: number } | undefined {
    for (const execution of executions) {
      if (execution.result?.ok !== false) {
        continue;
      }

      const key = `${execution.tool.name}:${execution.result.content.slice(0, 160)}`;
      const count = (repeatedFailures.get(key) ?? 0) + 1;
      repeatedFailures.set(key, count);

      if (count >= this.#budgets.maxRepeatedToolFailures) {
        return {
          tool: execution.tool.name,
          count
        };
      }
    }

    return undefined;
  }

  async #completeWithProvider(input: {
    userText: string;
    routedText: string;
    selectedSkill: LoadedSkill | SkillDefinition | undefined;
    selectedSkillInstructions: string | undefined;
    selectedSkillResources: LoadedSkill["resources"] | undefined;
    selectedSkillSetup: SkillSetupContext | undefined;
    intent: IntentRoute;
    securityDecision: SecurityDecision;
    toolExecutions: ToolExecutionRecord[];
    context: ContextExpansionResult | undefined;
    projectContext: ProjectContextSnapshot | undefined;
    attachments: ChannelAttachment[] | undefined;
    memoryPromptContext: MemoryPromptContext | undefined;
    providerTools: OpenAICompatibleToolSchema[];
    preflightCompression?: PromptSemanticCompressionReport;
    fallbackText: string;
    onEvent?: RuntimeEventSink;
    onDelta?: (text: string) => void;
    onSegmentBreak?: (reason?: string) => void | Promise<void>;
    toolPlans: ToolCallPlan[];
    iteration: number;
    loopStartedAt: number;
    signal?: AbortSignal;
    reasoningOnlyPrefill?: boolean;
  }): Promise<ProviderExecutionResult | undefined> {
    if (this.#providerExecutor === undefined || this.#model === undefined || this.#model.provider === "unconfigured") {
      return undefined;
    }

    const sessionHistory = await this.#providerSessionHistory();
    const prompt = assembleProviderPrompt({
      ...input,
      model: this.#model,
      cache: this.#promptCache,
      sessionHistory: sessionHistory.messages,
      rawSessionHistory: sessionHistory.rawMessages,
      nativeHistoryRoute: this.#primaryModelRoute,
      nativeHistoryRouteRole: "primary",
      compactionNotice: sessionHistory.compactionNotice,
      compression: input.preflightCompression ?? sessionHistory.compression,
      soul: this.#soul,
      memoryPromptContext: input.memoryPromptContext,
      skillsIndex: this.#skillsIndex,
      selectedSkillResources: input.selectedSkillResources,
      selectedSkillSetup: input.selectedSkillSetup,
      attachments: input.attachments,
      ui: this.#ui,
      agentProfile: this.#agentProfile
    });
    if (input.reasoningOnlyPrefill === true) {
      prompt.messages.push(reasoningOnlyPrefillMessage());
    }
    this.#lastPromptTokens = prompt.budget.estimatedTokens;
    await this.#runRecorder.recordPromptAssembly(prompt.budget);
    await this.#recordNativeHistoryDiagnostics(prompt, "primary");
    await emitContextUsage(input.onEvent, prompt.budget, "assembled-prompt");

    const providerRequest = normalizeProviderRequest({
      provider: this.#model.provider,
      model: this.#model.id,
      messages: prompt.messages,
      temperature: 0.2,
      tools: this.#model.supportsTools && input.providerTools.length > 0
        ? input.providerTools
        : undefined
    });
    const providerPreferences = {
      requireTools: input.providerTools.length > 0,
      requireVision: false,
      requireStructuredOutput: false,
      providerOrder: [this.#model.provider],
      ...this.#providerPreferences
    };
    const execution = await this.#completeProviderRequestWithFinalizationRetries({
      request: providerRequest,
      preferences: providerPreferences,
      sessionId: this.#currentSessionId(),
      iteration: input.iteration,
      loopStartedAt: input.loopStartedAt,
      signal: input.signal,
      onEvent: input.onEvent,
      onDelta: input.onDelta,
      onSegmentBreak: input.onSegmentBreak
    });
    if (execution.response?.usage?.inputTokens !== undefined) {
      this.#lastActualPromptTokens = execution.response.usage.inputTokens;
      await emit(input.onEvent, {
        kind: "context-usage",
        filled: normalizeTokenCount(execution.response.usage.inputTokens),
        total: normalizeTokenCount(prompt.budget.contextWindowTokens),
        source: "provider-actual"
      });
    }

    await this.#sessionDb.appendEvent(this.#currentSessionId(), {
      kind: "provider-completion",
      iteration: input.iteration,
      ok: execution.ok,
      attempts: execution.attempts.map(providerAttemptEventPayload),
      fallbackUsed: execution.fallbackUsed,
      ...providerExecutionEventMetadata(execution)
    });
    this.#trajectoryRecorder.record("provider-completion", {
      iteration: input.iteration,
      ok: execution.ok,
      attempts: execution.attempts.map(providerAttemptEventPayload),
      fallbackUsed: execution.fallbackUsed,
      ...providerExecutionEventMetadata(execution)
    });

    if (!execution.ok) {
      await this.#runRecorder.recordClassifiedFailure(
        { kind: "provider", execution, iteration: input.iteration },
        "provider-completion"
      );
    }

    return execution;
  }

  async #continueProviderAfterTools(input: {
    userText: string;
    routedText: string;
    selectedSkill: LoadedSkill | SkillDefinition | undefined;
    selectedSkillInstructions: string | undefined;
    selectedSkillResources: LoadedSkill["resources"] | undefined;
    selectedSkillSetup: SkillSetupContext | undefined;
    intent: IntentRoute;
    securityDecision: SecurityDecision;
    toolExecutions: ToolExecutionRecord[];
    context: ContextExpansionResult | undefined;
    projectContext: ProjectContextSnapshot | undefined;
    attachments: ChannelAttachment[] | undefined;
    memoryPromptContext: MemoryPromptContext | undefined;
    providerTools: OpenAICompatibleToolSchema[];
    providerExecution: ProviderExecutionResult | undefined;
    toolPlans: ToolCallPlan[];
    fallbackText: string;
    onEvent?: RuntimeEventSink;
    onDelta?: (text: string) => void;
    onSegmentBreak?: (reason?: string) => void | Promise<void>;
    iteration: number;
    loopStartedAt: number;
    emptyResponseNudge?: boolean;
    reasoningOnlyPrefill?: boolean;
    signal?: AbortSignal;
  }): Promise<ProviderExecutionResult | undefined> {
    if (
      this.#providerExecutor === undefined ||
      this.#model === undefined ||
      this.#model.provider === "unconfigured" ||
      input.providerExecution?.ok !== true ||
      (input.providerExecution.toolCalls.length === 0 && input.emptyResponseNudge !== true) ||
      !input.toolPlans.some((plan) => plan.status === "executed" || isRecoverableToolPlanStatus(plan.status))
    ) {
      return undefined;
    }

    const sessionHistory = await this.#providerSessionHistory();
    const prompt = assembleProviderContinuationPrompt({
      ...input,
      model: this.#model,
      cache: this.#promptCache,
      sessionHistory: sessionHistory.messages,
      rawSessionHistory: sessionHistory.rawMessages,
      nativeHistoryRoute: this.#primaryModelRoute,
      nativeHistoryRouteRole: "primary",
      compactionNotice: sessionHistory.compactionNotice,
      compression: sessionHistory.compression,
      soul: this.#soul,
      memoryPromptContext: input.memoryPromptContext,
      skillsIndex: this.#skillsIndex,
      selectedSkillResources: input.selectedSkillResources,
      selectedSkillSetup: input.selectedSkillSetup,
      attachments: input.attachments,
      ui: this.#ui,
      agentProfile: this.#agentProfile
    });
    if (input.emptyResponseNudge === true) {
      prompt.messages.push({
        role: "user",
        content: "You just executed tool calls but returned an empty response. Please process the tool results above and continue with the task."
      });
    }
    if (input.reasoningOnlyPrefill === true) {
      prompt.messages.push(reasoningOnlyPrefillMessage());
    }
    this.#lastPromptTokens = prompt.budget.estimatedTokens;
    await this.#runRecorder.recordPromptAssembly(prompt.budget);
    await this.#recordNativeHistoryDiagnostics(prompt, "primary");
    await emitContextUsage(input.onEvent, prompt.budget, "assembled-prompt");

    const providerRequest = normalizeProviderRequest({
      provider: this.#model.provider,
      model: this.#model.id,
      messages: prompt.messages,
      temperature: 0.2,
      tools: this.#model.supportsTools && input.providerTools.length > 0
        ? input.providerTools
        : undefined
    });
    const providerPreferences = {
      requireTools: input.providerTools.length > 0,
      requireVision: false,
      requireStructuredOutput: false,
      providerOrder: [this.#model.provider],
      ...this.#providerPreferences
    };
    const execution = await this.#completeProviderRequestWithFinalizationRetries({
      request: providerRequest,
      preferences: providerPreferences,
      sessionId: this.#currentSessionId(),
      iteration: input.iteration,
      loopStartedAt: input.loopStartedAt,
      signal: input.signal,
      onEvent: input.onEvent,
      onDelta: input.onDelta,
      onSegmentBreak: input.onSegmentBreak
    });
    if (execution.response?.usage?.inputTokens !== undefined) {
      this.#lastActualPromptTokens = execution.response.usage.inputTokens;
      await emit(input.onEvent, {
        kind: "context-usage",
        filled: normalizeTokenCount(execution.response.usage.inputTokens),
        total: normalizeTokenCount(prompt.budget.contextWindowTokens),
        source: "provider-actual"
      });
    }

    const continuationEvent = {
      kind: "provider-continuation" as const,
      iteration: input.iteration,
      ok: execution.ok,
      attempts: execution.attempts.map(providerAttemptEventPayload),
      toolPlans: input.toolPlans.map((plan) => ({
        id: plan.id,
        tool: plan.tool,
        status: plan.status
      })),
      ...providerExecutionEventMetadata(execution),
      nudge: input.emptyResponseNudge === true
    };
    await this.#sessionDb.appendEvent(this.#currentSessionId(), continuationEvent);
    this.#trajectoryRecorder.record("provider-continuation", {
      iteration: input.iteration,
      ok: execution.ok,
      attempts: execution.attempts.map(providerAttemptEventPayload),
      toolPlans: input.toolPlans.map((plan) => ({
        id: plan.id,
        tool: plan.tool,
        status: plan.status
      })),
      ...providerExecutionEventMetadata(execution),
      nudge: input.emptyResponseNudge === true
    });

    if (!execution.ok) {
      await this.#runRecorder.recordClassifiedFailure(
        { kind: "provider", execution, iteration: input.iteration },
        "provider-continuation"
      );
    }

    return execution;
  }

  async #completeProviderRequestWithFinalizationRetries(input: {
    request: Omit<ProviderRequest, "model"> & { model?: string };
    preferences: ProviderRoutePreferences;
    sessionId: string;
    iteration: number;
    loopStartedAt: number;
    signal?: AbortSignal;
    onEvent?: RuntimeEventSink;
    onDelta?: (text: string) => void;
    onSegmentBreak?: (reason?: string) => void | Promise<void>;
  }): Promise<ProviderExecutionResult> {
    const initial = await this.#completeProviderRequestWithTruncatedToolRetry(input);
    return await this.#continueLengthTruncatedTextResponse({
      ...input,
      initial
    });
  }

  async #completeProviderRequestWithTruncatedToolRetry(input: {
    request: Omit<ProviderRequest, "model"> & { model?: string };
    preferences: ProviderRoutePreferences;
    sessionId: string;
    iteration: number;
    loopStartedAt: number;
    primaryRoute?: ResolvedModelRoute;
    fallbackChain?: ResolvedModelRoute[];
    signal?: AbortSignal;
    onEvent?: RuntimeEventSink;
    onDelta?: (text: string) => void;
    onSegmentBreak?: (reason?: string) => void | Promise<void>;
  }): Promise<ProviderExecutionResult> {
    const primaryRoute = input.primaryRoute ?? this.#primaryModelRoute;
    const fallbackChain = input.fallbackChain ?? this.#modelFallbackRoutes;
    const initialEvents = createProviderToolCallEventBuffer({
      sink: input.onEvent,
      onDelta: input.onDelta,
      onSegmentBreak: input.onSegmentBreak
    });
    const execution = await this.#providerExecutor!.complete(input.request, input.preferences, {
      sessionId: input.sessionId,
      stream: true,
      signal: input.signal,
      primaryRoute,
      fallbackChain,
      onEvent: initialEvents.onEvent
    });

    if (!isLengthTruncatedToolCallExecution(execution)) {
      await initialEvents.flushToolCalls();
      return execution;
    }
    initialEvents.discardToolCalls();

    const originalRouteChain = resolvedRouteChain(primaryRoute, fallbackChain);
    const retryChain = buildRetryRouteChainFromSuccessfulAttempt(execution, originalRouteChain);
    const retryPrimaryRoute = retryChain[0];
    if (retryPrimaryRoute === undefined) {
      return execution;
    }

    if (input.iteration + 1 >= this.#budgets.maxProviderIterations) {
      return truncatedToolRetryRefusal({
        initial: execution,
        provider: (execution.response?.provider ?? input.request.provider ?? this.#model?.provider ?? "unknown") as ProviderResponse["provider"],
        model: execution.response?.model ?? input.request.model ?? "unknown",
        retried: false
      });
    }

    const elapsedMs = Date.now() - input.loopStartedAt;
    if (elapsedMs > this.#budgets.maxProviderWallClockMs) {
      await this.#runRecorder.recordProviderBudgetExhausted({
        budget: "provider-wall-clock-ms",
        limit: this.#budgets.maxProviderWallClockMs,
        observed: elapsedMs,
        reason: "Provider loop exceeded its wall-clock budget before retrying a truncated tool call."
      }, input.onEvent);
      await this.#runRecorder.recordClassifiedFailure(
        { kind: "budget", budget: "provider-wall-clock-ms", limit: this.#budgets.maxProviderWallClockMs, observed: elapsedMs, reason: "Provider loop exceeded its wall-clock budget before retrying a truncated tool call." },
        "provider-budget-exhausted"
      );
      return truncatedToolRetryRefusal({
        initial: execution,
        provider: (execution.response?.provider ?? input.request.provider ?? this.#model?.provider ?? "unknown") as ProviderResponse["provider"],
        model: execution.response?.model ?? input.request.model ?? "unknown",
        retried: false
      });
    }

    const baseMaxTokens = input.request.maxTokens ?? (execution.route ?? retryPrimaryRoute).maxTokens ?? 4096;
    const retryMaxTokens = Math.min(baseMaxTokens * 2, 32768);
    const retryEvents = createProviderToolCallEventBuffer({
      sink: input.onEvent,
      onDelta: input.onDelta,
      onSegmentBreak: input.onSegmentBreak
    });
    const retryExecutionRaw = await this.#providerExecutor!.complete({
      ...input.request,
      maxTokens: retryMaxTokens
    }, input.preferences, {
      sessionId: input.sessionId,
      stream: true,
      signal: input.signal,
      primaryRoute: retryPrimaryRoute,
      fallbackChain: retryChain.slice(1),
      onEvent: retryEvents.onEvent
    });
    const retryExecution = rebaseRetryRouteIdentity(retryExecutionRaw, retryChain, originalRouteChain);

    if (isLengthTruncatedToolCallExecution(retryExecution)) {
      retryEvents.discardToolCalls();
      return truncatedToolRetryRefusal({
        initial: execution,
        retry: retryExecution,
        provider: (retryExecution.response?.provider ?? execution.response?.provider ?? input.request.provider ?? this.#model?.provider ?? "unknown") as ProviderResponse["provider"],
        model: retryExecution.response?.model ?? execution.response?.model ?? input.request.model ?? "unknown",
        retried: true
      });
    }

    await retryEvents.flushToolCalls();
    return mergeTruncatedToolRetryExecutions(execution, retryExecution);
  }

  async #continueLengthTruncatedTextResponse(input: {
    initial: ProviderExecutionResult;
    request: Omit<ProviderRequest, "model"> & { model?: string };
    preferences: ProviderRoutePreferences;
    sessionId: string;
    iteration: number;
    loopStartedAt: number;
    signal?: AbortSignal;
    onEvent?: RuntimeEventSink;
    onDelta?: (text: string) => void;
    onSegmentBreak?: (reason?: string) => void | Promise<void>;
  }): Promise<ProviderExecutionResult> {
    if (!isLengthTruncatedTextExecution(input.initial)) {
      return input.initial;
    }

    const originalRouteChain = resolvedRouteChain(this.#primaryModelRoute, this.#modelFallbackRoutes);
    const executions: ProviderExecutionResult[] = [input.initial];
    let current = input.initial;
    let accumulatedVisibleText = input.initial.response!.content;
    let continuationAttempts = 0;
    let consumedProviderIterations = providerIterationCost(input.initial);
    let exhausted = false;
    let finalFinishReason: ProviderFinishReason | undefined = input.initial.response?.finishReason;

    while (continuationAttempts < MAX_TEXT_CONTINUATION_ATTEMPTS && isLengthTruncatedTextExecution(current)) {
      const retryChain = buildRetryRouteChainFromSuccessfulAttempt(current, originalRouteChain);
      const retryPrimaryRoute = retryChain[0];
      if (retryPrimaryRoute === undefined) {
        exhausted = true;
        break;
      }

      if (input.iteration + consumedProviderIterations >= this.#budgets.maxProviderIterations) {
        exhausted = true;
        break;
      }

      const elapsedMs = Date.now() - input.loopStartedAt;
      if (elapsedMs > this.#budgets.maxProviderWallClockMs) {
        await this.#runRecorder.recordProviderBudgetExhausted({
          budget: "provider-wall-clock-ms",
          limit: this.#budgets.maxProviderWallClockMs,
          observed: elapsedMs,
          reason: "Provider loop exceeded its wall-clock budget before continuing a length-truncated response."
        }, input.onEvent);
        await this.#runRecorder.recordClassifiedFailure(
          { kind: "budget", budget: "provider-wall-clock-ms", limit: this.#budgets.maxProviderWallClockMs, observed: elapsedMs, reason: "Provider loop exceeded its wall-clock budget before continuing a length-truncated response." },
          "provider-budget-exhausted"
        );
        exhausted = true;
        break;
      }

      continuationAttempts += 1;
      const baseMaxTokens = input.request.maxTokens ?? (current.route ?? retryPrimaryRoute).maxTokens ?? 4096;
      const continuationMaxTokens = Math.min(baseMaxTokens * (continuationAttempts + 1), 32768);
      const continuationMessages: ProviderRequest["messages"] = [
        ...input.request.messages,
        {
          role: "assistant",
          content: accumulatedVisibleText
        },
        {
          role: "user",
          content: TEXT_CONTINUATION_PROMPT
        }
      ];
      const continuationExecutionRaw = await this.#completeProviderRequestWithTruncatedToolRetry({
        ...input,
        request: {
          ...input.request,
          messages: continuationMessages,
          maxTokens: continuationMaxTokens
        },
        iteration: input.iteration + consumedProviderIterations,
        primaryRoute: retryPrimaryRoute,
        fallbackChain: retryChain.slice(1)
      });
      const continuationExecution = rebaseRetryRouteIdentity(
        continuationExecutionRaw,
        retryChain,
        originalRouteChain
      );
      executions.push(continuationExecution);
      consumedProviderIterations += providerIterationCost(continuationExecution);

      if (continuationExecution.ok !== true || continuationExecution.response === undefined) {
        finalFinishReason = undefined;
        break;
      }

      accumulatedVisibleText = appendWithExactOverlapTrim(
        accumulatedVisibleText,
        continuationExecution.response.content
      );
      finalFinishReason = continuationExecution.response.finishReason;
      current = continuationExecution;
    }

    if (isLengthTruncatedTextExecution(current)) {
      exhausted = true;
    }

    return mergeTextContinuationExecutions(executions, accumulatedVisibleText, {
      reason: "provider_length",
      attempts: continuationAttempts,
      exhausted,
      initialFinishReason: "length",
      ...(finalFinishReason === undefined ? {} : { finalFinishReason })
    });
  }

  async #providerSessionHistory(): Promise<{
    messages: Array<Pick<import("../contracts/provider.js").ProviderMessage, "role" | "content">>;
    rawMessages: SessionMessage[];
    compactionNotice?: string;
    compression?: PromptSemanticCompressionReport;
  }> {
    const sourceMessages = await this.#sessionDb.listMessages(this.#currentSessionId());
    const messages = sourceMessages;
    const packed = packSessionHistory(messages, {
      maxEstimatedTokens: deriveSessionHistoryBudget(this.#model?.contextWindowTokens)
    });

    if (packed.sourceMessageCount > 0) {
      await this.#sessionDb.appendEvent(this.#currentSessionId(), {
        kind: "session-history-packed",
        sourceMessageCount: packed.sourceMessageCount,
        summarizedMessageCount: packed.summarizedMessageCount,
        protectedMessageCount: packed.protectedMessageCount,
        protectedToolPairCount: packed.protectedToolPairCount,
        estimatedTokens: packed.estimatedTokens,
        summary: packed.summary
      });
      this.#trajectoryRecorder.record("session-history-packed", {
        sourceMessageCount: packed.sourceMessageCount,
        summarizedMessageCount: packed.summarizedMessageCount,
        protectedMessageCount: packed.protectedMessageCount,
        protectedToolPairCount: packed.protectedToolPairCount,
        estimatedTokens: packed.estimatedTokens,
        summary: packed.summary
      });
    }

    return {
      messages: packed.messages,
      rawMessages: messages,
      compactionNotice: semanticCompressionNotice(messages),
      compression: undefined
    };
  }

  lastPromptTokens(): number {
    return this.#lastPromptTokens;
  }

  lastActualPromptTokens(): number | undefined {
    return this.#lastActualPromptTokens;
  }

  #currentSessionId(): string {
    return this.#sessionRuntimeContext?.currentSessionId() ?? this.#sessionId;
  }

  async #recordNativeHistoryDiagnostics(prompt: ProviderPromptAssembly, routeRole: string): Promise<void> {
    for (const diagnostic of prompt.nativeHistoryDiagnostics ?? []) {
      await this.#runRecorder.recordStructuredToolHistoryDiagnostic({
        ...diagnostic,
        routeRole: diagnostic.routeRole ?? routeRole
      });
    }

    const serialized = nativeHistorySerializedDiagnostic(prompt.messages, this.#primaryModelRoute, this.#model, routeRole);
    if (serialized !== undefined) {
      await this.#runRecorder.recordStructuredToolHistoryDiagnostic(serialized);
    }
  }

  async #persistProviderToolCallTurn(execution: ProviderExecutionResult): Promise<ProviderExecutionResult> {
    if (execution.response === undefined) {
      return execution;
    }

    const normalizedToolCalls = execution.toolCalls.map((toolCall) => ({
      ...toolCall,
      id: toolCall.id ?? stableToolCallId(toolCall)
    }));
    const secretIndexes = new Set<number>();
    normalizedToolCalls.forEach((toolCall, index) => {
      if (containsSensitiveToolArguments(toolCall.argumentsText)) {
        secretIndexes.add(index);
      }
    });

    const echoEligibility = providerReplayEchoEligibility(execution);
    const echoValue = execution.response.reasoning;
    const echoMissing = echoEligibility.required && (typeof echoValue !== "string" || echoValue.length === 0);
    const echoOversized = echoEligibility.required &&
      typeof echoValue === "string" &&
      echoValue.length > MAX_PROVIDER_REPLAY_ECHO_CHARS;
    const nativeReplaySafe = secretIndexes.size === 0 && !echoMissing && !echoOversized;
    const providerToolCalls = normalizedToolCalls.map((toolCall, index) => ({
      id: toolCall.id!,
      name: toolCall.name ?? "",
      ...(!nativeReplaySafe
        ? (secretIndexes.has(index) ? { argumentsRedacted: true as const } : {})
        : toolCall.argumentsText === undefined ? {} : { argumentsText: toolCall.argumentsText })
    }));
    const providerReplayEcho = nativeReplaySafe &&
      echoEligibility.required &&
      echoEligibility.providerFamily !== undefined &&
      typeof echoValue === "string"
      ? {
          field: "reasoning_content" as const,
          value: echoValue,
          providerFamily: echoEligibility.providerFamily,
          apiMode: "openai_chat_completions" as const,
          chars: echoValue.length
        }
      : undefined;

    await this.#sessionDb.appendMessage({
      sessionId: this.#currentSessionId(),
      role: "agent",
      content: execution.response.content,
      metadata: {
        kind: "provider-tool-call-turn",
        nativeReplaySafe,
        providerToolCalls,
        provider: execution.response.provider,
        model: execution.response.model,
        ...(execution.routeRole === undefined ? {} : { routeRole: execution.routeRole }),
        ...(execution.attemptedRouteIndex === undefined ? {} : { attemptedRouteIndex: execution.attemptedRouteIndex }),
        ...(execution.response.reasoningMetadata === undefined ? {} : { reasoningMetadata: execution.response.reasoningMetadata }),
        ...(providerReplayEcho === undefined ? {} : { providerReplayEcho })
      }
    });
    const unsafeDiagnostic = unsafeProviderToolCallTurnDiagnostic(execution, {
      nativeReplaySafe,
      callCount: normalizedToolCalls.length,
      secretBearingCalls: secretIndexes.size,
      echoMissing,
      echoOversized
    });
    if (unsafeDiagnostic !== undefined) {
      await this.#runRecorder.recordStructuredToolHistoryDiagnostic(unsafeDiagnostic);
    }

    return {
      ...execution,
      toolCalls: normalizedToolCalls
    };
  }
}

function containsSensitiveToolArguments(argumentsText: string | undefined): boolean {
  if (argumentsText === undefined || argumentsText.length === 0) {
    return false;
  }

  return SENSITIVE_ARGUMENT_PATTERNS.some((pattern) => pattern.test(argumentsText));
}

const SENSITIVE_ARGUMENT_PATTERNS = [
  /["']?\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|password|passwd|secret|authorization)\b["']?\s*[:=]/iu,
  /\bauthorization\b\s*[:=]\s*["']?(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/iu,
  /\bbearer\s+[A-Za-z0-9._~+/=-]+/iu,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
  /\b(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|DEEPSEEK_API_KEY|KIMI_API_KEY|OPENROUTER_API_KEY|GOOGLE_API_KEY)\b/u,
  /\b(?:sk-proj-|sk-ant-|sk-|ghp_|github_pat_)[A-Za-z0-9_\-]+/u
];

function providerReplayEchoEligibility(execution: ProviderExecutionResult): {
  required: boolean;
  providerFamily?: "deepseek" | "kimi" | "mimo";
} {
  const route = execution.route;
  if (route === undefined || route.apiMode !== "openai_chat_completions" || route.profile.supportsTools !== true) {
    return { required: false };
  }

  const metadata = route as ResolvedModelRoute & {
    supportsNativeToolHistory?: boolean;
    requiresReasoningEcho?: boolean;
    reasoningEchoField?: "reasoning_content" | "reasoning";
    reasoningEchoRequiredForToolCalls?: boolean;
    reasoningEchoProviderFamily?: "deepseek" | "kimi" | "mimo";
  };

  if (
    metadata.supportsNativeToolHistory !== true ||
    metadata.requiresReasoningEcho !== true ||
    metadata.reasoningEchoField !== "reasoning_content" ||
    metadata.reasoningEchoRequiredForToolCalls !== true
  ) {
    return { required: false };
  }

  const providerFamily = metadata.reasoningEchoProviderFamily ?? inferReasoningEchoProviderFamily(route.provider, route.id);
  return providerFamily === undefined
    ? { required: false }
    : { required: true, providerFamily };
}

function nativeHistorySerializedDiagnostic(
  messages: ProviderMessage[],
  route: ResolvedModelRoute | undefined,
  model: ModelProfile | undefined,
  routeRole: string
): StructuredToolHistoryDiagnosticEvent | undefined {
  const assistantToolMessages = messages.filter((message) =>
    message.role === "assistant" &&
    Array.isArray(message.toolCalls) &&
    message.toolCalls.length > 0
  );
  if (assistantToolMessages.length === 0) {
    return undefined;
  }

  const base = nativeHistoryRouteDiagnosticBase(route, model, routeRole);
  const metadata = nativeHistoryRouteMetadata(route);
  const requiresEcho = metadata.requiresReasoningEcho === true &&
    metadata.reasoningEchoField === "reasoning_content" &&
    metadata.reasoningEchoRequiredForToolCalls === true;
  const echoMessages = assistantToolMessages.filter((message) =>
    message.providerReplayEcho !== undefined &&
    message.providerReplayEcho.providerFamily === metadata.reasoningEchoProviderFamily &&
    message.providerReplayEcho.apiMode === "openai_chat_completions"
  ).length;
  const echoMissing = requiresEcho ? assistantToolMessages.length - echoMessages : 0;

  if (echoMissing > 0) {
    return {
      kind: "structured-tool-history-skipped",
      ...base,
      nativePairs: assistantToolMessages.length,
      echoMissing,
      reason: "missing_echo"
    };
  }

  return {
    kind: "structured-tool-history-serialized",
    ...base,
    nativePairs: assistantToolMessages.length,
    echoMessages
  };
}

function unsafeProviderToolCallTurnDiagnostic(
  execution: ProviderExecutionResult,
  input: {
    nativeReplaySafe: boolean;
    callCount: number;
    secretBearingCalls: number;
    echoMissing: boolean;
    echoOversized: boolean;
  }
): StructuredToolHistoryDiagnosticEvent | undefined {
  if (input.nativeReplaySafe) {
    return undefined;
  }

  const reason = input.secretBearingCalls > 0
    ? "unsafe_arguments"
    : input.echoOversized
      ? "echo_oversized"
      : input.echoMissing
        ? "missing_echo"
        : "malformed_history";

  return {
    kind: "structured-tool-history-skipped",
    provider: execution.response?.provider,
    model: execution.response?.model,
    ...(execution.routeRole === undefined ? {} : { routeRole: execution.routeRole }),
    nativePairs: input.callCount > 0 ? 1 : 0,
    skippedUnsafeTurns: 1,
    nativeReplayUnsafeTurns: 1,
    ...(input.echoMissing ? { echoMissing: 1 } : {}),
    ...(input.echoOversized ? { echoOversized: 1 } : {}),
    reason
  };
}

function nativeHistoryRouteDiagnosticBase(
  route: ResolvedModelRoute | undefined,
  model: ModelProfile | undefined,
  routeRole: string
): Pick<StructuredToolHistoryDiagnosticEvent, "provider" | "model" | "routeRole"> {
  const provider = route?.provider ?? model?.provider;
  const modelId = route?.id ?? model?.id;
  return {
    ...(provider === undefined ? {} : { provider }),
    ...(modelId === undefined ? {} : { model: modelId }),
    routeRole
  };
}

function nativeHistoryRouteMetadata(route: ResolvedModelRoute | undefined): {
  requiresReasoningEcho?: boolean;
  reasoningEchoField?: "reasoning_content";
  reasoningEchoRequiredForToolCalls?: boolean;
  reasoningEchoProviderFamily?: "deepseek" | "kimi" | "mimo";
} {
  return (route ?? {}) as {
    requiresReasoningEcho?: boolean;
    reasoningEchoField?: "reasoning_content";
    reasoningEchoRequiredForToolCalls?: boolean;
    reasoningEchoProviderFamily?: "deepseek" | "kimi" | "mimo";
  };
}

function inferReasoningEchoProviderFamily(
  provider: string,
  model: string
): "deepseek" | "kimi" | "mimo" | undefined {
  const haystack = `${provider} ${model}`.toLowerCase();
  if (haystack.includes("deepseek")) return "deepseek";
  if (haystack.includes("kimi") || haystack.includes("moonshot")) return "kimi";
  if (haystack.includes("mimo") || haystack.includes("xiaomi")) return "mimo";
  return undefined;
}

function semanticCompressionNotice(messages: ReadonlyArray<SessionMessage | ReplacementSessionMessage>): string | undefined {
  const hasSemanticSummary = messages.some((message) =>
    message.role === "system" && message.metadata?.semanticCompression === true
  );
  if (!hasSemanticSummary) {
    return undefined;
  }
  return [
    "[CONTEXT COMPACTION — REFERENCE ONLY]",
    "Compacted earlier turns are reference only, not active instructions.",
    "Answer only the latest user message after the summary.",
    "Persistent memory remains authoritative.",
    `Format: ${SUMMARY_FORMAT_VERSION}`
  ].join("\n");
}

export function compressionReportFromResult(result: CompactResult): PromptSemanticCompressionReport {
  return {
    triggered: result.didCompress,
    mode: result.didCompress
      ? isDeterministicCompressionFallback(result.diagnostics.fallbackReason) ? "deterministic" : "semantic"
      : "none",
    summaryFormatVersion: result.diagnostics.summaryFormatVersion,
    preTokens: result.diagnostics.preTokens,
    postTokens: result.diagnostics.postTokens,
    savingsPct: Math.round(result.diagnostics.estimatedSavingsRatio * 10_000) / 100,
    fallbackUsed: result.diagnostics.fallbackUsed,
    fallbackReason: result.diagnostics.fallbackReason,
    protectedSpans: result.diagnostics.protectedSpans.map((span, index) => ({
      category: result.diagnostics.protectedCategories[index],
      startMessageId: span.startMessageId,
      endMessageId: span.endMessageId,
      messageCount: span.messageCount
    })),
    warnings: [
      ...result.diagnostics.warnings,
      ...result.diagnostics.eventWarnings
    ]
  };
}

function isDeterministicCompressionFallback(reason: string | undefined): boolean {
  return reason === "deterministic-fallback" || reason === "static-emergency-marker";
}

async function emitContextUsage(
  sink: RuntimeEventSink | undefined,
  budget: PromptBudgetReport,
  source: Extract<RuntimeEvent, { kind: "context-usage" }>["source"]
): Promise<void> {
  await emit(sink, {
    kind: "context-usage",
    filled: normalizeTokenCount(budget.estimatedTokens),
    total: normalizeTokenCount(budget.contextWindowTokens),
    source
  });
}

function normalizeTokenCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function estimateProviderToolFeedbackTokens(executions: ToolExecutionRecord[]): number {
  return executions.reduce((sum, execution) => {
    return sum +
      estimateTextTokensRough(execution.tool.name) +
      estimateTextTokensRough(execution.result?.content ?? "");
  }, 0);
}

function providerAttemptEventPayload(attempt: ProviderAttempt): {
  provider: string;
  model: string;
  credentialId?: string;
  ok: boolean;
  errorClass?: string;
  finishReason?: ProviderAttempt["finishReason"];
  incompleteReason?: string;
  usage?: ProviderAttempt["usage"];
  reasoningMetadata?: ProviderAttempt["reasoningMetadata"];
} {
  return {
    provider: attempt.provider,
    model: attempt.model,
    ok: attempt.ok,
    ...(attempt.credentialId === undefined ? {} : { credentialId: attempt.credentialId }),
    ...(attempt.errorClass === undefined ? {} : { errorClass: attempt.errorClass }),
    ...(attempt.finishReason === undefined ? {} : { finishReason: attempt.finishReason }),
    ...(attempt.incompleteReason === undefined ? {} : { incompleteReason: attempt.incompleteReason }),
    ...(attempt.usage === undefined ? {} : { usage: attempt.usage }),
    ...(attempt.reasoningMetadata === undefined ? {} : { reasoningMetadata: attempt.reasoningMetadata })
  };
}

function providerExecutionEventMetadata(execution: ProviderExecutionResult): {
  finishReason?: ProviderFinishReason;
  incompleteReason?: string;
  usage?: ProviderUsage;
  runtimeMetadata?: ProviderLoopRuntimeMetadata;
} {
  return {
    ...(execution.response?.finishReason === undefined ? {} : { finishReason: execution.response.finishReason }),
    ...(execution.response?.incompleteReason === undefined ? {} : { incompleteReason: execution.response.incompleteReason }),
    ...(execution.response?.usage === undefined ? {} : { usage: execution.response.usage }),
    ...(execution.runtimeMetadata === undefined ? {} : { runtimeMetadata: execution.runtimeMetadata })
  };
}

function isRecoverableToolPlanStatus(status: ToolCallPlan["status"]): boolean {
  return status === "invalid" || status === "unavailable" || status === "blocked";
}

function isHousekeepingToolName(name: string | undefined): boolean {
  return name === "memory.curate" ||
    name === "knowledge.memory.inspect" ||
    name === "skill.observe" ||
    name === "skill.list" ||
    name === "skill.view" ||
    name === "skill.inspect" ||
    name === "skill.usage" ||
    name === "skill.list_proposals" ||
    name === "skill.review_proposals" ||
    name === "skill.review_proposal";
}

const TRUNCATED_TOOL_CALL_REFUSAL = "The model response was truncated while generating tool calls, so EstaCoda refused to execute the incomplete tool arguments. Try again with a higher model.maxTokens value or a narrower request.";
const REASONING_ONLY_LENGTH_EXHAUSTION_MESSAGE = "The model exhausted its output budget while reasoning and did not produce a visible answer. Try again with a higher model.maxTokens value or a narrower request.";
const REASONING_ONLY_EMPTY_RESPONSE_MESSAGE = "The model produced internal reasoning but did not produce a visible answer. Try again with a narrower request.";
const REASONING_ONLY_PREFILL_CONTENT = "I’ll answer directly and only include the final visible answer.";
const TEXT_CONTINUATION_PROMPT = "Your previous response was truncated by the output length limit. Continue exactly where you left off. Do not repeat previous text.";
const MAX_TEXT_CONTINUATION_ATTEMPTS = 3;
const MAX_CONTINUATION_OVERLAP_CHARS = 1000;

function isLengthTruncatedToolCallExecution(execution: ProviderExecutionResult): boolean {
  return execution.ok === true &&
    execution.response?.finishReason === "length" &&
    execution.toolCalls.length > 0;
}

function isLengthTruncatedTextExecution(execution: ProviderExecutionResult): boolean {
  return execution.ok === true &&
    execution.response?.finishReason === "length" &&
    execution.response.content.trim().length > 0 &&
    execution.toolCalls.length === 0;
}

function isReasoningOnlyExecution(execution: ProviderExecutionResult): boolean {
  return execution.ok === true &&
    execution.response !== undefined &&
    execution.response.content.trim().length === 0 &&
    hasReasoning(execution.response) &&
    execution.toolCalls.length === 0;
}

function isReasoningOnlyLengthExhaustion(execution: ProviderExecutionResult): boolean {
  return isReasoningOnlyExecution(execution) &&
    execution.response?.finishReason === "length";
}

function hasReasoning(response: ProviderResponse): boolean {
  return (response.reasoning !== undefined && response.reasoning.length > 0) ||
    response.reasoningMetadata?.present === true;
}

function reasoningOnlyPrefillMessage(): ProviderRequest["messages"][number] {
  return {
    role: "assistant",
    content: REASONING_ONLY_PREFILL_CONTENT
  };
}

function reasoningOnlySafeGuidanceExecution(
  execution: ProviderExecutionResult,
  content: string
): ProviderExecutionResult {
  const response = execution.response;
  return {
    ...execution,
    response: {
      ok: true,
      content,
      model: response?.model ?? execution.route?.id ?? "unknown",
      provider: (response?.provider ?? execution.route?.provider ?? "unknown") as ProviderResponse["provider"],
      ...(response?.finishReason === undefined ? {} : { finishReason: response.finishReason }),
      ...(response?.incompleteReason === undefined ? {} : { incompleteReason: response.incompleteReason }),
      ...(response?.usage === undefined ? {} : { usage: response.usage })
    },
    toolCalls: []
  };
}

function isTruncatedToolCallRefusalExecution(execution: ProviderExecutionResult): boolean {
  return execution.ok === true &&
    execution.toolCalls.length === 0 &&
    execution.runtimeMetadata?.truncation?.kind === "tool_call" &&
    execution.runtimeMetadata.truncation.refused === true &&
    execution.response?.content === TRUNCATED_TOOL_CALL_REFUSAL;
}

function providerIterationCost(execution: ProviderExecutionResult): number {
  let cost = 1;
  if (
    execution.runtimeMetadata?.truncation?.kind === "tool_call" &&
    execution.runtimeMetadata.truncation.retried
  ) {
    cost += 1;
  }
  cost += execution.runtimeMetadata?.continuation?.attempts ?? 0;
  return cost;
}

function createProviderToolCallEventBuffer(input: {
  sink: RuntimeEventSink | undefined;
  onDelta?: (text: string) => void;
  onSegmentBreak?: (reason?: string) => void | Promise<void>;
}): {
  onEvent: (event: ProviderRuntimeEvent) => Promise<void>;
  flushToolCalls: () => Promise<void>;
  discardToolCalls: () => void;
} {
  const toolCallEvents: Extract<ProviderRuntimeEvent, { kind: "provider-tool-call" }>[] = [];

  return {
    async onEvent(event) {
      if (event.kind === "provider-tool-call") {
        toolCallEvents.push(event);
        return;
      }
      await emit(input.sink, mapProviderRuntimeEvent(event));
      if (event.kind === "provider-token") {
        safeProviderDelta(input.onDelta, event.text);
      }
    },
    async flushToolCalls() {
      if (toolCallEvents.length > 0) {
        await safeProviderSegmentBreak(input.onSegmentBreak, "provider-tool-call");
      }
      for (const event of toolCallEvents) {
        await emit(input.sink, mapProviderRuntimeEvent(event));
      }
      toolCallEvents.length = 0;
    },
    discardToolCalls() {
      toolCallEvents.length = 0;
    }
  };
}

function safeProviderDelta(onDelta: ((text: string) => void) | undefined, text: string): void {
  try {
    onDelta?.(text);
  } catch {
    // Streaming observer failures must not alter provider turn execution.
  }
}

async function safeProviderSegmentBreak(
  onSegmentBreak: ((reason?: string) => void | Promise<void>) | undefined,
  reason: string
): Promise<void> {
  try {
    await onSegmentBreak?.(reason);
  } catch {
    // Streaming observer failures must not alter provider turn execution.
  }
}

function resolvedRouteChain(
  primaryRoute: ResolvedModelRoute | undefined,
  fallbackRoutes: ResolvedModelRoute[]
): ResolvedModelRoute[] {
  return primaryRoute === undefined ? [...fallbackRoutes] : [primaryRoute, ...fallbackRoutes];
}

function buildRetryRouteChainFromSuccessfulAttempt(
  execution: ProviderExecutionResult,
  originalRouteChain: ResolvedModelRoute[]
): ResolvedModelRoute[] {
  const attemptedRouteIndex = execution.attemptedRouteIndex;
  if (
    attemptedRouteIndex !== undefined &&
    attemptedRouteIndex >= 0 &&
    attemptedRouteIndex < originalRouteChain.length
  ) {
    return originalRouteChain.slice(attemptedRouteIndex);
  }

  if (execution.route === undefined) {
    return originalRouteChain;
  }

  const routeIndex = originalRouteChain.findIndex((route) => routesMatch(route, execution.route!));
  return routeIndex === -1 ? [execution.route] : originalRouteChain.slice(routeIndex);
}

function routesMatch(a: ResolvedModelRoute, b: ResolvedModelRoute): boolean {
  return a.provider === b.provider &&
    a.id === b.id &&
    a.baseUrl === b.baseUrl &&
    a.apiKeyEnv === b.apiKeyEnv;
}

function rebaseRetryRouteIdentity(
  execution: ProviderExecutionResult,
  retryChain: ResolvedModelRoute[],
  originalRouteChain: ResolvedModelRoute[]
): ProviderExecutionResult {
  const retryRoute = execution.route;
  if (retryRoute === undefined) {
    return execution;
  }

  const originalIndex = originalRouteChain.findIndex((route) => routesMatch(route, retryRoute));
  if (originalIndex === -1) {
    return execution;
  }

  return {
    ...execution,
    attemptedRouteIndex: originalIndex,
    routeRole: originalIndex === 0 ? "primary" : "fallback",
    fallbackUsed: execution.fallbackUsed || originalIndex > 0 || retryChain[0] !== originalRouteChain[0]
  };
}

function mergeTruncatedToolRetryExecutions(
  initial: ProviderExecutionResult,
  retry: ProviderExecutionResult
): ProviderExecutionResult {
  return {
    ...retry,
    fallbackUsed: initial.fallbackUsed || retry.fallbackUsed,
    attempts: [
      ...initial.attempts,
      ...retry.attempts
    ],
    toolCalls: retry.toolCalls,
    runtimeMetadata: mergeProviderRuntimeMetadata(
      mergeProviderRuntimeMetadata(initial.runtimeMetadata, retry.runtimeMetadata),
      {
        truncation: {
          kind: "tool_call",
          retried: true,
          refused: false
        }
      }
    )
  };
}

function truncatedToolRetryRefusal(input: {
  initial: ProviderExecutionResult;
  retry?: ProviderExecutionResult;
  provider: ProviderResponse["provider"];
  model: string;
  retried: boolean;
}): ProviderExecutionResult {
  return {
    ok: true,
    response: {
      ok: true,
      content: TRUNCATED_TOOL_CALL_REFUSAL,
      model: input.model,
      provider: input.provider
    },
    fallbackUsed: input.initial.fallbackUsed || input.retry?.fallbackUsed === true,
    attempts: [
      ...input.initial.attempts,
      ...(input.retry?.attempts ?? [])
    ],
    route: input.retry?.route ?? input.initial.route,
    attemptedRouteIndex: input.retry?.attemptedRouteIndex ?? input.initial.attemptedRouteIndex,
    routeRole: input.retry?.routeRole ?? input.initial.routeRole,
    runtimeMetadata: mergeProviderRuntimeMetadata(
      mergeProviderRuntimeMetadata(input.initial.runtimeMetadata, input.retry?.runtimeMetadata),
      {
        truncation: {
          kind: "tool_call",
          retried: input.retried,
          refused: true
        }
      }
    ),
    toolCalls: []
  };
}

function mergeTextContinuationExecutions(
  executions: ProviderExecutionResult[],
  content: string,
  continuation: NonNullable<ProviderLoopRuntimeMetadata["continuation"]>
): ProviderExecutionResult {
  const initial = executions[0]!;
  const final = executions[executions.length - 1] ?? initial;
  const response = final.response ?? initial.response;

  return {
    ...final,
    ok: true,
    response: {
      ok: true,
      content,
      model: response?.model ?? final.route?.id ?? initial.route?.id ?? "unknown",
      provider: (response?.provider ?? final.route?.provider ?? initial.route?.provider ?? "unknown") as ProviderResponse["provider"],
      ...(response?.finishReason === undefined ? {} : { finishReason: response.finishReason }),
      ...(response?.incompleteReason === undefined ? {} : { incompleteReason: response.incompleteReason }),
      ...(response?.usage === undefined ? {} : { usage: response.usage }),
      ...(response?.reasoningMetadata === undefined ? {} : { reasoningMetadata: response.reasoningMetadata })
    },
    fallbackUsed: executions.some((execution) => execution.fallbackUsed),
    attempts: executions.flatMap((execution) => execution.attempts),
    toolCalls: final.toolCalls,
    route: final.route,
    attemptedRouteIndex: final.attemptedRouteIndex,
    routeRole: final.routeRole,
    runtimeMetadata: mergeRuntimeMetadataList([
      ...executions.map((execution) => execution.runtimeMetadata),
      { continuation }
    ])
  };
}

function mergeRuntimeMetadataList(
  metadata: Array<ProviderExecutionResult["runtimeMetadata"]>
): ProviderExecutionResult["runtimeMetadata"] {
  return metadata.reduce<ProviderExecutionResult["runtimeMetadata"]>((merged, entry) =>
    mergeProviderRuntimeMetadata(merged, entry), undefined);
}

function appendWithExactOverlapTrim(accumulated: string, continuation: string): string {
  if (accumulated.length === 0 || continuation.length === 0) {
    return accumulated + continuation;
  }

  const tail = accumulated.slice(-MAX_CONTINUATION_OVERLAP_CHARS);
  const head = continuation.slice(0, MAX_CONTINUATION_OVERLAP_CHARS);
  const maxOverlap = Math.min(tail.length, head.length);

  for (let length = maxOverlap; length > 0; length -= 1) {
    if (tail.slice(tail.length - length) === head.slice(0, length)) {
      return accumulated + continuation.slice(length);
    }
  }

  return accumulated + continuation;
}

function mergeProviderExecutions(
  initial: ProviderExecutionResult | undefined,
  continuation: ProviderExecutionResult | undefined
): ProviderExecutionResult | undefined {
  if (initial === undefined) {
    return continuation;
  }

  if (continuation === undefined) {
    return initial;
  }

  return {
    ok: continuation.ok,
    response: continuation.response,
    fallbackUsed: initial.fallbackUsed || continuation.fallbackUsed,
    attempts: [
      ...initial.attempts,
      ...continuation.attempts
    ],
    toolCalls: [
      ...initial.toolCalls,
      ...continuation.toolCalls
    ],
    route: continuation.route,
    attemptedRouteIndex: continuation.attemptedRouteIndex,
    routeRole: continuation.routeRole,
    runtimeMetadata: mergeProviderRuntimeMetadata(initial.runtimeMetadata, continuation.runtimeMetadata)
  };
}

function mergeProviderRuntimeMetadata(
  initial: ProviderExecutionResult["runtimeMetadata"],
  continuation: ProviderExecutionResult["runtimeMetadata"]
): ProviderExecutionResult["runtimeMetadata"] {
  if (initial === undefined) {
    return continuation;
  }

  if (continuation === undefined) {
    return initial;
  }

  return {
    ...initial,
    ...continuation
  };
}

function normalizeProviderRequest(request: Omit<ProviderRequest, "model"> & { model?: string }): Omit<ProviderRequest, "model"> & { model?: string } {
  const normalized = normalizeProviderMessagesStrict(request.messages);

  return {
    ...request,
    messages: normalized.messages
  };
}


function mapProviderRuntimeEvent(event: ProviderRuntimeEvent): RuntimeEvent {
  switch (event.kind) {
    case "provider-attempt-start":
      return {
        kind: "provider-attempt",
        provider: event.provider,
        model: event.model,
        fallback: event.fallback
      };
    case "provider-token":
      return {
        kind: "provider-token",
        provider: event.provider,
        model: event.model,
        text: event.text
      };
    case "provider-tool-call":
      return {
        kind: "provider-tool-call",
        provider: event.provider,
        model: event.model,
        index: event.index,
        id: event.id,
        name: event.name,
        argumentsText: event.argumentsText
      };
    case "provider-attempt-end":
      return {
        kind: "provider-result",
        provider: event.provider,
        model: event.model,
        ok: event.ok,
        fallback: event.fallback,
        willFallback: event.willFallback,
        ...(event.errorClass === undefined ? {} : { errorClass: event.errorClass }),
        ...(event.finishReason === undefined ? {} : { finishReason: event.finishReason }),
        ...(event.incompleteReason === undefined ? {} : { incompleteReason: event.incompleteReason }),
        ...(event.usage === undefined ? {} : { usage: event.usage }),
        ...(event.reasoningMetadata === undefined ? {} : { reasoningMetadata: event.reasoningMetadata })
      };
  }
}
