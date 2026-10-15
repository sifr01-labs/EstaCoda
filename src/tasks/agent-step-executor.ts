import { ProviderAccountingError } from "../providers/provider-executor.js";
import { inspectPlaintextCredentials } from "../security/plaintext-credential-guard.js";
import { truncateHistoryContent } from "../prompt/history-content.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import { fileOutputEvidence } from "../runtime/file-output-evidence.js";
import type { ExecutionEvidenceRecord } from "../contracts/execution-plan.js";
import { ExecutionEvidenceIndex } from "../runtime/execution-evidence-index.js";
import { researchCitationUrls, groundResearchResult, requiresSourceTable, RESEARCH_EVIDENCE_INSTRUCTION, SYNTHESIS_EVIDENCE_INSTRUCTION } from "./research-result-evidence.js";
import {taskModelOverride} from './task-model-override.js';
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
import { taskDelegationDepth } from "./task-tree-accounting.js";
import { deriveTaskResultSummary } from "../utils/task-result-summary.js";

const MAX_DEPENDENCY_RESULT_REFERENCES = 64;
const MAX_TASK_GUIDANCE_RECORDS_IN_CONTEXT = 16;
const MAX_DEPENDENCY_CONTEXT_CHARS = 16_000;
const MAX_ARTIFACT_RESULTS = 64;
export const MAX_PERSISTED_ASSISTANT_PREVIEWS_PER_ATTEMPT = 64;

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

    if (input.task.executionTarget !== undefined && JSON.stringify(input.task.executionTarget) !== JSON.stringify(parentSession.executionTarget)) {
      return failed("execution-target-mismatch", false);
    }

    let delegationDepth: number;
    try {
      delegationDepth = taskDelegationDepth(this.#taskStore, input.task, input.step);
    } catch {
      return failed("task-lineage-invalid", false);
    }

    const parentVisibleTools = filterTaskStepTools(
      this.#parentVisibleTools(),
      input.task,
      input.step
    );
    const recoveryContext = await this.#attemptRecoveryContext(input);
    const context = dependencyContext(this.#taskStore, input.task, input.step) + recoveryContext;
    const stepObjective = input.step.executor.role === "synthesis" && input.step.executor.requestContract?.requirements.fileOutput !== undefined &&
      this.#taskStore.listSteps(input.task.id, input.step.planRevisionId).some(step =>
        step.executor.role === "report-delivery" && step.dependsOn.includes(input.step.id))
          ? `${input.step.objective}\n\nRuntime step boundary: This is the synthesis step, not file delivery. Any save, file-write, read-back, or delivery-confirmation instructions above belong exclusively to the subsequent report-delivery step. Your only deliverable is the complete report body. Return report content with citations and material research limitations. Do not include execution status, missing-file-tool warnings, save instructions, or a delivery blocker in the report. The next step will save these exact bytes and verify them. Lack of file tools in this step is expected and is not a blocker.`
          : input.step.objective;
    const attemptFencingToken = input.attempt.lease?.fencingToken;
    if (attemptFencingToken === undefined) return failed("lease-missing", true);
    const modelOverride = taskModelOverride(this.#taskStore,input.task.id) ?? toModelOverride(input.step);
    let endReason = "task-step-failed";
    const childController = new AbortController();
    const abortChild = () => {
      endReason = "task-step-cancelled";
      if (!childController.signal.aborted) childController.abort(input.signal.reason ?? "task-attempt-cancelled");
    };
    input.signal.addEventListener("abort", abortChild, { once: true });
    if (input.signal.aborted) {
      input.signal.removeEventListener("abort", abortChild);
      return { outcome: "cancelled", usage: unavailableUsage("cancelled-before-construction") };
    }
    let child: ChildAgentLoopRuntime;
    try {
      child = await this.#childFactory.createChild({
        parentSessionId,
        profileId: input.task.profileId,
        task: stepObjective,
        context,
        allowedToolsets: [...input.step.authorityPolicy.allowedToolsets],
        allowedTools: input.step.authorityPolicy.allowedTools === undefined
          ? undefined
          : [...input.step.authorityPolicy.allowedTools],
        role: toDelegateRole(input.step),
        modelOverride,
        depth: delegationDepth,
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
          attemptFencingToken,
          originSessionId: input.task.originSessionId,
          ...(input.task.originTurnId === undefined ? {} : { originTurnId: input.task.originTurnId })
        },
        ...(input.attempt.workerSessionId === undefined ? {} : { resumeSessionId: input.attempt.workerSessionId })
      });
    } catch (error) {
      input.signal.removeEventListener("abort", abortChild);
      if (input.signal.aborted) return { outcome: "cancelled", usage: unavailableUsage("cancelled-during-construction") };
      if (error instanceof ChildModelOverrideError) return failed("model-override-unsupported", false);
      return failed("agent-construction-error", true);
    }

    let registered = false;

    try {
      if (input.signal.aborted && input.signal.reason !== TASK_STEP_HOST_HANDOFF_ABORT_REASON) {
        return {
          outcome: "cancelled",
          usage: unavailableUsage("cancelled-during-construction"),
          workerSessionId: child.childSessionId
        };
      }
      const accessFailure = delegatedChildAccessFailure(input.step, child);
      if (accessFailure !== undefined) {
        return {
          outcome: "failed",
          failure: taskFailure(accessFailure, false),
          usage: unavailableUsage("delegated-tools-unavailable"),
          workerSessionId: child.childSessionId
        };
      }
      input.checkpoint({
        workerSessionId: child.childSessionId
      });
      if (input.signal.aborted) {
        return {
          outcome: "cancelled",
          usage: unavailableUsage("cancelled-during-construction"),
          workerSessionId: child.childSessionId
        };
      }

      this.#subagentRegistry.registerSubagent({
        subagentId: input.attempt.id,
        childSessionId: child.childSessionId,
        parentSessionId,
        depth: delegationDepth,
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
      const siblingSubagents = this.#taskStore
        .listSteps(input.task.id, input.step.planRevisionId)
        .filter((step) => step.executor.role === "worker" || step.executor.role === "orchestrator")
        .sort((left, right) => left.position - right.position);
      const taskIndex = siblingSubagents.findIndex((step) => step.id === input.step.id);

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
        depth: delegationDepth,
        task: stepObjective,
        context,
        ...(input.attempt.workerSessionId === undefined ? {} : {
          prompt: "Continue this durable Task from the saved worker session. Use the existing transcript and do not repeat completed actions."
        }),
        channel: "cli",
        trustedWorkspace: true,
        provider: childProvider(child),
        model: childModel(child),
        effectiveAllowedTools: child.toolAccess.effectiveAllowedTools,
        ...(taskIndex < 0 ? {} : { taskIndex, batchTaskCount: siblingSubagents.length }),
        taskId: input.task.id,
        stepId: input.step.id,
        attemptId: input.attempt.id,
        parentOnEvent: this.#taskProgressSink(input),
        ...(input.step.executor.research === undefined && input.step.executor.requestContract?.requirements.research === undefined &&
          input.step.executor.role !== "report-delivery" && input.step.executor.role !== "synthesis" ? {} : { stepCompletion: {
          // Dependency reads are assigned by the durable graph, not optional semantic hints.
          requiredTools: input.step.dependsOn.length > 0 ? ["task.result.read"] : [],
          // Parent orchestration and research acceptance are enforced by this executor.
          // Only the delivery Step owns the foreground write/read-back requirement.
          requirements: {
            skillReferences: [], issues: [],
            ...(input.step.executor.role !== "report-delivery" ? {} : {
              fileOutput: input.step.executor.requestContract?.requirements.fileOutput
            })
          },
          ...(input.step.executor.role === "report-delivery" ? {
            validate: (_text, executions) => {
              // Feedback uses executor records. Settlement below still requires the
              // authoritative persisted receipts and exact accepted-result hash.
              const index = new ExecutionEvidenceIndex();
              for (const execution of executions) index.record(execution, "delivery-feedback");
              const requirements = input.step.executor.requestContract?.requirements;
              const evidence = fileOutputEvidence({ requirements: requirements && { ...requirements, originTurnId: undefined, sourceTaskId: input.task.id },
                toolExecutions: executions, executionReceipts: index.recordsForTurn("delivery-feedback") });
              return evidence.satisfied ? undefined : `File delivery is incomplete (${evidence.reason}). Read the complete accepted synthesis with task.result.read, copy it exactly with file.write sourceResult: {taskId, resultId} (omit content), then read the entire file with file.read using only path. Respect overwrite approvals. Do not repeat research.`;
            }
          } : {
            validate: (text, executions) => researchCompletionFailure(input, this.#taskStore, text, executions, this.#now())
          })
        } }),
        inputMetadata: {
          durableTask: true,
          taskId: input.task.id,
          planRevisionId: input.step.planRevisionId,
          stepId: input.step.id,
          attemptId: input.attempt.id,
          parentSessionId
        },
        now: this.#now
      });

      const worker = { workerSessionId: child.childSessionId };
      if (input.signal.aborted || runnerResult.kind === "cancelled") {
        endReason = "task-step-cancelled";
        return { outcome: "cancelled", usage: unavailableUsage("agent-cancelled"), ...worker };
      }
      if (runnerResult.kind === "timeout") {
        endReason = "task-step-timeout";
        return { outcome: "failed", failure: taskFailure("timeout", true), usage: unavailableUsage("agent-timeout"), ...worker };
      }
      if (childController.signal.aborted) {
        endReason = "task-step-cancelled";
        return { outcome: "cancelled", usage: unavailableUsage("agent-cancelled"), ...worker };
      }

      const response = runnerResult.response;
      input.checkpoint({ milestone: "provider-completed" });
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
      if (hasUnrecoveredToolFailure(input.step, response.toolExecutions)) {
        return {
          outcome: "failed",
          failure: taskFailure("tool-error", true),
          ...safeDiagnosticOutput(response.text, response.toolExecutions),
          ...metering,
          ...common
        };
      }

      if (input.step.executor.role === "report-delivery") {
        const requirements = input.step.executor.requestContract?.requirements;
        const evidence = fileOutputEvidence({
          requirements: requirements === undefined ? undefined : { ...requirements, originTurnId: undefined, sourceTaskId: input.task.id },
          toolExecutions: response.toolExecutions,
          executionReceipts: events.filter((event): event is typeof event & ExecutionEvidenceRecord => event.kind === "execution-evidence-recorded")
        });
        if (requirements?.fileOutput === undefined || !evidence.satisfied) return {
          outcome: "failed", failure: { ...taskFailure("evidence-contract-unsatisfied", false), message: `File delivery is incomplete (${evidence.satisfied ? "missing-file-requirement" : evidence.reason}). Inspect the write and read-back evidence.` }, ...metering, ...common
        };
      }
      const stopped = response.finalOutcome?.terminationCause;
      if ((stopped !== undefined && stopped !== "normal") || response.completionValidationFailure !== undefined) return {
        outcome: "failed",
        failure: { ...taskFailure(stopped !== undefined && stopped !== "normal" ? "execution-stopped" : "evidence-contract-unsatisfied", false), message:
          `Execution stopped (${stopped ?? "normal"}). ${response.completionValidationFailure ?? "An accepted answer was not produced."} Inspect the preserved draft.` },
        ...safeDiagnosticOutput(response.completionCandidate ?? response.text, response.toolExecutions), ...metering, ...common
      };
      const evidenceFailure = researchCompletionFailure(input, this.#taskStore, response.text, response.toolExecutions, this.#now());
      if (evidenceFailure !== undefined) return {
        outcome: "failed",
        failure: { ...taskFailure("evidence-contract-unsatisfied", false), message: evidenceFailure.split(". ")[0] + ". Inspect the preserved draft and validation feedback." },
        ...safeDiagnosticOutput(response.text, response.toolExecutions), ...metering, ...common
      };
      const grounded = groundResearchResult({ task: input.task, step: input.step, store: this.#taskStore,
        text: response.text, executions: response.toolExecutions, now: this.#now() });
      const unavailableSources = response.toolExecutions.filter(execution => execution.result?.ok === false &&
        isAlternativeResearchRead(input.step, execution, response.toolExecutions)).length;
      const researchText = (grounded.text ?? response.text) + (unavailableSources
        ? `\n\nSource access limitation: ${unavailableSources} source read(s) failed. Findings use other observed sources; failed retrievals remain in the attempt history.` : "");
      const captured = await captureResults(researchText, response.artifacts, input, this.#resolveArtifactContent);
      if (captured.failure !== undefined) {
        return {
          outcome: "failed",
          failure: captured.failure,
          ...safeDiagnosticOutput(response.text, response.toolExecutions),
          ...metering,
          ...common
        };
      }
      input.checkpoint({ milestone: "result-captured" });
      endReason = "task-step-completed";
      return { outcome: "succeeded", results: captured.results, ...metering, ...common };
    } catch (error) {
      if (!(error instanceof ProviderAccountingError)) throw error;
      if (input.signal.aborted) return { outcome: "cancelled", usage: unavailableUsage("agent-cancelled"), workerSessionId: child.childSessionId };
      // A known bookkeeping failure is not evidence of a failed research read.
      // Recovery is safe only where the Step cannot perform mutations/delegate.
      const readOnly = !input.step.authorityPolicy.mayCreateChildTasks &&
        Object.entries(input.step.authorityPolicy.riskClassPolicy).every(([risk, policy]) =>
          policy === "forbid" || risk === "read-only-local" || risk === "read-only-network");
      const events = await this.#sessionDb.listEvents(child.childSessionId);
      const blocked = events.some(event => event.kind === "tool-gated" && event.decision !== "allow" ||
        event.kind === "security-assessed" && event.assessment.decision !== "allow");
      const recoverable = readOnly && !blocked && await this.#isWorkspaceTrusted(input.task.workspace);
      const text = inspectPlaintextCredentials(error.diagnosticText).redactedText;
      if (recoverable) input.checkpoint({ milestone: "provider-completed" });
      if (recoverable && text.trim()) await this.#sessionDb.appendMessage({
        sessionId: child.childSessionId, role: "agent", content: text,
        metadata: { accountingDiagnostic: true, accepted: false }
      });
      return {
        outcome: "failed", workerSessionId: child.childSessionId,
        failure: { class: "provider-accounting", message: "The provider returned a response, but runtime accounting could not settle it. The response was not accepted or executed.",
          retryable: recoverable, uncertainSideEffects: !readOnly },
        usage: unavailableUsage("provider-accounting"),
        ...(recoverable ? safeDiagnosticOutput(text, []) : {})
      };
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

  async #attemptRecoveryContext(input: TaskStepExecutionInput): Promise<string> {
    const previous = this.#taskStore.listAttempts(input.task.id, input.step.id)
      .filter(attempt => attempt.attemptNumber < input.attempt.attemptNumber && ["provider-accounting", "evidence-contract-unsatisfied", "execution-stopped"].includes(attempt.failure?.class ?? ""))
      .sort((a, b) => b.attemptNumber - a.attemptNumber)[0];
    if (!previous?.workerSessionId) return "";
    const session = await this.#sessionDb.getSession(previous.workerSessionId);
    if (session?.profileId !== input.task.profileId || session.parentSessionId !== input.task.creatorSessionId) return "";
    const messages = await this.#sessionDb.listMessages(previous.workerSessionId);
    const draft = [...messages].reverse().find(message => message.role === "agent" &&
      (message.metadata?.accountingDiagnostic === true || message.metadata?.completionCandidate === true) && message.metadata.accepted === false);
    if (!draft) return "";
    return "\n\nRecovery draft from this Step's previous attempt (not accepted evidence). Repair this draft; verify its relevant sources with your allowed tools. Do not repeat the entire investigation or assume previous citations are verified in this attempt.\n" +
      truncateHistoryContent(inspectPlaintextCredentials(draft.content).redactedText, 32_000) +
      "\nUnresolved feedback from the prior attempt: " + inspectPlaintextCredentials(previous.failure?.message ?? "Review and correct the draft.").redactedText;
  }

  #taskProgressSink(input: TaskStepExecutionInput): RuntimeEventSink {
    let persistedAssistantPreviews = 0;
    let lastPersistedAssistantPreview: string | undefined;
    return async (event: RuntimeEvent) => {
      if (event.kind === "delegation-progress") {
        const activity = taskActivityFromDelegationProgress(event);
        const assistantPreview = activity?.assistantPreview;
        const canPersist = assistantPreview === undefined || (
          assistantPreview !== lastPersistedAssistantPreview &&
          persistedAssistantPreviews < MAX_PERSISTED_ASSISTANT_PREVIEWS_PER_ATTEMPT
        );
        if (activity !== undefined && canPersist) {
          input.checkpoint({ activity });
          if (assistantPreview !== undefined) {
            lastPersistedAssistantPreview = assistantPreview;
            persistedAssistantPreviews++;
          }
        }
      }
      await this.#onEvent?.(event);
    };
  }
}

