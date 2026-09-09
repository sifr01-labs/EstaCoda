import { randomUUID } from "node:crypto";
import type { SQLiteDatabase } from "../storage/sqlite.js";
import { validatePrivateControlRequest, type PrivateControlRequest } from "./private-control.js";

export const CONTROL_RECEIPT_SCHEMA_VERSION = 35;
export function migrateControlReceiptsV35(db: SQLiteDatabase): void {
  db.exec(`create table session_control_receipts (
    profile_id text not null, principal text not null, method text not null, operation_id text not null,
    session_id text not null references sessions(id), target_id text not null,
    input_event_id text not null, instance_id text not null,
    status text not null check(status in ('accepted','dispatched','completed','uncertain')),
    accepted_at integer not null, result_json text,
    primary key(profile_id, principal, method, operation_id)
  );`);
}
type ReceiptRow = { method: string; operation_id: string; session_id: string; target_id: string;
  input_event_id: string; instance_id: string; status: string; accepted_at: number; result_json: string | null };
export type ControlReceipt = { operationId: string; method: string; sessionId: string; status: string; result?: unknown };
const RETENTION_MS = 30 * 86_400_000;
const ACCEPT_WINDOW_MS = 5 * 60_000;
function canonical(request: PrivateControlRequest): string {
  return JSON.stringify({ method: request.method, sessionId: request.sessionId, targetId: request.targetId,
    operationId: request.operationId, ...(request.method === "send" ? { text: request.text } : {}),
    ...(request.method === "approval" ? { approvalId: request.approvalId, decision: request.decision } : {}) });
}
function projection(row: ReceiptRow): ControlReceipt {
  return { operationId: row.operation_id, method: row.method, sessionId: row.session_id, status: row.status,
    ...(row.result_json ? { result: JSON.parse(row.result_json) } : {}) };
}
/** Payloads use the existing bounded Session event store. Receipts contain only
 * references and safe control metadata, never tokens or input-derived hashes. */
export class ControlReceipts {
  readonly #principal = `local-operator:${process.getuid?.() ?? "local"}`;
  constructor(readonly db: SQLiteDatabase, readonly profileId: string, readonly instanceId: string) {}
  recover(): void {
    // Supervisor singleton acquisition has already proven old-host death or
    // settled release. A dispatched operation is still never replayed.
    this.db.query("update session_control_receipts set status='uncertain' where profile_id=? and instance_id<>? and status in ('accepted','dispatched')")
      .run(this.profileId, this.instanceId);
    const expired = this.db.query<{ input_event_id: string }>("select input_event_id from session_control_receipts where profile_id=? and accepted_at<?")
      .all(this.profileId, Date.now() - RETENTION_MS);
    this.db.exec("begin immediate");
    try {
      for (const row of expired) this.db.query("delete from session_events where id=?").run(row.input_event_id);
      this.db.query("delete from session_control_receipts where profile_id=? and accepted_at<?").run(this.profileId, Date.now() - RETENTION_MS);
      this.db.exec("commit");
    } catch (error) { this.db.exec("rollback"); throw error; }
  }
  inspect(request: PrivateControlRequest): ControlReceipt[] {
    return this.db.query<ReceiptRow>(`select * from session_control_receipts where profile_id=? and principal=? and operation_id=? and session_id=? and target_id=?`)
      .all(this.profileId, this.#principal, request.operationId, request.sessionId, request.targetId).map(projection);
  }
  accept(request: PrivateControlRequest): { inserted: boolean; receipt: ControlReceipt } {
    validatePrivateControlRequest(request);
    const binding = canonical(request);
    this.db.exec("begin immediate");
    try {
      const existing = this.db.query<ReceiptRow>("select * from session_control_receipts where profile_id=? and principal=? and method=? and operation_id=?")
        .get(this.profileId, this.#principal, request.method, request.operationId);
      if (existing) {
        const event = this.db.query<{ event_json: string }>("select event_json from session_events where id=?").get(existing.input_event_id);
        if (!event || JSON.parse(event.event_json).payload !== binding) throw new Error("Operation ID was already bound to different input, or its payload expired.");
        this.db.exec("commit"); return { inserted: false, receipt: projection(existing) };
      }
      const timestamp = Number(request.operationId.split(":", 1)[0]);
      if (!Number.isSafeInteger(timestamp) || Math.abs(Date.now() - timestamp) > ACCEPT_WINDOW_MS) throw new Error("Unknown or expired operation ID. Reconcile before submitting new work.");
      const count = this.db.query<{ count: number }>("select count(*) as count from session_control_receipts where profile_id=?").get(this.profileId)!.count;
      if (count >= 10_000) throw new Error("Control receipt retention capacity reached.");
      const session = this.db.query<{ target: string; profile_id: string; ended_at: string | null }>("select profile_id, ended_at, json_extract(execution_target_json, '$.targetId') as target from sessions where id=?").get(request.sessionId);
      if (!session || session.profile_id !== this.profileId || session.target !== request.targetId || session.ended_at) throw new Error("Control Session binding changed.");
      const eventId = randomUUID(), now = Date.now();
      this.db.query("insert into session_events values (?, ?, ?, ?)").run(eventId, request.sessionId, new Date(now).toISOString(), JSON.stringify({ type: "private-control-input", payload: binding }));
      this.db.query("insert into session_control_receipts values (?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?, null)")
        .run(this.profileId, this.#principal, request.method, request.operationId, request.sessionId, request.targetId, eventId, this.instanceId, now);
      this.db.exec("commit");
      return { inserted: true, receipt: { operationId: request.operationId, method: request.method, sessionId: request.sessionId, status: "accepted" } };
    } catch (error) { this.db.exec("rollback"); throw error; }
  }
  transition(request: PrivateControlRequest, status: "dispatched" | "completed" | "uncertain", result?: unknown): void {
    const expected = status === "dispatched" ? "accepted" : "dispatched";
    const changed = this.db.query(`update session_control_receipts set status=?, result_json=? where profile_id=? and principal=? and method=? and operation_id=? and instance_id=? and status=?`)
      .run(status, result === undefined ? null : JSON.stringify(result), this.profileId, this.#principal, request.method, request.operationId, this.instanceId, expected);
    if (changed.changes !== 1) throw new Error("Control receipt transition was fenced.");
  }
}
export function createControlOperationId(): string { return `${Date.now()}:${randomUUID()}`; }
