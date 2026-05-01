import type { LoadedSkill, SkillDefinition } from "../contracts/skill.js";
import type { SkillEvolutionStore } from "./skill-evolution.js";

export type SkillMutationAction = "patch" | "edit" | "delete" | "write-file" | "remove-file" | "promote";

export async function assertSkillMutable(options: {
  skill: LoadedSkill | SkillDefinition;
  action: SkillMutationAction;
  store?: SkillEvolutionStore;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const usage = await options.store?.getUsage(options.skill.name);

  if (usage?.pinned === true) {
    return {
      ok: false,
      reason: `Skill ${options.skill.name} is pinned and cannot be changed by skill.${options.action}.`
    };
  }

  return { ok: true };
}

export async function assertSkillContentMutationAllowed(options: {
  current: LoadedSkill | SkillDefinition;
  next: LoadedSkill | SkillDefinition;
  action: SkillMutationAction;
  store?: SkillEvolutionStore;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const mutable = await assertSkillMutable({
    skill: options.current,
    action: options.action,
    store: options.store
  });
  if (!mutable.ok) {
    return mutable;
  }

  const authorityExpansion = detectAuthorityExpansion(options.current, options.next);
  if (authorityExpansion.length > 0) {
    return {
      ok: false,
      reason: [
        `Skill ${options.current.name} ${options.action} would expand skill authority.`,
        "Credential, environment, toolset, or permission expansions require explicit human approval and are refused by this tool path.",
        `Changes: ${authorityExpansion.join("; ")}`
      ].join(" ")
    };
  }

  return { ok: true };
}

function detectAuthorityExpansion(
  current: LoadedSkill | SkillDefinition,
  next: LoadedSkill | SkillDefinition
): string[] {
  return [
    ...newValues("requiredEnvironmentVariables", current.requiredEnvironmentVariables, next.requiredEnvironmentVariables),
    ...newValues("requiredCredentialFiles", current.requiredCredentialFiles, next.requiredCredentialFiles),
    ...newValues("requiredToolsets", current.requiredToolsets, next.requiredToolsets),
    ...newValues("optionalToolsets", current.optionalToolsets, next.optionalToolsets),
    ...newPermissionExpectations(current.permissionExpectations, next.permissionExpectations)
  ];
}

function newValues(label: string, before: readonly string[] | undefined, after: readonly string[] | undefined): string[] {
  const beforeSet = new Set((before ?? []).map(normalizeComparable));
  return (after ?? [])
    .filter((value) => !beforeSet.has(normalizeComparable(value)))
    .map((value) => `${label} added ${value}`);
}

function newPermissionExpectations(
  before: readonly string[] | undefined,
  after: readonly string[] | undefined
): string[] {
  return newValues("permissionExpectations", before, after)
    .filter((change) => /write|external|credential|destructive/iu.test(change));
}

function normalizeComparable(value: string): string {
  return value.trim().toLowerCase();
}