function delegatedChildAccessFailure(
  step: TaskStep,
  child: ChildAgentLoopRuntime
): "delegated-tools-unavailable" | "delegated-authority-violation" | undefined {
  const persistedAccess = step.executor.delegationAccess;
  if (persistedAccess === undefined) return undefined;
  const effectiveTools = child.toolAccess.effectiveAllowedTools;
  if (effectiveTools.length === 0) return "delegated-tools-unavailable";
  const persistedTools = new Set(persistedAccess.effectiveAllowedTools);
  if (effectiveTools.some((name) => !persistedTools.has(name))) {
    return "delegated-authority-violation";
  }
  const persistedToolsets = new Set(persistedAccess.effectiveAllowedToolsets);
  if (child.toolAccess.effectiveAllowedToolsets.some((name) => !persistedToolsets.has(name))) {
    return "delegated-authority-violation";
  }
  const allowedTools = step.authorityPolicy.allowedTools === undefined
    ? undefined
    : new Set(step.authorityPolicy.allowedTools);
  if (allowedTools !== undefined && effectiveTools.some((name) => !allowedTools.has(name))) {
    return "delegated-authority-violation";
  }
  const allowedToolsets = new Set(step.authorityPolicy.allowedToolsets);
  if (child.toolAccess.effectiveAllowedToolsets.some((name) => !allowedToolsets.has(name))) {
    return "delegated-authority-violation";
  }
  return undefined;
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
  const availableResults = store.listResults(task.id)
    .filter((result) => result.status === "available" && result.disposition === "accepted" &&
      result.stepId !== undefined && dependencyIds.has(result.stepId));
  const references = availableResults
    .slice(0, MAX_DEPENDENCY_RESULT_REFERENCES)
    .map((result) => {
      const producer = result.stepId === undefined ? undefined : store.getStep(result.stepId) ?? undefined;
      const producerResearch = producer !== undefined && producer.taskId === task.id &&
        producer.planRevisionId === step.planRevisionId
        ? producer.executor.research
        : undefined;
      return {
        stepId: result.stepId,
        ...(producerResearch === undefined ? {} : { researchScope: producerResearch.scope }),
        readInput: {
          task_id: task.id,
          result_id: result.id
        },
        kind: result.kind,
        bytes: result.byteLength,
        summary: result.displaySummary === undefined
          ? result.summary === undefined ? undefined : boundText(result.summary, 240)
          : boundText(result.displaySummary, 240)
      };
    });
  const guidance = store.listGuidance(task.id)
    .slice(-MAX_TASK_GUIDANCE_RECORDS_IN_CONTEXT)
    .map((entry) => ({ id: entry.id, guidance: entry.guidance, createdAt: entry.createdAt }));
  const synthesisResearchBoundary = synthesisResearchScopeContext(store, task, step);
  const partialSynthesis = partialSynthesisContext(store, task, step, availableResults);
  return boundText([
    step.executor.role === "worker" && (step.executor.research !== undefined || step.executor.requestContract?.requirements.research !== undefined) ? `Assigned research objective: ${step.objective}. You are a research worker, not the synthesizer. Gather evidence for this scope; no worker dependency reports are required.` : `Durable Task objective: ${task.objective}`,
    ...(step.executor.requestContract === undefined ? [] : [
      `Original user objective (context, not a new delegation request):\n${step.executor.requestContract.objective.split("\n").map((line) => `> ${line}`).join("\n")}`,
      `Research workflow: ${step.executor.requestContract.skillName ?? "no explicit skill"}. Preserve the original freshness scope: ${step.executor.requestContract.requirements.research?.fresh ? "current sources required" : "no explicit freshness bound"}. Work only on this assigned Step; do not repeat the parent's worker batch or save its report from a worker.`,
      "The requested file output, when present, remains pending until workspace tools produce a verified write and readback. A synthesis result alone is not a saved file."
    ]),
    `Current Step: ${step.title}`,
    resultInstruction(step),
    ...(!requiresSourceTable(step, store) ? [] : [RESEARCH_EVIDENCE_INSTRUCTION, ...(step.executor.role === "synthesis" ? [SYNTHESIS_EVIDENCE_INSTRUCTION] : [])]),
    guidance.length === 0
      ? "Operator guidance: none."
      : `Authorized operator guidance (later entries take precedence without overriding policy):\n${JSON.stringify(guidance)}`,
    ...(synthesisResearchBoundary === undefined ? [] : [synthesisResearchBoundary]),
    ...(partialSynthesis === undefined ? [] : [partialSynthesis]),
    references.length === 0
      ? "Dependency results: none."
      : `Dependency result references. To read one, call task.result.read with reference.readInput exactly; it already contains the authorized task_id and result_id. Do not derive task_id from a result handle:\n${JSON.stringify(references)}`
  ].join("\n\n"), MAX_DEPENDENCY_CONTEXT_CHARS);
}

