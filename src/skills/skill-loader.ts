import type { Dirent } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import type {
  LoadedSkill,
  SkillDefinition,
  SkillEvaluation,
  SkillPattern,
  SkillPythonCapabilityRequirement,
  SkillPermissionExpectation,
  SkillRouting,
  SkillResourceEntry,
  SkillResourceKind,
  SkillSourceKind,
  SkillVisibilityRules,
  SkillPlaybookStepSpec
} from "../contracts/skill.js";
import type { NativeIntent } from "../contracts/intent.js";
import type { ToolsetName } from "../contracts/tool.js";
import { getRegisteredPythonCapabilitySpec } from "../python-env/capability-registry.js";
import { buildSkillContract } from "./skill-contract.js";
import {
  assertKnownToolsetName,
  MAX_SKILL_FILES,
  MAX_SKILL_MD_BYTES,
  MAX_SKILL_MD_CHARS,
  MAX_SKILL_RESOURCE_BYTES,
  MAX_SKILL_RESOURCE_FILES,
  MAX_SKILL_RESOURCE_SCAN_DEPTH,
  MAX_SKILL_SCAN_DEPTH
} from "./skill-limits.js";

export type SkillLoadResult = {
  skills: LoadedSkill[];
  errors: SkillLoadError[];
};

export type SkillLoadOptions = {
  sourceKind?: SkillSourceKind;
  sourceRoot?: string;
  maxDepth?: number;
  maxFiles?: number;
  exclude?: string[];
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
      maxFiles: options.maxFiles ?? MAX_SKILL_FILES,
      exclude: new Set(options.exclude ?? [])
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
      const fileStat = await stat(path);
      if (fileStat.size > MAX_SKILL_MD_BYTES) {
        throw new Error(`SKILL.md exceeds ${MAX_SKILL_MD_BYTES} byte safety limit`);
      }
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
  const instructions = match.groups.instructions.trim();
  const providerView = truncateContextDocument(instructions, MAX_SKILL_MD_CHARS);

  return {
    ...definition,
    sourcePath,
    sourceKind: options.sourceKind ?? "external",
    sourceRoot: options.sourceRoot ?? sourcePath,
    instructions,
    providerInstructions: providerView.truncated
      ? {
          content: providerView.content,
          truncated: true,
          originalChars: providerView.originalChars
        }
      : undefined
  };
}

export function truncateContextDocument(input: string, maxChars = MAX_SKILL_MD_CHARS): {
  content: string;
  truncated: boolean;
  originalChars: number;
  headChars: number;
  tailChars: number;
} {
  if (input.length <= maxChars) {
    return {
      content: input,
      truncated: false,
      originalChars: input.length,
      headChars: input.length,
      tailChars: 0
    };
  }

  const marker = `\n\n[TRUNCATED: omitted ${input.length - maxChars} characters from the middle]\n\n`;
  const remaining = Math.max(0, maxChars - marker.length);
  const headChars = Math.floor(remaining * 0.7);
  const tailChars = Math.floor(remaining * 0.2);

  return {
    content: `${input.slice(0, headChars)}${marker}${input.slice(input.length - tailChars)}`,
    truncated: true,
    originalChars: input.length,
    headChars,
    tailChars
  };
}

export async function hydrateSkillResources(skill: LoadedSkill): Promise<LoadedSkill> {
  const hydrated = {
    ...skill,
    resources: await loadSkillResourceIndex(skill)
  };

  return {
    ...hydrated,
    contract: buildSkillContract(hydrated)
  };
}

