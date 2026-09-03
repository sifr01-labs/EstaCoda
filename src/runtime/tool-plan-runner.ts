import type { RuntimeEvent, RuntimeEventSink } from "../contracts/runtime-event.js";
import type { ToolApprovalHandler, ToolDefinition, ToolExecutionConcurrency, ToolRiskClass } from "../contracts/tool.js";
import type { SecureInputRequestHandler } from "../contracts/secure-input.js";
import type { ProviderUsageLineage } from "../contracts/provider-usage.js";
import type { VisionInputProvenanceContext } from "../contracts/vision.js";
import type { ToolCallPlan } from "../contracts/tool-plan.js";
import type { FileChangePreviewViewModel } from "../contracts/view-model.js";
import type { ProviderExecutionResult } from "../providers/provider-executor.js";
import type { ToolCallPlanner } from "../tools/tool-call-planner.js";
import type {
  ToolExecutor,
  ToolExecutionRecord,
  ToolReadLedger,
  ToolReadLedgerScope,
  RuntimeToolAdmissionGuard
} from "../tools/tool-executor.js";
import { summarizeSecurityTarget } from "../tools/tool-executor.js";
import { buildToolDisplayPreview } from "../tools/tool-target-summary.js";
import { packetizeToolExecution } from "../tools/tool-result-packet.js";
import { DelegateCallBudget } from "../delegation/delegate-call-budget.js";
import type { RunRecorder } from "./run-recorder.js";
import type { SessionRuntimeContext } from "./session-runtime-context.js";
import type { ExecutionEvidenceIndex } from "./execution-evidence-index.js";
import { emit } from "../utils/runtime-helpers.js";

export type ToolPlanRunnerOptions = {
  toolCallPlanner: ToolCallPlanner | undefined;
  toolExecutor: ToolExecutor;
  runRecorder: RunRecorder;
  sessionId: string;
  sessionRuntimeContext?: SessionRuntimeContext;
  maxConcurrentSafeTools: number;
  delegateTaskCallLimit?: number;
  executionEvidenceIndex?: ExecutionEvidenceIndex;
};

export class ToolPlanRunner {
  readonly #toolCallPlanner: ToolCallPlanner | undefined;
  readonly #toolExecutor: ToolExecutor;
  readonly #runRecorder: RunRecorder;
  readonly #sessionId: string;
  readonly #sessionRuntimeContext: SessionRuntimeContext | undefined;
  readonly #maxConcurrentSafeTools: number;
  readonly #delegateCallBudget: DelegateCallBudget | undefined;
  readonly #executionEvidenceIndex: ExecutionEvidenceIndex | undefined;
  readonly #unsettledExecutionResources = new Set<string>();

  constructor(options: ToolPlanRunnerOptions) {
    this.#toolCallPlanner = options.toolCallPlanner;
    this.#toolExecutor = options.toolExecutor;
    this.#runRecorder = options.runRecorder;
    this.#sessionId = options.sessionId;
    this.#sessionRuntimeContext = options.sessionRuntimeContext;
    this.#maxConcurrentSafeTools = options.maxConcurrentSafeTools;
    this.#delegateCallBudget = options.delegateTaskCallLimit === undefined
      ? undefined
      : new DelegateCallBudget(options.delegateTaskCallLimit);
    this.#executionEvidenceIndex = options.executionEvidenceIndex;
  }

  resetPerTurnBudgets(): void {
    this.#delegateCallBudget?.reset();
    this.#unsettledExecutionResources.clear();
    this.#toolExecutor.resetPerTurnBudgets?.();
  }

