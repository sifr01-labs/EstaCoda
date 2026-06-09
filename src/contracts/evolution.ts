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
  evalCommand: string;       // e.g., "pnpm run eval:fixtures"
  constraintGates: string[]; // e.g., ["pnpm run typecheck", "pnpm run smoke"]
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

export type EvolutionExperimentOutcome =
  | "proposed"
  | "running"
  | "passed"
  | "failed"
  | "inconclusive"
  | "promoted"
  | "reverted";

export type EvolutionExperimentTargetSurface =
  | "skill"
  | "routing_metadata"
  | "memory_policy"
  | "tool_description"
  | "playbook";

export type EvolutionExperimentCostRuntime = {
  providerCostUsd?: number;
  wallClockMs?: number;
  evalRuns?: number;
};

export type EvolutionExperiment = {
  id: string;
  hypothesis: string;
  targetSurface: EvolutionExperimentTargetSurface;
  evidenceIds: string[];
  proposedChangeIds: string[];
  baselineMetrics?: Record<string, number>;
  evalPlan?: string;
  resultMetrics?: Record<string, number>;
  costRuntime?: EvolutionExperimentCostRuntime;
  outcome: EvolutionExperimentOutcome;
  createdAt: string;
  updatedAt: string;
};
