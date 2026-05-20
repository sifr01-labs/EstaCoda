import type { ChannelAttachment } from "../contracts/channel.js";
import type { ContextExpansionResult, ProjectContextSnapshot } from "../contracts/context.js";
import type { IntentRoute } from "../contracts/intent.js";
import type { MemoryPromptContext } from "../contracts/memory.js";
import type { ModelProfile, ProviderRequest, ProviderRoutePreferences, ResolvedModelRoute } from "../contracts/provider.js";
import type { RuntimeEvent, RuntimeEventSink } from "../contracts/runtime-event.js";
import type { SecurityDecision } from "../contracts/security.js";
import type { ReplacementSessionMessage, SessionDB, SessionMessage } from "../contracts/session.js";
import type { LoadedSkill, SkillDefinition, SkillCatalogEntry } from "../contracts/skill.js";
import type { ToolCallPlan } from "../contracts/tool-plan.js";
import type { ToolRiskClass } from "../contracts/tool.js";
import type { AgentProfileMode, AgentResponseLanguage, UiFlavor, UiLanguage } from "../config/runtime-config.js";
import type { SessionCompressionConfig } from "../config/runtime-config.js";
import { PromptCache } from "../prompt/prompt-cache.js";
import {
  assembleProviderContinuationPrompt,
  assembleProviderPrompt
} from "../prompt/prompt-assembly.js";
import { packSessionHistory } from "../prompt/history-packer.js";
import type { CompactResult, SessionCompressionService } from "../prompt/session-compression-service.js";
import { SUMMARY_FORMAT_VERSION } from "../prompt/semantic-compressor.js";
import { estimateMessagesTokensRough } from "../prompt/token-estimator.js";
import { normalizeProviderMessagesStrict } from "../providers/provider-message-normalizer.js";
import type { PromptSemanticCompressionReport } from "../contracts/prompt.js";
import type { ProviderExecutionResult, ProviderExecutor, ProviderRuntimeEvent } from "../providers/provider-executor.js";
import type { OpenAICompatibleToolSchema } from "../tools/tool-schema.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import type { TrajectoryRecorder } from "../trajectory/trajectory-recorder.js";
import type { RunRecorder } from "./run-recorder.js";
import type { ToolPlanRunner } from "./tool-plan-runner.js";
import type { SkillSetupContext } from "./agent-loop.js";
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
  profileId: string;
  trajectoryRecorder: TrajectoryRecorder;
  runRecorder: RunRecorder;
  toolPlanRunner: ToolPlanRunner;
  sessionCompressionService?: Pick<SessionCompressionService, "compactIfNeeded">;
  compressionConfig?: SessionCompressionConfig;
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
  readonly #profileId: string;
  readonly #trajectoryRecorder: TrajectoryRecorder;
  readonly #runRecorder: RunRecorder;
  readonly #toolPlanRunner: ToolPlanRunner;
  readonly #sessionCompressionService: Pick<SessionCompressionService, "compactIfNeeded"> | undefined;
  readonly #compressionConfig: SessionCompressionConfig | undefined;
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
    this.#profileId = options.profileId;
    this.#trajectoryRecorder = options.trajectoryRecorder;
    this.#runRecorder = options.runRecorder;
    this.#toolPlanRunner = options.toolPlanRunner;
    this.#sessionCompressionService = options.sessionCompressionService;
    this.#compressionConfig = options.compressionConfig;
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
      const phase = iteration === 0 ? "initial" : "continuation";
      const execution = phase === "initial"
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
            iteration
          });

      if (execution === undefined) {
        break;
      }

      iterations += 1;
      effectiveProviderExecution = mergeProviderExecutions(effectiveProviderExecution, execution);
      previousProviderExecution = execution;

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

      await this.#runRecorder.recordProviderIteration({
        iteration,
        phase,
        ok: execution.ok,
        toolCalls: execution.toolCalls.length,
        executedTools: providerToolExecutions.length - beforeExecutions,
        exhausted
      });

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
    fallbackText: string;
    onEvent?: RuntimeEventSink;
    toolPlans: ToolCallPlan[];
    iteration: number;
    signal?: AbortSignal;
  }): Promise<ProviderExecutionResult | undefined> {
    if (this.#providerExecutor === undefined || this.#model === undefined || this.#model.provider === "unconfigured") {
      return undefined;
    }

    const sessionHistory = await this.#providerSessionHistory({ allowSemanticCompression: true, signal: input.signal });
    const prompt = assembleProviderPrompt({
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
    this.#lastPromptTokens = prompt.budget.estimatedTokens;
    await this.#runRecorder.recordPromptAssembly(prompt.budget);

    const execution = await this.#providerExecutor.complete(normalizeProviderRequest({
      provider: this.#model.provider,
      model: this.#model.id,
      messages: prompt.messages,
      temperature: 0.2,
      maxTokens: 1_200,
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
      sessionId: this.#sessionId,
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
    }

    await this.#sessionDb.appendEvent(this.#sessionId, {
      kind: "provider-completion",
      iteration: input.iteration,
      ok: execution.ok,
      attempts: execution.attempts.map((attempt) => ({
        provider: attempt.provider,
        model: attempt.model,
        credentialId: attempt.credentialId,
        ok: attempt.ok,
        errorClass: attempt.errorClass
      })),
      fallbackUsed: execution.fallbackUsed,
      usage: execution.response?.usage
    });
    this.#trajectoryRecorder.record("provider-completion", {
      iteration: input.iteration,
      ok: execution.ok,
      attempts: execution.attempts.map((attempt) => ({
        provider: attempt.provider,
        model: attempt.model,
        credentialId: attempt.credentialId,
        ok: attempt.ok,
        errorClass: attempt.errorClass
      })),
      fallbackUsed: execution.fallbackUsed,
      usage: execution.response?.usage
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
    signal?: AbortSignal;
  }): Promise<ProviderExecutionResult | undefined> {
    if (
      this.#providerExecutor === undefined ||
      this.#model === undefined ||
      this.#model.provider === "unconfigured" ||
      input.providerExecution?.ok !== true ||
      input.providerExecution.toolCalls.length === 0 ||
      !input.toolPlans.some((plan) => plan.status === "executed" || isRecoverableToolPlanStatus(plan.status))
    ) {
      return undefined;
    }

    const sessionHistory = await this.#providerSessionHistory({ allowSemanticCompression: false, signal: input.signal });
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
    this.#lastPromptTokens = prompt.budget.estimatedTokens;
    await this.#runRecorder.recordPromptAssembly(prompt.budget);

    const execution = await this.#providerExecutor.complete(normalizeProviderRequest({
      provider: this.#model.provider,
      model: this.#model.id,
      messages: prompt.messages,
      temperature: 0.2,
      maxTokens: 1_200,
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
      sessionId: this.#sessionId,
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
    }

    await this.#sessionDb.appendEvent(this.#sessionId, {
      kind: "provider-continuation",
      iteration: input.iteration,
      ok: execution.ok,
      attempts: execution.attempts.map((attempt) => ({
        provider: attempt.provider,
        model: attempt.model,
        credentialId: attempt.credentialId,
        ok: attempt.ok,
        errorClass: attempt.errorClass
      })),
      toolPlans: input.toolPlans.map((plan) => ({
        id: plan.id,
        tool: plan.tool,
        status: plan.status
      })),
      usage: execution.response?.usage
    });
    this.#trajectoryRecorder.record("provider-continuation", {
      iteration: input.iteration,
      ok: execution.ok,
      attempts: execution.attempts.map((attempt) => ({
        provider: attempt.provider,
        model: attempt.model,
        credentialId: attempt.credentialId,
        ok: attempt.ok,
        errorClass: attempt.errorClass
      })),
      toolPlans: input.toolPlans.map((plan) => ({
        id: plan.id,
        tool: plan.tool,
        status: plan.status
      })),
      usage: execution.response?.usage
    });

    if (!execution.ok) {
      await this.#runRecorder.recordClassifiedFailure(
        { kind: "provider", execution, iteration: input.iteration },
        "provider-continuation"
      );
    }

    return execution;
  }

  async #providerSessionHistory(input: {
    allowSemanticCompression: boolean;
    signal?: AbortSignal;
  }): Promise<{
    messages: Array<Pick<import("../contracts/provider.js").ProviderMessage, "role" | "content">>;
    compactionNotice?: string;
    compression?: PromptSemanticCompressionReport;
  }> {
    const sourceMessages = await this.#sessionDb.listMessages(this.#sessionId);
    const compression = input.allowSemanticCompression
      ? await this.#compactSessionHistoryIfNeeded(sourceMessages, input.signal)
      : undefined;
    const messages = compression?.messages ?? sourceMessages;
    const packed = packSessionHistory(messages);

    if (packed.sourceMessageCount > 0) {
      await this.#sessionDb.appendEvent(this.#sessionId, {
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
      compression: compression?.report
    };
  }

  async #compactSessionHistoryIfNeeded(
    messages: SessionMessage[],
    signal: AbortSignal | undefined
  ): Promise<{
    messages: ReplacementSessionMessage[];
    report: PromptSemanticCompressionReport;
  } | undefined> {
    if (
      this.#sessionCompressionService === undefined ||
      this.#compressionConfig?.enabled !== true ||
      this.#model === undefined
    ) {
      return undefined;
    }

    const preTokens = estimateMessagesTokensRough(messages.map((message) => ({
      role: message.role,
      content: message.content,
      metadata: message.metadata
    })));
    const contextLength = this.#compressionConfig.summaryModelContextLength ?? this.#model.contextWindowTokens ?? 128_000;
    const thresholdTokens = Math.floor(contextLength * this.#compressionConfig.threshold);
    if (preTokens < thresholdTokens) {
      return undefined;
    }

    try {
      const result = await this.#sessionCompressionService.compactIfNeeded({
        profileId: this.#profileId,
        sessionId: this.#sessionId,
        ...(this.#lastPromptTokens > 0 ? { lastPromptTokensEstimated: this.#lastPromptTokens } : {}),
        ...(this.#lastActualPromptTokens === undefined ? {} : { lastActualPromptTokens: this.#lastActualPromptTokens }),
        signal
      });
      return {
        messages: result.messages.map((message) => ({ ...message, metadata: cloneMetadata(message.metadata) })),
        report: compressionReportFromResult(result)
      };
    } catch (error) {
      return {
        messages: messages.map(toReplacementMessage),
        report: {
          triggered: false,
          mode: "none",
          preTokens,
          fallbackUsed: true,
          fallbackReason: `compression-failed: ${errorMessage(error)}`,
          warnings: [`semantic compression failed before prompt assembly: ${errorMessage(error)}`]
        }
      };
    }
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

function compressionReportFromResult(result: CompactResult): PromptSemanticCompressionReport {
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

function toReplacementMessage(message: SessionMessage): ReplacementSessionMessage {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    channel: message.channel,
    metadata: cloneMetadata(message.metadata)
  };
}

function cloneMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return metadata === undefined ? undefined : { ...metadata };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}


function isRecoverableToolPlanStatus(status: ToolCallPlan["status"]): boolean {
  return status === "invalid" || status === "unavailable" || status === "blocked";
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
    ]
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
        errorClass: event.errorClass
      };
  }
}
