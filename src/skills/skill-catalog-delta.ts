import { createHash } from "node:crypto";
import type { LoadedSkill, SkillCatalogEntry, SkillDefinition } from "../contracts/skill.js";

/** Snapshot only the already-filtered session catalog. Never expose hidden names. */
export function snapshotSkillCatalog(
  catalog: readonly SkillCatalogEntry[],
  resolve: (name: string) => LoadedSkill | SkillDefinition | undefined
): Map<string, string> {
  return new Map(catalog.map((entry) => [entry.name, createHash("sha256")
    .update(JSON.stringify([entry, resolve(entry.name)])).digest("hex")]));
}

export function skillCatalogDelta(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>) {
  return {
    added: [...after.keys()].filter((name) => !before.has(name)).sort(),
    removed: [...before.keys()].filter((name) => !after.has(name)).sort(),
    changed: [...after.keys()].filter((name) => before.has(name) && before.get(name) !== after.get(name)).sort()
  };
}
