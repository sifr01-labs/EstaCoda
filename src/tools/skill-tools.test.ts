import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { IntentRoute } from "../contracts/intent.js";
import type { LoadedSkill, SkillDefinition } from "../contracts/skill.js";
import type { ToolResult } from "../contracts/tool.js";
import {
  MAX_SKILL_RESOURCE_BYTES,
  SKILL_READ_MAX_CHARS,
  SKILL_SEARCH_DEFAULT_RESULTS,
  SKILL_SEARCH_MAX_RESULTS
} from "../skills/skill-limits.js";
import { SkillRegistry } from "../skills/skill-registry.js";
import type { SkillEvolutionStore } from "../skills/skill-evolution.js";
import { RuntimeRouter } from "../runtime/runtime-router.js";
import type { IntentRouter } from "../runtime/intent-router.js";
import { createSkillTools } from "./skill-tools.js";

describe("skill.read", () => {
  it("returns full content for small loaded skills with rich metadata", async () => {
    const harness = await skillToolHarness([loadedSkill({
      name: "small-skill",
      instructions: "# Small\n\nUse the small skill.",
      resources: [
        { kind: "reference", path: "references/guide.md" },
        { kind: "script", path: "scripts/run.sh" }
      ],
      requiredEnvironmentVariables: ["SKILL_READ_TEST_MISSING_ENV"]
    })]);

    const result = await harness.run("skill.read", { name: "small-skill" });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("# small-skill\n\n# Small\n\nUse the small skill.");
    expect(result.metadata).toMatchObject({
      name: "small-skill",
      description: "Test skill small-skill.",
      version: "0.1.0",
      mode: "complete",
      originalChars: "# Small\n\nUse the small skill.".length,
      truncated: false,
      setup_needed: true,
      readiness_status: "missing-setup",
      missing_required_environment_variables: ["SKILL_READ_TEST_MISSING_ENV"],
      missing_required_credential_files: [],
      missing_config_fields: [],
      linked_files: {
        references: [{ kind: "reference", path: "references/guide.md" }],
        scripts: [{ kind: "script", path: "scripts/run.sh" }],
        templates: [],
        assets: []
      }
    });
  });

  it("returns contract content for large loaded skills by default and in contract mode", async () => {
    const large = loadedSkill({
      name: "large-skill",
      instructions: largeInstructions()
    });
    const harness = await skillToolHarness([large]);

    const defaultResult = await harness.run("skill.read", { name: "large-skill" });
    const contractResult = await harness.run("skill.read", { name: "large-skill", mode: "contract" });

    for (const result of [defaultResult, contractResult]) {
      expect(result.ok).toBe(true);
      expect(result.content).toContain("Skill contract: large-skill");
      expect(result.content).toContain("Load full root instructions later with: skill.read");
      expect(result.content).toContain("Contract status: root instructions are truncated from the selected prompt and represented by a bounded contract, not the full root body.");
      expect(result.content).not.toContain("LARGE_ROOT_TAIL_MARKER");
      expect(result.metadata).toMatchObject({
        mode: "contract",
        originalChars: large.instructions.length,
        truncated: true
      });
    }
  });

  it("returns mechanical metadata and resource index for small skills in contract mode", async () => {
    const harness = await skillToolHarness([loadedSkill({
      name: "small-contract",
      instructions: "# Small\n\nUse it.",
      resources: [{ kind: "template", path: "templates/base.md", bytes: 32 }]
    })]);

    const result = await harness.run("skill.read", { name: "small-contract", mode: "contract" });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("This is a mechanical metadata and resource index, not a semantic summary.");
    expect(result.content).toContain("templates/base.md · kind=template · bytes=32");
    expect(result.metadata).toMatchObject({
      mode: "contract",
      truncated: false,
      linked_files: {
        templates: [{ kind: "template", path: "templates/base.md", bytes: 32 }]
      }
    });
  });

  it("caps full mode by SKILL_READ_MAX_CHARS and reports originalChars/truncated", async () => {
    const instructions = `${"A".repeat(Math.floor(SKILL_READ_MAX_CHARS / 2))}FULL_MODE_MIDDLE_MARKER${"B".repeat(Math.floor(SKILL_READ_MAX_CHARS / 2) + 100)}`;
    const harness = await skillToolHarness([loadedSkill({
      name: "full-cap",
      instructions
    })]);

    const result = await harness.run("skill.read", { name: "full-cap", mode: "full" });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("[TRUNCATED:");
    expect(result.content.length).toBeLessThan(instructions.length + "# full-cap\n\n".length);
    expect(result.metadata).toMatchObject({
      mode: "full",
      originalChars: instructions.length,
      truncated: true
    });
  });

  it("reads skill-local resources through path-safe logic", async () => {
    const skill = loadedSkill({ name: "resource-skill" });
    const harness = await skillToolHarness([skill], {
      files: {
        "references/guide.md": "Reference body marker."
      }
    });

    const result = await harness.run("skill.read", {
      name: "resource-skill",
      path: "references/guide.md"
    });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("# resource-skill / references/guide.md");
    expect(result.content).toContain("Reference body marker.");
    expect(result.metadata).toMatchObject({
      mode: "reference",
      path: "references/guide.md",
      text: true,
      linked_files: {
        references: [{ kind: "reference", path: "references/guide.md" }]
      }
    });
  });

  it("rejects path reads combined with root-only modes using a structured error", async () => {
    const harness = await skillToolHarness([loadedSkill({ name: "bad-combo" })]);

    const result = await harness.run("skill.read", {
      name: "bad-combo",
      path: "references/guide.md",
      mode: "full"
    });

    expect(result.ok).toBe(false);
    expect(result.metadata).toMatchObject({
      code: "skill-read-incompatible-path-mode",
      name: "bad-combo",
      path: "references/guide.md",
      mode: "full"
    });
  });

  it("returns metadata-only mode for unloaded skills without fake loaded fields", async () => {
    const definition: SkillDefinition = {
      name: "definition-only",
      description: "Definition-only skill.",
      version: "0.1.0",
      category: "general",
      whenToUse: [],
      requiredToolsets: [],
      requiredCredentialFiles: ["/missing/credential.json"],
      configFields: [{ key: "apiMode", required: true }],
      playbook: [],
      permissionExpectations: [],
      examples: [],
      evaluations: []
    };
    const harness = await skillToolHarness([definition]);

    const result = await harness.run("skill.read", { name: "definition-only" });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Definition-only skill.");
    expect(result.metadata).toMatchObject({
      name: "definition-only",
      mode: "metadata-only",
      linked_files: {
        references: [],
        scripts: [],
        templates: [],
        assets: []
      },
      setup_needed: true,
      readiness_status: "missing-setup",
      missing_required_credential_files: ["/missing/credential.json"],
      missing_config_fields: ["apiMode"]
    });
    expect(result.metadata?.sourcePath).toBeUndefined();
    expect(result.metadata?.sourceRoot).toBeUndefined();
    expect(result.metadata?.resources).toBeUndefined();
  });

  it("keeps skill.view as a compatibility alias with the same rich metadata shape", async () => {
    const harness = await skillToolHarness([loadedSkill({ name: "alias-skill" })]);

    const read = await harness.run("skill.read", { name: "alias-skill" });
    const view = await harness.run("skill.view", { name: "alias-skill" });

    expect(view.ok).toBe(true);
    expect(view.content).toBe(read.content);
    expect(view.metadata).toEqual(read.metadata);
  });

  it("does not record usage telemetry for canonical skill.read", async () => {
    const recordSkillViewed = vi.fn().mockResolvedValue(undefined);
    const harness = await skillToolHarness([loadedSkill({ name: "read-telemetry" })], {
      skillEvolutionStore: { recordSkillViewed } as unknown as SkillEvolutionStore
    });

    const result = await harness.run("skill.read", { name: "read-telemetry" });

    expect(result.ok).toBe(true);
    expect(recordSkillViewed).not.toHaveBeenCalled();
  });

  it("preserves legacy viewed usage recording for skill.view compatibility", async () => {
    const recordSkillViewed = vi.fn().mockResolvedValue(undefined);
    const harness = await skillToolHarness([loadedSkill({ name: "view-telemetry" })], {
      skillEvolutionStore: { recordSkillViewed } as unknown as SkillEvolutionStore
    });

    const result = await harness.run("skill.view", { name: "view-telemetry" });

    expect(result.ok).toBe(true);
    expect(recordSkillViewed).toHaveBeenCalledTimes(1);
    expect(recordSkillViewed).toHaveBeenCalledWith({
      skillName: "view-telemetry",
      source: "local",
      provenanceKind: undefined
    });
  });

  it("uses the same setup helper for runtime setup context and skill.read readiness metadata", async () => {
    const skill = loadedSkill({
      name: "setup-skill",
      configFields: [{ key: "apiMode", required: true }]
    });
    const harness = await skillToolHarness([skill], {
      skillConfig: {
        "setup-skill": { api_mode: "configured" }
      }
    });
    const router = routerForSkill(skill, {
      "setup-skill": { api_mode: "configured" }
    });

    const route = router.route({ text: "test", channel: "cli" });
    const result = await harness.run("skill.read", { name: "setup-skill" });

    expect(route.selectedSkillSetup?.configFields).toEqual([
      {
        key: "apiMode",
        description: undefined,
        required: true,
        value: "configured",
        source: "config"
      }
    ]);
    expect(result.metadata).toMatchObject({
      setup_needed: false,
      readiness_status: "available",
      missing_config_fields: []
    });
  });
});

