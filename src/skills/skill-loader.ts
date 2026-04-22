import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { LoadedSkill, SkillDefinition, SkillPermissionExpectation, SkillSourceKind } from "../contracts/skill.js";

export type SkillLoadResult = {
  skills: LoadedSkill[];
  errors: SkillLoadError[];
};

export type SkillLoadOptions = {
  sourceKind?: SkillSourceKind;
  sourceRoot?: string;
};

export type SkillLoadError = {
  path: string;
  message: string;
};

export async function loadSkillsFromDirectory(root: string, options: SkillLoadOptions = {}): Promise<SkillLoadResult> {
  const skills: LoadedSkill[] = [];
  const errors: SkillLoadError[] = [];
  const skillFiles = await findSkillFiles(root);

  for (const path of skillFiles) {
    try {
      skills.push(parseSkillFile(path, await readFile(path, "utf8"), {
        sourceKind: options.sourceKind ?? "external",
        sourceRoot: options.sourceRoot ?? root
      }));
    } catch (error) {
      errors.push({
        path,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return { skills, errors };
}

export function parseSkillFile(
  sourcePath: string,
  content: string,
  options: { sourceKind?: SkillSourceKind; sourceRoot?: string } = {}
): LoadedSkill {
  const match = /^---\n(?<frontmatter>[\s\S]*?)\n---\n?(?<instructions>[\s\S]*)$/u.exec(content);

  if (match?.groups === undefined) {
    throw new Error("Skill file must start with frontmatter wrapped in --- markers");
  }

  const parsed = parseFrontmatter(match.groups.frontmatter);
  const definition = validateSkillDefinition(parsed);

  return {
    ...definition,
    sourcePath,
    sourceKind: options.sourceKind ?? "external",
    sourceRoot: options.sourceRoot ?? sourcePath,
    instructions: match.groups.instructions.trim()
  };
}

async function findSkillFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const path = join(root, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await findSkillFiles(path)));
      continue;
    }

    if (entry.isFile() && entry.name === "SKILL.md") {
      files.push(path);
    }
  }

  return files.sort();
}

