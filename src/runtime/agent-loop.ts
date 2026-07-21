import type { ArtifactRecord } from "../contracts/artifact.js";
import type { ChannelAttachment, ChannelKind } from "../contracts/channel.js";
import type { ContextExpansionResult, ProjectContextSnapshot } from "../contracts/context.js";
import type { IntentRoute } from "../contracts/intent.js";
import type { MemoryConclusion, MemoryFileKind, MemoryProvider, MemoryPromptContext, SkillOutcome } from "../contracts/memory.js";
import type { PromptBudgetReport, PromptSemanticCompressionReport } from "../contracts/prompt.js";
import type { ModelProfile, ProviderMessage, ProviderRequest, ProviderRoutePreferences } from "../contracts/provider.js";
import type { ContextEstimateStage, RuntimeEvent, RuntimeEventSink } from "../contracts/runtime-event.js";
import type { SecurityDecision, SecurityPolicy } from "../contracts/security.js";
import { assessSecurityPolicy, capabilityFirstDefaults } from "../contracts/security.js";
import type { SessionDB } from "../contracts/session.js";
import type { TurnUsageSummary, UsageCostSummary } from "../contracts/usage-cost.js";
import type {
  LoadedSkill,
  SelectedSkillPromptContent,
  SkillConfigField,
  SkillDefinition,
  SkillCatalogEntry,
  SkillRouteFinalOutcomeStatus,
  SkillRouteLlmRerankTelemetry
} from "../contracts/skill.js";
import type { ToolCallPlan } from "../contracts/tool-plan.js";
import type { ToolDefinition, ToolRiskClass, ToolsetName } from "../contracts/tool.js";
import type { AgentProfileMode, AgentResponseLanguage, SessionCompressionConfig, UiFlavor, UiLanguage } from "../config/runtime-config.js";
import type { AgentEvolutionPolicy } from "../contracts/agent-evolution.js";
import type { ContextReferenceExpander } from "../context/context-reference-expander.js";
import type { ProviderExecutionResult, ProviderRuntimeEvent } from "../providers/provider-executor.js";
import type { ToolCallPlanner } from "../tools/tool-call-planner.js";
import type { OpenAICompatibleToolSchema } from "../tools/tool-schema.js";
import type { ToolExecutor, ToolExecutionRecord } from "../tools/tool-executor.js";
import type { TrajectoryRecorder } from "../trajectory/trajectory-recorder.js";
import { resolveProjectFactPromotion, resolveUserPreferencePromotion } from "../memory/memory-promotion.js";
import { isMemoryBudgetOverflowError, type MemoryBudgetOverflowError } from "../memory/memory-store.js";
import { MemoryCurationBusyError } from "../memory/memory-curation-coordinator.js";
import type { MemoryRecallOrchestrator } from "../memory/memory-recall-orchestrator.js";
import type { SkillLearningManager } from "../skills/skill-learning.js";
import type { SkillEvolutionStore } from "../skills/skill-evolution.js";
import { compileSkillPlaybook } from "../skills/skill-playbook-planner.js";
import { createSkillRouteTelemetry, hashSkillRoutePrompt } from "../skills/skill-usage-telemetry.js";
import { compressionReportFromResult, ProviderTurnLoop } from "./provider-turn-loop.js";
import type { IntentRouter } from "./intent-router.js";
import { RunRecorder } from "./run-recorder.js";
import { boundedRerankCandidates, type SkillRouteShadowReranker } from "./skill-route-reranker.js";
import type { RuntimeRouter } from "./runtime-router.js";
import { summarizeAttachments } from "./runtime-router.js";
import { ToolPlanRunner, toolResultStats } from "./tool-plan-runner.js";
import { SkillPlaybookRunner } from "./skill-playbook-runner.js";
import { NativeToolExecutor } from "./native-tool-executor.js";
import type { SessionRuntimeContext } from "./session-runtime-context.js";
import { buildFallbackResponse, cancelledResponse, buildResumeNote, renderToolPlanProgress } from "./response-builders.js";
import { renderProviderExecutionSummary, summarizeProviderExecution } from "./provider-execution-summary.js";
import {
  sanitizeConversationContinuationState,
  updateConversationContinuationState,
  type ConversationContinuationState
} from "./conversation-continuation-state.js";
import { emit, isAborted } from "../utils/runtime-helpers.js";
import { appendArtifactSummary, renderArtifactProgress } from "../utils/artifact-formatting.js";
import { summarizeProviderFailure } from "../providers/provider-diagnostics.js";
import type { SessionCompressionService } from "../prompt/session-compression-service.js";
import { estimateMessagesTokensRough, estimateTextTokensRough } from "../prompt/token-estimator.js";
import { redactSensitiveText } from "../utils/redaction.js";
import type { MemoryCurationService } from "../memory/memory-curation-service.js";
import { emitContextEstimate } from "./context-usage-events.js";
import { unavailableUsageCostSummary, usageCostSummaryFromEntries } from "../providers/provider-usage-projection.js";

export type AgentLoopInput = {
  text: string;
  channel: ChannelKind;
  attachments?: ChannelAttachment[];
  trustedWorkspace?: boolean;
  workspaceRoot?: string;
  onEvent?: RuntimeEventSink;
  onDelta?: (text: string) => void;
  onSegmentBreak?: (reason?: string) => void | Promise<void>;
  signal?: AbortSignal;
  inputMetadata?: Record<string, unknown>;
};

export type AgentLoopResponse = {
  label: string;
  text: string;
  matchedSkills: string[];
  intent: IntentRoute;
  securityDecision: SecurityDecision;
  toolExecutions: ToolExecutionRecord[];
  toolPlans: ToolCallPlan[];
  skillOutcomes: SkillOutcome[];
  artifacts: ArtifactRecord[];
  context: ContextExpansionResult | undefined;
  projectContext: ProjectContextSnapshot | undefined;
  providerExecution?: ProviderExecutionResult;
  turnUsage?: TurnUsageSummary;
  progress: string[];
  setupApprovals?: AgentLoopSetupApprovalRequest[];
};

export type AgentLoopSetupApprovalRequest =
  | AgentLoopPythonCapabilitySetupApprovalRequest;

export type AgentLoopPythonCapabilitySetupApprovalRequest = {
  kind: "managed-python-capability-install";
  skillName?: string;
  capabilityId: string;
  groups: string[];
  packages: string[];
  estimatedInstallSizeMb?: number;
  reason?: string;
  repairCommand?: string;
};

