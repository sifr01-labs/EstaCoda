import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { CompiledSkillPlaybook } from "../contracts/skill.js";
import { convertSkillPlaybookToWorkflowPlan } from "./skill-playbook-to-workflow-plan.js";

describe("convertSkillPlaybookToWorkflowPlan", () => {
  it("preserves skill provenance on workflow plan metadata", () => {
    const plan = convertSkillPlaybookToWorkflowPlan(makePlaybook());

    expect(plan.name).toBe("researcher playbook");
    expect(plan.description).toBe("Workflow plan converted from skill playbook: researcher");
    expect(plan.metadata).toEqual({
      source: "skill-playbook",
      skill: "researcher",
      warnings: ["fallback target missing"]
    });
  });

  it("preserves step order, names, and descriptions", () => {
    const plan = convertSkillPlaybookToWorkflowPlan(makePlaybook());

    expect(plan.steps.map((step) => step.name)).toEqual(["inspect", "summarize"]);
    expect(plan.steps.map((step) => step.description)).toEqual([
      "Inspect the target material",
      "Summarize the findings"
    ]);
  });

  it("keeps playbook guidance as metadata without inferring workflow policy", () => {
    const plan = convertSkillPlaybookToWorkflowPlan(makePlaybook());

    expect(plan.steps[0]).toMatchObject({
      requiresApproval: false,
      maxRetries: 0,
      idempotent: false,
      skippable: false,
      metadata: {
        sourceStepId: "inspect",
        preferredToolsets: ["files", "browser"],
        successCriteria: ["source inspected"]
      }
    });
    expect(plan.steps[0]).not.toHaveProperty("onFailure");
    expect(plan.steps[0]?.metadata).not.toHaveProperty("fallbackTo");
  });

  it("stays inert during normal runtime execution paths", async () => {
    const runtimeSources = await Promise.all([
      readFile(new URL("../runtime/agent-loop.ts", import.meta.url), "utf8"),
      readFile(new URL("../runtime/skill-playbook-runner.ts", import.meta.url), "utf8"),
      readFile(new URL("../runtime/create-runtime.ts", import.meta.url), "utf8")
    ]);

    for (const source of runtimeSources) {
      expect(source).not.toContain("convertSkillPlaybookToWorkflowPlan");
      expect(source).not.toContain("skill-playbook-to-workflow-plan");
    }
  });
});

function makePlaybook(): CompiledSkillPlaybook {
  return {
    skill: "researcher",
    warnings: ["fallback target missing"],
    steps: [
      {
        id: "inspect",
        description: "Inspect the target material",
        preferredToolsets: ["files", "browser"],
        preferredTool: "files.read",
        toolCandidates: ["files.read", "browser.open"],
        fallbackTo: ["summarize"],
        successCriteria: ["source inspected"],
        outputTarget: "notes",
        status: "planned"
      },
      {
        id: "summarize",
        description: "Summarize the findings",
        preferredToolsets: ["core"],
        fallbackTo: [],
        successCriteria: ["findings summarized"],
        status: "planned"
      }
    ]
  };
}
