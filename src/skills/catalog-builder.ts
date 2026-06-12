import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const GITHUB_BLOB_BASE_URL = "https://github.com/KemetResearch/EstaCoda/blob/main";
const SOURCE_PRIORITIES = ["official", "optional", "community", "experimental"] as const;

type SourceType = (typeof SOURCE_PRIORITIES)[number];

type UnknownRecord = Record<string, unknown>;

export interface SkillSourceConfig {
  id: string;
  type: "local";
  path: string;
  sourceType: SourceType;
  label: string;
}

export interface SkillCatalogEntry {
  id: string;
  slug: string;
  name: string;
  description: string;
  overview: string;
  labels: string[];
  triggerPatterns: string[];
  requiredToolsets: string[];
  optionalToolsets: string[];
  playbookSteps: number;
  evaluationCount: number;
  routing: {
    confirmation: string;
  };
  source: {
    type: SourceType;
    label: string;
    path: string;
    githubUrl: string;
  };
  trust: {
    level: SourceType;
    reviewed: boolean;
    governed: boolean;
  };
}

export interface SkillsCatalog {
  schemaVersion: 1;
  generatedAt: string;
  skills: SkillCatalogEntry[];
}

export interface SkillsCatalogMeta {
  schemaVersion: 1;
  generatedAt: string;
  counts: {
    total: number;
    bySource: Record<string, number>;
    byTrust: Record<string, number>;
    byConfirmation: Record<string, number>;
  };
}

export interface BuildSkillsCatalogOptions {
  repoRoot?: string;
  sourcesPath?: string;
  outputDir?: string;
  generatedAt?: string;
  writeOutput?: boolean;
}

export interface BuildSkillsCatalogResult {
  catalog: SkillsCatalog;
  meta: SkillsCatalogMeta;
  warnings: string[];
  outputPaths: {
    skills: string;
    meta: string;
  };
}

export class SkillsCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillsCatalogError";
  }
}

interface ParsedSkillFile {
  frontmatter: UnknownRecord;
  body: string;
}

