import type { ArtifactRecord } from "../contracts/artifact.js";
import type { ChannelKind } from "../contracts/channel.js";
import type { ContextExpansionResult, ProjectContextSnapshot } from "../contracts/context.js";
import type { IntentRoute } from "../contracts/intent.js";
import type { MemoryProvider, MemoryProviderContext, SkillOutcome } from "../contracts/memory.js";
import type { PromptBudgetReport } from "../contracts/prompt.js";
import type { ModelProfile, ProviderMessage, ProviderRequest, ProviderRoutePreferences } from "../contracts/provider.js";
import type { RuntimeEvent, RuntimeEventSink } from "../contracts/runtime-event.js";
import type { SecurityDecision, SecurityPolicy } from "../contracts/security.js";
import type { SessionDB } from "../contracts/session.js";
import type {
  LoadedSkill,
  SkillDefinition,
  SkillCatalogEntry,
  SkillWorkflowPlan,
  SkillWorkflowPlanStep,
  SkillWorkflowStep
} from "../contracts/skill.js";
import type { ToolCallPlan } from "../contracts/tool-plan.js";
import type { ToolDefinition, ToolsetName } from "../contracts/tool.js";
import type { ContextReferenceExpander } from "../context/context-reference-expander.js";
import type { ProviderExecutionResult, ProviderExecutor, ProviderRuntimeEvent } from "../providers/provider-executor.js";
import type { ToolCallPlanner } from "../tools/tool-call-planner.js";
import type { OpenAICompatibleToolSchema } from "../tools/tool-schema.js";
import type { ToolExecutor, ToolExecutionRecord } from "../tools/tool-executor.js";
import { packetizeToolExecution, renderToolResultPacket } from "../tools/tool-result-packet.js";
import type { TrajectoryRecorder } from "../trajectory/trajectory-recorder.js";
import { compileSkillWorkflowPlan } from "../skills/skill-workflow-planner.js";
import {
  assembleProviderContinuationPrompt,
  assembleProviderPrompt
} from "../prompt/prompt-assembly.js";
import { packSessionHistory } from "../prompt/history-packer.js";
import { PromptCache } from "../prompt/prompt-cache.js";
import { normalizeProviderMessagesStrict } from "../providers/provider-message-normalizer.js";
import type { IntentRouter } from "./intent-router.js";

export type AgentLoopInput = {
  text: string;
  channel: ChannelKind;
  trustedWorkspace?: boolean;
  workspaceRoot?: string;
  onEvent?: RuntimeEventSink;
  signal?: AbortSignal;
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
  responseLabel: string;
  intentRouter: IntentRouter;
  securityPolicy: SecurityPolicy;
  trajectoryRecorder: TrajectoryRecorder;
  sessionDb: SessionDB;
  sessionId: string;
  toolExecutor: ToolExecutor;
  toolCallPlanner?: ToolCallPlanner;
  providerExecutor?: ProviderExecutor;
  memoryProvider?: MemoryProvider;
  memoryContext?: MemoryProviderContext;
  model?: ModelProfile;
  providerPreferences?: ProviderRoutePreferences;
  contextReferenceExpander?: ContextReferenceExpander;
  projectContext?: ProjectContextSnapshot;
  providerTools?: OpenAICompatibleToolSchema[];
  soul?: string;
  frozenMemory?: {
    user?: string;
    memory?: string;
  };
  skillsIndex?: SkillCatalogEntry[];
  maxProviderIterations?: number;
  budgets?: Partial<AgentLoopBudgets>;
};

export type AgentLoopBudgets = {
  maxProviderIterations: number;
  maxProviderToolCalls: number;
  maxRepeatedToolFailures: number;
  maxProviderWallClockMs: number;
  maxConcurrentSafeTools: number;
};

export class AgentLoop {
  readonly #responseLabel: string;
  readonly #intentRouter: IntentRouter;
  readonly #securityPolicy: SecurityPolicy;
  readonly #trajectoryRecorder: TrajectoryRecorder;
  readonly #sessionDb: SessionDB;
  readonly #sessionId: string;
  readonly #toolExecutor: ToolExecutor;
  readonly #toolCallPlanner: ToolCallPlanner | undefined;
  readonly #providerExecutor: ProviderExecutor | undefined;
  readonly #memoryProvider: MemoryProvider | undefined;
  readonly #memoryContext: MemoryProviderContext | undefined;
  readonly #model: ModelProfile | undefined;
  readonly #providerPreferences: ProviderRoutePreferences;
  readonly #contextReferenceExpander: ContextReferenceExpander | undefined;
  readonly #projectContext: ProjectContextSnapshot | undefined;
  readonly #providerTools: OpenAICompatibleToolSchema[];
  readonly #promptCache: PromptCache;
  readonly #soul: string | undefined;
  readonly #frozenMemory: { user?: string; memory?: string } | undefined;
  readonly #skillsIndex: SkillCatalogEntry[];
  readonly #budgets: AgentLoopBudgets;

