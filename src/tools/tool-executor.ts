import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import {
  DEFAULT_ENVIRONMENT_TYPE,
  assessSecurityPolicy,
  type EnvironmentType,
  type SecurityDecision,
  type SecurityPolicy
} from "../contracts/security.js";
import type { SessionDB } from "../contracts/session.js";
import type { ExecutionCheckpointJournalController } from "../contracts/execution-checkpoint.js";
import { checkpointResourcesFromResult } from "../runtime/execution-checkpoint-resources.js";
import type { ToolApprovalHandler, ToolDefinition, ToolExecutionConcurrency, ToolExecutionContext, ToolExecutionEffect, ToolExecutionSettlement, ToolResult, ToolRiskClass, ToolSecurityResolution, ToolsetName } from "../contracts/tool.js";
import type { RuntimeEventSink } from "../contracts/runtime-event.js";
import type { ProviderUsageLineage } from "../contracts/provider-usage.js";
import type { VisionDispatchPhase, VisionInputProvenanceContext } from "../contracts/vision.js";
import type {
  BrowserFieldSecureInputSource,
  SecureInputKind,
  SecureInputProtectedSourceFailure,
  SecureInputRequestHandler,
  SecureInputTransferRequestHandler,
} from "../contracts/secure-input.js";
import { assessCommandSafety } from "../security/command-safety.js";
import { protectPlaintextToolArguments } from "../security/plaintext-credential-guard.js";
import type { TrajectoryRecorder } from "../trajectory/trajectory-recorder.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { DelegateCallBudget } from "../delegation/delegate-call-budget.js";
import { buildToolSecurityTargetSummary } from "./tool-target-summary.js";
import { resolveToolExecutionEffect } from "./tool-capability.js";
import {
  findProtectedArgumentEnvelopes,
  matchesProtectedArgumentPattern,
  setAtProtectedArgumentPointer,
} from "../security/protected-argument-path.js";
import { createTimeoutSignal } from "../utils/timeout-signal.js";
import { ExecutionOperationLedger, semanticMutationKey } from "./execution-operation-ledger.js";
import {
  checkpointOperationCoordinates,
  checkpointSafeFactsFromResult,
  checkpointVerificationMatch
} from "../runtime/execution-checkpoint-journal.js";
import { ExecutionCheckpointConflictError, executionCheckpointOperationId } from "../runtime/execution-checkpoint-controller.js";
import { isTerminalCheckpointStatus } from "../session/execution-checkpoint-state.js";

