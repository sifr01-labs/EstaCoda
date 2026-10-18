import type { RequestRequirements } from "./intent.js";
import { redactString } from "../utils/redaction.js";
import type { DelegatedRequestContract } from "./delegation.js";

export function validateDelegatedRequestContract(value: unknown): DelegatedRequestContract {
  const record = object(value, ["version", "objective", "requirements", "skillName"]);
  if (record.version !== 1 || typeof record.objective !== "string" || record.objective.length === 0 || record.objective.length > 2000 ||
    (record.skillName !== undefined && (typeof record.skillName !== "string" || !/^[\p{L}\p{N}_-]{1,80}$/u.test(record.skillName)))) throw new Error("Invalid delegated request contract.");
  return { version: 1, objective: record.objective, requirements: validateRequestRequirements(record.requirements),
    ...(record.skillName === undefined ? {} : { skillName: record.skillName as string }) };
}

export function isDelegatedRequestContractValid(value: unknown): boolean {
  if (value === undefined) return true;
  try { validateDelegatedRequestContract(value); return true; } catch { return false; }
}

/** Persisted requirements are bounded user intent, never evidence or authority. */
export function validateRequestRequirements(value: unknown): RequestRequirements {
  const record = object(value, ["sourceTaskId", "originTurnId", "skillReferences", "delegation", "fileOutput", "research", "issues"]);
  if (record.sourceTaskId !== undefined && (typeof record.sourceTaskId !== "string" || !/^[A-Za-z0-9_.:-]{1,256}$/u.test(record.sourceTaskId))) throw new Error("Invalid source Task reference.");
  if (JSON.stringify(record).length > 4096) throw new Error("Request requirements exceed their budget.");
  if (!Array.isArray(record.skillReferences) || record.skillReferences.length > 4 || !record.skillReferences.every((name) =>
    typeof name === "string" && /^[\p{L}\p{N}_-]{1,80}$/u.test(name))) throw new Error("Invalid skill requirements.");
  if (!Array.isArray(record.issues) || record.issues.length > 3 || !record.issues.every((issue) =>
    ["request-too-long", "ambiguous-file-target", "unsafe-file-target"].includes(String(issue)))) throw new Error("Invalid requirement issues.");
  if (record.originTurnId !== undefined && (typeof record.originTurnId !== "string" || !/^[A-Za-z0-9_.:-]{1,256}$/u.test(record.originTurnId))) throw new Error("Invalid requirement origin.");
  if (record.delegation !== undefined) {
    const delegation = object(record.delegation, ["count"]);
    if (delegation.count !== undefined && (!Number.isSafeInteger(delegation.count) || Number(delegation.count) < 0 || Number(delegation.count) > 999_999_999)) throw new Error("Invalid worker count.");
  }
  if (record.research !== undefined) {
    const research = object(record.research, ["domain", "fresh"]);
    if (!["general", "literature", "paper"].includes(String(research.domain)) || typeof research.fresh !== "boolean") throw new Error("Invalid research requirement.");
  }
  if (record.fileOutput !== undefined) {
    const file = object(record.fileOutput, ["format", "path", "exactCopy"]);
    if (file.exactCopy !== undefined) {
      const copy = object(file.exactCopy, ["sourcePath"]);
      if (copy.sourcePath !== undefined) validateRequestRequirements({ skillReferences: [], issues: [], fileOutput: { format: "text", path: copy.sourcePath } });
    }
    if (file.format !== "markdown" && file.format !== "text") throw new Error("Invalid file format.");
    if (file.path !== undefined && (typeof file.path !== "string" || file.path.length === 0 || file.path.length > 240 ||
      /^(?:[/\\]|[a-z]:)|[\u0000-\u001f\u007f]/iu.test(file.path) || file.path.split(/[/\\]/u).includes("..") ||
      redactString(file.path, { strict: true }) !== file.path)) throw new Error("Invalid relative file target.");
  }
  return structuredClone(record) as RequestRequirements;
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new Error("Invalid request requirement state.");
  return value as Record<string, unknown>;
}
