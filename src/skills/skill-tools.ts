import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { LoadedSkill, SkillDefinition } from "../contracts/skill.js";
import type { RegisteredTool, ToolResult } from "../contracts/tool.js";
import { hydrateSkillResources, loadSkillsFromDirectory, parseSkillFile } from "./skill-loader.js";
import type { SkillRegistry } from "./skill-registry.js";

export type SkillToolsOptions = {
  registry: SkillRegistry;
  visibleRegistry?: SkillRegistry;
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
        const catalog = (options.visibleRegistry ?? options.registry).catalog()
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
      description: "Create a personal skill from full SKILL.md content or from metadata and instructions.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          content: { type: "string" },
          description: { type: "string" },
          category: { type: "string" },
          instructions: { type: "string" },
          whenToUse: { type: "array", items: { type: "string" } },
          requiredToolsets: { type: "array", items: { type: "string" } }
        },
        required: ["name"]
      },
      riskClass: "workspace-write",
      toolsets: ["core", "files", "coding"],
      progressLabel: "creating skill",
      maxResultSizeChars: 4000,
      isAvailable: () => true,
      run: async (input: {
        name?: string;
        content?: string;
        description?: string;
        category?: string;
        instructions?: string;
        whenToUse?: string[];
        requiredToolsets?: string[];
      }) => {
        if (!isNonEmptyString(input.name)) {
          return errorResult("skill.create requires name");
        }

        const skillDir = personalSkillDirectory(options, input.name);
        const skillPath = join(skillDir, "SKILL.md");
        let content: string;
        try {
          content = isNonEmptyString(input.content)
            ? input.content
            : buildSkillFileContent(input);
        } catch (error) {
          return errorResult(error instanceof Error ? error.message : String(error));
        }

        const loaded = await hydrateSkillResources(parseSkillFile(skillPath, content, {
          sourceKind: "personal",
          sourceRoot: options.personalSkillsRoot
        }));
        if (loaded.name !== input.name) {
          return errorResult(`skill.create content name mismatch: expected ${input.name}, found ${loaded.name}`);
        }
        await mkdir(skillDir, { recursive: true });
        await writeFile(skillPath, content, "utf8");
        options.registry.register(loaded);

        return {
          ok: true,
          content: `Created skill ${loaded.name} at ${skillPath}.`,
          metadata: toSkillMetadata(loaded)
        };
      }
    },
    {
      name: "skill.patch",
      description: "Apply a targeted text replacement to a local personal skill SKILL.md file.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
          oldString: { type: "string" },
          newString: { type: "string" }
        },
        required: ["name", "old_string", "new_string"]
      },
      riskClass: "workspace-write",
      toolsets: ["core", "files", "coding"],
      progressLabel: "patching skill",
      maxResultSizeChars: 4000,
      isAvailable: () => true,
      run: async (input: {
        name?: string;
        old_string?: string;
        new_string?: string;
        oldString?: string;
        newString?: string;
      }) => {
        const oldString = firstNonEmptyString(input.old_string, input.oldString);
        const newString = firstDefinedString(input.new_string, input.newString);
        if (!isNonEmptyString(input.name) || !isNonEmptyString(oldString) || newString === undefined) {
          return errorResult("skill.patch requires name, old_string, and new_string");
        }

        const target = requirePersonalSkill(options, input.name);
        if (!isPersonalSkillTarget(target)) {
          return target;
        }

        const current = await readFile(target.skillPath, "utf8");
        if (!current.includes(oldString)) {
          return errorResult(`skill.patch could not find target text in ${target.skillPath}`);
        }

        const next = current.replace(oldString, newString);
        await writeFile(target.skillPath, next, "utf8");
        const loaded = await reloadPersonalSkill(options, target.skillPath);

        return {
          ok: true,
          content: `Patched skill ${loaded.name} at ${target.skillPath}.`,
          metadata: toSkillMetadata(loaded)
        };
      }
    },
    {
      name: "skill.edit",
      description: "Replace a local personal skill SKILL.md file with full content.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          content: { type: "string" }
        },
        required: ["name", "content"]
      },
      riskClass: "workspace-write",
      toolsets: ["core", "files", "coding"],
      progressLabel: "editing skill",
      maxResultSizeChars: 4000,
      isAvailable: () => true,
      run: async (input: { name?: string; content?: string }) => {
        if (!isNonEmptyString(input.name) || !isNonEmptyString(input.content)) {
          return errorResult("skill.edit requires name and content");
        }

        const target = requirePersonalSkill(options, input.name);
        if (!isPersonalSkillTarget(target)) {
          return target;
        }

        const loaded = await hydrateSkillResources(parseSkillFile(target.skillPath, input.content, {
          sourceKind: "personal",
          sourceRoot: options.personalSkillsRoot
        }));
        if (loaded.name !== input.name) {
          return errorResult(`skill.edit content name mismatch: expected ${input.name}, found ${loaded.name}`);
        }
        await writeFile(target.skillPath, input.content, "utf8");
        options.registry.register(loaded);

        return {
          ok: true,
          content: `Edited skill ${loaded.name} at ${target.skillPath}.`,
          metadata: toSkillMetadata(loaded)
        };
      }
    },
    {
      name: "skill.delete",
      description: "Delete a local personal skill directory.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" }
        },
        required: ["name"]
      },
      riskClass: "destructive-local",
      toolsets: ["core", "files", "coding"],
      progressLabel: "deleting skill",
      maxResultSizeChars: 4000,
      isAvailable: () => true,
      run: async (input: { name?: string }) => {
        if (!isNonEmptyString(input.name)) {
          return errorResult("skill.delete requires name");
        }

        const target = requirePersonalSkill(options, input.name);
        if (!isPersonalSkillTarget(target)) {
          return target;
        }

        await rm(target.skillDir, { recursive: true, force: true });
        options.registry.unregister(input.name);

        return {
          ok: true,
          content: `Deleted skill ${input.name} from ${target.skillDir}.`,
          metadata: {
            name: input.name,
            deleted: true,
            path: target.skillDir
          }
        };
      }
    },
    {
      name: "skill.write_file",
      description: "Write a supporting file inside a local personal skill directory.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          file_path: { type: "string" },
          file_content: { type: "string" },
          filePath: { type: "string" },
          fileContent: { type: "string" }
        },
        required: ["name", "file_path", "file_content"]
      },
      riskClass: "workspace-write",
      toolsets: ["core", "files", "coding"],
      progressLabel: "writing skill file",
      maxResultSizeChars: 4000,
      isAvailable: () => true,
      run: async (input: {
        name?: string;
        file_path?: string;
        file_content?: string;
        filePath?: string;
        fileContent?: string;
      }) => {
        const filePath = firstNonEmptyString(input.file_path, input.filePath);
        const fileContent = firstDefinedString(input.file_content, input.fileContent);
        if (!isNonEmptyString(input.name) || !isNonEmptyString(filePath) || fileContent === undefined) {
          return errorResult("skill.write_file requires name, file_path, and file_content");
        }

        const target = requirePersonalSkill(options, input.name);
        if (!isPersonalSkillTarget(target)) {
          return target;
        }

        const supportFile = resolveSkillSupportPath(target.skillDir, filePath);
        if (!isSkillSupportTarget(supportFile)) {
          return supportFile;
        }

        await mkdir(dirname(supportFile.path), { recursive: true });
        await writeFile(supportFile.path, fileContent, "utf8");

        return {
          ok: true,
          content: `Wrote ${supportFile.relativePath} for skill ${input.name}.`,
          metadata: {
            name: input.name,
            path: supportFile.relativePath,
            bytes: Buffer.byteLength(fileContent)
          }
        };
      }
    },
    {
      name: "skill.remove_file",
      description: "Remove a supporting file from a local personal skill directory.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          file_path: { type: "string" },
          filePath: { type: "string" }
        },
        required: ["name", "file_path"]
      },
      riskClass: "destructive-local",
      toolsets: ["core", "files", "coding"],
      progressLabel: "removing skill file",
      maxResultSizeChars: 4000,
      isAvailable: () => true,
      run: async (input: { name?: string; file_path?: string; filePath?: string }) => {
        const filePath = firstNonEmptyString(input.file_path, input.filePath);
        if (!isNonEmptyString(input.name) || !isNonEmptyString(filePath)) {
          return errorResult("skill.remove_file requires name and file_path");
        }

        const target = requirePersonalSkill(options, input.name);
        if (!isPersonalSkillTarget(target)) {
          return target;
        }

        const supportFile = resolveSkillSupportPath(target.skillDir, filePath);
        if (!isSkillSupportTarget(supportFile)) {
          return supportFile;
        }

        await rm(supportFile.path, { force: true });

        return {
          ok: true,
          content: `Removed ${supportFile.relativePath} from skill ${input.name}.`,
          metadata: {
            name: input.name,
            path: supportFile.relativePath,
            removed: true
          }
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
    visibility: skill.visibility,
    workflow: skill.workflow,
    permissionExpectations: skill.permissionExpectations,
    examples: skill.examples,
    evaluations: skill.evaluations,
    platforms: skill.platforms,
    references: skill.references,
    resources: "resources" in skill ? skill.resources : undefined,
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

function buildSkillFileContent(input: {
  name?: string;
  description?: string;
  category?: string;
  instructions?: string;
  whenToUse?: string[];
  requiredToolsets?: string[];
}): string {
  if (!isNonEmptyString(input.name) || !isNonEmptyString(input.description) || !isNonEmptyString(input.instructions)) {
    throw new Error("skill.create requires either content or description plus instructions");
  }

  const definition = defaultSkillDefinition({
    name: input.name,
    description: input.description,
    category: input.category,
    whenToUse: input.whenToUse,
    requiredToolsets: input.requiredToolsets
  });
  return renderSkillFile(definition, input.instructions);
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]+/g, "-").replace(/^-|-$/g, "") || basename(value);
}