const MAX_STORED_TOOL_RESULT_CHARS = 12_000;
const MAX_CONTEXT_SUMMARY_CHARS = 500;
const DEFAULT_TOOL_EXECUTION_TIMEOUT_MS = 5 * 60_000;
const SENSITIVE_KEY_RE = /apiKey|api[_-]?key|password|passwd|token|secret|credential|authorization|(?:^|[_-])auth(?:$|[_-])/i;
const REDACTED_SECRET_VALUE = "[REDACTED]";
const REDACTED_CDP_EXPRESSION = "[REDACTED_CDP_EXPRESSION]";
const REDACTED_PROVIDER_ARGUMENTS = "[REDACTED_PROVIDER_ARGUMENTS]";
const SENSITIVE_QUERY_PARAM_VALUE_RE = /(^|[?&;\s])((?:token|access_token|refresh_token|id_token|api_key|key|password|passwd|secret|client_secret|auth|authorization)=)([^&;\s"'<>)[\][]+)/giu;
const SENSITIVE_FIELD_VALUE_RE = /(^|["'{,\s])([A-Za-z0-9_-]*(?:api[_-]?key|key|token|access[_-]?token|refresh[_-]?token|id[_-]?token|password|passwd|secret|client[_-]?secret|credential)[A-Za-z0-9_-]*["']?\s*[:=]\s*["']?)([^"',\s}\]\[]+)/giu;
const AUTH_FIELD_VALUE_RE = /(^|["'{,\s])(auth["']?\s*[:=]\s*["']?)([^"',\s}\]\[]+)/giu;
const AUTHORIZATION_FIELD_VALUE_RE = /(^|["'{,\s])(authorization["']?\s*[:=]\s*["']?)(?!(?:bearer|basic)\s)([^"',\s}\]\[]+)/giu;
const AUTH_VALUE_RE = /\b((?:authorization\s*:\s*)?(?:bearer|basic)\s+)([\w.\-~+/]+=*)/giu;
const TOKEN_PREFIX_RE = /\b(?:sk-ant-|sk-proj-|sk-|ghp_|github_pat_)[A-Za-z0-9_\-]+/gu;
const URL_USERINFO_RE = /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^@\s/]+)@/giu;

export type ToolExecutionRequest = {
  toolset: ToolsetName;
  input: Record<string, unknown>;
  trustedWorkspace: boolean;
  sessionId: string;
  environmentType?: EnvironmentType;
  excludedTools?: string[];
  providerUsageLineage?: ProviderUsageLineage;
  visionInputProvenance?: VisionInputProvenanceContext;
  visionDispatchPhase?: VisionDispatchPhase;
  signal?: AbortSignal;
  onApprovalRequest?: ToolApprovalHandler;
  onSecureInputRequest?: SecureInputRequestHandler;
};

export type NamedToolExecutionRequest = {
  tool: string;
  input: Record<string, unknown>;
  trustedWorkspace: boolean;
  sessionId: string;
  environmentType?: EnvironmentType;
  toolCallId?: string;
  visibleTurnId?: string;
  providerUsageLineage?: ProviderUsageLineage;
  visionInputProvenance?: VisionInputProvenanceContext;
  visionDispatchPhase?: VisionDispatchPhase;
  toolCallName?: string;
  providerNativeToolCall?: unknown;
  signal?: AbortSignal;
  onEvent?: RuntimeEventSink;
  onApprovalRequest?: ToolApprovalHandler;
  onSecureInputRequest?: SecureInputRequestHandler;
  delegateCallBudget?: DelegateCallBudget;
  readLedger?: ToolReadLedger;
  readLedgerScope?: ToolReadLedgerScope;
  /** Runtime-owned live-state gate; provider input cannot define or bypass it. */
  runtimeAdmissionGuard?: RuntimeToolAdmissionGuard;
};

export type RuntimeToolAdmissionGuard = (input: {
  tool: ToolDefinition;
  input: Readonly<Record<string, unknown>>;
  executionEffect: ToolExecutionEffect | undefined;
}) => { reason: string; code: string } | undefined;

export type ToolReadLedgerScope = {
  profileId: string;
  sessionId: string;
};

export type ToolReadLedger = {
  reuse(input: {
    scope: ToolReadLedgerScope;
    tool: ToolDefinition;
    input: Record<string, unknown>;
    toolCallId?: string;
  }): ToolResult | undefined;
  observe(input: {
    scope: ToolReadLedgerScope;
    execution: ToolExecutionRecord;
  }): void;
};

export type ToolExecutionRecord = {
  /** Executor-owned link to a successful equivalent call; never tool-result metadata. */
  completedReplayOf?: string;
  tool: ToolDefinition;
  /** Runtime-derived from trusted registration metadata; never provider input. */
  executionEffect?: ToolExecutionEffect;
  /** Runtime-owned terminal, dispatch, and side-effect classification. */
  settlement?: ToolExecutionSettlement;
  input?: Record<string, unknown>;
  decision: SecurityDecision;
  riskClass: ToolRiskClass;
  targetKey?: string;
  targetSummary?: string;
  result?: ToolResult;
  toolCallId?: string;
  toolCallName?: string;
  providerNativeToolCall?: unknown;
};

export type ToolExecutorOptions = {
  registry: ToolRegistry;
  securityPolicy: SecurityPolicy;
  sessionDb: SessionDB;
  trajectoryRecorder: TrajectoryRecorder;
  workspaceRoot?: string;
  profileId?: string;
  executionCheckpointController?: ExecutionCheckpointJournalController;
  defaultExecutionTimeoutMs?: number;
};

export class ToolExecutor {
  readonly #registry: ToolRegistry;
  readonly #securityPolicy: SecurityPolicy;
  readonly #sessionDb: SessionDB;
  readonly #trajectoryRecorder: TrajectoryRecorder;
  readonly #workspaceRoot: string;
  readonly #profileId: string | undefined;
  readonly #executionCheckpointController: ExecutionCheckpointJournalController | undefined;
  readonly #defaultExecutionTimeoutMs: number;
  readonly #uncertainMutationKeys = new Set<string>();
  readonly #operationLedger = new ExecutionOperationLedger();

  constructor(options: ToolExecutorOptions) {
    this.#registry = options.registry;
    this.#securityPolicy = options.securityPolicy;
    this.#sessionDb = options.sessionDb;
    this.#trajectoryRecorder = options.trajectoryRecorder;
    this.#workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
    this.#profileId = options.profileId;
    this.#executionCheckpointController = options.executionCheckpointController;
    this.#defaultExecutionTimeoutMs = positiveExecutionTimeout(
      options.defaultExecutionTimeoutMs,
      DEFAULT_TOOL_EXECUTION_TIMEOUT_MS
    );
  }

  resetPerTurnBudgets(): void {
    this.#uncertainMutationKeys.clear();
    this.#operationLedger.reset();
  }

  markMutationOutcomeUncertain(tool: string, input: Record<string, unknown>): void {
    this.#uncertainMutationKeys.add(uncertainMutationKey(tool, input));
  }

  async executeFirstAvailable(request: ToolExecutionRequest): Promise<ToolExecutionRecord | undefined> {
    const tools = await this.#availableToolsFor(request.toolset);
    const excludedTools = new Set(request.excludedTools ?? []);
    const tool = tools.find((candidate) => !excludedTools.has(candidate.name));

    if (tool === undefined) {
      return undefined;
    }

    return this.executeTool({
      tool: tool.name,
      input: request.input,
      trustedWorkspace: request.trustedWorkspace,
      sessionId: request.sessionId,
      environmentType: request.environmentType,
      providerUsageLineage: request.providerUsageLineage,
      visionInputProvenance: request.visionInputProvenance,
      visionDispatchPhase: request.visionDispatchPhase,
      signal: request.signal,
      onApprovalRequest: request.onApprovalRequest,
      onSecureInputRequest: request.onSecureInputRequest
    });
  }

  async executeTool(request: NamedToolExecutionRequest): Promise<ToolExecutionRecord | undefined> {
    const tool = this.#registry.get(request.tool);

    if (tool === undefined || !(await tool.isAvailable())) {
      return undefined;
    }

    const protectedInput = protectPlaintextToolArguments(request.input, (tool.protectedArguments ?? []).map((entry) => entry.path));
    if (protectedInput !== undefined) {
      // Drop the native copy too: it can contain the same plaintext arguments.
      request = { ...request, input: protectedInput, providerNativeToolCall: undefined };
    }

    const environmentType = request.environmentType ?? DEFAULT_ENVIRONMENT_TYPE;
    const baseRiskClass = classifyEffectiveRisk(tool, request.input, environmentType);
    const baseExecutionEffect = resolveToolExecutionEffect(tool, baseRiskClass);
    const persistedCall = redactToolCallForPersistence(tool.name, request.input, request.providerNativeToolCall);
    const validationError = validateToolInput(tool, request.input);
    if (validationError !== undefined) {
      const result: ToolResult = {
        ok: false,
        content: `Invalid tool input: ${validationError}`
      };
      const storedResult = redactToolResultForPersistence(truncateToolResultForStorage(result));
      await this.#sessionDb.appendEvent(request.sessionId, {
        kind: "tool-result",
        tool: tool.name,
        result: storedResult,
        toolCallId: request.toolCallId,
        toolCallName: request.toolCallName,
        providerNativeToolCall: persistedCall.providerNativeToolCall
      });

      return {
        tool: toDefinition(tool),
        ...(baseExecutionEffect === undefined ? {} : { executionEffect: baseExecutionEffect }),
        settlement: notStartedSettlement("failed"),
        input: request.input,
        decision: "deny",
        riskClass: baseRiskClass,
        result,
        toolCallId: request.toolCallId,
        toolCallName: request.toolCallName,
        providerNativeToolCall: request.providerNativeToolCall
      };
    }

    let securityResolution: ToolSecurityResolution | undefined;
    try {
      securityResolution = await tool.resolveSecurity?.(request.input, {
        toolCallId: request.toolCallId,
        visibleTurnId: request.visibleTurnId,
        providerUsageLineage: request.providerUsageLineage,
        visionInputProvenance: request.visionInputProvenance,
        visionDispatchPhase: request.visionDispatchPhase,
        signal: request.signal,
        environmentType,
        onEvent: request.onEvent,
        trustedWorkspace: request.trustedWorkspace,
        sessionId: request.sessionId
      });
    } catch {
      return await this.#blockedSecurityResolution(request, tool, baseRiskClass);
    }
    const riskClass = moreRestrictiveRiskClass(baseRiskClass, securityResolution?.riskClass);
    const executionEffect = resolveToolExecutionEffect(tool, riskClass);
    if (tool.name === "delegate_task" && request.delegateCallBudget !== undefined) {
      const budget = request.delegateCallBudget.tryConsume();
      if (budget.allowed === false) {
        return await this.#blockedDelegateCallLimit(request, tool, riskClass, budget);
      }
    }

    const targetKey = securityResolution?.targetKey ?? await this.#buildSecurityTargetKey(tool.name, request.input);
    const targetSummary = securityResolution?.targetSummary ?? summarizeSecurityTarget(tool.name, request.input);
    const checkpointAtAdmission = this.#activeCheckpoint();
    const durableJournalDeclared = checkpointAtAdmission !== undefined &&
      executionEffect?.kind === "mutation" && executionEffect.connector !== undefined &&
      tool.operationJournal !== undefined;
    const durableCoordinates = checkpointAtAdmission === undefined
      ? undefined
      : checkpointOperationCoordinates({ tool, effect: executionEffect, value: request.input });
    const durableOperationId = durableCoordinates === undefined
      ? undefined
      : executionCheckpointOperationId(durableCoordinates);
    const durableOperation = durableOperationId === undefined
      ? undefined
      : checkpointAtAdmission?.operations.find((operation) => operation.id === durableOperationId);
    if (
      durableOperation !== undefined &&
      (durableOperation.status === "dispatched" || durableOperation.status === "uncertain") &&
      executionEffect !== undefined
    ) {
      return await this.#blockedUncertainMutationReplay(
        request,
        tool,
        riskClass,
        executionEffect,
        targetKey,
        targetSummary,
        durableOperation.status
      );
    }
    if (
      durableOperation !== undefined &&
      (durableOperation.status === "settled" || durableOperation.status === "verified") &&
      executionEffect !== undefined
    ) {
      return await this.#blockedCompletedMutationReplay(
        request,
        tool,
        riskClass,
        executionEffect,
        targetKey,
        targetSummary,
        durableOperation.status
      );
    }
    const mutationReplayKey = !durableJournalDeclared && durableCoordinates === undefined && executionEffect?.kind === "mutation"
      ? uncertainMutationKey(tool.name, request.input)
      : undefined;
    if (
      mutationReplayKey !== undefined &&
      executionEffect !== undefined &&
      this.#uncertainMutationKeys.has(mutationReplayKey)
    ) {
      return await this.#blockedUncertainMutationReplay(
        request,
        tool,
        riskClass,
        executionEffect,
        targetKey,
        targetSummary
      );
    }
    const completedMutation = (
      durableCoordinates === undefined &&
      executionEffect?.kind === "mutation" &&
      executionEffect.connector !== undefined &&
      request.visibleTurnId !== undefined
    )
      ? this.#operationLedger.admission({
          tool: tool.name,
          value: request.input,
          scope: request.visibleTurnId
        })
      : undefined;
    if (
      completedMutation !== undefined && executionEffect !== undefined &&
      (completedMutation.status === "verification-required" || completedMutation.status === "verified")
    ) {
      return await this.#blockedCompletedMutationReplay(
        request,
        tool,
        riskClass,
        executionEffect,
        targetKey,
        targetSummary,
        completedMutation.status,
        completedMutation.mutationCallId
      );
    }
    const persistedTargetKey = redactPersistedString(targetKey);
    const persistedTargetSummary = redactPersistedString(targetSummary);
    const securityRequest = {
      riskClass,
      toolName: tool.name,
      targetKey: persistedTargetKey,
      targetSummary: persistedTargetSummary,
      command: typeof request.input.command === "string" ? request.input.command : undefined,
      environmentType,
      description: `run tool ${tool.name}`,
      context: {
        trustedWorkspace: request.trustedWorkspace,
        targetConversationIsActive: true,
        ...(securityResolution?.dataEgress === undefined
          ? {}
          : { dataEgress: securityResolution.dataEgress })
      }
    };
    let assessment = await assessSecurityPolicy(this.#securityPolicy, securityRequest);
    await this.#recordSecurityAssessment(request.sessionId, tool.name, riskClass, persistedTargetKey, persistedTargetSummary, assessment);

    if (assessment.decision === "ask" && request.onApprovalRequest !== undefined && !isAbortSignalAborted(request.signal)) {
      let operatorDecision: Awaited<ReturnType<ToolApprovalHandler>> = "denied";
      try {
        operatorDecision = await request.onApprovalRequest({
          tool: toDefinition(tool),
          input: structuredClone(request.input),
          riskClass,
          targetKey: persistedTargetKey,
          targetSummary: persistedTargetSummary,
          toolCallId: request.toolCallId,
          toolCallName: request.toolCallName
        });
      } catch {
        operatorDecision = "denied";
      }

      if (operatorDecision === "approved" && !isAbortSignalAborted(request.signal)) {
        assessment = await assessSecurityPolicy(this.#securityPolicy, securityRequest);
        await this.#recordSecurityAssessment(request.sessionId, tool.name, riskClass, persistedTargetKey, persistedTargetSummary, assessment);
        if (assessment.decision === "ask") {
          assessment = {
            ...assessment,
            decision: "deny",
            reason: "The approval did not authorize this exact tool call."
          };
        }
      } else {
        assessment = {
          ...assessment,
          decision: "deny",
          reason: isAbortSignalAborted(request.signal)
            ? "Tool approval was cancelled before execution."
            : "Tool approval was denied by the operator."
        };
      }
    }

    const decision = assessment.decision;

    if (decision !== "allow") {
      await this.#sessionDb.appendEvent(request.sessionId, {
        kind: "tool-gated",
        tool: tool.name,
        decision,
        riskClass
      });
      this.#trajectoryRecorder.record("tool-gated", {
        tool: tool.name,
        decision,
        riskClass
      });

      return {
        tool: toDefinition(tool),
        ...(executionEffect === undefined ? {} : { executionEffect }),
        settlement: notStartedSettlement("failed"),
        input: request.input,
        decision,
        riskClass,
        targetKey,
        targetSummary,
        toolCallId: request.toolCallId,
        toolCallName: request.toolCallName,
        providerNativeToolCall: request.providerNativeToolCall
      };
    }

    const runtimeBlocker = request.runtimeAdmissionGuard?.({
      tool: toDefinition(tool),
      input: request.input,
      executionEffect
    });
    if (runtimeBlocker !== undefined) {
      return await this.#blockedRuntimeAdmission(
        request,
        tool,
        riskClass,
        executionEffect,
        targetKey,
        targetSummary,
        runtimeBlocker
      );
    }

    if (durableJournalDeclared && durableCoordinates === undefined) {
      return await this.#blockedUncertainMutationReplay(
        request,
        tool,
        riskClass,
        executionEffect!,
        targetKey,
        targetSummary,
        "journal-unavailable"
      );
    }

    if (durableCoordinates !== undefined && durableOperationId !== undefined) {
      const current = this.#activeCheckpoint();
      if (current !== undefined) {
        let planned;
        try {
          planned = await this.#executionCheckpointController?.planOperation(current.revision, durableCoordinates);
        } catch {
          planned = undefined;
        }
        if (!planned?.operations.some((operation) => operation.id === durableOperationId && operation.status === "planned")) {
          return await this.#blockedUncertainMutationReplay(
            request,
            tool,
            riskClass,
            executionEffect!,
            targetKey,
            targetSummary,
            "journal-unavailable"
          );
        }
      }
    }

    await this.#sessionDb.appendEvent(request.sessionId, {
      kind: "tool-called",
      tool: tool.name,
      input: persistedCall.input,
      toolCallId: request.toolCallId,
      toolCallName: request.toolCallName,
      providerNativeToolCall: persistedCall.providerNativeToolCall
    });
    this.#trajectoryRecorder.record("tool-call", {
      tool: tool.name,
      input: persistedCall.input
    });

    let result: ToolResult;
    let settlement: ToolExecutionSettlement;
    const definition = toDefinition(tool);
    const reusableResult = request.readLedger === undefined || request.readLedgerScope === undefined
      ? undefined
      : request.readLedger.reuse({
          scope: request.readLedgerScope,
          tool: definition,
          input: request.input,
          toolCallId: request.toolCallId
        });

    if (request.signal?.aborted === true) {
      result = {
        ok: false,
        content: "Tool execution cancelled.",
        metadata: settlementMetadata("cancelled", "not_started", "none")
      };
      settlement = notStartedSettlement("cancelled");
    } else if (reusableResult !== undefined) {
      result = reusableResult;
      settlement = {
        terminalStatus: reusableResult.ok ? "completed" : "failed",
        dispatchState: "not_started",
        sideEffectState: "none"
      };
    } else {
      const timeoutMs = positiveExecutionTimeout(tool.executionTimeoutMs, this.#defaultExecutionTimeoutMs);
      const timeout = createTimeoutSignal({
        timeoutMs,
        parentSignal: request.signal,
        timeoutMessage: `Tool execution timed out after ${timeoutMs}ms.`
      });
      let dispatchState: ToolExecutionSettlement["dispatchState"] = "not_started";
      const executionContext = {
        sessionId: request.sessionId,
        profileId: this.#profileId,
        toolCallId: request.toolCallId,
        visibleTurnId: request.visibleTurnId,
        providerUsageLineage: request.providerUsageLineage,
        visionInputProvenance: request.visionInputProvenance,
        visionDispatchPhase: request.visionDispatchPhase,
        securityResolution,
        signal: timeout.signal,
        environmentType,
        onEvent: request.onEvent,
        onApprovalRequest: tool.name === "execute_code" ? request.onApprovalRequest : undefined,
        onSecureInputRequest: request.onSecureInputRequest
      };
      const running = runToolWithProtectedArguments(tool, request.input, executionContext, {
        beforeDispatch: async () => {
          if (durableOperationId !== undefined) {
            const current = this.#activeCheckpoint();
            const dispatched = current === undefined
              ? undefined
              : await this.#executionCheckpointController?.dispatchOperation(current.revision, durableOperationId);
            if (!dispatched?.operations.some((operation) =>
              operation.id === durableOperationId && operation.status === "dispatched"
            )) throw new Error("Durable operation dispatch could not be journaled.");
          }
          dispatchState = "started";
        },
        afterDispatch: () => {
          dispatchState = "finished";
        }
      });
      try {
        result = await awaitWithAbort(
          running,
          timeout.signal
        );
        settlement = {
          terminalStatus: result.ok ? "completed" : "failed",
          dispatchState,
          sideEffectState: executionEffect?.kind !== "mutation"
            ? "none"
            : result.ok ? "confirmed" : dispatchState === "not_started" ? "none" : "possible"
        };
      } catch (error) {
        const terminalStatus = timeout.timedOut()
          ? "timed_out"
          : timeout.signal.aborted ? "cancelled" : "failed";
        if (
          (terminalStatus === "timed_out" || terminalStatus === "cancelled") &&
          tool.executionAbortSettlementGraceMs !== undefined
        ) {
          await waitForExecutionSettlement(running, tool.executionAbortSettlementGraceMs);
        }
        const sideEffectState = executionEffect?.kind === "mutation" && dispatchState !== "not_started"
          ? "possible"
          : "none";
        settlement = {
          terminalStatus,
          dispatchState,
          sideEffectState,
          ...(terminalStatus === "timed_out" ? { timeoutMs } : {})
        };
        if (terminalStatus === "timed_out") {
          result = timeoutToolResult(settlement);
        } else if (terminalStatus === "cancelled") {
          result = {
            ok: false,
            content: "Tool execution cancelled.",
            metadata: settlementMetadata("cancelled", dispatchState, sideEffectState)
          };
        } else {
          const message = error instanceof Error ? error.message : "Unknown error";
          result = {
            ok: false,
            content: `Tool execution failed: ${message}`,
            metadata: settlementMetadata("error", dispatchState, sideEffectState)
          };
        }
      } finally {
        timeout.cleanup();
      }
    }

    if (mutationReplayKey !== undefined && settlement.sideEffectState === "possible") {
      this.#uncertainMutationKeys.add(mutationReplayKey);
    }

    if (durableOperationId !== undefined) {
      const status = settlement.sideEffectState === "possible"
        ? "uncertain" as const
        : result.ok && settlement.dispatchState === "finished"
          ? "settled" as const
          : "failed" as const;
      const current = this.#activeCheckpoint();
      if (current !== undefined) {
        await this.#executionCheckpointController?.settleOperation(current.revision, durableOperationId, status);
      }
    }

    const checkpoint = this.#activeCheckpoint();
    if (checkpoint !== undefined) {
      const verification = checkpointVerificationMatch({
        tool,
        effect: executionEffect,
        value: request.input,
        result,
        operations: checkpoint.operations
      });
      if (verification !== undefined) {
        await this.#executionCheckpointController?.verifyOperation(
          checkpoint.revision,
          verification.operationId,
          verification.outcome
        ).catch(() => undefined);
      }
      const facts = checkpointSafeFactsFromResult({
        tool,
        result,
        observedAt: new Date().toISOString()
      });
      if (facts.length > 0) {
        const latest = this.#activeCheckpoint();
        if (latest !== undefined) {
          await this.#executionCheckpointController?.retainFacts(latest.revision, facts).catch(() => undefined);
        }
      }
      // Parallel connector results can advance the journal while this receipt is
      // being retained. Rebase only the evidence; never redispatch the tool.
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const latest = this.#activeCheckpoint();
        if (latest === undefined) break;
        try {
          await this.#executionCheckpointController?.retainResources(latest.revision, checkpointResourcesFromResult({
            checkpoint: latest, tool, result, observedAt: new Date().toISOString(), operationId: durableOperationId,
            acceptedInput: request.input
          }));
          break;
        } catch (error) {
          if (!(error instanceof ExecutionCheckpointConflictError)) break;
        }
      }
    }

    const storedResult = redactToolResultForPersistence(truncateToolResultForStorage(result));
    await this.#sessionDb.appendEvent(request.sessionId, {
      kind: "tool-result",
      tool: tool.name,
      result: storedResult,
      toolCallId: request.toolCallId,
      toolCallName: request.toolCallName,
      providerNativeToolCall: persistedCall.providerNativeToolCall
    });
    await this.#sessionDb.appendMessage({
      sessionId: request.sessionId,
      role: "tool",
      content: storedResult.content,
      metadata: {
        tool: tool.name,
        tool_call_id: request.toolCallId,
        tool_call_name: request.toolCallName,
        provider_native_tool_call: persistedCall.providerNativeToolCall,
        ok: result.ok,
        truncated: storedResult.metadata?.truncatedForStorage,
        ...contextSummaryMetadata(storedResult.metadata)
      }
    });
    this.#trajectoryRecorder.record("tool-result", {
      tool: tool.name,
      result: storedResult
    });

    const execution: ToolExecutionRecord = {
      tool: definition,
      ...(executionEffect === undefined ? {} : { executionEffect }),
      settlement,
      input: request.input,
      decision,
      riskClass,
      targetKey,
      targetSummary,
      result,
      toolCallId: request.toolCallId,
      toolCallName: request.toolCallName,
      providerNativeToolCall: request.providerNativeToolCall
    };
    if (request.visibleTurnId !== undefined) {
      this.#operationLedger.observe(execution, request.visibleTurnId);
    }
    if (request.readLedger !== undefined && request.readLedgerScope !== undefined) {
      request.readLedger.observe({
        scope: request.readLedgerScope,
        execution
      });
    }
    return execution;
  }

  #activeCheckpoint() {
    const checkpoint = this.#executionCheckpointController?.current();
    return checkpoint !== undefined && !isTerminalCheckpointStatus(checkpoint.status)
      ? checkpoint
      : undefined;
  }

  getToolDefinition(name: string): ToolDefinition | undefined {
    const tool = this.#registry.get(name);

    return tool === undefined ? undefined : toDefinition(tool);
  }

  getToolExecutionConcurrency(
    name: string,
    input: Record<string, unknown>,
    sessionId: string
  ): ToolExecutionConcurrency | undefined {
    const declaration = this.#registry.get(name)?.executionConcurrency;
    if (declaration === undefined) return undefined;

    try {
      const resourceKey = declaration.resourceKey(input, { sessionId }).trim();
      return {
        mode: declaration.mode,
        resourceKey: resourceKey.length === 0 ? "runtime:unresolved-exclusive-resource" : resourceKey
      };
    } catch {
      // A trusted resolver failure must reduce concurrency rather than expose shared state to a race.
      return {
        mode: declaration.mode,
        resourceKey: "runtime:unresolved-exclusive-resource"
      };
    }
  }

  async #recordSecurityAssessment(
    sessionId: string,
    toolName: string,
    riskClass: ToolRiskClass,
    targetKey: string | undefined,
    targetSummary: string | undefined,
    assessment: Awaited<ReturnType<typeof assessSecurityPolicy>>
  ): Promise<void> {
    await this.#sessionDb.appendEvent(sessionId, {
      kind: "security-assessed",
      tool: toolName,
      riskClass,
      targetKey,
      targetSummary,
      assessment
    });
    this.#trajectoryRecorder.record("progress", {
      message: `security assessed for ${toolName}`,
      tool: toolName,
      decision: assessment.decision,
      mode: assessment.mode,
      reason: assessment.reason,
      riskClass
    });
  }

  async #availableToolsFor(toolset: ToolsetName) {
    const tools = this.#registry.getRegisteredByToolset(toolset);
    const available = [];

    for (const tool of tools) {
      if (await tool.isAvailable()) {
        available.push(tool);
      }
    }

    return available;
  }

  async #buildSecurityTargetKey(toolName: string, input: Record<string, unknown>): Promise<string | undefined> {
    const canonicalRoot = await realpath(this.#workspaceRoot).catch(() => this.#workspaceRoot);

    if (toolName === "terminal.run" || toolName === "process.start") {
      if (typeof input.command !== "string") {
        return undefined;
      }

      const command = normalizeCommandKey(input.command);
      const executable = extractExecutable(command);
      return `${toolName}:cwd=${normalizePathKey(canonicalRoot)}:exec=${executable}:cmd=${command}`;
    }

    if (toolName.startsWith("file.")) {
      const rawPath = typeof input.path === "string"
        ? input.path
        : typeof input.file_path === "string"
          ? input.file_path
          : undefined;
      if (rawPath === undefined) {
        return undefined;
      }

      const allowMissingLeaf = toolName === "file.write";
      const canonicalTarget = await canonicalWorkspaceTarget(this.#workspaceRoot, canonicalRoot, rawPath, { allowMissingLeaf });
      return canonicalTarget === undefined
        ? `${toolName}:path:${normalizePathKey(rawPath)}`
        : `${toolName}:path:${normalizePathKey(canonicalTarget)}`;
    }

    if (typeof input.url === "string") {
      return `${toolName}:url:${normalizeUrlKey(input.url)}`;
    }

    if (typeof input.path === "string") {
      return `${toolName}:path:${normalizePathKey(input.path)}`;
    }

    if (typeof input.file_path === "string") {
      return `${toolName}:path:${normalizePathKey(input.file_path)}`;
    }

    return undefined;
  }

  async #blockedDelegateCallLimit(
    request: NamedToolExecutionRequest,
    tool: import("../contracts/tool.js").RegisteredTool,
    riskClass: ToolRiskClass,
    budget: { limit: number; skippedCount: number; used: number }
  ): Promise<ToolExecutionRecord> {
    const result: ToolResult = {
      ok: false,
      content: `delegate_task call skipped because this provider turn reached maxDelegateCallsPerTurn (${budget.limit}).`,
      metadata: {
        reason: "delegate-call-limit",
        status: "skipped",
        limit: budget.limit,
        skippedCount: budget.skippedCount,
        used: budget.used
      }
    };
    const persistedCall = redactToolCallForPersistence(tool.name, request.input, request.providerNativeToolCall);
    await this.#sessionDb.appendEvent(request.sessionId, {
      kind: "tool-result",
      tool: tool.name,
      result,
      toolCallId: request.toolCallId,
      toolCallName: request.toolCallName,
      providerNativeToolCall: persistedCall.providerNativeToolCall
    });
    await this.#sessionDb.appendMessage({
      sessionId: request.sessionId,
      role: "tool",
      content: result.content,
      metadata: {
        tool: tool.name,
        tool_call_id: request.toolCallId,
        tool_call_name: request.toolCallName,
        provider_native_tool_call: persistedCall.providerNativeToolCall,
        ok: false,
        reason: "delegate-call-limit",
        skippedCount: budget.skippedCount,
        limit: budget.limit
      }
    });

    return {
      tool: toDefinition(tool),
      ...executionEffectProperty(tool, riskClass),
      settlement: notStartedSettlement("failed"),
      input: request.input,
      decision: "deny",
      riskClass,
      result,
      toolCallId: request.toolCallId,
      toolCallName: request.toolCallName,
      providerNativeToolCall: request.providerNativeToolCall
    };
  }

  async #blockedUncertainMutationReplay(
    request: NamedToolExecutionRequest,
    tool: import("../contracts/tool.js").RegisteredTool,
    riskClass: ToolRiskClass,
    executionEffect: ToolExecutionEffect,
    targetKey: string | undefined,
    targetSummary: string | undefined,
    operationStatus: "dispatched" | "uncertain" | "journal-unavailable" = "uncertain"
  ): Promise<ToolExecutionRecord> {
    const unavailable = operationStatus === "journal-unavailable";
    const verifierAvailable = !unavailable && await this.#hasReliableVerifier(tool.name, executionEffect);
    const result: ToolResult = {
      ok: false,
      content: [
        unavailable
          ? `Tool execution blocked: ${tool.name} could not be recorded in the bounded operation journal.`
          : `Tool execution blocked: ${tool.name} matches a mutation whose outcome is ${operationStatus}.`,
        unavailable
          ? "No external mutation was dispatched. Retry after durable checkpoint storage is available."
          : verifierAvailable
            ? "Verify the destination state with a registered verifier before attempting another mutation."
            : "No reliable verifier or idempotency mechanism is registered. Do not retry this mutation automatically."
      ].join("\n"),
      metadata: {
        ...settlementMetadata(unavailable ? "operation-journal-unavailable" : "uncertain-mutation-replay", "not_started", "none"),
        operationStatus
      }
    };
    const persistedCall = redactToolCallForPersistence(tool.name, request.input, request.providerNativeToolCall);
    const storedResult = redactToolResultForPersistence(result);
    await this.#sessionDb.appendEvent(request.sessionId, {
      kind: "tool-gated",
      tool: tool.name,
      decision: "deny",
      riskClass
    });
    await this.#sessionDb.appendEvent(request.sessionId, {
      kind: "tool-result",
      tool: tool.name,
      result: storedResult,
      toolCallId: request.toolCallId,
      toolCallName: request.toolCallName,
      providerNativeToolCall: persistedCall.providerNativeToolCall
    });
    await this.#sessionDb.appendMessage({
      sessionId: request.sessionId,
      role: "tool",
      content: storedResult.content,
      metadata: {
        tool: tool.name,
        tool_call_id: request.toolCallId,
        tool_call_name: request.toolCallName,
        provider_native_tool_call: persistedCall.providerNativeToolCall,
        ok: false,
        reason: unavailable ? "operation-journal-unavailable" : "uncertain-mutation-replay"
      }
    });
    this.#trajectoryRecorder.record("tool-gated", {
      tool: tool.name,
      decision: "deny",
      riskClass,
      reason: unavailable ? "operation-journal-unavailable" : "uncertain-mutation-replay",
      operationStatus
    });
    return {
      tool: toDefinition(tool),
      executionEffect,
      settlement: notStartedSettlement("failed"),
      input: request.input,
      decision: "deny",
      riskClass,
      targetKey,
      targetSummary,
      result,
      toolCallId: request.toolCallId,
      toolCallName: request.toolCallName,
      providerNativeToolCall: request.providerNativeToolCall
    };
  }

  async #blockedRuntimeAdmission(
    request: NamedToolExecutionRequest,
    tool: import("../contracts/tool.js").RegisteredTool,
    riskClass: ToolRiskClass,
    executionEffect: ToolExecutionEffect | undefined,
    targetKey: string | undefined,
    targetSummary: string | undefined,
    blocker: { reason: string; code: string }
  ): Promise<ToolExecutionRecord> {
    const result: ToolResult = {
      ok: false,
      content: blocker.reason,
      metadata: {
        ...settlementMetadata(blocker.code, "not_started", "none"),
        runtimeAdmissionBlocked: true
      }
    };
    const persistedCall = redactToolCallForPersistence(tool.name, request.input, request.providerNativeToolCall);
    const storedResult = redactToolResultForPersistence(result);
    await this.#sessionDb.appendEvent(request.sessionId, {
      kind: "tool-gated",
      tool: tool.name,
      decision: "deny",
      riskClass
    });
    await this.#sessionDb.appendEvent(request.sessionId, {
      kind: "tool-result",
      tool: tool.name,
      result: storedResult,
      toolCallId: request.toolCallId,
      toolCallName: request.toolCallName,
      providerNativeToolCall: persistedCall.providerNativeToolCall
    });
    await this.#sessionDb.appendMessage({
      sessionId: request.sessionId,
      role: "tool",
      content: storedResult.content,
      metadata: {
        tool: tool.name,
        tool_call_id: request.toolCallId,
        tool_call_name: request.toolCallName,
        provider_native_tool_call: persistedCall.providerNativeToolCall,
        ok: false,
        reason: blocker.code
      }
    });
    this.#trajectoryRecorder.record("tool-gated", {
      tool: tool.name,
      decision: "deny",
      riskClass,
      reason: blocker.code
    });
    return {
      tool: toDefinition(tool),
      ...(executionEffect === undefined ? {} : { executionEffect }),
      settlement: notStartedSettlement("failed"),
      input: request.input,
      decision: "deny",
      riskClass,
      targetKey,
      targetSummary,
      result,
      toolCallId: request.toolCallId,
      toolCallName: request.toolCallName,
      providerNativeToolCall: request.providerNativeToolCall
    };
  }

  async #blockedCompletedMutationReplay(
    request: NamedToolExecutionRequest,
    tool: import("../contracts/tool.js").RegisteredTool,
    riskClass: ToolRiskClass,
    executionEffect: ToolExecutionEffect,
    targetKey: string | undefined,
    targetSummary: string | undefined,
    operationStatus: "verification-required" | "settled" | "verified",
    completedReplayOf?: string
  ): Promise<ToolExecutionRecord> {
    const verifierAvailable = operationStatus !== "verified" && await this.#hasReliableVerifier(tool.name, executionEffect, false);
    const nextAction = operationStatus === "verified"
      ? "Continue from the verified result instead of repeating the mutation."
      : verifierAvailable
        ? "Use a registered independent verification tool before deciding whether any corrective mutation is needed."
        : "No available readback tool with a reviewed verification relationship was found. Do not repeat this successful mutation automatically; report the missing verification separately.";
    const result: ToolResult = {
      ok: false,
      content: [
        `Tool execution skipped: the equivalent ${tool.name} mutation already succeeded (${operationStatus}). No new write was dispatched.`,
        nextAction
      ].join("\n"),
      metadata: {
        ...settlementMetadata("completed-mutation-replay", "not_started", "none"),
        operationStatus
      }
    };
    const persistedCall = redactToolCallForPersistence(tool.name, request.input, request.providerNativeToolCall);
    const storedResult = redactToolResultForPersistence(result);
    await this.#sessionDb.appendEvent(request.sessionId, {
      kind: "tool-gated",
      tool: tool.name,
      decision: "deny",
      riskClass
    });
    await this.#sessionDb.appendEvent(request.sessionId, {
      kind: "tool-result",
      tool: tool.name,
      result: storedResult,
      toolCallId: request.toolCallId,
      toolCallName: request.toolCallName,
      providerNativeToolCall: persistedCall.providerNativeToolCall
    });
    await this.#sessionDb.appendMessage({
      sessionId: request.sessionId,
      role: "tool",
      content: storedResult.content,
      metadata: {
        tool: tool.name,
        tool_call_id: request.toolCallId,
        tool_call_name: request.toolCallName,
        provider_native_tool_call: persistedCall.providerNativeToolCall,
        ok: false,
        reason: "completed-mutation-replay",
        operation_status: operationStatus
      }
    });
    this.#trajectoryRecorder.record("tool-gated", {
      tool: tool.name,
      decision: "deny",
      riskClass,
      reason: "completed-mutation-replay",
      operationStatus
    });
    return {
      tool: toDefinition(tool),
      executionEffect,
      ...(completedReplayOf === undefined ? {} : { completedReplayOf }),
      settlement: notStartedSettlement("failed"),
      input: request.input,
      decision: "deny",
      riskClass,
      targetKey,
      targetSummary,
      result,
      toolCallId: request.toolCallId,
      toolCallName: request.toolCallName,
      providerNativeToolCall: request.providerNativeToolCall
    };
  }

  async #hasReliableVerifier(mutationTool: string, effect: ToolExecutionEffect, requireJournalParser = true): Promise<boolean> {
    if (effect.connector === undefined) return false;
    for (const definition of this.#registry.list()) {
      const candidate = this.#registry.get(definition.name);
      if (
        candidate?.connector?.id !== effect.connector.id ||
        candidate.connector.kind !== effect.connector.kind ||
        candidate.capabilityMetadata?.verification?.verifies.includes(mutationTool) !== true ||
        (requireJournalParser && candidate.operationJournal?.verify === undefined)
      ) continue;
      try {
        if (await candidate.isAvailable()) return true;
      } catch {
        // An unavailable or failing verifier cannot make a retry safe.
      }
    }
    return false;
  }

  async #blockedSecurityResolution(
    request: NamedToolExecutionRequest,
    tool: import("../contracts/tool.js").RegisteredTool,
    riskClass: ToolRiskClass
  ): Promise<ToolExecutionRecord> {
    const targetSummary = "dynamic tool security preflight failed";
    const assessment = {
      decision: "deny" as const,
      mode: "strict" as const,
      reason: "Tool security preflight failed closed before execution.",
      risk: "high" as const,
      deterministicRule: "tool-security-preflight-failed",
      assessor: { used: false as const, status: "disabled" as const }
    };
    await this.#sessionDb.appendEvent(request.sessionId, {
      kind: "security-assessed",
      tool: tool.name,
      riskClass,
      targetSummary,
      assessment
    });
    await this.#sessionDb.appendEvent(request.sessionId, {
      kind: "tool-gated",
      tool: tool.name,
      decision: "deny",
      riskClass
    });
    this.#trajectoryRecorder.record("tool-gated", {
      tool: tool.name,
      decision: "deny",
      riskClass
    });
    return {
      tool: toDefinition(tool),
      ...executionEffectProperty(tool, riskClass),
      settlement: notStartedSettlement("failed"),
      input: request.input,
      decision: "deny",
      riskClass,
      targetSummary,
      toolCallId: request.toolCallId,
      toolCallName: request.toolCallName,
      providerNativeToolCall: request.providerNativeToolCall
    };
  }
}

