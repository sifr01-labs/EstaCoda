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
import type { Trajectory, CompressedTrajectory } from "../contracts/trajectory.js";
import type { FailureRecord } from "../contracts/failure.js";
import type { TrajectoryStore } from "../contracts/trajectory-store.js";
import type { SQLiteDatabase } from "../storage/sqlite.js";
import { openDefaultSQLiteDatabase } from "../storage/factory.js";

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
          metadata_json
        ) values (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        profileId,
        input.title ?? null,
        now,
        now,
        input.parentSessionId ?? null,
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

  async listMessagesForProfile(sessionId: string, profileId: string): Promise<SessionMessage[]> {
    return this.#db
      .query<MessageRow>(
        `select m.*
        from messages m
        join sessions s on s.id = m.session_id
        where s.profile_id = ? and m.session_id = ?
        order by m.created_at asc`
      )
      .all(profileId, sessionId)
      .map(rowToMessage);
  }

  async listEvents(sessionId: string): Promise<SessionEvent[]> {
    return this.#db
      .query<EventRow>("select event_json from session_events where session_id = ? order by created_at asc")
      .all(sessionId)
      .map((row) => JSON.parse(row.event_json) as SessionEvent);
  }

  async listEventsForProfile(sessionId: string, profileId: string): Promise<SessionEvent[]> {
    return this.#db
      .query<EventRow>(
        `select e.event_json
        from session_events e
        join sessions s on s.id = e.session_id
        where s.profile_id = ? and e.session_id = ?
        order by e.created_at asc`
      )
      .all(profileId, sessionId)
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

    this.#runMigrationStep(1, "v0.8-schema-v1", () => this.#migrateV1());
    this.#runMigrationStep(2, "v0.8-schema-v2", () => this.#migrateV2());
    this.#runMigrationStep(3, "v0.8-schema-v3", () => this.#migrateV3());
    this.#runMigrationStep(4, "v0.9-schema-v4-cron-executions", () => this.#migrateV4());
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

  #migrateV3(): void {
    // Defensive: inspect operator_events columns before adding each
    const rows = this.#db.query("pragma table_info(operator_events)").all() as Array<{ name: string }>;
    const colNames = new Set(rows.map((r) => r.name));
    if (!colNames.has("consumed_at")) {
      this.#db.exec("alter table operator_events add column consumed_at text");
    }
    if (!colNames.has("consumed_by_step_id")) {
      this.#db.exec("alter table operator_events add column consumed_by_step_id text");
    }
    if (!colNames.has("consumed_by_run_id")) {
      this.#db.exec("alter table operator_events add column consumed_by_run_id text");
    }
    if (!colNames.has("consumed_by_flow_event_id")) {
      this.#db.exec("alter table operator_events add column consumed_by_flow_event_id text");
    }
  }

  #migrateV2(): void {
    this.#db.exec(`
      create table if not exists compact_summaries (
        id text primary key,
        flow_id text not null references flows(id) on delete cascade,
        from_event_id text not null,
        to_event_id text not null,
        turn_summaries_json text not null,
        tool_outcome_summaries_json text not null,
        operator_action_summaries_json text not null,
        created_at text not null
      );
      create index if not exists idx_compact_summaries_flow on compact_summaries(flow_id, created_at);
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

  #migrateV1(): void {
    // TaskFlow durable execution schema (v0.8)
    this.#db.exec(`
      create table if not exists flows (
        id text primary key,
        session_id text not null,
        status text not null default 'pending',
        intent_json text not null,
        selected_skill text,
        current_step_id text,
        created_at text not null,
        updated_at text not null,
        completed_at text,
        cancelled_at text,
        failed_at text,
        pause_requested_at text,
        pause_reason text,
        interrupt_reason text,
        cancel_reason text,
        wait_reason_json text,
        operator_summary text,
        compacted_at text,
        checkpoint_count integer not null default 0,
        step_count integer not null default 0,
        retry_count integer not null default 0,
        metadata_json text
      );

      create table if not exists flow_steps (
        id text primary key,
        flow_id text not null references flows(id) on delete cascade,
        step_index integer not null,
        status text not null default 'pending',
        name text not null,
        description text not null,
        tool_plans_json text,
        executions_json text,
        retry_policy_json text not null,
        retry_count integer not null default 0,
        max_retries integer not null default 1,
        idempotent integer not null default 0,
        safe_to_retry integer not null default 0,
        failure_policy_json text not null,
        wait_reason_json text,
        pause_reason text,
        interrupt_reason text,
        skip_reason text,
        retry_of_step_id text,
        attempt_number integer not null default 1,
        started_at text,
        completed_at text,
        failed_at text,
        cancelled_at text,
        paused_at text,
        resumed_at text,
        wait_started_at text,
        wait_ended_at text,
        created_at text not null,
        updated_at text not null
      );

      create table if not exists flow_events (
        id text primary key,
        flow_id text not null references flows(id) on delete cascade,
        step_id text,
        kind text not null,
        data_json text not null,
        timestamp text not null
      );

      create table if not exists operator_events (
        id text primary key,
        flow_id text not null references flows(id) on delete cascade,
        step_id text,
        kind text not null,
        operator text not null,
        command text not null,
        effect text not null,
        previous_state text not null,
        new_state text not null,
        metadata_json text,
        timestamp text not null
      );

      create table if not exists checkpoints (
        id text primary key,
        flow_id text not null references flows(id) on delete cascade,
        step_id text,
        name text not null,
        description text,
        snapshot_json text not null,
        created_at text not null,
        created_by text not null
      );

      create table if not exists approval_gates (
        id text primary key,
        step_id text not null references flow_steps(id) on delete cascade,
        flow_id text not null references flows(id) on delete cascade,
        status text not null default 'pending',
        requested_at text not null,
        resolved_at text,
        resolved_by text,
        reason text not null,
        risk_class text not null,
        tool_name text,
        target_key text,
        target_summary text,
        scope text,
        controller_grant_id text,
        tool_executor_decision text not null,
        deterministic_rule text
      );

      create table if not exists flow_locks (
        flow_id text primary key,
        owner_id text not null,
        locked_at text not null,
        heartbeat_at text not null,
        expires_at text not null
      );

      create table if not exists flow_processes (
        id text primary key,
        flow_id text not null references flows(id) on delete cascade,
        step_id text not null,
        process_manager_id text not null,
        process_type text not null,
        command_summary text,
        started_at text not null,
        expected_exit_at text,
        status text not null default 'running'
      );

      create table if not exists flow_artifacts (
        artifact_id text not null,
        step_id text not null,
        flow_id text not null references flows(id) on delete cascade,
        kind text not null,
        linked_at text not null,
        primary key (artifact_id, step_id, flow_id)
      );

      create table if not exists flow_run_links (
        run_id text not null,
        step_id text not null,
        flow_id text not null references flows(id) on delete cascade,
        turn_index integer not null,
        linked_at text not null,
        primary key (run_id, step_id, flow_id)
      );

      create index if not exists idx_flows_session on flows(session_id, created_at);
      create index if not exists idx_flows_status on flows(status);
      create index if not exists idx_flow_steps_flow on flow_steps(flow_id, step_index);
      create index if not exists idx_flow_steps_status on flow_steps(status);
      create index if not exists idx_flow_events_flow on flow_events(flow_id, timestamp);
      create index if not exists idx_flow_events_step on flow_events(flow_id, step_id, timestamp);
      create index if not exists idx_operator_events_flow on operator_events(flow_id, timestamp);
      create index if not exists idx_checkpoints_flow on checkpoints(flow_id, created_at);
      create index if not exists idx_approval_gates_flow on approval_gates(flow_id, status);
      create index if not exists idx_approval_gates_step on approval_gates(step_id, status);
      create index if not exists idx_flow_processes_flow on flow_processes(flow_id, step_id);
      create index if not exists idx_flow_locks_expires on flow_locks(expires_at);
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