export async function buildSkillsCatalog(
  options: BuildSkillsCatalogOptions = {}
): Promise<BuildSkillsCatalogResult> {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const sourcesPath = path.resolve(repoRoot, options.sourcesPath ?? "registries/skills.sources.json");
  const outputDir = path.resolve(repoRoot, options.outputDir ?? "website/static/api");
  const warnings: string[] = [];

  const sources = await readSourceRegistry(sourcesPath, repoRoot);
  const skills = await collectSkills({ repoRoot, sources, warnings });
  skills.sort(compareSkills);

  const catalog: SkillsCatalog = {
    schemaVersion: 1,
    generatedAt,
    skills
  };
  const meta = buildCatalogMeta(skills, generatedAt);
  const outputPaths = {
    skills: path.join(outputDir, "skills.json"),
    meta: path.join(outputDir, "skills-meta.json")
  };

  if (options.writeOutput !== false) {
    await mkdir(outputDir, { recursive: true });
    await writeFile(outputPaths.skills, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
    await writeFile(outputPaths.meta, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  }

  return { catalog, meta, warnings, outputPaths };
}

export function extractJsonFrontmatter(markdown: string, filePath: string): ParsedSkillFile {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(markdown);
  if (!match) {
    throw new SkillsCatalogError(`${filePath}: SKILL.md is missing JSON frontmatter`);
  }

  try {
    const parsed = JSON.parse(match[1]);
    if (!isRecord(parsed)) {
      throw new SkillsCatalogError(`${filePath}: frontmatter must be a JSON object`);
    }
    return { frontmatter: parsed, body: match[2] };
  } catch (error) {
    if (error instanceof SkillsCatalogError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new SkillsCatalogError(`${filePath}: frontmatter is invalid JSON: ${message}`);
  }
}

export function extractOverview(markdownBody: string): string {
  const lines = markdownBody.replace(/\r\n/g, "\n").split("\n");
  const paragraph: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed) {
      if (paragraph.length > 0) {
        return paragraph.join(" ").replace(/\s+/g, " ").trim();
      }
      continue;
    }

    if (
      /^#{1,6}\s+/.test(trimmed) ||
      /^```/.test(trimmed) ||
      /^[-*_]{3,}$/.test(trimmed) ||
      /^[-*+]\s+/.test(trimmed) ||
      /^\d+\.\s+/.test(trimmed)
    ) {
      if (paragraph.length > 0) {
        return paragraph.join(" ").replace(/\s+/g, " ").trim();
      }
      continue;
    }

    paragraph.push(trimmed);
  }

  return paragraph.join(" ").replace(/\s+/g, " ").trim();
}

async function readSourceRegistry(registryPath: string, repoRoot: string): Promise<SkillSourceConfig[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(registryPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SkillsCatalogError(`${toDisplayPath(registryPath, repoRoot)}: source registry is invalid: ${message}`);
  }

  if (!Array.isArray(parsed)) {
    throw new SkillsCatalogError(`${toDisplayPath(registryPath, repoRoot)}: source registry must be an array`);
  }

  const sources = parsed.map((source, index) => validateSourceConfig(source, index, repoRoot));
  for (const source of sources) {
    await assertDirectoryExists(path.resolve(repoRoot, source.path), `${source.id}.path`, repoRoot);
  }
  return sources;
}

function validateSourceConfig(source: unknown, index: number, repoRoot: string): SkillSourceConfig {
  const prefix = `registries/skills.sources.json[${index}]`;
  if (!isRecord(source)) {
    throw new SkillsCatalogError(`${prefix}: source config must be an object`);
  }

  const id = requireString(source.id, `${prefix}.id`);
  const type = requireString(source.type, `${prefix}.type`);
  const sourcePath = requireString(source.path, `${prefix}.path`);
  const sourceType = requireString(source.sourceType, `${prefix}.sourceType`);
  const label = requireString(source.label, `${prefix}.label`);

  if (type !== "local") {
    throw new SkillsCatalogError(`${prefix}.type: only local sources are supported`);
  }
  if (!isSourceType(sourceType)) {
    throw new SkillsCatalogError(
      `${prefix}.sourceType: expected one of ${SOURCE_PRIORITIES.join(", ")}`
    );
  }
  if (path.isAbsolute(sourcePath)) {
    throw new SkillsCatalogError(`${prefix}.path: source path must be repo-relative`);
  }

  const resolved = path.resolve(repoRoot, sourcePath);
  if (!isInsidePath(repoRoot, resolved)) {
    throw new SkillsCatalogError(`${prefix}.path: source path must stay inside the repo`);
  }

  return {
    id,
    type,
    path: toPosixPath(sourcePath),
    sourceType,
    label
  };
}

async function assertDirectoryExists(directoryPath: string, field: string, repoRoot: string): Promise<void> {
  try {
    const stats = await stat(directoryPath);
    if (!stats.isDirectory()) {
      throw new SkillsCatalogError(`${field}: ${toDisplayPath(directoryPath, repoRoot)} is not a directory`);
    }
  } catch (error) {
    if (error instanceof SkillsCatalogError) {
      throw error;
    }
    throw new SkillsCatalogError(`${field}: source path does not exist: ${toDisplayPath(directoryPath, repoRoot)}`);
  }
}

async function collectSkills(args: {
  repoRoot: string;
  sources: SkillSourceConfig[];
  warnings: string[];
}): Promise<SkillCatalogEntry[]> {
  const skills: SkillCatalogEntry[] = [];
  const seenIds = new Set<string>();

  for (const source of args.sources) {
    const sourceRoot = path.resolve(args.repoRoot, source.path);
    const entries = (await readdir(sourceRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name, "en"));
    const seenSlugs = new Set<string>();

    for (const entry of entries) {
      const slug = entry.name;
      if (seenSlugs.has(slug)) {
        throw new SkillsCatalogError(`${source.id}: generated slug is duplicated within source: ${slug}`);
      }
      seenSlugs.add(slug);

      const skillPath = path.join(sourceRoot, slug, "SKILL.md");
      const repoRelativeSkillPath = toDisplayPath(skillPath, args.repoRoot);

      let markdown: string;
      try {
        markdown = await readFile(skillPath, "utf8");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new SkillsCatalogError(`${repoRelativeSkillPath}: unable to read SKILL.md: ${message}`);
      }

      const id = `${source.sourceType}.${slug}`;
      if (seenIds.has(id)) {
        throw new SkillsCatalogError(`${repoRelativeSkillPath}: generated skill id is duplicated: ${id}`);
      }
      seenIds.add(id);

      const parsed = extractJsonFrontmatter(markdown, repoRelativeSkillPath);
      skills.push(buildSkillEntry({
        id,
        slug,
        source,
        skillPath: repoRelativeSkillPath,
        parsed,
        warnings: args.warnings
      }));
    }
  }

  return skills;
}

function buildSkillEntry(args: {
  id: string;
  slug: string;
  source: SkillSourceConfig;
  skillPath: string;
  parsed: ParsedSkillFile;
  warnings: string[];
}): SkillCatalogEntry {
  const frontmatter = args.parsed.frontmatter;
  const fieldPrefix = args.skillPath;
  const routing = requireRecord(frontmatter.routing, `${fieldPrefix}: routing`);
  const labels = requireStringArray(routing.labels, `${fieldPrefix}: routing.labels`);
  const confirmation = requireString(routing.confirmation, `${fieldPrefix}: routing.confirmation`);
  const requiredToolsets = requireStringArray(
    frontmatter.requiredToolsets,
    `${fieldPrefix}: requiredToolsets`
  );
  const playbook = requireArray(frontmatter.playbook, `${fieldPrefix}: playbook`);
  const evaluations = requireArray(frontmatter.evaluations, `${fieldPrefix}: evaluations`);
  const optionalToolsets = optionalStringArray(
    frontmatter.optionalToolsets,
    `${fieldPrefix}: optionalToolsets`,
    args.warnings
  );
  const triggerPatterns = normalizeTriggerPatterns(
    routing.triggerPatterns,
    `${fieldPrefix}: routing.triggerPatterns`,
    args.warnings
  );
  const overview = extractOverview(args.parsed.body);

  if (triggerPatterns.length === 0) {
    args.warnings.push(`${fieldPrefix}: routing.triggerPatterns is missing or empty`);
  }
  if (frontmatter.optionalToolsets === undefined) {
    args.warnings.push(`${fieldPrefix}: optionalToolsets is missing`);
  }
  if (!overview) {
    args.warnings.push(`${fieldPrefix}: overview is missing`);
  }
  if (evaluations.length === 0) {
    args.warnings.push(`${fieldPrefix}: evaluations is empty`);
  }

  const isOfficial = args.source.sourceType === "official";

  return {
    id: args.id,
    slug: args.slug,
    name: resolveDisplayName(frontmatter, args.slug, fieldPrefix),
    description: requireString(frontmatter.description, `${fieldPrefix}: description`),
    overview,
    labels,
    triggerPatterns,
    requiredToolsets,
    optionalToolsets,
    playbookSteps: playbook.length,
    evaluationCount: evaluations.length,
    routing: {
      confirmation
    },
    source: {
      type: args.source.sourceType,
      label: args.source.label,
      path: args.skillPath,
      githubUrl: `${GITHUB_BLOB_BASE_URL}/${args.skillPath}`
    },
    trust: {
      level: args.source.sourceType,
      reviewed: isOfficial,
      governed: isOfficial
    }
  };
}

function resolveDisplayName(frontmatter: UnknownRecord, slug: string, fieldPrefix: string): string {
  const explicitDisplayName = firstString(frontmatter.displayName, frontmatter.displayTitle, frontmatter.title);
  if (explicitDisplayName) {
    return explicitDisplayName;
  }

  const rawName = requireString(frontmatter.name, `${fieldPrefix}: name`);
  if (isMachineName(rawName)) {
    return isMachineName(slug) ? humanizeSkillName(slug) : humanizeSkillName(rawName);
  }
  if (isMachineName(slug)) {
    return humanizeSkillName(slug);
  }
  return rawName;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function isMachineName(value: string): boolean {
  return /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(value);
}

function humanizeSkillName(value: string): string {
  return value
    .split(/[-_]+/)
    .filter((part) => part.length > 0)
    .map(formatNamePart)
    .join(" ");
}

function formatNamePart(part: string): string {
  const special = new Map<string, string>([
    ["ascii", "ASCII"],
    ["api", "API"],
    ["cli", "CLI"],
    ["json", "JSON"],
    ["mcp", "MCP"],
    ["ui", "UI"],
    ["url", "URL"],
    ["youtube", "YouTube"]
  ]);
  const lower = part.toLowerCase();
  return special.get(lower) ?? `${lower.slice(0, 1).toUpperCase()}${lower.slice(1)}`;
}

function normalizeTriggerPatterns(value: unknown, field: string, warnings: string[]): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    warnings.push(`${field} is not an array; emitting an empty triggerPatterns list`);
    return [];
  }

  const patterns: string[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      patterns.push(item);
      continue;
    }
    if (isRecord(item) && typeof item.value === "string") {
      patterns.push(item.value);
      continue;
    }
    warnings.push(`${field} contains a trigger pattern without a string value`);
  }
  return patterns;
}

function optionalStringArray(value: unknown, field: string, warnings: string[]): string[] {
  if (value === undefined) {
    return [];
  }
  if (!isStringArray(value)) {
    warnings.push(`${field} is not an array of strings; emitting an empty optionalToolsets list`);
    return [];
  }
  return value;
}

function buildCatalogMeta(skills: SkillCatalogEntry[], generatedAt: string): SkillsCatalogMeta {
  const bySource: Record<string, number> = {};
  const byTrust: Record<string, number> = {};
  const byConfirmation: Record<string, number> = {};

  for (const skill of skills) {
    increment(bySource, skill.source.type);
    increment(byTrust, skill.trust.level);
    increment(byConfirmation, skill.routing.confirmation);
  }

  return {
    schemaVersion: 1,
    generatedAt,
    counts: {
      total: skills.length,
      bySource,
      byTrust,
      byConfirmation
    }
  };
}

function compareSkills(a: SkillCatalogEntry, b: SkillCatalogEntry): number {
  const sourcePriority = sourcePriorityOf(a.source.type) - sourcePriorityOf(b.source.type);
  if (sourcePriority !== 0) {
    return sourcePriority;
  }

  const nameComparison = a.name.localeCompare(b.name, "en", { sensitivity: "base" });
  if (nameComparison !== 0) {
    return nameComparison;
  }

  return a.id.localeCompare(b.id, "en");
}

function sourcePriorityOf(sourceType: SourceType): number {
  return SOURCE_PRIORITIES.indexOf(sourceType);
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function requireRecord(value: unknown, field: string): UnknownRecord {
  if (!isRecord(value)) {
    throw new SkillsCatalogError(`${field} is missing or not an object`);
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new SkillsCatalogError(`${field} is missing or not a string`);
  }
  return value;
}

function requireArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new SkillsCatalogError(`${field} is missing or not an array`);
  }
  return value;
}

function requireStringArray(value: unknown, field: string): string[] {
  if (!isStringArray(value)) {
    throw new SkillsCatalogError(`${field} is missing or not an array of strings`);
  }
  return value;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSourceType(value: string): value is SourceType {
  return SOURCE_PRIORITIES.includes(value as SourceType);
}

function isInsidePath(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function toDisplayPath(filePath: string, repoRoot: string): string {
  return toPosixPath(path.relative(repoRoot, filePath));
}

function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}