async function runToolWithProtectedArguments(
  tool: import("../contracts/tool.js").RegisteredTool,
  input: Record<string, unknown>,
  context: ToolExecutionContext,
  lifecycle: {
    beforeDispatch(): void | Promise<void>;
    afterDispatch(): void;
  }
): Promise<ToolResult> {
  const declarations = tool.protectedArguments ?? [];
  // Some trusted core tools own their protected-input collection internally.
  // Declaration matching applies only to the generic argument-injection path.
  if (declarations.length === 0) return await dispatchTool(tool, input, context, lifecycle);
  const envelopes = findProtectedArgumentEnvelopes(input);
  const protectedArguments: Array<{
    declaration: (typeof declarations)[number];
    pointer: string;
    envelope: Record<string, unknown>;
  }> = [];
  for (const candidate of envelopes) {
    const matches = declarations.filter((declaration) =>
      matchesProtectedArgumentPattern(declaration.path, candidate.pointer, input)
    );
    if (matches.length !== 1) {
      return protectedArgumentFailure(matches.length === 0
        ? `Protected tool argument ${candidate.pointer} is not declared.`
        : `Protected tool argument ${candidate.pointer} matches more than one declaration.`);
    }
    protectedArguments.push({ declaration: matches[0]!, pointer: candidate.pointer, envelope: candidate.envelope });
  }
  if (protectedArguments.length === 0) return await dispatchTool(tool, input, context, lifecycle);
  if (context.onSecureInputRequest === undefined) {
    return protectedArgumentFailure("Protected tool arguments are unavailable on this runtime.");
  }

  const prepared = protectedArguments.map(({ declaration, pointer, envelope }) => ({
    declaration,
    pointer,
    descriptor: parseProtectedArgumentDescriptor(envelope, tool.name, pointer),
  }));
  if (prepared.some((entry) => entry.descriptor === undefined)) {
    return protectedArgumentFailure("Protected tool argument metadata is invalid.");
  }
  const protectedCapability = tool.capabilityMetadata?.protectedInput;
  if (protectedCapability === undefined) {
    return protectedArgumentFailure("Protected tool argument capability metadata is unavailable.");
  }
  if (prepared.some((entry) => entry.descriptor!.source !== undefined) &&
    !protectedCapability.sources.includes("browser")) {
    return protectedArgumentFailure("Protected browser-source relay is not supported by this tool.");
  }

  if (prepared.length > 1) {
    if (!protectedCapability.groupedDelivery) {
      return protectedArgumentFailure("Grouped protected tool argument delivery is not supported by this tool.");
    }
    const sourceCount = prepared.filter((entry) => entry.descriptor!.source !== undefined).length;
    if (sourceCount !== 0 && sourceCount !== prepared.length) {
      return protectedArgumentFailure("Use either user input for every grouped value or verified browser sources for every value; mixed groups are not supported.");
    }
    const handler = context.onSecureInputRequest as Partial<SecureInputTransferRequestHandler>;
    const transferGroup = sourceCount === 0 ? handler.collectGroup : handler.transferGroup;
    if (transferGroup === undefined) {
      return protectedArgumentFailure("Grouped protected tool argument delivery is unavailable on this runtime.");
    }
    let dispatchedResult: ToolResult | undefined;
    const receipt = await transferGroup({
      purpose: `Transfer ${prepared.length} protected values to ${tool.name}`,
      items: prepared.map((entry, index) => ({
        id: `argument-${index + 1}`,
        source: entry.descriptor!.source!,
        request: {
          kind: entry.descriptor!.kind,
          purpose: entry.descriptor!.purpose,
          retention: "use-once",
          destination: protectedArgumentDestination(tool.name, entry.declaration, entry.pointer),
        },
        handling: entry.declaration.handling,
      })),
    }, async (values) => {
      if (values.length !== prepared.length) throw new Error("Protected tool argument group was incomplete.");
      const dispatchedInput = structuredClone(input);
      const decoded: string[] = [];
      try {
        for (const [index, entry] of prepared.entries()) {
          const value = values.find((candidate) => candidate.id === `argument-${index + 1}`);
          if (value === undefined) throw new Error("Protected tool argument group was incomplete.");
          const secret = new TextDecoder("utf-8", { fatal: true }).decode(value.value);
          decoded.push(secret);
          setAtProtectedArgumentPointer(dispatchedInput, entry.pointer, secret);
        }
        dispatchedResult = redactExactSecrets(await dispatchTool(tool, dispatchedInput, {
          ...context,
          onSecureInputRequest: undefined,
        }, lifecycle), decoded);
      } catch {
        throw new Error("Protected tool argument dispatch failed.");
      }
    }).catch(() => undefined);
    if (receipt?.status !== "delivered" || dispatchedResult === undefined) {
      return protectedArgumentFailure(receipt === undefined
        ? "Protected tool argument group delivery failed."
        : receipt.failure?.code === "protected-source-validation"
          ? receipt.reason ?? "Protected source validation failed."
          : `Protected tool argument group ${receipt.status}: ${receipt.reason ?? "delivery did not complete."}`,
      receipt?.failure);
    }
    // Keep only the reviewed receipt projection. Arbitrary destination echoes
    // may contain transformations of credentials that exact redaction cannot identify.
    const facts = dispatchedResult.metadata?._estacoda_continuity_facts
      ?.filter((fact) => !fact.value.includes("[PROTECTED_INPUT]")).slice(0, 24);
    const content = dispatchedResult.ok
      ? `${prepared.length} protected values transferred atomically. Verify the destination state with a separate read.${facts?.length ? `\nDestination receipt: ${JSON.stringify(facts)}` : ""}`
      : "The protected destination reported that the grouped transfer did not complete.";
    return {
      ok: dispatchedResult.ok,
      content,
      metadata: { protectedTransfer: true, protectedValueCount: prepared.length,
        ...(facts?.length ? { _estacoda_continuity_facts: facts } : {}),
        _estacoda_context_summary: content
      },
    };
  }

  const [{ declaration, pointer, descriptor: parsedDescriptor }] = prepared;
  const descriptor = parsedDescriptor!;
  let dispatchedResult: ToolResult | undefined;
  const destination = protectedArgumentDestination(tool.name, declaration, pointer);
  const request = {
    kind: descriptor.kind,
    purpose: descriptor.purpose,
    retention: "use-once",
    destination
  } as const;
  const consume = async (value: Uint8Array) => {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(value);
    const dispatchedInput = structuredClone(input);
    setAtProtectedArgumentPointer(dispatchedInput, pointer, decoded);
    try {
      dispatchedResult = redactExactSecret(await dispatchTool(tool, dispatchedInput, {
        ...context,
        onSecureInputRequest: undefined
      }, lifecycle), decoded);
    } catch {
      throw new Error("Protected tool argument dispatch failed.");
    }
  };
  const transfer = (context.onSecureInputRequest as Partial<SecureInputTransferRequestHandler>).transfer;
  const receipt = await (descriptor.source === undefined
    ? context.onSecureInputRequest(request, consume)
    : transfer === undefined
      ? Promise.resolve(undefined)
      : transfer({ source: descriptor.source, request, handling: declaration.handling }, consume)
  ).catch(() => undefined);

  if (receipt?.status !== "delivered" || dispatchedResult === undefined) {
    return protectedArgumentFailure(receipt === undefined
      ? "Protected tool argument delivery failed."
      : receipt.failure?.code === "protected-source-validation"
        ? receipt.reason ?? "Protected source validation failed."
        : `Protected tool argument ${receipt.status}: ${receipt.reason ?? "delivery did not complete."}`,
    receipt?.failure);
  }
  if (descriptor.source !== undefined) {
    return {
      ok: dispatchedResult.ok,
      content: dispatchedResult.ok
        ? `Protected value transferred to ${receipt.destinationLabel}. Verify the destination state with a separate read.`
        : "The protected destination reported that the transfer did not complete.",
      metadata: { protectedTransfer: true },
    };
  }
  return dispatchedResult;
}

