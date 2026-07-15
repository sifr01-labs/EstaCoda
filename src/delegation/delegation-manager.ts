import type { ChannelKind } from "../contracts/channel.js";
import {
  MAX_DELEGATION_BATCH_TASKS,
  type DelegateModelOverride,
  type DelegateModelOverrideMetadata,
  type DelegateRole,
  type DelegationConfig,
  type DelegateTaskItem,
  type DelegationStaleFileWarning
} from "../contracts/delegation.js";
import type { RuntimeEventSink } from "../contracts/runtime-event.js";
import type { SessionDB, SessionEvent } from "../contracts/session.js";
import type { ToolDefinition, ToolsetName } from "../contracts/tool.js";
import type { ProviderUsage } from "../contracts/provider.js";
import { DEFAULT_DELEGATION_CONFIG } from "../config/delegation-defaults.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import type { TrajectoryRecorder } from "../trajectory/trajectory-recorder.js";
import type { AgentLoopResponse } from "../runtime/agent-loop.js";
import {
  ChildModelOverrideError,
  type ChildAgentLoopFactory,
  type ChildAgentLoopRuntime
} from "../runtime/agent-loop-factory.js";
import type { ChildToolDiagnostic } from "./toolset-security.js";
import type { FileStateReadSnapshot, FileStateTracker } from "./file-state-tracker.js";
import { findStaleParentFileReadWarnings } from "./file-state-guard.js";
import { SubagentRegistry } from "./subagent-registry.js";
import {
  appendDiagnosticEvent,
  runDelegatedChild,
  timeoutDelegationSummary
} from "./child-runner.js";
import { runBoundedBatch } from "./batch-runner.js";

export type DelegationRequest = {
  parentSessionId: string;
  profileId: string;
  task: string;
  context?: string;
  allowedToolsets?: ToolsetName[];
  allowedTools?: string[];
  role?: DelegateRole;
  modelOverride?: DelegateModelOverride;
  batchId?: string;
  taskIndex?: number;
  channel?: ChannelKind;
  trustedWorkspace: boolean;
  signal?: AbortSignal;
  onEvent?: RuntimeEventSink;
};

export type DelegationUsageMetadata = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
};

export type DelegationSummary = {
  childSessionId: string;
  status: "completed" | "blocked" | "failed";
  reason?: "cancelled" | "blocked" | "provider-error" | "runtime-error" | "construction-error" | "spawn-depth-exceeded" | "spawn-paused" | "timeout" | "model-override-unsupported";
  task: string;
  summary: string;
  role: DelegateRole;
  depth: number;
  batchId?: string;
  taskIndex?: number;
  toolExecutions: Array<{
    tool: string;
    decision: string;
    ok?: boolean;
  }>;
  allowedToolsets: ToolsetName[];
  allowedTools: string[];
  effectiveAllowedToolsets: ToolsetName[];
  effectiveAllowedTools: string[];
  strippedTools: ChildToolDiagnostic[];
  blockedTools: ChildToolDiagnostic[];
  rejectedRequestedTools: ChildToolDiagnostic[];
  rejectedRequestedToolsets: Array<{
    name: ToolsetName;
    reasons: ChildToolDiagnostic["reasons"];
  }>;
  usage?: DelegationUsageMetadata;
  aggregateUsage?: DelegationUsageMetadata;
  usageUnavailable?: boolean;
  staleFileWarnings?: DelegationStaleFileWarning[];
  staleFileWarningCount?: number;
  modelOverride?: DelegateModelOverrideMetadata;
  diagnosticPath?: string;
};

export type BatchDelegationChildStatus = DelegationSummary["status"] | "timeout" | "cancelled";

export type BatchDelegationSummary = {
  batchId: string;
  status: DelegationSummary["status"];
  reason?: "cancelled" | "blocked" | "child-failed" | "child-timeout";
  summary: string;
  results: Array<DelegationSummary & {
    index: number;
    childStatus: BatchDelegationChildStatus;
  }>;
  aggregateUsage?: DelegationUsageMetadata;
  usageUnavailable: boolean;
  usageUnavailableCount: number;
  staleFileWarningCount: number;
  maxObservedConcurrency: number;
  recoveredTasksFromJsonString?: boolean;
};

export type DelegationManagerOptions = {
  sessionDb: SessionDB;
  childFactory: ChildAgentLoopFactory;
  trajectoryRecorder: TrajectoryRecorder;
  delegationConfig?: DelegationConfig;
  currentDepth?: number;
  parentVisibleTools?: () => readonly ToolDefinition[];
  subagentRegistry?: SubagentRegistry;
  diagnosticsRoot?: string;
  fileStateTracker?: FileStateTracker;
};