export type AgentLoopOptions = {
  runRecorder: RunRecorder;
  runtimeRouter: RuntimeRouter;
  toolPlanRunner: ToolPlanRunner;
  providerTurnLoop: ProviderTurnLoop;
  skillPlaybookRunner: SkillPlaybookRunner;
  nativeToolExecutor: NativeToolExecutor;
  responseLabel: string;
  intentRouter: IntentRouter;
  securityPolicy: SecurityPolicy;
  trajectoryRecorder: TrajectoryRecorder;
  sessionDb: SessionDB;
  sessionId: string;
  sessionRuntimeContext?: SessionRuntimeContext;
  profileId: string;
  toolExecutor: ToolExecutor;
  toolCallPlanner?: ToolCallPlanner;
  memoryProvider?: MemoryProvider;
  memoryPromptContext?: MemoryPromptContext;
  memoryRecallOrchestrator?: Pick<MemoryRecallOrchestrator, "prepareForTurn">;
  sessionCompressionService?: Pick<SessionCompressionService, "compactIfNeeded">;
  memoryCurationService?: Pick<MemoryCurationService, "observeCompletedTurn" | "checkpoint">;
  compressionConfig?: SessionCompressionConfig;
  model?: ModelProfile;
  providerPreferences?: ProviderRoutePreferences;
  contextReferenceExpander?: ContextReferenceExpander;
  projectContext?: ProjectContextSnapshot;
  providerTools?: OpenAICompatibleToolSchema[];
  soul?: string;
  skillsIndex?: SkillCatalogEntry[];
  skillConfig?: Record<string, Record<string, unknown>>;
  skillLearningManager?: SkillLearningManager;
  skillRouteShadowReranker?: SkillRouteShadowReranker;
  skillEvolutionStore?: SkillEvolutionStore;
  agentEvolutionPolicy?: AgentEvolutionPolicy;
  ui?: {
    language: UiLanguage;
    flavor: UiFlavor;
    activityLabels: "en" | "ar";
  };
  agentProfile?: {
    mode: AgentProfileMode;
    responseLanguage: AgentResponseLanguage;
  };
  maxProviderIterations?: number;
  budgets?: Partial<AgentLoopBudgets>;
};

export type AgentLoopBudgets = {
  maxProviderIterations: number;
  maxProviderToolCalls: number;
  maxRepeatedToolFailures: number;
  maxProviderWallClockMs: number;
};

export type SkillSetupContext = {
  skillDirectory?: string;
  requiredEnvironmentVariables: Array<{
    name: string;
    present: boolean;
  }>;
  requiredCredentialFiles: Array<{
    path: string;
    present: boolean;
    resolvedPath?: string;
  }>;
  pythonCapabilities: Array<{
    id: string;
    required: boolean;
    groups: string[];
    status: "available" | "unavailable" | "unknown";
    reason?: string;
    message?: string;
    repairCommand?: string;
    packages: string[];
    estimatedInstallSizeMb?: number;
    installedGroups?: string[];
  }>;
  configFields: Array<{
    key: string;
    description?: string;
    required?: boolean;
    value?: unknown;
    source: "config" | "default" | "missing";
  }>;
};

export class AgentLoop {
  readonly #responseLabel: string;
  readonly #runRecorder: RunRecorder;
  readonly #runtimeRouter: RuntimeRouter;
  readonly #toolPlanRunner: ToolPlanRunner;
  readonly #intentRouter: IntentRouter;
  readonly #securityPolicy: SecurityPolicy;
  readonly #trajectoryRecorder: TrajectoryRecorder;
  readonly #sessionDb: SessionDB;
  readonly #sessionId: string;
  readonly #sessionRuntimeContext: SessionRuntimeContext | undefined;
  readonly #profileId: string;
  readonly #toolExecutor: ToolExecutor;
  readonly #toolCallPlanner: ToolCallPlanner | undefined;
  readonly #memoryProvider: MemoryProvider | undefined;
  readonly #memoryPromptContext: MemoryPromptContext | undefined;
  readonly #memoryRecallOrchestrator: Pick<MemoryRecallOrchestrator, "prepareForTurn"> | undefined;
  readonly #sessionCompressionService: Pick<SessionCompressionService, "compactIfNeeded"> | undefined;
  readonly #memoryCurationService: Pick<MemoryCurationService, "observeCompletedTurn" | "checkpoint"> | undefined;
  readonly #compressionConfig: SessionCompressionConfig | undefined;
  readonly #model: ModelProfile | undefined;
  readonly #providerPreferences: ProviderRoutePreferences;
  readonly #contextReferenceExpander: ContextReferenceExpander | undefined;
  readonly #projectContext: ProjectContextSnapshot | undefined;
  readonly #providerTools: OpenAICompatibleToolSchema[];
  readonly #providerTurnLoop: ProviderTurnLoop;
  readonly #skillPlaybookRunner: SkillPlaybookRunner;
  readonly #nativeToolExecutor: NativeToolExecutor;
  readonly #soul: string | undefined;
  readonly #skillsIndex: SkillCatalogEntry[];
  readonly #skillConfig: Record<string, Record<string, unknown>>;
  readonly #skillLearningManager: SkillLearningManager | undefined;
  readonly #skillRouteShadowReranker: SkillRouteShadowReranker | undefined;
  readonly #skillEvolutionStore: SkillEvolutionStore | undefined;
  readonly #agentEvolutionPolicy: AgentEvolutionPolicy | undefined;
  readonly #ui: AgentLoopOptions["ui"];
  readonly #agentProfile: AgentLoopOptions["agentProfile"];
  readonly #budgets: AgentLoopBudgets;