async function dispatchTool(
  tool: import("../contracts/tool.js").RegisteredTool,
  input: Record<string, unknown>,
  context: ToolExecutionContext,
  lifecycle: {
    beforeDispatch(): void | Promise<void>;
    afterDispatch(): void;
  }
): Promise<ToolResult> {
  throwIfAborted(context.signal);
  await lifecycle.beforeDispatch();
  try {
    return await tool.run(input, context);
  } finally {
    lifecycle.afterDispatch();
  }
}

function protectedArgumentDestination(
  toolName: string,
  declaration: import("../contracts/tool.js").ProtectedToolArgumentDeclaration,
  pointer: string
) {
  return declaration.destination === undefined
    ? { type: "tool-argument" as const, toolName, argumentPath: pointer }
    : {
        type: "mcp-argument" as const,
        serverId: declaration.destination.serverId,
        toolName: declaration.destination.toolName,
        argumentPath: pointer,
      };
}

function parseProtectedArgumentDescriptor(
  value: Record<string, unknown>,
  toolName: string,
  argumentPath: string
): { kind: SecureInputKind; purpose: string; source?: BrowserFieldSecureInputSource } | undefined {
  if (!SECURE_INPUT_KINDS.has(value.kind as SecureInputKind)) return undefined;
  if (value.retention !== undefined && value.retention !== "use-once") return undefined;
  const purpose = typeof value.purpose === "string" && value.purpose.trim().length > 0 && value.purpose.length <= 500
    ? value.purpose.trim()
    : `Provide protected argument ${argumentPath} to ${toolName}`;
  const source = value.source === undefined ? undefined : parseProtectedBrowserSource(value.source);
  if (value.source !== undefined && source === undefined) return undefined;
  return { kind: value.kind as SecureInputKind, purpose, ...(source === undefined ? {} : { source }) };
}