describe("skill.search", () => {
  it("searches named skill root instructions with path, line, heading, and deterministic excerpts", async () => {
    const harness = await skillToolHarness([loadedSkill({
      name: "search-root",
      instructions: [
        "# Troubleshooting",
        "First line.",
        "TransformMatchingTex error happens here.",
        "Next line."
      ].join("\n")
    })]);

    const result = await harness.run("skill.search", {
      name: "search-root",
      query: "transformmatchingtex"
    });
    const payload = parseSearchPayload(result);

    expect(result.ok).toBe(true);
    expect(payload).toMatchObject({
      name: "search-root",
      query: "transformmatchingtex",
      maxResults: SKILL_SEARCH_DEFAULT_RESULTS,
      matchCount: 1,
      truncated: false,
      results: [
        {
          path: "SKILL.md",
          heading: "Troubleshooting",
          line: 3
        }
      ]
    });
    expect(payload.results[0]?.excerpt).toContain("3: TransformMatchingTex error happens here.");
  });

  it("searches only indexed skill resources and returns deterministic path excerpts", async () => {
    const harness = await skillToolHarness([loadedSkill({
      name: "search-resources",
      instructions: "# Root\n\nNo match here.",
      resources: [
        { kind: "reference", path: "references/guide.md" },
        { kind: "template", path: "templates/example.md" }
      ]
    })], {
      files: {
        "references/guide.md": "# Guide\n\nA latex error appears in the reference.",
        "templates/example.md": "# Template\n\nAnother latex error appears in template."
      }
    });

    const result = await harness.run("skill.search", {
      name: "search-resources",
      query: "latex error",
      maxResults: 10
    });
    const payload = parseSearchPayload(result);

    expect(payload.results.map((entry) => entry.path)).toEqual([
      "references/guide.md",
      "templates/example.md"
    ]);
    expect(payload.results[0]).toMatchObject({
      heading: "Guide",
      line: 3
    });
    expect(payload.results[1]).toMatchObject({
      heading: "Template",
      line: 3
    });
  });

  it("clamps maxResults and marks result truncation", async () => {
    const instructions = Array.from({ length: SKILL_SEARCH_MAX_RESULTS + 2 }, (_, index) =>
      `needle occurrence ${index + 1}`
    ).join("\n");
    const harness = await skillToolHarness([loadedSkill({
      name: "search-clamp",
      instructions
    })]);

    const result = await harness.run("skill.search", {
      name: "search-clamp",
      query: "needle",
      maxResults: 999
    });
    const payload = parseSearchPayload(result);

    expect(payload.maxResults).toBe(SKILL_SEARCH_MAX_RESULTS);
    expect(payload.results).toHaveLength(SKILL_SEARCH_MAX_RESULTS);
    expect(payload.matchCount).toBe(SKILL_SEARCH_MAX_RESULTS + 2);
    expect(payload.truncated).toBe(true);
  });

  it("uses default max results when maxResults is absent", async () => {
    const instructions = Array.from({ length: SKILL_SEARCH_DEFAULT_RESULTS + 1 }, (_, index) =>
      `default needle ${index + 1}`
    ).join("\n");
    const harness = await skillToolHarness([loadedSkill({
      name: "search-default",
      instructions
    })]);

    const result = await harness.run("skill.search", {
      name: "search-default",
      query: "needle"
    });
    const payload = parseSearchPayload(result);

    expect(payload.maxResults).toBe(SKILL_SEARCH_DEFAULT_RESULTS);
    expect(payload.results).toHaveLength(SKILL_SEARCH_DEFAULT_RESULTS);
    expect(payload.matchCount).toBe(SKILL_SEARCH_DEFAULT_RESULTS + 1);
    expect(payload.truncated).toBe(true);
  });

  it("rejects missing or empty required search inputs without global fallback", async () => {
    const harness = await skillToolHarness([loadedSkill({
      name: "other-skill",
      instructions: "latex error should not be found without a name"
    })]);

    await expectSearchFailure(harness, { query: "latex" }, "skill name is required");
    await expectSearchFailure(harness, { name: "", query: "latex" }, "skill name is required");
    await expectSearchFailure(harness, { name: "other-skill" }, "skill.search requires a non-empty query.");
    await expectSearchFailure(harness, { name: "other-skill", query: "   " }, "skill.search requires a non-empty query.");
    await expectSearchFailure(harness, { name: "missing-skill", query: "latex" }, "Skill not found: missing-skill");
  });

  it("rejects unloaded skills instead of searching all skills", async () => {
    const definition: SkillDefinition = {
      name: "definition-only-search",
      description: "Definition only.",
      version: "0.1.0",
      whenToUse: [],
      requiredToolsets: [],
      playbook: [],
      permissionExpectations: [],
      examples: [],
      evaluations: []
    };
    const harness = await skillToolHarness([definition, loadedSkill({
      name: "loaded-other",
      instructions: "needle exists elsewhere"
    })]);

    const result = await harness.run("skill.search", {
      name: "definition-only-search",
      query: "needle"
    });

    expect(result.ok).toBe(false);
    expect(result.metadata).toMatchObject({
      code: "skill-search-unloaded-skill",
      name: "definition-only-search"
    });
  });

  it("blocks traversal resources and skips binary or oversized resources safely", async () => {
    const harness = await skillToolHarness([loadedSkill({
      name: "search-safety",
      instructions: "No matching root text.",
      resources: [
        { kind: "reference", path: "../outside.txt" },
        { kind: "reference", path: "references/binary.bin" },
        { kind: "reference", path: "references/huge.md" }
      ]
    })], {
      files: {
        "../outside.txt": "needle outside skill directory",
        "references/binary.bin": Buffer.from([0, 1, 2, 3, 4]),
        "references/huge.md": Buffer.alloc(MAX_SKILL_RESOURCE_BYTES + 1, "n")
      }
    });

    const result = await harness.run("skill.search", {
      name: "search-safety",
      query: "needle",
      maxResults: 10
    });
    const payload = parseSearchPayload(result);

    expect(result.ok).toBe(true);
    expect(payload.results).toEqual([]);
    expect(payload.skippedResources).toEqual([
      { path: "../outside.txt", reason: "outside-skill-directory" },
      { path: "references/binary.bin", reason: "binary" },
      { path: "references/huge.md", reason: "oversized" }
    ]);
  });

  it("caps excerpts and marks excerpt truncation", async () => {
    const longLine = `${"a".repeat(1_000)} needle ${"b".repeat(1_000)}`;
    const harness = await skillToolHarness([loadedSkill({
      name: "search-excerpt-cap",
      instructions: `# Long\n${longLine}`
    })]);

    const result = await harness.run("skill.search", {
      name: "search-excerpt-cap",
      query: "needle"
    });
    const payload = parseSearchPayload(result);

    expect(payload.results[0]?.truncated).toBe(true);
    expect(payload.results[0]?.excerpt).toContain("[TRUNCATED:");
  });

  it("does not alter skill.read or skill.view behavior", async () => {
    const harness = await skillToolHarness([loadedSkill({
      name: "search-alias-check",
      instructions: "# Root\n\nneedle"
    })]);

    const read = await harness.run("skill.read", { name: "search-alias-check" });
    const view = await harness.run("skill.view", { name: "search-alias-check" });
    const search = await harness.run("skill.search", {
      name: "search-alias-check",
      query: "needle"
    });

    expect(read.ok).toBe(true);
    expect(view.metadata).toEqual(read.metadata);
    expect(parseSearchPayload(search).results[0]?.path).toBe("SKILL.md");
  });
});

