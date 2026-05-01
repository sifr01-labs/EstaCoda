import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import type {
  LoadedSkill,
  SkillConfigField,
  SkillDefinition,
  SkillEvaluation,
  SkillPattern,
  SkillPermissionExpectation,
  SkillRouting,
  SkillResourceEntry,
  SkillResourceKind,
  SkillSourceKind,
  SkillVisibilityRules,
  SkillWorkflowStep
} from "../contracts/skill.js";
import type { NativeIntent } from "../contracts/intent.js";
import type { ToolsetName } from "../contracts/tool.js";

const MAX_SKILL_SCAN_DEPTH = 8;
const MAX_SKILL_FILES = 500;

export type SkillLoadResult = {
  skills: LoadedSkill[];
  errors: SkillLoadError[];
};

export type SkillLoadOptions = {
  sourceKind?: SkillSourceKind;
  sourceRoot?: string;
  maxDepth?: number;
  maxFiles?: number;
};

export type SkillLoadError = {
  path: string;
  message: string;
};

export async function loadSkillsFromDirectory(root: string, options: SkillLoadOptions = {}): Promise<SkillLoadResult> {
  const skills: LoadedSkill[] = [];
  const errors: SkillLoadError[] = [];
  let skillFiles: string[];

  try {
    skillFiles = await findSkillFiles(root, {
      maxDepth: options.maxDepth ?? MAX_SKILL_SCAN_DEPTH,
      maxFiles: options.maxFiles ?? MAX_SKILL_FILES
    });
  } catch (error) {
    return {
      skills,
      errors: [{
        path: root,
        message: error instanceof Error ? error.message : String(error)
      }]
    };
  }

  for (const path of skillFiles) {
    try {
      const parsed = parseSkillFile(path, await readFile(path, "utf8"), {
        sourceKind: options.sourceKind ?? "external",
        sourceRoot: options.sourceRoot ?? root
      });
      skills.push(await hydrateSkillResources(parsed));
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

export async function hydrateSkillResources(skill: LoadedSkill): Promise<LoadedSkill> {
  return {
    ...skill,
    resources: await loadSkillResourceIndex(skill)
  };
}

async function findSkillFiles(
  root: string,
  options: { maxDepth: number; maxFiles: number },
  depth = 0,
  files: string[] = []
): Promise<string[]> {
  if (depth > options.maxDepth) {
    throw new Error(`Skill directory scan exceeded max depth ${options.maxDepth}: ${root}`);
  }
  if (files.length >= options.maxFiles) {
    throw new Error(`Skill directory scan exceeded max file count ${options.maxFiles}`);
  }

  const entries = await readdir(root, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }

    const path = join(root, entry.name);

    if (entry.isDirectory()) {
      await findSkillFiles(path, options, depth + 1, files);
      continue;
    }

    if (entry.isFile() && entry.name === "SKILL.md") {
      files.push(path);
      if (files.length >= options.maxFiles) {
        throw new Error(`Skill directory scan exceeded max file count ${options.maxFiles}`);
      }
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
    required_environment_variables?: string[];
    required_credential_files?: string[];
    permission_expectations?: string[];
    additional_files?: string[];
    intent_labels?: string[];
    trigger_patterns?: string[];
    negative_patterns?: string[];
    optional_toolsets?: string[];
    visibility?: Record<string, unknown>;
    routing?: unknown;
  };
  const inferredVisibility = mergeVisibilityRules(
    parseVisibilityRules(definition.visibility),
    inferHermesVisibility(definition.metadata)
  );
  const inferredConfigFields = inferHermesConfigFields(definition.metadata);

  assertString(definition.name, "name");
  assertString(definition.description, "description");

  const legacyIntentLabels = stringArrayOrEmpty(definition.intentLabels ?? definition.intent_labels);
  const legacyTriggerPatterns = legacyPatternArray(definition.triggerPatterns ?? definition.trigger_patterns);
  const legacyNegativePatterns = legacyPatternArray(definition.negativePatterns ?? definition.negative_patterns);
  const requiredToolsets = stringArrayOrDefault(definition.requiredToolsets ?? definition.required_toolsets ?? definition.toolsets ?? definition.tools, ["core"]);
  const routing = normalizeSkillRouting(definition.routing, {
    labels: legacyIntentLabels,
    triggerPatterns: legacyTriggerPatterns,
    negativePatterns: legacyNegativePatterns,
    requiredToolsets
  });

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
    routing,
    intentLabels: legacyIntentLabels,
    triggerPatterns: legacyTriggerPatterns.map(patternToLegacyString),
    negativePatterns: legacyNegativePatterns.map(patternToLegacyString),
    whenToUse: stringArrayOrDefault(definition.whenToUse ?? definition.when_to_use, [definition.description]),
    requiredToolsets,
    optionalToolsets: stringArrayOrEmpty(definition.optionalToolsets ?? definition.optional_toolsets),
    requiredEnvironmentVariables: stringArrayOrEmpty(definition.requiredEnvironmentVariables ?? definition.required_environment_variables),
    requiredCredentialFiles: stringArrayOrEmpty(definition.requiredCredentialFiles ?? definition.required_credential_files),
    configFields: inferredConfigFields,
    visibility: inferredVisibility,
    inputs: definition.inputs,
    outputs: definition.outputs,
    workflow: normalizeWorkflow(definition.workflow, {
      id: "run",
      description: definition.description,
      toolsets: requiredToolsets
    }),
    permissionExpectations: skillPermissionExpectations(definition.permissionExpectations ?? definition.permission_expectations),
    examples: stringArrayOrDefault(definition.examples, []),
    evaluations: normalizeEvaluations(definition.evaluations)
  };

  return normalized;
}

function normalizeSkillRouting(value: unknown, legacy: Required<Pick<SkillRouting, "labels" | "triggerPatterns" | "negativePatterns" | "requiredToolsets">>): SkillRouting {
  const explicit = isRecord(value) ? value : {};
  const labels = dedupeStrings([
    ...normalizeStringList(explicit.labels),
    ...legacy.labels
  ]);
  const triggerPatterns = dedupePatterns([
    ...normalizeSkillPatterns(explicit.triggerPatterns),
    ...legacy.triggerPatterns
  ]);
  const negativePatterns = dedupePatterns([
    ...normalizeSkillPatterns(explicit.negativePatterns),
    ...legacy.negativePatterns
  ]);
  const requiredToolsets = dedupeStrings([
    ...normalizeStringList(explicit.requiredToolsets),
    ...legacy.requiredToolsets
  ]) as ToolsetName[];
  const confirmation = normalizeConfirmation(explicit.confirmation);
  const deferWhen = normalizeDeferRules(explicit.deferWhen);
  const priority = typeof explicit.priority === "number" && Number.isFinite(explicit.priority)
    ? explicit.priority
    : undefined;

  return {
    labels,
    triggerPatterns,
    negativePatterns,
    requiredToolsets,
    confirmation,
    deferWhen,
    priority
  };
}

function legacyPatternArray(value: unknown): SkillPattern[] {
  return normalizeStringList(value).map((pattern) => ({
    type: "regex",
    value: pattern
  }));
}

function normalizeSkillPatterns(value: unknown): SkillPattern[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const patterns: SkillPattern[] = [];
  for (const entry of value) {
    const pattern = normalizeSkillPattern(entry);
    if (pattern !== undefined) {
      patterns.push(pattern);
    }
  }

  return patterns;
}

function normalizeSkillPattern(value: unknown): SkillPattern | undefined {
  if (typeof value === "string") {
    return { type: "regex", value };
  }

  if (!isRecord(value) || typeof value.type !== "string" || typeof value.value !== "string") {
    return undefined;
  }

  if (value.type === "contains" || value.type === "regex") {
    return { type: value.type, value: value.value };
  }

  if (value.type === "attachment-kind" && isRoutableAttachmentKind(value.value)) {
    return { type: "attachment-kind", value: value.value };
  }

  if (value.type === "native-intent" && isNativeIntent(value.value)) {
    return { type: "native-intent", value: value.value };
  }

  return undefined;
}

function normalizeDeferRules(value: unknown): NonNullable<SkillRouting["deferWhen"]> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isRecord)
    .map((entry) => {
      const when = isRecord(entry.when) ? entry.when : {};
      return {
        when: {
          nativeIntent: typeof when.nativeIntent === "string" && isNativeIntent(when.nativeIntent) ? when.nativeIntent : undefined,
          modelSupportsVision: typeof when.modelSupportsVision === "boolean" ? when.modelSupportsVision : undefined,
          attachmentKinds: normalizeStringList(when.attachmentKinds).filter(isRoutableAttachmentKind),
          promptMatches: normalizeSkillPatterns(when.promptMatches)
        },
        reason: isNonEmptyString(entry.reason) ? entry.reason : "Routing metadata requested deferral."
      };
    });
}

