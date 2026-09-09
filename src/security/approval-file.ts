import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { openDefaultSQLiteDatabase } from "../storage/factory.js";

export type ApprovalFile<T> = { version: 2; revision: number; grants: T[] };
export function readApprovalFile<T>(path: string, valid: (value: unknown) => value is T): ApprovalFile<T> {
  let raw: string;
  try { raw = readFileSync(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 2, revision: 0, grants: [] }; throw error; }
  const file = JSON.parse(raw);
  if (!file || ![1, 2].includes(file.version) || !Array.isArray(file.grants) ||
    (file.version === 2 && (!Number.isSafeInteger(file.revision) || file.revision < 0))) throw new Error("Unsupported or corrupt approval store. Restore a compatible backup.");
  return { version: 2, revision: file.version === 1 ? 0 : file.revision, grants: file.grants.filter(valid).map((grant: T) => {
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
