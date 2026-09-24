import { readTaskResultEvidence } from "../tasks/task-result-read-evidence.js";
import type { RequestRequirements } from "../contracts/intent.js";
import type { ExecutionEvidenceRecord } from "../contracts/execution-plan.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";

export function researchRequestEvidence(input: {
  requestRequirements?: RequestRequirements;
  toolExecutions: readonly ToolExecutionRecord[];
  executionReceipts: readonly ExecutionEvidenceRecord[];
  skillRequirementsSatisfied?: boolean;
  delegatedAnswerOwned?: boolean;
}): { satisfied: boolean; missing: string[]; partialResearch?: boolean } {
  const requirements = input.requestRequirements;
  if (requirements === undefined) return { satisfied: true, missing: [] };
  const observed = input.toolExecutions.filter((execution) => execution.decision === "allow" && execution.result?.ok === true &&
    input.executionReceipts.some((receipt) => receipt.toolCallId === execution.toolCallId && receipt.tool === execution.tool.name &&
      (receipt.status === "success" || (receipt.status === "ineligible" && receipt.tool === "delegate_task")) &&
      (requirements.originTurnId === undefined || receipt.visibleTurnId === requirements.originTurnId)));
  const admitted = observed.some((execution) => {
    const metadata = execution.result?.metadata;
    const ids = metadata?.workerStepIds;
    return execution.tool.name === "delegate_task" && metadata?.requestContractAccepted === true && metadata.childTask === false &&
      Array.isArray(ids) && ids.length > 0 && ids.every((id) => typeof id === "string") && new Set(ids).size === ids.length &&
      !(typeof metadata.primaryResultStepId === "string" && ids.includes(metadata.primaryResultStepId)) &&
      (requirements.delegation?.count === undefined || ids.length === requirements.delegation.count);
  });
  const handoff = input.delegatedAnswerOwned === true && admitted;
  const missing: string[] = [];
  const sourceResult = requirements.sourceTaskId === undefined ? undefined : readTaskResultEvidence(observed, requirements.sourceTaskId).find((page) => page.primary);
  const settledResearch = sourceResult?.researchComplete === true;
  if (requirements.sourceTaskId !== undefined && sourceResult === undefined) missing.push("accepted-research-result");
  if (requirements.delegation !== undefined && !handoff && !settledResearch) missing.push("requested-worker-evidence");
  if (requirements.research?.fresh && !handoff && !settledResearch && !observed.some((execution) => execution.tool.name === "web.search")) missing.push("live-source-evidence");
  if (requirements.skillReferences.length > 0 && input.skillRequirementsSatisfied !== true && !settledResearch) missing.push("requested-skill-instructions");
  return { satisfied: missing.length === 0, missing, ...(sourceResult?.researchComplete === false ? { partialResearch: true } : {}) };
}