  async executePlans(input: {
    providerExecution: ProviderExecutionResult | undefined;
    toolPlans: ToolCallPlan[];
    trustedWorkspace: boolean;
    remainingToolCalls: number;
    riskBaseline: ToolRiskClass;
    visibleTurnId?: string;
    providerUsageLineage?: ProviderUsageLineage;
    visionInputProvenance?: VisionInputProvenanceContext;
    signal?: AbortSignal;
    onEvent?: RuntimeEventSink;
    onApprovalRequest?: ToolApprovalHandler;
    onSecureInputRequest?: SecureInputRequestHandler;
    readLedger?: ToolReadLedger;
    readLedgerScope?: ToolReadLedgerScope;
    runtimeAdmissionGuard?: RuntimeToolAdmissionGuard;
    onExecution?: (execution: ToolExecutionRecord) => void | Promise<void>;
  }): Promise<{
    executions: ToolExecutionRecord[];
    maxObservedRisk: ToolRiskClass;
  }> {
    if (this.#toolCallPlanner === undefined || input.providerExecution === undefined) {
      return {
        executions: [],
        maxObservedRisk: input.riskBaseline
      };
    }

    const executions: ToolExecutionRecord[] = [];
    const pending: Array<{
      plan: ToolCallPlan;
      definition: ToolDefinition | undefined;
      concurrency: ToolExecutionConcurrency | undefined;
    }> = [];

    for (const toolCall of input.providerExecution.toolCalls.slice(0, input.remainingToolCalls)) {
      const plan = this.#toolCallPlanner.planFromProviderDelta(toolCall);

      input.toolPlans.push(plan);
      await this.#runRecorder.recordToolPlan(plan);

      if (plan.status !== "planned") {
        if (
          plan.status === "unavailable" &&
          plan.tool.length > 0 &&
          this.#executionEvidenceIndex !== undefined
        ) {
          const receipt = this.#executionEvidenceIndex.recordUnavailable(plan.id, plan.tool, input.visibleTurnId);
          if (receipt !== undefined) await this.#runRecorder.recordExecutionEvidence(receipt);
        }
        await emit(input.onEvent, {
          kind: "tool-result",
          tool: plan.tool.length === 0 ? "provider-tool" : plan.tool,
          ok: false,
          targetSummary: summarizeSecurityTarget(plan.tool, plan.input) ?? plan.error ?? (plan.tool.length === 0 ? "provider-tool" : plan.tool),
          activityId: plan.id
        });
        continue;
      }

      const definition = this.#toolExecutor.getToolDefinition(plan.tool);
      pending.push({
        plan,
        definition,
        concurrency: this.#toolExecutor.getToolExecutionConcurrency?.(
          plan.tool,
          plan.input,
          this.#currentSessionId()
        )
      });
    }

    let maxObservedRisk: ToolRiskClass = input.riskBaseline;
    for (const group of groupProviderToolPlans(pending, this.#maxConcurrentSafeTools)) {
      const nextRisk = maxRiskClass(group.entries.map((entry) => entry.definition?.riskClass));
      if (riskRank(nextRisk) > riskRank(maxObservedRisk)) {
        await this.#runRecorder.recordSecurityRiskEscalation({
          from: maxObservedRisk,
          to: nextRisk,
          onEvent: input.onEvent
        });
        maxObservedRisk = nextRisk;
      }