async function findSkillFiles(
  root: string,
  options: { maxDepth: number; maxFiles: number; exclude?: Set<string> },
  depth = 0,
  files: string[] = []
): Promise<string[]> {
  if (depth > options.maxDepth) {
    throw new Error(`Skill directory scan exceeded max depth ${options.maxDepth}: ${root}`);
  }
  if (files.length >= options.maxFiles) {
    throw new Error(`Skill directory scan exceeded max file count ${options.maxFiles}`);
  }

  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return files;
    }
    throw error;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.isSymbolicLink()) {
      continue;
    }

    const path = join(root, entry.name);

    if (entry.isDirectory()) {
      if (options.exclude?.has(entry.name)) {
        continue;
      }
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
    workflow?: unknown;
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
    python_capabilities?: unknown;
    visibility?: Record<string, unknown>;
    routing?: unknown;
  };
  const parsedVisibility = parseVisibilityRules(definition.visibility);

  assertString(definition.name, "name");
  assertString(definition.description, "description");

  const legacyIntentLabels = stringArrayOrEmpty(definition.intentLabels ?? definition.intent_labels);
  const legacyTriggerPatterns = legacyPatternArray(definition.triggerPatterns ?? definition.trigger_patterns);
  const legacyNegativePatterns = legacyPatternArray(definition.negativePatterns ?? definition.negative_patterns);
  const requiredToolsets = toolsetArrayOrDefault(definition.requiredToolsets ?? definition.required_toolsets ?? definition.toolsets ?? definition.tools, ["core"], "requiredToolsets");
  const routing = normalizeSkillRouting(definition.routing, {
    labels: legacyIntentLabels,
    triggerPatterns: legacyTriggerPatterns,
    negativePatterns: legacyNegativePatterns,
    requiredToolsets
  });
  if (definition.workflow !== undefined) {
    throw new Error("Skill field workflow has been renamed to playbook; update SKILL.md to use playbook.");
  }

  const normalized: SkillDefinition = {
    name: definition.name,
    description: definition.description,
    version: isNonEmptyString(definition.version) ? definition.version : "0.1.0",
    category: isNonEmptyString(definition.category) ? definition.category : undefined,
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
    optionalToolsets: toolsetArrayOrEmpty(definition.optionalToolsets ?? definition.optional_toolsets, "optionalToolsets"),
    requiredEnvironmentVariables: stringArrayOrEmpty(definition.requiredEnvironmentVariables ?? definition.required_environment_variables),
    requiredCredentialFiles: stringArrayOrEmpty(definition.requiredCredentialFiles ?? definition.required_credential_files),
    pythonCapabilities: normalizePythonCapabilities(definition.pythonCapabilities ?? definition.python_capabilities),
    configFields: undefined,
    visibility: parsedVisibility,
    inputs: definition.inputs,
    outputs: definition.outputs,
    playbook: normalizePlaybook(definition.playbook, {
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
  const requiredToolsets = toolsetArrayOrEmpty(dedupeStrings([
    ...normalizeStringList(explicit.requiredToolsets),
    ...legacy.requiredToolsets
  ]), "routing.requiredToolsets");
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

function normalizePlaybook(value: unknown, fallback: SkillPlaybookStepSpec): SkillPlaybookStepSpec[] {
  if (value === undefined) {
    return [fallback];
  }

  if (!Array.isArray(value)) {
    throw new Error("Skill field playbook must be an array of objects");
  }

  if (value.length === 0) {
    return [fallback];
  }

  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`Skill playbook[${index}] must be an object`);
    }
    assertString(entry.id, `playbook[${index}].id`);
    assertString(entry.description, `playbook[${index}].description`);

    return {
      id: entry.id,
      description: entry.description,
      toolsets: toolsetArrayOrEmpty(entry.toolsets, `playbook[${index}].toolsets`),
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
      shouldUseToolsets: toolsetArrayOrEmpty(entry.shouldUseToolsets ?? entry.should_use_toolsets, `evaluations[${index}].shouldUseToolsets`),
      shouldNotAskUserFirst: entry.shouldNotAskUserFirst === true || entry.should_not_ask_user_first === true,
      expectedOutcome: firstNonEmptyString(entry.expectedOutcome, entry.expected_outcome)
    };
  });
}

