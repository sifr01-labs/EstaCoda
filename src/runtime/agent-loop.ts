import type { ArtifactRecord } from "../contracts/artifact.js";
import type { ChannelAttachment, ChannelKind } from "../contracts/channel.js";
import type { ContextExpansionResult, ProjectContextSnapshot } from "../contracts/context.js";
import type { IntentRoute } from "../contracts/intent.js";
import type { MemoryConclusion, MemoryFileKind, MemoryProvider, MemoryPromptContext, SkillOutcome } from "../contracts/memory.js";
import type { PromptBudgetReport, PromptSemanticCompressionReport } from "../contracts/prompt.js";
import type { ModelProfile, ProviderMessage, ProviderRequest, ProviderRoutePreferences } from "../contracts/provider.js";
import type { RuntimeEvent, RuntimeEventSink } from "../contracts/runtime-event.js";
import type { SecurityDecision, SecurityPolicy } from "../contracts/security.js";
import { assessSecurityPolicy, capabilityFirstDefaults } from "../contracts/security.js";
import type { SessionDB } from "../contracts/session.js";
import type {
  LoadedSkill,
  SkillConfigField,
  SkillDefinition,
  SkillCatalogEntry
} from "../contracts/skill.js";
import type { ToolCallPlan } from "../contracts/tool-plan.js";
import type { ToolDefinition, ToolRiskClass, ToolsetName } from "../contracts/tool.js";
import type { AgentProfileMode, AgentResponseLanguage, SessionCompressionConfig, UiFlavor, UiLanguage } from "../config/runtime-config.js";
import type { ContextReferenceExpander } from "../context/context-reference-expander.js";
import type { ProviderExecutionResult, ProviderRuntimeEvent } from "../providers/provider-executor.js";
import type { ToolCallPlanner } from "../tools/tool-call-planner.js";
import type { OpenAICompatibleToolSchema } from "../tools/tool-schema.js";
import type { ToolExecutor, ToolExecutionRecord } from "../tools/tool-executor.js";
import type { TrajectoryRecorder } from "../trajectory/trajectory-recorder.js";
import { resolveProjectFactPromotion, resolveUserPreferencePromotion } from "../memory/memory-promotion.js";
import { isMemoryBudgetOverflowError, type MemoryBudgetOverflowError } from "../memory/memory-store.js";
import type { MemoryRecallOrchestrator } from "../memory/memory-recall-orchestrator.js";
import type { SkillLearningManager } from "../skills/skill-learning.js";
import type { SkillEvolutionStore } from "../skills/skill-evolution.js";
import { compileSkillWorkflowPlan } from "../skills/skill-workflow-planner.js";
import { createSkillRouteTelemetry, hashSkillRoutePrompt } from "../skills/skill-usage-telemetry.js";
import { compressionReportFromResult, ProviderTurnLoop } from "./provider-turn-loop.js";
import type { IntentRouter } from "./intent-router.js";
import { RunRecorder } from "./run-recorder.js";
import type { RuntimeRouter } from "./runtime-router.js";
import { summarizeAttachments } from "./runtime-router.js";
import { ToolPlanRunner, toolResultStats } from "./tool-plan-runner.js";
import { SkillWorkflowExecutor } from "./skill-workflow-executor.js";
import { NativeToolExecutor } from "./native-tool-executor.js";
import type { SessionRuntimeContext } from "./session-runtime-context.js";
import { buildFallbackResponse, cancelledResponse, buildResumeNote, renderToolPlanProgress } from "./response-builders.js";
import { emit, isAborted } from "../utils/runtime-helpers.js";
import { appendArtifactSummary, renderArtifactProgress } from "../utils/artifact-formatting.js";
import { summarizeProviderFailure } from "../providers/provider-diagnostics.js";
import type { SessionCompressionService } from "../prompt/session-compression-service.js";
import { estimateMessagesTokensRough } from "../prompt/token-estimator.js";
import { redactSensitiveText } from "../utils/redaction.js";

export type AgentLoopInput = {
  text: string;
  channel: ChannelKind;
  attachments?: ChannelAttachment[];
  trustedWorkspace?: boolean;
  workspaceRoot?: string;
  onEvent?: RuntimeEventSink;
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
  progress: string[];
};

