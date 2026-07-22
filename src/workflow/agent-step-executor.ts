import type { ArtifactRecord } from "../contracts/artifact.js";
import type { DelegateModelOverride, DelegateRole, DelegationConfig } from "../contracts/delegation.js";
import type { RuntimeEvent, RuntimeEventSink } from "../contracts/runtime-event.js";
import type { SecurityPolicy } from "../contracts/security.js";
import type { SessionDB, SessionEvent } from "../contracts/session.js";
import type { Task, TaskAttempt, TaskFailure, TaskStep, TaskWorkspaceBinding } from "../contracts/task.js";
import type { ToolDefinition } from "../contracts/tool.js";
import { DEFAULT_DELEGATION_CONFIG } from "../config/delegation-defaults.js";
import { runDelegatedChild } from "../delegation/child-runner.js";
import { SubagentRegistry } from "../delegation/subagent-registry.js";
import {
  ChildModelOverrideError,
  type ChildAgentLoopFactory,
  type ChildAgentLoopRuntime
} from "../runtime/agent-loop-factory.js";
import type { TaskStore } from "./task-store.js";
import { TaskApprovalService } from "./task-approval-service.js";
import {
  taskUsageFromAgentResponse,
  taskUsageFromEntries
} from "./task-agent-usage.js";
import {
  TASK_STEP_HOST_HANDOFF_ABORT_REASON,
  type TaskExecutorResultContent,
  type TaskExecutorSettlement,
  type TaskStepExecutionInput,
  type TaskStepExecutor
} from "./task-step-executor.js";
import { taskActivityFromDelegationProgress } from "./task-safe-activity.js";

const MAX_DEPENDENCY_RESULT_REFERENCES = 64;
const MAX_TASK_GUIDANCE_RECORDS_IN_CONTEXT = 16;
const MAX_DEPENDENCY_CONTEXT_CHARS = 16_000;
const MAX_ARTIFACT_RESULTS = 64;

export type ResolveTaskArtifactContent = (input: {
  artifact: ArtifactRecord;
  task: Task;
  step: TaskStep;
  attempt: TaskAttempt;
}) => Promise<string | Uint8Array | undefined>;

export type AgentStepExecutorOptions = {
  childFactory: ChildAgentLoopFactory;
  sessionDb: SessionDB;
  taskStore: TaskStore;
  hostWorkspace: TaskWorkspaceBinding;
  isWorkspaceTrusted: (workspace: TaskWorkspaceBinding) => boolean | Promise<boolean>;
  parentVisibleTools: () => readonly ToolDefinition[];
  delegationConfig?: DelegationConfig;
  subagentRegistry?: SubagentRegistry;
  diagnosticsRoot?: string;
  onEvent?: RuntimeEventSink;
  resolveArtifactContent?: ResolveTaskArtifactContent;
  maxHeartbeatSeconds?: number;
  now?: () => Date;
  approvalService: TaskApprovalService;
  securityPolicy: SecurityPolicy;
};

/** Production agent executor for one durable Attempt. Scheduler state remains its only lifecycle authority. */
export class AgentStepExecutor implements TaskStepExecutor {
  readonly kind = "agent" as const;
  readonly #childFactory: ChildAgentLoopFactory;
  readonly #sessionDb: SessionDB;
  readonly #taskStore: TaskStore;
  readonly #hostWorkspace: TaskWorkspaceBinding;
  readonly #isWorkspaceTrusted: AgentStepExecutorOptions["isWorkspaceTrusted"];
  readonly #parentVisibleTools: () => readonly ToolDefinition[];
  readonly #delegationConfig: DelegationConfig;
  readonly #subagentRegistry: SubagentRegistry;
  readonly #diagnosticsRoot: string | undefined;
  readonly #onEvent: RuntimeEventSink | undefined;
  readonly #resolveArtifactContent: ResolveTaskArtifactContent | undefined;
  readonly #maxHeartbeatSeconds: number;
  readonly #now: () => Date;
  readonly #approvalService: TaskApprovalService;
  readonly #securityPolicy: SecurityPolicy;

