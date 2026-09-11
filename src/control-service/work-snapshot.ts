import { profileAttention } from './profile-attention.js';
import { appendInbox } from './inbox-projections.js';
import { SQLiteTaskStore } from '../tasks/sqlite-task-store.js';
import { appendTaskWork } from './task-projections.js';
import { INTERNAL_SESSION_KINDS } from '../session/session-presentation.js';
import { randomBytes } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { resolveGlobalStateHome } from '../config/profile-home.js';
import { SQLiteSessionDB } from '../session/sqlite-session-db.js';
import { ControlProtocolError, type InboxProjection, type ActivityProjection, type Page, type WorkProjection } from '../contracts/desktop-control/index.js';
import { sessionActivity, sessionWork } from './work-projections.js';
import type { SessionEvent, SessionMessage } from '../contracts/session.js';

export type WorkState = { inbox?: InboxProjection[]; work: WorkProjection[]; activity: Record<string, ActivityProjection[]> };
/** Materialized, bounded epoch. No open SQLite transaction or live executor survives capture. */
export async function captureWork(input: { homeDir: string; profileId: string; version?: string }, signal: AbortSignal): Promise<WorkState> {
  const attention = await profileAttention(input);
  const path = resolveGlobalStateHome(input).sessionsSqlitePath;
  try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) throw new ControlProtocolError('-32007'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { work: [], activity: {}, inbox: attention.inbox }; throw error; }
  const sessions = new SQLiteSessionDB({ path, readonly: true });
  try {
    sessions.db.exec('begin');
    const state: WorkState = { work: [], activity: {}, inbox: attention.inbox };
    // Refuse an oversized capture, rather than silently presenting incomplete Work as complete.
    const ids = sessions.db.query<{ id: string }>('select id from sessions where profile_id = ? order by updated_at desc, id limit 1001').all(input.profileId);
    if (ids.length > 1000) throw new ControlProtocolError('-32007');
    for (const { id } of ids) {
      signal.throwIfAborted();
      const session = await sessions.getSessionForProfile(id, input.profileId);
      if (!session || INTERNAL_SESSION_KINDS.includes(session.metadata?.kind as typeof INTERNAL_SESSION_KINDS[number])) continue;
      const events = sessions.db.query<{ event_json: string }>('select event_json from session_events where session_id = ? order by rowid desc limit 1000').all(id)
        .reverse().map((row) => JSON.parse(row.event_json) as SessionEvent);
      const active = sessions.db.query<{ active: number }>('select count(*) as active from session_execution_owners where session_id = ? and profile_id = ? and owner_id is not null and expires_at > ?').get(id, input.profileId, Date.now());
      state.work.push(sessionWork(session, events, Boolean(active?.active)));
      const messages = sessions.db.query<{ id: string; role: SessionMessage['role']; content: string; created_at: string }>(
        'select id, role, substr(content, 1, 16384) as content, created_at from messages where session_id = ? order by created_at, rowid limit 1001').all(id);
      if (messages.length > 1000) throw new ControlProtocolError('-32007');
      state.activity[`session:${id}`] = sessionActivity(session, messages.map((m) => ({ ...m, sessionId: id, createdAt: m.created_at })));
      if (Buffer.byteLength(JSON.stringify(state)) > 8 * 1024 * 1024) throw new ControlProtocolError('-32007');
    }
    const taskCount = sessions.db.query<{ count: number }>('select count(*) as count from tasks where profile_id = ?').get(input.profileId);
    if ((taskCount?.count ?? 0) > 1000) throw new ControlProtocolError('-32007');
    appendTaskWork(state, new SQLiteTaskStore({ db: sessions.db, profileId: input.profileId }));
    await appendInbox(state, sessions, input, attention.jobs);
    if (Buffer.byteLength(JSON.stringify(state)) > 8 * 1024 * 1024) throw new ControlProtocolError('-32007');
    sessions.db.exec('commit');
    return state;
  } finally { sessions.close(); }
}
/** Tokens are unguessable references bound to this instance, epoch, query and page size. */
export class WorkSnapshot {
  readonly #pages = new Map<string, { key: string; offset: number; limit: number }>();
  constructor(readonly state: WorkState) {}
  get(id: string): WorkProjection {
    const work = this.state.work.find((work) => work.id === id);
    if (!work) throw new ControlProtocolError('-32003');
    return structuredClone(work);
  }
  page<T>(key: string, items: T[], params: { limit: number; cursor?: string }): Page<T> {
    let offset = 0;
    if (params.cursor) {
      const page = this.#pages.get(params.cursor);
      if (!page || page.key !== key || page.limit !== params.limit) throw new ControlProtocolError('-32007');
      offset = page.offset;
    }
    // Bound serialized replies, even when each item individually satisfies the schema.
    const selected: T[] = [];
    let bytes = 0;
    for (const item of items.slice(offset, offset + params.limit)) {
      const size = Buffer.byteLength(JSON.stringify(item));
      if (bytes + size > 96_000) break;
      selected.push(item); bytes += size;
    }
    const nextOffset = offset + selected.length;
    let nextCursor: string | null = null;
    if (nextOffset < items.length) {
      if (!selected.length || this.#pages.size >= 4096) throw new ControlProtocolError('-32007');
      nextCursor = randomBytes(24).toString('base64url');
      this.#pages.set(nextCursor, { key, offset: nextOffset, limit: params.limit });
    }
    return structuredClone({ items: selected, nextCursor });
  }
}
