import { describe, expect, it } from "vitest";
import { deriveAgentEvolutionPolicy } from "./agent-evolution.js";

describe("deriveAgentEvolutionPolicy", () => {
  it("maps none correctly", () => {
    expect(deriveAgentEvolutionPolicy("none")).toMatchObject({
      mode: "none",
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
      autoRollbackEligibleLocalChanges: false
    });
  });

  it("maps suggest correctly", () => {
    expect(deriveAgentEvolutionPolicy("suggest")).toMatchObject({
      mode: "suggest",
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
      autoRollbackEligibleLocalChanges: false
    });
  });

  it.each(["proactive", "autonomous"] as const)("allows bounded instruction updates in %s unless approval is enabled", mode => {
    expect(deriveAgentEvolutionPolicy(mode)).toMatchObject({ skillWriteApproval: false, preparePatches: true,
      requireApprovalForLowRisk: false, requireApprovalForMediumRisk: true, requireApprovalForHighRisk: true,
      autoPromoteEligibleLocalChanges: true, autoRollbackEligibleLocalChanges: false });
    expect(deriveAgentEvolutionPolicy(mode, { skillWriteApproval: true, autoPromoteEligibleLocalChanges: true }))
      .toMatchObject({ requireApprovalForLowRisk: true, autoPromoteEligibleLocalChanges: false });
  });

  it.each(["none", "suggest"] as const)("cannot force automatic promotion in %s", mode => {
    expect(deriveAgentEvolutionPolicy(mode, { autoPromoteEligibleLocalChanges: true })).toMatchObject({ autoPromoteEligibleLocalChanges: false });
  });

  it("does not allow advancedOverride to enable auto-rollback in Phase 1A", () => {
    expect(deriveAgentEvolutionPolicy("autonomous", {
      autoRollbackEligibleLocalChanges: true
    }).autoRollbackEligibleLocalChanges).toBe(false);
  });

  it("does not allow advancedOverride to disable high-risk approval", () => {
    expect(deriveAgentEvolutionPolicy("autonomous", {
      requireApprovalForHighRisk: false
    }).requireApprovalForHighRisk).toBe(true);
  });
});
