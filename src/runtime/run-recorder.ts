import { isArtifactKind, type ArtifactRecord } from "../contracts/artifact.js";
import type { ChannelAttachment, ChannelKind } from "../contracts/channel.js";
import type { ContextExpansionResult } from "../contracts/context.js";
import type { IntentRoute } from "../contracts/intent.js";
import type { MemoryProvider, SkillOutcome } from "../contracts/memory.js";
import type { PromptBudgetReport } from "../contracts/prompt.js";
import type { SecurityDecision } from "../contracts/security.js";
import type { SessionDB, StructuredToolHistoryDiagnosticEvent } from "../contracts/session.js";
import type {
  LoadedSkill,
  SkillDefinition,
  SkillWorkflowPlan,
  SkillWorkflowPlanStep,
  SkillWorkflowStep
} from "../contracts/skill.js";
import type { ToolCallPlan } from "../contracts/tool-plan.js";
import type { ToolsetName, ToolRiskClass } from "../contracts/tool.js";
import type { RuntimeEvent, RuntimeEventSink } from "../contracts/runtime-event.js";
import type { Trajectory } from "../contracts/trajectory.js";
import type { TrajectoryStore } from "../contracts/trajectory-store.js";
import type { TrajectoryRecorder } from "../trajectory/trajectory-recorder.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import { createSkillRouteTelemetry, hashSkillRoutePrompt } from "../skills/skill-usage-telemetry.js";
import type { SkillEvolutionStore } from "../skills/skill-evolution.js";
import { stripInlineReasoning } from "../providers/provider-reasoning.js";
import { emit } from "../utils/runtime-helpers.js";
import { truncate } from "../utils/formatting.js";
import { buildFailureRecord, type FailureContext } from "../trajectory/failure-classifier.js";
import { redactSensitiveText } from "../utils/redaction.js";
import type { SessionRuntimeContext } from "./session-runtime-context.js";

export type RunRecorderOptions = {
  sessionDb: SessionDB;
  sessionId: string;
  sessionRuntimeContext?: SessionRuntimeContext;
  trajectoryRecorder: TrajectoryRecorder;
  trajectoryStore?: Pick<TrajectoryStore, "saveTrajectory">;
  profileId: string;
  skillEvolutionStore?: SkillEvolutionStore;
  memoryProvider?: MemoryProvider;
};

export class RunRecorder {
  readonly #sessionDb: SessionDB;
  readonly #sessionId: string;
  readonly #sessionRuntimeContext: SessionRuntimeContext | undefined;
  readonly #trajectoryRecorder: TrajectoryRecorder;
  readonly #trajectoryStore: Pick<TrajectoryStore, "saveTrajectory"> | undefined;
  readonly #profileId: string;
  readonly #skillEvolutionStore: SkillEvolutionStore | undefined;
  readonly #memoryProvider: MemoryProvider | undefined;

  constructor(options: RunRecorderOptions) {
    this.#sessionDb = options.sessionDb;
    this.#sessionId = options.sessionId;
    this.#sessionRuntimeContext = options.sessionRuntimeContext;
    this.#trajectoryRecorder = options.trajectoryRecorder;
    this.#trajectoryStore = options.trajectoryStore;
    this.#profileId = options.profileId;
    this.#skillEvolutionStore = options.skillEvolutionStore;
    this.#memoryProvider = options.memoryProvider;
  }

