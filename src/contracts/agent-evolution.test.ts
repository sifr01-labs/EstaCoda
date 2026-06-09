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

  it("maps proactive correctly", () => {
    expect(deriveAgentEvolutionPolicy("proactive")).toMatchObject({
      mode: "proactive",
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
      autoRollbackEligibleLocalChanges: false
    });
  });

  it("maps autonomous correctly as shadow-only", () => {
    expect(deriveAgentEvolutionPolicy("autonomous")).toMatchObject({
      mode: "autonomous",
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
      autoRollbackEligibleLocalChanges: false
    });
  });

  it("does not allow advancedOverride to enable real auto-promotion in Phase 1A", () => {
    expect(deriveAgentEvolutionPolicy("autonomous", {
      autoPromoteEligibleLocalChanges: true
    }).autoPromoteEligibleLocalChanges).toBe(false);
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