  constructor(options: AgentStepExecutorOptions) {
    if (options.taskStore.profileId.trim().length === 0) {
      throw new Error("AgentStepExecutor requires a profile-bound TaskStore.");
    }
    if (options.hostWorkspace.canonicalPath.trim().length === 0 || options.hostWorkspace.identityHash.trim().length === 0) {
      throw new Error("AgentStepExecutor requires a complete host workspace binding.");
    }
    this.#childFactory = options.childFactory;
    this.#sessionDb = options.sessionDb;
    this.#taskStore = options.taskStore;
    this.#hostWorkspace = { ...options.hostWorkspace };
    this.#isWorkspaceTrusted = options.isWorkspaceTrusted;
    this.#parentVisibleTools = options.parentVisibleTools;
    this.#delegationConfig = options.delegationConfig ?? DEFAULT_DELEGATION_CONFIG;
    this.#subagentRegistry = options.subagentRegistry ?? new SubagentRegistry();
    this.#diagnosticsRoot = options.diagnosticsRoot;
    this.#onEvent = options.onEvent;
    this.#resolveArtifactContent = options.resolveArtifactContent;
    this.#maxHeartbeatSeconds = positiveInteger(options.maxHeartbeatSeconds ?? 5, "maximum heartbeat interval");
    this.#now = options.now ?? (() => new Date());
    this.#approvalService = options.approvalService;
    this.#securityPolicy = options.securityPolicy;
  }