function synthesisResearchScopeContext(
  store: TaskStore,
  task: Task,
  step: TaskStep
): string | undefined {
  if (step.executor.kind !== "agent" || step.executor.role !== "synthesis") return undefined;
  const scopes = step.dependsOn.flatMap((stepId) => {
    const dependency = store.getStep(stepId);
    return dependency !== null && dependency.taskId === task.id && dependency.executor.research !== undefined
      ? [dependency.executor.research.scope]
      : [];
  });
  if (scopes.length === 0) return undefined;
  return [
    `Assigned research scopes: ${JSON.stringify(scopes)}`,
    "Keep each scope's evidence distinct. Do not present overlapping scopes as independent corroboration, and do not fill an unavailable scope with training knowledge."
  ].join("\n");
}

function partialSynthesisContext(
  store: TaskStore,
  task: Task,
  step: TaskStep,
  availableResults: readonly { readonly stepId?: string }[]
): string | undefined {
  if (step.executor.kind !== "agent" || step.executor.role !== "synthesis") return undefined;
  const resultStepIds = new Set(availableResults.flatMap((result) => result.stepId === undefined ? [] : [result.stepId]));
  const coverage = step.dependsOn.map((stepId) => {
    const dependency = store.getStep(stepId);
    if (dependency === null || dependency.taskId !== task.id || dependency.planRevisionId !== step.planRevisionId) {
      return { stepId, title: "Unavailable dependency", status: "missing", resultAvailable: false };
    }
    return {
      stepId,
      title: dependency.title,
      ...(dependency.executor.research === undefined ? {} : { researchScope: dependency.executor.research.scope }),
      status: dependency.status,
      resultAvailable: resultStepIds.has(stepId)
    };
  });
  if (coverage.every((dependency) => dependency.status === "completed")) return undefined;
  return [
    "Partial synthesis boundary: one or more dependencies did not complete successfully. Use only the available accepted dependency results; diagnostic or unavailable outputs are not evidence.",
    "Explicitly identify failed, cancelled, skipped, or missing coverage in the final answer and qualify conclusions accordingly. Do not imply that every delegated Step succeeded.",
    `Dependency coverage manifest:\n${JSON.stringify(coverage)}`
  ].join("\n");
}

