import { AsyncLocalStorage } from "node:async_hooks";
import type { SQLiteDatabase, SQLiteStatement, SQLiteValue } from "../storage/sqlite.js";
import type { ExecutionClaim } from "./execution-ownership.js";

const context = new AsyncLocalStorage<{ db: SQLiteDatabase; claim: ExecutionClaim; assertLive?: () => void }>();
export function withExecutionFence<T>(db: SQLiteDatabase, claim: ExecutionClaim, work: () => T, assertLive?: () => void): T {
  return context.run({ db, claim, assertLive }, work);
}
export function rotateExecutionFence(db: SQLiteDatabase, claim: ExecutionClaim): void {
  const current = context.getStore();
  if (current?.db === db) current.claim = claim;
}
export function assertCurrentExecutionFence(): void {
  const current = context.getStore();
  if (!current) return;
  const { db, claim } = current;
  const row = db.query<{ fence: number }>(`select fence from session_execution_owners
    where session_id=? and profile_id=? and target_id=? and owner_id=? and fence=?`)
    .get(claim.sessionId, claim.profileId, claim.targetId, claim.ownerId, claim.fence);
  if (!row) throw new Error("Session execution fence was lost.");
}

/** Fence each authoritative SQLite statement in the same write transaction.
 * Async execution carries the claim, never an open transaction across I/O.
 * Surface/finalization writes outside execution retain their own authorization. */
export function executionFencedDatabase(raw: SQLiteDatabase): SQLiteDatabase {
  let wrapper: SQLiteDatabase;
  const guarded = <T>(work: () => T): T => {
    const current = context.getStore();
    if (!current || current.db !== wrapper) return work();
    current.assertLive?.();
    const claim = current.claim;
    raw.exec("savepoint execution_fence");
    try {
      const checked = raw.query(`update session_execution_owners set heartbeat_at=heartbeat_at
        where session_id=? and profile_id=? and target_id=? and owner_id=? and fence=?`)
        .run(claim.sessionId, claim.profileId, claim.targetId, claim.ownerId, claim.fence);
      if (checked.changes !== 1) throw new Error("Session execution fence was lost; write rejected.");
      const result = work();
      raw.exec("release execution_fence");
      return result;
    } catch (error) {
      raw.exec("rollback to execution_fence"); raw.exec("release execution_fence"); throw error;
    }
  };
  wrapper = {
    exec: (sql) => raw.exec(sql),
    close: () => raw.close(),
    query<T>(sql: string): SQLiteStatement<T> {
      const statement = raw.query<T>(sql);
      return {
        run: (...args: SQLiteValue[]) => guarded(() => statement.run(...args)),
        get: (...args: SQLiteValue[]) => statement.get(...args),
        all: (...args: SQLiteValue[]) => statement.all(...args),
      };
    }
  };
  return wrapper;
}