function validateSkillDefinition(value: unknown): SkillDefinition {
  if (!isRecord(value)) {
    throw new Error("Skill frontmatter must be an object");
  }

  const definition = value as Partial<SkillDefinition> & {
    toolsets?: string[];
    tools?: string[];
    when_to_use?: string[];
    required_toolsets?: string[];
    permission_expectations?: string[];
    additional_files?: string[];
  };

  assertString(definition.name, "name");
  assertString(definition.description, "description");

  const normalized: SkillDefinition = {
    name: definition.name,
    description: definition.description,
    version: isNonEmptyString(definition.version) ? definition.version : "0.1.0",
    category: isNonEmptyString(definition.category) ? definition.category : inferHermesCategory(definition.metadata),
    platforms: stringArrayOrEmpty(definition.platforms),
    references: [
      ...stringArrayOrEmpty(definition.references),
      ...stringArrayOrEmpty(definition.additional_files)
    ],
    metadata: definition.metadata,
    whenToUse: stringArrayOrDefault(definition.whenToUse ?? definition.when_to_use, [definition.description]),
    requiredToolsets: stringArrayOrDefault(definition.requiredToolsets ?? definition.required_toolsets ?? definition.toolsets ?? definition.tools, ["core"]),
    inputs: definition.inputs,
    outputs: definition.outputs,
    workflow: Array.isArray(definition.workflow) && definition.workflow.length > 0
      ? definition.workflow
      : [
          {
            id: "run",
            description: definition.description,
            toolsets: stringArrayOrDefault(definition.requiredToolsets ?? definition.required_toolsets ?? definition.toolsets ?? definition.tools, ["core"])
          }
        ],
    permissionExpectations: skillPermissionExpectations(definition.permissionExpectations ?? definition.permission_expectations),
    examples: stringArrayOrDefault(definition.examples, []),
    evaluations: Array.isArray(definition.evaluations) ? definition.evaluations : []
  };

  return normalized;
}

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Skill field ${field} must be a non-empty string`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function stringArrayOrDefault(value: unknown, fallback: string[]): string[] {
  const array = stringArrayOrEmpty(value);
  return array.length === 0 ? fallback : array;
}

function stringArrayOrEmpty(value: unknown): string[] {
  if (typeof value === "string" && value.trim().length > 0) {
    return [value.trim()];
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isNonEmptyString).map((entry) => entry.trim());
}

function inferHermesCategory(metadata: unknown): string | undefined {
  if (!isRecord(metadata)) {
    return undefined;
  }

  const hermes = metadata.hermes;
  if (!isRecord(hermes) || !isNonEmptyString(hermes.category)) {
    return undefined;
  }

  return hermes.category;
}

function skillPermissionExpectations(value: unknown): SkillPermissionExpectation[] {
  const allowed = new Set<SkillPermissionExpectation>([
    "auto-read",
    "auto-active-channel-reply",
    "ask-before-write",
    "ask-before-external-send",
    "ask-before-credential-access",
    "ask-before-destructive-action"
  ]);
  const values = stringArrayOrDefault(value, ["auto-read"])
    .filter((entry): entry is SkillPermissionExpectation => allowed.has(entry as SkillPermissionExpectation));

  return values.length === 0 ? ["auto-read"] : values;
}

function parseFrontmatter(frontmatter: string): unknown {
  const trimmed = frontmatter.trim();

  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed) as unknown;
  }

  return parseSimpleYaml(trimmed);
}

function parseSimpleYaml(input: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; value: Record<string, unknown> }> = [{ indent: -1, value: root }];
  const lines = input.split(/\r?\n/u);

  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index];

    if (raw.trim().length === 0 || raw.trimStart().startsWith("#")) {
      continue;
    }

    const indent = raw.match(/^\s*/u)?.[0].length ?? 0;
    const line = raw.trim();
    const match = /^(?<key>[A-Za-z0-9_-]+):(?:\s*(?<value>.*))?$/u.exec(line);

    if (match?.groups === undefined) {
      continue;
    }

    while (stack.length > 1 && indent <= stack[stack.length - 1]!.indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1]!.value;
    const key = camelize(match.groups.key);
    const rawValue = match.groups.value ?? "";
    const nextArray = collectIndentedArray(lines, index, indent);

    if (rawValue.length === 0 && nextArray.values.length > 0) {
      parent[key] = nextArray.values;
      index = nextArray.endIndex;
      continue;
    }

    if (rawValue.length === 0) {
      const child: Record<string, unknown> = {};
      parent[key] = child;
      stack.push({ indent, value: child });
      continue;
    }

    parent[key] = parseYamlScalar(rawValue);
  }

  return root;
}

function collectIndentedArray(lines: string[], startIndex: number, parentIndent: number): {
  values: string[];
  endIndex: number;
} {
  const values: string[] = [];
  let endIndex = startIndex;

  for (let index = startIndex + 1; index < lines.length; index++) {
    const raw = lines[index];
    const indent = raw.match(/^\s*/u)?.[0].length ?? 0;
    const line = raw.trim();

    if (line.length === 0) {
      endIndex = index;
      continue;
    }

    if (indent <= parentIndent || !line.startsWith("- ")) {
      break;
    }

    values.push(stripYamlQuotes(line.slice(2).trim()));
    endIndex = index;
  }

  return { values, endIndex };
}

function parseYamlScalar(value: string): unknown {
  const trimmed = value.trim();

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((entry) => stripYamlQuotes(entry.trim()))
      .filter((entry) => entry.length > 0);
  }

  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(\.\d+)?$/u.test(trimmed)) return Number(trimmed);

  return stripYamlQuotes(trimmed);
}

function stripYamlQuotes(value: string): string {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }

  return value;
}

function camelize(value: string): string {
  return value.replace(/_([a-z])/gu, (_, char: string) => char.toUpperCase());
}
