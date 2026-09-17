import type { SQLiteDatabase } from '../storage/sqlite.js';
import type { SessionRecord } from '../contracts/session.js';
import { ControlProtocolError, type ActivityProjection } from '../contracts/desktop-control/index.js';
import { appendSessionEvents, sessionActivity } from './work-projections.js';
import { sessionDisplayEvents, DISPLAY_EVENT_FILTER } from './session-display-events.js';

export type HistoryBoundary = { messages: number; events: number; count: number; revision: number };
/** Append-only high water marks, plus the core transcript rewrite revision. */
export function historyBoundary(db: SQLiteDatabase, session: SessionRecord): HistoryBoundary {
  const messages = db.query<{ last: number }>('select coalesce(max(rowid),0) as last from messages where session_id=?').get(session.id)!.last;
  const events = db.query<{ last: number }>('select coalesce(max(rowid),0) as last from session_events where session_id=?').get(session.id)!.last;
  const count = db.query<{ count: number }>(`select (select count(*) from messages where session_id=? and role in ('user','agent')) +
    (select count(*) from session_events where session_id=? and ${DISPLAY_EVENT_FILTER}) as count`).get(session.id, session.id)!.count;
  return { messages, events, count, revision: Number(session.metadata?.transcriptRevision ?? 0) };
}
/** One bounded page, read in the caller's short read transaction. No raw tool payloads. */
export function historyPage(db: SQLiteDatabase, session: SessionRecord, boundary: HistoryBoundary, offset: number, limit: number): ActivityProjection[] {
  if (Number(session.metadata?.transcriptRevision ?? 0) !== boundary.revision) throw new ControlProtocolError('-32007');
  const rows = db.query<{ source: string; row: number }>(`select source, row from (
    select 'message' as source, rowid as row, created_at from messages where session_id=? and rowid<=? and role in ('user','agent')
    union all select 'event' as source, rowid as row, created_at from session_events where session_id=? and rowid<=? and ${DISPLAY_EVENT_FILTER}
    ) order by created_at, source, row limit ? offset ?`).all(session.id, boundary.messages, session.id, boundary.events, limit, offset);
  return rows.flatMap(({ source, row }, index) => {
    if (source === 'message') {
      const message = db.query<{ id: string; role: 'user' | 'agent'; content: string; createdAt: string; progress:number }>(
        `select id, role, substr(content,1,16384) as content, created_at as createdAt,
        case when json_valid(metadata_json) then json_extract(metadata_json,'$.kind')='provider-tool-call-turn' else 0 end as progress
        from messages where session_id=? and rowid=?`).get(session.id, row)!;
      return sessionActivity(session, [{ ...message, sessionId: session.id,metadata:message.progress?{kind:'provider-tool-call-turn'}:{} }]).map(item => ({ ...item, sequence: offset + index }));
    }
    return appendSessionEvents(session, [], sessionDisplayEvents(db, session.id, { row, limit: 1 })).map(item => ({ ...item, sequence: offset + index }));
  });
}