function researchCompletionFailure(
  input: TaskStepExecutionInput, store: TaskStore, text: string,
  executions: readonly import("../tools/tool-executor.js").ToolExecutionRecord[], now: Date
): string | undefined {
  const grounded = groundResearchResult({ task: input.task, step: input.step, store, text, executions, now });
  if (grounded.failure !== undefined) return `Research evidence needs correction: ${grounded.failure}. ${grounded.feedback ?? "Return the corrected report with observed citations and source limitations."}`;
  // Use the same failure recovery decision before completion and at settlement.
  // A provider must be able to repair required reads before its Attempt ends.
  if (hasUnrecoveredToolFailure(input.step, executions)) return "Research evidence needs correction: unresolved-tool-error. Retry the failed required read with the same arguments, or report that the assigned evidence could not be obtained. Failed optional source reads may use other observed evidence; authorization failures are never recoverable here.";
  const missing = researchEvidenceFailure(input.step, text, [...executions]);
  return missing === undefined ? undefined : `Research evidence needs correction: ${missing}. Cite evidence observed with the assigned tools; obtain missing evidence or explicitly report the unresolved gap.`;
}

function researchEvidenceFailure(
  step: TaskStep,
  text: string,
  toolExecutions: Awaited<ReturnType<ChildAgentLoopRuntime["handle"]>>["toolExecutions"]
): "live-sources" | "repository-evidence" | undefined {
  const research = step.executor.research;
  if (research === undefined) return undefined;
  const successful = toolExecutions.filter((execution) =>
    execution.decision === "allow" && execution.result?.ok === true
  );

  if (research.requireLiveSources) {
    const observedUrls = new Set(successful
      .filter((execution) => execution.tool.name === "web.search" || execution.tool.name === "web.extract")
      .flatMap((execution) => execution.tool.name === "web.extract"
        ? collectHttpUrls([execution.result?.metadata?.url])
        : collectHttpUrls([execution.result?.content, execution.result?.metadata])));
    const citedUrls = collectHttpUrls([text]);
    if (!successful.some(execution => execution.tool.name === "web.search") || observedUrls.size === 0 || citedUrls.length === 0 || citedUrls.some((url) => !observedUrls.has(url))) {
      return "live-sources";
    }
  }

  if (research.requireRepositoryEvidence) {
    const repositoryReads = successful.filter((execution) => execution.tool.name === "file.read");
    const usedDiscovery = successful.some((execution) =>
      execution.tool.name === "file.search" ||
      execution.tool.name === "file.grep" ||
      execution.tool.name === "file.glob"
    );
    const observedPaths = new Set(repositoryReads.flatMap((execution) => [
      workspaceRelativeReference(execution.result?.metadata?.path),
      workspaceRelativeReference(execution.input?.path)
    ].filter((path): path is string => path !== undefined)));
    if (!usedDiscovery || observedPaths.size === 0 || ![...observedPaths].some((path) => hasWorkspaceReference(text, path))) {
      return "repository-evidence";
    }
  }
  return undefined;
}

