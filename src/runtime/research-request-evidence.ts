import { verifiedFileOutputContent } from "./file-output-evidence.js";
import { groundForegroundResearch } from "../tasks/research-result-evidence.js";
import { readTaskResultEvidence } from "../tasks/task-result-read-evidence.js";
import type { IntentRoute, RequestRequirements } from "../contracts/intent.js";
import type { ProviderToolSchemaCatalog } from "../tools/tool-schema.js";
import type { ExecutionEvidenceRecord } from "../contracts/execution-plan.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";

/** Only proven session prerequisites block admission. Unexposed capabilities
 * remain recoverable, and saved Task results do not require fresh search. */
export function researchPrerequisiteBlockers(intent: Pick<IntentRoute, "requestRequirements" | "skillRequests">, catalog?: ProviderToolSchemaCatalog): string[] {
  const requirements = intent.requestRequirements;
  if (requirements?.research === undefined) return [];
  const blockers: string[] = [];
  if (intent.skillRequests?.some((request) => request.status === "unavailable")) {
    blockers.push("Requested research skill instructions are unavailable in this session. Check the selected profile's skill visibility and the installed bundled skills before retrying.");
  }
  if (requirements.research.fresh && requirements.sourceTaskId === undefined && catalog !== undefined &&
    !catalog.entries.some((entry) => entry.tool.name === "web.search")) {
    blockers.push("web.search is unavailable in this session. Review and verify a search provider through Web Research setup (config.web.setup), then retry. Direct URL extraction cannot satisfy the requested fresh-search evidence.");
  }
  return blockers;
}

export function researchRequestEvidence(input: {
  finalText?: string;
  requestRequirements?: RequestRequirements;
  toolExecutions: readonly ToolExecutionRecord[];
  executionReceipts: readonly ExecutionEvidenceRecord[];
  skillRequirementsSatisfied?: boolean;
  delegatedAnswerOwned?: boolean;
}): { satisfied: boolean; missing: string[]; partialResearch?: boolean; groundedText?: string } {
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
  const missing: string[] = requirements.issues.includes("request-too-long") ? ["request-requirements-exceed-bound"] : [];
  const sourceResult = requirements.sourceTaskId === undefined ? undefined : readTaskResultEvidence(observed, requirements.sourceTaskId).find((page) => page.primary);
  const settledResearch = sourceResult?.researchComplete === true;
  if (requirements.sourceTaskId !== undefined && sourceResult === undefined) missing.push("accepted-research-result");
  if (requirements.delegation !== undefined && !handoff && !settledResearch) missing.push("requested-worker-evidence");
  if (requirements.research?.fresh && !handoff && !settledResearch && !observed.some((execution) => execution.tool.name === "web.search")) missing.push("live-source-evidence");
  const report = requirements.fileOutput === undefined ? input.finalText : verifiedFileOutputContent({
    requirements, toolExecutions: input.toolExecutions, executionReceipts: input.executionReceipts
  });
  const grounded = requirements.research?.fresh && !handoff && !settledResearch
    ? groundForegroundResearch(report ?? "", observed, new Date()) : undefined;
  if (grounded?.failure !== undefined) missing.push(requirements.fileOutput !== undefined && report === undefined ? "verified-report-content-missing" : grounded.failure);
  if (requirements.skillReferences.length > 0 && input.skillRequirementsSatisfied !== true) missing.push("requested-skill-instructions");
  return { satisfied: missing.length === 0, missing, ...(grounded?.text === undefined || requirements.fileOutput !== undefined ? {} : { groundedText: grounded.text }), ...(sourceResult?.researchComplete === false ? { partialResearch: true } : {}) };
}
