import { describe, expect, it } from "vitest";
import type { IntentRoute } from "../contracts/intent.js";
import {
  selectToolSelectionPolicy,
  shouldIncludePlan,
  TOOL_SELECTION_POLICIES
} from "./tool-selection-policies.js";

function intent(taskClass: IntentRoute["taskClass"]): IntentRoute {
  return {
    nativeIntent: taskClass === "browser-operation" ? "browser-control" : "general",
    taskClass,
    labels: [],
    confidence: 0.35,
    suggestedToolsets: [],
    suggestedSkills: [],
    confirmationRequired: false,
    evidence: [],
    rationale: "test"
  };
}

describe("tool selection policies", () => {
  it.each([
    ["conversation", "conversation"],
    ["repo-inspection", "repo-inspection"],
    ["code-review", "repo-inspection"],
    ["repo-change", "repo-modification"],
    ["release-validation", "repo-modification"],
    ["provider-diagnostics", "provider-diagnostics"],
    ["browser-operation", "browser-operation"],
    ["research", "research"],
    ["general", "bounded-general"]
  ] as const)("maps task class %s to policy %s", (taskClass, policy) => {
    expect(selectToolSelectionPolicy({
      intent: intent(taskClass),
      namedConnectorOperation: false,
      selectedSkill: false,
      readyAttachments: false
    }).name).toBe(policy);
  });

  it("defines policies through bounded toolsets and risks, not concrete tool names", () => {
    for (const policy of Object.values(TOOL_SELECTION_POLICIES)) {
      expect(policy).toEqual(expect.objectContaining({
        name: expect.any(String),
        toolsets: expect.any(Array),
        allowedRiskClasses: expect.any(Array)
      }));
      expect(policy).not.toHaveProperty("tools");
      expect(policy).not.toHaveProperty("toolNames");
      expect(policy.toolsets.length).toBeLessThanOrEqual(4);
    }
  });

  it("includes plan only for genuinely multi-step eligible policies", () => {
    expect(shouldIncludePlan({
      policy: TOOL_SELECTION_POLICIES.conversation,
      userText: "hello"
    })).toBe(false);
    expect(shouldIncludePlan({
      policy: TOOL_SELECTION_POLICIES["repo-modification"],
      userText: "change one file"
    })).toBe(false);
    expect(shouldIncludePlan({
      policy: TOOL_SELECTION_POLICIES["repo-modification"],
      userText: "change the file and run validation"
    })).toBe(true);
    expect(shouldIncludePlan({
      policy: TOOL_SELECTION_POLICIES["repo-inspection"],
      userText: "inspect this file"
    })).toBe(false);
    expect(shouldIncludePlan({
      policy: TOOL_SELECTION_POLICIES["repo-inspection"],
      userText: "inspect all modules across the repository"
    })).toBe(true);
    expect(shouldIncludePlan({
      policy: TOOL_SELECTION_POLICIES.conversation,
      userText: "run the selected skill",
      selectedSkillPlaybookSteps: 3
    })).toBe(true);
  });
});
