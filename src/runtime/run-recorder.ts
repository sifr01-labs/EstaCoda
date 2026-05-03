import { isArtifactKind, type ArtifactRecord } from "../contracts/artifact.js";
import type { ChannelAttachment, ChannelKind } from "../contracts/channel.js";
import type { ContextExpansionResult } from "../contracts/context.js";
import type { IntentRoute } from "../contracts/intent.js";
import type { MemoryProvider, SkillOutcome } from "../contracts/memory.js";
import type { PromptBudgetReport } from "../contracts/prompt.js";
import type { SecurityDecision } from "../contracts/security.js";
import type { SessionDB } from "../contracts/session.js";
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
import type { TrajectoryRecorder } from "../trajectory/trajectory-recorder.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import { createSkillRouteTelemetry, hashSkillRoutePrompt } from "../skills/skill-usage-telemetry.js";
import type { SkillEvolutionStore } from "../skills/skill-evolution.js";
import { emit } from "../utils/runtime-helpers.js";
import { truncate } from "../utils/formatting.js";
import { buildFailureRecord, type FailureContext } from "../trajectory/failure-classifier.js";

export type RunRecorderOptions = {
  sessionDb: SessionDB;
  sessionId: string;
  trajectoryRecorder: TrajectoryRecorder;
  profileId: string;
  skillEvolutionStore?: SkillEvolutionStore;
  memoryProvider?: MemoryProvider;
};

export class RunRecorder {
  readonly #sessionDb: SessionDB;
  readonly #sessionId: string;
  readonly #trajectoryRecorder: TrajectoryRecorder;
  readonly #profileId: string;
  readonly #skillEvolutionStore: SkillEvolutionStore | undefined;
  readonly #memoryProvider: MemoryProvider | undefined;

  constructor(options: RunRecorderOptions) {
    this.#sessionDb = options.sessionDb;
    this.#sessionId = options.sessionId;
    this.#trajectoryRecorder = options.trajectoryRecorder;
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

  async recordWorkflowPlan(plan: SkillWorkflowPlan): Promise<void> {
    await this.#sessionDb.appendEvent(this.#sessionId, {
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

  async recordToolPlan(plan: ToolCallPlan): Promise<void> {
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

  async recordProviderBudgetExhausted(input: {
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

  async recordCancellation(input: {
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

  async recordProviderIteration(input: {
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
    await this.#sessionDb.appendEvent(this.#sessionId, event);
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

    await this.#sessionDb.appendEvent(this.#sessionId, {
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
    await this.#sessionDb.appendEvent(this.#sessionId, {
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
    await this.#sessionDb.appendEvent(this.#sessionId, {
      kind: "prompt-assembled",
      budget
    });
    this.#trajectoryRecorder.record("prompt-assembled", {
      budget
    });
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
      await this.#sessionDb.appendEvent(this.#sessionId, {
        kind: "memory-write",
        provider: this.#memoryProvider.id,
        outcome
      });
    }

    await this.#skillEvolutionStore?.recordSkillOutcome({
      skill: input.selectedSkill,
      outcome,
      sessionId: this.#sessionId,
      promptSummary: truncate(input.userText, 240),
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

  async latestResumeNote(): Promise<string | undefined> {
    const events = await this.#sessionDb.listEvents(this.#sessionId);
    const cancelled = [...events].reverse().find((event) => event.kind === "agent-cancelled" && event.resumeNote !== undefined);

    return cancelled?.kind === "agent-cancelled" ? cancelled.resumeNote : undefined;
  }

  async recordClassifiedFailure(context: FailureContext, sourceEventKind: string): Promise<void> {
    if (this.#sessionDb.saveFailure === undefined) {
      return;
    }

    const record = buildFailureRecord(context, {
      sessionId: this.#sessionId,
      trajectoryId: this.#trajectoryRecorder.trajectoryId,
      sourceEventKind
    });

    await this.#sessionDb.saveFailure(record);
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
    await this.#sessionDb.appendEvent(this.#sessionId, {
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


