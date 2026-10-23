import { posix } from "node:path";
import type { FileOutputRequirement, RequestRequirements } from "./intent.js";
import { redactString } from "../utils/redaction.js";
import type { DelegatedRequestContract } from "./delegation.js";

export const MAX_FILE_OUTPUTS = 8;
export const MAX_REQUEST_REQUIREMENTS_CHARS = 4096;

/** The first output remains the primary report for existing presentation APIs. */
export function requestedFileOutputs(requirements: RequestRequirements | undefined): FileOutputRequirement[] {
  if (requirements?.fileOutput === undefined) return [];
  const { additionalFiles, ...primary } = requirements.fileOutput;
  return [primary, ...(additionalFiles ?? [])];
}

/** Old persisted contracts retain readback semantics. Neither a provider nor a
 * delivery step can downgrade exact-copy or accepted-report content checks. */
export function requiresFileContentVerification(requirements: RequestRequirements | undefined, file: FileOutputRequirement): boolean {
  return file.verification !== "execution" || file.exactCopy !== undefined || requirements?.sourceTaskId !== undefined || requirements?.research !== undefined;
}

export function requiresAnyFileContentVerification(requirements: RequestRequirements | undefined): boolean {
  return requestedFileOutputs(requirements).some(file => requiresFileContentVerification(requirements, file));
}

/** Completion identity only. Tool dispatch still enforces workspace containment.
 * Only a user-named bare filename may be fulfilled in an unspecified directory. */
export function matchesFileOutputPath(path: string, file: FileOutputRequirement): boolean {
  if (!path || /^(?:[/\\]|[a-z]:)/iu.test(path) || path.split(/[/\\]/u).includes("..")) return false;
  const normalized = posix.normalize(path.replaceAll("\\", "/"));
  return [file.path, ...(file.alternativePaths ?? [])].some(target => target !== undefined &&
    (file.directoryUnspecified === true ? posix.basename(normalized) === target : normalized === posix.normalize(target.replaceAll("\\", "/"))));
}

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
  if (JSON.stringify(record).length > MAX_REQUEST_REQUIREMENTS_CHARS) throw new Error("Request requirements exceed their budget.");
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
    const primary = object(record.fileOutput, ["format", "verification", "path", "directoryUnspecified", "alternativePaths", "exactCopy", "additionalFiles"]);
    const { additionalFiles, ...file } = primary;
    validateFile(file);
    if (additionalFiles !== undefined) {
      if (!Array.isArray(additionalFiles) || additionalFiles.length === 0 || additionalFiles.length >= MAX_FILE_OUTPUTS || file.path === undefined) throw new Error("Invalid additional file targets.");
      const paths = new Set([posix.normalize(String(file.path).replaceAll("\\", "/"))]);
      for (const additional of additionalFiles) {
        const output = validateFile(additional);
        if (output.path === undefined || paths.has(posix.normalize(String(output.path).replaceAll("\\", "/")))) throw new Error("Invalid duplicate or unnamed file target.");
        paths.add(posix.normalize(String(output.path).replaceAll("\\", "/")));
      }
    }
  }
  const targets = requestedFileOutputs(record as RequestRequirements).flatMap(file => [file.path, ...(file.alternativePaths ?? [])]);
  if (targets.length > MAX_FILE_OUTPUTS || new Set(targets.map(path => path === undefined ? path : posix.normalize(path.replaceAll("\\", "/")))).size !== targets.length) throw new Error("Invalid file target count or duplicates.");
  return structuredClone(record) as RequestRequirements;
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new Error("Invalid request requirement state.");
  return value as Record<string, unknown>;
}

function validateFile(value: unknown): Record<string, unknown> {
  const file = object(value, ["format", "verification", "path", "directoryUnspecified", "alternativePaths", "exactCopy"]);
  if (file.directoryUnspecified !== undefined && (file.directoryUnspecified !== true || file.exactCopy !== undefined ||
    [file.path, ...(Array.isArray(file.alternativePaths) ? file.alternativePaths : [])].some(path =>
      typeof path !== "string" || /[/\\:]|^\.{1,2}$/u.test(path)))) throw new Error("Invalid unspecified file directory.");
  if (file.alternativePaths !== undefined) {
    if (file.path === undefined || !Array.isArray(file.alternativePaths) || file.alternativePaths.length === 0 || file.alternativePaths.length >= MAX_FILE_OUTPUTS || file.exactCopy !== undefined) throw new Error("Invalid alternative file targets.");
    for (const path of file.alternativePaths) {
      if (typeof path !== "string") throw new Error("Invalid alternative file target.");
      validateFile({ format: "text", path });
    }
  }
  if (file.exactCopy !== undefined) {
    const copy = object(file.exactCopy, ["sourcePath"]);
    if (copy.sourcePath !== undefined) validateFile({ format: "text", path: copy.sourcePath });
  }
  if (file.verification !== undefined && file.verification !== "execution") throw new Error("Invalid file verification policy.");
  if (file.format !== "markdown" && file.format !== "text" && file.format !== "artifact") throw new Error("Invalid file format.");
  if (file.path !== undefined && (typeof file.path !== "string" || file.path.length === 0 || file.path.length > 240 ||
    /^(?:[/\\]|[a-z]:)|[\u0000-\u001f\u007f]/iu.test(file.path) || file.path.split(/[/\\]/u).includes("..") ||
    redactString(file.path, { strict: true }) !== file.path)) throw new Error("Invalid relative file target.");
  return file;
}
