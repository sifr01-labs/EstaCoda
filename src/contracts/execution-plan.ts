export const EXECUTION_PLAN_MAX_ITEMS = 16;
export const EXECUTION_PLAN_MAX_ITEM_CHARS = 240;
export const EXECUTION_PLAN_MAX_OBJECTIVE_CHARS = 500;
export const EXECUTION_PLAN_MAX_BLOCKER_CHARS = 500;
export const EXECUTION_PLAN_MAX_SERIALIZED_BYTES = 8 * 1024;
export const EXECUTION_PLAN_MAX_ID_CHARS = 64;
export const EXECUTION_PLAN_MAX_EVIDENCE_CALL_IDS = 16;
export const EXECUTION_PLAN_MAX_REQUIREMENTS = 12;
export const EXECUTION_PLAN_MAX_PROTECTED_PATHS = 8;
export const EXECUTION_PLAN_MAX_TOOL_NAME_CHARS = 160;

export type ExecutionPlanOperation = "read" | "write" | "merge";

/** Trusted runtime progress emitted by protected browser authentication receipts. */
export type AuthenticationExecutionEffect =
  | "credentials-required"
  | "credentials-submitted"
  | "challenge-required"
  | "challenge-submitted"
  | "authentication-candidate"
  | "authentication-verified"
  | "authentication-blocked";

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

export type ExecutionPlanCapability = "read" | "mutate" | "verify";

/** Bounded, model-authored declaration of a capability needed by this Mission. */
export type ExecutionPlanCapabilityRequirement = {
  id: string;
  itemId: string;
  /** Exact tool name exposed to the current session. */
  tool: string;
  capability: ExecutionPlanCapability;
  /** Semantic request only. The runtime resolves reviewed argument mappings. */
  requiresProtectedInput?: boolean;
  /** Declares that protected values must originate from the supervised browser. */
  protectedSource?: "browser";
};

export type ExecutionPlanCapabilityAssessmentStatus =
  | "ready"
  | "missing"
  | "unavailable"
  | "incompatible";

export type ExecutionPlanCapabilityAssessmentReason =
  | "tool_missing"
  | "tool_unavailable"
  | "risk_class_missing"
  | "capability_metadata_invalid"
  | "protected_path_missing"
  | "protected_transfer_unavailable"
  | "grouped_transfer_unsupported"
  | "protected_source_unsupported"
  | "protected_source_unavailable"
  | "verification_missing"
  | "risk_mismatch";

/** Runtime-resolved facts. Provider input cannot populate this structure. */
export type ExecutionPlanCapabilityResolution = {
  canonicalTool: string;
  riskClass: import("./tool.js").ToolRiskClass;
  classification: "read" | "mutate";
  protectedInput?: {
    paths: string[];
    grouped: boolean;
    source?: "browser";
  };
  verification?: {
    mutationTools: string[];
  };
};

/** Runtime-owned assessment. Provider input must never populate this field. */
export type ExecutionPlanCapabilityAssessment = {
  requirementId: string;
  itemId: string;
  tool: string;
  capability: ExecutionPlanCapability;
  status: ExecutionPlanCapabilityAssessmentStatus;
  reasonCode?: ExecutionPlanCapabilityAssessmentReason;
  resolution?: ExecutionPlanCapabilityResolution;
};

export type ExecutionPlanCapabilityPreflight = {
  status: "ready" | "blocked";
  assessments: ExecutionPlanCapabilityAssessment[];
};

/** Per-call runtime facts used while accepting a plan write; never model-authored. */
export type ExecutionPlanWriteContext = {
  protectedTransferAvailable?: boolean;
  groupedProtectedTransferAvailable?: boolean;
  /** Runtime-owned identity for the component authoring this plan snapshot. */
  source?: "runtime" | "provider";
  /** Only the runtime may mark its initial execution skeleton as provisional. */
  provisional?: boolean;
  /** Current logical Session identity; required for provisional runtime plans. */
  sessionId?: string;
};