function normalizePythonCapabilities(value: unknown): SkillPythonCapabilityRequirement[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("Skill field pythonCapabilities must be an array of objects");
  }

  const byDeclaration = new Map<string, SkillPythonCapabilityRequirement>();
  const requiredByIdAndGroups = new Map<string, boolean>();
  value.forEach((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`Skill pythonCapabilities[${index}] must be an object`);
    }
    assertAllowedPythonCapabilityFields(entry, index);
    assertString(entry.id, `pythonCapabilities[${index}].id`);
    const spec = getRegisteredPythonCapabilitySpec(entry.id);
    if (spec === undefined) {
      throw new Error(`Skill pythonCapabilities[${index}].id references unknown managed Python capability '${entry.id}'`);
    }
    if (entry.required !== undefined && typeof entry.required !== "boolean") {
      throw new Error(`Skill pythonCapabilities[${index}].required must be a boolean`);
    }
    const groups = normalizePythonCapabilityGroups(entry.groups, index).sort();
    const uniqueGroups = dedupeStrings(groups);
    for (const groupId of uniqueGroups) {
      if (spec.optionalGroups?.[groupId] === undefined) {
        throw new Error(`Skill pythonCapabilities[${index}].groups references unknown optional group '${groupId}' for managed Python capability '${entry.id}'`);
      }
    }
    const required = entry.required !== false;
    const idAndGroupsKey = `${entry.id}\0${uniqueGroups.join("\0")}`;
    const existingRequired = requiredByIdAndGroups.get(idAndGroupsKey);
    if (existingRequired !== undefined && existingRequired !== required) {
      throw new Error(`Skill pythonCapabilities[${index}] conflicts with another declaration for managed Python capability '${entry.id}' and the same groups`);
    }
    requiredByIdAndGroups.set(idAndGroupsKey, required);
    byDeclaration.set(`${idAndGroupsKey}\0${required ? "required" : "optional"}`, {
      id: entry.id,
      required,
      groups: uniqueGroups
    });
  });

  return [...byDeclaration.values()].sort((left, right) => {
    const idOrder = left.id.localeCompare(right.id);
    if (idOrder !== 0) {
      return idOrder;
    }
    const groupOrder = left.groups.join("\0").localeCompare(right.groups.join("\0"));
    if (groupOrder !== 0) {
      return groupOrder;
    }
    return Number(right.required) - Number(left.required);
  });
}

function normalizePythonCapabilityGroups(value: unknown, index: number): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`Skill pythonCapabilities[${index}].groups must be an array of strings`);
  }
  return value.map((group, groupIndex) => {
    if (typeof group !== "string" || group.trim().length === 0) {
      throw new Error(`Skill pythonCapabilities[${index}].groups[${groupIndex}] must be a non-empty string`);
    }
    return group.trim();
  });
}

function assertAllowedPythonCapabilityFields(entry: Record<string, unknown>, index: number): void {
  const allowedFields = new Set(["id", "required", "groups"]);
  for (const field of Object.keys(entry)) {
    if (!allowedFields.has(field)) {
      throw new Error(`Skill pythonCapabilities[${index}] must not define unsupported field '${field}'`);
    }
  }
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

function toolsetArrayOrDefault(value: unknown, fallback: ToolsetName[], field: string): ToolsetName[] {
  const array = toolsetArrayOrEmpty(value, field);
  return array.length === 0 ? fallback : array;
}

function toolsetArrayOrEmpty(value: unknown, field: string): ToolsetName[] {
  return stringArrayOrEmpty(value).map((entry, index) => {
    assertKnownToolsetName(entry, `${field}[${index}]`);
    return entry;
  });
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
  values: unknown[];
  endIndex: number;
} {
  const values: unknown[] = [];
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
      const collected = collectYamlObjectArrayEntry(lines, index, indent);
      values.push(collected.value);
      index = collected.endIndex;
      endIndex = collected.endIndex;
      continue;
    }

    values.push(stripYamlQuotes(line.slice(2).trim()));
    endIndex = index;
  }

  return { values, endIndex };
}

function collectYamlObjectArrayEntry(lines: string[], startIndex: number, itemIndent: number): {
  value: Record<string, unknown>;
  endIndex: number;
} {
  const value: Record<string, unknown> = {};
  let endIndex = startIndex;
  const firstLine = lines[startIndex]!.trim().slice(2).trim();
  assignYamlObjectProperty(value, firstLine);

  for (let index = startIndex + 1; index < lines.length; index++) {
    const raw = lines[index];
    const indent = raw.match(/^\s*/u)?.[0].length ?? 0;
    const line = raw.trim();

    if (line.length === 0) {
      endIndex = index;
      continue;
    }
    if (indent <= itemIndent || line.startsWith("- ")) {
      break;
    }
    assignYamlObjectProperty(value, line);
    endIndex = index;
  }

  return { value, endIndex };
}

