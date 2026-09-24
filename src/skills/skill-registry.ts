import type { LoadedSkill, SkillCatalogEntry, SkillDefinition, SkillSourceKind } from "../contracts/skill.js";
import type { ToolsetName } from "../contracts/tool.js";

const SOURCE_PRIORITY: Record<SkillSourceKind, number> = {
  local: 3,
  bundled: 2,
  external: 1
};

export type SkillRegistryConflict = {
  name: string;
  kept: {
    sourceKind?: SkillSourceKind;
    sourcePath?: string;
  };
  ignored: {
    sourceKind?: SkillSourceKind;
    sourcePath?: string;
  };
  reason: "local-shadows-external" | "local-shadows-bundled" | "duplicate-source" | "external-shadowed";
};
const GENERIC_MATCH_WORDS = new Set([
  "agent",
  "artifact",
  "create",
  "from",
  "generated",
  "into",
  "asks",
  "skill",
  "source",
  "style",
  "this",
  "user",
  "video",
  "want",
  "wants",
  "when",
  "with",
  "workflow"
]);

export class SkillRegistry {
  readonly #skills = new Map<string, LoadedSkill | SkillDefinition>();
  readonly #conflicts: SkillRegistryConflict[] = [];

  register(skill: LoadedSkill | SkillDefinition): void {
    const existing = this.#skills.get(skill.name);

    if (existing !== undefined) {
      const decision = resolveConflict(existing, skill);

      if (decision.conflict !== undefined) {
        this.#conflicts.push(decision.conflict);
      }

      if (!decision.useIncoming) {
        return;
      }
    }

    this.#skills.set(skill.name, skill);
  }

  get(name: string): LoadedSkill | SkillDefinition | undefined {
    return this.#skills.get(name);
  }

  resolve(name: string): LoadedSkill | SkillDefinition | undefined {
    return this.get(name);
  }

  /** Exact names take precedence over aliases; collisions remain visible. */
  resolveReference(reference: string): Array<LoadedSkill | SkillDefinition> {
    const normalized = reference.toLocaleLowerCase("en-US");
    const exact = this.list().filter((skill) => skill.name.toLocaleLowerCase("en-US") === normalized);
    return exact.length > 0 ? exact : this.list().filter((skill) =>
      skill.routing?.aliases?.some((alias) => alias.toLocaleLowerCase("en-US") === normalized));
  }

  listConflicts(): SkillRegistryConflict[] {
    return [...this.#conflicts];
  }

  unregister(name: string): void {
    this.#skills.delete(name);
  }

  list(): Array<LoadedSkill | SkillDefinition> {
    return [...this.#skills.values()];
  }

  listLoaded(): LoadedSkill[] {
    return this.list().filter(isLoadedSkill);
  }

  catalog(): SkillCatalogEntry[] {
    return this.list()
      .map((skill) => ({
        name: skill.name,
        description: skill.description,
        version: skill.version,
        category: skill.category ?? "general",
        requiredToolsets: [...skill.requiredToolsets],
        sourceKind: isLoadedSkill(skill) ? skill.sourceKind : undefined,
        sourcePath: isLoadedSkill(skill) ? skill.sourcePath : undefined,
        instructionBytes: isLoadedSkill(skill) ? Buffer.byteLength(skill.instructions) : undefined,
        provenanceKind: isLoadedSkill(skill) ? skill.provenance?.kind : undefined,
        lifecycleState: isLoadedSkill(skill) ? skill.lifecycleState : undefined
      }))
      .sort((left, right) => left.category.localeCompare(right.category) || left.name.localeCompare(right.name));
  }

  loadInstructions(name: string): string | undefined {
    const skill = this.#skills.get(name);
    return skill !== undefined && isLoadedSkill(skill) ? skill.instructions : undefined;
  }

  listByToolset(toolset: ToolsetName): Array<LoadedSkill | SkillDefinition> {
    return this.list().filter((skill) => skill.requiredToolsets.includes(toolset));
  }

  matchPrompt(prompt: string): Array<LoadedSkill | SkillDefinition> {
    const normalizedPrompt = normalize(prompt);

    return this.list().filter((skill) => {
      const searchable = [
        skill.name,
        skill.description,
        ...(skill.routing?.labels ?? []),
        ...(skill.routing?.triggerPatterns?.map((pattern) => pattern.value) ?? []),
        ...(skill.intentLabels ?? []),
        ...(skill.triggerPatterns ?? []),
        ...skill.whenToUse,
        ...skill.examples
      ]
        .map(normalize)
        .join(" ");

      return searchable
        .split(/\s+/)
        .filter((word) => word.length > 3 && !GENERIC_MATCH_WORDS.has(word))
        .some((word) => new RegExp(`(^|\\s)${escapeRegExp(word)}($|\\s)`, "u").test(normalizedPrompt));
    });
  }
}

function resolveConflict(
  existing: LoadedSkill | SkillDefinition,
  incoming: LoadedSkill | SkillDefinition
): { useIncoming: boolean; conflict?: SkillRegistryConflict } {
  const existingPriority = isLoadedSkill(existing) ? SOURCE_PRIORITY[existing.sourceKind] : 0;
  const incomingPriority = isLoadedSkill(incoming) ? SOURCE_PRIORITY[incoming.sourceKind] : 0;

  const useIncoming = incomingPriority > existingPriority;
  const kept = useIncoming ? incoming : existing;
  const ignored = useIncoming ? existing : incoming;

  return {
    useIncoming,
    conflict: {
      name: incoming.name,
      kept: sourceSummary(kept),
      ignored: sourceSummary(ignored),
      reason: conflictReason(kept, ignored)
    }
  };
}

function sourceSummary(skill: LoadedSkill | SkillDefinition): SkillRegistryConflict["kept"] {
  return {
    sourceKind: isLoadedSkill(skill) ? skill.sourceKind : undefined,
    sourcePath: isLoadedSkill(skill) ? skill.sourcePath : undefined
  };
}

function conflictReason(
  kept: LoadedSkill | SkillDefinition,
  ignored: LoadedSkill | SkillDefinition
): SkillRegistryConflict["reason"] {
  const keptSource = isLoadedSkill(kept) ? kept.sourceKind : undefined;
  const ignoredSource = isLoadedSkill(ignored) ? ignored.sourceKind : undefined;

  if (keptSource === ignoredSource) {
    return "duplicate-source";
  }
  if (keptSource === "local" && ignoredSource === "external") {
    return "local-shadows-external";
  }
  if (keptSource === "local" && ignoredSource === "bundled") {
    return "local-shadows-bundled";
  }

  return "external-shadowed";
}

function isLoadedSkill(skill: LoadedSkill | SkillDefinition): skill is LoadedSkill {
  return "sourcePath" in skill && "instructions" in skill;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]+/g, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