  canExecute(task: Task, step: TaskStep): boolean {
    return task.profileId === this.#taskStore.profileId &&
      step.profileId === this.#taskStore.profileId &&
      step.taskId === task.id &&
      step.executor.kind === this.kind &&
      workspaceMatches(task.workspace, this.#hostWorkspace);
  }

  async execute(input: TaskStepExecutionInput): Promise<TaskExecutorSettlement> {
    const invalidContext = validateExecutionContext(input, this.#taskStore.profileId);
    if (invalidContext !== undefined) return failed(invalidContext, false);
    if (!this.canExecute(input.task, input.step)) return failed("workspace-mismatch", false);
    if (input.signal.aborted) return { outcome: "cancelled", usage: unavailableUsage("cancelled-before-start") };

    let trusted = false;
    try {
      trusted = await this.#isWorkspaceTrusted(input.task.workspace);
    } catch {
      return failed("workspace-trust-check-failed", false);
    }
    if (!trusted) return failed("workspace-untrusted", false);

    const parentSessionId = input.task.creatorSessionId;
    if (parentSessionId === undefined) return failed("parent-session-missing", false);
    let parentSession;
    try {
      parentSession = await this.#sessionDb.getSession(parentSessionId);
    } catch {
      return failed("parent-session-unavailable", false);
    }
    if (parentSession === undefined || parentSession.profileId !== input.task.profileId) {
      return failed("parent-session-unavailable", false);
    }

    const parentVisibleTools = filterTaskStepTools(
      this.#parentVisibleTools(),
      input.task,
      input.step
    );
    const modelOverride = toModelOverride(input.step);
    let child: ChildAgentLoopRuntime;
    try {
      child = await this.#childFactory.createChild({
        parentSessionId,
        profileId: input.task.profileId,
        task: input.step.objective,
        context: dependencyContext(this.#taskStore, input.task, input.step),
        allowedToolsets: [...input.step.authorityPolicy.allowedToolsets],
        allowedTools: input.step.authorityPolicy.allowedTools === undefined
          ? undefined
          : [...input.step.authorityPolicy.allowedTools],
        role: toDelegateRole(input.step),
        modelOverride,
        depth: 1,
        channel: "cli",
        trustedWorkspace: true,
        parentVisibleTools,
        securityPolicy: this.#approvalService.securityPolicyFor(
          input.task,
          input.step,
          input.attempt,
          this.#securityPolicy
        ),
        taskExecution: {
          taskId: input.task.id,
          rootTaskId: input.task.rootTaskId,
          planRevisionId: input.step.planRevisionId,
          stepId: input.step.id,
          attemptId: input.attempt.id,
          originSessionId: input.task.originSessionId,
          ...(input.task.originTurnId === undefined ? {} : { originTurnId: input.task.originTurnId })
        },
        ...(input.attempt.workerSessionId === undefined ? {} : { resumeSessionId: input.attempt.workerSessionId })
      });
    } catch (error) {
      if (error instanceof ChildModelOverrideError) return failed("model-override-unsupported", false);
      return failed("agent-construction-error", true);
    }

    let endReason = "task-step-failed";
    let registered = false;
    const childController = new AbortController();
    const abortChild = () => {
      if (!childController.signal.aborted) childController.abort(input.signal.reason ?? "task-attempt-cancelled");
    };
    input.signal.addEventListener("abort", abortChild, { once: true });

    try {
      input.checkpoint({
        workerSessionId: child.childSessionId
      });

      this.#subagentRegistry.registerSubagent({
        subagentId: input.attempt.id,
        childSessionId: child.childSessionId,
        parentSessionId,
        depth: 1,
        role: toDelegateRole(input.step),
        goal: input.step.objective,
        model: childModel(child),
        provider: childProvider(child),
        toolCount: child.toolAccess.effectiveAllowedTools.length,
        abortController: childController
      });
      registered = true;
      this.#subagentRegistry.updateSubagent(input.attempt.id, {
        status: "running",
        lastActivityAt: this.#now().toISOString()
      });

      const runnerResult = await runDelegatedChild({
        child,
        childAbortController: childController,
        parentSignal: input.signal,
        subagentRegistry: this.#subagentRegistry,
        subagentId: input.attempt.id,
        sessionDb: this.#sessionDb,
        delegationConfig: childRunnerConfig(
          this.#delegationConfig,
          input.step,
          input.attempt,
          this.#maxHeartbeatSeconds,
          this.#now()
        ),
        diagnosticsRoot: this.#diagnosticsRoot,
        parentSessionId,
        childSessionId: child.childSessionId,
        role: toDelegateRole(input.step),
        depth: 1,
        task: input.step.objective,
        context: dependencyContext(this.#taskStore, input.task, input.step),
        ...(input.attempt.workerSessionId === undefined ? {} : {
          prompt: "Continue this durable Task from the saved worker session. Use the existing transcript and do not repeat completed actions."
        }),
        channel: "cli",
        trustedWorkspace: true,
        provider: childProvider(child),
        model: childModel(child),
        effectiveAllowedTools: child.toolAccess.effectiveAllowedTools,
        parentOnEvent: this.#taskProgressSink(input),
        inputMetadata: {
          durableTask: true,
          taskId: input.task.id,
          planRevisionId: input.step.planRevisionId,
          stepId: input.step.id,
          attemptId: input.attempt.id,
          parentSessionId
        },
        onHeartbeat: input.heartbeat,
        now: this.#now
      });

      const worker = { workerSessionId: child.childSessionId };
      if (input.signal.aborted || childController.signal.aborted || runnerResult.kind === "cancelled") {
        endReason = "task-step-cancelled";
        return { outcome: "cancelled", usage: unavailableUsage("agent-cancelled"), ...worker };
      }
      if (runnerResult.kind === "timeout") {
        endReason = "task-step-timeout";
        return { outcome: "failed", failure: taskFailure("timeout", true), usage: unavailableUsage("agent-timeout"), ...worker };
      }

      const response = runnerResult.response;
      const trajectoryId = child.agentLoop.trajectoryId;
      if (trajectoryId !== undefined) input.checkpoint({ trajectoryId });
      const common = { ...worker, ...(trajectoryId === undefined ? {} : { trajectoryId }) };
      const events = await this.#sessionDb.listEvents(child.childSessionId);
      const usageEntries = await this.#sessionDb.listProviderUsageEntries(input.task.profileId, {
        attemptId: input.attempt.id
      });
      const usage = usageEntries.length === 0
        ? taskUsageFromAgentResponse(response.providerExecution, child.builtSession.providerRoutes)
        : taskUsageFromEntries(usageEntries);
      const metering = { usage, usageEntries };
      const approval = this.#approvalService.takeRequest(input.attempt.id);
      if (approval !== undefined || response.toolExecutions.some((execution) => execution.decision === "ask")) {
        if (approval === undefined) {
          return { outcome: "failed", failure: taskFailure("approval-request-missing", false), ...metering, ...common };
        }
        endReason = "task-step-waiting-for-approval";
        return { outcome: "waiting_for_approval", approval, ...metering, ...common };
      }
      for (const approved of this.#approvalService.takeApprovedRequests(input.attempt.id)) {
        this.#approvalService.consumeApproved(input.attempt.id, approved);
      }
      if (response.setupApprovals !== undefined && response.setupApprovals.length > 0) {
        return { outcome: "failed", failure: taskFailure("approval-required", false), ...metering, ...common };
      }
      if (hasStructuredBlock(response, events)) {
        return { outcome: "failed", failure: taskFailure("security-deny", false), ...metering, ...common };
      }
      if (response.providerExecution?.spendDenialReason !== undefined) {
        endReason = "task-step-spending-denied";
        return {
          outcome: "spending_denied",
          reason: response.providerExecution.spendDenialReason,
          ...metering,
          ...common
        };
      }
      if (response.providerExecution?.ok === false) {
        const providerFailure = classifyProviderFailure(response.providerExecution.attempts.at(-1)?.errorClass);
        return {
          outcome: "failed",
          failure: providerFailure,
          ...safeDiagnosticOutput(response.text, response.toolExecutions),
          ...metering,
          ...common
        };
      }
      if (response.toolExecutions.some((execution, index, executions) =>
        execution.result?.ok === false && !isRecoveredRead(execution, index, executions)
      )) {
        return {
          outcome: "failed",
          failure: taskFailure("tool-error", true),
          ...safeDiagnosticOutput(response.text, response.toolExecutions),
          ...metering,
          ...common
        };
      }

      const captured = await captureResults(response.text, response.artifacts, input, this.#resolveArtifactContent);
      if (captured.failure !== undefined) {
        return {
          outcome: "failed",
          failure: captured.failure,
          ...safeDiagnosticOutput(response.text, response.toolExecutions),
          ...metering,
          ...common
        };
      }
      endReason = "task-step-completed";
      return { outcome: "succeeded", results: captured.results, ...metering, ...common };
    } finally {
      this.#approvalService.clearAttempt(input.attempt.id);
      input.signal.removeEventListener("abort", abortChild);
      if (registered) this.#subagentRegistry.unregisterSubagent(input.attempt.id);
      if (input.signal.reason !== TASK_STEP_HOST_HANDOFF_ABORT_REASON) {
        await this.#sessionDb.endSession(child.childSessionId, endReason).catch(() => undefined);
      }
      await child.cleanup().catch(() => undefined);
    }
  }

  #taskProgressSink(input: TaskStepExecutionInput): RuntimeEventSink {
    return async (event: RuntimeEvent) => {
      if (event.kind === "delegation-progress") {
        const activity = taskActivityFromDelegationProgress(event);
        if (activity !== undefined) input.checkpoint({ activity });
      }
      await this.#onEvent?.(event);
    };
  }
}

