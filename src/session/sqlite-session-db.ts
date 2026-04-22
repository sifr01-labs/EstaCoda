import { Database } from "bun:sqlite";
import type {
  AppendMessageInput,
  CreateSessionInput,
  SessionDB,
  SessionEvent,
  SessionMessage,
  SessionRecord,
  SessionRole,
  SessionSearchResult
} from "../contracts/session.js";
import type { ChannelKind } from "../contracts/channel.js";

type SessionRow = {
  id: string;
  profile_id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  parent_session_id: string | null;
  metadata_json: string | null;
};

type MessageRow = {
  id: string;
  session_id: string;
  role: SessionRole;
  content: string;
  created_at: string;
  channel: ChannelKind | null;
  metadata_json: string | null;
};

type EventRow = {
  event_json: string;
};

type SearchRow = MessageRow & {
  session_profile_id: string;
  session_title: string | null;
  session_created_at: string;
  session_updated_at: string;
  session_parent_session_id: string | null;
  session_metadata_json: string | null;
  rank: number;
};

export class SQLiteSessionDB implements SessionDB {
  readonly #db: Database;
  readonly #now: () => Date;
  readonly #id: () => string;

  constructor(options: { path: string; now?: () => Date; id?: () => string }) {
    this.#db = new Database(options.path, { create: true, readwrite: true });
    this.#now = options.now ?? (() => new Date());
    this.#id = options.id ?? (() => crypto.randomUUID());
    this.#migrate();
  }

  close(): void {
    this.#db.close();
  }

