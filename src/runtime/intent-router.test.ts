import { describe, expect, it } from "vitest";
import type { SkillDefinition, SkillRouting } from "../contracts/skill.js";
import { SkillRegistry } from "../skills/skill-registry.js";
import { IntentRouter } from "./intent-router.js";

describe("IntentRouter governed route contract", () => {
  it("uses explicit slash invocation as the primary skill", () => {
    const alpha = skill({
      name: "alpha",
      routing: {
        labels: ["alpha-route"]
      }
    });
    const router = routerWith(alpha);

    const route = router.route("/alpha review this");

    expect(route.taskClass).toBe("general");
    expect(route.primarySkill).toBe(alpha);
    expect(route.supportingSkills).toEqual([]);
    expect(route.candidates).toEqual([
      expect.objectContaining({
        skill: alpha,
        role: "primary",
        confidence: 1
      })
    ]);
    expect(route.rejectedCandidates).toEqual([]);
    expect(route.suggestedSkills).toEqual([alpha]);
  });

  it("keeps unknown slash invocations as no-skill routes", () => {
    const route = routerWith().route("/missing do thing");

    expect(route.primarySkill).toBeUndefined();
    expect(route.supportingSkills).toEqual([]);
    expect(route.candidates).toEqual([]);
    expect(route.rejectedCandidates).toEqual([]);
    expect(route.suggestedSkills).toEqual([]);
  });

  it("chooses the highest-ranked match as primary and preserves supporting skills", () => {
    const primary = skill({
      name: "primary-route",
      routing: {
        triggerPatterns: [{ type: "contains", value: "release route" }],
        priority: 10
      }
    });
    const supporting = skill({
      name: "supporting-route",
      routing: {
        triggerPatterns: [{ type: "contains", value: "release route" }]
      }
    });
    const route = routerWith(supporting, primary).route("please use the release route");

    expect(route.primarySkill).toBe(primary);
    expect(route.supportingSkills).toEqual([supporting]);
    expect(route.candidates?.map((candidate) => [candidate.skill.name, candidate.role])).toEqual([
      ["primary-route", "primary"],
      ["supporting-route", "supporting"]
    ]);
    expect(route.suggestedSkills).toEqual([primary, supporting]);
  });

  it("records negative pattern matches as rejected candidates", () => {
    const selected = skill({
      name: "selected-route",
      routing: {
        triggerPatterns: [{ type: "contains", value: "review" }]
      }
    });
    const rejected = skill({
      name: "rejected-route",
      routing: {
        triggerPatterns: [{ type: "contains", value: "review" }],
        negativePatterns: [{ type: "contains", value: "review" }]
      }
    });
    const route = routerWith(rejected, selected).route("review this release");

    expect(route.primarySkill).toBe(selected);
    expect(route.rejectedCandidates).toEqual([
      expect.objectContaining({
        skill: rejected,
        role: "rejected"
      })
    ]);
    expect(route.suggestedSkills).toEqual([selected]);
  });

  it("records defer rules as deferred candidates without selecting them", () => {
    const deferred = skill({
      name: "deferred-route",
      routing: {
        triggerPatterns: [{ type: "contains", value: "review" }],
        deferWhen: [{
          when: {
            promptMatches: [{ type: "contains", value: "review" }]
          },
          reason: "Defer review route during preflight."
        }]
      }
    });
    const route = routerWith(deferred).route("review this release");

    expect(route.primarySkill).toBeUndefined();
    expect(route.candidates).toEqual([
      expect.objectContaining({
        skill: deferred,
        role: "deferred",
        reason: "Defer review route during preflight."
      })
    ]);
    expect(route.rejectedCandidates).toEqual([
      expect.objectContaining({
        skill: deferred,
        role: "deferred"
      })
    ]);
    expect(route.suggestedSkills).toEqual([]);
  });

  it("sets a task class from native intent without changing skill authority", () => {
    const route = routerWith().route("generate an image of a dashboard");

    expect(route.nativeIntent).toBe("image-generation");
    expect(route.taskClass).toBe("media-generation");
    expect(route.primarySkill).toBeUndefined();
  });

  it.each([
    ["please review this pull request", "code-review"],
    ["can you update the README docs for this command", "docs-writing"],
    ["validate this branch before merge", "release-validation"],
    ["what do you think of this architecture plan?", "architecture-advice"],
    ["research the best approaches for local embeddings", "research"],
    ["please implement the CLI feature in the repo", "repo-change"]
  ] as const)("classifies %s as %s without selecting a skill by itself", (prompt, taskClass) => {
    const route = routerWith().route(prompt);

    expect(route.taskClass).toBe(taskClass);
    expect(route.primarySkill).toBeUndefined();
    expect(route.suggestedSkills).toEqual([]);
    expect(route.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "task-class",
          detail: expect.stringContaining(taskClass)
        })
      ])
    );
  });

  it("leaves unrelated prompts as general without task-class evidence", () => {
    const route = routerWith().route("hello there");

    expect(route.taskClass).toBe("general");
    expect(route.evidence.some((entry) => entry.kind === "task-class")).toBe(false);
  });
});

function routerWith(...skills: SkillDefinition[]): IntentRouter {
  const registry = new SkillRegistry();
  for (const entry of skills) {
    registry.register(entry);
  }
  return new IntentRouter({ skillRegistry: registry });
}

function skill(input: {
  name: string;
  routing?: SkillRouting;
}): SkillDefinition {
  return {
    name: input.name,
    description: `${input.name} test skill.`,
    version: "0.1.0",
    routing: input.routing,
    whenToUse: [],
    requiredToolsets: [],
    playbook: [],
    permissionExpectations: [],
    examples: [],
    evaluations: []
  };
}
