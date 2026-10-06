import type { SQLiteDatabase } from '../storage/sqlite.js';
import type { SessionEvent } from '../contracts/session.js';
import type { DisplayEvent } from './work-projections.js';
export const DISPLAY_EVENT_FILTER = `json_valid(event_json) and (
  json_extract(event_json,'$.kind') in ('routing-status','provider-route','tool-called','tool-result','execution-final-outcome-recorded','agent-cancelled','session-artifact-registered')
  or (json_extract(event_json,'$.kind') like 'execution-plan-%' and json_type(event_json,'$.plan.items')='array' and length(json_extract(event_json,'$.plan'))<=16384))`;
/** Read only fields allowed in Desktop, so a large tool result is never buffered by the bridge. */
export function sessionDisplayEvents(db: SQLiteDatabase, sessionId: string, options: { row?: number; limit?: number; outcomeOnly?: boolean } = {}): DisplayEvent[] {
  const rows = db.query<{ id: string; created_at: string; kind: string; tool: string | null; ok: number | null; status: string | null;
    call_id: string | null; artifact: string | null; turn: string | null; cause: string | null; floor: string | null; plan: string | null; route: string | null; routing: string | null }>(`
    select id, created_at, json_extract(event_json,'$.kind') as kind,
      case when json_extract(event_json,'$.kind')='provider-route' then json_object(
        'provider',substr(json_extract(event_json,'$.provider'),1,200),
        'model',substr(json_extract(event_json,'$.model'),1,200),
        'fallback',json_extract(event_json,'$.fallback'), 'state',json_extract(event_json,'$.state')) else null end as route,
      case when json_extract(event_json,'$.kind')='routing-status' then json_object(
        'stage',substr(json_extract(event_json,'$.stage'),1,32),'configuredMode',substr(json_extract(event_json,'$.configuredMode'),1,32),
        'partialFallback',json_extract(event_json,'$.partialFallback'),'actualEngine',substr(json_extract(event_json,'$.actualEngine'),1,32),'model',substr(json_extract(event_json,'$.model'),1,104),
        'fallbackReason',substr(json_extract(event_json,'$.fallbackReason'),1,64)) else null end as routing,
      substr(json_extract(event_json,'$.tool'),1,160) as tool,
      case when json_type(event_json,'$.toolCallId')='text' and length(json_extract(event_json,'$.toolCallId'))<=256 then json_extract(event_json,'$.toolCallId') else null end as call_id,
      case when json_extract(event_json,'$.kind')='session-artifact-registered' then json_object(
        'id',substr(json_extract(event_json,'$.artifact.id'),1,256),'sessionId',substr(json_extract(event_json,'$.artifact.sessionId'),1,256),
        'profileId',substr(json_extract(event_json,'$.artifact.profileId'),1,256),'bytes',json_extract(event_json,'$.artifact.bytes'),
        'mimeType',substr(json_extract(event_json,'$.artifact.mimeType'),1,160),
        'source',json_object('filename',substr(json_extract(event_json,'$.artifact.source.filename'),1,4096))) else null end as artifact, json_extract(event_json,'$.result.ok') as ok,
      json_extract(event_json,'$.turnMessageId') as turn, json_extract(event_json,'$.status') as status, json_extract(event_json,'$.terminationCause') as cause,
      json_extract(event_json,'$.completionFloor') as floor,
      case when length(json_extract(event_json,'$.plan')) <= 16384 then json_extract(event_json,'$.plan') else null end as plan
    from session_events where session_id=? and ${DISPLAY_EVENT_FILTER}
      ${options.row === undefined ? '' : 'and rowid=?'}
      ${options.outcomeOnly ? "and json_extract(event_json,'$.kind')='execution-final-outcome-recorded'" : ''}
      order by rowid desc limit ?`).all(sessionId, ...(options.row === undefined ? [] : [options.row]), options.limit ?? 32);
  return rows.map((row) => ({ id: row.id, createdAt: row.created_at, event: {
    kind: row.kind, toolCallId: row.call_id ?? undefined, ...(row.artifact ? {artifact:JSON.parse(row.artifact)} : {}), turnMessageId: row.turn ?? undefined, tool: row.tool, result: { ok: row.ok === 1 }, status: row.status, terminationCause: row.cause, completionFloor: row.floor,
    ...(row.routing ? { ...JSON.parse(row.routing), partialFallback: JSON.parse(row.routing).partialFallback === 1 } : {}),
    ...(row.route ? { ...JSON.parse(row.route), fallback: JSON.parse(row.route).fallback === 1 } : {}),
    ...(row.plan ? { plan: JSON.parse(row.plan) } : {}),
  } as SessionEvent }));
}