  async recordWorkflowStep(input: {
    skill: string;
    step: SkillWorkflowStep | SkillWorkflowPlanStep;
    status: "tool-executed" | "no-tool" | "blocked" | "skipped";
    toolsets: ToolsetName[];
    tool?: string;
    reason?: string;
  }): Promise<void> {
    await this.#sessionDb.appendEvent(this.#currentSessionId(), {
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

  async recordWorkflowPlan(plan: SkillWorkflowPlan): Promise<void> {
    await this.#sessionDb.appendEvent(this.#currentSessionId(), {
      kind: "skill-workflow-planned",
      plan
    });
    this.#trajectoryRecorder.record("skill-workflow-planned", {
      plan
    });
  }

  async recordArtifactsFromExecutions(
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
      await this.#sessionDb.appendEvent(this.#currentSessionId(), {
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

  async recordToolPlan(plan: ToolCallPlan): Promise<void> {
    await this.#sessionDb.appendEvent(this.#currentSessionId(), {
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

  async recordProviderBudgetExhausted(input: {
    budget: string;
    limit: number;
    observed: number;
    reason: string;
  }, sink: RuntimeEventSink | undefined): Promise<void> {
    await this.#sessionDb.appendEvent(this.#currentSessionId(), {
      kind: "provider-budget-exhausted",
      ...input
    });
    this.#trajectoryRecorder.record("provider-budget-exhausted", input);
    await emit(sink, {
      kind: "provider-budget-exhausted",
      ...input
    });
  }

  async recordCancellation(input: {
    reason: string;
    resumeNote?: string;
    activeSkill?: string;
    activeToolPlans?: ToolCallPlan[];
  }, sink: RuntimeEventSink | undefined): Promise<void> {
    await this.#sessionDb.appendEvent(this.#currentSessionId(), {
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

  async recordProviderIteration(input: {
    iteration: number;
    phase: "initial" | "continuation";
    ok: boolean;
    toolCalls: number;
    executedTools: number;
    exhausted: boolean;
  }): Promise<void> {
    await this.#sessionDb.appendEvent(this.#currentSessionId(), {
      kind: "provider-iteration",
      ...input
    });
    this.#trajectoryRecorder.record("provider-iteration", input);
  }

  async recordStructuredToolHistoryDiagnostic(input: StructuredToolHistoryDiagnosticEvent): Promise<void> {
    const event = sanitizeStructuredToolHistoryDiagnostic(input);
    await this.#sessionDb.appendEvent(this.#currentSessionId(), event);
  }

  async recordRouteUsage(input: {
    intent: IntentRoute;
    selectedSkill: LoadedSkill | SkillDefinition | undefined;
    channel: ChannelKind;
    userText: string;
    onEvent?: RuntimeEventSink;
  }): Promise<void> {
    const promptHash = hashSkillRoutePrompt(input.userText);
    const timestamp = new Date().toISOString();
    const routeTelemetry = input.intent.suggestedSkills.map((skill) => createSkillRouteTelemetry({
      skillName: skill.name,
      sourceKind: isLoadedSkill(skill) ? skill.sourceKind : "local",
      selected: input.selectedSkill?.name === skill.name,
      explicitInvocation: input.intent.invocation?.explicit === true,
      confidence: input.intent.confidence,
      labels: input.intent.labels,
      evidence: input.intent.evidence.map((entry) => `${entry.kind}: ${entry.detail}`),
      routeId: promptHash,
      matchedAt: timestamp
    }));
    const event = {
      kind: "skill-route-usage" as const,
      timestamp,
      skillName: input.selectedSkill?.name,
      nativeIntent: input.intent.nativeIntent,
      labels: input.intent.labels,
      selected: input.selectedSkill !== undefined,
      invoked: input.intent.invocation?.explicit === true,
      deferred: input.intent.evidence.some((entry) => entry.kind === "skill-defer-rule"),
      deferReason: input.intent.evidence.find((entry) => entry.kind === "skill-defer-rule")?.detail,
      confidence: input.intent.confidence,
      evidenceKinds: input.intent.evidence.map((entry) => entry.kind),
      surface: input.channel
    };
    await this.#sessionDb.appendEvent(this.#currentSessionId(), event);
    this.#trajectoryRecorder.record("skill-route-usage", event);
    for (const telemetry of routeTelemetry) {
      await this.#skillEvolutionStore?.recordSkillRouteTelemetry(telemetry);
    }
    if (input.selectedSkill !== undefined) {
      await this.#skillEvolutionStore?.recordSkillUsed({
        skill: input.selectedSkill,
        selectedAt: timestamp
      });
    }

    await this.#sessionDb.appendEvent(this.#currentSessionId(), {
      kind: "skill-route-telemetry",
      telemetry: {
        promptHash,
        labels: input.intent.labels,
        confidence: input.intent.confidence,
        selectedSkill: input.selectedSkill?.name,
        explicitInvocation: input.intent.invocation?.explicit === true,
        candidates: routeTelemetry
      }
    });
    this.#trajectoryRecorder.record("skill-route-telemetry", {
      promptHash,
      labels: input.intent.labels,
      confidence: input.intent.confidence,
      selectedSkill: input.selectedSkill?.name,
      explicitInvocation: input.intent.invocation?.explicit === true,
      candidates: routeTelemetry
    });
    await emit(input.onEvent, {
      kind: "skill-route-telemetry",
      promptHash,
      selectedSkill: input.selectedSkill?.name,
      confidence: input.intent.confidence,
      candidates: routeTelemetry.map((telemetry) => ({
        skillName: telemetry.skillName,
        selected: telemetry.selected,
        explicitInvocation: telemetry.explicitInvocation,
        confidence: telemetry.confidence,
        sourceKind: telemetry.sourceKind
      }))
    });
  }

  async recordSecurityRiskEscalation(input: {
    from: ToolRiskClass;
    to: ToolRiskClass;
    onEvent?: RuntimeEventSink;
  }): Promise<void> {
    const reason = "provider proposed higher-risk tool call than initial turn posture";
    await this.#sessionDb.appendEvent(this.#currentSessionId(), {
      kind: "security-risk-escalated",
      from: input.from,
      to: input.to,
      reason
    });
    this.#trajectoryRecorder.record("security-risk-escalated", {
      from: input.from,
      to: input.to,
      reason
    });
    await emit(input.onEvent, {
      kind: "security-risk-escalated",
      from: input.from,
      to: input.to,
      reason
    });
  }

  async recordPromptAssembly(budget: PromptBudgetReport): Promise<void> {
    await this.#sessionDb.appendEvent(this.#currentSessionId(), {
      kind: "prompt-assembled",
      budget
    });
    this.#trajectoryRecorder.record("prompt-assembled", {
      budget
    });
  }

  async recordSessionRecallDecision(input: {
    triggered: boolean;
    reason: string;
    query?: string;
    sourceSessionIds: string[];
    warningCount: number;
    onEvent?: RuntimeEventSink;
  }): Promise<string[]> {
    const warnings: string[] = [];
    try {
      await this.#sessionDb.appendEvent(this.#currentSessionId(), {
        kind: "session-recall-decision",
        triggered: input.triggered,
        reason: input.reason,
        query: input.query,
        sourceSessionIds: input.sourceSessionIds,
        warningCount: input.warningCount
      });
    } catch (error) {
      warnings.push(`session recall decision session event failed: ${errorMessage(error)}`);
    }

    try {
      this.#trajectoryRecorder.record("session-recall-decision", {
        triggered: input.triggered,
        reason: input.reason,
        query: input.query,
        sourceSessionIds: input.sourceSessionIds,
        warningCount: input.warningCount
      });
    } catch (error) {
      warnings.push(`session recall decision trajectory event failed: ${errorMessage(error)}`);
    }

    try {
      await emit(input.onEvent, {
        kind: "session-recall-decision",
        triggered: input.triggered,
        reason: input.reason,
        sourceSessionIds: input.sourceSessionIds
      });
    } catch (error) {
      warnings.push(`session recall decision runtime event failed: ${errorMessage(error)}`);
    }

    return warnings;
  }

  async recordExternalMemoryRecall(input: {
    providerIds: string[];
    enabled: boolean;
    attempted: boolean;
    resultCount: number;
    totalChars: number;
    workspaceScoped: boolean;
    warningCount: number;
    failureCount: number;
    failures?: Array<{ providerId?: string; reason: string }>;
    durationMs?: number;
  }): Promise<string[]> {
    const event = {
      kind: "external-memory-recall" as const,
      providerIds: input.providerIds,
      enabled: input.enabled,
      attempted: input.attempted,
      resultCount: input.resultCount,
      totalChars: input.totalChars,
      profileId: this.#profileId,
      workspaceScoped: input.workspaceScoped,
      warningCount: input.warningCount,
      failureCount: input.failureCount,
      ...(input.failures === undefined ? {} : { failures: sanitizeAuditFailures(input.failures) }),
      ...(input.durationMs === undefined ? {} : { durationMs: Math.max(0, Math.round(input.durationMs)) })
    };
    const warnings: string[] = [];
    try {
      await this.#sessionDb.appendEvent(this.#currentSessionId(), event);
    } catch (error) {
      warnings.push(`external memory recall session event failed: ${auditErrorMessage(error)}`);
    }
    try {
      this.#trajectoryRecorder.record("external-memory-recall", event);
    } catch (error) {
      warnings.push(`external memory recall trajectory event failed: ${auditErrorMessage(error)}`);
    }
    return warnings;
  }

  async recordExternalMemoryMirrorWrite(input: {
    providerIds: string[];
    enabled: boolean;
    mirrorEnabled: boolean;
    localWriteSucceeded: boolean;
    mirrorAttempted: boolean;
    mirrorSucceeded: boolean;
    memoryFile?: string;
    operationKind?: string;
    entryChars: number;
    workspaceScoped: boolean;
    warningCount: number;
    failureCount: number;
    failures?: Array<{ providerId?: string; reason: string }>;
  }): Promise<string[]> {
    const event = {
      kind: "external-memory-mirror-write" as const,
      providerIds: input.providerIds,
      enabled: input.enabled,
      mirrorEnabled: input.mirrorEnabled,
      localWriteSucceeded: input.localWriteSucceeded,
      mirrorAttempted: input.mirrorAttempted,
      mirrorSucceeded: input.mirrorSucceeded,
      ...(input.memoryFile === undefined ? {} : { memoryFile: input.memoryFile }),
      ...(input.operationKind === undefined ? {} : { operationKind: input.operationKind }),
      entryChars: Math.max(0, input.entryChars),
      profileId: this.#profileId,
      workspaceScoped: input.workspaceScoped,
      warningCount: input.warningCount,
      failureCount: input.failureCount,
      ...(input.failures === undefined ? {} : { failures: sanitizeAuditFailures(input.failures) })
    };
    const warnings: string[] = [];
    try {
      await this.#sessionDb.appendEvent(this.#currentSessionId(), event);
    } catch (error) {
      warnings.push(`external memory mirror write session event failed: ${auditErrorMessage(error)}`);
    }
    try {
      this.#trajectoryRecorder.record("external-memory-mirror-write", event);
    } catch (error) {
      warnings.push(`external memory mirror write trajectory event failed: ${auditErrorMessage(error)}`);
    }
    return warnings;
  }

  async recordSkillOutcomes(input: {
    selectedSkill: LoadedSkill | SkillDefinition | undefined;
    userText: string;
    toolExecutions: ToolExecutionRecord[];
    toolPlans: ToolCallPlan[];
  }): Promise<SkillOutcome[]> {
    if (
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

    if (this.#memoryProvider !== undefined) {
      await this.#memoryProvider.recordSkillOutcome(outcome);
      this.#trajectoryRecorder.record("memory-write", {
        provider: this.#memoryProvider.id,
        outcome
      });
      await this.#sessionDb.appendEvent(this.#currentSessionId(), {
        kind: "memory-write",
        provider: this.#memoryProvider.id,
        outcome
      });
    }

    await this.#skillEvolutionStore?.recordSkillOutcome({
      skill: input.selectedSkill,
      outcome,
      sessionId: this.#currentSessionId(),
      promptSummary: truncate(stripInlineReasoning(input.userText), 240),
      selectedWorkflowStep: input.selectedSkill.workflow[0]?.id,
      toolExecutions: input.toolExecutions
    }).catch(() => undefined);

    return [outcome];
  }

  async markPlannedToolPlansCancelled(plans: ToolCallPlan[], reason: string): Promise<void> {
    for (const plan of plans) {
      if (plan.status !== "planned") {
        continue;
      }

      plan.status = "cancelled";
      plan.error = reason;
      await this.recordToolPlan(plan);
    }
  }

  async appendCancelledAssistantMessage(input: {
    response: { text: string; progress: string[]; toolPlans: ToolCallPlan[] };
    channel: ChannelKind;
  }): Promise<void> {
    await this.#sessionDb.appendMessage({
      sessionId: this.#currentSessionId(),
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

  async latestResumeNote(): Promise<string | undefined> {
    const events = await this.#sessionDb.listEvents(this.#currentSessionId());
    const cancelled = [...events].reverse().find((event) => event.kind === "agent-cancelled" && event.resumeNote !== undefined);

    return cancelled?.kind === "agent-cancelled" ? cancelled.resumeNote : undefined;
  }

  async recordClassifiedFailure(context: FailureContext, sourceEventKind: string): Promise<void> {
    if (this.#sessionDb.saveFailure === undefined) {
      return;
    }

    await this.persistTrajectory();

    const record = buildFailureRecord(context, {
      sessionId: this.#currentSessionId(),
      trajectoryId: this.#trajectoryRecorder.trajectoryId,
      sourceEventKind
    });

    await this.#sessionDb.saveFailure(record);
  }

  async persistTrajectory(): Promise<void> {
    await this.#trajectoryStore?.saveTrajectory(this.#trajectoryRecorder.snapshot());
  }

  async completeTrajectory(
    outcome: Trajectory["outcome"],
    options: { bestEffort?: boolean } = {}
  ): Promise<void> {
    const trajectory = this.#trajectoryRecorder.complete(outcome);

    if (options.bestEffort === true) {
      try {
        await this.#trajectoryStore?.saveTrajectory(trajectory);
      } catch {
        // Final trace persistence must not fail an already-completed user turn.
      }
      return;
    }

    await this.#trajectoryStore?.saveTrajectory(trajectory);
  }

  async recordUserCorrection(input: {
    correctionText: string;
    skillName?: string;
    reason?: string;
  }): Promise<void> {
    this.#trajectoryRecorder.record("user-correction", {
      correctionText: input.correctionText,
      skillName: input.skillName,
      reason: input.reason
    });
    await this.#sessionDb.appendEvent(this.#currentSessionId(), {
      kind: "user-correction",
      correctionText: input.correctionText,
      skillName: input.skillName,
      reason: input.reason
    });
    if (input.skillName !== undefined && this.#skillEvolutionStore !== undefined) {
      await this.#skillEvolutionStore.appendObservation({
        skillName: input.skillName,
        type: "note",
        lesson: input.correctionText,
        sourceTrust: "user_direct",
        mayPromoteAutomatically: false,
        requiresHumanApproval: true
      });
    }
  }

  #currentSessionId(): string {
    return this.#sessionRuntimeContext?.currentSessionId() ?? this.#sessionId;
  }
}

