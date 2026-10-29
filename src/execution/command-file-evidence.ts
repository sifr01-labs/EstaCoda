import { createHash, randomUUID } from "node:crypto";
import { MAX_FILE_OUTPUTS, requestedFileOutputs, requiresFileContentVerification, validateRequestRequirements } from "../contracts/request-requirements.js";
import type { RequestRequirements } from "../contracts/intent.js";
import type { WorkspaceFiles } from "./host-workspace-files.js";

/** Runtime observations of explicitly requested destinations only. No directory
 * scans, command parsing, provider-supplied hashes, or file contents in receipts. */
export type CommandFileObservation = {
  id: string;
  completed: boolean;
  /** A file snapshot while an explicitly declared service remains running. */
  serviceCheckpoint?: true;
  originTurnId: string;
  files: Array<{ path: string; before: string | null | undefined; after?: string | null; metadataOnly?: true }>;
};

export async function beginCommandFileObservation(files: WorkspaceFiles, requirements?: RequestRequirements, visibleTurnId?: string, contentOnly = false): Promise<CommandFileObservation | undefined> {
  if (!requirements || !visibleTurnId || requirements.issues.length) return undefined;
  try { validateRequestRequirements(requirements); } catch { return undefined; }
  const outputs = requestedFileOutputs(requirements);
  const paths = [...new Set(outputs.flatMap(file => [file.path, ...(file.alternativePaths ?? [])]))];
  if (!paths.length || paths.length > MAX_FILE_OUTPUTS) return undefined;
  const observations: CommandFileObservation["files"] = [];
  for (const path of paths) {
    if (path === undefined) continue;
    const requirement = outputs.find(file => file.path === path || file.alternativePaths?.includes(path))!;
    const metadataOnly = !contentOnly && !requiresFileContentVerification(requirements, requirement);
    const before = await observe(files, path, metadataOnly);
    if (before !== undefined || contentOnly) observations.push({ path, before, ...(metadataOnly ? { metadataOnly: true as const } : {}) });
  }
  return observations.length ? { id: randomUUID(), completed: false, originTurnId: visibleTurnId, files: observations } : undefined;
}

export async function finishCommandFileObservation(files: WorkspaceFiles, observation?: CommandFileObservation): Promise<CommandFileObservation | undefined> {
  if (!observation) return undefined;
  const outputs: CommandFileObservation["files"] = [];
  for (const file of observation.files) outputs.push({ ...file, after: await observe(files, file.path, file.metadataOnly === true) });
  return { ...observation, completed: true, files: outputs };
}

async function observe(files: WorkspaceFiles, path: string, metadataOnly: boolean): Promise<string | null | undefined> {
  if (!metadataOnly) return digest(files, path);
  try { return await files.observeOutput?.(path); } catch { return undefined; }
}

async function digest(files: WorkspaceFiles, path: string): Promise<string | null | undefined> {
  try {
    const resolved = await files.resolvePath(path, { allowMissingLeaf: true, forbidSymlinks: true });
    if (!resolved.ok) return undefined;
    let stat;
    try {
      stat = await files.lstat(resolved.path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) return undefined;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined;
    }
    // WorkspaceFiles applies execution-view containment, secret exclusions and
    // bounded reads again, including Docker-backed workspaces.
    const bytes = await files.readFile(resolved.path);
    if (!(await files.resolvePath(path, { forbidSymlinks: true })).ok) return undefined;
    const after = await files.lstat(resolved.path);
    if (!after.isFile() || after.isSymbolicLink() || after.ino !== stat.ino || after.dev !== stat.dev || after.mtimeMs !== stat.mtimeMs || after.size !== stat.size || bytes.length !== stat.size) return undefined;
    return createHash("sha256").update(bytes).digest("hex");
  } catch { return undefined; }
}
