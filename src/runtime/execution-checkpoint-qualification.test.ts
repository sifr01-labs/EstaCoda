import { describe, expect, it } from "vitest";
import type { IntentRoute } from "../contracts/intent.js";
import type { SkillDefinition } from "../contracts/skill.js";
import { qualifyForegroundExecution } from "./execution-checkpoint-qualification.js";

describe("qualifyForegroundExecution", () => {
  it("does not checkpoint ordinary or merely multi-part conversation", () => {
    expect(qualifyForegroundExecution({
      originTurnId: "turn-1",
      userText: "Tell me the weather and whether I need a jacket",
      intent: route({ taskClass: "conversation", suggestedToolsets: [] }),
      completionFloor: "none"
    })).toBeUndefined();
  });

  it("qualifies a cross-system API workflow with named deterministic reasons", () => {
    const result = qualifyForegroundExecution({
      originTurnId: "turn-1",
      userText: "Import all six Swagger products and credentials into Postman, then verify them",
      intent: route({ suggestedToolsets: ["browser", "mcp"] }),
      selectedSkill: apiSkill(),
      completionFloor: "mutation_with_verification",
      connectorIds: ["postman"]
    });

    expect(result).toMatchObject({
      selectedSkillName: "api-integration",
      qualificationReasons: [
        "cross_system",
        "verified_mutation",
        "external_multi_step",
        "multi_item"
      ],
      requiredOperations: ["read", "mutation", "verification", "artifact_relay", "protected_transfer"],
      connectorIds: ["postman"]
    });
  });

  it("qualifies a verified mutation without requiring an external connector", () => {
    expect(qualifyForegroundExecution({
      originTurnId: "turn-repo",
      userText: "Fix the bug and run the tests",
      intent: route({ taskClass: "repo-change", suggestedToolsets: ["files", "shell"] }),
      completionFloor: "mutation_with_verification"
    })?.qualificationReasons).toContain("verified_mutation");
  });
});

function route(overrides: Partial<IntentRoute> = {}): IntentRoute {
  return {
    nativeIntent: "general",
    taskClass: "general",
    labels: ["general"],
    confidence: 1,
    suggestedToolsets: [],
    supportingSkills: [],
    candidates: [],
    rejectedCandidates: [],
    suggestedSkills: [],
    confirmationRequired: false,
    evidence: [],
    rationale: "test",
    ...overrides
  };
}

function apiSkill(): SkillDefinition {
  return {
    name: "api-integration",
    description: "Integrate APIs",
    version: "1.0.0",
    whenToUse: [],
    requiredToolsets: ["browser", "mcp"],
    optionalToolsets: ["files"],
    playbook: [
      { id: "discover", description: "Discover" },
      { id: "import", description: "Import" },
      { id: "verify", description: "Verify" }
    ],
    permissionExpectations: [],
    examples: [],
    evaluations: []
  };
}
