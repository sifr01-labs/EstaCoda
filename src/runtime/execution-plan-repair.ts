import {
  EXECUTION_PLAN_MAX_EVIDENCE_CALL_IDS,
  EXECUTION_PLAN_MAX_ID_CHARS,
  EXECUTION_PLAN_MAX_ITEM_CHARS,
  EXECUTION_PLAN_MAX_ITEMS,
  EXECUTION_PLAN_MAX_OBJECTIVE_CHARS,
  EXECUTION_PLAN_MAX_SERIALIZED_BYTES,
  type ExecutionPlanItemStatus,
  type ExecutionPlanWriteInput
} from "../contracts/execution-plan.js";
import { isClearlyReasoningOnlyContent } from "./execution-plan-controller.js";

const ITEM_STATUSES = new Set<ExecutionPlanItemStatus>([
  "pending",
  "in_progress",
  "completed",
  "blocked",
  "cancelled"
]);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u;

export type ExecutionPlanRepair = {
  itemId: string;
  field: "completionKind" | "evidenceCallIds" | "status";
  reason: string;
};

export type ExecutionPlanRepairResult = {
  plan: ExecutionPlanWriteInput;
  repairs: ExecutionPlanRepair[];
};

export function repairExecutionPlanWriteInput(
  input: ExecutionPlanWriteInput
): ExecutionPlanRepairResult | undefined {
  if (!hasRepairableStructure(input)) return undefined;

  const repairs: ExecutionPlanRepair[] = [];
  let retainedInProgress = false;
  const items = input.items.map((item) => {
    let status = item.status ?? "pending";
    let completionKind = item.completionKind;
    let evidenceCallIds = item.evidenceCallIds;

    if (status !== "completed") {
      if (completionKind !== undefined) {
        repairs.push({
          itemId: item.id,
          field: "completionKind",
          reason: "Completion metadata applies only to completed items"
        });
        completionKind = undefined;
      }
      if (evidenceCallIds !== undefined) {
        repairs.push({
          itemId: item.id,
          field: "evidenceCallIds",
          reason: "Completion evidence applies only to completed items"
        });
        evidenceCallIds = undefined;
      }
    } else if (completionKind === "reasoning" && !isClearlyReasoningOnlyContent(item.content)) {
      repairs.push({
        itemId: item.id,
        field: "completionKind",
        reason: "Consequential work requires tool evidence"
      });
      completionKind = undefined;
      if (evidenceCallIds === undefined) {
        status = "pending";
        repairs.push({
          itemId: item.id,
          field: "status",
          reason: "Consequential completion has no harness evidence"
        });
      }
    }

    if (status === "in_progress") {
      if (retainedInProgress) {
        status = "pending";
        repairs.push({
          itemId: item.id,
          field: "status",
          reason: "Only one item may be in progress"
        });
      } else {
        retainedInProgress = true;
      }
    }

    const repairedItem = {
      ...item,
      status,
      ...(evidenceCallIds === undefined ? {} : { evidenceCallIds: [...evidenceCallIds] }),
      ...(completionKind === undefined ? {} : { completionKind })
    };
    if (evidenceCallIds === undefined) delete repairedItem.evidenceCallIds;
    if (completionKind === undefined) delete repairedItem.completionKind;
    return repairedItem;
  });

  if (!retainedInProgress) {
    const firstPending = items.find((item) => item.status === "pending");
    if (firstPending !== undefined) {
      firstPending.status = "in_progress";
      repairs.push({
        itemId: firstPending.id,
        field: "status",
        reason: "An active Mission needs one current item"
      });
    }
  }

  return {
    plan: {
      objective: input.objective,
      items,
      ...(input.requirements === undefined ? {} : {
        requirements: input.requirements.map((requirement) => ({
          ...requirement,
          ...(requirement.protectedPaths === undefined ? {} : {
            protectedPaths: [...requirement.protectedPaths]
          })
        }))
      })
    },
    repairs
  };
}

function hasRepairableStructure(input: ExecutionPlanWriteInput): boolean {
  if (
    typeof input.objective !== "string" ||
    input.objective.trim().length === 0 ||
    input.objective.length > EXECUTION_PLAN_MAX_OBJECTIVE_CHARS ||
    !Array.isArray(input.items) ||
    input.items.length === 0 ||
    input.items.length > EXECUTION_PLAN_MAX_ITEMS ||
    Buffer.byteLength(JSON.stringify(input), "utf8") > EXECUTION_PLAN_MAX_SERIALIZED_BYTES
  ) {
    return false;
  }

  const ids = new Set<string>();
  for (const item of input.items) {
    if (
      typeof item !== "object" ||
      item === null ||
      typeof item.id !== "string" ||
      item.id.length > EXECUTION_PLAN_MAX_ID_CHARS ||
      !SAFE_ID.test(item.id) ||
      ids.has(item.id) ||
      typeof item.content !== "string" ||
      item.content.trim().length === 0 ||
      item.content.length > EXECUTION_PLAN_MAX_ITEM_CHARS ||
      (item.status !== undefined && !ITEM_STATUSES.has(item.status)) ||
      (item.completionKind !== undefined && item.completionKind !== "reasoning") ||
      !hasStructurallyValidEvidenceIds(item.evidenceCallIds)
    ) {
      return false;
    }
    ids.add(item.id);
  }
  return true;
}

function hasStructurallyValidEvidenceIds(input: string[] | undefined): boolean {
  return input === undefined || (
    Array.isArray(input) &&
    input.length <= EXECUTION_PLAN_MAX_EVIDENCE_CALL_IDS &&
    input.every((id) => typeof id === "string" && id.trim().length > 0 && id.length <= 256)
  );
}
