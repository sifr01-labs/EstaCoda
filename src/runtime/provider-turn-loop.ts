import type { ChannelAttachment } from "../contracts/channel.js";
import type { ContextExpansionResult, ProjectContextSnapshot } from "../contracts/context.js";
import type { IntentRoute } from "../contracts/intent.js";
import type { MemoryPromptContext } from "../contracts/memory.js";
import type {
  ModelProfile,
  ProviderFinishReason,
  ProviderLoopRuntimeMetadata,
  ProviderRequest,
  ProviderRoutePreferences,
  ProviderUsage,
  ResolvedModelRoute
} from "../contracts/provider.js";
import type { RuntimeEvent, RuntimeEventSink } from "../contracts/runtime-event.js";
import type { SecurityDecision } from "../contracts/security.js";
import type { ReplacementSessionMessage, SessionDB, SessionMessage } from "../contracts/session.js";
import type { LoadedSkill, SkillDefinition, SkillCatalogEntry } from "../contracts/skill.js";
import type { ToolCallPlan } from "../contracts/tool-plan.js";
import type { ToolRiskClass } from "../contracts/tool.js";
import type { AgentProfileMode, AgentResponseLanguage, UiFlavor, UiLanguage } from "../config/runtime-config.js";
import { PromptCache } from "../prompt/prompt-cache.js";
import { estimateTextTokensRough } from "../prompt/token-estimator.js";
import {
  assembleProviderContinuationPrompt,
  assembleProviderPrompt
} from "../prompt/prompt-assembly.js";
import { deriveSessionHistoryBudget, packSessionHistory } from "../prompt/history-packer.js";
import type { CompactResult } from "../prompt/session-compression-service.js";
import { SUMMARY_FORMAT_VERSION } from "../prompt/semantic-compressor.js";
import { normalizeProviderMessagesStrict } from "../providers/provider-message-normalizer.js";
import type { PromptBudgetReport, PromptSemanticCompressionReport } from "../contracts/prompt.js";
import type { ProviderAttempt, ProviderExecutionResult, ProviderExecutor, ProviderRuntimeEvent } from "../providers/provider-executor.js";
import type { OpenAICompatibleToolSchema } from "../tools/tool-schema.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import type { TrajectoryRecorder } from "../trajectory/trajectory-recorder.js";
import type { RunRecorder } from "./run-recorder.js";
import type { ToolPlanRunner } from "./tool-plan-runner.js";
import type { SkillSetupContext } from "./agent-loop.js";
import type { SessionRuntimeContext } from "./session-runtime-context.js";
import { emit, isAborted } from "../utils/runtime-helpers.js";

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
    toolPlans: ToolCallPlan[];
    trustedWorkspace: boolean;
    initialRiskClass: ToolRiskClass;
    signal?: AbortSignal;
  }): Promise<{
    providerExecution: ProviderExecutionResult | undefined;
    toolExecutions: ToolExecutionRecord[];
    iterations: number;
  }> {
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
      const phase = iteration === 0 || retryEmptyInitialResponse ? "initial" : "continuation";
      retryEmptyInitialResponse = false;

      let execution = phase === "initial"
        ? await this.#completeWithProvider({
            ...input,
            iteration
          })
        : await this.#continueProviderAfterTools({
          ...input,
          toolExecutions: [
            ...input.toolExecutions,
            ...providerToolExecutions
          ],
          providerExecution: previousProviderExecution,
          iteration,
          emptyResponseNudge: pendingEmptyResponseNudge
        });
      pendingEmptyResponseNudge = false;

      if (execution === undefined) {
        break;
      }

      iterations += 1;

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
        iteration + 1 >= this.#budgets.maxProviderIterations ||
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
        iteration + 1 < this.#budgets.maxProviderIterations
      ) {
        postToolEmptyRetried = true;
        pendingEmptyResponseNudge = true;
        effectiveProviderExecution = mergeProviderExecutions(effectiveProviderExecution, execution);
        previousProviderExecution = execution;
        continue;
      }

      const successfulEmptyWithoutTools =
        execution.ok === true &&
        execution.toolCalls.length === 0 &&
        execution.response?.content.trim().length === 0;

      if (
        successfulEmptyWithoutTools &&
        emptyContentRetries < 3 &&
        iteration + 1 < this.#budgets.maxProviderIterations
      ) {
        emptyContentRetries += 1;
        if (phase === "initial") {
          retryEmptyInitialResponse = true;
          effectiveProviderExecution = mergeProviderExecutions(effectiveProviderExecution, execution);
          previousProviderExecution = execution;
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
    toolPlans: ToolCallPlan[];
    iteration: number;
    signal?: AbortSignal;
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
    this.#lastPromptTokens = prompt.budget.estimatedTokens;
    await this.#runRecorder.recordPromptAssembly(prompt.budget);
    await emitContextUsage(input.onEvent, prompt.budget, "assembled-prompt");

    const execution = await this.#providerExecutor.complete(normalizeProviderRequest({
      provider: this.#model.provider,
      model: this.#model.id,
      messages: prompt.messages,
      temperature: 0.2,
      tools: this.#model.supportsTools && input.providerTools.length > 0
        ? input.providerTools
        : undefined
    }), {
      requireTools: input.providerTools.length > 0,
      requireVision: false,
      requireStructuredOutput: false,
      providerOrder: [this.#model.provider],
      ...this.#providerPreferences
    }, {
      sessionId: this.#currentSessionId(),
      stream: true,
      signal: input.signal,
      primaryRoute: this.#primaryModelRoute,
      fallbackChain: this.#modelFallbackRoutes,
      onEvent: async (event) => {
        await emit(input.onEvent, mapProviderRuntimeEvent(event));
      }
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
    iteration: number;
    emptyResponseNudge?: boolean;
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
    this.#lastPromptTokens = prompt.budget.estimatedTokens;
    await this.#runRecorder.recordPromptAssembly(prompt.budget);
    await emitContextUsage(input.onEvent, prompt.budget, "assembled-prompt");

    const execution = await this.#providerExecutor.complete(normalizeProviderRequest({
      provider: this.#model.provider,
      model: this.#model.id,
      messages: prompt.messages,
      temperature: 0.2,
      tools: this.#model.supportsTools && input.providerTools.length > 0
        ? input.providerTools
        : undefined
    }), {
      requireTools: input.providerTools.length > 0,
      requireVision: false,
      requireStructuredOutput: false,
      providerOrder: [this.#model.provider],
      ...this.#providerPreferences
    }, {
      sessionId: this.#currentSessionId(),
      stream: true,
      signal: input.signal,
      primaryRoute: this.#primaryModelRoute,
      fallbackChain: this.#modelFallbackRoutes,
      onEvent: async (event) => {
        await emit(input.onEvent, mapProviderRuntimeEvent(event));
      }
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

  async #providerSessionHistory(): Promise<{
    messages: Array<Pick<import("../contracts/provider.js").ProviderMessage, "role" | "content">>;
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