function validateExecutionContext(input: TaskStepExecutionInput, profileId: string): string | undefined {
  if (input.task.profileId !== profileId || input.step.profileId !== profileId || input.attempt.profileId !== profileId) {
    return "profile-mismatch";
  }
  if (input.step.taskId !== input.task.id || input.attempt.taskId !== input.task.id || input.attempt.stepId !== input.step.id ||
      input.attempt.planRevisionId !== input.step.planRevisionId) {
    return "attempt-context-mismatch";
  }
  return undefined;
}

function filterTaskStepTools(tools: readonly ToolDefinition[], task: Task, step: TaskStep): ToolDefinition[] {
  const taskToolsets = new Set(task.authorityPolicy.allowedToolsets);
  const stepToolsets = new Set(step.authorityPolicy.allowedToolsets);
  const taskTools = task.authorityPolicy.allowedTools === undefined ? undefined : new Set(task.authorityPolicy.allowedTools);
  const stepTools = step.authorityPolicy.allowedTools === undefined ? undefined : new Set(step.authorityPolicy.allowedTools);
  const blocked = new Set([...task.authorityPolicy.blockedTools, ...step.authorityPolicy.blockedTools]);
  return tools.filter((tool) =>
    (tool.name !== "delegate_task" || (
      step.executor.role === "orchestrator" &&
      step.childTaskPolicy === "fire_and_forget" &&
      task.authorityPolicy.mayCreateChildTasks &&
      step.authorityPolicy.mayCreateChildTasks &&
      step.authorityPolicy.maxChildDepth > 0
    )) &&
    task.authorityPolicy.riskClassPolicy[tool.riskClass] !== "forbid" &&
    step.authorityPolicy.riskClassPolicy[tool.riskClass] !== "forbid" &&
    !blocked.has(tool.name) &&
    (taskTools === undefined || taskTools.has(tool.name)) &&
    (stepTools === undefined || stepTools.has(tool.name)) &&
    tool.toolsets.some((toolset) => taskToolsets.has(toolset) && stepToolsets.has(toolset))
  );
}