  constructor(options: AgentLoopOptions) {
    this.#responseLabel = options.responseLabel;
    this.#runRecorder = options.runRecorder;
    this.#runtimeRouter = options.runtimeRouter;
    this.#toolPlanRunner = options.toolPlanRunner;
    this.#intentRouter = options.intentRouter;
    this.#securityPolicy = options.securityPolicy;
    this.#trajectoryRecorder = options.trajectoryRecorder;
    this.#sessionDb = options.sessionDb;
    this.#sessionId = options.sessionId;
    this.#sessionRuntimeContext = options.sessionRuntimeContext;
    this.#profileId = options.profileId;
    this.#toolExecutor = options.toolExecutor;
    this.#toolCallPlanner = options.toolCallPlanner;
    this.#memoryProvider = options.memoryProvider;
    this.#memoryPromptContext = options.memoryPromptContext;
    this.#memoryRecallOrchestrator = options.memoryRecallOrchestrator;
    this.#sessionCompressionService = options.sessionCompressionService;
    this.#memoryCurationService = options.memoryCurationService;
    this.#compressionConfig = options.compressionConfig;
    this.#model = options.model;
    this.#providerPreferences = options.providerPreferences ?? {};
    this.#contextReferenceExpander = options.contextReferenceExpander;
    this.#projectContext = options.projectContext;
    this.#providerTools = options.providerTools ?? [];
    this.#providerTurnLoop = options.providerTurnLoop;
    this.#skillPlaybookRunner = options.skillPlaybookRunner;
    this.#nativeToolExecutor = options.nativeToolExecutor;
    this.#soul = options.soul;
    this.#skillsIndex = options.skillsIndex ?? [];
    this.#skillConfig = options.skillConfig ?? {};
    this.#skillLearningManager = options.skillLearningManager;
    this.#skillRouteShadowReranker = options.skillRouteShadowReranker;
    this.#skillEvolutionStore = options.skillEvolutionStore;
    this.#agentEvolutionPolicy = options.agentEvolutionPolicy;
    this.#ui = options.ui;
    this.#agentProfile = options.agentProfile;
    this.#budgets = {
      maxProviderIterations: options.budgets?.maxProviderIterations ?? options.maxProviderIterations ?? 4,
      maxProviderToolCalls: options.budgets?.maxProviderToolCalls ?? 12,
      maxRepeatedToolFailures: options.budgets?.maxRepeatedToolFailures ?? 2,
      maxProviderWallClockMs: options.budgets?.maxProviderWallClockMs ?? 180_000
    };
  }

  get trajectoryId(): string | undefined {
    return this.#trajectoryRecorder.trajectoryId;
  }

  async handle(input: AgentLoopInput): Promise<AgentLoopResponse> {
    const latestResumeNote = await this.#runRecorder.latestResumeNote();
    const effectiveText = isResumeRequest(input.text) && latestResumeNote !== undefined
      ? [
          input.text,
          "",
          "Latest interrupted-turn resume note:",
          latestResumeNote
        ].join("\n")
      : input.text;
    await emit(input.onEvent, {
      kind: "agent-start",
      sessionId: this.#currentSessionId(),
      input: effectiveText
    });
    if (isAborted(input.signal)) {
      const resumeNote = buildResumeNote({
        stage: "startup",
        userText: effectiveText
      });
      await this.#runRecorder.recordCancellation({
        reason: "cancelled before start",
        resumeNote
      }, input.onEvent);

      return await this.#completeAndReturn(cancelledResponse({
        label: this.#responseLabel,
        resumeNote
      }), {
        success: false,
        summary: "Turn cancelled before start."
      });
    }
    const expandedContext = await this.#contextReferenceExpander?.expand(effectiveText);
    const context = expandedContext !== undefined && expandedContext.references.length > 0
      ? expandedContext
      : undefined;
    const routedText = context?.expandedText ?? effectiveText;
    const trustedWorkspace = input.trustedWorkspace ?? false;
    const route = this.#runtimeRouter.route({
      text: routedText,
      attachments: input.attachments,
      channel: input.channel,
      model: this.#model,
      trustedWorkspace
    });
    const attachments = route.attachments;

    const visibleTurn = await this.#sessionDb.appendMessage({
      sessionId: this.#currentSessionId(),
      role: "user",
      content: effectiveText,
      channel: input.channel,
      metadata: {
        ...input.inputMetadata,
        attachments: summarizeAttachments(attachments),
        contextReferences: context?.references.map((reference) => reference.raw) ?? [],
        projectContextFiles: this.#projectContext?.files.map((file) => file.source) ?? []
      }
    });
    const userInputEvent = this.#trajectoryRecorder.record("user-input", {
      text: effectiveText,
      channel: input.channel,
      attachments: summarizeAttachments(attachments),
      contextReferences: context?.references.map((reference) => reference.raw) ?? []
    });
    await this.#emitLiveContextUsageEstimate({
      onEvent: input.onEvent,
      routedText,
      context,
      projectContext: this.#projectContext,
      attachments,
      stage: "input"
    });

    if (context !== undefined && context.references.length > 0) {
      await this.#sessionDb.appendEvent(this.#currentSessionId(), {
        kind: "context-expanded",
        references: context.references,
        blocks: context.blocks.map((block) => ({
          source: block.source,
          status: block.status,
          bytes: block.bytes,
          warnings: block.warnings
        })),
        warnings: context.warnings
      });

      this.#trajectoryRecorder.record("context-expanded", {
        references: context.references.map((reference) => reference.raw),
        blocks: context.blocks.map((block) => ({
          source: block.source,
          status: block.status,
          bytes: block.bytes
        })),
        warnings: context.warnings
      });
    }

    if (isAborted(input.signal)) {
      const resumeNote = buildResumeNote({
        stage: "context expansion",
        userText: effectiveText,
        context,
        projectContext: this.#projectContext
      });
      await this.#runRecorder.recordCancellation({
        reason: "cancelled before routing",
        resumeNote
      }, input.onEvent);

      return await this.#completeAndReturn(cancelledResponse({
        label: this.#responseLabel,
        resumeNote
      }), {
        success: false,
        summary: "Turn cancelled before routing."
      }, visibleTurn.id);
    }

    if (route.attachmentFailureResponse !== undefined) {
      await this.#sessionDb.appendEvent(this.#currentSessionId(), {
        kind: "intent-routed",
        route: route.intent
      });
      const attachmentFailureSecurityAssessment = await assessSecurityPolicy(capabilityFirstDefaults, {
        riskClass: "read-only-local",
        description: "respond to attachment failure",
        context: {
          trustedWorkspace,
          activeChannel: input.channel,
          targetChannel: input.channel,
          targetConversationIsActive: true
        }
      }, "strict");
      await this.#sessionDb.appendEvent(this.#currentSessionId(), {
        kind: "security-decided",
        decision: attachmentFailureSecurityAssessment.decision,
        description: "respond to attachment failure",
        mode: attachmentFailureSecurityAssessment.mode,
        reason: attachmentFailureSecurityAssessment.reason
      });
      this.#trajectoryRecorder.record("progress", {
        message: "attachment preflight failed",
        labels: route.intent.labels,
        confidence: route.intent.confidence
      });
      this.#trajectoryRecorder.record("assistant-output", {
        text: route.attachmentFailureResponse,
        matchedSkills: [],
        intentLabels: route.intent.labels,
        securityDecision: attachmentFailureSecurityAssessment.decision,
        contextReferences: context?.references.map((reference) => reference.raw) ?? [],
        toolExecutions: [],
        artifacts: []
      });
      await this.#sessionDb.appendMessage({
        sessionId: this.#currentSessionId(),
        role: "agent",
        content: route.attachmentFailureResponse,
        channel: input.channel,
        metadata: {
          matchedSkills: [],
          intentLabels: route.intent.labels,
          attachmentFailure: summarizeAttachments(attachments)
        }
      });
      await emit(input.onEvent, {
        kind: "agent-final",
        text: route.attachmentFailureResponse
      });

      return await this.#completeAndReturn({
        label: this.#responseLabel,
        text: route.attachmentFailureResponse,
        matchedSkills: [],
        intent: route.intent,
        securityDecision: attachmentFailureSecurityAssessment.decision,
        toolExecutions: [],
        toolPlans: [],
        skillOutcomes: [],
        artifacts: [],
        context,
        projectContext: this.#projectContext,
        progress: [
          "attachment preflight failed",
          ...(attachments ?? [])
            .filter((attachment) => attachment.status !== undefined && attachment.status !== "ready")
            .map((attachment) => `attachment: ${attachment.id} (${attachment.status})`)
        ]
      }, {
        success: false,
        summary: "Attachment preflight failed."
      }, visibleTurn.id);
    }

    await emit(input.onEvent, {
      kind: "intent",
      labels: route.intent.labels,
      confidence: route.intent.confidence
    });

    const intent = route.intent;
    const selectedSkill = route.selectedSkill;
    const selectedSkillPromptContent = route.selectedSkillPromptContent;
    const selectedSkillInstructions = route.selectedSkillInstructions;
    const selectedSkillResources = route.selectedSkillResources;
    const selectedSkillSetup = route.selectedSkillSetup;

    await this.#sessionDb.appendEvent(this.#currentSessionId(), {
      kind: "intent-routed",
      route: intent
    });

    this.#trajectoryRecorder.record("progress", {
      message: "intent routed",
      nativeIntent: intent.nativeIntent,
      labels: intent.labels,
      confidence: intent.confidence,
      confirmationRequired: intent.confirmationRequired,
      suggestedToolsets: intent.suggestedToolsets
    });
    const shadowLlmRerank = await this.#shadowLlmRerank({
      intent,
      userText: routedText,
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
    await this.#runRecorder.recordRouteUsage({
      intent,
      selectedSkill,
      channel: input.channel,
      userText: effectiveText,
      ...(shadowLlmRerank === undefined ? {} : { routeDetails: { shadowLlmRerank } }),
      onEvent: input.onEvent
    });
    const turnMemoryPromptContext = await this.#memoryPromptContextForTurn({
      text: routedText,
      onEvent: input.onEvent
    });
    await this.#emitLiveContextUsageEstimate({
      onEvent: input.onEvent,
      routedText,
      context,
      projectContext: this.#projectContext,
      attachments,
      memoryPromptContext: turnMemoryPromptContext,
      stage: "memory"
    });

    if (selectedSkill !== undefined) {
      await emit(input.onEvent, {
        kind: "skill",
        name: selectedSkill.name
      });
      await this.#sessionDb.appendEvent(this.#currentSessionId(), {
        kind: "skill-selected",
        skill: selectedSkill.name
      });

      this.#trajectoryRecorder.record("skill-selected", {
        skill: selectedSkill.name,
        reason: intent.invocation?.explicit === true ? "slash-invocation" : "intent-route",
        progressiveDisclosure: {
          loadedInstructions: selectedSkillInstructions !== undefined,
          instructionBytes: selectedSkillInstructions === undefined ? 0 : Buffer.byteLength(selectedSkillInstructions)
        }
      });
      await this.#emitLiveContextUsageEstimate({
        onEvent: input.onEvent,
        routedText,
        context,
        projectContext: this.#projectContext,
        attachments,
        memoryPromptContext: turnMemoryPromptContext,
        selectedSkillInstructions,
        selectedSkillPromptContent,
        selectedSkillResources,
        selectedSkillSetup,
        stage: "skill"
      });
    }

    const initialRiskClass = inferInitialRiskClass(selectedSkill);
    const securityAssessment = await assessSecurityPolicy(this.#securityPolicy, {
      riskClass: initialRiskClass,
      description: selectedSkill === undefined ? "respond to user prompt" : `run skill ${selectedSkill.name}`,
      context: {
        trustedWorkspace,
        activeChannel: input.channel,
        targetChannel: input.channel,
        targetConversationIsActive: true
      }
    });
    const securityDecision = securityAssessment.decision;

    await this.#sessionDb.appendEvent(this.#currentSessionId(), {
      kind: "security-decided",
      decision: securityDecision,
      description: selectedSkill === undefined ? "respond to user prompt" : `run skill ${selectedSkill.name}`,
      mode: securityAssessment.mode,
      reason: securityAssessment.reason
    });

    this.#trajectoryRecorder.record("progress", {
      message: selectedSkill === undefined ? "no skill selected" : `selected ${selectedSkill.name}`,
      securityDecision
    });

    if (selectedSkill !== undefined && !intent.confirmationRequired) {
      await this.#runRecorder.recordSkillPlaybookPlan(compileSkillPlaybook(selectedSkill));
    }

    const deterministicNativeTools = await this.#nativeToolExecutor.executeDeterministicNativeTools({
      intent,
      text: effectiveText,
      trustedWorkspace,
      signal: input.signal,
      onEvent: input.onEvent
    });
    const useDeterministicSkillPlaybook = !this.#providerTurnLoop.canRunProvider();
    const skillPlaybookToolExecutions = useDeterministicSkillPlaybook
      ? await this.#skillPlaybookRunner.runSkillPlaybook({
      selectedSkill,
      intent,
      trustedWorkspace,
      signal: input.signal,
      text: routedText,
      onEvent: input.onEvent
      })
      : [];
    const toolExecutions = [
      ...deterministicNativeTools.executions,
      ...skillPlaybookToolExecutions
    ];
    await this.#emitLiveContextUsageEstimate({
      onEvent: input.onEvent,
      routedText,
      context,
      projectContext: this.#projectContext,
      attachments,
      memoryPromptContext: turnMemoryPromptContext,
      selectedSkillInstructions,
      selectedSkillPromptContent,
      selectedSkillResources,
      selectedSkillSetup,
      toolExecutions,
      stage: "tools"
    });
    const recordedArtifactIds = new Set<string>();
    const artifacts = await this.#runRecorder.recordArtifactsFromExecutions(toolExecutions, recordedArtifactIds);
    const toolPlans: ToolCallPlan[] = [...deterministicNativeTools.plans];

    const fallbackResponse = buildFallbackResponse({
      label: this.#responseLabel,
      selectedSkill,
      intent,
      securityDecision,
      toolExecutions,
      toolPlans,
      skillOutcomes: [],
      artifacts,
      context,
      projectContext: this.#projectContext
    });
    const setupApprovals = buildSetupApprovalRequests(selectedSkillSetup, selectedSkill?.name);
    const deterministicImageGenerationRan = deterministicNativeTools.executions.some((execution) => execution.tool.name === "image.generate");
    const providerTools = this.#model?.supportsTools === true ? this.#providerTools : [];
    const preflightCompression = await this.#compactBeforeProviderTurn(input.signal, input.onEvent);
    const previousConversationContinuationState = await this.#latestConversationContinuationState();
    await this.#emitLiveContextUsageEstimate({
      onEvent: input.onEvent,
      routedText,
      context,
      projectContext: this.#projectContext,
      attachments,
      memoryPromptContext: turnMemoryPromptContext,
      selectedSkillInstructions,
      selectedSkillPromptContent,
      selectedSkillResources,
      selectedSkillSetup,
      toolExecutions,
      providerTools: deterministicImageGenerationRan ? suppressImageGenerationTools(providerTools) : providerTools,
      preflightCompression,
      stage: "preflight"
    });
    const providerLoop = await this.#providerTurnLoop.run({
      visibleTurnId: visibleTurn.id,
      userText: effectiveText,
      routedText,
      selectedSkill,
      selectedSkillPromptContent,
      selectedSkillInstructions,
      selectedSkillResources,
      selectedSkillSetup,
      intent,
      securityDecision,
      toolExecutions,
      context,
      projectContext: this.#projectContext,
      attachments,
      memoryPromptContext: turnMemoryPromptContext,
      providerTools: deterministicImageGenerationRan ? suppressImageGenerationTools(providerTools) : providerTools,
      preflightCompression,
      fallbackText: fallbackResponse.text,
      onEvent: input.onEvent,
      onDelta: input.onDelta,
      onSegmentBreak: input.onSegmentBreak,
      toolPlans,
      trustedWorkspace,
      initialRiskClass,
      conversationContinuationState: previousConversationContinuationState,
      signal: input.signal
    });
    const effectiveProviderExecution = providerLoop.providerExecution;

    toolExecutions.push(...providerLoop.toolExecutions);
    artifacts.push(...(await this.#runRecorder.recordArtifactsFromExecutions(providerLoop.toolExecutions, recordedArtifactIds)));
    if (isAborted(input.signal)) {
      await this.#runRecorder.markPlannedToolPlansCancelled(toolPlans, "Cancelled by user before the turn completed.");
      const resumeNote = buildResumeNote({
        stage: "provider/tool loop",
        userText: effectiveText,
        selectedSkill,
        toolPlans,
        toolExecutions,
        providerExecution: effectiveProviderExecution,
        context,
        projectContext: this.#projectContext
      });
      await this.#runRecorder.recordCancellation({
        reason: "cancelled during provider/tool loop",
        resumeNote,
        activeSkill: selectedSkill?.name,
        activeToolPlans: toolPlans
      }, input.onEvent);

      const response = cancelledResponse({
        label: this.#responseLabel,
        resumeNote,
        intent,
        securityDecision,
        selectedSkill,
        toolExecutions,
        toolPlans,
        artifacts,
        context,
        projectContext: this.#projectContext,
        providerExecution: effectiveProviderExecution
      });
      await this.#runRecorder.appendCancelledAssistantMessage({
        response,
        channel: input.channel
      });

      return await this.#completeAndReturn(response, {
        success: false,
        summary: "Turn cancelled during provider/tool loop."
      }, visibleTurn.id);
    }
    const skillOutcomes = await this.#runRecorder.recordSkillOutcomes({
      selectedSkill,
      userText: effectiveText,
      toolExecutions,
      toolPlans
    });
    const rawProviderContent = effectiveProviderExecution?.ok === true
      ? (effectiveProviderExecution.response?.content ?? "")
      : "";
    const providerReturnedEmptyContent =
      effectiveProviderExecution?.ok === true &&
      rawProviderContent.trim().length === 0;
    const displayText = providerReturnedEmptyContent
      ? "I completed the requested actions but did not produce any visible output."
      : rawProviderContent;
    const providerSummary = summarizeProviderExecution({
      configuredModel: this.#model === undefined
        ? undefined
        : { provider: this.#model.provider, id: this.#model.id },
      execution: effectiveProviderExecution
    });
    const providerProgress = renderProviderExecutionSummary(providerSummary);
    const response = effectiveProviderExecution?.ok === true && effectiveProviderExecution.response !== undefined
      ? {
          ...fallbackResponse,
          text: appendArtifactSummary(displayText, artifacts),
          toolExecutions,
          toolPlans,
          skillOutcomes,
          artifacts,
          providerExecution: effectiveProviderExecution,
          setupApprovals,
          progress: [
            ...fallbackResponse.progress,
            ...renderArtifactProgress(artifacts),
            ...renderToolPlanProgress(toolPlans),
            ...providerProgress,
            providerLoop.iterations > 1 ? `provider iterations: ${providerLoop.iterations}` : "provider continuation: not needed"
          ]
        }
      : effectiveProviderExecution === undefined
        ? {
            ...fallbackResponse,
            toolExecutions,
            toolPlans,
            skillOutcomes,
            artifacts,
            setupApprovals,
            text: appendArtifactSummary(fallbackResponse.text, artifacts),
            progress: [
              ...fallbackResponse.progress,
              ...renderArtifactProgress(artifacts)
            ]
          }
        : {
            ...fallbackResponse,
            text: appendArtifactSummary([
              fallbackResponse.text,
              "",
              `Provider note: ${summarizeProviderFailure(effectiveProviderExecution)}`
            ].join("\n"), artifacts),
            toolExecutions,
            toolPlans,
            skillOutcomes,
            artifacts,
            providerExecution: effectiveProviderExecution,
            setupApprovals,
            progress: [
              ...fallbackResponse.progress,
              ...renderArtifactProgress(artifacts),
              ...renderToolPlanProgress(toolPlans),
            ...providerProgress
          ]
        };
    const conversationContinuationState = updateConversationContinuationState({
      previous: previousConversationContinuationState,
      userText: effectiveText,
      agentText: response.text,
      toolExecutions,
      providerExecution: providerSummary
    });

    await this.#skillLearningManager?.observeTurn({
      profileId: this.#profileId,
      sessionId: this.#currentSessionId(),
      userText: effectiveText,
      selectedSkill,
      finalSkillUsed: selectedSkill?.name,
      noSkillResult: selectedSkill === undefined ? "not-applicable" : undefined,
      routeConfidence: intent.confidence,
      promptHash: hashSkillRoutePrompt(effectiveText),
      outcomeStatus: finalOutcomeStatusForLearning(effectiveProviderExecution, toolExecutions),
      candidatesShown: intent.suggestedSkills.map((skill) => skill.name),
      agentEvolutionPolicy: this.#agentEvolutionPolicy ?? noLearningPolicy(),
      toolExecutions
    }).catch(() => undefined);

    this.#trajectoryRecorder.record("assistant-output", {
      text: response.text,
      matchedSkills: response.matchedSkills,
      intentLabels: intent.labels,
      securityDecision,
      contextReferences: context?.references.map((reference) => reference.raw) ?? [],
      toolExecutions: toolExecutions.map((execution) => ({
        tool: execution.tool.name,
        decision: execution.decision,
        ok: execution.result?.ok
      })),
      provider: effectiveProviderExecution?.response === undefined
        ? undefined
        : {
            id: effectiveProviderExecution.response.provider,
            model: effectiveProviderExecution.response.model,
            fallbackUsed: effectiveProviderExecution.fallbackUsed,
            usage: effectiveProviderExecution.response.usage
          },
      skillOutcomes,
      artifacts
    });

    const skipFinalAgentAppend = await this.#shouldSkipDuplicateProviderToolCallFinalAppend(
      response,
      effectiveProviderExecution
    );
    if (!skipFinalAgentAppend) {
      await this.#sessionDb.appendMessage({
        sessionId: this.#currentSessionId(),
        role: "agent",
        content: response.text,
        channel: input.channel,
        metadata: {
          matchedSkills: response.matchedSkills,
          intentLabels: intent.labels,
          securityDecision,
          contextReferences: context?.references.map((reference) => reference.raw) ?? [],
          toolExecutions: toolExecutions.map((execution) => execution.tool.name),
          provider: providerSummary.actual === undefined
            ? undefined
            : `${providerSummary.actual.provider}/${providerSummary.actual.model}`,
          providerExecution: providerSummary,
          providerFallbackUsed: providerSummary.fallbackUsed,
          providerPrimaryFailureClass: providerSummary.primaryFailureClass,
          ...(conversationContinuationState === undefined ? {} : { conversationContinuationState }),
          toolPlans: toolPlans.map((plan) => ({
            id: plan.id,
            tool: plan.tool,
            status: plan.status,
            error: plan.error
          })),
          artifacts: artifacts.map((artifact) => ({
            id: artifact.id,
            path: artifact.path,
            kind: artifact.kind,
            bytes: artifact.bytes
          }))
        }
      });
    }

    await emit(input.onEvent, {
      kind: "agent-final",
      text: response.text
    });

    await this.#promoteRepeatedPreferences(input.text, userInputEvent.id);
    await this.#memoryCurationService?.observeCompletedTurn({
      signal: input.signal,
      onEvent: input.onEvent
    }).catch(() => undefined);

    return await this.#completeAndReturn(response, outcomeFromResponse(response), visibleTurn.id);
  }





  async #emitLiveContextUsageEstimate(input: {
    onEvent?: RuntimeEventSink;
    routedText: string;
    context: ContextExpansionResult | undefined;
    projectContext: ProjectContextSnapshot | undefined;
    attachments: ChannelAttachment[] | undefined;
    memoryPromptContext?: MemoryPromptContext;
    selectedSkillInstructions?: string;
    selectedSkillPromptContent?: SelectedSkillPromptContent;
    selectedSkillResources?: LoadedSkill["resources"];
    selectedSkillSetup?: SkillSetupContext;
    toolExecutions?: ToolExecutionRecord[];
    providerTools?: OpenAICompatibleToolSchema[];
    preflightCompression?: PromptSemanticCompressionReport;
    stage: ContextEstimateStage;
  }): Promise<void> {
    const total = this.#model?.contextWindowTokens;
    if (!Number.isFinite(total) || total === undefined || total <= 0) {
      return;
    }

    await emitContextEstimate(input.onEvent, {
      filled: Math.max(0, Math.round(await this.#estimateLiveContextTokens(input))),
      total,
      source: "live-estimate",
      stage: input.stage
    });
  }

  async #shouldSkipDuplicateProviderToolCallFinalAppend(
    response: AgentLoopResponse,
    providerExecution: ProviderExecutionResult | undefined
  ): Promise<boolean> {
    if (
      providerExecution?.ok !== true ||
      providerExecution.toolCalls.length === 0 ||
      (providerExecution.response?.content ?? "").trim().length > 0
    ) {
      return false;
    }

    const messages = await this.#sessionDb.listMessages(this.#currentSessionId()).catch(() => []);
    const lastAgent = [...messages].reverse().find((message) => message.role === "agent");
    return lastAgent?.metadata?.kind === "provider-tool-call-turn" &&
      response.text === "I completed the requested actions but did not produce any visible output.";
  }

  async #latestConversationContinuationState(): Promise<ConversationContinuationState | undefined> {
    const messages = await this.#sessionDb.listMessages(this.#currentSessionId()).catch(() => []);
    for (const message of [...messages].reverse()) {
      if (message.role !== "agent") {
        continue;
      }
      const state = sanitizeConversationContinuationState(message.metadata?.conversationContinuationState);
      if (state !== undefined) {
        return state.status === "open" ? state : undefined;
      }
    }
    return undefined;
  }

  async #estimateLiveContextTokens(input: {
    routedText: string;
    context: ContextExpansionResult | undefined;
    projectContext: ProjectContextSnapshot | undefined;
    attachments: ChannelAttachment[] | undefined;
    memoryPromptContext?: MemoryPromptContext;
    selectedSkillInstructions?: string;
    selectedSkillPromptContent?: SelectedSkillPromptContent;
    selectedSkillResources?: LoadedSkill["resources"];
    selectedSkillSetup?: SkillSetupContext;
    toolExecutions?: ToolExecutionRecord[];
    providerTools?: OpenAICompatibleToolSchema[];
    preflightCompression?: PromptSemanticCompressionReport;
    stage: ContextEstimateStage;
  }): Promise<number> {
    const sessionMessages = await this.#sessionDb.listMessages(this.#currentSessionId()).catch(() => []);
    let tokens = estimateMessagesTokensRough(sessionMessages.map((message) => ({
      role: message.role,
      content: message.content,
      metadata: message.metadata
    })));

    if (sessionMessages.length === 0) {
      tokens += estimateTextTokensRough(input.routedText);
    }

    tokens += estimateTextTokensRough(this.#soul ?? "");
    tokens += estimateContextReferenceTokens(input.context);
    tokens += estimateProjectContextTokens(input.projectContext);
    tokens += estimateTextTokensRough(input.selectedSkillPromptContent?.content ?? input.selectedSkillInstructions ?? "");
    tokens += estimateResourceIndexTokens(input.selectedSkillResources);
    tokens += estimateSkillSetupTokens(input.selectedSkillSetup);
    tokens += estimateMemoryPromptContextTokens(input.memoryPromptContext);
    tokens += estimateToolExecutionTokens(input.toolExecutions);
    tokens += estimateJsonTokens(input.providerTools);
    tokens += estimateJsonTokens(input.preflightCompression);
    tokens += estimateJsonTokens({
      stage: input.stage,
      contextReferences: input.context?.references.length ?? 0,
      contextWarnings: input.context?.warnings.length ?? 0,
      projectWarnings: input.projectContext?.warnings.length ?? 0,
      attachmentCount: input.attachments?.length ?? 0,
      skillCount: this.#skillsIndex.length
    });

    return tokens;
  }

  async #memoryPromptContextForTurn(input: {
    text: string;
    onEvent?: RuntimeEventSink;
  }): Promise<MemoryPromptContext | undefined> {
    if (this.#memoryRecallOrchestrator === undefined) {
      return this.#memoryPromptContext;
    }
    const result = await this.#memoryRecallOrchestrator.prepareForTurn(input);
    return result.context;
  }

  async #compactBeforeProviderTurn(
    signal: AbortSignal | undefined,
    onEvent: RuntimeEventSink | undefined
  ): Promise<PromptSemanticCompressionReport | undefined> {
    if (
      !this.#providerTurnLoop.canRunProvider() ||
      this.#sessionCompressionService === undefined ||
      this.#compressionConfig?.enabled !== true ||
      this.#model === undefined
    ) {
      return undefined;
    }

    const sessionId = this.#currentSessionId();
    const messages = await this.#sessionDb.listMessages(sessionId);
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
      await this.#memoryCurationService?.checkpoint({
        trigger: "compact",
        sessionId,
        signal,
        onEvent
      }).catch(() => undefined);
      const result = await this.#sessionCompressionService.compactIfNeeded({
        profileId: this.#profileId,
        sessionId,
        preserveTranscript: true,
        ...(this.#providerTurnLoop.lastPromptTokens() > 0
          ? { lastPromptTokensEstimated: this.#providerTurnLoop.lastPromptTokens() }
          : {}),
        ...(this.#providerTurnLoop.lastActualPromptTokens() === undefined
          ? {}
          : { lastActualPromptTokens: this.#providerTurnLoop.lastActualPromptTokens() }),
        signal
      });
      if (result.rotated) {
        this.#sessionRuntimeContext?.rotateSession(result.activeSessionId);
      }
      if (result.didCompress) {
        try {
          await emit(onEvent, {
            kind: "session-compacted",
            originalSessionId: result.originalSessionId,
            activeSessionId: result.activeSessionId,
            rotated: result.rotated,
            trigger: "auto",
            postTokens: result.diagnostics.postTokens
          });
        } catch {
          // Compaction already succeeded; rail notification must not turn it into a compression failure.
        }
      }
      return compressionReportFromResult(result);
    } catch (error) {
      return {
        triggered: false,
        mode: "none",
        preTokens,
        fallbackUsed: true,
        fallbackReason: `compression-failed: ${errorMessage(error)}`,
        warnings: [`semantic compression failed before prompt assembly: ${errorMessage(error)}`]
      };
    }
  }

  async #promoteRepeatedPreferences(userText: string, userInputEventId: string): Promise<void> {
    if (this.#memoryProvider === undefined) {
      return;
    }

    let preferenceResult: Awaited<ReturnType<typeof resolveUserPreferencePromotion>> | undefined;
    try {
      preferenceResult = await resolveUserPreferencePromotion({
        profileId: this.#profileId,
        currentUserText: userText,
        sessionDb: this.#sessionDb,
        memoryProvider: this.#memoryProvider,
        sourceTrajectoryId: this.#trajectoryRecorder.trajectoryId,
        sourceEventId: userInputEventId
      });
    } catch (error) {
      if (error instanceof MemoryCurationBusyError) {
        return;
      }
      if (!isMemoryBudgetOverflowError(error)) {
        throw error;
      }
      await this.#recordPromotionOverflow({
        error,
        targetFile: "USER.md",
        conclusionKind: "user-preference"
      });
    }

    if (preferenceResult?.kind === "conclusion") {
      const { conclusion } = preferenceResult;
      const targetFile = "USER.md";

      this.#trajectoryRecorder.record("memory-promotion", {
        conclusionId: conclusion.id,
        kind: conclusion.kind,
        targetFile,
        sourceTrajectoryId: conclusion.sourceTrajectoryId,
        sourceEventId: conclusion.sourceEventId
      });
      this.#trajectoryRecorder.record("memory-conclusion", {
        provider: this.#memoryProvider.id,
        conclusion
      });
      await this.#sessionDb.appendEvent(this.#currentSessionId(), {
        kind: "memory-conclusion",
        provider: this.#memoryProvider.id,
        conclusion
      });
    }

    let projectFactResult: Awaited<ReturnType<typeof resolveProjectFactPromotion>> | undefined;
    try {
      projectFactResult = await resolveProjectFactPromotion({
        profileId: this.#profileId,
        currentUserText: userText,
        sessionDb: this.#sessionDb,
        memoryProvider: this.#memoryProvider,
        sourceTrajectoryId: this.#trajectoryRecorder.trajectoryId,
        sourceEventId: userInputEventId
      });
    } catch (error) {
      if (error instanceof MemoryCurationBusyError) {
        return;
      }
      if (!isMemoryBudgetOverflowError(error)) {
        throw error;
      }
      await this.#recordPromotionOverflow({
        error,
        targetFile: "MEMORY.md",
        conclusionKind: "project-fact"
      });
      return;
    }

    if (projectFactResult?.kind !== "conclusion") {
      return;
    }
    const { conclusion } = projectFactResult;
    const targetFile = "MEMORY.md";

    this.#trajectoryRecorder.record("memory-promotion", {
      conclusionId: conclusion.id,
      kind: conclusion.kind,
      targetFile,
      sourceTrajectoryId: conclusion.sourceTrajectoryId,
      sourceEventId: conclusion.sourceEventId
    });
    this.#trajectoryRecorder.record("memory-conclusion", {
      provider: this.#memoryProvider.id,
      conclusion
    });
    await this.#sessionDb.appendEvent(this.#currentSessionId(), {
      kind: "memory-conclusion",
      provider: this.#memoryProvider.id,
      conclusion
    });
  }

  async #recordPromotionOverflow(input: {
    error: MemoryBudgetOverflowError;
    targetFile: MemoryFileKind;
    conclusionKind: MemoryConclusion["kind"];
    conclusionId?: string;
  }): Promise<void> {
    if (this.#memoryProvider === undefined) {
      return;
    }

    const payload = {
      provider: this.#memoryProvider.id,
      reason: "memory-budget-overflow" as const,
      targetFile: input.targetFile,
      memoryKind: input.error.overflow.kind,
      pressure: {
        state: input.error.overflow.pressure.state,
        chars: input.error.overflow.chars,
        maxChars: input.error.overflow.maxChars,
        overflowChars: input.error.overflow.overflowChars
      },
      conclusionKind: input.conclusionKind,
      ...(input.conclusionId === undefined ? {} : { conclusionId: input.conclusionId }),
      remediationHint: "Use memory-file compaction or reduce memory size before retrying promotion.",
      failure: truncate(redactSensitiveText(input.error.message), 240)
    };

    try {
      this.#trajectoryRecorder.record("memory-promotion-failed", payload);
    } catch {
      // Promotion overflow diagnostics must not fail an otherwise successful turn.
    }

    try {
      await this.#sessionDb.appendEvent(this.#currentSessionId(), {
        kind: "memory-promotion-failed",
        ...payload
      });
    } catch {
      // Session diagnostics are best-effort for memory-side promotion failures.
    }
  }

  async #shadowLlmRerank(input: {
    intent: IntentRoute;
    userText: string;
    signal?: AbortSignal;
  }): Promise<SkillRouteLlmRerankTelemetry | undefined> {
    if (this.#skillRouteShadowReranker === undefined) {
      return undefined;
    }
    if (
      this.#agentEvolutionPolicy?.routingMode !== "hybrid" &&
      this.#agentEvolutionPolicy?.routingMode !== "hybrid-plus"
    ) {
      return undefined;
    }

    try {
      return await this.#skillRouteShadowReranker.rerank(input);
    } catch (error) {
      const candidates = boundedRerankCandidates(input.intent);
      if (candidates.length < 2) {
        return undefined;
      }
      return {
        mode: "llm-rerank-shadow",
        status: "failed",
        candidates: candidates.map((candidate) => ({ skillName: candidate.skill.name })),
        diagnostics: [`Reranker threw: ${truncate(redactSensitiveText(errorMessage(error)), 160)}`]
      };
    }
  }

  #currentSessionId(): string {
    return this.#sessionRuntimeContext?.currentSessionId() ?? this.#sessionId;
  }

  async #completeAndReturn(response: AgentLoopResponse, outcome: {
    success: boolean;
    summary: string;
    userAccepted?: boolean;
  }, visibleTurnId?: string): Promise<AgentLoopResponse> {
    const completedResponse = visibleTurnId === undefined
      ? response
      : await this.#withTurnUsage(response, visibleTurnId);
    await this.#runRecorder.completeTrajectory(outcome, { bestEffort: true });
    return completedResponse;
  }

  async #withTurnUsage(response: AgentLoopResponse, visibleTurnId: string): Promise<AgentLoopResponse> {
    let mainAgent: UsageCostSummary;
    try {
      const entries = await this.#sessionDb.listProviderUsageEntries(this.#profileId, {
        visibleTurnId
      });
      const dispatchedProviderRequest = response.providerExecution?.attempts.some((attempt) => attempt.state === "dispatched") === true;
      mainAgent = usageCostSummaryFromEntries(entries, {
        emptyUsageIsComplete: !dispatchedProviderRequest
      });
    } catch {
      mainAgent = unavailableUsageCostSummary("turn-usage-read-failed");
    }
    return {
      ...response,
      turnUsage: {
        turnId: visibleTurnId,
        mainAgent,
        total: mainAgent
      }
    };
  }



}