function parseProtectedBrowserSource(value: unknown): BrowserFieldSecureInputSource | undefined {
  if (!isObjectRecord(value) || value.type !== "browser-field" || !isSafeMetadata(value.sessionId) ||
      typeof value.ref !== "string" || !/^@e\d+$/u.test(value.ref) || !isObjectRecord(value.identity) ||
      !isBrowserIdentity(value.identity) || !isSafeMetadata(value.tabRef) || typeof value.expectedOrigin !== "string") {
    return undefined;
  }
  let expectedOrigin: string;
  try {
    const parsed = new URL(value.expectedOrigin);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.origin !== value.expectedOrigin) return undefined;
    expectedOrigin = parsed.origin;
  } catch {
    return undefined;
  }
  if (value.frameId !== undefined && !isSafeMetadata(value.frameId)) return undefined;
  return {
    type: "browser-field",
    sessionId: value.sessionId,
    ref: value.ref,
    identity: {
      documentEpoch: value.identity.documentEpoch,
      actionRevision: value.identity.actionRevision,
      observationId: value.identity.observationId,
    },
    expectedOrigin,
    tabRef: value.tabRef,
    ...(typeof value.frameId === "string" ? { frameId: value.frameId } : {}),
  };
}

function isBrowserIdentity(value: Record<string, unknown>): value is Record<string, unknown> & {
  documentEpoch: number;
  actionRevision: number;
  observationId: number;
} {
  return [value.documentEpoch, value.actionRevision, value.observationId]
    .every((entry) => typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0);
}

