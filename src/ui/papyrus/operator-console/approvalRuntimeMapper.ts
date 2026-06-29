import type { ToolExecutionRecord } from "../../../tools/tool-executor.js";
import type { FileChangePreviewViewModel } from "../../../contracts/view-model.js";
import { buildToolDisplayPreview } from "../../../tools/tool-target-summary.js";
import { toolDisplayLabel, type ToolDisplayLocale } from "../../tool-display.js";
import type { ApprovalCardState } from "./operatorConsoleState.js";

export function approvalCardStateFromToolExecution(
  execution: ToolExecutionRecord,
  input: { readonly id?: string; readonly focused?: boolean; readonly locale?: ToolDisplayLocale } = {}
): ApprovalCardState {
  const diffStats = diffStatsFromExecution(execution);
  const status = execution.decision === "ask" ? "pending" : "rejected";
  return {
    id: input.id ?? approvalIdFromExecution(execution),
    status,
    action: toolDisplayLabel(execution.tool.name, input.locale),
    target: approvalTargetFromExecution(execution),
    risk: execution.riskClass,
    ...(diffStats === undefined ? {} : { diffStats }),
    ...(input.focused === true && status === "pending" ? { focusedControl: "approve" } : {}),
  };
}

function approvalIdFromExecution(execution: ToolExecutionRecord): string {
  return execution.toolCallId ?? execution.targetKey ?? execution.targetSummary ?? execution.tool.name;
}

function approvalTargetFromExecution(execution: ToolExecutionRecord): string {
  return (execution.input === undefined ? undefined : buildToolDisplayPreview(execution.tool.name, execution.input)) ??
    execution.targetSummary ??
    execution.targetKey ??
    execution.tool.description ??
    execution.tool.name;
}

function diffStatsFromExecution(execution: ToolExecutionRecord): ApprovalCardState["diffStats"] | undefined {
  const preview = execution.result?.metadata?.fileChangePreview;
  if (!isFileChangePreview(preview) || preview.diff === undefined) return undefined;
  const added = preview.diff.split("\n").filter((line) =>
    line.startsWith("+") && !line.startsWith("+++")
  ).length;
  const removed = preview.diff.split("\n").filter((line) =>
    line.startsWith("-") && !line.startsWith("---")
  ).length;
  return added === 0 && removed === 0 ? undefined : { added, removed };
}

function isFileChangePreview(value: unknown): value is FileChangePreviewViewModel {
  return typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "fileChangePreview";
}