function normalizeConfirmation(value: unknown): SkillRouting["confirmation"] {
  return value === "never" || value === "ask" || value === "policy" ? value : undefined;
}

function normalizeStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim())
    : [];
}

function dedupeStrings<T extends string>(values: T[]): T[] {
  return [...new Set(values)];
}

function dedupePatterns(patterns: SkillPattern[]): SkillPattern[] {
  const seen = new Set<string>();
  const unique: SkillPattern[] = [];

  for (const pattern of patterns) {
    const key = `${pattern.type}:${pattern.value}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(pattern);
  }

  return unique;
}

function patternToLegacyString(pattern: SkillPattern): string {
  return pattern.value;
}

function isRoutableAttachmentKind(value: string): value is "image" | "document" | "file" | "audio" | "video" | "voice" {
  return value === "image" ||
    value === "document" ||
    value === "file" ||
    value === "audio" ||
    value === "video" ||
    value === "voice";
}

function isNativeIntent(value: string): value is NativeIntent {
  return value === "image-generation" ||
    value === "voice-transcription" ||
    value === "speech-generation" ||
    value === "attachment-analysis" ||
    value === "general";
}

function normalizeWorkflow(value: unknown, fallback: SkillWorkflowStep): SkillWorkflowStep[] {
  if (value === undefined) {
    return [fallback];
  }

  if (!Array.isArray(value)) {
    throw new Error("Skill field workflow must be an array of objects");
  }

  if (value.length === 0) {
    return [fallback];
  }

  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`Skill workflow[${index}] must be an object`);
    }
    assertString(entry.id, `workflow[${index}].id`);
    assertString(entry.description, `workflow[${index}].description`);

    return {
      id: entry.id,
      description: entry.description,
      toolsets: stringArrayOrEmpty(entry.toolsets) as ToolsetName[],
      preferredTool: firstNonEmptyString(entry.preferredTool, entry.preferred_tool),
      toolCandidates: stringArrayOrEmpty(entry.toolCandidates ?? entry.tool_candidates),
      fallbackTo: stringArrayOrEmpty(entry.fallbackTo ?? entry.fallback_to),
      successCriteria: stringArrayOrEmpty(entry.successCriteria ?? entry.success_criteria),
      outputTarget: firstNonEmptyString(entry.outputTarget, entry.output_target)
    };
  });
}

function normalizeEvaluations(value: unknown): SkillEvaluation[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error("Skill field evaluations must be an array of objects");
  }

  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`Skill evaluations[${index}] must be an object`);
    }
    assertString(entry.input, `evaluations[${index}].input`);

    return {
      input: entry.input,
      shouldUseToolsets: stringArrayOrEmpty(entry.shouldUseToolsets ?? entry.should_use_toolsets) as ToolsetName[],
      shouldNotAskUserFirst: entry.shouldNotAskUserFirst === true || entry.should_not_ask_user_first === true,
      expectedOutcome: firstNonEmptyString(entry.expectedOutcome, entry.expected_outcome)
    };
  });
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

function firstNonEmptyString(...values: unknown[]): string | undefined {
  return values.find(isNonEmptyString);
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

function inferHermesVisibility(metadata: unknown): SkillVisibilityRules | undefined {
  if (!isRecord(metadata)) {
    return undefined;
  }

  const hermes = metadata.hermes;
  if (!isRecord(hermes)) {
    return undefined;
  }

  return normalizeVisibilityRules({
    requiresToolsets: hermes.requiresToolsets ?? hermes.requires_toolsets,
    fallbackForToolsets: hermes.fallbackForToolsets ?? hermes.fallback_for_toolsets,
    requiresTools: hermes.requiresTools ?? hermes.requires_tools,
    fallbackForTools: hermes.fallbackForTools ?? hermes.fallback_for_tools
  });
}

function inferHermesConfigFields(metadata: unknown): SkillConfigField[] | undefined {
  if (!isRecord(metadata)) {
    return undefined;
  }

  const hermes = metadata.hermes;
  if (!isRecord(hermes) || !isRecord(hermes.config)) {
    return undefined;
  }

  const configFields: SkillConfigField[] = [];
  for (const [key, value] of Object.entries(hermes.config)) {
    if (isRecord(value)) {
      configFields.push({
        key,
        description: isNonEmptyString(value.description) ? value.description : undefined,
        required: value.required === true,
        defaultValue: value.default
      });
      continue;
    }

    configFields.push({
      key,
      defaultValue: value
    });
  }

  return configFields.length === 0 ? undefined : configFields;
}

function parseVisibilityRules(value: unknown): SkillVisibilityRules | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return normalizeVisibilityRules({
    requiresToolsets: value.requiresToolsets,
    fallbackForToolsets: value.fallbackForToolsets,
    requiresTools: value.requiresTools,
    fallbackForTools: value.fallbackForTools
  });
}

function normalizeVisibilityRules(value: {
  requiresToolsets?: unknown;
  fallbackForToolsets?: unknown;
  requiresTools?: unknown;
  fallbackForTools?: unknown;
}): SkillVisibilityRules | undefined {
  const normalized: SkillVisibilityRules = {};
  const requiresToolsets = stringArrayOrEmpty(value.requiresToolsets) as ToolsetName[];
  const fallbackForToolsets = stringArrayOrEmpty(value.fallbackForToolsets) as ToolsetName[];
  const requiresTools = stringArrayOrEmpty(value.requiresTools);
  const fallbackForTools = stringArrayOrEmpty(value.fallbackForTools);

  if (requiresToolsets.length > 0) {
    normalized.requiresToolsets = requiresToolsets;
  }
  if (fallbackForToolsets.length > 0) {
    normalized.fallbackForToolsets = fallbackForToolsets;
  }
  if (requiresTools.length > 0) {
    normalized.requiresTools = requiresTools;
  }
  if (fallbackForTools.length > 0) {
    normalized.fallbackForTools = fallbackForTools;
  }

  return Object.keys(normalized).length === 0 ? undefined : normalized;
}

function mergeVisibilityRules(
  left: SkillVisibilityRules | undefined,
  right: SkillVisibilityRules | undefined
): SkillVisibilityRules | undefined {
  if (left === undefined) {
    return right;
  }

  if (right === undefined) {
    return left;
  }

  const merged = normalizeVisibilityRules({
    requiresToolsets: [...(left.requiresToolsets ?? []), ...(right.requiresToolsets ?? [])],
    fallbackForToolsets: [...(left.fallbackForToolsets ?? []), ...(right.fallbackForToolsets ?? [])],
    requiresTools: [...(left.requiresTools ?? []), ...(right.requiresTools ?? [])],
    fallbackForTools: [...(left.fallbackForTools ?? []), ...(right.fallbackForTools ?? [])]
  });

  return merged;
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

    if (/^-\s*[A-Za-z0-9_-]+:(?:\s|$)/u.test(line)) {
      throw new Error("YAML object arrays are not supported in skill frontmatter yet; use JSON frontmatter for workflow/evaluations.");
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

async function loadSkillResourceIndex(skill: LoadedSkill): Promise<SkillResourceEntry[]> {
  const skillRoot = dirname(skill.sourcePath);
  const resources = new Map<string, SkillResourceEntry>();

  for (const declaredReference of skill.references ?? []) {
    const normalized = normalizeRelativeSkillPath(skillRoot, declaredReference);
    if (normalized === undefined || normalized === "SKILL.md") {
      continue;
    }

    const fullPath = resolve(skillRoot, normalized);
    const bytes = await stat(fullPath).then((entry) => entry.size).catch(() => undefined);
    resources.set(`reference:${normalized}`, {
      kind: "reference",
      path: normalized,
      bytes,
      declared: true
    });
  }

  await collectResourceDirectory(skillRoot, "references", "reference", resources);
  await collectResourceDirectory(skillRoot, "templates", "template", resources);
  await collectResourceDirectory(skillRoot, "scripts", "script", resources);
  await collectResourceDirectory(skillRoot, "assets", "asset", resources);

  return [...resources.values()].sort((left, right) =>
    left.kind.localeCompare(right.kind) || left.path.localeCompare(right.path)
  );
}

async function collectResourceDirectory(
  skillRoot: string,
  directoryName: string,
  kind: SkillResourceKind,
  resources: Map<string, SkillResourceEntry>
): Promise<void> {
  const root = join(skillRoot, directoryName);
  const files = await walkFiles(root).catch(() => []);

  for (const filePath of files) {
    const relativePath = relative(skillRoot, filePath);
    resources.set(`${kind}:${relativePath}`, {
      kind,
      path: relativePath,
      bytes: await stat(filePath).then((entry) => entry.size).catch(() => undefined),
      declared: kind === "reference" ? resources.get(`reference:${relativePath}`)?.declared === true : undefined
    });
  }
}

async function walkFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(path)));
      continue;
    }
    if (entry.isFile()) {
      files.push(path);
    }
  }

  return files.sort();
}

function normalizeRelativeSkillPath(skillRoot: string, path: string): string | undefined {
  const candidate = resolve(skillRoot, path);
  const relativePath = relative(skillRoot, candidate);
  if (relativePath.length === 0 || relativePath.startsWith("..") || relativePath.startsWith("/")) {
    return undefined;
  }
  return relativePath;
}
