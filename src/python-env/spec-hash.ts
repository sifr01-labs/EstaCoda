import { createHash } from "node:crypto";
import type { ManagedPythonCapabilityEnvSpec } from "./capability-registry.js";

export function fingerprintManagedPythonCapabilitySpec(
  spec: ManagedPythonCapabilityEnvSpec,
  selectedGroups: string[] = []
): string {
  const groups = normalizeSelectedGroups(spec, selectedGroups);
  const payload = {
    id: spec.id,
    version: spec.version,
    packages: spec.packages,
    verifyImports: spec.verifyImports,
    pythonVersion: spec.pythonVersion,
    estimatedInstallSizeMb: spec.estimatedInstallSizeMb,
    optionalGroups: Object.fromEntries(groups.map((groupId) => [groupId, spec.optionalGroups?.[groupId]]))
  };
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

function normalizeSelectedGroups(spec: ManagedPythonCapabilityEnvSpec, selectedGroups: string[]): string[] {
  const knownGroups = spec.optionalGroups ?? {};
  const unique = [...new Set(selectedGroups)];
  unique.sort();
  for (const groupId of unique) {
    if (knownGroups[groupId] === undefined) {
      throw new Error(`Unknown optional group '${groupId}' for managed Python capability '${spec.id}'.`);
    }
  }
  return unique;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => [key, sortJson(entryValue)]));
  }
  return value;
}
