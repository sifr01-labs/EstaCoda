import type { SQLiteDatabase } from '../storage/sqlite.js';
import type { SessionEvent } from '../contracts/session.js';
import type { DisplayEvent } from './work-projections.js';
export const DISPLAY_EVENT_FILTER = `json_valid(event_json) and (
  json_extract(event_json,'$.kind') in ('tool-called','tool-result','execution-final-outcome-recorded','agent-cancelled')
  or (json_extract(event_json,'$.kind') like 'execution-plan-%' and json_type(event_json,'$.plan.items')='array' and length(json_extract(event_json,'$.plan'))<=16384))`;
/** Read only fields allowed in Desktop, so a large tool result is never buffered by the bridge. */
export function sessionDisplayEvents(db: SQLiteDatabase, sessionId: string, options: { row?: number; limit?: number; outcomeOnly?: boolean } = {}): DisplayEvent[] {
  const rows = db.query<{ id: string; created_at: string; kind: string; tool: string | null; ok: number | null; status: string | null;
    turn: string | null; cause: string | null; floor: string | null; plan: string | null }>(`
    select id, created_at, json_extract(event_json,'$.kind') as kind,
      json_extract(event_json,'$.tool') as tool, json_extract(event_json,'$.result.ok') as ok,
      json_extract(event_json,'$.turnMessageId') as turn, json_extract(event_json,'$.status') as status, json_extract(event_json,'$.terminationCause') as cause,
      json_extract(event_json,'$.completionFloor') as floor,
      case when length(json_extract(event_json,'$.plan')) <= 16384 then json_extract(event_json,'$.plan') else null end as plan
    from session_events where session_id=? and ${DISPLAY_EVENT_FILTER}
      ${options.row === undefined ? '' : 'and rowid=?'}
      ${options.outcomeOnly ? "and json_extract(event_json,'$.kind')='execution-final-outcome-recorded'" : ''}
      order by rowid desc limit ?`).all(sessionId, ...(options.row === undefined ? [] : [options.row]), options.limit ?? 32);
  return rows.map((row) => ({ id: row.id, createdAt: row.created_at, event: {
    kind: row.kind, turnMessageId: row.turn ?? undefined, tool: row.tool, result: { ok: row.ok === 1 }, status: row.status, terminationCause: row.cause, completionFloor: row.floor,
    ...(row.plan ? { plan: JSON.parse(row.plan) } : {}),
  } as SessionEvent }));
}
