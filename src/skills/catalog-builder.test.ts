import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildSkillsCatalog,
  extractJsonFrontmatter,
  SkillsCatalogError
} from "./catalog-builder.js";

describe("skills catalog builder", () => {
  it("parses valid JSON frontmatter", () => {
    const parsed = extractJsonFrontmatter(
      [
        "---",
        JSON.stringify(validFrontmatter({ name: "Valid Skill" }), null, 2),
        "---",
        "",
        "# Valid Skill",
        "",
        "Useful overview."
      ].join("\n"),
      "skills/official/valid/SKILL.md"
    );

    expect(parsed.frontmatter.name).toBe("Valid Skill");
    expect(parsed.body).toContain("Useful overview.");
  });

  it("fails on invalid JSON frontmatter", () => {
    expect(() =>
      extractJsonFrontmatter("---\n{ invalid }\n---\nbody", "skills/official/broken/SKILL.md")
    ).toThrow(SkillsCatalogError);
  });

  it("fails when required fields are missing", async () => {
    const repoRoot = await createTempRepo();
    await writeSourceRegistry(repoRoot, [{ path: "skills/official", sourceType: "official" }]);
    await writeSkill(repoRoot, "skills/official/missing/SKILL.md", {
      description: "Missing a name.",
      routing: { labels: ["missing"], confirmation: "policy" },
      requiredToolsets: ["files"],
      playbook: [],
      evaluations: []
    });

    await expect(buildSkillsCatalog({ repoRoot, writeOutput: false })).rejects.toThrow(/name/);
  });

  it("derives deterministic ids from source type and folder slug", async () => {
    const repoRoot = await createTempRepo();
    await writeSourceRegistry(repoRoot, [{ path: "skills/official", sourceType: "official" }]);
    await writeSkill(repoRoot, "skills/official/alpha-skill/SKILL.md", validFrontmatter({
      name: "A Display Name"
    }));

    const first = await buildSkillsCatalog({
      repoRoot,
      generatedAt: "2026-06-12T00:00:00.000Z",
      writeOutput: false
    });
    const second = await buildSkillsCatalog({
      repoRoot,
      generatedAt: "2026-06-12T00:00:00.000Z",
      writeOutput: false
    });

    expect(first.catalog.skills[0]?.id).toBe("official.alpha-skill");
    expect(second.catalog.skills).toEqual(first.catalog.skills);
  });

  it("emits display-safe public names without changing ids or slugs", async () => {
    const repoRoot = await createTempRepo();
    await writeSourceRegistry(repoRoot, [{ path: "skills/official", sourceType: "official" }]);
    await writeSkill(repoRoot, "skills/official/ascii-video/SKILL.md", validFrontmatter({
      name: "ascii-video"
    }));
    await writeSkill(repoRoot, "skills/official/product-builder/SKILL.md", validFrontmatter({
      name: "product-builder"
    }));
    await writeSkill(repoRoot, "skills/official/skillify/SKILL.md", validFrontmatter({
      name: "skillify"
    }));

    const result = await buildSkillsCatalog({ repoRoot, writeOutput: false });

    expect(result.catalog.skills.map((skill) => ({
      id: skill.id,
      slug: skill.slug,
      name: skill.name
    }))).toEqual([
      { id: "official.ascii-video", slug: "ascii-video", name: "ASCII Video" },
      {
        id: "official.product-builder",
        slug: "product-builder",
        name: "Product Builder"
      },
      {
        id: "official.skillify",
        slug: "skillify",
        name: "Skillify"
      }
    ]);
  });

  it("prefers explicit display frontmatter fields over humanized machine names", async () => {
    const repoRoot = await createTempRepo();
    await writeSourceRegistry(repoRoot, [{ path: "skills/official", sourceType: "official" }]);
    await writeSkill(repoRoot, "skills/official/ascii-video/SKILL.md", validFrontmatter({
      name: "ascii-video",
      displayName: "Custom ASCII Studio"
    }));

    const result = await buildSkillsCatalog({ repoRoot, writeOutput: false });

    expect(result.catalog.skills[0]).toMatchObject({
      id: "official.ascii-video",
      slug: "ascii-video",
      name: "Custom ASCII Studio"
    });
  });

  it("sorts output by source priority, display name, and id", async () => {
    const repoRoot = await createTempRepo();
    await writeSourceRegistry(repoRoot, [
      { id: "optional", path: "skills/optional", sourceType: "optional", label: "Optional" },
      { id: "official", path: "skills/official", sourceType: "official", label: "Official" }
    ]);
    await writeSkill(repoRoot, "skills/optional/aaa/SKILL.md", validFrontmatter({ name: "A Skill" }));
    await writeSkill(repoRoot, "skills/official/zzz/SKILL.md", validFrontmatter({ name: "Z Skill" }));
    await writeSkill(repoRoot, "skills/official/aaa/SKILL.md", validFrontmatter({ name: "A Skill" }));

    const result = await buildSkillsCatalog({ repoRoot, writeOutput: false });

    expect(result.catalog.skills.map((skill) => skill.id)).toEqual([
      "official.aaa",
      "official.zzz",
      "optional.aaa"
    ]);
  });

  it("writes generated files to website/static/api", async () => {
    const repoRoot = await createTempRepo();
    await writeSourceRegistry(repoRoot, [{ path: "skills/official", sourceType: "official" }]);
    await writeSkill(repoRoot, "skills/official/write-test/SKILL.md", validFrontmatter({
      name: "Write Test"
    }));

    const result = await buildSkillsCatalog({
      repoRoot,
      generatedAt: "2026-06-12T00:00:00.000Z"
    });

    expect(path.relative(repoRoot, result.outputPaths.skills)).toBe("website/static/api/skills.json");
    expect(path.relative(repoRoot, result.outputPaths.meta)).toBe("website/static/api/skills-meta.json");
    await expect(readJson(result.outputPaths.skills)).resolves.toMatchObject({
      schemaVersion: 1,
      skills: [{ id: "official.write-test" }]
    });
    await expect(readJson(result.outputPaths.meta)).resolves.toMatchObject({
      schemaVersion: 1,
      counts: { total: 1 }
    });
  });

  it("preserves generatedAt when existing output is semantically unchanged", async () => {
    const repoRoot = await createTempRepo();
    await writeSourceRegistry(repoRoot, [{ path: "skills/official", sourceType: "official" }]);
    await writeSkill(repoRoot, "skills/official/stable/SKILL.md", validFrontmatter({
      name: "Stable Skill"
    }));

    const first = await buildSkillsCatalog({
      repoRoot,
      generatedAt: "2026-06-12T00:00:00.000Z"
    });
    const second = await buildSkillsCatalog({
      repoRoot,
      generatedAt: "2026-06-13T00:00:00.000Z"
    });

    await expect(readJson(first.outputPaths.skills)).resolves.toMatchObject({
      generatedAt: "2026-06-12T00:00:00.000Z"
    });
    await expect(readJson(first.outputPaths.meta)).resolves.toMatchObject({
      generatedAt: "2026-06-12T00:00:00.000Z"
    });
    expect(second.catalog.generatedAt).toBe("2026-06-12T00:00:00.000Z");
    expect(second.meta.generatedAt).toBe("2026-06-12T00:00:00.000Z");
  });

  it("uses a fresh generatedAt when catalog content changes", async () => {
    const repoRoot = await createTempRepo();
    await writeSourceRegistry(repoRoot, [{ path: "skills/official", sourceType: "official" }]);
    await writeSkill(repoRoot, "skills/official/changing/SKILL.md", validFrontmatter({
      name: "Changing Skill"
    }));

    await buildSkillsCatalog({
      repoRoot,
      generatedAt: "2026-06-12T00:00:00.000Z"
    });
    await writeSkill(repoRoot, "skills/official/changing/SKILL.md", validFrontmatter({
      description: "Changed description."
    }));
    const result = await buildSkillsCatalog({
      repoRoot,
      generatedAt: "2026-06-13T00:00:00.000Z"
    });

    expect(result.catalog.generatedAt).toBe("2026-06-13T00:00:00.000Z");
    expect(result.meta.generatedAt).toBe("2026-06-13T00:00:00.000Z");
    await expect(readJson(result.outputPaths.skills)).resolves.toMatchObject({
      generatedAt: "2026-06-13T00:00:00.000Z",
      skills: [{ description: "Changed description." }]
    });
  });

  it("emits non-fatal warnings for weak routing metadata", async () => {
    const repoRoot = await createTempRepo();
    await writeSourceRegistry(repoRoot, [{ path: "skills/official", sourceType: "official" }]);
    await writeSkill(repoRoot, "skills/official/weak-route/SKILL.md", validFrontmatter({
      routing: {
        labels: ["weak"],
        triggerPatterns: [{ type: "contains", value: "write" }],
        confirmation: "policy"
      },
      permissionExpectations: [],
      evaluations: [{ input: "write something" }]
    }));

    const result = await buildSkillsCatalog({ repoRoot, writeOutput: false });

    expect(result.catalog.skills).toHaveLength(1);
    expect(result.warnings).toEqual(expect.arrayContaining([
      "skills/official/weak-route/SKILL.md: routing.negativePatterns or negativePatterns is missing or empty",
      "skills/official/weak-route/SKILL.md: routing.triggerPatterns may be too broad: write",
      "skills/official/weak-route/SKILL.md: evaluations has no routing expectation",
      "skills/official/weak-route/SKILL.md: permissionExpectations is missing or empty"
    ]));
  });

  it("does not warn when routing metadata is explicit enough", async () => {
    const repoRoot = await createTempRepo();
    await writeSourceRegistry(repoRoot, [{ path: "skills/official", sourceType: "official" }]);
    await writeSkill(repoRoot, "skills/official/strong-route/SKILL.md", validFrontmatter({
      name: "Strong Route"
    }));

    const result = await buildSkillsCatalog({ repoRoot, writeOutput: false });

    expect(result.warnings).toEqual([]);
  });
});