function firstNonEmptyString(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => isNonEmptyString(value));
}

function firstDefinedString(...values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined);
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

function personalSkillDirectory(options: SkillToolsOptions, name: string): string {
  return join(options.personalSkillsRoot, slugify(name));
}

function requirePersonalSkill(
  options: SkillToolsOptions,
  name: string
): { ok: true; skillDir: string; skillPath: string } | ToolResult {
  const existing = options.registry.get(name);
  if (existing !== undefined) {
    if (!isLoadedSkill(existing) || existing.sourceKind !== "personal") {
      return errorResult(`Skill ${name} is not a local personal skill and cannot be modified here.`);
    }

    return {
      ok: true,
      skillDir: dirname(existing.sourcePath),
      skillPath: existing.sourcePath
    };
  }

  return errorResult(`Local personal skill not found: ${name}`);
}

function isPersonalSkillTarget(
  value: { ok: true; skillDir: string; skillPath: string } | ToolResult
): value is { ok: true; skillDir: string; skillPath: string } {
  return value.ok === true && "skillDir" in value && "skillPath" in value;
}

async function reloadPersonalSkill(options: SkillToolsOptions, skillPath: string): Promise<LoadedSkill> {
  const loaded = await hydrateSkillResources(parseSkillFile(skillPath, await readFile(skillPath, "utf8"), {
    sourceKind: "personal",
    sourceRoot: options.personalSkillsRoot
  }));
  options.registry.register(loaded);
  return loaded;
}