export type AgentLoopOptions = {
  runRecorder: RunRecorder;
  runtimeRouter: RuntimeRouter;
  toolPlanRunner: ToolPlanRunner;
  providerTurnLoop: ProviderTurnLoop;
  skillWorkflowExecutor: SkillWorkflowExecutor;
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
  skillEvolutionStore?: SkillEvolutionStore;
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
  readonly #compressionConfig: SessionCompressionConfig | undefined;
  readonly #model: ModelProfile | undefined;
  readonly #providerPreferences: ProviderRoutePreferences;
  readonly #contextReferenceExpander: ContextReferenceExpander | undefined;
  readonly #projectContext: ProjectContextSnapshot | undefined;
  readonly #providerTools: OpenAICompatibleToolSchema[];
  readonly #providerTurnLoop: ProviderTurnLoop;
  readonly #skillWorkflowExecutor: SkillWorkflowExecutor;
  readonly #nativeToolExecutor: NativeToolExecutor;
  readonly #soul: string | undefined;
  readonly #skillsIndex: SkillCatalogEntry[];
  readonly #skillConfig: Record<string, Record<string, unknown>>;
  readonly #skillLearningManager: SkillLearningManager | undefined;
  readonly #skillEvolutionStore: SkillEvolutionStore | undefined;
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
    this.#compressionConfig = options.compressionConfig;
    this.#model = options.model;
    this.#providerPreferences = options.providerPreferences ?? {};
    this.#contextReferenceExpander = options.contextReferenceExpander;
    this.#projectContext = options.projectContext;
    this.#providerTools = options.providerTools ?? [];
    this.#providerTurnLoop = options.providerTurnLoop;
    this.#skillWorkflowExecutor = options.skillWorkflowExecutor;
    this.#nativeToolExecutor = options.nativeToolExecutor;
    this.#soul = options.soul;
    this.#skillsIndex = options.skillsIndex ?? [];
    this.#skillConfig = options.skillConfig ?? {};
    this.#skillLearningManager = options.skillLearningManager;
    this.#skillEvolutionStore = options.skillEvolutionStore;
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

      return cancelledResponse({
        label: this.#responseLabel,
        resumeNote
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

    await this.#sessionDb.appendMessage({
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

      return cancelledResponse({
        label: this.#responseLabel,
        resumeNote
      });
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

      return {
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
      };
    }

    await emit(input.onEvent, {
      kind: "intent",
      labels: route.intent.labels,
      confidence: route.intent.confidence
    });

    const intent = route.intent;
    const selectedSkill = route.selectedSkill;
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
    await this.#runRecorder.recordRouteUsage({
      intent,
      selectedSkill,
      channel: input.channel,
      userText: effectiveText,
      onEvent: input.onEvent
    });
    const turnMemoryPromptContext = await this.#memoryPromptContextForTurn({
      text: routedText,
      onEvent: input.onEvent
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
      await this.#runRecorder.recordWorkflowPlan(compileSkillWorkflowPlan(selectedSkill));
    }

    const deterministicNativeTools = await this.#nativeToolExecutor.executeDeterministicNativeTools({
      intent,
      text: effectiveText,
      trustedWorkspace,
      signal: input.signal,
      onEvent: input.onEvent
    });
    const useDeterministicSkillWorkflow = !this.#providerTurnLoop.canRunProvider();
    const skillToolExecutions = useDeterministicSkillWorkflow
      ? await this.#skillWorkflowExecutor.executeSkillWorkflow({
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
      ...skillToolExecutions
    ];
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
    const deterministicImageGenerationRan = deterministicNativeTools.executions.some((execution) => execution.tool.name === "image.generate");
    const providerTools = this.#model?.supportsTools === true ? this.#providerTools : [];
    const preflightCompression = await this.#compactBeforeProviderTurn(input.signal);
    const providerLoop = await this.#providerTurnLoop.run({
      userText: effectiveText,
      routedText,
      selectedSkill,
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
      toolPlans,
      trustedWorkspace,
      initialRiskClass,
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

      return response;
    }
    const skillOutcomes = await this.#runRecorder.recordSkillOutcomes({
      selectedSkill,
      userText: effectiveText,
      toolExecutions,
      toolPlans
    });
    const response = effectiveProviderExecution?.ok === true && effectiveProviderExecution.response !== undefined
      ? {
          ...fallbackResponse,
          text: appendArtifactSummary(effectiveProviderExecution.response.content, artifacts),
          toolExecutions,
          toolPlans,
          skillOutcomes,
          artifacts,
          providerExecution: effectiveProviderExecution,
          progress: [
            ...fallbackResponse.progress,
            ...renderArtifactProgress(artifacts),
            ...renderToolPlanProgress(toolPlans),
            `provider: ${effectiveProviderExecution.response.provider}/${effectiveProviderExecution.response.model}`,
            effectiveProviderExecution.fallbackUsed ? "provider fallback used" : "provider primary used",
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
            progress: [
              ...fallbackResponse.progress,
              ...renderArtifactProgress(artifacts),
              ...renderToolPlanProgress(toolPlans),
              `provider failed: ${effectiveProviderExecution.attempts.map((attempt) => `${attempt.provider}/${attempt.model}:${attempt.errorClass ?? "unknown"}`).join(", ") || "no route"}`
            ]
          };

    await this.#skillLearningManager?.observeTurn({
      profileId: this.#profileId,
      sessionId: this.#currentSessionId(),
      userText: effectiveText,
      selectedSkill,
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
        provider: effectiveProviderExecution?.response === undefined
          ? undefined
          : `${effectiveProviderExecution.response.provider}/${effectiveProviderExecution.response.model}`,
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

    await emit(input.onEvent, {
      kind: "agent-final",
      text: response.text
    });

    await this.#promoteRepeatedPreferences(effectiveText, userInputEvent.id);

    return response;
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

  async #compactBeforeProviderTurn(signal: AbortSignal | undefined): Promise<PromptSemanticCompressionReport | undefined> {
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
      if (!isMemoryBudgetOverflowError(error)) {
        throw error;
      }
      await this.#recordPromotionOverflow({
        error,
        targetFile: "USER.md",
        conclusionKind: "user-preference"
      });
      return;
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
      return;
    }
    if (preferenceResult?.kind === "forgotten") {
      return;
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

  #currentSessionId(): string {
    return this.#sessionRuntimeContext?.currentSessionId() ?? this.#sessionId;
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