export class DelegationManager {
  readonly #sessionDb: SessionDB;
  readonly #childFactory: ChildAgentLoopFactory;
  readonly #trajectoryRecorder: TrajectoryRecorder;
  readonly #delegationConfig: DelegationConfig;
  readonly #currentDepth: number;
  readonly #parentVisibleTools: () => readonly ToolDefinition[];
  readonly #subagentRegistry: SubagentRegistry;
  readonly #diagnosticsRoot: string | undefined;
  readonly #fileStateTracker: FileStateTracker | undefined;

  constructor(options: DelegationManagerOptions) {
    this.#sessionDb = options.sessionDb;
    this.#childFactory = options.childFactory;
    this.#trajectoryRecorder = options.trajectoryRecorder;
    this.#delegationConfig = options.delegationConfig ?? DEFAULT_DELEGATION_CONFIG;
    this.#currentDepth = options.currentDepth ?? 0;
    this.#parentVisibleTools = options.parentVisibleTools ?? (() => []);
    this.#subagentRegistry = options.subagentRegistry ?? new SubagentRegistry();
    this.#diagnosticsRoot = options.diagnosticsRoot;
    this.#fileStateTracker = options.fileStateTracker;
  }

  async delegateBatch(request: Omit<DelegationRequest, "task" | "batchId" | "taskIndex"> & {
    tasks: DelegateTaskItem[];
    recoveredTasksFromJsonString?: boolean;
  }): Promise<BatchDelegationSummary> {
    const maxBatchTasks = Math.max(
      1,
      Math.min(this.#delegationConfig.maxBatchTasks, MAX_DELEGATION_BATCH_TASKS)
    );
    if (request.tasks.length > maxBatchTasks) {
      throw new RangeError(`Delegation batches support at most ${maxBatchTasks} tasks.`);
    }
    const batchId = `batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const maxConcurrency = Math.min(this.#delegationConfig.maxConcurrentChildren, request.tasks.length);
    const skippedIndexes = new Set<number>();
    const parentReadSnapshot = this.#snapshotParentReads(request.parentSessionId);
    const batch = await runBoundedBatch<DelegateTaskItem, DelegationSummary>({
      tasks: request.tasks,
      maxConcurrency,
      signal: request.signal,
      runTask: async (task, index) => this.#delegateWithSnapshot({
        ...request,
        task: task.task,
        context: task.context,
        allowedToolsets: task.allowedToolsets,
        allowedTools: task.allowedTools,
        role: task.role,
        modelOverride: task.modelOverride ?? request.modelOverride,
        batchId,
        taskIndex: index
      }, parentReadSnapshot),
      skipTask: (task, index): DelegationSummary => {
        skippedIndexes.add(index);
        return {
          childSessionId: "unavailable",
          status: "failed",
          reason: "cancelled",
          task: task.task,
          summary: "Delegation cancelled before queued child start.",
          role: task.role ?? "leaf",
          depth: this.#currentDepth + 1,
          batchId,
          taskIndex: index,
          allowedToolsets: task.allowedToolsets ?? [],
          allowedTools: task.allowedTools ?? [],
          effectiveAllowedToolsets: [],
          effectiveAllowedTools: [],
          strippedTools: [],
          blockedTools: [],
          rejectedRequestedTools: [],
          rejectedRequestedToolsets: [],
          toolExecutions: [],
          modelOverride: task.modelOverride !== undefined || request.modelOverride !== undefined ? {
            requested: true,
            status: "rejected",
            reason: "cancelled"
          } : undefined,
          usageUnavailable: true
        };
      }
    });
    const results = batch.results.map((result, index) => ({
      ...result,
      index,
      childStatus: childStatus(result)
    }));
    const timeoutCount = results.filter((result) => result.childStatus === "timeout").length;
    const failedCount = results.filter((result) => result.status === "failed").length;
    const blockedCount = results.filter((result) => result.status === "blocked").length;
    const cancelledCount = results.filter((result) => result.childStatus === "cancelled").length;
    const status: DelegationSummary["status"] = failedCount > 0 || timeoutCount > 0
      ? "failed"
      : blockedCount > 0
        ? "blocked"
        : "completed";
    const reason = cancelledCount > 0
      ? "cancelled"
      : timeoutCount > 0
        ? "child-timeout"
        : failedCount > 0
          ? "child-failed"
          : blockedCount > 0
            ? "blocked"
            : undefined;
    const summary = [
      `Delegation batch ${batchId}: ${status}.`,
      `Completed: ${results.filter((result) => result.status === "completed").length}/${results.length}.`,
      blockedCount > 0 ? `Blocked: ${blockedCount}.` : undefined,
      failedCount > 0 ? `Failed: ${failedCount}.` : undefined,
      timeoutCount > 0 ? `Timed out: ${timeoutCount}.` : undefined,
      cancelledCount > 0 ? `Cancelled: ${cancelledCount}.` : undefined
    ].filter((line): line is string => line !== undefined).join(" ");
    const usageRollup = rollUpChildUsage(results);
    const staleFileWarningCount = results.reduce((count, result) => count + (result.staleFileWarningCount ?? 0), 0);
    return {
      batchId,
      status,
      reason,
      summary,
      results,
      aggregateUsage: usageRollup.aggregateUsage,
      usageUnavailable: usageRollup.usageUnavailable,
      usageUnavailableCount: usageRollup.usageUnavailableCount,
      staleFileWarningCount,
      maxObservedConcurrency: batch.maxObservedConcurrency,
      recoveredTasksFromJsonString: request.recoveredTasksFromJsonString === true ? true : undefined
    };
  }

  async delegate(request: DelegationRequest): Promise<DelegationSummary> {
    return await this.#delegateWithSnapshot(request, this.#snapshotParentReads(request.parentSessionId));
  }

  async #delegateWithSnapshot(
    request: DelegationRequest,
    parentReadSnapshot: FileStateReadSnapshot | undefined
  ): Promise<DelegationSummary> {
    const allowedToolsets = request.allowedToolsets ?? [];
    const allowedTools = request.allowedTools ?? [];
    const role = request.role ?? "leaf";
    const depth = this.#currentDepth + 1;

    if (isSignalAborted(request.signal)) {
      return await this.#cancelledBeforeStart(request, allowedToolsets, allowedTools, role, depth);
    }

    if (this.#subagentRegistry.isSpawnPaused()) {
      const result = this.#spawnPaused(request, allowedToolsets, allowedTools, role, depth);
      return result;
    }

    if (depth > this.#delegationConfig.maxSpawnDepth) {
      return await this.#spawnDepthExceeded(request, allowedToolsets, allowedTools, role, depth);
    }

    const startedAt = Date.now();
    let childSessionId: string | undefined;
    let subagentId: string | undefined;
    let child: ChildAgentLoopRuntime | undefined;
    let parentAbortCleanup: (() => void) | undefined;
    let childAbortController: AbortController | undefined;
    try {
      child = await this.#childFactory.createChild({
        parentSessionId: request.parentSessionId,
        profileId: request.profileId,
        task: request.task,
        context: request.context,
        allowedToolsets,
        allowedTools,
        role,
        depth,
        channel: request.channel,
        modelOverride: request.modelOverride,
        trustedWorkspace: request.trustedWorkspace,
        parentVisibleTools: this.#parentVisibleTools()
      });
      childSessionId = child.childSessionId;

      if (isSignalAborted(request.signal)) {
        const result = this.#withStaleFileWarnings(
          this.#cancelledAfterConstruction(request, allowedToolsets, allowedTools, role, depth, childSessionId),
          request,
          parentReadSnapshot
        );
        await this.#emitSettlement(request, result, role, depth);
        return result;
      }

      childAbortController = new AbortController();
      subagentId = child.childSessionId;
      parentAbortCleanup = linkParentAbort(request.signal, childAbortController, () =>
        this.#subagentRegistry.interruptChildrenForParent(request.parentSessionId, "parent-aborted")
      );
      this.#subagentRegistry.registerSubagent({
        subagentId,
        childSessionId: child.childSessionId,
        parentSessionId: request.parentSessionId,
        batchId: request.batchId,
        taskIndex: request.taskIndex,
        depth,
        role,
        goal: request.task,
        model: childModel(child),
        provider: childProvider(child),
        toolCount: child.toolAccess.effectiveAllowedTools.length,
        abortController: childAbortController
      });

      await this.#recordStarted({
        parentSessionId: request.parentSessionId,
        childSessionId,
        task: request.task,
        allowedToolsets,
        allowedTools,
        role,
        depth,
        batchId: request.batchId,
        taskIndex: request.taskIndex,
        modelOverride: child.modelOverride
      });

      this.#subagentRegistry.updateSubagent(subagentId, {
        status: "running",
        lastActivityAt: new Date().toISOString()
      });
      const runnerResult = await runDelegatedChild({
        child,
        childAbortController,
        parentSignal: request.signal,
        subagentRegistry: this.#subagentRegistry,
        subagentId,
        sessionDb: this.#sessionDb,
        delegationConfig: this.#delegationConfig,
        diagnosticsRoot: this.#diagnosticsRoot,
        parentSessionId: request.parentSessionId,
        childSessionId: child.childSessionId,
        role,
        depth,
        task: request.task,
        context: request.context,
        channel: request.channel,
        trustedWorkspace: request.trustedWorkspace,
        provider: childProvider(child),
        model: childModel(child),
        effectiveAllowedTools: child.toolAccess.effectiveAllowedTools,
        taskIndex: request.taskIndex,
        batchId: request.batchId,
        parentOnEvent: request.onEvent
      });
      if (runnerResult.kind === "timeout") {
        await appendDiagnosticEvent({
          sessionDb: this.#sessionDb,
          parentSessionId: request.parentSessionId,
          childSessionId: child.childSessionId,
          role,
          depth,
          taskIndex: request.taskIndex,
          batchId: request.batchId
        }, "timeout", runnerResult.diagnostic ?? {
          taskHash: "",
          taskPreview: ""
        });
	        let result = timeoutDelegationSummary({
	          childSessionId: child.childSessionId,
	          task: request.task,
	          summary: runnerResult.summary,
          role,
          depth,
          batchId: request.batchId,
          taskIndex: request.taskIndex,
          allowedToolsets,
          allowedTools,
          child,
          diagnostic: runnerResult.diagnostic
	        });
	        result.usageUnavailable = true;
          result.modelOverride = child.modelOverride;
	        result = this.#withStaleFileWarnings(result, request, parentReadSnapshot);
	        await this.#recordFinished({
	          parentSessionId: request.parentSessionId,
	          childSessionId: child.childSessionId,
          status: result.status,
          reason: result.reason,
          summary: result.summary,
          durationMs: Date.now() - startedAt,
	          error: result.summary,
          diagnosticPath: result.diagnosticPath,
	          modelOverride: result.modelOverride,
	          usageUnavailable: result.usageUnavailable,
	          staleFileWarnings: result.staleFileWarnings,
	          staleFileWarningCount: result.staleFileWarningCount
	        });
        await this.#emitSettlement(request, result, role, depth);
        return result;
      }
      if (runnerResult.kind === "cancelled") {
	        const result = this.#withStaleFileWarnings({
	          childSessionId: child.childSessionId,
	          status: "failed",
          reason: "cancelled",
          task: request.task,
          summary: runnerResult.summary,
          role,
          depth,
          batchId: request.batchId,
          taskIndex: request.taskIndex,
          allowedToolsets,
          allowedTools,
          effectiveAllowedToolsets: child.toolAccess.effectiveAllowedToolsets,
          effectiveAllowedTools: child.toolAccess.effectiveAllowedTools,
          strippedTools: child.toolAccess.strippedTools,
          blockedTools: child.toolAccess.blockedTools,
          rejectedRequestedTools: child.toolAccess.rejectedRequestedTools,
          rejectedRequestedToolsets: child.toolAccess.rejectedRequestedToolsets,
          toolExecutions: [],
          modelOverride: child.modelOverride,
	          usageUnavailable: true
	        }, request, parentReadSnapshot);
	        await this.#recordFinished({
          parentSessionId: request.parentSessionId,
          childSessionId: child.childSessionId,
          status: result.status,
          reason: result.reason,
          summary: result.summary,
          durationMs: Date.now() - startedAt,
	          error: result.summary,
	          modelOverride: result.modelOverride,
	          usageUnavailable: result.usageUnavailable,
	          staleFileWarnings: result.staleFileWarnings,
	          staleFileWarningCount: result.staleFileWarningCount
	        });
        await this.#emitSettlement(request, result, role, depth);
        return result;
      }
      const childResponse = runnerResult.response;
      const summary = childResponse.text;
      const status = await this.#statusFromChildResponse(child.childSessionId, childResponse, request.signal);
      const usage = usageFromProviderResponse(childResponse.providerExecution?.response?.usage);
      const usageUnavailable = usage === undefined;
	      const result = this.#withStaleFileWarnings({
	        childSessionId: child.childSessionId,
	        status: status.status,
        reason: status.reason,
        task: request.task,
        summary,
        role,
        depth,
        batchId: request.batchId,
        taskIndex: request.taskIndex,
        allowedToolsets,
        allowedTools,
        effectiveAllowedToolsets: child.toolAccess.effectiveAllowedToolsets,
        effectiveAllowedTools: child.toolAccess.effectiveAllowedTools,
        strippedTools: child.toolAccess.strippedTools,
        blockedTools: child.toolAccess.blockedTools,
        rejectedRequestedTools: child.toolAccess.rejectedRequestedTools,
        rejectedRequestedToolsets: child.toolAccess.rejectedRequestedToolsets,
        usage,
        aggregateUsage: usage,
        usageUnavailable,
        modelOverride: child.modelOverride,
	        toolExecutions: childResponse.toolExecutions.map((execution) => ({
	          tool: execution.tool.name,
	          decision: execution.decision,
	          ok: execution.result?.ok
	        }))
	      }, request, parentReadSnapshot);
      this.#subagentRegistry.updateSubagent(subagentId, {
        status: result.status === "completed" ? "completed" : "failed",
        lastActivityAt: new Date().toISOString()
      });
      await this.#recordFinished({
        parentSessionId: request.parentSessionId,
        childSessionId: child.childSessionId,
        status: result.status,
        reason: result.reason,
        summary: result.summary,
        durationMs: Date.now() - startedAt,
        modelOverride: result.modelOverride,
        usage: result.usage,
        aggregateUsage: result.aggregateUsage,
	        usageUnavailable: result.usageUnavailable,
	        staleFileWarnings: result.staleFileWarnings,
	        staleFileWarningCount: result.staleFileWarningCount
	      });
      await this.#emitSettlement(request, result, role, depth);
      return result;
    } catch (error) {
      if (error instanceof ChildModelOverrideError) {
        const result = this.#modelOverrideRejected(request, allowedToolsets, allowedTools, role, depth, error);
        return result;
      }

      const summary = error instanceof Error ? error.message : "Unknown child delegation error.";
	      const result = this.#withStaleFileWarnings({
	        childSessionId: childSessionId ?? "unavailable",
	        status: "failed",
        reason: childSessionId === undefined ? "construction-error" : "runtime-error",
        task: request.task,
        summary,
        role,
        depth,
        batchId: request.batchId,
        taskIndex: request.taskIndex,
        allowedToolsets,
        allowedTools,
        effectiveAllowedToolsets: [],
        effectiveAllowedTools: [],
        strippedTools: [],
        blockedTools: [],
        rejectedRequestedTools: [],
        rejectedRequestedToolsets: [],
        toolExecutions: [],
        modelOverride: child?.modelOverride,
	        usageUnavailable: true
	      }, request, parentReadSnapshot);
      if (subagentId !== undefined) {
        this.#subagentRegistry.updateSubagent(subagentId, {
          status: isSignalAborted(request.signal) ? "cancelling" : "failed",
          lastActivityAt: new Date().toISOString()
        });
      }
      if (childSessionId !== undefined) {
        await this.#recordFinished({
          parentSessionId: request.parentSessionId,
          childSessionId,
          status: "failed",
          reason: result.reason,
          summary,
          durationMs: Date.now() - startedAt,
          error: summary,
          modelOverride: result.modelOverride,
	          usageUnavailable: result.usageUnavailable,
	          staleFileWarnings: result.staleFileWarnings,
	          staleFileWarningCount: result.staleFileWarningCount
	        });
        await this.#emitSettlement(request, result, role, depth);
      }
      return result;
    } finally {
      parentAbortCleanup?.();
      if (subagentId !== undefined) {
        this.#subagentRegistry.unregisterSubagent(subagentId);
      }
      await child?.cleanup().catch(() => undefined);
    }
  }

  async #cancelledBeforeStart(
    request: DelegationRequest,
    allowedToolsets: ToolsetName[],
    allowedTools: string[],
    role: DelegateRole,
    depth: number
  ): Promise<DelegationSummary> {
    const summary = "Delegation cancelled before child start.";
    this.#trajectoryRecorder.record("delegation-finished", {
      parentSessionId: request.parentSessionId,
      childSessionId: "unavailable",
      status: "failed",
      reason: "cancelled",
      summary,
      usageUnavailable: true
    });
    const result: DelegationSummary = {
      childSessionId: "unavailable",
      status: "failed",
      reason: "cancelled",
      task: request.task,
      summary,
      role,
      depth,
      batchId: request.batchId,
      taskIndex: request.taskIndex,
      allowedToolsets,
      allowedTools,
      effectiveAllowedToolsets: [],
      effectiveAllowedTools: [],
      strippedTools: [],
      blockedTools: [],
      rejectedRequestedTools: [],
      rejectedRequestedToolsets: [],
      toolExecutions: [],
      modelOverride: request.modelOverride === undefined ? undefined : {
        requested: true,
        status: "rejected",
        reason: "cancelled"
      },
      usageUnavailable: true
    };
    return result;
  }

  #cancelledAfterConstruction(
    request: DelegationRequest,
    allowedToolsets: ToolsetName[],
    allowedTools: string[],
    role: DelegateRole,
    depth: number,
    childSessionId: string
  ): DelegationSummary {
    const summary = "Delegation cancelled before child start.";
    return {
      childSessionId,
      status: "failed",
      reason: "cancelled",
      task: request.task,
      summary,
      role,
      depth,
      batchId: request.batchId,
      taskIndex: request.taskIndex,
      allowedToolsets,
      allowedTools,
      effectiveAllowedToolsets: [],
      effectiveAllowedTools: [],
      strippedTools: [],
      blockedTools: [],
      rejectedRequestedTools: [],
      rejectedRequestedToolsets: [],
      toolExecutions: [],
      modelOverride: request.modelOverride === undefined ? undefined : {
        requested: true,
        status: "rejected",
        reason: "cancelled"
      },
      usageUnavailable: true
    };
  }

  #spawnPaused(
    request: DelegationRequest,
    allowedToolsets: ToolsetName[],
    allowedTools: string[],
    role: DelegateRole,
    depth: number
  ): DelegationSummary {
    const reason = this.#subagentRegistry.spawnPausedReason();
    const summary = reason === undefined || reason.length === 0
      ? "Delegation spawn is paused."
      : `Delegation spawn is paused: ${reason}`;
    return {
      childSessionId: "unavailable",
      status: "failed",
      reason: "spawn-paused",
      task: request.task,
      summary,
      role,
      depth,
      batchId: request.batchId,
      taskIndex: request.taskIndex,
      allowedToolsets,
      allowedTools,
      effectiveAllowedToolsets: [],
      effectiveAllowedTools: [],
      strippedTools: [],
      blockedTools: [],
      rejectedRequestedTools: [],
      rejectedRequestedToolsets: [],
      toolExecutions: [],
      modelOverride: request.modelOverride === undefined ? undefined : {
        requested: true,
        status: "rejected",
        reason: "spawn-paused"
      },
      usageUnavailable: true
    };
  }

	  async #spawnDepthExceeded(
    request: DelegationRequest,
    allowedToolsets: ToolsetName[],
    allowedTools: string[],
    role: DelegateRole,
    depth: number
  ): Promise<DelegationSummary> {
    const summary = `Delegation spawn depth ${depth} exceeds maxSpawnDepth ${this.#delegationConfig.maxSpawnDepth}.`;
    this.#trajectoryRecorder.record("delegation-finished", {
      parentSessionId: request.parentSessionId,
      childSessionId: "unavailable",
      status: "failed",
      reason: "spawn-depth-exceeded",
      role,
      depth,
      summary,
      usageUnavailable: true
    });
    const result: DelegationSummary = {
      childSessionId: "unavailable",
      status: "failed",
      reason: "spawn-depth-exceeded",
      task: request.task,
      summary,
      role,
      depth,
      batchId: request.batchId,
      taskIndex: request.taskIndex,
      allowedToolsets,
      allowedTools,
      effectiveAllowedToolsets: [],
      effectiveAllowedTools: [],
      strippedTools: [],
      blockedTools: [],
      rejectedRequestedTools: [],
      rejectedRequestedToolsets: [],
      toolExecutions: [],
      modelOverride: request.modelOverride === undefined ? undefined : {
        requested: true,
        status: "rejected",
        reason: "spawn-depth-exceeded"
      },
      usageUnavailable: true
    };
	    return result;
	  }

