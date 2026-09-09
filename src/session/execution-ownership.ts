import { randomUUID } from "node:crypto";
import type { SQLiteDatabase } from "../storage/sqlite.js";

export const EXECUTION_OWNERSHIP_SCHEMA_VERSION = 34;
export function migrateExecutionOwnershipV34(db: SQLiteDatabase): void {
  db.exec(`create table session_execution_owners (
    session_id text primary key references sessions(id), profile_id text not null,
    target_id text not null, owner_id text, owner_pid integer,
    fence integer not null, heartbeat_at integer not null, expires_at integer not null,
    turn_revision integer not null default 0, control_revision integer not null default 0
  );`);
}
export type ExecutionClaim = Readonly<{
  sessionId: string; profileId: string; targetId: string; ownerId: string; fence: number;
}>;
type OwnerRow = {
  session_id: string; profile_id: string; target_id: string; owner_id: string | null;
  owner_pid: number | null; fence: number;
};

/** Only ESRCH proves absence. Unknown state, EPERM, expiry and PID reuse all
 * remain busy. A live reused PID is conservatively unavailable, never stolen. */
export function processDefinitelyAbsent(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

export class SessionExecutionOwnership {
  constructor(readonly db: SQLiteDatabase) {}

  claim(input: { sessionId: string; profileId: string; targetId: string }): ExecutionClaim {
    this.db.exec("begin immediate");
    try {
      const session = this.db.query<{ profile_id: string; target_id: string | null; ended_at: string | null }>(
        "select profile_id, json_extract(execution_target_json, '$.targetId') as target_id, ended_at from sessions where id = ?"
      ).get(input.sessionId);
      if (!session || session.profile_id !== input.profileId || session.target_id !== input.targetId || session.ended_at !== null) {
        throw new Error("Execution ownership does not match the live Session target.");
      }
      const existing = this.db.query<OwnerRow>("select * from session_execution_owners where session_id = ?").get(input.sessionId);
      if (existing?.owner_id && !processDefinitelyAbsent(existing.owner_pid ?? 0)) {
        throw new Error("Session execution is busy. Attach to its owner or wait for a settled handoff.");
      }
      const claim = Object.freeze({ ...input, ownerId: randomUUID(), fence: (existing?.fence ?? 0) + 1 });
      const now = Date.now();
      this.db.query(`insert into session_execution_owners
        (session_id, profile_id, target_id, owner_id, owner_pid, fence, heartbeat_at, expires_at)
        values (?, ?, ?, ?, ?, ?, ?, ?) on conflict(session_id) do update set
        owner_id=excluded.owner_id, owner_pid=excluded.owner_pid, fence=excluded.fence,
        heartbeat_at=excluded.heartbeat_at, expires_at=excluded.expires_at`)
        .run(input.sessionId, input.profileId, input.targetId, claim.ownerId, process.pid, claim.fence, now, now + 30_000);
      this.db.exec("commit");
      return claim;
    } catch (error) { this.db.exec("rollback"); throw error; }
  }

  assert(claim: ExecutionClaim): void {
    const row = this.db.query<OwnerRow>("select * from session_execution_owners where session_id = ?").get(claim.sessionId);
    if (!row || row.profile_id !== claim.profileId || row.target_id !== claim.targetId || row.owner_id !== claim.ownerId || row.fence !== claim.fence) {
      throw new Error("Session execution ownership was lost; reacquire before continuing.");
    }
  }

  renew(claim: ExecutionClaim): void {
    this.transition(claim, "heartbeat_at = ?, expires_at = ?", [Date.now(), Date.now() + 30_000]);
  }
  advance(claim: ExecutionClaim, kind: "turn" | "control"): void {
    const column = kind === "turn" ? "turn_revision" : "control_revision";
    this.transition(claim, `${column} = ${column} + 1`, []);
  }
  /** Call only after all execution resources and authoritative writes settle. */
  release(claim: ExecutionClaim): void {
    this.transition(claim, "owner_id = null, owner_pid = null", []);
  }
  private transition(claim: ExecutionClaim, assignment: string, values: number[]): void {
    const result = this.db.query(`update session_execution_owners set ${assignment}
      where session_id = ? and profile_id = ? and target_id = ? and owner_id = ? and fence = ?`)
      .run(...values, claim.sessionId, claim.profileId, claim.targetId, claim.ownerId, claim.fence);
    if (result.changes !== 1) throw new Error("Session execution ownership was lost; transition rejected.");
  }
}