function dependencyContext(store: TaskStore, task: Task, step: TaskStep): string {
  const dependencyIds = new Set(step.dependsOn);
  const references = store.listResults(task.id)
    .filter((result) => result.status === "available" && result.disposition === "accepted" &&
      result.stepId !== undefined && dependencyIds.has(result.stepId))
    .slice(0, MAX_DEPENDENCY_RESULT_REFERENCES)
    .map((result) => ({
      stepId: result.stepId,
      readInput: {
        task_id: task.id,
        result_id: result.id
      },
      kind: result.kind,
      bytes: result.byteLength,
      summary: result.summary === undefined ? undefined : boundText(result.summary, 240)
    }));
  const guidance = store.listGuidance(task.id)
    .slice(-MAX_TASK_GUIDANCE_RECORDS_IN_CONTEXT)
    .map((entry) => ({ id: entry.id, guidance: entry.guidance, createdAt: entry.createdAt }));
  return boundText([
    `Durable Task objective: ${task.objective}`,
    `Current Step: ${step.title}`,
    resultInstruction(step),
    guidance.length === 0
      ? "Operator guidance: none."
      : `Authorized operator guidance (later entries take precedence without overriding policy):\n${JSON.stringify(guidance)}`,
    references.length === 0
      ? "Dependency results: none."
      : `Dependency result references. To read one, call task.result.read with reference.readInput exactly; it already contains the authorized task_id and result_id. Do not derive task_id from a result handle:\n${JSON.stringify(references)}`
  ].join("\n\n"), MAX_DEPENDENCY_CONTEXT_CHARS);
}

function resultInstruction(step: TaskStep): string {
  switch (step.resultPolicy.kind) {
    case "none": return "Complete the Step without producing a durable result body.";
    case "text": return "Return the complete durable Step result as final response text.";
    case "json": return "Return only one valid JSON value as the final response.";
    case "artifact": return "Create the declared artifact result; the final response may briefly summarize it.";
  }
}

async function captureResults(
  text: string,
  artifacts: readonly ArtifactRecord[],
  input: TaskStepExecutionInput,
  resolver: ResolveTaskArtifactContent | undefined
): Promise<{ results: TaskExecutorResultContent[]; failure?: TaskFailure }> {
  const policy = input.step.resultPolicy;
  if (policy.kind === "none") return { results: [] };
  if (policy.kind === "text") {
    return text.length === 0
      ? { results: [] }
      : { results: [{ kind: "text", content: text, mimeType: "text/plain; charset=utf-8" }] };
  }
  if (policy.kind === "json") {
    if (text.length === 0) return { results: [] };
    try {
      JSON.parse(text);
    } catch {
      return { results: [], failure: taskFailure("invalid-json-result", false) };
    }
    return { results: [{ kind: "json", content: text, mimeType: "application/json" }] };
  }
  if (artifacts.length === 0) return { results: [] };
  if (artifacts.length > MAX_ARTIFACT_RESULTS) {
    return { results: [], failure: taskFailure("too-many-artifacts", false) };
  }
  if (resolver === undefined) {
    return { results: [], failure: taskFailure("artifact-capture-unavailable", false) };
  }

  const results: TaskExecutorResultContent[] = [];
  for (const artifact of artifacts) {
    let content: string | Uint8Array | undefined;
    try {
      content = await resolver({ artifact, task: input.task, step: input.step, attempt: input.attempt });
    } catch {
      return { results: [], failure: taskFailure("artifact-capture-failed", true) };
    }
    if (content === undefined) {
      return { results: [], failure: taskFailure("artifact-content-unavailable", false) };
    }
    const bytes = typeof content === "string" ? new TextEncoder().encode(content).byteLength : content.byteLength;
    if (bytes !== artifact.bytes) {
      return { results: [], failure: taskFailure("artifact-size-mismatch", false) };
    }
    results.push({
      kind: "artifact",
      content,
      mimeType: artifact.mimeType,
      summary: artifact.summary
    });
  }
  return { results };
}

function hasStructuredBlock(
  response: Awaited<ReturnType<ChildAgentLoopRuntime["handle"]>>,
  events: readonly SessionEvent[]
): boolean {
  return response.toolExecutions.some((execution) => execution.decision !== "allow") || events.some((event) =>
    event.kind === "tool-gated" && event.decision !== "allow" ||
    event.kind === "security-assessed" && event.assessment.decision !== "allow"
  );
}