      if (group.concurrent && !group.entries.some((entry) => entry.definition?.toolsets.includes("mcp") === true)) {
        const groupSettlements = await Promise.allSettled(group.entries.map(async (entry) => {
          if (this.#isExecutionResourceUnsettled(entry.concurrency)) {
            await this.#settleUnsettledExecutionResourcePlan(entry.plan, input.onEvent);
            return undefined;
          }
          return this.#executeProviderToolPlan({
            plan: entry.plan,
            trustedWorkspace: input.trustedWorkspace,
            visibleTurnId: input.visibleTurnId,
            providerUsageLineage: input.providerUsageLineage,
            visionInputProvenance: input.visionInputProvenance,
            signal: input.signal,
            onEvent: input.onEvent,
            onApprovalRequest: input.onApprovalRequest,
            onSecureInputRequest: input.onSecureInputRequest,
            readLedger: input.readLedger,
            readLedgerScope: input.readLedgerScope,
            runtimeAdmissionGuard: input.runtimeAdmissionGuard
          });
        }));

        const completed: ToolExecutionRecord[] = [];
        for (const [index, settled] of groupSettlements.entries()) {
          if (settled.status === "fulfilled") {
            if (settled.value !== undefined) {
              completed.push(settled.value);
              this.#observeExecutionResourceSettlement(
                group.entries[index]!.concurrency,
                settled.value
              );
            }
            continue;
          }
          const entry = group.entries[index]!;
          const execution = await this.#settleRejectedProviderToolPlan(entry, input.onEvent);
          completed.push(execution);
          this.#observeExecutionResourceSettlement(entry.concurrency, execution);
        }
        executions.push(...completed);
        for (const execution of completed) await input.onExecution?.(execution);
        const dynamicRisk = maxRiskClass(completed.map((execution) => execution.riskClass));
        if (riskRank(dynamicRisk) > riskRank(maxObservedRisk)) {
          await this.#runRecorder.recordSecurityRiskEscalation({
            from: maxObservedRisk,
            to: dynamicRisk,
            onEvent: input.onEvent
          });
          maxObservedRisk = dynamicRisk;
        }
        continue;
      }

      for (const { plan, concurrency } of group.entries) {
        if (this.#isExecutionResourceUnsettled(concurrency)) {
          await this.#settleUnsettledExecutionResourcePlan(plan, input.onEvent);
          continue;
        }
        let execution: ToolExecutionRecord | undefined;
        try {
          execution = await this.#executeProviderToolPlan({
            plan,
            trustedWorkspace: input.trustedWorkspace,
            visibleTurnId: input.visibleTurnId,
            providerUsageLineage: input.providerUsageLineage,
            visionInputProvenance: input.visionInputProvenance,
            signal: input.signal,
            onEvent: input.onEvent,
            onApprovalRequest: input.onApprovalRequest,
            onSecureInputRequest: input.onSecureInputRequest,
            readLedger: input.readLedger,
            readLedgerScope: input.readLedgerScope,
            runtimeAdmissionGuard: input.runtimeAdmissionGuard
          });
        } catch {
          execution = await this.#settleRejectedProviderToolPlan(
            { plan, definition: this.#toolExecutor.getToolDefinition(plan.tool), concurrency },
            input.onEvent
          );
        }
        if (execution !== undefined) {
          this.#observeExecutionResourceSettlement(concurrency, execution);
          executions.push(execution);
          await input.onExecution?.(execution);
          if (riskRank(execution.riskClass) > riskRank(maxObservedRisk)) {
            await this.#runRecorder.recordSecurityRiskEscalation({
              from: maxObservedRisk,
              to: execution.riskClass,
              onEvent: input.onEvent
            });
            maxObservedRisk = execution.riskClass;
          }
        }
      }
    }

    return {
      executions,
      maxObservedRisk
    };
  }

  /** Executes one runtime-authored recovery action through normal validation, security, and receipts. */
  async executeInternalTool(input: {
    id: string;
    tool: string;
    value: Record<string, unknown>;
    toolPlans: ToolCallPlan[];
    trustedWorkspace: boolean;
    riskBaseline: ToolRiskClass;
    visibleTurnId?: string;
    providerUsageLineage?: ProviderUsageLineage;
    signal?: AbortSignal;
    onEvent?: RuntimeEventSink;
    onApprovalRequest?: ToolApprovalHandler;
    onSecureInputRequest?: SecureInputRequestHandler;
    runtimeAdmissionGuard?: RuntimeToolAdmissionGuard;
    onExecution?: (execution: ToolExecutionRecord) => void | Promise<void>;
  }): Promise<{ execution?: ToolExecutionRecord; maxObservedRisk: ToolRiskClass }> {
    const definition = this.#toolExecutor.getToolDefinition(input.tool);
    const concurrency = this.#toolExecutor.getToolExecutionConcurrency?.(
      input.tool,
      input.value,
      this.#currentSessionId()
    );
    const plan: ToolCallPlan = {
      id: input.id,
      tool: input.tool,
      input: input.value,
      source: "internal",
      status: definition === undefined ? "unavailable" : "planned",
      ...(definition === undefined ? {} : { riskClass: definition.riskClass })
    };
    input.toolPlans.push(plan);
    await this.#runRecorder.recordToolPlan(plan);
    if (definition === undefined) return { maxObservedRisk: input.riskBaseline };
    if (this.#isExecutionResourceUnsettled(concurrency)) {
      await this.#settleUnsettledExecutionResourcePlan(plan, input.onEvent);
      return { maxObservedRisk: input.riskBaseline };
    }
    let execution: ToolExecutionRecord | undefined;
    try {
      execution = await this.#executeProviderToolPlan({
        plan,
        trustedWorkspace: input.trustedWorkspace,
        visibleTurnId: input.visibleTurnId,
        providerUsageLineage: input.providerUsageLineage,
        signal: input.signal,
        onEvent: input.onEvent,
        onApprovalRequest: input.onApprovalRequest,
        onSecureInputRequest: input.onSecureInputRequest,
        runtimeAdmissionGuard: input.runtimeAdmissionGuard
      });
    } catch {
      execution = await this.#settleRejectedProviderToolPlan({ plan, definition, concurrency }, input.onEvent);
    }
    if (execution !== undefined) this.#observeExecutionResourceSettlement(concurrency, execution);
    if (execution !== undefined) await input.onExecution?.(execution);
    if (execution !== undefined && riskRank(execution.riskClass) > riskRank(input.riskBaseline)) {
      await this.#runRecorder.recordSecurityRiskEscalation({
        from: input.riskBaseline,
        to: execution.riskClass,
        onEvent: input.onEvent
      });
    }
    return {
      ...(execution === undefined ? {} : { execution }),
      maxObservedRisk: execution !== undefined && riskRank(execution.riskClass) > riskRank(input.riskBaseline)
        ? execution.riskClass
        : input.riskBaseline
    };
  }

  async #executeProviderToolPlan(input: {
    plan: ToolCallPlan;
    trustedWorkspace: boolean;
    visibleTurnId?: string;
    providerUsageLineage?: ProviderUsageLineage;
    visionInputProvenance?: VisionInputProvenanceContext;
    signal?: AbortSignal;
    onEvent?: RuntimeEventSink;
    onApprovalRequest?: ToolApprovalHandler;
    onSecureInputRequest?: SecureInputRequestHandler;
    readLedger?: ToolReadLedger;
    readLedgerScope?: ToolReadLedgerScope;
    runtimeAdmissionGuard?: RuntimeToolAdmissionGuard;
  }): Promise<ToolExecutionRecord | undefined> {
    const plan = input.plan;

    await emit(input.onEvent, {
      kind: "tool-start",
      tool: plan.tool,
      targetSummary: summarizeSecurityTarget(plan.tool, plan.input),
      displayPreview: buildToolDisplayPreview(plan.tool, plan.input),
      activityId: plan.id
    });

    const execution = await this.#toolExecutor.executeTool({
      tool: plan.tool,
      input: plan.input,
      trustedWorkspace: input.trustedWorkspace,
      sessionId: this.#currentSessionId(),
      toolCallId: plan.id,
      visibleTurnId: input.visibleTurnId,
      providerUsageLineage: input.providerUsageLineage,
      visionInputProvenance: input.visionInputProvenance,
      toolCallName: plan.tool,
      providerNativeToolCall: plan.raw,
      signal: input.signal,
      onEvent: input.onEvent,
      onApprovalRequest: input.onApprovalRequest,
      onSecureInputRequest: input.onSecureInputRequest,
      delegateCallBudget: this.#delegateCallBudget,
      readLedger: input.readLedger,
      readLedgerScope: input.readLedgerScope,
      runtimeAdmissionGuard: input.runtimeAdmissionGuard
    });

    if (execution === undefined) {
      plan.status = "unavailable";
      plan.error = `Tool is unavailable: ${plan.tool}`;
      await this.#runRecorder.recordToolPlan(plan);
      await this.#runRecorder.recordClassifiedFailure(
        { kind: "tool-plan", plan },
        "tool-execution"
      );
      await emit(input.onEvent, {
        kind: "tool-result",
        tool: plan.tool,
        ok: false,
        targetSummary: summarizeSecurityTarget(plan.tool, plan.input),
        displayPreview: buildToolDisplayPreview(plan.tool, plan.input),
        activityId: plan.id
      });
      if (this.#executionEvidenceIndex !== undefined) {
        const receipt = this.#executionEvidenceIndex.recordUnavailable(plan.id, plan.tool, input.visibleTurnId);
        if (receipt !== undefined) await this.#runRecorder.recordExecutionEvidence(receipt);
      }
      return undefined;
    }

    plan.status = execution.decision === "allow" ? "executed" : "blocked";
    plan.result = execution.result;
    if (execution.decision !== "allow") {
      plan.error = `security decision: ${execution.decision}`;
      await this.#runRecorder.recordClassifiedFailure(
        { kind: "tool-execution", execution },
        "tool-execution"
      );
    } else if (execution.result?.ok === false) {
      await this.#runRecorder.recordClassifiedFailure(
        { kind: "tool-execution", execution },
        "tool-execution"
      );
    }
    await this.#runRecorder.recordToolPlan(plan);
    await emit(input.onEvent, {
      kind: "tool-result",
      tool: execution.tool.name,
      decision: execution.decision,
      riskClass: execution.riskClass,
      ok: execution.result?.ok,
      fileChangePreview: toolResultFileChangePreview(execution),
      targetSummary: execution.targetSummary,
      displayPreview: buildToolDisplayPreview(plan.tool, plan.input),
      activityId: plan.id,
      ...toolResultStats(execution)
    });

    const evidenceRecord = this.#executionEvidenceIndex?.record(execution, input.visibleTurnId);
    if (evidenceRecord !== undefined) {
      await this.#runRecorder.recordExecutionEvidence(evidenceRecord);
    }

    return execution;
  }

  async #settleRejectedProviderToolPlan(
    entry: ProviderToolPlanEntry,
    onEvent: RuntimeEventSink | undefined
  ): Promise<ToolExecutionRecord> {
    const { plan } = entry;
    const tool = entry.definition ?? {
      name: plan.tool,
      description: "Tool execution ended without a settled runtime receipt.",
      inputSchema: {},
      riskClass: plan.riskClass ?? "external-side-effect",
      toolsets: [],
      progressLabel: plan.tool,
      maxResultSizeChars: 1_400
    };
    const consequential = tool.riskClass !== "read-only-local" && tool.riskClass !== "read-only-network";
    const sideEffectState = consequential ? "possible" : "none";
    const result = {
      ok: false,
      content: consequential
        ? "Tool execution ended without a settled runtime receipt. Its outcome is unknown; do not retry it automatically. Verify the destination state first."
        : "Tool execution ended without a settled runtime receipt. The read did not produce an authoritative result and may be retried if it is still needed.",
      metadata: {
        reason: "tool-execution-unknown",
        terminalStatus: "failed",
        dispatchState: "unknown",
        sideEffectState
      }
    } as const;
    const execution: ToolExecutionRecord = {
      tool,
      executionEffect: {
        kind: consequential ? "mutation" : "read",
        ...(tool.connector === undefined ? {} : { connector: { ...tool.connector } })
      },
      settlement: {
        terminalStatus: "failed",
        dispatchState: "unknown",
        sideEffectState
      },
      input: plan.input,
      decision: "allow",
      riskClass: tool.riskClass,
      targetSummary: summarizeSecurityTarget(plan.tool, plan.input),
      result,
      toolCallId: plan.id,
      toolCallName: plan.tool,
      providerNativeToolCall: plan.raw
    };
    if (consequential) {
      this.#toolExecutor.markMutationOutcomeUncertain?.(plan.tool, plan.input);
    }
    plan.status = "executed";
    plan.error = result.content;
    plan.result = result;
    await Promise.allSettled([
      this.#runRecorder.recordToolPlan(plan),
      this.#runRecorder.recordClassifiedFailure(
        { kind: "tool-execution", execution },
        "tool-execution"
      ),
      emit(onEvent, {
        kind: "tool-result",
        tool: plan.tool,
        ok: false,
        targetSummary: summarizeSecurityTarget(plan.tool, plan.input),
        displayPreview: buildToolDisplayPreview(plan.tool, plan.input),
        activityId: plan.id
      })
    ]);
    return execution;
  }

  async #settleUnsettledExecutionResourcePlan(
    plan: ToolCallPlan,
    onEvent: RuntimeEventSink | undefined
  ): Promise<void> {
    plan.status = "blocked";
    plan.error = "A prior call on this exclusive execution resource has not settled. Retry only after the resource is re-established.";
    plan.result = {
      ok: false,
      content: plan.error,
      metadata: {
        reason: "execution-resource-unsettled",
        terminalStatus: "failed",
        dispatchState: "not_started",
        sideEffectState: "none"
      }
    };
    await Promise.allSettled([
      this.#runRecorder.recordToolPlan(plan),
      this.#runRecorder.recordClassifiedFailure(
        { kind: "tool-plan", plan },
        "tool-execution"
      ),
      emit(onEvent, {
        kind: "tool-result",
        tool: plan.tool,
        ok: false,
        targetSummary: summarizeSecurityTarget(plan.tool, plan.input),
        displayPreview: buildToolDisplayPreview(plan.tool, plan.input),
        activityId: plan.id
      })
    ]);
  }

  #isExecutionResourceUnsettled(concurrency: ToolExecutionConcurrency | undefined): boolean {
    return concurrency?.mode === "exclusive" &&
      this.#unsettledExecutionResources.has(concurrency.resourceKey);
  }

  #observeExecutionResourceSettlement(
    concurrency: ToolExecutionConcurrency | undefined,
    execution: ToolExecutionRecord
  ): void {
    if (
      concurrency?.mode !== "exclusive" ||
      (execution.settlement?.dispatchState !== "unknown" && (
        (execution.settlement?.terminalStatus !== "timed_out" &&
          execution.settlement?.terminalStatus !== "cancelled") ||
        execution.settlement.dispatchState !== "started"
      ))
    ) return;
    this.#unsettledExecutionResources.add(concurrency.resourceKey);
  }

  #currentSessionId(): string {
    return this.#sessionRuntimeContext?.currentSessionId() ?? this.#sessionId;
  }
}

