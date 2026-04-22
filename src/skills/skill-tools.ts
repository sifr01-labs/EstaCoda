import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { LoadedSkill, SkillDefinition } from "../contracts/skill.js";
import type { RegisteredTool, ToolResult } from "../contracts/tool.js";
import { loadSkillsFromDirectory, parseSkillFile } from "./skill-loader.js";
import type { SkillRegistry } from "./skill-registry.js";

export type SkillToolsOptions = {
  registry: SkillRegistry;
  personalSkillsRoot: string;
  projectSkillsRoot?: string;
};

export function createSkillTools(options: SkillToolsOptions): readonly RegisteredTool[] {
  return [
    {
      name: "skill.list",
      description: "List available skills with source and category metadata.",
      inputSchema: {
        type: "object",
        properties: {
          category: { type: "string" }
        }
      },
      riskClass: "read-only-local",
      toolsets: ["core", "research"],
      progressLabel: "listing skills",
      maxResultSizeChars: 12_000,
      isAvailable: () => true,
      run: async (input: { category?: string }) => {
        const catalog = options.registry.catalog()
          .filter((skill) => input.category === undefined || skill.category === input.category);

        return {
          ok: true,
          content: catalog.length === 0
            ? "No skills found."
            : catalog
                .map((skill) => `${skill.name}\t${skill.category}\t${skill.sourceKind ?? "runtime"}\t${skill.description}`)
                .join("\n"),
          metadata: {
            count: catalog.length,
            skills: catalog
          }
        };
      }
    },
    {
      name: "skill.view",
      description: "View full instructions for a loaded skill.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          path: { type: "string" }
        },
        required: ["name"]
      },
      riskClass: "read-only-local",
      toolsets: ["core", "research"],
      progressLabel: "viewing skill",
      maxResultSizeChars: 24_000,
      isAvailable: () => true,
      run: async (input: { name?: string; path?: string }) => {
        const skill = getSkill(options.registry, input.name);
        if (!skill.ok) {
          return skill;
        }
        const foundSkill = skill.skill;

        if (isLoadedSkill(foundSkill) && isNonEmptyString(input.path)) {
          return readSkillReference(foundSkill, input.path);
        }

        return {
          ok: true,
          content: "instructions" in foundSkill
            ? `# ${foundSkill.name}\n\n${foundSkill.instructions}`
            : `# ${foundSkill.name}\n\n${foundSkill.description}`,
          metadata: toSkillMetadata(foundSkill)
        };
      }
    },
    {
      name: "skill.inspect",
      description: "Inspect skill metadata, workflow, examples, and evaluations without loading extra files.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" }
        },
        required: ["name"]
      },
      riskClass: "read-only-local",
      toolsets: ["core", "research"],
      progressLabel: "inspecting skill",
      maxResultSizeChars: 16_000,
      isAvailable: () => true,
      run: async (input: { name?: string }) => {
        const skill = getSkill(options.registry, input.name);
        if (!skill.ok) {
          return skill;
        }
        const foundSkill = skill.skill;

        return {
          ok: true,
          content: JSON.stringify(toSkillMetadata(foundSkill), null, 2),
          metadata: toSkillMetadata(foundSkill)
        };
      }
    },
    {
      name: "skill.create",
      description: "Create a personal SKILL.md file from metadata and instructions.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          category: { type: "string" },
          instructions: { type: "string" },
          whenToUse: { type: "array", items: { type: "string" } },
          requiredToolsets: { type: "array", items: { type: "string" } }
        },
        required: ["name", "description", "instructions"]
      },
      riskClass: "workspace-write",
      toolsets: ["core", "files", "coding"],
      progressLabel: "creating skill",
      maxResultSizeChars: 4000,
      isAvailable: () => true,
      run: async (input: {
        name?: string;
        description?: string;
        category?: string;
        instructions?: string;
        whenToUse?: string[];
        requiredToolsets?: string[];
      }) => {
        if (!isNonEmptyString(input.name) || !isNonEmptyString(input.description) || !isNonEmptyString(input.instructions)) {
          return errorResult("skill.create requires name, description, and instructions");
        }

        const skillDir = join(options.personalSkillsRoot, slugify(input.name));
        const skillPath = join(skillDir, "SKILL.md");
        const definition = defaultSkillDefinition({
          name: input.name,
          description: input.description,
          category: input.category,
          whenToUse: input.whenToUse,
          requiredToolsets: input.requiredToolsets
        });
        const content = renderSkillFile(definition, input.instructions);

        await mkdir(skillDir, { recursive: true });
        await writeFile(skillPath, content, "utf8");
        const loaded = parseSkillFile(skillPath, content, {
          sourceKind: "personal",
          sourceRoot: options.personalSkillsRoot
        });
        options.registry.register(loaded);

        return {
          ok: true,
          content: `Created skill ${loaded.name} at ${skillPath}.`,
          metadata: toSkillMetadata(loaded)
        };
      }
    },
    {
      name: "skill.import",
      description: "Import skills from an existing directory containing SKILL.md files.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          sourceKind: { type: "string" }
        },
        required: ["path"]
      },
      riskClass: "workspace-write",
      toolsets: ["core", "files", "coding"],
      progressLabel: "importing skills",
      maxResultSizeChars: 8000,
      isAvailable: () => true,
      run: async (input: { path?: string; sourceKind?: "personal" | "project" | "external" | "official" }) => {
        if (!isNonEmptyString(input.path)) {
          return errorResult("skill.import requires path");
        }

        const root = resolve(input.path);
        const loaded = await loadSkillsFromDirectory(root, {
          sourceKind: input.sourceKind ?? "external",
          sourceRoot: root
        });

        for (const skill of loaded.skills) {
          options.registry.register(skill);
        }

        return {
          ok: loaded.errors.length === 0,
          content: [
            `Imported ${loaded.skills.length} skill(s) from ${root}.`,
            ...loaded.errors.map((error) => `Error ${error.path}: ${error.message}`)
          ].join("\n"),
          metadata: {
            imported: loaded.skills.map(toSkillMetadata),
            errors: loaded.errors
          }
        };
      }
    },
    {
      name: "skill.export",
      description: "Export a loaded skill to a destination directory as SKILL.md.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          destination: { type: "string" }
        },
        required: ["name", "destination"]
      },
      riskClass: "workspace-write",
      toolsets: ["core", "files", "coding"],
      progressLabel: "exporting skill",
      maxResultSizeChars: 4000,
      isAvailable: () => true,
      run: async (input: { name?: string; destination?: string }) => {
        const skill = getSkill(options.registry, input.name);
        if (!skill.ok) {
          return skill;
        }
        const foundSkill = skill.skill;

        if (!isNonEmptyString(input.destination)) {
          return errorResult("skill.export requires destination");
        }

        const destination = resolve(input.destination, slugify(foundSkill.name), "SKILL.md");
        await mkdir(dirname(destination), { recursive: true });

        if ("sourcePath" in foundSkill) {
          await writeFile(destination, await readFile(foundSkill.sourcePath, "utf8"), "utf8");
        } else {
          await writeFile(destination, renderSkillFile(foundSkill, foundSkill.description), "utf8");
        }

        return {
          ok: true,
          content: `Exported ${foundSkill.name} to ${destination}.`,
          metadata: {
            destination,
            skill: toSkillMetadata(foundSkill)
          }
        };
      }
    }
  ];
}

