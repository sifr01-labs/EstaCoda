import type {
  AppendMessageInput,
  CreateSessionInput,
  ReplacementSessionMessage,
  RewriteSessionTranscriptInput,
  SessionDB,
  SessionEvent,
  SessionMessage,
  SessionModelOverride,
  SessionRecord,
  SessionRole,
  SessionSearchOptions,
  SessionSearchResult
} from "../contracts/session.js";
import type { ChannelKind } from "../contracts/channel.js";
import type { Trajectory, CompressedTrajectory } from "../contracts/trajectory.js";
import type { FailureRecord } from "../contracts/failure.js";
import type { ProviderUsageEntry, ProviderUsageQuery } from "../contracts/provider-usage.js";
import type { TrajectoryStore } from "../contracts/trajectory-store.js";
import type { SQLiteDatabase } from "../storage/sqlite.js";
import { openDefaultSQLiteDatabase } from "../storage/factory.js";
import { toFtsQuery } from "../search/fts-query.js";
import {
  migrateTaskAgentExecutorSchemaV12,
  migrateTaskBackgroundHostSchemaV13,
  migrateTaskChildGovernanceSchemaV16,
  migrateCanonicalProviderUsageSchemaV21,
  migrateProviderUsageLedgerSchemaV18,
  migrateTaskTreeBudgetSchemaV17,
  migrateTaskCorrectiveFoundationSchemaV14,
  migrateTaskExecutionPreferenceSchemaV20,
  migrateTaskHostOwnershipSchemaV19,
  migrateTaskVerticalSliceSchemaV15,
  migrateTaskSchedulerSchemaV11,
  migrateTaskSchemaV10
} from "../workflow/task-schema.js";
import { insertProviderUsageEntry, selectProviderUsageEntries } from "../workflow/sqlite-provider-usage.js";