async function createTempRepo(): Promise<string> {
  const repoRoot = await mkdtemp(path.join(tmpdir(), "estacoda-skills-catalog-"));
  await mkdir(path.join(repoRoot, "registries"), { recursive: true });
  return repoRoot;
}

async function writeSourceRegistry(
  repoRoot: string,
  sources: Array<{
    id?: string;
    path: string;
    sourceType: "official" | "optional" | "community" | "experimental";
    label?: string;
  }>
): Promise<void> {
  for (const source of sources) {
    await mkdir(path.join(repoRoot, source.path), { recursive: true });
  }
  await writeFile(
    path.join(repoRoot, "registries/skills.sources.json"),
    `${JSON.stringify(
      sources.map((source) => ({
        id: source.id ?? source.sourceType,
        type: "local",
        path: source.path,
        sourceType: source.sourceType,
        label: source.label ?? source.sourceType
      })),
      null,
      2
    )}\n`,
    "utf8"
  );
}

async function writeSkill(
  repoRoot: string,
  skillPath: string,
  frontmatter: Record<string, unknown>,
  body = "# Skill\n\nUseful overview paragraph.\n"
): Promise<void> {
  const absolutePath = path.join(repoRoot, skillPath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(
    absolutePath,
    ["---", JSON.stringify(frontmatter, null, 2), "---", "", body].join("\n"),
    "utf8"
  );
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function validFrontmatter(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Example Skill",
    description: "Example description.",
    routing: {
      labels: ["example"],
      triggerPatterns: [{ type: "contains", value: "example skill" }],
      negativePatterns: [{ type: "contains", value: "example skill issue" }],
      confirmation: "policy"
    },
    requiredToolsets: ["files"],
    optionalToolsets: [],
    permissionExpectations: ["auto-read"],
    playbook: [{ id: "do-work" }],
    evaluations: [{ input: "example", expected: { selectedSkill: "Example Skill" } }],
    ...overrides
  };
}
