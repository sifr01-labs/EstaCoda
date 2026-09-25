import { TASK_MODEL_OVERRIDE_SCHEMA_VERSION } from '../tasks/task-schema.js';
import { setImmediate } from 'node:timers/promises';
import { sessionActions, inboxActions } from './action-projections.js';
import { historyBoundary, historyPage, type HistoryBoundary } from './session-history.js';
import { sessionDisplayEvents } from './session-display-events.js';
import { profileAttention } from './profile-attention.js';
import { appendInbox } from './inbox-projections.js';
import { SQLiteTaskStore } from '../tasks/sqlite-task-store.js';
import { appendTaskWork } from './task-projections.js';
import { INTERNAL_SESSION_KINDS } from '../session/session-presentation.js';
import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { resolveGlobalStateHome } from '../config/profile-home.js';
import { SQLiteSessionDB } from '../session/sqlite-session-db.js';
import { ControlProtocolError, type InboxProjection, type ActivityProjection, type Page, type PageParams, type WorkProjection } from '../contracts/desktop-control/index.js';
import { sessionWork } from './work-projections.js';

export type WorkState = { requestTurns?: Record<string,string>; inbox?: InboxProjection[]; work: WorkProjection[]; activity: Record<string, ActivityProjection[]>; history?: Record<string, HistoryBoundary>; activeSchedules?:number|null;capturedAt?:number };
/** Metadata epoch with bounded history previews. No open SQLite transaction or live executor survives capture. */
export async function captureWork(input: { homeDir: string; profileId: string; version?: string }, signal: AbortSignal): Promise<WorkState> {
  const attention = await profileAttention(input);
  const path = resolveGlobalStateHome(input).sessionsSqlitePath;
  try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) throw new ControlProtocolError('-32007'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { capturedAt:Date.now(),activeSchedules:attention.inbox.some(item=>item.id==='setup:schedules')?null:attention.jobs.filter(job=>job.status==='active').length,work: [], activity: {}, inbox: attention.inbox.map(item => ({ ...item, actions: inboxActions(item) })) }; throw error; }
  const sessions = new SQLiteSessionDB({ path, readonly: true });
  try {
    sessions.db.exec('begin');
    const versionTable = sessions.db.query<{name:string}>("select name from sqlite_master where type='table' and name='schema_version'").get();
    const version = versionTable ? sessions.db.query<{version:number|null}>('select max(version) as version from schema_version').get()?.version ?? 0 : 0;
    if (version < TASK_MODEL_OVERRIDE_SCHEMA_VERSION) throw new ControlProtocolError('-32011');
    if (version > TASK_MODEL_OVERRIDE_SCHEMA_VERSION) throw new ControlProtocolError('-32012');
    const state: WorkState = { capturedAt:Date.now(), requestTurns: {}, work: [], activity: {}, inbox: attention.inbox, activeSchedules:attention.inbox.some(item=>item.id==='setup:schedules')?null:attention.jobs.filter(job=>job.status==='active').length, history: {} };
    // Capture navigation metadata; transcript bodies are paged separately.
    const ids = sessions.db.query<{ id: string }>('select id from sessions where profile_id = ? order by updated_at desc, id').all(input.profileId);
    let capturedBytes = 0;
    let visited = 0;
    for (const { id } of ids) {
      if (++visited % 32 === 0) await setImmediate();
      signal.throwIfAborted();
      const session = await sessions.getSessionForProfile(id, input.profileId);
      if(!session)continue;
      const child=session.metadata?.kind==='delegated-child'||session.metadata?.kind==='task-step-worker';
      if(INTERNAL_SESSION_KINDS.includes(session.metadata?.kind as typeof INTERNAL_SESSION_KINDS[number])&&!child)continue;
      if(child&&(!session.parentSessionId||!await sessions.getSessionForProfile(session.parentSessionId,input.profileId)))continue;
      const events = sessionDisplayEvents(sessions.db, id, { outcomeOnly: true, limit: 1 });
      const latestUserMessage = sessions.db.query<{ id: string; created_at: string }>("select id, created_at from messages where session_id=? and role='user' order by rowid desc limit 1").get(id);
      const savedTurn = session.metadata?.latestUserTurn as { id?: unknown; createdAt?: unknown } | undefined;
      const latestUser = typeof savedTurn?.id === 'string' && typeof savedTurn.createdAt === 'string'
        ? { id: savedTurn.id, created_at: savedTurn.createdAt } : latestUserMessage;
      const currentEvents = events.filter(({ event, createdAt }) => !latestUser || (event.kind === 'execution-final-outcome-recorded' && event.turnMessageId ? event.turnMessageId === latestUser.id : createdAt > latestUser.created_at)).map((event) => event.event);
      const active = sessions.db.query<{ active: number }>('select count(*) as active from session_execution_owners where session_id = ? and profile_id = ? and owner_id is not null and expires_at > ?').get(id, input.profileId, Date.now());
      if (latestUser) state.requestTurns![id] = latestUser.id;
      const work = sessionWork(session, currentEvents, Boolean(active?.active));
      const queued = sessions.db.query<{ count: number }>("select count(*) as count from session_control_receipts where session_id=? and profile_id=? and method='send' and status in ('accepted','dispatched')").get(id, input.profileId);
      if (!active?.active && queued?.count) work.status = 'queued';
      else if (latestUser && work.status === 'draft') { work.status = 'needs_attention'; work.reason = 'No confirmed outcome is available for the latest turn.'; }
      work.actions = child?[{id:'inspect_result',enabled:true}]:sessionActions(session, work);
      if(child)delete work.modelBinding;
      state.work.push(work);
      const boundary = historyBoundary(sessions.db, session);
      state.history![work.id] = boundary;
      // The observer keeps a bounded recent preview, never the full transcript.
      if (capturedBytes < 1_048_576) {
        const preview = historyPage(sessions.db, session, boundary, Math.max(0, boundary.count - 32), 32);
        const bytes = Buffer.byteLength(JSON.stringify(preview));
        if (capturedBytes + bytes <= 1_048_576) { state.activity[work.id] = preview; capturedBytes += bytes; }
      }
    }
    await appendTaskWork(state, new SQLiteTaskStore({ db: sessions.db, profileId: input.profileId }), signal);
    await appendInbox(state, sessions, input, attention.jobs, signal);
    signal.throwIfAborted();
    sessions.db.exec('commit');
    return state;
  } finally { sessions.close(); }
}
/** Authenticated opaque continuations bind to this instance, epoch, query and page size without an ever-growing token map. */
export class WorkSnapshot {
  readonly #cursorKey = randomBytes(32);
  readonly #newWork = new Map<string,WorkSnapshot>();
  /** Resolve a just-created chat without changing existing list/history cursor epochs. */
  includeNew(id:string,state:WorkState):WorkProjection{
    if(this.#newWork.has(id))return this.#newWork.get(id)!.get(id);
    const snapshot=new WorkSnapshot({work:state.work.filter(item=>item.id===id),activity:{[id]:state.activity[id]??[]},history:state.history?.[id]?{[id]:state.history[id]!}:{}},this.input),work=snapshot.get(id);
    if(this.input&&work.profileId!==this.input.profileId)throw new ControlProtocolError('-32003');
    if(this.#newWork.size>=100)throw new ControlProtocolError('-32009');
    this.#newWork.set(id,snapshot);return work;
  }
  constructor(readonly state: WorkState, readonly input?: { homeDir: string; profileId: string }) {}
  search(params: PageParams & {query?:string;parentWorkId?:string}): Page<WorkProjection> {
    const query=(params.query??'').trim().toLocaleLowerCase('en-US');
    const related=params.parentWorkId?this.state.work.filter(work=>work.parentWorkId===params.parentWorkId):this.state.work;
    const items=query?related.filter(work=>[work.title,work.canonicalId,work.target?.label??''].some(value=>value.toLocaleLowerCase('en-US').includes(query))):related;
    return this.page('work:'+JSON.stringify([query,params.parentWorkId??null]),items,params);
  }
  get(id: string): WorkProjection {
    if(this.#newWork.has(id))return this.#newWork.get(id)!.get(id);
    const work = this.state.work.find((work) => work.id === id);
    if (!work) throw new ControlProtocolError('-32003');
    return structuredClone(work);
  }
  async activity(workId: string, params: { limit: number; cursor?: string }): Promise<Page<ActivityProjection>> {
    if(this.#newWork.has(workId))return this.#newWork.get(workId)!.activity(workId,params);
    const work = this.get(workId), boundary = this.state.history?.[workId];
    if (!boundary || !this.input) return this.page(workId, this.state.activity[workId] ?? [], params);
    const offset = this.offset(workId, params);
    const path = resolveGlobalStateHome(this.input).sessionsSqlitePath;
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new ControlProtocolError('-32003');
    const db = new SQLiteSessionDB({ path, readonly: true });
    try {
      db.db.exec('begin');
      const session = await db.getSessionForProfile(work.canonicalId, this.input.profileId);
      if (!session) throw new ControlProtocolError('-32003');
      const items = historyPage(db.db, session, boundary, offset, params.limit);
      const result = this.finishPage(workId, items, offset, boundary.count, params.limit);
      db.db.exec('commit');
      return result;
    } finally { db.close(); }
  }
  private offset(key: string, params: { limit: number; cursor?: string }): number {
    if (!params.cursor) return 0;
    try {
      if (params.cursor.length > 512 || !/^[A-Za-z0-9_-]+$/.test(params.cursor)) throw new Error();
      const value: unknown = JSON.parse(Buffer.from(params.cursor, 'base64url').toString('utf8'));
      if (!Array.isArray(value) || value.length !== 3) throw new Error();
      const [offset, limit, signature] = value as unknown[];
      if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || limit !== params.limit ||
        typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) throw new Error();
      if (!timingSafeEqual(Buffer.from(signature, 'hex'), this.signature(key, offset, params.limit))) throw new Error();
      return offset;
    } catch { throw new ControlProtocolError('-32007'); }
  }
  private signature(key: string, offset: number, limit: number): Buffer {
    return createHmac('sha256', this.#cursorKey).update(JSON.stringify([key, offset, limit])).digest();
  }
  page<T>(key: string, items: T[], params: { limit: number; cursor?: string }): Page<T> {
    const offset = this.offset(key, params);
    return this.finishPage(key, items.slice(offset, offset + params.limit), offset, items.length, params.limit);
  }
  private finishPage<T>(key: string, items: T[], offset: number, total: number, limit: number): Page<T> {
    // Bound serialized replies, even when each item individually satisfies the schema.
    const selected: T[] = [];
    let bytes = 0;
    for (const item of items) {
      const size = Buffer.byteLength(JSON.stringify(item));
      if (bytes + size > 96_000) break;
      selected.push(item); bytes += size;
    }
    const nextOffset = offset + selected.length;
    let nextCursor: string | null = null;
    if (nextOffset < total) {
      if (!selected.length) throw new ControlProtocolError('-32007');
      nextCursor = Buffer.from(JSON.stringify([nextOffset, limit, this.signature(key, nextOffset, limit).toString('hex')])).toString('base64url');
    }
    return structuredClone({ items: selected, nextCursor });
  }
}