function isSafeMetadata(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001F\u007F]/u.test(value);
}

function redactExactSecret(result: ToolResult, secret: string): ToolResult {
  if (secret.length === 0) return result;
  return replaceExactSecret(result, secret) as ToolResult;
}

function redactExactSecrets(result: ToolResult, secrets: readonly string[]): ToolResult {
  return secrets.reduce((current, secret) => {
    const variants = new Set([secret, Buffer.from(secret).toString("base64"), Buffer.from(secret).toString("base64url"),
      Buffer.from(secret).toString("hex"), encodeURIComponent(secret)]);
    return [...variants].reduce((value, variant) => redactExactSecret(value, variant), current);
  }, result);
}

function replaceExactSecret(value: unknown, secret: string): unknown {
  if (typeof value === "string") return value.split(secret).join("[PROTECTED_INPUT]");
  if (Array.isArray(value)) return value.map((entry) => replaceExactSecret(entry, secret));
  if (!isObjectRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replaceExactSecret(entry, secret)]));
}

function protectedArgumentFailure(
  content: string,
  sourceFailure?: SecureInputProtectedSourceFailure
): ToolResult {
  return {
    ok: false,
    content,
    metadata: {
      reason: "protected-tool-argument-unavailable",
      ...(sourceFailure === undefined ? {} : { protectedSourceFailure: structuredClone(sourceFailure) })
    }
  };
}