  #modelOverrideRejected(
    request: DelegationRequest,
    allowedToolsets: ToolsetName[],
    allowedTools: string[],
    role: DelegateRole,
    depth: number,
    error: ChildModelOverrideError
  ): DelegationSummary {
    const summary = error.message;
    this.#trajectoryRecorder.record("delegation-finished", {
      parentSessionId: request.parentSessionId,
      childSessionId: "unavailable",
      status: "blocked",
      reason: "model-override-unsupported",
      role,
      depth,
      summary,
      modelOverride: error.metadata,
      usageUnavailable: true
    });
    return {
      childSessionId: "unavailable",
      status: "blocked",
      reason: "model-override-unsupported",
      task: request.task,
      summary,
      role,
      depth,
      batchId: request.batchId,
      taskIndex: request.taskIndex,
      allowedToolsets,
      allowedTools,
      effectiveAllowedToolsets: [],
      effectiveAllowedTools: [],
      strippedTools: [],
      blockedTools: [],
      rejectedRequestedTools: [],
      rejectedRequestedToolsets: [],
      toolExecutions: [],
      modelOverride: error.metadata,
      usageUnavailable: true
    };
  }

	  #snapshotParentReads(parentSessionId: string): FileStateReadSnapshot | undefined {
	    return this.#fileStateTracker?.snapshotReads(parentSessionId);
	  }

	  #withStaleFileWarnings(
	    result: DelegationSummary,
	    request: DelegationRequest,
	    parentReadSnapshot: FileStateReadSnapshot | undefined
	  ): DelegationSummary {
	    const staleFileWarnings = findStaleParentFileReadWarnings({
	      tracker: this.#fileStateTracker,
	      parentReadSnapshot,
	      parentSessionId: request.parentSessionId,
	      childSessionId: result.childSessionId,
	      taskIndex: request.taskIndex,
	      batchId: request.batchId
	    });
	    if (staleFileWarnings.length === 0) {
	      return result;
	    }
	    return {
	      ...result,
	      staleFileWarnings,
	      staleFileWarningCount: staleFileWarnings.length
	    };
	  }

	  async #recordStarted(input: {
    parentSessionId: string;
    childSessionId: string;
    task: string;
    allowedToolsets: ToolsetName[];
    allowedTools: string[];
    role: DelegateRole;
    depth: number;
    batchId?: string;
    taskIndex?: number;
    modelOverride?: DelegateModelOverrideMetadata;
  }): Promise<void> {
    await this.#sessionDb.appendEvent(input.parentSessionId, {
      kind: "delegation-started",
      childSessionId: input.childSessionId,
      task: input.task,
      allowedToolsets: input.allowedToolsets,
      allowedTools: input.allowedTools,
      role: input.role,
      depth: input.depth,
      batchId: input.batchId,
      taskIndex: input.taskIndex,
      modelOverride: input.modelOverride
    });
    this.#trajectoryRecorder.record("delegation-started", input);
  }

  async #recordFinished(input: {
    parentSessionId: string;
    childSessionId: string;
    status: DelegationSummary["status"];
    reason?: DelegationSummary["reason"];
    summary: string;
    durationMs: number;
    error?: string;
    diagnosticPath?: string;
	    usage?: DelegationUsageMetadata;
	    aggregateUsage?: DelegationUsageMetadata;
	    usageUnavailable?: boolean;
      modelOverride?: DelegateModelOverrideMetadata;
	    staleFileWarnings?: DelegationStaleFileWarning[];
	    staleFileWarningCount?: number;
	  }): Promise<void> {
	    await this.#sessionDb.appendEvent(input.parentSessionId, {
      kind: "delegation-finished",
      childSessionId: input.childSessionId,
      summary: input.summary,
      status: input.status,
      reason: input.reason,
      durationMs: input.durationMs,
      error: input.error,
      diagnosticPath: input.diagnosticPath,
	      usage: input.usage,
	      aggregateUsage: input.aggregateUsage,
	      usageUnavailable: input.usageUnavailable,
        modelOverride: input.modelOverride,
	      staleFileWarnings: input.staleFileWarnings,
	      staleFileWarningCount: input.staleFileWarningCount
	    });
    this.#trajectoryRecorder.record("delegation-finished", input);
  }

  async #emitSettlement(
    request: DelegationRequest,
    result: DelegationSummary,
    role: DelegateRole,
    depth: number
  ): Promise<void> {
    if (request.onEvent === undefined || result.childSessionId === "unavailable") return;
    await request.onEvent({
      kind: "delegation-progress",
      subagentId: result.childSessionId,
      childSessionId: result.childSessionId,
      parentSessionId: request.parentSessionId,
      role,
      depth,
      taskIndex: request.taskIndex,
      batchId: request.batchId,
      childEvent: {
        kind: "delegation-result",
        status: childStatus(result)
      }
    });
  }

  async #statusFromChildResponse(
    childSessionId: string,
    response: AgentLoopResponse,
    signal: AbortSignal | undefined
  ): Promise<{ status: DelegationSummary["status"]; reason?: DelegationSummary["reason"] }> {
    if (signal?.aborted === true) {
      return { status: "failed", reason: "cancelled" };
    }
    const events = await this.#sessionDb.listEvents(childSessionId);
    if (hasStructuredBlock(response.toolExecutions, events)) {
      return { status: "blocked", reason: "blocked" };
    }
    if (response.providerExecution?.ok === false) {
      return { status: "failed", reason: "provider-error" };
    }
    return { status: "completed" };
  }
}

