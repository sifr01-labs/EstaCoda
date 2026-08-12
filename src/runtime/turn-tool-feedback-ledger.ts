import type { ToolCallPlan } from "../contracts/tool-plan.js";
import type { ToolRiskClass } from "../contracts/tool.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import { redactSensitiveText } from "../utils/redaction.js";

const MAX_CONSUMED_FEEDBACK_SUMMARY_CHARS = 4_000;

export type ToolFeedbackEntry = {
  plan: ToolCallPlan;
  execution?: ToolExecutionRecord;
};

export type ToolFeedbackSummary = {
  callId: string;
  tool: string;
  status: ToolCallPlan["status"];
  ok?: boolean;
  riskClass?: ToolRiskClass;
  targetSummary?: string;
  resultChars: number;
};

export type TurnToolFeedbackLedger = {
  latest: ToolFeedbackEntry[];
  consumed: ToolFeedbackSummary[];
  omittedCount: number;
};

export function createTurnToolFeedbackLedger(): TurnToolFeedbackLedger {
  return {
    latest: [],
    consumed: [],
    omittedCount: 0
  };
}

export function recordTurnToolFeedbackBatch(
  ledger: TurnToolFeedbackLedger,
  plans: readonly ToolCallPlan[],
  executions: readonly ToolExecutionRecord[]
): TurnToolFeedbackLedger {
  if (plans.length === 0) {
    return ledger;
  }

  const newlyConsumed = ledger.latest.map(summarizeFeedbackEntry);
  const consumed = [...ledger.consumed, ...newlyConsumed];
  let omittedCount = ledger.omittedCount;
  while (consumed.length > 0 && estimatedSummaryChars(consumed) > MAX_CONSUMED_FEEDBACK_SUMMARY_CHARS) {
    consumed.shift();
    omittedCount += 1;
  }

  const executionsByCallId = new Map(
    executions
      .filter((execution) => typeof execution.toolCallId === "string")
      .map((execution) => [execution.toolCallId!, execution])
  );

  return {
    latest: plans.map((plan, index) => {
      const positionalExecution = executions[index];
      return {
        plan,
        execution: executionsByCallId.get(plan.id) ?? (
          positionalExecution?.toolCallId === undefined ? positionalExecution : undefined
        )
      };
    }),
    consumed,
    omittedCount
  };
}

function summarizeFeedbackEntry(entry: ToolFeedbackEntry): ToolFeedbackSummary {
  const targetSummary = entry.execution?.targetSummary === undefined
    ? undefined
    : truncate(redactSensitiveText(entry.execution.targetSummary).trim(), 240);
  return {
    callId: entry.plan.id,
    tool: entry.plan.tool || "unknown",
    status: entry.plan.status,
    ...(entry.plan.result === undefined ? {} : { ok: entry.plan.result.ok }),
    ...(entry.execution === undefined ? {} : { riskClass: entry.execution.riskClass }),
    ...(targetSummary === undefined || targetSummary.length === 0 ? {} : { targetSummary }),
    resultChars: entry.plan.result?.content.length ?? 0
  };
}

function estimatedSummaryChars(summaries: readonly ToolFeedbackSummary[]): number {
  return summaries.reduce((sum, summary) => (
    sum + 96 + summary.callId.length + summary.tool.length + (summary.targetSummary?.length ?? 0)
  ), 0);
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
}