  async createSession(input: CreateSessionInput): Promise<SessionRecord> {
    const now = this.#now().toISOString();
    const id = input.id ?? this.#id();

    this.#db
      .query(
        `insert into sessions (
          id,
          profile_id,
          title,
          created_at,
          updated_at,
          parent_session_id,
          metadata_json
        ) values (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.profileId,
        input.title ?? null,
        now,
        now,
        input.parentSessionId ?? null,
        stringifyJson(input.metadata)
      );

    const session = await this.getSession(id);

    if (session === undefined) {
      throw new Error(`Failed to create session: ${id}`);
    }

    return session;
  }

  async getSession(id: string): Promise<SessionRecord | undefined> {
    const row = this.#db.query<SessionRow>("select * from sessions where id = ?").get(id);
    return row === null ? undefined : rowToSession(row);
  }

  async listSessions(profileId?: string): Promise<SessionRecord[]> {
    const rows =
      profileId === undefined
        ? this.#db.query<SessionRow>("select * from sessions order by updated_at desc").all()
        : this.#db
            .query<SessionRow>("select * from sessions where profile_id = ? order by updated_at desc")
            .all(profileId);

    return rows.map(rowToSession);
  }

  async appendMessage(input: AppendMessageInput): Promise<SessionMessage> {
    const session = await this.getSession(input.sessionId);

    if (session === undefined) {
      throw new Error(`Session not found: ${input.sessionId}`);
    }

    const message: SessionMessage = {
      id: input.id ?? this.#id(),
      sessionId: input.sessionId,
      role: input.role,
      content: input.content,
      createdAt: this.#now().toISOString(),
      channel: input.channel,
      metadata: input.metadata
    };

    this.#db
      .query(
        `insert into messages (
          id,
          session_id,
          role,
          content,
          created_at,
          channel,
          metadata_json
        ) values (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        message.id,
        message.sessionId,
        message.role,
        message.content,
        message.createdAt,
        message.channel ?? null,
        stringifyJson(message.metadata)
      );

    this.#db
      .query("insert into messages_fts(rowid, message_id, content) values ((select rowid from messages where id = ?), ?, ?)")
      .run(message.id, message.id, message.content);

    this.#touch(message.sessionId);

    return message;
  }

  async appendEvent(sessionId: string, event: SessionEvent): Promise<void> {
    const session = await this.getSession(sessionId);

    if (session === undefined) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    this.#db
      .query("insert into session_events (id, session_id, created_at, event_json) values (?, ?, ?, ?)")
      .run(this.#id(), sessionId, this.#now().toISOString(), JSON.stringify(event));

    this.#touch(sessionId);
  }

  async listMessages(sessionId: string): Promise<SessionMessage[]> {
    return this.#db
      .query<MessageRow>("select * from messages where session_id = ? order by created_at asc")
      .all(sessionId)
      .map(rowToMessage);
  }

  async listEvents(sessionId: string): Promise<SessionEvent[]> {
    return this.#db
      .query<EventRow>("select event_json from session_events where session_id = ? order by created_at asc")
      .all(sessionId)
      .map((row) => JSON.parse(row.event_json) as SessionEvent);
  }

  async search(query: string, options: { profileId?: string; limit?: number } = {}): Promise<SessionSearchResult[]> {
    const match = toFtsQuery(query);

    if (match === "") {
      return [];
    }

    const limit = options.limit ?? 10;
    const rows =
      options.profileId === undefined
        ? this.#db
            .query<SearchRow>(
              `select
                m.*,
                s.profile_id as session_profile_id,
                s.title as session_title,
                s.created_at as session_created_at,
                s.updated_at as session_updated_at,
                s.parent_session_id as session_parent_session_id,
                s.metadata_json as session_metadata_json,
                bm25(messages_fts) as rank
              from messages_fts
              join messages m on m.rowid = messages_fts.rowid
              join sessions s on s.id = m.session_id
              where messages_fts match ?
              order by rank asc
              limit ?`
            )
            .all(match, limit)
        : this.#db
            .query<SearchRow>(
              `select
                m.*,
                s.profile_id as session_profile_id,
                s.title as session_title,
                s.created_at as session_created_at,
                s.updated_at as session_updated_at,
                s.parent_session_id as session_parent_session_id,
                s.metadata_json as session_metadata_json,
                bm25(messages_fts) as rank
              from messages_fts
              join messages m on m.rowid = messages_fts.rowid
              join sessions s on s.id = m.session_id
              where messages_fts match ? and s.profile_id = ?
              order by rank asc
              limit ?`
            )
            .all(match, options.profileId, limit);

    return rows.map((row) => ({
      session: {
        id: row.session_id,
        profileId: row.session_profile_id,
        title: row.session_title ?? undefined,
        createdAt: row.session_created_at,
        updatedAt: row.session_updated_at,
        parentSessionId: row.session_parent_session_id ?? undefined,
        metadata: parseJson(row.session_metadata_json)
      },
      message: rowToMessage(row),
      score: Math.abs(row.rank)
    }));
  }

  #migrate(): void {
    this.#db.exec(`
      pragma journal_mode = wal;

      create table if not exists sessions (
        id text primary key,
        profile_id text not null,
        title text,
        created_at text not null,
        updated_at text not null,
        parent_session_id text,
        metadata_json text
      );

      create table if not exists messages (
        id text primary key,
        session_id text not null references sessions(id) on delete cascade,
        role text not null,
        content text not null,
        created_at text not null,
        channel text,
        metadata_json text
      );

      create virtual table if not exists messages_fts using fts5(
        message_id unindexed,
        content,
        tokenize = 'unicode61'
      );

      create table if not exists session_events (
        id text primary key,
        session_id text not null references sessions(id) on delete cascade,
        created_at text not null,
        event_json text not null
      );

      create index if not exists idx_sessions_profile_updated on sessions(profile_id, updated_at);
      create index if not exists idx_messages_session_created on messages(session_id, created_at);
      create index if not exists idx_events_session_created on session_events(session_id, created_at);
    `);
  }

  #touch(sessionId: string): void {
    this.#db
      .query("update sessions set updated_at = ? where id = ?")
      .run(this.#now().toISOString(), sessionId);
  }
}

function rowToSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    profileId: row.profile_id,
    title: row.title ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    parentSessionId: row.parent_session_id ?? undefined,
    metadata: parseJson(row.metadata_json)
  };
}

function rowToMessage(row: MessageRow): SessionMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
    channel: row.channel ?? undefined,
    metadata: parseJson(row.metadata_json)
  };
}

function stringifyJson(value: Record<string, unknown> | undefined): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function parseJson(value: string | null): Record<string, unknown> | undefined {
  return value === null ? undefined : (JSON.parse(value) as Record<string, unknown>);
}

function toFtsQuery(query: string): string {
  return query
    .toLowerCase()
    .split(/[^a-z0-9\u0600-\u06ff]+/u)
    .filter((term) => term.length > 1)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" OR ");
}

