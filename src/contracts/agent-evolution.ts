export type AgentEvolutionMode =
  | "none"
  | "suggest"
  | "proactive"
  | "autonomous";

export type AgentEvolutionRoutingMode =
  | "deterministic"
  | "semantic-local"
  | "hybrid"
  | "hybrid-plus";

export type AgentEvolutionPolicy = {
  mode: AgentEvolutionMode;
  routingMode: AgentEvolutionRoutingMode;
  observeTurns: boolean;
  observeSelectedSkillTurns: boolean;
  createEvidence: boolean;
  createProposals: boolean;
  createExperiments: boolean;
  createManifests: boolean;
  preparePatches: boolean;
  runEvals: boolean;
  shadowAutonomousDecisions: boolean;
  requireApprovalForLowRisk: boolean;
  requireApprovalForMediumRisk: boolean;
  requireApprovalForHighRisk: boolean;
  autoPromoteEligibleLocalChanges: boolean;
  autoRollbackEligibleLocalChanges: boolean;
  budgets: {
    maxProposalsPerDay?: number;
    maxShadowAutoPromotionsPerDay?: number;
    maxRealAutoPromotionsPerDay?: number;
    maxEvalRuntimeMs?: number;
    maxProviderCostUsd?: number;
    maxFilesTouchedPerPromotion?: number;
    maxSkillMutationsPerSession?: number;
  };
};

export function deriveAgentEvolutionPolicy(
  mode: AgentEvolutionMode,
  advancedOverride: Partial<AgentEvolutionPolicy> = {}
): AgentEvolutionPolicy {
  const base = baseAgentEvolutionPolicy(mode);
  const merged: AgentEvolutionPolicy = {
    ...base,
    ...advancedOverride,
    mode: base.mode,
    budgets: {
      ...base.budgets,
      ...advancedOverride.budgets
    }
  };

  return {
    ...merged,
    requireApprovalForHighRisk: true,
    autoPromoteEligibleLocalChanges: false,
    autoRollbackEligibleLocalChanges: false
  };
}

function baseAgentEvolutionPolicy(mode: AgentEvolutionMode): AgentEvolutionPolicy {
  switch (mode) {
    case "none":
      return {
        mode,
        routingMode: "deterministic",
        observeTurns: false,
        observeSelectedSkillTurns: false,
        createEvidence: false,
        createProposals: false,
        createExperiments: false,
        createManifests: false,
        preparePatches: false,
        runEvals: false,
        shadowAutonomousDecisions: false,
        requireApprovalForLowRisk: true,
        requireApprovalForMediumRisk: true,
        requireApprovalForHighRisk: true,
        autoPromoteEligibleLocalChanges: false,
        autoRollbackEligibleLocalChanges: false,
        budgets: {}
      };
    case "suggest":
      return {
        mode,
        routingMode: "semantic-local",
        observeTurns: true,
        observeSelectedSkillTurns: true,
        createEvidence: true,
        createProposals: true,
        createExperiments: false,
        createManifests: true,
        preparePatches: false,
        runEvals: false,
        shadowAutonomousDecisions: false,
        requireApprovalForLowRisk: true,
        requireApprovalForMediumRisk: true,
        requireApprovalForHighRisk: true,
        autoPromoteEligibleLocalChanges: false,
        autoRollbackEligibleLocalChanges: false,
        budgets: {}
      };
    case "proactive":
      return {
        mode,
        routingMode: "hybrid",
        observeTurns: true,
        observeSelectedSkillTurns: true,
        createEvidence: true,
        createProposals: true,
        createExperiments: true,
        createManifests: true,
        preparePatches: true,
        runEvals: true,
        shadowAutonomousDecisions: false,
        requireApprovalForLowRisk: true,
        requireApprovalForMediumRisk: true,
        requireApprovalForHighRisk: true,
        autoPromoteEligibleLocalChanges: false,
        autoRollbackEligibleLocalChanges: false,
        budgets: {}
      };
    case "autonomous":
      return {
        mode,
        routingMode: "hybrid-plus",
        observeTurns: true,
        observeSelectedSkillTurns: true,
        createEvidence: true,
        createProposals: true,
        createExperiments: true,
        createManifests: true,
        preparePatches: true,
        runEvals: true,
        shadowAutonomousDecisions: true,
        requireApprovalForLowRisk: false,
        requireApprovalForMediumRisk: true,
        requireApprovalForHighRisk: true,
        autoPromoteEligibleLocalChanges: false,
        autoRollbackEligibleLocalChanges: false,
        budgets: {}
      };
  }
}
