import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { openDefaultSQLiteDatabase } from "./factory.js";

export function readJsonState<T>(path: string, empty: () => T, decode: (value: unknown) => T): T {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error("State file must not be a symbolic link.");
    return decode(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty(); throw error; }
}
/** Kernel-owned mutex, synchronous read/modify/write, atomic JSON publication.
 * JSON stays canonical; crashes release the mutex without timestamp stealing. */
export function updateJsonState<T, R>(path: string, read: () => T, update: (state: T) => R): R {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lockPath = `${path}.lock.sqlite`, temporary = `${path}.${randomUUID()}.tmp`;
  try { if (lstatSync(lockPath).isSymbolicLink()) throw new Error("State lock must not be a symbolic link."); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const lock = openDefaultSQLiteDatabase({ path: lockPath });
  try {
    chmodSync(lockPath, 0o600); lock.exec("begin immediate");
    const state = read(); const before = JSON.stringify(state);
    const result = update(state);
    if (JSON.stringify(state) !== before) {
      writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      renameSync(temporary, path);
    }
    lock.exec("commit"); return result;
  } finally {
    lock.close();
    try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
