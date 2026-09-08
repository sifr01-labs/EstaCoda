import type {
  SessionUsageInspection,
  TaskUsageInspection,
  TurnUsageInspection,
  UsageInspection
} from "../session/usage-inspector.js";
import { formatUsageCost, formatUsageCostNotice, formatUsdAmount } from "./usage-cost-format.js";

export function formatUsageInspection(inspection: UsageInspection): string {
  if (inspection.scope === "session") return formatSessionUsageInspection(inspection);
  if (inspection.scope === "task") return formatTaskUsageInspection(inspection);
  return formatTurnUsageInspection(inspection);
}

function formatSessionUsageInspection(inspection: SessionUsageInspection): string {
  const usage = inspection.usage;
  const context = inspection.contextWindow;
  const budget = usage.budget;
  return [
    "Usage — current session",
    `Tokens: ${formatCount(usage.totalTokens)}${usage.usageComplete ? "" : " (at least)"}`,
    `Estimated cost: ${formatUsageCost(usage)}`,
    `Provider calls: ${formatCount(usage.providerCalls)}`,
    context === undefined
      ? "Context window: unavailable"
      : `Context window: ${formatCount(context.usedTokens)} / ${formatCount(context.totalTokens)} (${formatPercent(context.usedTokens, context.totalTokens)})`,
    ...(budget === undefined ? [] : [
      `Session budget: ${formatUsdAmount(budget.spentCostUsd)} spent · ${formatUsdAmount(budget.reservedCostUsd)} reserved · ${formatUsdAmount(budget.remainingCostUsd)} remaining`
    ]),
    formatUsageCostNotice(usage),
    "Includes provider usage recorded through the latest settled call."
  ].filter((line): line is string => line !== undefined).join("\n");
}

function formatTurnUsageInspection(inspection: TurnUsageInspection): string {
  const { usage } = inspection;
  return [
    inspection.selection === "replied"
      ? "Usage — replied message"
      : inspection.selection === "specific"
        ? "Usage — selected turn"
        : "Usage — latest completed turn",
    usageLine("Total", usage.total, usage.provisional),
    usageLine("Main agent", usage.mainAgent, false),
    usageLine("Auxiliary models", usage.auxiliaryModels, false),
    usageLine("Delegated work", usage.delegatedWork, usage.provisional),
    turnTaskStatusLine(inspection),
    "As of: latest settled provider call",
    formatUsageCostNotice(usage.total),
    "Delegated Task usage is included in the total; do not add it again."
  ].filter((line): line is string => line !== undefined).join("\n");
}

function formatTaskUsageInspection(inspection: TaskUsageInspection): string {
  const budget = inspection.budget;
  return [
    "Usage — Task",
    `Task: ${inspection.taskId}`,
    `Status: ${inspection.status}`,
    usageLine("Total", inspection.usage, inspection.provisional),
    `Accounting: ${inspection.provisional ? "provisional" : "settled"}`,
    "As of: latest settled provider call",
    ...(budget === undefined ? [] : [
      `Task budget: ${formatUsdAmount(budget.spentCostUsd)} spent · ${formatUsdAmount(budget.reservedCostUsd)} reserved · ${formatUsdAmount(budget.remainingCostUsd)} remaining`
    ]),
    formatUsageCostNotice(inspection.usage),
    "This Task may already be included in its originating turn and session totals."
  ].filter((line): line is string => line !== undefined).join("\n");
}

function turnTaskStatusLine(inspection: TurnUsageInspection): string {
  const tasks = inspection.originatingTasks;
  if (tasks.scanTruncated && tasks.active === 0) {
    return "Status: provisional — originating Task scan was truncated; additional active work may exist";
  }
  if (!inspection.usage.provisional) {
    return tasks.settled === 0
      ? "Status: settled"
      : `Status: settled — ${formatCount(tasks.settled)} originating ${tasks.settled === 1 ? "Task" : "Tasks"} settled`;
  }
  const qualifier = tasks.scanTruncated ? "at least " : "";
  const settled = tasks.settled === 0
    ? ""
    : `; ${formatCount(tasks.settled)} ${tasks.settled === 1 ? "is" : "are"} settled`;
  return `Status: provisional — ${qualifier}${formatCount(tasks.active)} originating ${tasks.active === 1 ? "Task is" : "Tasks are"} still active${settled}`;
}

function usageLine(
  label: string,
  usage: { totalTokens: number; usageComplete: boolean; estimatedCostUsd?: number; costComplete: boolean },
  provisional: boolean
): string {
  const tokenQualifier = usage.usageComplete && !provisional ? "" : "at least ";
  return `${label}: ${tokenQualifier}${formatCount(usage.totalTokens)} tokens · ${formatUsageCost({
    estimatedCostUsd: usage.estimatedCostUsd,
    costComplete: usage.costComplete && !provisional
  })}`;
}

function formatCount(value: number): string {
  return Math.max(0, Math.floor(Number.isFinite(value) ? value : 0)).toLocaleString("en-US");
}

function formatPercent(used: number, total: number): string {
  if (total <= 0) return "unavailable";
  return `${Math.min(100, Math.max(0, (used / total) * 100)).toFixed(1)}%`;
}