function estimateMemoryPromptContextTokens(context: MemoryPromptContext | undefined): number {
  if (context === undefined) {
    return 0;
  }

  const blocks = [
    ...context.frozenCompactMemory,
    ...context.safetyMemory,
    ...(context.sessionRecall ?? []),
    ...(context.externalRecall ?? [])
  ];
  return blocks.reduce((sum, block) => sum + estimateTextTokensRough(block.content), 0);
}

function estimateContextReferenceTokens(context: ContextExpansionResult | undefined): number {
  const blocks = context?.blocks.filter((block) => block.content.length > 0) ?? [];
  if (blocks.length === 0) {
    return estimateTextTokensRough("No explicit context references were loaded.");
  }
  return blocks.reduce((sum, block) => {
    return sum + estimateTextTokensRough(`Source: ${block.source}\n${truncate(block.content, 2_000)}`);
  }, 0);
}

function estimateProjectContextTokens(context: ProjectContextSnapshot | undefined): number {
  if (context === undefined || context.files.length === 0) {
    return estimateTextTokensRough("No project context files were loaded.");
  }
  return context.files.reduce((sum, file) => {
    return sum + estimateTextTokensRough(`Source: ${file.source}\n${truncate(file.content, 1_500)}`);
  }, 0);
}

function estimateResourceIndexTokens(resources: LoadedSkill["resources"] | undefined): number {
  if (resources === undefined) {
    return 0;
  }
  return resources.reduce((sum, resource) => {
    const labels = [
      resource.path,
      resource.bytes === undefined ? undefined : `${resource.bytes} bytes`,
      resource.declared === true ? "declared" : undefined
    ].filter((value) => value !== undefined);
    return sum + estimateTextTokensRough(`${resource.kind}: - ${labels.join(" · ")}`);
  }, 0);
}