function collectHttpUrls(values: readonly unknown[]): string[] {
  const urls = new Set<string>();
  const visit = (value: unknown, depth: number): void => {
    if (urls.size >= 128 || depth > 4 || value === undefined || value === null) return;
    if (typeof value === "string") {
      for (const match of researchCitationUrls(value.slice(0, 24_000))) {
        const normalized = normalizedHttpUrl(match);
        if (normalized !== undefined) urls.add(normalized);
        if (urls.size >= 128) break;
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value.slice(0, 128)) visit(entry, depth + 1);
      return;
    }
    if (typeof value === "object") {
      for (const entry of Object.values(value as Record<string, unknown>).slice(0, 128)) visit(entry, depth + 1);
    }
  };
  for (const value of values) visit(value, 0);
  return [...urls];
}

function normalizedHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value.replace(/[.,;:!?]+$/u, ""));
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

function workspaceRelativeReference(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//u, "");
  if (normalized.length === 0 || normalized === "." || normalized.length > 500 ||
    normalized.startsWith("/") || /^[A-Za-z]:\//u.test(normalized) ||
    normalized.split("/").some((segment) => segment === ".." || segment.length === 0)) {
    return undefined;
  }
  return normalized;
}

function hasWorkspaceReference(text: string, path: string): boolean {
  let offset = text.indexOf(path);
  while (offset >= 0) {
    const before = offset === 0 ? undefined : text[offset - 1];
    const afterOffset = offset + path.length;
    const after = afterOffset === text.length ? undefined : text[afterOffset];
    const pathCharacter = (value: string | undefined): boolean =>
      value !== undefined && /[A-Za-z0-9._/-]/u.test(value);
    if (!pathCharacter(before) && !pathCharacter(after)) return true;
    offset = text.indexOf(path, offset + 1);
  }
  return false;
}