function safeDiagnosticOutput(
  text: string,
  toolExecutions: Awaited<ReturnType<ChildAgentLoopRuntime["handle"]>>["toolExecutions"]
): { diagnosticResults?: readonly TaskExecutorResultContent[] } {
  if (text.trim().length === 0) return {};
  // Never republish output associated with a mutating or otherwise privileged action.
  if (toolExecutions.some((execution) =>
    execution.riskClass !== "read-only-local" && execution.riskClass !== "read-only-network"
  )) return {};
  return {
    diagnosticResults: [{
      kind: "text",
      content: text,
      mimeType: "text/plain; charset=utf-8",
      summary: "Recovered output from a failed Attempt; incomplete and not accepted as the Step result."
    }]
  };
}

function isRecoveredRead(
  failedExecution: Awaited<ReturnType<ChildAgentLoopRuntime["handle"]>>["toolExecutions"][number],
  failedIndex: number,
  executions: Awaited<ReturnType<ChildAgentLoopRuntime["handle"]>>["toolExecutions"]
): boolean {
  if (failedExecution.riskClass !== "read-only-local" && failedExecution.riskClass !== "read-only-network") return false;
  const failedInput = stableToolInput(failedExecution.input);
  return executions.slice(failedIndex + 1).some((candidate) =>
    candidate.tool.name === failedExecution.tool.name &&
    candidate.riskClass === failedExecution.riskClass &&
    candidate.decision === "allow" &&
    candidate.result?.ok === true &&
    stableToolInput(candidate.input) === failedInput
  );
}

function stableToolInput(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(stableToolInput).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableToolInput(entry)}`)
    .join(",")}}`;
}

function classifyProviderFailure(errorClass: string | undefined): TaskFailure {
  const normalized = errorClass !== undefined && /^[a-z0-9-]{1,80}$/u.test(errorClass) ? errorClass : "provider-error";
  const nonRetryable = normalized === "auth" || normalized === "quota" || normalized === "unsupported" || normalized === "missing-route";
  return taskFailure(normalized, !nonRetryable);
}

function taskFailure(failureClass: string, retryable: boolean): TaskFailure {
  return {
    class: failureClass,
    message: `Agent Step execution failed (${failureClass}).`,
    retryable,
    uncertainSideEffects: false
  };
}

function failed(failureClass: string, retryable: boolean): TaskExecutorSettlement {
  return { outcome: "failed", failure: taskFailure(failureClass, retryable), usage: unavailableUsage(failureClass) };
}

function unavailableUsage(reason: string) {
  return {
    providerCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    usageComplete: false,
    pricingComplete: false,
    incompleteReasons: [reason]
  };
}

function toModelOverride(step: TaskStep): DelegateModelOverride | undefined {
  return step.executor.model === undefined
    ? undefined
    : { model: step.executor.model.id, provider: step.executor.model.provider };
}

function toDelegateRole(step: TaskStep): DelegateRole {
  return step.executor.role === "orchestrator" ? "orchestrator" : "leaf";
}

function childModel(child: ChildAgentLoopRuntime): string {
  return child.builtSession.providerRoutes.primaryModelRoute?.id ?? child.builtSession.providerRoutes.mainRoute.id;
}

function childProvider(child: ChildAgentLoopRuntime): string {
  return child.builtSession.providerRoutes.primaryModelRoute?.provider ?? child.builtSession.providerRoutes.mainRoute.provider;
}

function childRunnerConfig(
  config: DelegationConfig,
  step: TaskStep,
  attempt: TaskAttempt,
  maxHeartbeatSeconds: number,
  now: Date
): DelegationConfig {
  const leaseRemainingMs = attempt.lease === undefined ? 1_000 : Math.max(1_000, Date.parse(attempt.lease.expiresAt) - now.getTime());
  const safeHeartbeatSeconds = Math.max(1, Math.floor(leaseRemainingMs / 3_000));
  return {
    ...config,
    childTimeoutSeconds: Math.max(1, Math.ceil(Math.min(
      config.childTimeoutSeconds * 1_000,
      step.executionLimits.maxWallClockMs
    ) / 1_000)),
    heartbeatSeconds: Math.min(config.heartbeatSeconds, maxHeartbeatSeconds, safeHeartbeatSeconds)
  };
}

function workspaceMatches(left: TaskWorkspaceBinding, right: TaskWorkspaceBinding): boolean {
  return left.canonicalPath === right.canonicalPath && left.identityHash === right.identityHash;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`AgentStepExecutor ${label} must be a positive integer.`);
  return value;
}

function boundText(value: string, maxChars: number): string {
  const normalized = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, " ");
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 3)}...`;
}