export function toolResultStats(execution: ToolExecutionRecord): {
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

export function toolResultFileChangePreview(
  execution: ToolExecutionRecord
): FileChangePreviewViewModel | undefined {
  const candidate = execution.result?.metadata?.fileChangePreview;
  if (!isFileChangePreview(candidate)) {
    return undefined;
  }
  return candidate;
}

function isFileChangePreview(value: unknown): value is FileChangePreviewViewModel {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<FileChangePreviewViewModel>;
  return candidate.kind === "fileChangePreview" &&
    typeof candidate.path === "string" &&
    (candidate.changeType === "added" || candidate.changeType === "modified" || candidate.changeType === "deleted");
}

export function isRecoverableToolPlanStatus(status: ToolCallPlan["status"]): boolean {
  return status === "invalid" || status === "unavailable" || status === "blocked";
}


function maxRiskClass(values: Array<ToolRiskClass | undefined>): ToolRiskClass {
  return values.reduce<ToolRiskClass>((max, value) =>
    value === undefined || riskRank(value) <= riskRank(max) ? max : value, "read-only-local");
}

function riskRank(value: ToolRiskClass): number {
  switch (value) {
    case "read-only-local":
      return 1;
    case "read-only-network":
      return 2;
    case "workspace-write":
      return 3;
    case "shared-state-mutation":
      return 4;
    case "external-side-effect":
      return 5;
    case "credential-access":
      return 6;
    case "destructive-local":
      return 7;
    case "spend-money":
      return 8;
    case "sandbox-escape":
      return 9;
  }
}

function isConcurrentSafeTool(tool: ToolDefinition | undefined): boolean {
  if (tool === undefined) {
    return false;
  }

  return (tool.riskClass === "read-only-local" || tool.riskClass === "read-only-network") &&
    tool.name !== "terminal.run" &&
    tool.name !== "process.start" &&
    tool.name !== "plan";
}

type ProviderToolPlanEntry = {
  plan: ToolCallPlan;
  definition: ToolDefinition | undefined;
  concurrency?: ToolExecutionConcurrency;
};

export function groupProviderToolPlans(
  entries: ProviderToolPlanEntry[],
  maxConcurrentSafeTools: number
): Array<{ concurrent: boolean; entries: ProviderToolPlanEntry[] }> {
  const groups: Array<{ concurrent: boolean; entries: ProviderToolPlanEntry[] }> = [];
  const safeSize = Math.max(1, maxConcurrentSafeTools);
  let safeBatch: ProviderToolPlanEntry[] = [];
  let exclusiveResourceKeys = new Set<string>();

  const flushSafeBatch = () => {
    if (safeBatch.length > 0) {
      groups.push({
        concurrent: true,
        entries: safeBatch
      });
    }
    safeBatch = [];
    exclusiveResourceKeys = new Set<string>();
  };

  for (const entry of entries) {
    if (isConcurrentSafeTool(entry.definition)) {
      const resourceKey = entry.concurrency?.mode === "exclusive"
        ? entry.concurrency.resourceKey
        : undefined;
      if (
        safeBatch.length >= safeSize ||
        (resourceKey !== undefined && exclusiveResourceKeys.has(resourceKey))
      ) {
        flushSafeBatch();
      }
      safeBatch.push(entry);
      if (resourceKey !== undefined) exclusiveResourceKeys.add(resourceKey);
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