async function skillToolHarness(
  skills: Array<LoadedSkill | SkillDefinition>,
  options: {
    files?: Record<string, string | Buffer>;
    skillConfig?: Record<string, Record<string, unknown>>;
    skillEvolutionStore?: SkillEvolutionStore;
  } = {}
): Promise<{ run(toolName: "skill.read" | "skill.search" | "skill.view", input: Record<string, unknown>): Promise<ToolResult> }> {
  const root = await mkdtemp(join(tmpdir(), "skill-tools-test-"));
  const registry = new SkillRegistry();
  for (const skill of skills) {
    if (isLoadedSkill(skill)) {
      const skillRoot = join(root, skill.name);
      await mkdir(skillRoot, { recursive: true });
      await writeFile(join(skillRoot, "SKILL.md"), "{}", "utf8");
      for (const [path, content] of Object.entries(options.files ?? {})) {
        const absolute = join(skillRoot, path);
        await mkdir(dirname(absolute), { recursive: true });
        await writeFile(absolute, content);
      }
      registry.register({
        ...skill,
        sourcePath: join(skillRoot, "SKILL.md"),
        sourceRoot: root,
        resources: skill.resources ?? Object.keys(options.files ?? {}).map((path) => ({
          kind: "reference" as const,
          path
        }))
      });
    } else {
      registry.register(skill);
    }
  }
  const tools = createSkillTools({
    registry,
    localSkillsRoot: root,
    skillConfig: options.skillConfig,
    skillEvolutionStore: options.skillEvolutionStore
  });
  return {
    async run(toolName, input) {
      const tool = tools.find((candidate) => candidate.name === toolName);
      if (tool === undefined) {
        throw new Error(`${toolName} was not registered`);
      }
      return await tool.run(input);
    }
  };
}