function estimateSkillSetupTokens(setup: SkillSetupContext | undefined): number {
  if (setup === undefined) {
    return 0;
  }
  return estimateJsonTokens({
    skillDirectory: setup.skillDirectory,
    requiredEnvironmentVariables: setup.requiredEnvironmentVariables.map((item) => ({
      name: item.name,
      present: item.present
    })),
    requiredCredentialFiles: setup.requiredCredentialFiles.map((item) => ({
      path: item.path,
      present: item.present,
      resolvedPath: item.resolvedPath
    })),
    pythonCapabilities: setup.pythonCapabilities.map((capability) => ({
      id: capability.id,
      required: capability.required,
      groups: capability.groups,
      status: capability.status,
      reason: capability.reason,
      repairCommand: capability.repairCommand,
      packages: capability.packages
    })),
    configFields: setup.configFields.map((field) => ({
      key: field.key,
      required: field.required,
      source: field.source,
      valueType: field.value === undefined ? "undefined" : typeof field.value
    }))
  });
}

function estimateToolExecutionTokens(toolExecutions: ToolExecutionRecord[] | undefined): number {
  if (toolExecutions === undefined) {
    return 0;
  }
  return toolExecutions.reduce((sum, execution) => {
    return sum +
      estimateTextTokensRough(execution.tool.name) +
      estimateTextTokensRough(execution.result?.content ?? "") +
      estimateJsonTokens({
        ok: execution.result?.ok,
        decision: execution.decision,
        riskClass: execution.riskClass,
        metadata: execution.result?.metadata
      });
  }, 0);
}

