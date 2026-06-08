export type WorkflowActivationReason = "explicit" | "playbook" | "policy";

export type WorkflowRuntimeContext = {
  runId: string;
  stepId?: string;
  activationReason: WorkflowActivationReason;
};

const WORKFLOW_ACTIVATION_REASONS = new Set<WorkflowActivationReason>(["explicit", "playbook", "policy"]);

export function normalizeWorkflowActivationReason(value: unknown): WorkflowActivationReason {
  return typeof value === "string" && WORKFLOW_ACTIVATION_REASONS.has(value as WorkflowActivationReason)
    ? value as WorkflowActivationReason
    : "explicit";
}
