export const EXECUTION_PLAN_MAX_ITEMS = 16;
export const EXECUTION_PLAN_MAX_ITEM_CHARS = 240;
export const EXECUTION_PLAN_MAX_OBJECTIVE_CHARS = 500;
export const EXECUTION_PLAN_MAX_BLOCKER_CHARS = 500;
export const EXECUTION_PLAN_MAX_SERIALIZED_BYTES = 8 * 1024;
export const EXECUTION_PLAN_MAX_ID_CHARS = 64;
export const EXECUTION_PLAN_MAX_EVIDENCE_CALL_IDS = 16;

export type ExecutionPlanOperation = "read" | "write" | "merge";

export type ExecutionPlanItemStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "blocked"
  | "cancelled";

export type ExecutionPlanBlockerKind =
  | "user_input_required"
  | "approval_required"
  | "missing_capability"
  | "external_state"
  | "budget";

export type ExecutionPlanStatus =
  | "active"
  | "completed"
  | "blocked"
  | "transferred"
  | "abandoned";

export type ExecutionPlanBlocker = {
  kind: ExecutionPlanBlockerKind;
  summary: string;
};

export type ExecutionPlanEvidence = {
  toolCallId: string;
  tool: string;
  outcome: "success";
  riskClass: import("./tool.js").ToolRiskClass;
  targetSummary?: string;
};

export type ExecutionPlanItem = {
  id: string;
  content: string;
  status: ExecutionPlanItemStatus;
  /** Untrusted references awaiting harness validation in the evidence-enforcement layer. */
  evidenceCallIds?: string[];
  /** Harness-derived evidence. Provider input must never populate this field directly. */
  evidence?: ExecutionPlanEvidence[];
  blocker?: ExecutionPlanBlocker;
};

export type ExecutionPlan = {
  objective: string;
  originTurnId: string;
  revision: number;
  status: ExecutionPlanStatus;
  items: ExecutionPlanItem[];
};

export const EXECUTION_PLAN_EVENT_KINDS = [
  "execution-plan-started",
  "execution-plan-updated",
  "execution-plan-completed",
  "execution-plan-blocked",
  "execution-plan-transferred",
  "execution-plan-abandoned"
] as const;

export type ExecutionPlanEventKind = typeof EXECUTION_PLAN_EVENT_KINDS[number];

export type ExecutionPlanLifecycleEvent = {
  kind: ExecutionPlanEventKind;
  plan: ExecutionPlan;
  /** Trusted Task identifiers recorded only for an ownership handoff. */
  taskIds?: string[];
};

export type ExecutionPlanEventSink = (event: ExecutionPlanLifecycleEvent) => void | Promise<void>;

export type ExecutionPlanWriteInput = {
  objective: string;
  items: Array<{
    id: string;
    content: string;
    status?: ExecutionPlanItemStatus;
    evidenceCallIds?: string[];
    blocker?: ExecutionPlanBlocker;
  }>;
};

export type ExecutionPlanMergeItemInput = {
  id: string;
  content?: string;
  status?: ExecutionPlanItemStatus;
  evidenceCallIds?: string[];
  blocker?: ExecutionPlanBlocker | null;
};

export type ExecutionPlanMergeInput = {
  objective?: string;
  items: ExecutionPlanMergeItemInput[];
};

export type ExecutionPlanToolInput =
  | { operation: "read" }
  | ({ operation: "write" } & ExecutionPlanWriteInput)
  | ({ operation: "merge" } & ExecutionPlanMergeInput);

export type ExecutionPlanReader = {
  current(): ExecutionPlan | undefined;
};

export type ExecutionPlanControllerApi = ExecutionPlanReader & {
  write(input: ExecutionPlanWriteInput, originTurnId: string, sink?: ExecutionPlanEventSink): Promise<ExecutionPlan>;
  merge(input: ExecutionPlanMergeInput, sink?: ExecutionPlanEventSink): Promise<ExecutionPlan>;
};