function resultInstruction(step: TaskStep): string {
  switch (step.resultPolicy.kind) {
    case "none": return "Complete the Step without producing a durable result body.";
    case "text": return "Return the complete durable Step result as final response text. Begin with a concise plain-language summary paragraph of at most 200 characters without Markdown, then provide supporting detail.";
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
      : {
          results: [{
            kind: "text",
            content: text,
            mimeType: "text/plain; charset=utf-8",
            displaySummary: deriveTaskResultSummary(text)
          }]
        };
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

function hasUnrecoveredToolFailure(step: TaskStep, executions: readonly ToolExecutionRecord[]): boolean {
  return executions.some((execution, index) => execution.result?.ok === false &&
    !isRecoveredRead(execution, index, executions) && !isRecoveredDeliveryValidation(step, execution, index, executions) && !isAlternativeResearchRead(step, execution, executions));
}

/** A pre-write validation error has no uncertain effect. A later authorized
 * write to the same path may repair it; final delivery still verifies all bytes. */
function isRecoveredDeliveryValidation(step: TaskStep, failed: ToolExecutionRecord, index: number, executions: readonly ToolExecutionRecord[]): boolean {
  return step.executor.role === "report-delivery" && failed.tool.name === "file.write" && failed.decision === "allow" &&
    failed.settlement?.sideEffectState === "none" && typeof failed.input?.path === "string" &&
    executions.slice(index + 1).some(next => next.tool.name === "file.write" && next.decision === "allow" && next.result?.ok === true && next.input?.path === failed.input!.path);
}

/** Source read failures can be replaced by other observed evidence.
 * The research and grounding gates below still validate the returned report. */
function isAlternativeResearchRead(step: TaskStep, execution: ToolExecutionRecord, executions: readonly ToolExecutionRecord[]): boolean {
  if (step.executor.role !== "worker" || !step.executor.requestContract?.requirements.research ||
      !step.executor.research?.requireLiveSources || execution.decision !== "allow" ||
      execution.riskClass !== "read-only-network") return false;
  if (execution.tool.name === "web.search") {
    // A provider read failure is not a missing capability or authorization. The
    // same provider must have returned usable observations elsewhere this attempt.
    const provider = execution.result?.metadata?.provider;
    return execution.result?.metadata?.reason === "provider-failed" && typeof provider === "string" &&
      executions.some(other => other.tool.name === "web.search" && other.decision === "allow" && other.result?.ok === true &&
        other.result.metadata?.provider === provider && Array.isArray(other.result.metadata.results) && other.result.metadata.results.length > 0);
  }
  if (execution.tool.name !== "web.extract") return false;
  const status = execution.result?.metadata?.status;
  const url = execution.input?.url;
  return (["url-resolution-failed", "fetch-failed", "provider-failed"].includes(String(execution.result?.metadata?.reason)) ||
      typeof status === "number" && [403, 404, 406, 410, 429, 500, 502, 503, 504].includes(status)) &&
    typeof url === "string" && !collectHttpUrls([step.objective, step.executor.research.scope]).includes(normalizedHttpUrl(url) ?? url);
}

function isRecoveredRead(
  failedExecution: Awaited<ReturnType<ChildAgentLoopRuntime["handle"]>>["toolExecutions"][number],
  failedIndex: number,
  executions: readonly ToolExecutionRecord[]
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
  const leaseExpiresAtMs = attempt.lease === undefined ? Number.NaN : Date.parse(attempt.lease.expiresAt);
  const leaseRemainingMs = Number.isFinite(leaseExpiresAtMs)
    ? Math.max(1_000, leaseExpiresAtMs - now.getTime())
    : 1_000;
  const safeHeartbeatSeconds = Math.max(1, Math.floor(leaseRemainingMs / 3_000));
  const configuredHeartbeatSeconds = Number.isFinite(config.heartbeatSeconds) && config.heartbeatSeconds > 0
    ? config.heartbeatSeconds
    : 1;
  const maximumHeartbeatSeconds = Number.isFinite(maxHeartbeatSeconds) && maxHeartbeatSeconds > 0
    ? maxHeartbeatSeconds
    : 1;
  return {
    ...config,
    childTimeoutSeconds: Math.max(1, Math.ceil(Math.min(
      config.childTimeoutSeconds * 1_000,
      step.executionLimits.maxWallClockMs
    ) / 1_000)),
    heartbeatSeconds: Math.min(configuredHeartbeatSeconds, maximumHeartbeatSeconds, safeHeartbeatSeconds)
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