function resolveSkillSupportPath(
  skillDir: string,
  requestedPath: string
): { ok: true; path: string; relativePath: string } | ToolResult {
  const target = resolve(skillDir, requestedPath);
  const relativePath = relative(skillDir, target);

  if (
    relativePath.length === 0 ||
    relativePath.startsWith("..") ||
    relativePath.startsWith("/") ||
    relativePath === "SKILL.md"
  ) {
    return errorResult("Supporting file path must stay inside the skill directory and cannot target SKILL.md.");
  }

  return {
    ok: true,
    path: target,
    relativePath
  };
}

function isSkillSupportTarget(
  value: { ok: true; path: string; relativePath: string } | ToolResult
): value is { ok: true; path: string; relativePath: string } {
  return value.ok === true && "path" in value && "relativePath" in value;
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

  const content = await readFile(canonical);
  const metadata = await stat(canonical).catch(() => undefined);
  const inferredKind = skill.resources?.find((resource) => resource.path === relativePath)?.kind;

  if (!isProbablyText(content)) {
    return {
      ok: true,
      content: [
        `# ${skill.name} / ${relativePath}`,
        "",
        "This resource is not plain text. Use its metadata and route it through the appropriate media/document tool if you need to inspect the contents."
      ].join("\n"),
      metadata: {
        skill: skill.name,
        path: relativePath,
        kind: inferredKind ?? inferSkillResourceKind(relativePath),
        bytes: metadata?.size ?? content.byteLength,
        text: false
      }
    };
  }

  const decoded = content.toString("utf8");

  return {
    ok: true,
    content: `# ${skill.name} / ${relativePath}\n\n${decoded.slice(0, 24_000)}`,
    metadata: {
      skill: skill.name,
      path: relativePath,
      kind: inferredKind ?? inferSkillResourceKind(relativePath),
      bytes: metadata?.size ?? content.byteLength,
      text: true,
      truncated: decoded.length > 24_000
    }
  };
}

function isProbablyText(content: Buffer): boolean {
  const sample = content.subarray(0, Math.min(content.byteLength, 2048));
  let controlBytes = 0;
  for (const byte of sample) {
    if (byte === 0) {
      return false;
    }
    if (byte < 9 || (byte > 13 && byte < 32)) {
      controlBytes++;
    }
  }
  return controlBytes / Math.max(1, sample.byteLength) < 0.1;
}

function inferSkillResourceKind(path: string): string {
  if (path.startsWith("references/")) return "reference";
  if (path.startsWith("templates/")) return "template";
  if (path.startsWith("scripts/")) return "script";
  if (path.startsWith("assets/")) return "asset";
  return "resource";
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