function childStatus(result: DelegationSummary): BatchDelegationChildStatus {
  if (result.reason === "timeout") {
    return "timeout";
  }
  if (result.reason === "cancelled") {
    return "cancelled";
  }
  return result.status;
}

export function delegatedPrompt(task: string, context: string | undefined): string {
  if (context === undefined || context.trim().length === 0) {
    return task;
  }
  return [
    `Delegated task: ${task}`,
    "",
    `Context: ${context}`
  ].join("\n");
}

function hasStructuredBlock(toolExecutions: ToolExecutionRecord[], events: SessionEvent[]): boolean {
  if (toolExecutions.some((execution) => execution.decision !== "allow")) {
    return true;
  }
  return events.some((event) =>
    event.kind === "tool-gated" && event.decision !== "allow" ||
    event.kind === "security-assessed" && event.assessment.decision !== "allow"
  );
}

function usageFromProviderResponse(usage: ProviderUsage | undefined): DelegationUsageMetadata | undefined {
  if (usage === undefined) {
    return undefined;
  }
  return normalizeUsage(usage);
}

function rollUpChildUsage(results: readonly DelegationSummary[]): {
  aggregateUsage?: DelegationUsageMetadata;
  usageUnavailable: boolean;
  usageUnavailableCount: number;
} {
  let usageUnavailableCount = 0;
  const aggregate: DelegationUsageMetadata = {};

  for (const result of results) {
    const usage = normalizeUsage(result.usage);
    if (usage === undefined) {
      usageUnavailableCount += 1;
      continue;
    }
    addUsage(aggregate, usage);
  }

  return {
    aggregateUsage: hasUsage(aggregate) ? aggregate : undefined,
    usageUnavailable: usageUnavailableCount > 0,
    usageUnavailableCount
  };
}