type GetSkillResult =
  | { ok: true; content: ""; skill: LoadedSkill | SkillDefinition }
  | { ok: false; content: string };

function getSkill(registry: SkillRegistry, name: string | undefined): GetSkillResult {
  if (!isNonEmptyString(name)) {
    return skillError("skill name is required");
  }

  const skill = registry.get(name);

  if (skill === undefined) {
    return skillError(`Skill not found: ${name}`);
  }

  return {
    ok: true,
    content: "",
    skill
  };
}

function toSkillMetadata(skill: LoadedSkill | SkillDefinition): Record<string, unknown> {
  return {
    name: skill.name,
    description: skill.description,
    version: skill.version,
    category: skill.category ?? "general",
    whenToUse: skill.whenToUse,
    requiredToolsets: skill.requiredToolsets,
    workflow: skill.workflow,
    permissionExpectations: skill.permissionExpectations,
    examples: skill.examples,
    evaluations: skill.evaluations,
    platforms: skill.platforms,
    references: skill.references,
    metadata: skill.metadata,
    sourcePath: "sourcePath" in skill ? skill.sourcePath : undefined,
    sourceKind: "sourceKind" in skill ? skill.sourceKind : undefined,
    sourceRoot: "sourceRoot" in skill ? skill.sourceRoot : undefined
  };
}

