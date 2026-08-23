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
  ToolReadLedgerScope
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
        const groupExecutions = await Promise.all(group.entries.map(async ({ plan }) =>
          this.#executeProviderToolPlan({
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
            readLedgerScope: input.readLedgerScope
          })
        ));

        const completed = groupExecutions.filter((execution) => execution !== undefined);
        executions.push(...completed);
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

      for (const { plan } of group.entries) {
        const execution = await this.#executeProviderToolPlan({
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
          readLedgerScope: input.readLedgerScope
        });
        if (execution !== undefined) {
          executions.push(execution);
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
      readLedgerScope: input.readLedgerScope
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