function isLoadedSkill(skill: LoadedSkill | SkillDefinition): skill is LoadedSkill {
  return "instructions" in skill && "sourcePath" in skill;
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
    isArtifactKind(candidate.kind) &&
    typeof candidate.bytes === "number" &&
    typeof candidate.createdAt === "string";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function auditErrorMessage(error: unknown): string {
  return truncate(redactSensitiveText(error instanceof Error ? error.message : String(error)), 240);
}

function sanitizeAuditFailures(
  failures: Array<{ providerId?: string; reason: string }>
): Array<{ providerId?: string; reason: string }> {
  return failures.slice(0, 8).map((failure) => ({
    ...(failure.providerId === undefined ? {} : { providerId: truncate(redactSensitiveText(failure.providerId), 80) }),
    reason: truncate(redactSensitiveText(failure.reason), 240)
  }));
}

function sanitizeStructuredToolHistoryDiagnostic(
  input: StructuredToolHistoryDiagnosticEvent
): StructuredToolHistoryDiagnosticEvent {
  return {
    kind: input.kind,
    ...(input.provider === undefined ? {} : { provider: input.provider }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.routeRole === undefined ? {} : { routeRole: input.routeRole }),
    ...(input.nativePairs === undefined ? {} : { nativePairs: nonNegativeInteger(input.nativePairs) }),
    ...(input.droppedOrphans === undefined ? {} : { droppedOrphans: nonNegativeInteger(input.droppedOrphans) }),
    ...(input.injectedStubs === undefined ? {} : { injectedStubs: nonNegativeInteger(input.injectedStubs) }),
    ...(input.mergedUsers === undefined ? {} : { mergedUsers: nonNegativeInteger(input.mergedUsers) }),
    ...(input.skippedMalformedToolCalls === undefined ? {} : { skippedMalformedToolCalls: nonNegativeInteger(input.skippedMalformedToolCalls) }),
    ...(input.skippedUnsafeTurns === undefined ? {} : { skippedUnsafeTurns: nonNegativeInteger(input.skippedUnsafeTurns) }),
    ...(input.echoMessages === undefined ? {} : { echoMessages: nonNegativeInteger(input.echoMessages) }),
    ...(input.echoMissing === undefined ? {} : { echoMissing: nonNegativeInteger(input.echoMissing) }),
    ...(input.echoOversized === undefined ? {} : { echoOversized: nonNegativeInteger(input.echoOversized) }),
    ...(input.nativeReplayUnsafeTurns === undefined ? {} : { nativeReplayUnsafeTurns: nonNegativeInteger(input.nativeReplayUnsafeTurns) }),
    ...(input.reason === undefined ? {} : { reason: input.reason })
  };
}

function nonNegativeInteger(value: number): number {
  return Math.max(0, Math.floor(Number.isFinite(value) ? value : 0));
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