function defaultSkillDefinition(input: {
  name: string;
  description: string;
  category?: string;
  whenToUse?: string[];
  requiredToolsets?: string[];
}): SkillDefinition {
  return {
    name: input.name,
    description: input.description,
    version: "0.1.0",
    category: input.category,
    whenToUse: input.whenToUse ?? [input.description],
    requiredToolsets: input.requiredToolsets ?? ["core"],
    workflow: [
      {
        id: "run",
        description: input.description,
        toolsets: input.requiredToolsets ?? ["core"]
      }
    ],
    permissionExpectations: ["auto-read"],
    examples: [],
    evaluations: []
  };
}

function renderSkillFile(definition: SkillDefinition, instructions: string): string {
  return `---\n${renderYamlFrontmatter(definition)}---\n${instructions.trim()}\n`;
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]+/g, "-").replace(/^-|-$/g, "") || basename(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function errorResult(content: string): ToolResult {
  return {
    ok: false,
    content
  };
}

function skillError(content: string): GetSkillResult {
  return {
    ok: false,
    content
  };
}

function isLoadedSkill(skill: LoadedSkill | SkillDefinition): skill is LoadedSkill {
  return "sourcePath" in skill && "instructions" in skill;
}

async function readSkillReference(skill: LoadedSkill, path: string): Promise<ToolResult> {
  const skillRoot = await realpath(dirname(skill.sourcePath));
  const candidate = resolve(skillRoot, path);
  const canonical = await realpath(candidate).catch(() => undefined);

  if (canonical === undefined) {
    return errorResult(`Skill reference not found: ${path}`);
  }

  const relativePath = relative(skillRoot, canonical);
  if (relativePath.startsWith("..") || relativePath.startsWith("/")) {
    return errorResult("Skill reference path is outside the skill directory.");
  }

  const content = await readFile(canonical, "utf8");

  return {
    ok: true,
    content: `# ${skill.name} / ${relativePath}\n\n${content.slice(0, 24_000)}`,
    metadata: {
      skill: skill.name,
      path: relativePath,
      bytes: Buffer.byteLength(content),
      truncated: content.length > 24_000
    }
  };
}

function renderYamlFrontmatter(definition: SkillDefinition): string {
  return [
    `name: ${quoteYaml(definition.name)}`,
    `description: ${quoteYaml(definition.description)}`,
    `version: ${quoteYaml(definition.version)}`,
    definition.category === undefined ? undefined : `category: ${quoteYaml(definition.category)}`,
    renderYamlArray("whenToUse", definition.whenToUse),
    renderYamlArray("requiredToolsets", definition.requiredToolsets),
    "workflow:",
    ...definition.workflow.flatMap((step) => [
      `  - id: ${quoteYaml(step.id)}`,
      `    description: ${quoteYaml(step.description)}`,
      step.toolsets === undefined ? undefined : `    toolsets: [${step.toolsets.map(quoteYaml).join(", ")}]`
    ].filter((line) => line !== undefined)),
    renderYamlArray("permissionExpectations", definition.permissionExpectations),
    renderYamlArray("examples", definition.examples),
    "evaluations: []"
  ].filter((line) => line !== undefined).join("\n") + "\n";
}

function renderYamlArray(key: string, values: readonly string[]): string {
  return `${key}: [${values.map(quoteYaml).join(", ")}]`;
}

function quoteYaml(value: string): string {
  return JSON.stringify(value);
}