const SECURE_INPUT_KINDS = new Set<SecureInputKind>([
  "account-identifier", "password", "one-time-code", "api-key", "client-secret", "access-token",
  "private-key", "recovery-code", "generic-secret"
]);

function isAbortSignalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function positiveExecutionTimeout(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(2_147_483_647, Math.floor(value))
    : fallback;
}

function notStartedSettlement(
  terminalStatus: ToolExecutionSettlement["terminalStatus"]
): ToolExecutionSettlement {
  return {
    terminalStatus,
    dispatchState: "not_started",
    sideEffectState: "none"
  };
}

function settlementMetadata(
  reason: string,
  dispatchState: ToolExecutionSettlement["dispatchState"],
  sideEffectState: ToolExecutionSettlement["sideEffectState"],
  timeoutMs?: number
): NonNullable<ToolResult["metadata"]> {
  return {
    reason,
    terminalStatus: reason === "timeout" ? "timed_out" : reason === "cancelled" ? "cancelled" : "failed",
    dispatchState,
    sideEffectState,
    ...(timeoutMs === undefined ? {} : { timeoutMs })
  };
}

function timeoutToolResult(settlement: ToolExecutionSettlement): ToolResult {
  const possibleSideEffect = settlement.sideEffectState === "possible";
  return {
    ok: false,
    content: possibleSideEffect
      ? "Tool execution timed out after the mutation started. Its outcome is uncertain; do not retry it automatically. Verify the destination state first."
      : settlement.dispatchState === "not_started"
        ? "Tool execution timed out before dispatch. No side effect was started; the call may be retried."
        : "Tool execution timed out without a side effect. The call may be retried if it is still needed.",
    metadata: settlementMetadata(
      "timeout",
      settlement.dispatchState,
      settlement.sideEffectState,
      settlement.timeoutMs
    )
  };
}

async function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortReason(signal);
  return await new Promise<T>((resolvePromise, rejectPromise) => {
    const onAbort = () => rejectPromise(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolvePromise, rejectPromise).finally(() => {
      signal.removeEventListener("abort", onAbort);
    }).catch(() => undefined);
  });
}

async function waitForExecutionSettlement(promise: Promise<unknown>, graceMs: number): Promise<void> {
  const boundedGraceMs = Math.min(10_000, Math.max(0, Math.floor(graceMs)));
  if (boundedGraceMs === 0) return;
  await Promise.race([
    promise.then(() => undefined, () => undefined),
    new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, boundedGraceMs);
    })
  ]);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Tool execution aborted.");
}

function uncertainMutationKey(
  tool: string,
  input: Record<string, unknown>
): string {
  return semanticMutationKey(tool, input);
}

function classifyEffectiveRisk(
  tool: ToolDefinition,
  input: Record<string, unknown>,
  environmentType: EnvironmentType = DEFAULT_ENVIRONMENT_TYPE
): ToolRiskClass {
  if ((tool.name === "terminal.run" || tool.name === "process.start") && typeof input.command === "string") {
    const assessment = assessCommandSafety(input.command, { environmentType });
    if (assessment.riskClass !== undefined) {
      return assessment.riskClass;
    }
  }

  return tool.riskClass;
}

function moreRestrictiveRiskClass(
  base: ToolRiskClass,
  dynamic: ToolRiskClass | undefined
): ToolRiskClass {
  if (dynamic === undefined) return base;
  return toolRiskRank(dynamic) > toolRiskRank(base) ? dynamic : base;
}

function toolRiskRank(value: ToolRiskClass): number {
  switch (value) {
    case "read-only-local": return 0;
    case "read-only-network": return 1;
    case "workspace-write": return 2;
    case "shared-state-mutation": return 3;
    case "external-side-effect": return 4;
    case "credential-access": return 5;
    case "destructive-local": return 6;
    case "spend-money": return 7;
    case "sandbox-escape": return 8;
  }
}

function validateToolInput(tool: ToolDefinition, input: Record<string, unknown>): string | undefined {
  if (containsProtectedInputPlaintextConflict(input)) {
    return "protected input cannot include a plaintext 'text' value";
  }
  const schema = tool.inputSchema;
  if (!isObjectRecord(schema)) {
    return undefined;
  }

  const required = Array.isArray(schema.required)
    ? schema.required.filter((entry): entry is string => typeof entry === "string")
    : [];
  for (const key of required) {
    if (!(key in input)) {
      return `missing required field '${key}'`;
    }
  }

  const properties = isObjectRecord(schema.properties) ? schema.properties : {};
  for (const [key, value] of Object.entries(input)) {
    const property = properties[key];
    if (!isObjectRecord(property) || !("type" in property)) {
      continue;
    }

    const expected = property.type;
    if (typeof expected !== "string") {
      continue;
    }

    if (!matchesJsonSchemaPrimitive(value, expected)) {
      return `field '${key}' must be ${expected}`;
    }
  }

  return undefined;
}