type SessionRow = {
  id: string;
  profile_id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
  parent_session_id: string | null;
  ended_at: string | null;
  end_reason: string | null;
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

type SessionEventRow = {
  event_json: string;
};

type SearchRow = MessageRow & {
  session_profile_id: string;
  session_title: string | null;
  session_created_at: string;
  session_updated_at: string;
  session_parent_session_id: string | null;
  session_ended_at: string | null;
  session_end_reason: string | null;
  session_metadata_json: string | null;
  rank: number;
};

type TrajectoryRow = {
  id: string;
  session_id: string;
  profile_id: string;
  model_id: string;
  created_at: string;
  completed_at: string | null;
  event_count: number;
  events_json: string;
  outcome_json: string | null;
  compressed_json: string | null;
};

type FailureRow = {
  id: string;
  trajectory_id: string;
  session_id: string;
  timestamp: string;
  class: string;
  message: string;
  recoverable: number;
  context_json: string | null;
};

const MIGRATION_LOCK_TIMEOUT_MS = 5_000;
const MIGRATION_LOCK_RETRY_INTERVAL_MS = 25;
const MIGRATION_LOCK_SLEEP_BUFFER = new SharedArrayBuffer(4);
const MIGRATION_LOCK_SLEEP_VIEW = new Int32Array(MIGRATION_LOCK_SLEEP_BUFFER);
const SESSION_MODEL_OVERRIDE_METADATA_KEY = "sessionModelOverride";

function isSQLiteBusyError(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /busy|locked/i.test(message);
}

function sleepSync(ms: number): void {
  Atomics.wait(MIGRATION_LOCK_SLEEP_VIEW, 0, 0, ms);
}

export class SQLiteSessionDB implements SessionDB, TrajectoryStore {
  readonly #db: SQLiteDatabase;
  readonly #now: () => Date;
  readonly #id: () => string;
  readonly #path: string;

  constructor(options: { path: string; db?: SQLiteDatabase; now?: () => Date; id?: () => string }) {
    this.#path = options.path;
    this.#db = options.db ?? openDefaultSQLiteDatabase({ path: options.path });
    this.#now = options.now ?? (() => new Date());
    this.#id = options.id ?? (() => crypto.randomUUID());
    this.#migrate();
  }

  get db(): SQLiteDatabase {
    return this.#db;
  }

  close(): void {
    this.#db.close();
  }

  async createSession(input: CreateSessionInput): Promise<SessionRecord> {
    const now = this.#now().toISOString();
    const id = input.id ?? this.#id();
    const profileId = input.profileId ?? "default";

    this.#db
      .query(
        `insert into sessions (
          id,
          profile_id,
          title,
          created_at,
          updated_at,
          parent_session_id,
          ended_at,
          end_reason,
          metadata_json
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        profileId,
        input.title ?? null,
        now,
        now,
        input.parentSessionId ?? null,
        input.endedAt ?? null,
        input.endReason ?? null,
        stringifyJson(input.metadata)
      );

    const session = await this.getSessionForProfile(id, profileId);

    if (session === undefined) {
      throw new Error(`Failed to create session: ${id}`);
    }

    return session;
  }

  async getSession(id: string): Promise<SessionRecord | undefined> {
    const row = this.#db.query<SessionRow>("select * from sessions where id = ?").get(id);
    return row === null ? undefined : rowToSession(row);
  }

  async getSessionForProfile(id: string, profileId: string): Promise<SessionRecord | undefined> {
    const row = this.#db
      .query<SessionRow>("select * from sessions where profile_id = ? and id = ?")
      .get(profileId, id);
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

  async endSession(sessionId: string, reason: string): Promise<void> {
    const endedAt = this.#now().toISOString();

    this.#withWriteTransaction(() => {
      const session = this.#db.query<SessionRow>("select * from sessions where id = ?").get(sessionId);
      if (session === null) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      if (session.ended_at !== null) {
        return;
      }
      this.#db
        .query("update sessions set ended_at = ?, end_reason = ?, updated_at = ? where id = ?")
        .run(endedAt, reason, endedAt, sessionId);
    });
  }

  async setSessionModelOverride(sessionId: string, override: SessionModelOverride): Promise<void> {
    const updatedAt = this.#now().toISOString();
    this.#withWriteTransaction(() => {
      const session = this.#db.query<SessionRow>("select * from sessions where id = ?").get(sessionId);
      if (session === null) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      const metadata = {
        ...(parseJson(session.metadata_json) ?? {}),
        [SESSION_MODEL_OVERRIDE_METADATA_KEY]: structuredClone(override)
      };
      this.#db
        .query("update sessions set metadata_json = ?, updated_at = ? where id = ?")
        .run(stringifyJson(metadata), updatedAt, sessionId);
      this.#insertSessionEvent(sessionId, {
        kind: "context-window-usage-invalidated",
        reason: "model-change"
      });
    });
  }

  async clearSessionModelOverride(sessionId: string): Promise<void> {
    const updatedAt = this.#now().toISOString();
    this.#withWriteTransaction(() => {
      const session = this.#db.query<SessionRow>("select * from sessions where id = ?").get(sessionId);
      if (session === null) {
        throw new Error(`Session not found: ${sessionId}`);
      }
      const metadata = parseJson(session.metadata_json);
      if (metadata === undefined || !(SESSION_MODEL_OVERRIDE_METADATA_KEY in metadata)) {
        this.#db.query("update sessions set updated_at = ? where id = ?").run(updatedAt, sessionId);
        this.#insertSessionEvent(sessionId, {
          kind: "context-window-usage-invalidated",
          reason: "model-change"
        });
        return;
      }
      const { [SESSION_MODEL_OVERRIDE_METADATA_KEY]: _removed, ...rest } = metadata;
      this.#db
        .query("update sessions set metadata_json = ?, updated_at = ? where id = ?")
        .run(stringifyJson(Object.keys(rest).length === 0 ? undefined : rest), updatedAt, sessionId);
      this.#insertSessionEvent(sessionId, {
        kind: "context-window-usage-invalidated",
        reason: "model-change"
      });
    });
  }

  async getSessionModelOverride(sessionId: string): Promise<SessionModelOverride | undefined> {
    const session = this.#db.query<SessionRow>("select * from sessions where id = ?").get(sessionId);
    if (session === null) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    return readSessionModelOverride(parseJson(session.metadata_json));
  }

  async replaceMessages(input: RewriteSessionTranscriptInput): Promise<SessionMessage[]> {
    return this.rewriteTranscript(input);
  }

  async rewriteTranscript(input: RewriteSessionTranscriptInput): Promise<SessionMessage[]> {
    const replacements = this.#buildReplacementMessages(input);

    this.#withWriteTransaction(() => {
      const session = this.#db.query<SessionRow>("select * from sessions where id = ?").get(input.sessionId);
      if (session === null) {
        throw new Error(`Session not found: ${input.sessionId}`);
      }

      this.#db
        .query("delete from messages_fts where rowid in (select rowid from messages where session_id = ?)")
        .run(input.sessionId);
      this.#db.query("delete from messages where session_id = ?").run(input.sessionId);

      for (const message of replacements) {
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
      }

      for (const event of input.events ?? []) {
        this.#insertSessionEvent(input.sessionId, event);
      }

      this.#touch(input.sessionId);
    });

    return replacements;
  }

  async appendEvent(sessionId: string, event: SessionEvent): Promise<void> {
    const session = await this.getSession(sessionId);

    if (session === undefined) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    this.#insertSessionEvent(sessionId, event);

    this.#touch(sessionId);
  }

  async recordProviderUsageEntries(entries: readonly ProviderUsageEntry[]): Promise<void> {
    this.#withWriteTransaction(() => {
      for (const entry of entries) {
        insertProviderUsageEntry(this.#db, entry);
      }
    });
  }

  async listProviderUsageEntries(
    profileId: string,
    query: ProviderUsageQuery = {}
  ): Promise<ProviderUsageEntry[]> {
    return selectProviderUsageEntries(this.#db, profileId, query);
  }

  async listMessages(sessionId: string): Promise<SessionMessage[]> {
    return this.#db
      .query<MessageRow>("select * from messages where session_id = ? order by created_at asc, rowid asc")
      .all(sessionId)
      .map(rowToMessage);
  }

  async listMessagesForProfile(sessionId: string, profileId: string): Promise<SessionMessage[]> {
    return this.#db
      .query<MessageRow>(
        `select m.*
        from messages m
        join sessions s on s.id = m.session_id
        where s.profile_id = ? and m.session_id = ?
        order by m.created_at asc, m.rowid asc`
      )
      .all(profileId, sessionId)
      .map(rowToMessage);
  }

  async listEvents(sessionId: string): Promise<SessionEvent[]> {
    return this.#db
      .query<SessionEventRow>("select event_json from session_events where session_id = ? order by created_at asc, rowid asc")
      .all(sessionId)
      .map((row) => JSON.parse(row.event_json) as SessionEvent);
  }

  async listEventsForProfile(sessionId: string, profileId: string): Promise<SessionEvent[]> {
    return this.#db
      .query<SessionEventRow>(
        `select e.event_json
        from session_events e
        join sessions s on s.id = e.session_id
        where s.profile_id = ? and e.session_id = ?
        order by e.created_at asc, e.rowid asc`
      )
      .all(profileId, sessionId)
      .map((row) => JSON.parse(row.event_json) as SessionEvent);
  }

  async search(query: string, options: SessionSearchOptions = {}): Promise<SessionSearchResult[]> {
    const match = toFtsQuery(query);

    if (match === "") {
      return [];
    }

    const limit = options.limit ?? 10;
    const conditions = ["messages_fts match ?"];
    const parameters: Array<string | number> = [match];
    if (options.profileId !== undefined) {
      conditions.push("s.profile_id = ?");
      parameters.push(options.profileId);
    }
    if (options.rootSessionsOnly === true) {
      conditions.push("s.parent_session_id is null");
    }
    parameters.push(limit);
    const rows = this.#db
      .query<SearchRow>(
        `select
          m.*,
          s.profile_id as session_profile_id,
          s.title as session_title,
          s.created_at as session_created_at,
          s.updated_at as session_updated_at,
          s.parent_session_id as session_parent_session_id,
          s.ended_at as session_ended_at,
          s.end_reason as session_end_reason,
          s.metadata_json as session_metadata_json,
          bm25(messages_fts) as rank
        from messages_fts
        join messages m on m.rowid = messages_fts.rowid
        join sessions s on s.id = m.session_id
        where ${conditions.join(" and ")}
        order by rank asc
        limit ?`
      )
      .all(...parameters);

    return rows.map((row) => ({
      session: {
        id: row.session_id,
        profileId: row.session_profile_id,
        title: row.session_title ?? undefined,
        createdAt: row.session_created_at,
        updatedAt: row.session_updated_at,
        parentSessionId: row.session_parent_session_id ?? undefined,
        endedAt: row.session_ended_at ?? undefined,
        endReason: row.session_end_reason ?? undefined,
        metadata: parseJson(row.session_metadata_json)
      },
      message: rowToMessage(row),
      score: Math.abs(row.rank)
    }));
  }

  // ── Trajectory persistence ────────────────────────────────────────────────

  async saveTrajectory(trajectory: Trajectory): Promise<void> {
    this.#db
      .query(
        `insert into trajectories (
          id, session_id, profile_id, model_id, created_at, completed_at,
          event_count, events_json, outcome_json, compressed_json
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(id) do update set
          completed_at = excluded.completed_at,
          event_count = excluded.event_count,
          events_json = excluded.events_json,
          outcome_json = excluded.outcome_json,
          compressed_json = excluded.compressed_json`
      )
      .run(
        trajectory.id,
        trajectory.sessionId,
        trajectory.profileId,
        trajectory.modelId,
        trajectory.events[0]?.timestamp ?? this.#now().toISOString(),
        trajectory.outcome !== undefined ? this.#now().toISOString() : null,
        trajectory.events.length,
        JSON.stringify(trajectory.events),
        trajectory.outcome !== undefined ? JSON.stringify(trajectory.outcome) : null,
        null
      );
  }

  async loadTrajectory(id: string): Promise<Trajectory | undefined> {
    const row = this.#db.query<TrajectoryRow>("select * from trajectories where id = ?").get(id);
    return row === null ? undefined : rowToTrajectory(row);
  }

  async loadTrajectoryForProfile(id: string, profileId: string): Promise<Trajectory | undefined> {
    const row = this.#db
      .query<TrajectoryRow>("select * from trajectories where profile_id = ? and id = ?")
      .get(profileId, id);
    return row === null ? undefined : rowToTrajectory(row);
  }

  async listTrajectoriesForSession(sessionId: string, options: { profileId?: string } = {}): Promise<Trajectory[]> {
    const rows = options.profileId === undefined
      ? this.#db
          .query<TrajectoryRow>("select * from trajectories where session_id = ? order by created_at asc")
          .all(sessionId)
      : this.#db
          .query<TrajectoryRow>("select * from trajectories where profile_id = ? and session_id = ? order by created_at asc")
          .all(options.profileId, sessionId);
    return rows.map(rowToTrajectory);
  }

  async listTrajectoriesForProfile(
    profileId: string,
    options: { limit?: number; after?: string } = {}
  ): Promise<Trajectory[]> {
    const limit = options.limit ?? 50;
    const rows =
      options.after === undefined
        ? this.#db
            .query<TrajectoryRow>(
              "select * from trajectories where profile_id = ? order by created_at desc limit ?"
            )
            .all(profileId, limit)
        : this.#db
            .query<TrajectoryRow>(
              "select * from trajectories where profile_id = ? and created_at < ? order by created_at desc limit ?"
            )
            .all(profileId, options.after, limit);
    return rows.map(rowToTrajectory);
  }

  // ── Failure classification persistence ────────────────────────────────────

  async saveFailure(record: FailureRecord): Promise<void> {
    this.#db
      .query(
        `insert into trajectory_failures (
          id, trajectory_id, session_id, timestamp, class, message, recoverable, context_json
        ) values (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.trajectoryId ?? "",
        record.sessionId,
        record.timestamp,
        record.class,
        record.message,
        record.recoverable ? 1 : 0,
        record.context !== undefined ? JSON.stringify(record.context) : null
      );
  }

  async listFailuresForTrajectory(trajectoryId: string): Promise<FailureRecord[]> {
    const rows = this.#db
      .query<FailureRow>(
        "select * from trajectory_failures where trajectory_id = ? order by timestamp asc"
      )
      .all(trajectoryId);
    return rows.map(rowToFailure);
  }

  async listFailuresForSession(sessionId: string): Promise<FailureRecord[]> {
    const rows = this.#db
      .query<FailureRow>(
        "select * from trajectory_failures where session_id = ? order by timestamp asc"
      )
      .all(sessionId);
    return rows.map(rowToFailure);
  }

  async listFailuresByClass(
    failureClass: string,
    options: { limit?: number; after?: string } = {}
  ): Promise<FailureRecord[]> {
    const limit = options.limit ?? 50;
    const rows =
      options.after === undefined
        ? this.#db
            .query<FailureRow>(
              "select * from trajectory_failures where class = ? order by timestamp desc limit ?"
            )
            .all(failureClass, limit)
        : this.#db
            .query<FailureRow>(
              "select * from trajectory_failures where class = ? and timestamp < ? order by timestamp desc limit ?"
            )
            .all(failureClass, options.after, limit);
    return rows.map(rowToFailure);
  }

  #migrate(): void {
    this.#execMigrationControlSql(`pragma foreign_keys = on;`);
    this.#execMigrationControlSql(`pragma journal_mode = wal;`);

    this.#withMigrationLock(() => {
      // ─── Baseline: legacy tables (idempotent, always safe) ───
      this.#db.exec(`
        create table if not exists sessions (
          id text primary key,
          profile_id text not null default 'default',
          title text,
          created_at text not null,
          updated_at text not null,
          parent_session_id text,
          ended_at text,
          end_reason text,
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
        create index if not exists idx_sessions_profile_id on sessions(profile_id, id);
        create index if not exists idx_messages_session_created on messages(session_id, created_at);
        create index if not exists idx_events_session_created on session_events(session_id, created_at);

        create table if not exists trajectories (
          id text primary key,
          session_id text not null references sessions(id) on delete cascade,
          profile_id text not null,
          model_id text not null,
          created_at text not null,
          completed_at text,
          event_count integer not null default 0,
          events_json text not null,
          outcome_json text,
          compressed_json text
        );

        create table if not exists trajectory_failures (
          id text primary key,
          trajectory_id text not null references trajectories(id) on delete cascade,
          session_id text not null,
          timestamp text not null,
          class text not null,
          message text not null,
          recoverable integer not null default 0,
          context_json text
        );

        create index if not exists idx_trajectories_session on trajectories(session_id, created_at);
        create index if not exists idx_trajectories_profile on trajectories(profile_id, created_at);
        create index if not exists idx_failures_class on trajectory_failures(class, timestamp);
        create index if not exists idx_failures_trajectory on trajectory_failures(trajectory_id);
      `);

      // ─── Schema versioning (new in v0.8) ───
      this.#db.exec(`
        create table if not exists schema_version (
          version integer primary key
        );
      `);
    });

    this.#runMigrationStep(4, "v0.9-schema-v4-cron-executions", () => this.#migrateV4());
    this.#runMigrationStep(5, "v0.9-schema-v5-pending-approvals", () => this.#migrateV5());
    this.#runMigrationStep(6, "v0.9-schema-v6-session-lineage", () => this.#migrateV6());
    this.#runMigrationStep(7, "v0.9-schema-v7-typed-pending-approvals", () => this.#migrateV7());
    this.#runMigrationStep(8, "v0.9-schema-v8-session-finalization", () => this.#migrateV8());
    this.#runMigrationStep(9, "v0.9-schema-v9-memory-curation-lease", () => this.#migrateV9());
    this.#runMigrationStep(10, "v0.10-schema-v10-task-persistence", () => migrateTaskSchemaV10(this.#db));
    this.#runMigrationStep(11, "v0.10-schema-v11-task-scheduler", () => migrateTaskSchedulerSchemaV11(this.#db));
    this.#runMigrationStep(12, "v0.10-schema-v12-task-agent-executor", () => migrateTaskAgentExecutorSchemaV12(this.#db));
    this.#runMigrationStep(13, "v0.10-schema-v13-task-background-host", () => migrateTaskBackgroundHostSchemaV13(this.#db));
    this.#runMigrationStep(14, "v0.10-schema-v14-task-corrective-foundation", () => migrateTaskCorrectiveFoundationSchemaV14(this.#db));
    this.#runMigrationStep(15, "v0.10-schema-v15-task-vertical-slice", () => migrateTaskVerticalSliceSchemaV15(this.#db));
    this.#runMigrationStep(16, "v0.10-schema-v16-task-child-governance", () => migrateTaskChildGovernanceSchemaV16(this.#db));
    this.#runMigrationStep(17, "v0.10-schema-v17-task-tree-budgets", () => migrateTaskTreeBudgetSchemaV17(this.#db));
    this.#runMigrationStep(18, "v0.10-schema-v18-provider-usage-ledger", () => migrateProviderUsageLedgerSchemaV18(this.#db));
    this.#runMigrationStep(19, "v0.10-schema-v19-task-host-ownership", () => migrateTaskHostOwnershipSchemaV19(this.#db));
    this.#runMigrationStep(20, "v0.10-schema-v20-task-execution-preference", () => migrateTaskExecutionPreferenceSchemaV20(this.#db));
    this.#runMigrationStep(21, "v0.10-schema-v21-canonical-provider-usage", () => migrateCanonicalProviderUsageSchemaV21(this.#db));
  }

  #withMigrationLock(migrate: () => void): void {
    this.#execMigrationControlSql("begin immediate");
    try {
      migrate();
      this.#db.exec("commit");
    } catch (error) {
      try {
        this.#db.exec("rollback");
      } catch {
        // Ignore rollback errors so the original migration failure is preserved.
      }
      throw error;
    }
  }

  #withWriteTransaction(write: () => void): void {
    this.#db.exec("begin immediate");
    try {
      write();
      this.#db.exec("commit");
    } catch (error) {
      try {
        this.#db.exec("rollback");
      } catch {
        // Preserve the original write failure.
      }
      throw error;
    }
  }

  #buildReplacementMessages(input: {
    sessionId: string;
    messages: ReplacementSessionMessage[];
  }): SessionMessage[] {
    const baseTime = this.#now().getTime();
    let generated = 0;

    return input.messages.map((message) => ({
      id: message.id ?? this.#id(),
      sessionId: input.sessionId,
      role: message.role,
      content: message.content,
      createdAt: message.createdAt ?? new Date(baseTime + generated++).toISOString(),
      channel: message.channel,
      metadata: message.metadata
    }));
  }

  #execMigrationControlSql(sql: string): void {
    const deadline = Date.now() + MIGRATION_LOCK_TIMEOUT_MS;
    while (true) {
      try {
        this.#db.exec(sql);
        return;
      } catch (error) {
        if (!isSQLiteBusyError(error) || Date.now() >= deadline) {
          throw error;
        }
        sleepSync(MIGRATION_LOCK_RETRY_INTERVAL_MS);
      }
    }
  }

  #runMigrationStep(targetVersion: number, backupLabel: string, migrate: () => void): void {
    if (this.#readSchemaVersion() >= targetVersion) {
      return;
    }

    this.#backupDbBeforeMigration(backupLabel);

    this.#withMigrationLock(() => {
      if (this.#readSchemaVersion() >= targetVersion) {
        return;
      }
      migrate();
      this.#db
        .query("insert into schema_version (version) values (?) on conflict(version) do update set version = ?")
        .run(targetVersion, targetVersion);
    });
  }

  #readSchemaVersion(): number {
    const versionRow = this.#db
      .query<{ version: number | null }>("select max(version) as version from schema_version")
      .get();
    return versionRow?.version ?? 0;
  }

  #migrateV4(): void {
    this.#db.exec(`
      create table if not exists cron_executions (
        id text primary key,
        job_id text not null,
        session_id text,
        trajectory_id text,
        scheduled_at text,
        started_at text not null,
        completed_at text,
        status text not null,
        output_summary text,
        delivery_results_json text,
        failure_class text,
        failure_message text,
        created_at text not null
      );

      create index if not exists idx_cron_executions_job on cron_executions(job_id, started_at desc);
      create index if not exists idx_cron_executions_status on cron_executions(status, started_at desc);
      create index if not exists idx_cron_executions_session on cron_executions(session_id);
    `);
  }

  #migrateV5(): void {
    this.#ensurePendingApprovalsTable();
  }

  #ensurePendingApprovalsTable(): void {
    this.#db.exec(`
      create table if not exists pending_approvals (
        id text primary key,
        session_id text not null,
        profile_id text not null,
        command_preview text not null,
        command_hash text not null,
        command_payload text,
        tool_name text not null,
        requested_at text not null,
        expires_at text not null,
        status text not null default 'pending',
        resolved_at text,
        resolved_by text,
        channel text not null,
        chat_id text
      );

      create index if not exists idx_pending_approvals_session on pending_approvals(session_id);
      create index if not exists idx_pending_approvals_status on pending_approvals(status);
      create index if not exists idx_pending_approvals_profile on pending_approvals(profile_id);
    `);
  }

  #migrateV6(): void {
    const rows = this.#db.query("pragma table_info(sessions)").all() as Array<{ name: string }>;
    const colNames = new Set(rows.map((row) => row.name));
    if (!colNames.has("ended_at")) {
      this.#db.exec("alter table sessions add column ended_at text");
    }
    if (!colNames.has("end_reason")) {
      this.#db.exec("alter table sessions add column end_reason text");
    }
  }

  #migrateV7(): void {
    this.#ensurePendingApprovalsTable();

    const rows = this.#db.query("pragma table_info(pending_approvals)").all() as Array<{ name: string }>;
    const colNames = new Set(rows.map((row) => row.name));
    if (!colNames.has("approval_kind")) {
      this.#db.exec("alter table pending_approvals add column approval_kind text not null default 'command'");
    }
    if (!colNames.has("request_payload")) {
      this.#db.exec("alter table pending_approvals add column request_payload text");
    }
  }

  #migrateV8(): void {
    this.#db.exec(`
      create table if not exists session_finalization_jobs (
        id text primary key,
        profile_id text not null,
        session_id text not null references sessions(id) on delete cascade,
        reason text not null check(reason in ('new-session', 'cli-exit', 'sigint', 'channel-reset', 'one-shot')),
        status text not null default 'pending' check(status in ('pending', 'running', 'completed', 'failed')),
        source_message_count integer not null check(source_message_count >= 0),
        cutoff_message_id text not null,
        attempts integer not null default 0 check(attempts >= 0),
        available_at text not null,
        claimed_at text,
        lease_owner text,
        lease_expires_at text,
        completed_at text,
        failed_at text,
        outcome_code text,
        last_error_code text,
        created_at text not null,
        updated_at text not null,
        unique(profile_id, session_id, cutoff_message_id, source_message_count)
      );

      create index if not exists idx_session_finalization_ready
        on session_finalization_jobs(profile_id, status, available_at, created_at);
      create index if not exists idx_session_finalization_lease
        on session_finalization_jobs(profile_id, status, lease_expires_at);
      create index if not exists idx_session_finalization_session
        on session_finalization_jobs(profile_id, session_id, created_at);
    `);
  }

  #migrateV9(): void {
    this.#db.exec(`
      create table if not exists memory_curation_leases (
        profile_id text primary key,
        owner_id text not null,
        acquired_at text not null,
        lease_expires_at text not null,
        updated_at text not null
      );

      create index if not exists idx_memory_curation_lease_expiry
        on memory_curation_leases(lease_expires_at);
    `);
  }

  #backupDbBeforeMigration(label: string): void {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backupPath = `${this.#path}.backup.${label}.${timestamp}`;
      this.#db.exec(`vacuum into '${backupPath.replace(/'/g, "''")}'`);
    } catch {
      // Backup is best-effort; do not block migration
    }
  }

  #touch(sessionId: string): void {
    this.#db
      .query("update sessions set updated_at = ? where id = ?")
      .run(this.#now().toISOString(), sessionId);
  }

  #insertSessionEvent(sessionId: string, event: SessionEvent): void {
    this.#db
      .query("insert into session_events (id, session_id, created_at, event_json) values (?, ?, ?, ?)")
      .run(this.#id(), sessionId, this.#now().toISOString(), JSON.stringify(event));
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
    endedAt: row.ended_at ?? undefined,
    endReason: row.end_reason ?? undefined,
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

function readSessionModelOverride(metadata: Record<string, unknown> | undefined): SessionModelOverride | undefined {
  const value = metadata?.[SESSION_MODEL_OVERRIDE_METADATA_KEY];
  return isSessionModelOverride(value) ? structuredClone(value) : undefined;
}

function isSessionModelOverride(value: unknown): value is SessionModelOverride {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<SessionModelOverride>;
  return (
    typeof candidate.setAt === "string" &&
    (candidate.source === "cli" || candidate.source === "gateway") &&
    typeof candidate.route === "object" &&
    candidate.route !== null &&
    typeof candidate.route.provider === "string" &&
    typeof candidate.route.id === "string" &&
    typeof candidate.modelProfile === "object" &&
    candidate.modelProfile !== null &&
    typeof candidate.modelProfile.id === "string" &&
    typeof candidate.modelProfile.provider === "string"
  );
}

function rowToTrajectory(row: TrajectoryRow): Trajectory {
  return {
    id: row.id,
    sessionId: row.session_id,
    profileId: row.profile_id,
    modelId: row.model_id,
    events: JSON.parse(row.events_json) as Trajectory["events"],
    outcome:
      row.outcome_json === null
        ? undefined
        : (JSON.parse(row.outcome_json) as Trajectory["outcome"])
  };
}

function rowToFailure(row: FailureRow): FailureRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    trajectoryId: row.trajectory_id,
    timestamp: row.timestamp,
    class: row.class as FailureRecord["class"],
    sourceEventKind: "",      // not stored separately; recovered from context if needed
    message: row.message,
    recoverable: row.recoverable === 1,
    context: row.context_json === null ? undefined : (JSON.parse(row.context_json) as Record<string, unknown>)
  };
}