function normalizeUsage(usage: DelegationUsageMetadata | ProviderUsage | undefined): DelegationUsageMetadata | undefined {
  if (usage === undefined) {
    return undefined;
  }
  const normalized: DelegationUsageMetadata = {};
  if (isFiniteNumber(usage.inputTokens)) {
    normalized.inputTokens = usage.inputTokens;
  }
  if (isFiniteNumber(usage.outputTokens)) {
    normalized.outputTokens = usage.outputTokens;
  }
  if (isFiniteNumber(usage.totalTokens)) {
    normalized.totalTokens = usage.totalTokens;
  }
  if (isFiniteNumber(usage.reasoningTokens)) {
    normalized.reasoningTokens = usage.reasoningTokens;
  }
  return hasUsage(normalized) ? normalized : undefined;
}

function addUsage(target: DelegationUsageMetadata, usage: DelegationUsageMetadata): void {
  if (usage.inputTokens !== undefined) {
    target.inputTokens = (target.inputTokens ?? 0) + usage.inputTokens;
  }
  if (usage.outputTokens !== undefined) {
    target.outputTokens = (target.outputTokens ?? 0) + usage.outputTokens;
  }
  if (usage.totalTokens !== undefined) {
    target.totalTokens = (target.totalTokens ?? 0) + usage.totalTokens;
  }
  if (usage.reasoningTokens !== undefined) {
    target.reasoningTokens = (target.reasoningTokens ?? 0) + usage.reasoningTokens;
  }
}