function matchesJsonSchemaPrimitive(value: unknown, expected: string): boolean {
  switch (expected) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return isObjectRecord(value);
    case "array":
      return Array.isArray(value);
    default:
      return true;
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncateToolResultForStorage(result: ToolResult): ToolResult {
  if (result.content.length <= MAX_STORED_TOOL_RESULT_CHARS) {
    return result;
  }

  return {
    ...result,
    content: `${result.content.slice(0, MAX_STORED_TOOL_RESULT_CHARS)}\n[truncated ${result.content.length - MAX_STORED_TOOL_RESULT_CHARS} chars before session storage]`,
    metadata: {
      ...result.metadata,
      truncatedForStorage: true,
      originalChars: result.content.length
    }
  };
}

function toDefinition(tool: ToolDefinition): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    riskClass: tool.riskClass,
    toolsets: [...tool.toolsets],
    connector: tool.connector === undefined ? undefined : { ...tool.connector },
    progressLabel: tool.progressLabel,
    maxResultSizeChars: tool.maxResultSizeChars,
    requiredConfig: tool.requiredConfig === undefined ? undefined : [...tool.requiredConfig]
  };
}

function executionEffectProperty(
  tool: import("../contracts/tool.js").RegisteredTool,
  riskClass: ToolRiskClass
): { executionEffect?: ToolExecutionEffect } {
  const executionEffect = resolveToolExecutionEffect(tool, riskClass);
  return executionEffect === undefined ? {} : { executionEffect };
}

export const summarizeSecurityTarget = buildToolSecurityTargetSummary;

function redactToolCallForPersistence(
  toolName: string,
  input: Record<string, unknown>,
  providerNativeToolCall: unknown
): {
  input: Record<string, unknown>;
  providerNativeToolCall: unknown;
} {
  return {
    input: redactToolInputForPersistence(toolName, input),
    providerNativeToolCall: redactProviderNativeToolCallForPersistence(toolName, providerNativeToolCall)
  };
}

function redactToolInputForPersistence(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  const redacted = redactValue(input) as Record<string, unknown>;
  return redactCdpInputForPersistence(toolName, redacted);
}

function redactToolResultForPersistence(result: ToolResult): ToolResult {
  return {
    ...result,
    content: redactPersistedText(result.content),
    metadata: result.metadata === undefined ? undefined : redactValue(result.metadata) as ToolResult["metadata"]
  };
}

function contextSummaryMetadata(metadata: ToolResult["metadata"] | undefined): {
  _estacoda_context_summary?: string;
} {
  const summary = metadata?._estacoda_context_summary;
  if (typeof summary !== "string") {
    return {};
  }
  const trimmed = summary.trim();
  if (trimmed.length === 0) {
    return {};
  }
  return {
    _estacoda_context_summary: truncate(trimmed, MAX_CONTEXT_SUMMARY_CHARS)
  };
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return redactPersistedText(value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }
  if (isProtectedInputEnvelope(value)) {
    return redactProtectedInputEnvelope(value);
  }
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    if (isProtectedInputEnvelope(val)) {
      result[key] = redactProtectedInputEnvelope(val);
    } else if (SENSITIVE_KEY_RE.test(key)) {
      result[key] = REDACTED_SECRET_VALUE;
    } else if (typeof val === "object" && val !== null) {
      result[key] = redactValue(val);
    } else if (typeof val === "string") {
      result[key] = redactPersistedText(val);
    } else {
      result[key] = val;
    }
  }
  return result;
}

function containsProtectedInputPlaintextConflict(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsProtectedInputPlaintextConflict);
  if (!isObjectRecord(value)) return false;
  if (isObjectRecord(value.protectedInput) && typeof value.text === "string") return true;
  return Object.values(value).some(containsProtectedInputPlaintextConflict);
}

function isProtectedInputEnvelope(value: unknown): value is Record<string, unknown> & {
  protectedInput: Record<string, unknown>;
} {
  return isObjectRecord(value) && isObjectRecord(value.protectedInput);
}

function redactProtectedInputEnvelope(value: Record<string, unknown> & {
  protectedInput: Record<string, unknown>;
}): Record<string, unknown> {
  const metadata = value.protectedInput;
  return {
    ...(typeof value.ref === "string" ? { ref: redactPersistedText(value.ref) } : {}),
    protectedInput: {
      ...(typeof metadata.kind === "string" ? { kind: redactPersistedText(metadata.kind) } : {}),
      ...(typeof metadata.purpose === "string" ? { purpose: redactPersistedText(metadata.purpose) } : {}),
      ...(typeof metadata.retention === "string" ? { retention: redactPersistedText(metadata.retention) } : {})
    }
  };
}

function redactProviderNativeToolCallForPersistence(toolName: string, value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }
  return redactProviderNativeValue(toolName, value);
}

function redactProviderNativeValue(toolName: string, value: unknown): unknown {
  if (typeof value === "string") {
    return redactPersistedText(value);
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactProviderNativeValue(toolName, entry));
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isProviderArgumentKey(key)) {
      result[key] = redactProviderArgumentPayload(toolName, entry);
    } else if (SENSITIVE_KEY_RE.test(key)) {
      result[key] = REDACTED_SECRET_VALUE;
    } else {
      result[key] = redactProviderNativeValue(toolName, entry);
    }
  }
  return result;
}

function isProviderArgumentKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return normalized === "arguments" || normalized === "args";
}

function redactProviderArgumentPayload(toolName: string, value: unknown): unknown {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (isObjectRecord(parsed)) {
        return JSON.stringify(redactToolInputForPersistence(toolName, parsed));
      }
      return JSON.stringify(redactValue(parsed));
    } catch {
      return REDACTED_PROVIDER_ARGUMENTS;
    }
  }

  if (isObjectRecord(value)) {
    return redactToolInputForPersistence(toolName, value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry));
  }

  return redactValue(value);
}

function redactCdpInputForPersistence(toolName: string, input: Record<string, unknown>): Record<string, unknown> {
  if (toolName !== "browser.cdp" || !isObjectRecord(input.params) || typeof input.method !== "string") {
    return input;
  }

  if (input.method === "Runtime.evaluate") {
    return {
      ...input,
      params: redactRuntimeExpressionFields(input.params, ["expression"])
    };
  }

  if (input.method === "Runtime.callFunctionOn") {
    return {
      ...input,
      params: redactRuntimeExpressionFields(input.params, ["functionDeclaration", "expression"])
    };
  }

  return input;
}

function redactRuntimeExpressionFields(params: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const result = { ...params };
  for (const key of keys) {
    if (typeof result[key] === "string") {
      result[key] = REDACTED_CDP_EXPRESSION;
    }
  }
  return result;
}

function redactPersistedString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return redactPersistedText(value);
}

function redactPersistedText(value: string): string {
  return value
    .replace(URL_USERINFO_RE, (_match, protocol: string) => `${protocol}${REDACTED_SECRET_VALUE}:${REDACTED_SECRET_VALUE}@`)
    .replace(AUTH_VALUE_RE, (_match, prefix: string) => `${prefix}${REDACTED_SECRET_VALUE}`)
    .replace(SENSITIVE_QUERY_PARAM_VALUE_RE, (_match, boundary: string, prefix: string) => `${boundary}${prefix}${REDACTED_SECRET_VALUE}`)
    .replace(SENSITIVE_FIELD_VALUE_RE, (_match, boundary: string, prefix: string) => `${boundary}${prefix}${REDACTED_SECRET_VALUE}`)
    .replace(AUTH_FIELD_VALUE_RE, (_match, boundary: string, prefix: string) => `${boundary}${prefix}${REDACTED_SECRET_VALUE}`)
    .replace(AUTHORIZATION_FIELD_VALUE_RE, (_match, boundary: string, prefix: string) => `${boundary}${prefix}${REDACTED_SECRET_VALUE}`)
    .replace(TOKEN_PREFIX_RE, REDACTED_SECRET_VALUE);
}

function normalizeCommandKey(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function normalizePathKey(value: string): string {
  const normalized = value.trim().replace(/\/+/gu, "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function normalizeUrlKey(value: string): string {
  return value.trim();
}

function extractExecutable(command: string): string {
  const [head = "unknown"] = command.split(/\s+/u);
  return head;
}

async function canonicalWorkspaceTarget(
  configuredRoot: string,
  canonicalRoot: string,
  rawPath: string,
  options: { allowMissingLeaf?: boolean } = {}
): Promise<string | undefined> {
  const candidate = isAbsolute(rawPath) ? resolve(rawPath) : resolve(configuredRoot, rawPath);
  if (!isWithinAnyRoot([configuredRoot, canonicalRoot], candidate)) {
    return undefined;
  }

  try {
    const resolved = await realpath(candidate);
    return isWithinRoot(canonicalRoot, resolved) ? resolved : undefined;
  } catch {
    if (options.allowMissingLeaf !== true) {
      return undefined;
    }

    try {
      const resolvedParent = await realpath(dirname(candidate));
      const finalTarget = resolve(resolvedParent, basename(candidate));
      return isWithinRoot(canonicalRoot, finalTarget) ? finalTarget : undefined;
    } catch {
      return undefined;
    }
  }
}

function isWithinRoot(root: string, candidate: string): boolean {
  const diff = relative(root, candidate);
  return diff === "" || (!diff.startsWith("..") && !isAbsolute(diff));
}

function isWithinAnyRoot(roots: string[], candidate: string): boolean {
  return roots.some((root) => isWithinRoot(root, candidate));
}