  constructor(options: AgentLoopOptions) {
    this.#responseLabel = options.responseLabel;
    this.#intentRouter = options.intentRouter;
    this.#securityPolicy = options.securityPolicy;
    this.#trajectoryRecorder = options.trajectoryRecorder;
    this.#sessionDb = options.sessionDb;
    this.#sessionId = options.sessionId;
    this.#toolExecutor = options.toolExecutor;
    this.#toolCallPlanner = options.toolCallPlanner;
    this.#providerExecutor = options.providerExecutor;
    this.#memoryProvider = options.memoryProvider;
    this.#memoryContext = options.memoryContext;
    this.#model = options.model;
    this.#providerPreferences = options.providerPreferences ?? {};
    this.#contextReferenceExpander = options.contextReferenceExpander;
    this.#projectContext = options.projectContext;
    this.#providerTools = options.providerTools ?? [];
    this.#promptCache = new PromptCache();
    this.#soul = options.soul;
    this.#frozenMemory = options.frozenMemory;
    this.#skillsIndex = options.skillsIndex ?? [];
    this.#budgets = {
      maxProviderIterations: options.budgets?.maxProviderIterations ?? options.maxProviderIterations ?? 4,
      maxProviderToolCalls: options.budgets?.maxProviderToolCalls ?? 12,
      maxRepeatedToolFailures: options.budgets?.maxRepeatedToolFailures ?? 2,
      maxProviderWallClockMs: options.budgets?.maxProviderWallClockMs ?? 180_000,
      maxConcurrentSafeTools: options.budgets?.maxConcurrentSafeTools ?? 4
    };
  }

  async handle(input: AgentLoopInput): Promise<AgentLoopResponse> {
    const latestResumeNote = await this.#latestResumeNote();
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
      sessionId: this.#sessionId,
      input: effectiveText
    });
    if (isAborted(input.signal)) {
      const resumeNote = buildResumeNote({
        stage: "startup",
        userText: effectiveText
      });
      await this.#recordCancellation({
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

    await this.#sessionDb.appendMessage({
      sessionId: this.#sessionId,
      role: "user",
      content: effectiveText,
      channel: input.channel,
      metadata: {
        contextReferences: context?.references.map((reference) => reference.raw) ?? [],
        projectContextFiles: this.#projectContext?.files.map((file) => file.source) ?? []
      }
    });

    this.#trajectoryRecorder.record("user-input", {
      text: effectiveText,
      channel: input.channel,
      contextReferences: context?.references.map((reference) => reference.raw) ?? []
    });

    if (context !== undefined && context.references.length > 0) {
      await this.#sessionDb.appendEvent(this.#sessionId, {
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

    const trustedWorkspace = input.trustedWorkspace ?? false;
    if (isAborted(input.signal)) {
      const resumeNote = buildResumeNote({
        stage: "context expansion",
        userText: effectiveText,
        context,
        projectContext: this.#projectContext
      });
      await this.#recordCancellation({
        reason: "cancelled before routing",
        resumeNote
      }, input.onEvent);

      return cancelledResponse({
        label: this.#responseLabel,
        resumeNote
      });
    }
    const intent = this.#intentRouter.route(routedText);
    await emit(input.onEvent, {
      kind: "intent",
      labels: intent.labels,
      confidence: intent.confidence
    });
    const selectedSkill = intent.suggestedSkills[0];
    const selectedSkillInstructions = selectedSkill === undefined || !isLoadedSkill(selectedSkill)
      ? undefined
      : selectedSkill.instructions;
    const selectedSkillResources = selectedSkill === undefined || !isLoadedSkill(selectedSkill)
      ? undefined
      : selectedSkill.resources;

    await this.#sessionDb.appendEvent(this.#sessionId, {
      kind: "intent-routed",
      route: intent
    });

    this.#trajectoryRecorder.record("progress", {
      message: "intent routed",
      labels: intent.labels,
      confidence: intent.confidence,
      confirmationRequired: intent.confirmationRequired,
      suggestedToolsets: intent.suggestedToolsets
    });

    if (selectedSkill !== undefined) {
      await emit(input.onEvent, {
        kind: "skill",
        name: selectedSkill.name
      });
      await this.#sessionDb.appendEvent(this.#sessionId, {
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

    const securityDecision = this.#securityPolicy.decide({
      riskClass: inferInitialRiskClass(selectedSkill),
      description: selectedSkill === undefined ? "respond to user prompt" : `run skill ${selectedSkill.name}`,
      context: {
        trustedWorkspace,
        activeChannel: input.channel,
        targetChannel: input.channel,
        targetConversationIsActive: true
      }
    });

    await this.#sessionDb.appendEvent(this.#sessionId, {
      kind: "security-decided",
      decision: securityDecision,
      description: selectedSkill === undefined ? "respond to user prompt" : `run skill ${selectedSkill.name}`
    });

    this.#trajectoryRecorder.record("progress", {
      message: selectedSkill === undefined ? "no skill selected" : `selected ${selectedSkill.name}`,
      securityDecision
    });

    if (selectedSkill !== undefined && !intent.confirmationRequired) {
      await this.#recordWorkflowPlan(compileSkillWorkflowPlan(selectedSkill));
    }

    const useDeterministicSkillWorkflow = this.#providerExecutor === undefined ||
      this.#model === undefined ||
      this.#model.provider === "unconfigured";
    const toolExecutions = useDeterministicSkillWorkflow
      ? await this.#executeSkillWorkflow({
      selectedSkill,
      intent,
      trustedWorkspace,
      signal: input.signal,
      text: routedText,
      onEvent: input.onEvent
      })
      : [];
    const recordedArtifactIds = new Set<string>();
    const artifacts = await this.#recordArtifactsFromExecutions(toolExecutions, recordedArtifactIds);
    const toolPlans: ToolCallPlan[] = [];

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
      projectContext: this.#projectContext,
      memoryContext: this.#memoryContext
    });
    const providerTools = this.#model?.supportsTools === true ? this.#providerTools : [];
    const providerLoop = await this.#runProviderLoop({
      userText: effectiveText,
      routedText,
      selectedSkill,
      selectedSkillInstructions,
      selectedSkillResources,
      intent,
      securityDecision,
      toolExecutions,
      context,
      projectContext: this.#projectContext,
      memoryContext: this.#memoryContext,
      providerTools,
      fallbackText: fallbackResponse.text,
      onEvent: input.onEvent,
      toolPlans,
      trustedWorkspace,
      signal: input.signal
    });
    const effectiveProviderExecution = providerLoop.providerExecution;

    toolExecutions.push(...providerLoop.toolExecutions);
    artifacts.push(...(await this.#recordArtifactsFromExecutions(providerLoop.toolExecutions, recordedArtifactIds)));
    if (isAborted(input.signal)) {
      await this.#markPlannedToolPlansCancelled(toolPlans, "Cancelled by user before the turn completed.");
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
      await this.#recordCancellation({
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
      await this.#appendCancelledAssistantMessage({
        response,
        channel: input.channel
      });

      return response;
    }
    const skillOutcomes = await this.#recordSkillOutcomes({
      selectedSkill,
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
      sessionId: this.#sessionId,
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

    return response;
  }

  async #executeSkillWorkflow(input: {
    selectedSkill: LoadedSkill | SkillDefinition | undefined;
    intent: IntentRoute;
    trustedWorkspace: boolean;
    text: string;
    signal?: AbortSignal;
    onEvent?: RuntimeEventSink;
  }): Promise<ToolExecutionRecord[]> {
    if (input.selectedSkill === undefined || input.intent.confirmationRequired) {
      return [];
    }

    const executions: ToolExecutionRecord[] = [];
    const previousResults: string[] = [];
    const usedTools = new Set<string>();
    const plan = compileSkillWorkflowPlan(input.selectedSkill);
    const stepMap = new Map(plan.steps.map((step, index) => [step.id, { step, index }]));
    const visited = new Set<string>();
    let stepIndex = 0;

    while (stepIndex < plan.steps.length && executions.length < 4) {
      if (isAborted(input.signal)) {
        break;
      }
      const step = plan.steps[stepIndex];
      if (step === undefined || visited.has(step.id)) {
        stepIndex += 1;
        continue;
      }
      visited.add(step.id);
      step.status = "running";
      const execution = await this.#executeWorkflowStep({
        skill: input.selectedSkill,
        step,
        intent: input.intent,
        trustedWorkspace: input.trustedWorkspace,
        previousResults,
        usedTools,
        text: input.intent.invocation?.args ?? input.text,
        onEvent: input.onEvent
      });

      if (execution === undefined) {
        step.status = "failed";
        step.reason = "No available tool for this workflow step yet.";
        const fallbackIndex = nextFallbackIndex(plan, step, stepMap);
        if (fallbackIndex !== undefined) {
          step.status = "fallback-used";
          step.reason = `Falling back to ${plan.steps[fallbackIndex]?.id ?? "next fallback"}.`;
          stepIndex = fallbackIndex;
          continue;
        }
        stepIndex += 1;
        continue;
      }

      executions.push(execution);
      usedTools.add(execution.tool.name);
      step.tool = execution.tool.name;
      step.status = execution.decision === "allow" && execution.result?.ok !== false
        ? "succeeded"
        : execution.decision === "allow"
          ? "failed"
          : "blocked";

      if (execution.result?.content !== undefined) {
        previousResults.push(renderToolResultPacket(packetizeToolExecution({
          execution,
          maxChars: 600
        })));
      }

      if (execution.decision !== "allow") {
        break;
      }
      if (execution.result?.ok === false) {
        const fallbackIndex = nextFallbackIndex(plan, step, stepMap);
        if (fallbackIndex !== undefined) {
          step.status = "fallback-used";
          step.reason = `Falling back to ${plan.steps[fallbackIndex]?.id ?? "next fallback"}.`;
          stepIndex = fallbackIndex;
          continue;
        }
      }
      stepIndex += 1;
    }

    return executions;
  }

  async #executeWorkflowStep(input: {
    skill: LoadedSkill | SkillDefinition;
    step: SkillWorkflowPlanStep;
    intent: IntentRoute;
    trustedWorkspace: boolean;
    previousResults: string[];
    usedTools: Set<string>;
    text: string;
    onEvent?: RuntimeEventSink;
  }): Promise<ToolExecutionRecord | undefined> {
    const toolsets = input.step.preferredToolsets;

    for (const toolset of toolsets) {
      const toolInput = {
        skill: input.skill.name,
        intent: input.intent.labels,
        text: input.text,
        url: extractFirstUrl(input.text),
        firstStep: input.skill.workflow[0]?.description,
        workflowStep: input.step.id,
        stepDescription: input.step.description,
        previousResults: input.previousResults.map((result) => truncate(result, 500))
      };
      const preferredTool = input.step.preferredTool ?? preferredToolForStep(input.step, toolset);
      let emittedStart = false;
      if (preferredTool !== undefined && !input.usedTools.has(preferredTool)) {
        await emit(input.onEvent, {
          kind: "tool-start",
          tool: preferredTool,
          stepId: input.step.id
        });
        emittedStart = true;
      }
      const execution = preferredTool === undefined || input.usedTools.has(preferredTool)
        ? await this.#toolExecutor.executeFirstAvailable({
            toolset,
            sessionId: this.#sessionId,
            trustedWorkspace: input.trustedWorkspace,
            excludedTools: [...input.usedTools],
            input: toolInput
          })
        : await this.#toolExecutor.executeTool({
            tool: preferredTool,
            sessionId: this.#sessionId,
            trustedWorkspace: input.trustedWorkspace,
            input: toolInput
          });

      if (execution === undefined) {
        continue;
      }
      if (!emittedStart) {
        await emit(input.onEvent, {
          kind: "tool-start",
          tool: execution.tool.name,
          stepId: input.step.id
        });
      }

      await this.#recordWorkflowStep({
        skill: input.skill.name,
        step: input.step,
        status: execution.decision === "allow" ? "tool-executed" : "blocked",
        toolsets,
        tool: execution.tool.name,
        reason: execution.decision === "allow" ? undefined : `security decision: ${execution.decision}`
      });
      await emit(input.onEvent, {
        kind: "tool-result",
        tool: execution.tool.name,
        decision: execution.decision,
        riskClass: execution.riskClass,
        ok: execution.result?.ok,
        ...toolResultStats(execution)
      });

      return execution;
    }

    await this.#recordWorkflowStep({
      skill: input.skill.name,
      step: input.step,
      status: "no-tool",
      toolsets,
      reason: "No available tool for this workflow step yet."
    });

    return undefined;
  }

  async #recordWorkflowStep(input: {
    skill: string;
    step: SkillWorkflowStep | SkillWorkflowPlanStep;
    status: "tool-executed" | "no-tool" | "blocked" | "skipped";
    toolsets: ToolsetName[];
    tool?: string;
    reason?: string;
  }): Promise<void> {
    await this.#sessionDb.appendEvent(this.#sessionId, {
      kind: "skill-workflow-step",
      skill: input.skill,
      stepId: input.step.id,
      description: input.step.description,
      status: input.status,
      toolsets: input.toolsets,
      tool: input.tool,
      reason: input.reason
    });
    this.#trajectoryRecorder.record("skill-workflow-step", {
      skill: input.skill,
      stepId: input.step.id,
      description: input.step.description,
      status: input.status,
      toolsets: input.toolsets,
      tool: input.tool,
      reason: input.reason
    });
  }

  async #recordWorkflowPlan(plan: SkillWorkflowPlan): Promise<void> {
    await this.#sessionDb.appendEvent(this.#sessionId, {
      kind: "skill-workflow-planned",
      plan
    });
    this.#trajectoryRecorder.record("skill-workflow-planned", {
      plan
    });
  }

  async #recordArtifactsFromExecutions(
    executions: ToolExecutionRecord[],
    recordedIds: Set<string>
  ): Promise<ArtifactRecord[]> {
    const artifacts: ArtifactRecord[] = [];

    for (const execution of executions) {
      const artifact = artifactFromExecution(execution);
      if (artifact === undefined || recordedIds.has(artifact.id)) {
        continue;
      }

      recordedIds.add(artifact.id);
      artifacts.push(artifact);
      await this.#sessionDb.appendEvent(this.#sessionId, {
        kind: "artifact-created",
        artifact,
        tool: execution.tool.name
      });
      this.#trajectoryRecorder.record("artifact-created", {
        artifact,
        tool: execution.tool.name
      });
    }

    return artifacts;
  }

  async #executeProviderToolPlans(input: {
    providerExecution: ProviderExecutionResult | undefined;
    toolPlans: ToolCallPlan[];
    trustedWorkspace: boolean;
    remainingToolCalls: number;
    signal?: AbortSignal;
    onEvent?: RuntimeEventSink;
  }): Promise<ToolExecutionRecord[]> {
    if (this.#toolCallPlanner === undefined || input.providerExecution === undefined) {
      return [];
    }

    const executions: ToolExecutionRecord[] = [];
    const pending: Array<{
      plan: ToolCallPlan;
      definition: ToolDefinition | undefined;
    }> = [];

    for (const toolCall of input.providerExecution.toolCalls.slice(0, input.remainingToolCalls)) {
      const plan = this.#toolCallPlanner.planFromProviderDelta(toolCall);

      input.toolPlans.push(plan);
      await this.#recordToolPlan(plan);

      if (plan.status !== "planned") {
        continue;
      }

      pending.push({
        plan,
        definition: this.#toolExecutor.getToolDefinition(plan.tool)
      });
    }

    for (const group of groupProviderToolPlans(pending, this.#budgets.maxConcurrentSafeTools)) {
      if (group.concurrent) {
        const groupExecutions = await Promise.all(group.entries.map(async ({ plan }) =>
          this.#executeProviderToolPlan({
            plan,
            trustedWorkspace: input.trustedWorkspace,
            signal: input.signal,
            onEvent: input.onEvent
          })
        ));

        executions.push(...groupExecutions.filter((execution) => execution !== undefined));
        continue;
      }

      for (const { plan } of group.entries) {
        const execution = await this.#executeProviderToolPlan({
          plan,
          trustedWorkspace: input.trustedWorkspace,
          signal: input.signal,
          onEvent: input.onEvent
        });
        if (execution !== undefined) {
          executions.push(execution);
        }
      }
    }

    return executions;
  }

  async #executeProviderToolPlan(input: {
    plan: ToolCallPlan;
    trustedWorkspace: boolean;
    signal?: AbortSignal;
    onEvent?: RuntimeEventSink;
  }): Promise<ToolExecutionRecord | undefined> {
    const plan = input.plan;

      await emit(input.onEvent, {
        kind: "tool-start",
        tool: plan.tool
      });

      const execution = await this.#toolExecutor.executeTool({
        tool: plan.tool,
        input: plan.input,
        trustedWorkspace: input.trustedWorkspace,
        sessionId: this.#sessionId,
        signal: input.signal
      });

      if (execution === undefined) {
        plan.status = "unavailable";
        plan.error = `Tool is unavailable: ${plan.tool}`;
        await this.#recordToolPlan(plan);
        return undefined;
      }

      plan.status = execution.decision === "allow" ? "executed" : "blocked";
      plan.result = execution.result;
      if (execution.decision !== "allow") {
        plan.error = `security decision: ${execution.decision}`;
      }
      await this.#recordToolPlan(plan);
      await emit(input.onEvent, {
        kind: "tool-result",
        tool: execution.tool.name,
        decision: execution.decision,
        riskClass: execution.riskClass,
        ok: execution.result?.ok,
        ...toolResultStats(execution)
      });

      return execution;
  }

  async #recordSkillOutcomes(input: {
    selectedSkill: LoadedSkill | SkillDefinition | undefined;
    toolExecutions: ToolExecutionRecord[];
    toolPlans: ToolCallPlan[];
  }): Promise<SkillOutcome[]> {
    if (
      this.#memoryProvider === undefined ||
      input.selectedSkill === undefined ||
      (input.toolExecutions.length === 0 && input.toolPlans.length === 0)
    ) {
      return [];
    }

    const succeeded = input.toolExecutions.filter((execution) => execution.result?.ok === true);
    const failed = input.toolExecutions.filter((execution) => execution.result?.ok === false);
    const blocked = input.toolExecutions.filter((execution) => execution.decision !== "allow");
    const executedPlans = input.toolPlans.filter((plan) => plan.status === "executed");
    const blockedPlans = input.toolPlans.filter((plan) => plan.status === "blocked");
    const failedPlans = input.toolPlans.filter((plan) => plan.status === "invalid" || plan.status === "unavailable");
    const status: SkillOutcome["status"] =
      blocked.length > 0 || blockedPlans.length > 0
        ? "blocked"
        : (failed.length > 0 || failedPlans.length > 0) && (succeeded.length > 0 || executedPlans.length > 0)
          ? "partial"
          : failed.length > 0 || failedPlans.length > 0
            ? "failed"
            : "succeeded";
    const outcome: SkillOutcome = {
      skill: input.selectedSkill.name,
      summary: summarizeSkillOutcome(input.selectedSkill.name, input.toolExecutions, input.toolPlans),
      status,
      tools: [...new Set([
        ...input.toolExecutions.map((execution) => execution.tool.name),
        ...input.toolPlans.map((plan) => plan.tool).filter((tool) => tool.length > 0)
      ])],
      memoryTargets: ["MEMORY.md"],
      metadata: {
        plannedTools: input.toolPlans.map((plan) => ({
          tool: plan.tool,
          status: plan.status
        }))
      }
    };

    await this.#memoryProvider.recordSkillOutcome(outcome);
    this.#trajectoryRecorder.record("memory-write", {
      provider: this.#memoryProvider.id,
      outcome
    });
    await this.#sessionDb.appendEvent(this.#sessionId, {
      kind: "memory-write",
      provider: this.#memoryProvider.id,
      outcome
    });

    return [outcome];
  }

  async #recordToolPlan(plan: ToolCallPlan): Promise<void> {
    await this.#sessionDb.appendEvent(this.#sessionId, {
      kind: "tool-plan",
      plan
    });
    this.#trajectoryRecorder.record("tool-plan", {
      id: plan.id,
      tool: plan.tool,
      status: plan.status,
      source: plan.source,
      error: plan.error
    });
  }

  async #runProviderLoop(input: {
    userText: string;
    routedText: string;
    selectedSkill: LoadedSkill | SkillDefinition | undefined;
    selectedSkillInstructions: string | undefined;
    selectedSkillResources: LoadedSkill["resources"] | undefined;
    intent: IntentRoute;
    securityDecision: SecurityDecision;
    toolExecutions: ToolExecutionRecord[];
    context: ContextExpansionResult | undefined;
    projectContext: ProjectContextSnapshot | undefined;
    memoryContext: MemoryProviderContext | undefined;
    providerTools: OpenAICompatibleToolSchema[];
    fallbackText: string;
    onEvent?: RuntimeEventSink;
    toolPlans: ToolCallPlan[];
    trustedWorkspace: boolean;
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

    for (let iteration = 0; iteration < this.#budgets.maxProviderIterations; iteration += 1) {
      if (isAborted(input.signal)) {
        await this.#recordProviderBudgetExhausted({
          budget: "abort-signal",
          limit: 1,
          observed: 1,
          reason: "Provider loop was cancelled before the next iteration."
        }, input.onEvent);
        break;
      }
      const elapsedMs = Date.now() - loopStartedAt;
      if (elapsedMs > this.#budgets.maxProviderWallClockMs) {
        await this.#recordProviderBudgetExhausted({
          budget: "provider-wall-clock-ms",
          limit: this.#budgets.maxProviderWallClockMs,
          observed: elapsedMs,
          reason: "Provider loop exceeded its wall-clock budget."
        }, input.onEvent);
        break;
      }
      if (providerToolExecutions.length >= this.#budgets.maxProviderToolCalls) {
        await this.#recordProviderBudgetExhausted({
          budget: "provider-tool-calls",
          limit: this.#budgets.maxProviderToolCalls,
          observed: providerToolExecutions.length,
          reason: "Provider loop reached its tool-call execution budget."
        }, input.onEvent);
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
      const loopToolExecutions = await this.#executeProviderToolPlans({
        providerExecution: execution,
        toolPlans: input.toolPlans,
        trustedWorkspace: input.trustedWorkspace,
        remainingToolCalls: Math.max(0, this.#budgets.maxProviderToolCalls - providerToolExecutions.length),
        signal: input.signal,
        onEvent: input.onEvent
      });
      providerToolExecutions.push(...loopToolExecutions);
      const currentPlans = input.toolPlans.slice(beforePlans);
      const hasRecoverableToolFeedback = currentPlans.some((plan) => isRecoverableToolPlanStatus(plan.status));
      const repeatedFailureBudgetExceeded = this.#recordRepeatedToolFailures(loopToolExecutions, repeatedFailures);
      if (repeatedFailureBudgetExceeded !== undefined) {
        await this.#recordProviderBudgetExhausted({
          budget: "repeated-tool-failures",
          limit: this.#budgets.maxRepeatedToolFailures,
          observed: repeatedFailureBudgetExceeded.count,
          reason: `Tool ${repeatedFailureBudgetExceeded.tool} failed repeatedly with the same outcome.`
        }, input.onEvent);
      }
      const exhausted = (
        iteration + 1 >= this.#budgets.maxProviderIterations ||
        providerToolExecutions.length >= this.#budgets.maxProviderToolCalls ||
        repeatedFailureBudgetExceeded !== undefined
      ) && execution.toolCalls.length > 0 && loopToolExecutions.length > 0;

      await this.#recordProviderIteration({
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

  async #recordProviderBudgetExhausted(input: {
    budget: string;
    limit: number;
    observed: number;
    reason: string;
  }, sink: RuntimeEventSink | undefined): Promise<void> {
    await this.#sessionDb.appendEvent(this.#sessionId, {
      kind: "provider-budget-exhausted",
      ...input
    });
    this.#trajectoryRecorder.record("provider-budget-exhausted", input);
    await emit(sink, {
      kind: "provider-budget-exhausted",
      ...input
    });
  }

  async #recordCancellation(input: {
    reason: string;
    resumeNote?: string;
    activeSkill?: string;
    activeToolPlans?: ToolCallPlan[];
  }, sink: RuntimeEventSink | undefined): Promise<void> {
    await this.#sessionDb.appendEvent(this.#sessionId, {
      kind: "agent-cancelled",
      reason: input.reason,
      resumeNote: input.resumeNote,
      activeSkill: input.activeSkill,
      activeToolPlans: input.activeToolPlans?.map((plan) => ({
        id: plan.id,
        tool: plan.tool,
        status: plan.status
      }))
    });
    this.#trajectoryRecorder.record("agent-cancelled", {
      reason: input.reason,
      resumeNote: input.resumeNote,
      activeSkill: input.activeSkill,
      activeToolPlans: input.activeToolPlans?.map((plan) => ({
        id: plan.id,
        tool: plan.tool,
        status: plan.status
      }))
    });
    await emit(sink, {
      kind: "agent-cancelled",
      reason: input.reason,
      resumeNote: input.resumeNote
    });
  }

  async #latestResumeNote(): Promise<string | undefined> {
    const events = await this.#sessionDb.listEvents(this.#sessionId);
    const cancelled = [...events].reverse().find((event) => event.kind === "agent-cancelled" && event.resumeNote !== undefined);

    return cancelled?.kind === "agent-cancelled" ? cancelled.resumeNote : undefined;
  }

  async #markPlannedToolPlansCancelled(plans: ToolCallPlan[], reason: string): Promise<void> {
    for (const plan of plans) {
      if (plan.status !== "planned") {
        continue;
      }

      plan.status = "cancelled";
      plan.error = reason;
      await this.#recordToolPlan(plan);
    }
  }

  async #appendCancelledAssistantMessage(input: {
    response: AgentLoopResponse;
    channel: ChannelKind;
  }): Promise<void> {
    await this.#sessionDb.appendMessage({
      sessionId: this.#sessionId,
      role: "agent",
      content: input.response.text,
      channel: input.channel,
      metadata: {
        cancelled: true,
        resumeNote: input.response.progress.find((entry) => entry.startsWith("resume:"))?.replace(/^resume:\s*/u, ""),
        toolPlans: input.response.toolPlans.map((plan) => ({
          id: plan.id,
          tool: plan.tool,
          status: plan.status,
          error: plan.error
        }))
      }
    });
  }

  async #recordProviderIteration(input: {
    iteration: number;
    phase: "initial" | "continuation";
    ok: boolean;
    toolCalls: number;
    executedTools: number;
    exhausted: boolean;
  }): Promise<void> {
    await this.#sessionDb.appendEvent(this.#sessionId, {
      kind: "provider-iteration",
      ...input
    });
    this.#trajectoryRecorder.record("provider-iteration", input);
  }

  async #completeWithProvider(input: {
    userText: string;
    routedText: string;
      selectedSkill: LoadedSkill | SkillDefinition | undefined;
      selectedSkillInstructions: string | undefined;
      selectedSkillResources: LoadedSkill["resources"] | undefined;
    intent: IntentRoute;
    securityDecision: SecurityDecision;
    toolExecutions: ToolExecutionRecord[];
    context: ContextExpansionResult | undefined;
    projectContext: ProjectContextSnapshot | undefined;
    memoryContext: MemoryProviderContext | undefined;
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

    const sessionHistory = await this.#providerSessionHistory();
    const prompt = assembleProviderPrompt({
      ...input,
      model: this.#model,
      cache: this.#promptCache,
      sessionHistory,
      soul: this.#soul,
      frozenMemory: this.#frozenMemory,
      skillsIndex: this.#skillsIndex,
      selectedSkillResources: input.selectedSkillResources
    });
    await this.#recordPromptAssembly(prompt.budget);

    const execution = await this.#providerExecutor.complete(normalizeProviderRequest({
      model: this.#model.id,
      messages: prompt.messages,
      temperature: 0.2,
      maxTokens: 1_200,
      tools: this.#model.supportsTools && this.#providerTools.length > 0
        ? this.#providerTools
        : undefined
    }), {
      requireTools: this.#model.supportsTools,
      requireVision: false,
      requireStructuredOutput: false,
      providerOrder: [this.#model.provider],
      ...this.#providerPreferences
    }, {
      sessionId: this.#sessionId,
      stream: true,
      signal: input.signal,
      onEvent: async (event) => {
        await emit(input.onEvent, mapProviderRuntimeEvent(event));
      }
    });

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

    return execution;
  }

  async #continueProviderAfterTools(input: {
    userText: string;
    routedText: string;
    selectedSkill: LoadedSkill | SkillDefinition | undefined;
    selectedSkillInstructions: string | undefined;
    selectedSkillResources: LoadedSkill["resources"] | undefined;
    intent: IntentRoute;
    securityDecision: SecurityDecision;
    toolExecutions: ToolExecutionRecord[];
    context: ContextExpansionResult | undefined;
    projectContext: ProjectContextSnapshot | undefined;
    memoryContext: MemoryProviderContext | undefined;
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

    const sessionHistory = await this.#providerSessionHistory();
    const prompt = assembleProviderContinuationPrompt({
      ...input,
      model: this.#model,
      cache: this.#promptCache,
      sessionHistory,
      soul: this.#soul,
      frozenMemory: this.#frozenMemory,
      skillsIndex: this.#skillsIndex,
      selectedSkillResources: input.selectedSkillResources
    });
    await this.#recordPromptAssembly(prompt.budget);

    const execution = await this.#providerExecutor.complete(normalizeProviderRequest({
      model: this.#model.id,
      messages: prompt.messages,
      temperature: 0.2,
      maxTokens: 1_200,
      tools: this.#model.supportsTools && this.#providerTools.length > 0
        ? this.#providerTools
        : undefined
    }), {
      requireTools: this.#model.supportsTools,
      requireVision: false,
      requireStructuredOutput: false,
      providerOrder: [this.#model.provider],
      ...this.#providerPreferences
    }, {
      sessionId: this.#sessionId,
      stream: true,
      signal: input.signal,
      onEvent: async (event) => {
        await emit(input.onEvent, mapProviderRuntimeEvent(event));
      }
    });

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

    return execution;
  }

  async #recordPromptAssembly(budget: PromptBudgetReport): Promise<void> {
    await this.#sessionDb.appendEvent(this.#sessionId, {
      kind: "prompt-assembled",
      budget
    });
    this.#trajectoryRecorder.record("prompt-assembled", {
      budget
    });
  }

  async #providerSessionHistory(): Promise<Array<Pick<ProviderMessage, "role" | "content">>> {
    const messages = await this.#sessionDb.listMessages(this.#sessionId);
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

    return packed.messages;
  }
}