type ParsedSkillSearchPayload = {
  name: string;
  query: string;
  maxResults: number;
  results: Array<{
    path: string;
    excerpt: string;
    heading?: string;
    line?: number;
    truncated?: boolean;
  }>;
  matchCount: number;
  truncated: boolean;
  skippedResources?: Array<{ path: string; reason: string }>;
};

function parseSearchPayload(result: ToolResult): ParsedSkillSearchPayload {
  expect(result.ok).toBe(true);
  return JSON.parse(result.content) as ParsedSkillSearchPayload;
}

async function expectSearchFailure(
  harness: { run(toolName: "skill.search", input: Record<string, unknown>): Promise<ToolResult> },
  input: Record<string, unknown>,
  message: string
): Promise<void> {
  const result = await harness.run("skill.search", input);
  expect(result.ok).toBe(false);
  expect(result.content).toContain(message);
}

function loadedSkill(overrides: Partial<LoadedSkill> = {}): LoadedSkill {
  const name = overrides.name ?? "loaded-skill";
  return {
    name,
    description: `Test skill ${name}.`,
    version: "0.1.0",
    category: "general",
    whenToUse: [],
    requiredToolsets: [],
    playbook: [],
    permissionExpectations: [],
    examples: [],
    evaluations: [],
    sourcePath: join(tmpdir(), name, "SKILL.md"),
    sourceKind: "local",
    sourceRoot: tmpdir(),
    instructions: "# Instructions\n\nUse the skill.",
    ...overrides
  };
}

function largeInstructions(): string {
  return [
    "# Large",
    "Detailed instructions.\n".repeat(420),
    "LARGE_ROOT_TAIL_MARKER"
  ].join("\n");
}

function routerForSkill(
  skill: LoadedSkill | SkillDefinition,
  skillConfig: Record<string, Record<string, unknown>>
): RuntimeRouter {
  const route: IntentRoute = {
    nativeIntent: "general",
    labels: ["general"],
    confidence: 1,
    suggestedToolsets: [],
    suggestedSkills: [skill],
    confirmationRequired: false,
    evidence: [],
    rationale: "test"
  };
  const intentRouter = {
    route: () => route
  } as unknown as IntentRouter;
  return new RuntimeRouter({
    intentRouter,
    skillConfig
  });
}

function isLoadedSkill(skill: LoadedSkill | SkillDefinition): skill is LoadedSkill {
  return "instructions" in skill && "sourcePath" in skill;
}