function hasUsage(usage: DelegationUsageMetadata): boolean {
  return usage.inputTokens !== undefined ||
    usage.outputTokens !== undefined ||
    usage.totalTokens !== undefined ||
    usage.reasoningTokens !== undefined;
}

function isFiniteNumber(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function childModel(child: ChildAgentLoopRuntime): string {
  const routes = child.builtSession.providerRoutes as Partial<ChildAgentLoopRuntime["builtSession"]["providerRoutes"]> | undefined;
  return routes?.primaryModelRoute?.id ??
    routes?.mainRoute?.id ??
    routes?.model?.id ??
    "unknown";
}

function childProvider(child: ChildAgentLoopRuntime): string {
  const routes = child.builtSession.providerRoutes as Partial<ChildAgentLoopRuntime["builtSession"]["providerRoutes"]> | undefined;
  return routes?.primaryModelRoute?.provider ??
    routes?.mainRoute?.provider ??
    routes?.model?.provider ??
    "unknown";
}

function linkParentAbort(
  parentSignal: AbortSignal | undefined,
  childAbortController: AbortController,
  onAbort: () => void
): (() => void) | undefined {
  if (parentSignal === undefined) {
    return undefined;
  }
  const abortChild = () => {
    onAbort();
    if (!childAbortController.signal.aborted) {
      childAbortController.abort(parentSignal.reason ?? "parent-aborted");
    }
  };
  if (parentSignal.aborted) {
    abortChild();
    return undefined;
  }
  parentSignal.addEventListener("abort", abortChild, { once: true });
  return () => parentSignal.removeEventListener("abort", abortChild);
}

function isSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
