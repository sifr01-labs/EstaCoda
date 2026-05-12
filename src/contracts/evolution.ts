export type EvolutionTarget =
  | "skill"
  | "tool_description"
  | "routing_metadata"
  | "middleware"
  | "memory_policy"
  | "workflow_policy"
  | "runtime_code";

export type EvolutionChangeManifest = {
  id: string;
  target: EvolutionTarget;
  filesChanged: string[];
  evidence: {
    traces: string[];        // trajectory IDs
    failures: string[];      // failure record IDs
    evalCases: string[];     // eval task IDs
    userCorrections?: string[];
  };
  hypothesis: string;
  predictedImpact: string;
  riskLevel: "low" | "medium" | "high";
  evalCommand: string;       // e.g., "pnpm run eval:run -- --task ..."
  constraintGates: string[]; // e.g., ["typecheck", "smoke", "golden-flows"]
  rollbackPlan: string;      // description or command
  status:
    | "proposed"
    | "testing"
    | "approved"
    | "rejected"
    | "promoted"
    | "reverted";
  createdAt: string;
  updatedAt?: string;
  promotedAt?: string;
  promotedBy?: string;
};