function assignYamlObjectProperty(target: Record<string, unknown>, line: string): void {
  const match = /^(?<key>[A-Za-z0-9_-]+):(?:\s*(?<value>.*))?$/u.exec(line);
  if (match?.groups === undefined) {
    throw new Error("YAML object arrays support only simple key/value entries.");
  }
  target[camelize(match.groups.key)] = parseYamlScalar(match.groups.value ?? "");
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
  const canonicalSkillRoot = await realpath(skillRoot).catch(() => skillRoot);
  const resources = new Map<string, SkillResourceEntry>();
  const scanState = { count: 0 };

  for (const declaredReference of skill.references ?? []) {
    const normalized = normalizeRelativeSkillPath(skillRoot, declaredReference);
    if (normalized === undefined || normalized === "SKILL.md") {
      continue;
    }

    const fullPath = resolve(skillRoot, normalized);
    const canonicalPath = await realpath(fullPath).catch(() => undefined);
    if (canonicalPath === undefined || !isPathInside(canonicalSkillRoot, canonicalPath)) {
      continue;
    }
    const bytes = await stat(fullPath).then((entry) => entry.size).catch(() => undefined);
    resources.set(`reference:${normalized}`, {
      kind: "reference",
      path: normalized,
      bytes,
      declared: true
    });
  }

  await collectResourceDirectory(skillRoot, "references", "reference", resources, scanState);
  await collectResourceDirectory(skillRoot, "templates", "template", resources, scanState);
  await collectResourceDirectory(skillRoot, "scripts", "script", resources, scanState);
  await collectResourceDirectory(skillRoot, "assets", "asset", resources, scanState);

  return [...resources.values()].sort((left, right) =>
    left.kind.localeCompare(right.kind) || left.path.localeCompare(right.path)
  );
}

async function collectResourceDirectory(
  skillRoot: string,
  directoryName: string,
  kind: SkillResourceKind,
  resources: Map<string, SkillResourceEntry>,
  scanState: { count: number }
): Promise<void> {
  const root = join(skillRoot, directoryName);
  const files = await walkFiles(root, {
    baseRoot: skillRoot,
    maxDepth: MAX_SKILL_RESOURCE_SCAN_DEPTH,
    maxFiles: MAX_SKILL_RESOURCE_FILES,
    state: scanState
  }).catch(() => []);

  for (const filePath of files) {
    const relativePath = relative(skillRoot, filePath);
    const bytes = await stat(filePath).then((entry) => entry.size).catch(() => undefined);
    resources.set(`${kind}:${relativePath}`, {
      kind,
      path: relativePath,
      bytes,
      declared: kind === "reference" ? resources.get(`reference:${relativePath}`)?.declared === true : undefined
    });
  }
}

async function walkFiles(
  root: string,
  options: {
    baseRoot: string;
    maxDepth: number;
    maxFiles: number;
    state: { count: number };
  },
  depth = 0
): Promise<string[]> {
  if (depth > options.maxDepth || options.state.count >= options.maxFiles) {
    return [];
  }

  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  const canonicalBaseRoot = await realpath(options.baseRoot).catch(() => options.baseRoot);

  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.isSymbolicLink()) {
      continue;
    }

    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(path, options, depth + 1)));
      continue;
    }
    if (entry.isFile()) {
      if (options.state.count >= options.maxFiles) {
        break;
      }
      const canonicalPath = await realpath(path).catch(() => undefined);
      if (canonicalPath === undefined || !isPathInside(canonicalBaseRoot, canonicalPath)) {
        continue;
      }
      const bytes = await stat(path).then((entryStat) => entryStat.size).catch(() => undefined);
      if (bytes !== undefined && bytes > MAX_SKILL_RESOURCE_BYTES) {
        continue;
      }
      options.state.count += 1;
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

function isPathInside(root: string, path: string): boolean {
  const relativePath = relative(root, path);
  return relativePath.length === 0 || (!relativePath.startsWith("..") && !relativePath.startsWith("/"));
}