function preferredToolsets(step: SkillWorkflowStep): ToolsetName[] {
  const toolsets = step.toolsets ?? ["research"];

  return toolsets.length === 0 ? ["research"] : toolsets;
}

function preferredToolForStep(
  step: SkillWorkflowStep | SkillWorkflowPlanStep,
  toolset: ToolsetName
): string | undefined {
  if (step.id.includes("extract") && toolset === "web") {
    return "web.extract";
  }

  if (step.id.includes("browser") && toolset === "browser") {
    return "browser.navigate";
  }

  return undefined;
}

function nextFallbackIndex(
  plan: SkillWorkflowPlan,
  step: SkillWorkflowPlanStep,
  stepMap: Map<string, { step: SkillWorkflowPlanStep; index: number }>
): number | undefined {
  for (const fallbackId of step.fallbackTo) {
    const fallback = stepMap.get(fallbackId);
    if (fallback !== undefined && fallback.step.status === "planned") {
      return fallback.index;
    }
  }

  return undefined;
}

function extractFirstUrl(text: string): string | undefined {
  return /https?:\/\/[^\s<>"')]+/iu.exec(text)?.[0];
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

function isLoadedSkill(skill: LoadedSkill | SkillDefinition): skill is LoadedSkill {
  return "instructions" in skill && "sourcePath" in skill;
}

function buildFallbackResponse(input: {
  label: string;
  selectedSkill: LoadedSkill | SkillDefinition | undefined;
  intent: IntentRoute;
  securityDecision: SecurityDecision;
  toolExecutions: ToolExecutionRecord[];
  toolPlans: ToolCallPlan[];
  skillOutcomes: SkillOutcome[];
  artifacts: ArtifactRecord[];
  context: ContextExpansionResult | undefined;
  projectContext: ProjectContextSnapshot | undefined;
  memoryContext: MemoryProviderContext | undefined;
}): AgentLoopResponse {
  const contextProgress = [
    ...(input.context === undefined
      ? []
      : [`context refs: ${input.context.blocks.filter((block) => block.content.length > 0).length}/${input.context.references.length}`]),
    ...(input.projectContext === undefined || input.projectContext.files.length === 0
      ? []
      : [`project context: ${input.projectContext.files.map((file) => file.source).join(", ")}`])
  ];

  if (input.selectedSkill === undefined) {
    return {
      label: input.label,
      text: "I did not find a matching skill yet. I would answer directly and record this interaction for future skill discovery.",
      matchedSkills: [],
      intent: input.intent,
      securityDecision: input.securityDecision,
      toolExecutions: input.toolExecutions,
      toolPlans: input.toolPlans,
      skillOutcomes: input.skillOutcomes,
      artifacts: input.artifacts,
      context: input.context,
      projectContext: input.projectContext,
      providerExecution: undefined,
      progress: [
        "received prompt",
        ...contextProgress,
        `intent: ${input.intent.labels.join(", ")}`,
        "no skill selected",
        "ready for direct response"
      ]
    };
  }

  const confirmationText = input.intent.confirmationRequired
    ? "I matched it, but this route needs confirmation before I persist changes."
    : `I matched the ${input.selectedSkill.name} skill and can begin its workflow without asking first.`;

  return {
    label: input.label,
    text: confirmationText,
    matchedSkills: input.intent.suggestedSkills.map((skill) => skill.name),
    intent: input.intent,
    securityDecision: input.securityDecision,
      toolExecutions: input.toolExecutions,
      toolPlans: input.toolPlans,
      skillOutcomes: input.skillOutcomes,
      artifacts: input.artifacts,
      context: input.context,
    projectContext: input.projectContext,
    providerExecution: undefined,
    progress: [
      "received prompt",
      ...contextProgress,
      `intent: ${input.intent.labels.join(", ")}`,
      `confidence: ${Math.round(input.intent.confidence * 100)}%`,
      `selected skill: ${input.selectedSkill.name}`,
      `security: ${input.securityDecision}`,
      ...input.toolExecutions.map(
        (execution) => `tool: ${execution.tool.name} (${execution.decision}${execution.result === undefined ? "" : `/${execution.result.ok ? "ok" : "error"}`})`
      ),
      ...renderArtifactProgress(input.artifacts),
      `next: ${input.selectedSkill.workflow[0]?.description ?? "run skill workflow"}`
    ]
  };
}

function cancelledResponse(input: {
  label: string;
  resumeNote: string;
  intent?: IntentRoute;
  securityDecision?: SecurityDecision;
  selectedSkill?: LoadedSkill | SkillDefinition;
  toolExecutions?: ToolExecutionRecord[];
  toolPlans?: ToolCallPlan[];
  artifacts?: ArtifactRecord[];
  context?: ContextExpansionResult;
  projectContext?: ProjectContextSnapshot;
  providerExecution?: ProviderExecutionResult;
}): AgentLoopResponse {
  return {
    label: input.label,
    text: [
      "Cancelled this turn. The session is still available, and you can resume when ready.",
      "",
      input.resumeNote
    ].join("\n"),
    matchedSkills: input.selectedSkill === undefined ? [] : [input.selectedSkill.name],
    intent: input.intent ?? {
      labels: ["general"],
      confidence: 1,
      suggestedSkills: [],
      suggestedToolsets: [],
      confirmationRequired: false,
      rationale: "The active turn was cancelled before completion."
    },
    securityDecision: input.securityDecision ?? "allow",
    toolExecutions: input.toolExecutions ?? [],
    toolPlans: input.toolPlans ?? [],
    skillOutcomes: [],
    artifacts: input.artifacts ?? [],
    context: input.context,
    projectContext: input.projectContext,
    providerExecution: input.providerExecution,
    progress: [
      "received prompt",
      "cancelled",
      `resume: ${input.resumeNote}`
    ]
  };
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

function isResumeRequest(text: string): boolean {
  return /^(resume|resume that|continue|continue that|pick up where we left off)\b/iu.test(text.trim());
}

function buildResumeNote(input: {
  stage: string;
  userText: string;
  selectedSkill?: LoadedSkill | SkillDefinition;
  toolPlans?: ToolCallPlan[];
  toolExecutions?: ToolExecutionRecord[];
  providerExecution?: ProviderExecutionResult;
  context?: ContextExpansionResult;
  projectContext?: ProjectContextSnapshot;
}): string {
  const planned = input.toolPlans?.filter((plan) => plan.status === "planned" || plan.status === "cancelled") ?? [];
  const executed = input.toolExecutions?.map((execution) => execution.tool.name) ?? [];
  const provider = input.providerExecution?.response === undefined
    ? undefined
    : `${input.providerExecution.response.provider}/${input.providerExecution.response.model}`;
  const lines = [
    `Resume note: interrupted during ${input.stage}.`,
    `Original request: ${truncate(input.userText, 220)}`,
    input.selectedSkill === undefined ? undefined : `Skill: ${input.selectedSkill.name}`,
    provider === undefined ? undefined : `Provider: ${provider}`,
    executed.length === 0 ? undefined : `Tools completed: ${[...new Set(executed)].join(", ")}`,
    planned.length === 0 ? undefined : `Tool plans to revisit: ${planned.map((plan) => plan.tool || "unknown").join(", ")}`,
    input.context === undefined ? undefined : `Context refs loaded: ${input.context.blocks.filter((block) => block.content.length > 0).length}/${input.context.references.length}`,
    input.projectContext === undefined || input.projectContext.files.length === 0
      ? undefined
      : `Project context: ${input.projectContext.files.map((file) => file.source).join(", ")}`,
    "Send a follow-up like 'resume that' or restate the next step to continue from here."
  ].filter((line) => line !== undefined);

  return lines.join("\n");
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n[truncated ${value.length - maxChars} chars]`;
}

function renderToolPlanProgress(plans: ToolCallPlan[]): string[] {
  return plans.length === 0
    ? []
    : plans.map((plan) => `tool plan: ${plan.tool || "unknown"} (${plan.status})`);
}

function renderArtifactProgress(artifacts: ArtifactRecord[]): string[] {
  return artifacts.map((artifact) => `artifact: ${artifact.path} (${artifact.kind}, ${formatBytes(artifact.bytes)})`);
}

function appendArtifactSummary(text: string, artifacts: ArtifactRecord[]): string {
  if (artifacts.length === 0) {
    return text;
  }

  const lower = text.toLowerCase();
  const missingArtifacts = artifacts.filter((artifact) => !lower.includes(artifact.path.toLowerCase()));
  if (missingArtifacts.length === 0) {
    return text;
  }

  return [
    text.trimEnd(),
    "",
    "Artifacts:",
    ...missingArtifacts.map((artifact) =>
      `- ${artifact.path} (${artifact.kind}, ${formatBytes(artifact.bytes)})${artifact.summary === undefined ? "" : ` - ${artifact.summary}`}`
    )
  ].join("\n");
}

function renderArtifactSummary(artifacts: ArtifactRecord[]): string {
  if (artifacts.length === 0) {
    return "No artifacts have been recorded yet.";
  }

  return artifacts
    .map((artifact) => [
      `- ${artifact.path}`,
      `  id: ${artifact.id}`,
      `  kind: ${artifact.kind}`,
      `  size: ${formatBytes(artifact.bytes)}`,
      artifact.mimeType === undefined ? undefined : `  mime: ${artifact.mimeType}`,
      artifact.summary === undefined ? undefined : `  summary: ${artifact.summary}`
    ].filter((line) => line !== undefined).join("\n"))
    .join("\n");
}

function artifactsFromExecutions(executions: ToolExecutionRecord[]): ArtifactRecord[] {
  const seen = new Set<string>();
  const artifacts: ArtifactRecord[] = [];

  for (const execution of executions) {
    const artifact = artifactFromExecution(execution);
    if (artifact === undefined || seen.has(artifact.id)) {
      continue;
    }

    seen.add(artifact.id);
    artifacts.push(artifact);
  }

  return artifacts;
}

function artifactFromExecution(execution: ToolExecutionRecord): ArtifactRecord | undefined {
  const metadata = execution.result?.metadata;

  if (!isArtifactRecord(metadata)) {
    return undefined;
  }

  return metadata;
}

function isArtifactRecord(value: unknown): value is ArtifactRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Partial<ArtifactRecord>;
  return typeof candidate.id === "string" &&
    typeof candidate.path === "string" &&
    typeof candidate.kind === "string" &&
    typeof candidate.bytes === "number" &&
    typeof candidate.createdAt === "string";
}

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) {
    return `${(bytes / 1_000_000).toFixed(bytes >= 10_000_000 ? 0 : 1)} MB`;
  }

  if (bytes >= 1_000) {
    return `${(bytes / 1_000).toFixed(bytes >= 10_000 ? 0 : 1)} KB`;
  }

  return `${bytes} B`;
}

function summarizeSkillOutcome(
  skill: string,
  executions: ToolExecutionRecord[],
  plans: ToolCallPlan[]
): string {
  const successfulTools = executions
    .filter((execution) => execution.result?.ok === true)
    .map((execution) => execution.tool.name);
  const executedPlannedTools = plans
    .filter((plan) => plan.status === "executed")
    .map((plan) => plan.tool);
  const attemptedTools = plans
    .map((plan) => plan.tool)
    .filter((tool) => tool.length > 0);
  const failedTools = plans
    .filter((plan) => plan.status === "invalid" || plan.status === "unavailable" || plan.status === "blocked")
    .map((plan) => plan.tool)
    .filter((tool) => tool.length > 0);
  const successful = [...new Set([...successfulTools, ...executedPlannedTools])];
  const attempted = [...new Set([...attemptedTools, ...executions.map((execution) => execution.tool.name)])];
  const failed = [...new Set(failedTools)];

  return [
    `${skill} completed with ${successful.length === 0 ? "no successful tools" : successful.join(", ")}.`,
    attempted.length === 0 ? undefined : `Attempted: ${attempted.join(", ")}.`,
    failed.length === 0 ? undefined : `Failed: ${failed.join(", ")}.`
  ].filter((line) => line !== undefined).join(" ");
}

function toolResultStats(execution: ToolExecutionRecord): {
  chars?: number;
  sentChars?: number;
  truncated?: boolean;
} {
  if (execution.result === undefined) {
    return {};
  }

  const packet = packetizeToolExecution({
    execution,
    maxChars: 1_400
  });

  return {
    chars: packet.chars,
    sentChars: packet.sentChars,
    truncated: packet.truncated
  };
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
    route: continuation.route ?? initial.route,
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

function isConcurrentSafeTool(tool: ToolDefinition | undefined): boolean {
  if (tool === undefined) {
    return false;
  }

  return (tool.riskClass === "read-only-local" || tool.riskClass === "read-only-network") &&
    tool.name !== "terminal.run" &&
    tool.name !== "process.start";
}

function isRecoverableToolPlanStatus(status: ToolCallPlan["status"]): boolean {
  return status === "invalid" || status === "unavailable" || status === "blocked";
}

type ProviderToolPlanEntry = {
  plan: ToolCallPlan;
  definition: ToolDefinition | undefined;
};

function groupProviderToolPlans(
  entries: ProviderToolPlanEntry[],
  maxConcurrentSafeTools: number
): Array<{ concurrent: boolean; entries: ProviderToolPlanEntry[] }> {
  const groups: Array<{ concurrent: boolean; entries: ProviderToolPlanEntry[] }> = [];
  const safeSize = Math.max(1, maxConcurrentSafeTools);
  let safeBatch: ProviderToolPlanEntry[] = [];

  const flushSafeBatch = () => {
    for (let index = 0; index < safeBatch.length; index += safeSize) {
      groups.push({
        concurrent: true,
        entries: safeBatch.slice(index, index + safeSize)
      });
    }
    safeBatch = [];
  };

  for (const entry of entries) {
    if (isConcurrentSafeTool(entry.definition)) {
      safeBatch.push(entry);
      continue;
    }

    flushSafeBatch();
    groups.push({
      concurrent: false,
      entries: [entry]
    });
  }

  flushSafeBatch();

  return groups;
}

function normalizeProviderRequest(request: Omit<ProviderRequest, "model"> & { model?: string }): Omit<ProviderRequest, "model"> & { model?: string } {
  const normalized = normalizeProviderMessagesStrict(request.messages);

  return {
    ...request,
    messages: normalized.messages
  };
}

async function emit(sink: RuntimeEventSink | undefined, event: RuntimeEvent): Promise<void> {
  await sink?.(event);
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

function summarizeProviderFailure(execution: ProviderExecutionResult): string {
  if (execution.attempts.length === 0) {
    return "No configured provider route was available for this request.";
  }

  const last = execution.attempts[execution.attempts.length - 1];
  const attempts = execution.attempts
    .map((attempt) => `${attempt.provider}/${attempt.model} (${humanProviderIssue(attempt.errorClass)})`)
    .join(", ");

  return `The configured model path did not complete. Last issue: ${humanProviderIssue(last?.errorClass)}. Attempts: ${attempts}.`;
}

function humanProviderIssue(errorClass: string | undefined): string {
  switch (errorClass) {
    case "auth":
      return "authentication needs attention";
    case "rate-limit":
      return "rate limited";
    case "quota":
      return "quota or billing limit";
    case "network":
      return "network issue";
    case "server":
      return "provider server issue";
    case "model-unavailable":
      return "model unavailable";
    case "timeout":
      return "timed out";
    case undefined:
      return "unknown provider issue";
    default:
      return errorClass;
  }
}
