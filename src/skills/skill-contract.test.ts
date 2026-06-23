import { describe, expect, it } from "vitest";
import type { LoadedSkill } from "../contracts/skill.js";
import { SKILL_CONTRACT_MAX_CHARS, SKILL_ROOT_INLINE_MAX_CHARS } from "./skill-limits.js";
import { buildSkillContract, selectSkillPromptContent } from "./skill-contract.js";

describe("buildSkillContract", () => {
  it("returns undefined for small skills", () => {
    const skill = makeLoadedSkill({
      instructions: "# Small\n\nUse the small skill."
    });

    expect(buildSkillContract(skill)).toBeUndefined();
  });

  it("builds a deterministic contract for large skills", () => {
    const skill = makeLoadedSkill({
      name: "large-skill",
      description: "A large test skill.",
      instructions: largeInstructions([
        "# Overview",
        "Use the skill carefully.",
        "## Workflow",
        "Follow deterministic steps."
      ])
    });

    const first = buildSkillContract(skill);
    const second = buildSkillContract(skill);

    expect(first).toEqual(second);
    expect(first?.summary).toContain("Skill contract: large-skill");
    expect(first?.summary).toContain("Description: A large test skill.");
    expect(first?.summary).toContain(`Inline prompt cap: ${SKILL_ROOT_INLINE_MAX_CHARS}`);
    expect(first?.summary).toContain("skill.read({ \"name\": \"large-skill\", \"mode\": \"full\" })");
    expect(first?.summary.length).toBeLessThanOrEqual(SKILL_CONTRACT_MAX_CHARS);
    expect(first?.originalChars).toBe(skill.instructions.length);
  });

  it("extracts headings and ignores headings inside fenced code blocks", () => {
    const skill = makeLoadedSkill({
      instructions: largeInstructions([
        "# Outside",
        "```ts",
        "# Inside Fence",
        "```",
        "## After Fence"
      ])
    });

    const contract = buildSkillContract(skill);

    expect(contract?.sectionIndex.map((section) => section.heading)).toEqual([
      "Outside",
      "After Fence"
    ]);
    expect(contract?.sectionIndex[0]).toMatchObject({
      level: 1,
      charOffset: 0
    });
    expect(contract?.sectionIndex[0]?.charLength).toBeGreaterThan(0);
  });

  it("indexes non-script resources separately from scripts without embedding resource contents", () => {
    const skill = makeLoadedSkill({
      instructions: largeInstructions(["# Resource Skill"]),
      resources: [
        { kind: "reference", path: "references/guide.md", bytes: 123 },
        { kind: "template", path: "templates/base.md", bytes: 456 },
        { kind: "asset", path: "assets/icon.png", bytes: 789 },
        { kind: "script", path: "scripts/run.sh", bytes: 10 }
      ]
    });

    const contract = buildSkillContract(skill);

    expect(contract?.referenceIndex.map((entry) => entry.path)).toEqual([
      "references/guide.md",
      "templates/base.md",
      "assets/icon.png"
    ]);
    expect(contract?.scriptIndex.map((entry) => entry.path)).toEqual(["scripts/run.sh"]);
    expect(contract?.summary).toContain("references/guide.md");
    expect(contract?.summary).toContain("scripts/run.sh");
    expect(contract?.summary).not.toContain("SECRET REFERENCE CONTENT");
  });

  it("marks contract summaries when they are capped", () => {
    const skill = makeLoadedSkill({
      name: "capped-skill",
      instructions: largeInstructions(
        Array.from({ length: 120 }, (_, index) => `## Very Long Heading ${index} ${"x".repeat(40)}`)
      ),
      resources: Array.from({ length: 80 }, (_, index) => ({
        kind: "reference" as const,
        path: `references/${String(index).padStart(2, "0")}-${"long-name-".repeat(20)}.md`
      }))
    });

    const contract = buildSkillContract(skill);

    expect(contract?.summary.length).toBeLessThanOrEqual(SKILL_CONTRACT_MAX_CHARS);
    expect(contract?.summary).toContain("[Contract summary truncated.");
  });
});

describe("selectSkillPromptContent", () => {
  it("returns full mode for small skills", () => {
    const skill = makeLoadedSkill({
      instructions: "# Small\n\nUse all instructions.",
      resources: [
        { kind: "reference", path: "references/guide.md" },
        { kind: "script", path: "scripts/run.sh" }
      ]
    });

    const selected = selectSkillPromptContent(skill);

    expect(selected).toMatchObject({
      name: skill.name,
      description: skill.description,
      content: skill.instructions,
      contentMode: "full",
      originalChars: skill.instructions.length,
      truncated: false,
      referencePaths: ["references/guide.md"],
      scriptPaths: ["scripts/run.sh"]
    });
    expect(selected.loadInstruction).toBeUndefined();
  });

  it("returns contract mode and full-load instruction for large skills", () => {
    const skill = makeLoadedSkill({
      name: "large-skill",
      instructions: largeInstructions(["# Large"]),
      resources: [
        { kind: "reference", path: "references/guide.md" },
        { kind: "script", path: "scripts/run.sh" }
      ]
    });
    const contract = buildSkillContract(skill);

    const selected = selectSkillPromptContent({
      ...skill,
      contract
    });

    expect(selected).toMatchObject({
      name: "large-skill",
      content: contract?.summary,
      contentMode: "contract",
      originalChars: skill.instructions.length,
      truncated: true,
      referencePaths: ["references/guide.md"],
      scriptPaths: ["scripts/run.sh"],
      loadInstruction: "skill.read({ \"name\": \"large-skill\", \"mode\": \"full\" })"
    });
  });
});

function makeLoadedSkill(overrides: Partial<LoadedSkill> = {}): LoadedSkill {
  return {
    name: "test-skill",
    description: "A test skill.",
    version: "1.0.0",
    whenToUse: ["testing"],
    requiredToolsets: ["core"],
    playbook: [],
    permissionExpectations: [],
    examples: [],
    evaluations: [],
    sourcePath: "/tmp/test-skill/SKILL.md",
    sourceKind: "local",
    sourceRoot: "/tmp",
    instructions: "# Test\n\nUse the test skill.",
    ...overrides
  };
}

function largeInstructions(prefixLines: string[]): string {
  const filler = "Detailed instruction text.\n".repeat(420);
  return [...prefixLines, filler].join("\n");
}