function estimateJsonTokens(value: unknown): number {
  if (value === undefined) {
    return 0;
  }
  try {
    return estimateTextTokensRough(JSON.stringify(value));
  } catch {
    return 0;
  }
}

function inferInitialRiskClass(skill: LoadedSkill | SkillDefinition | undefined) {
  if (skill === undefined) {
    return "read-only-local";
  }

  if (skill.permissionExpectations.includes("auto-active-channel-reply")) {
    return "external-side-effect";
  }

  if (skill.permissionExpectations.includes("auto-read")) {
    return "read-only-local";
  }

  return "workspace-write";
}

function buildSetupApprovalRequests(
  setup: SkillSetupContext | undefined,
  skillName: string | undefined
): AgentLoopSetupApprovalRequest[] {
  if (setup === undefined) {
    return [];
  }

  return setup.pythonCapabilities
    .filter((capability) => capability.required && capability.status !== "available")
    .map((capability) => ({
      kind: "managed-python-capability-install" as const,
      skillName,
      capabilityId: capability.id,
      groups: [...capability.groups],
      packages: [...capability.packages],
      estimatedInstallSizeMb: capability.estimatedInstallSizeMb,
      reason: capability.reason ?? capability.message,
      repairCommand: capability.repairCommand
    }));
}

function outcomeFromResponse(response: AgentLoopResponse): {
  success: boolean;
  summary: string;
} {
  if (
    response.providerExecution?.ok === true &&
    (response.providerExecution.response?.content ?? "").trim().length === 0
  ) {
    return {
      success: false,
      summary: "Provider turn succeeded but returned empty visible content."
    };
  }

  if (response.providerExecution?.ok === false) {
    return {
      success: false,
      summary: "Provider turn failed; fallback response returned."
    };
  }

  const failedTools = response.toolExecutions.filter((execution) =>
    execution.decision !== "allow" || execution.result?.ok === false
  ).length;
  if (failedTools > 0) {
    return {
      success: false,
      summary: `${failedTools} tool execution(s) failed or were blocked.`
    };
  }

  return {
    success: true,
    summary: "Turn completed."
  };
}

