import { describe, expect, it } from "vitest";
import type { IntentRoute } from "../contracts/intent.js";
import { buildFallbackResponse } from "./response-builders.js";

const generalIntent: IntentRoute = {
  nativeIntent: "general",
  labels: ["general"],
  confidence: 1,
  suggestedSkills: [],
  suggestedToolsets: [],
  confirmationRequired: false,
  evidence: [],
  rationale: "No specialized route matched."
};

describe("buildFallbackResponse", () => {
  it("uses user-facing wording when no skill is selected", () => {
    const response = buildFallbackResponse({
      label: "Test",
      selectedSkill: undefined,
      intent: generalIntent,
      securityDecision: "allow",
      toolExecutions: [],
      toolPlans: [],
      skillOutcomes: [],
      artifacts: [],
      context: undefined,
      projectContext: undefined
    });

    expect(response.text).toBe(
      "I could not generate a full model response for this turn. Check provider configuration or try again once a model provider is available."
    );
    expect(response.matchedSkills).toEqual([]);
    expect(response.progress).toContain("direct response mode");
    expect(response.progress).not.toContain("no skill selected");

    const userVisible = [response.text, ...response.progress].join("\n");
    expect(userVisible).not.toMatch(/matching skill/i);
    expect(userVisible).not.toMatch(/future skill discovery/i);
    expect(userVisible).not.toMatch(/I would answer directly/i);
  });
});