/** Runtime-owned provenance. It is not accepted by the model-visible plan schema. */
export type ExecutionPlanProvenance = {
  source: "runtime" | "provider";
  provisional: boolean;
  sessionId?: string;
};

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

/** Safe, bounded current-turn choice offered after a missing-evidence update. */
export type ExecutionEvidenceCandidate = {
  toolCallId: string;
  tool: string;
  riskClass: import("./tool.js").ToolRiskClass;
  targetSummary?: string;
};

export type ConfirmedActionReceipt = {
  toolCallId?: string;
  tool: string;
  riskClass: import("./tool.js").ToolRiskClass;
  targetSummary?: string;
  status: "confirmed";
  verification: "verified" | "not_verified";
};

export type UncertainActionReceipt = {
  toolCallId?: string;
  tool: string;
  riskClass: import("./tool.js").ToolRiskClass;
  targetSummary?: string;
  status: "uncertain";
};

export type ExecutionFinalOutcomeStatus =
  | "completed"
  | "completed_with_recovered_errors"
  | "partially_completed"
  | "blocked"
  | "failed"
  | "cancelled";

export type ExecutionFinalOutcome = {
  status: ExecutionFinalOutcomeStatus;
  confirmedActions: ConfirmedActionReceipt[];
  uncertainActions: UncertainActionReceipt[];
};

/** Safe, harness-derived receipt persisted independently of raw tool output. */
export type ExecutionEvidenceRecord =
  | {
      kind: "execution-evidence-recorded";
      toolCallId: string;
      tool: string;
      status: "success";
      riskClass: import("./tool.js").ToolRiskClass;
      targetSummary?: string;
      visibleTurnId?: string;
      executionEffect?: import("./tool.js").ToolExecutionEffect;
      verifiedMutation?: {
        toolCallId: string;
        tool: string;
      };
    }
  | {
      kind: "execution-evidence-recorded";
      toolCallId: string;
      tool: string;
      status: "failed" | "blocked" | "unavailable" | "ineligible";
      riskClass?: import("./tool.js").ToolRiskClass;
      targetSummary?: string;
      visibleTurnId?: string;
      executionEffect?: import("./tool.js").ToolExecutionEffect;
    };

export type ExecutionPlanCompletionKind = "reasoning";

export type ExecutionPlanItem = {
  id: string;
  content: string;
  status: ExecutionPlanItemStatus;
  /** Untrusted references awaiting harness validation in the evidence-enforcement layer. */
  evidenceCallIds?: string[];
  /** Harness-derived evidence. Provider input must never populate this field directly. */
  evidence?: ExecutionPlanEvidence[];
  /** Explicit exception for genuinely reasoning-only work. */
  completionKind?: ExecutionPlanCompletionKind;
  blocker?: ExecutionPlanBlocker;
};

export type ExecutionPlan = {
  objective: string;
  originTurnId: string;
  revision: number;
  status: ExecutionPlanStatus;
  items: ExecutionPlanItem[];
  provenance?: ExecutionPlanProvenance;
  requirements?: ExecutionPlanCapabilityRequirement[];
  capabilityPreflight?: ExecutionPlanCapabilityPreflight;
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
    completionKind?: ExecutionPlanCompletionKind;
    blocker?: ExecutionPlanBlocker;
  }>;
  requirements?: ExecutionPlanCapabilityRequirement[];
};

export type ExecutionPlanMergeItemInput = {
  id: string;
  content?: string;
  status?: ExecutionPlanItemStatus;
  evidenceCallIds?: string[];
  completionKind?: ExecutionPlanCompletionKind;
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
  write(
    input: ExecutionPlanWriteInput,
    originTurnId: string,
    sink?: ExecutionPlanEventSink,
    context?: ExecutionPlanWriteContext
  ): Promise<ExecutionPlan>;
  merge(input: ExecutionPlanMergeInput, sink?: ExecutionPlanEventSink): Promise<ExecutionPlan>;
  evidenceCandidates(itemId: string, visibleTurnId: string): ExecutionEvidenceCandidate[];
};
