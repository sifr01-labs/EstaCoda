import { posix } from "node:path";

export const verificationInputsSchema = {
  type: ["array", "null"], items: { type: "string" }, minItems: 1, maxItems: 32,
  description: "Optional complete input scope for a declared verification: workspace-relative files or directories, including tests, configuration and dependencies. No globs. Use '.' or omit when dependencies are unknown. Only observed writes outside every declared input preserve this check; this is a declared scope, not automatic dependency analysis."
};

export function verificationInputs(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) return undefined;
  if (!value.every(path => typeof path === "string" && path.length > 0 && path.length <= 240 &&
    !/[/\\]$|[\\*?\[\]{}\x00-\x1f]|^(?:\/|[a-z]:)/iu.test(path) && !path.split("/").includes(".."))) return undefined;
  return [...new Set((value as string[]).map(path => posix.normalize(path)))];
}

export function verificationAffected(inputs: readonly string[] | undefined, changed: readonly string[] | undefined): boolean {
  if (!inputs || !changed || changed.length === 0) return true;
  return inputs.some(input => input === "." || changed.some(path => path === input || path.startsWith(`${input}/`) || input.startsWith(`${path}/`)));
}