function finalOutcomeStatusForLearning(
  providerExecution: ProviderExecutionResult | undefined,
  toolExecutions: ToolExecutionRecord[]
): SkillRouteFinalOutcomeStatus {
  if (providerExecution?.ok === false) {
    return "failed";
  }
  if (toolExecutions.some((execution) => execution.decision !== "allow")) {
    return "blocked";
  }
  if (toolExecutions.some((execution) => execution.result?.ok === false)) {
    return "failed";
  }
  return "succeeded";
}

function noLearningPolicy(): AgentEvolutionPolicy {
  return {
    mode: "none",
    routingMode: "deterministic",
    observeTurns: false,
    observeSelectedSkillTurns: false,
    createEvidence: false,
    createProposals: false,
    createExperiments: false,
    createManifests: false,
    preparePatches: false,
    runEvals: false,
    shadowAutonomousDecisions: false,
    requireApprovalForLowRisk: true,
    requireApprovalForMediumRisk: true,
    requireApprovalForHighRisk: true,
    autoPromoteEligibleLocalChanges: false,
    autoRollbackEligibleLocalChanges: false,
    budgets: {}
  };
}

function isResumeRequest(text: string): boolean {
  return /^(resume|resume that|continue|continue that|pick up where we left off)\b/iu.test(text.trim());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 3)}...`;
}









function suppressImageGenerationTools(tools: OpenAICompatibleToolSchema[]): OpenAICompatibleToolSchema[] {
  return tools.filter((tool) => tool.function.name !== "image_generate" && tool.function.name !== "image.generate");
}
