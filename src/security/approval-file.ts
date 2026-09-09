import { validApprovalScope, type ApprovalExecutionScope } from "./approval-scope.js";
import { exactActionKey } from "./exact-action-key.js";
import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { openDefaultSQLiteDatabase } from "../storage/factory.js";

export type ApprovalFile<T> = { version: 3; revision: number; grants: T[]; revocations: Record<string, number> };
export type ApprovalAuthority = { executionScope?: ApprovalExecutionScope; toolName?: string; riskClass: string; targetKey?: string };
function authorityKey(authority: ApprovalAuthority): string | undefined {
  const scope = authority.executionScope;
  if (!validApprovalScope(scope)) return undefined;
  return exactActionKey([scope.profileId, scope.workspaceIdentityHash, scope.authorityFingerprint, scope.surfaceKey,
    authority.toolName, authority.riskClass, authority.targetKey]);
}
/** File revision serializes storage; only revocations of this authority fence it.
 * Tombstones survive removal/regrant, even when no matching grant remains. */
export function approvalAuthorityRevision(file: ApprovalFile<unknown>, authority?: ApprovalAuthority): number {
  if (authority === undefined) return file.revision;
  const key = authorityKey(authority);
  return key === undefined ? file.revision : file.revocations[key] ?? 0;
}
export function recordApprovalRevocation(file: ApprovalFile<unknown>, authority: ApprovalAuthority): void {
  const key = authorityKey(authority);
  if (key !== undefined) file.revocations[key] = file.revision;
}
export function hasApprovalGrant<T extends ApprovalAuthority & { id: string; authorizationGeneration?: number }>(file: ApprovalFile<T>, grant: T): boolean {
  const key = authorityKey(grant);
  return key !== undefined && file.grants.some((current) => current.id === grant.id && current.authorizationGeneration === grant.authorizationGeneration &&
    authorityKey(current) === key);
}
export function readApprovalFile<T>(path: string, valid: (value: unknown) => value is T): ApprovalFile<T> {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 3, revision: 0, grants: [], revocations: {} }; throw error; }
  const file = JSON.parse(raw);
  if (!file || ![1, 2, 3].includes(file.version) || !Array.isArray(file.grants) ||
    (file.version >= 2 && (!Number.isSafeInteger(file.revision) || file.revision < 0))) throw new Error("Unsupported or corrupt approval store. Restore a compatible backup.");
  if (file.version === 3 && (!file.revocations || typeof file.revocations !== "object" || Array.isArray(file.revocations) ||
    Object.entries(file.revocations).some(([key, revision]) => !/^[a-f0-9]{64}$/u.test(key) || !Number.isSafeInteger(revision) || (revision as number) < 1 || (revision as number) > file.revision))) throw new Error("Unsupported or corrupt approval revocations. Restore a compatible backup.");
  return { version: 3, revocations: file.version === 3 ? file.revocations : {}, revision: file.version === 1 ? 0 : file.revision, grants: file.grants.filter(valid).map((grant: T) => {
    if (file.version !== 1) return grant;
    const legacy = { ...grant } as T & { executionScope?: unknown; authorizationGeneration?: unknown };
    delete legacy.executionScope; delete legacy.authorizationGeneration;
    return legacy;
  }) };
}

/** SQLite is only a cross-process write mutex; JSON remains the existing source
 * of truth. Kernel-managed transactions release on process death, with no PID or
 * age-based lock stealing. The synchronous critical section contains no await. */
export function updateApprovalFile<T, R>(path: string, valid: (value: unknown) => value is T, update: (file: ApprovalFile<T>) => R): R {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock.sqlite`;
  for (const candidate of [path, lockPath]) {
    try { if (lstatSync(candidate).isSymbolicLink()) throw new Error("Approval state must not be a symbolic link."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const lock = openDefaultSQLiteDatabase({ path: lockPath });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    chmodSync(lockPath, 0o600);
    lock.exec("begin immediate");
    const file = readApprovalFile(path, valid);
    const previous = JSON.stringify(file);
    const result = update(file);
    if (!Number.isSafeInteger(file.revision) || file.revision < 0) throw new Error("Approval revision exhausted. Restore a compatible backup.");
    if (JSON.stringify(file) !== previous) {
      writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, path);
    }
    lock.exec("commit");
    return result;
  } finally {
    lock.close();
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
