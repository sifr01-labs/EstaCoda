import type { SQLiteDatabase } from "../storage/sqlite.js";

export type SessionFinalizationReason =
  | "new-session"
  | "cli-exit"
  | "sigint"
  | "channel-reset"
  | "one-shot";

export type SessionFinalizationStatus = "pending" | "running" | "completed" | "failed";

export type SessionFinalizationJob = {
  id: string;
  profileId: string;
  sessionId: string;
  reason: SessionFinalizationReason;
  status: SessionFinalizationStatus;
  sourceMessageCount: number;
  cutoffMessageId?: string;
  attempts: number;
  availableAt: string;
  claimedAt?: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  completedAt?: string;
  failedAt?: string;
  outcomeCode?: string;
  lastErrorCode?: string;
  createdAt: string;
  updatedAt: string;
};

export type SessionFinalizationQueueSummary = {
  pending: number;
  running: number;
  retrying: number;
  failed: number;
};

const DEFAULT_TERMINAL_RETENTION = 1_000;
const MAX_ENQUEUE_BUSY_TIMEOUT_MS = 1_000;

type SessionFinalizationRow = {
  id: string;
  profile_id: string;
  session_id: string;
  reason: SessionFinalizationReason;
  status: SessionFinalizationStatus;
  source_message_count: number;
  cutoff_message_id: string;
  attempts: number;
  available_at: string;
  claimed_at: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  outcome_code: string | null;
  last_error_code: string | null;
  created_at: string;
  updated_at: string;
};

type SessionCutoffRow = {
  source_message_count: number;
  cutoff_message_id: string | null;
};

const FINALIZATION_REASONS = new Set<SessionFinalizationReason>([
  "new-session",
  "cli-exit",
  "sigint",
  "channel-reset",
  "one-shot",
]);
const FINALIZATION_STATUSES = new Set<SessionFinalizationStatus>([
  "pending",
  "running",
  "completed",
  "failed",
]);

const SAFE_CODE = /^[a-z0-9][a-z0-9._-]{0,79}$/u;

export class SessionFinalizationQueue {
  readonly #db: SQLiteDatabase;
  readonly #now: () => Date;
  readonly #id: () => string;
  readonly #enqueueBusyTimeoutMs: number | undefined;

  constructor(options: {
    db: SQLiteDatabase;
    now?: () => Date;
    id?: () => string;
    enqueueBusyTimeoutMs?: number;
  }) {
    this.#db = options.db;
    this.#now = options.now ?? (() => new Date());
    this.#id = options.id ?? (() => crypto.randomUUID());
    this.#enqueueBusyTimeoutMs = options.enqueueBusyTimeoutMs === undefined
      ? undefined
      : requireBoundedNonNegativeInteger(
          options.enqueueBusyTimeoutMs,
          "enqueueBusyTimeoutMs",
          MAX_ENQUEUE_BUSY_TIMEOUT_MS
        );
  }

  enqueue(input: {
    profileId: string;
    sessionId: string;
    reason: SessionFinalizationReason;
  }): SessionFinalizationJob {
    const profileId = requireScopeValue(input.profileId, "profileId");
    const sessionId = requireScopeValue(input.sessionId, "sessionId");
    if (!FINALIZATION_REASONS.has(input.reason)) {
      throw new Error("Unsupported session finalization reason.");
    }

    const now = this.#now().toISOString();
    let job: SessionFinalizationRow | null = null;
    this.#withWriteTransaction(() => {
      const session = this.#db
        .query<{ id: string }>("select id from sessions where profile_id = ? and id = ?")
        .get(profileId, sessionId);
      if (session === null) {
        throw new Error("Session not found in the requested profile scope.");
      }

      const cutoff = this.#db
        .query<SessionCutoffRow>(
          `select
            count(*) as source_message_count,
            coalesce((select id from messages where session_id = ? order by rowid desc limit 1), '') as cutoff_message_id
          from messages
          where session_id = ?`
        )
        .get(sessionId, sessionId);
      if (cutoff === null) {
        throw new Error("Could not determine the session finalization cutoff.");
      }

      job = this.#db
        .query<SessionFinalizationRow>(
          `select * from session_finalization_jobs
          where profile_id = ? and session_id = ? and cutoff_message_id = ? and source_message_count = ?`
        )
        .get(profileId, sessionId, cutoff.cutoff_message_id, cutoff.source_message_count);
      if (job !== null) {
        return;
      }

      const id = this.#id();
      this.#db
        .query(
          `insert into session_finalization_jobs (
            id, profile_id, session_id, reason, status,
            source_message_count, cutoff_message_id, attempts,
            available_at, created_at, updated_at
          ) values (?, ?, ?, ?, 'pending', ?, ?, 0, ?, ?, ?)`
        )
        .run(
          id,
          profileId,
          sessionId,
          input.reason,
          cutoff.source_message_count,
          cutoff.cutoff_message_id,
          now,
          now,
          now
        );
      job = this.#getScopedRow(id, profileId);
    }, this.#enqueueBusyTimeoutMs);

    if (job === null) {
      throw new Error("Session finalization job disappeared before enqueue completed.");
    }
    return rowToJob(job);
  }

  claimNext(input: {
    profileId: string;
    ownerId: string;
    leaseMs: number;
  }): SessionFinalizationJob | undefined {
    const profileId = requireScopeValue(input.profileId, "profileId");
    const ownerId = requireScopeValue(input.ownerId, "ownerId");
    const leaseMs = requirePositiveInteger(input.leaseMs, "leaseMs");
    const nowDate = this.#now();
    const now = nowDate.toISOString();
    const leaseExpiresAt = new Date(nowDate.getTime() + leaseMs).toISOString();
    let claimed: SessionFinalizationRow | null = null;

    this.#withWriteTransaction(() => {
      this.#db
        .query(
          `update session_finalization_jobs
          set status = 'pending',
              claimed_at = null,
              lease_owner = null,
              lease_expires_at = null,
              available_at = ?,
              updated_at = ?
          where profile_id = ?
            and status = 'running'
            and lease_expires_at <= ?`
        )
        .run(now, now, profileId, now);

      const active = this.#db
        .query<{ id: string }>(
          `select id from session_finalization_jobs
          where profile_id = ? and status = 'running' and lease_expires_at > ?
          limit 1`
        )
        .get(profileId, now);
      if (active !== null) {
        return;
      }

      const next = this.#db
        .query<SessionFinalizationRow>(
          `select * from session_finalization_jobs
          where profile_id = ? and status = 'pending' and available_at <= ?
          order by available_at asc, created_at asc, id asc
          limit 1`
        )
        .get(profileId, now);
      if (next === null) {
        return;
      }

      const result = this.#db
        .query(
          `update session_finalization_jobs
          set status = 'running',
              attempts = attempts + 1,
              claimed_at = ?,
              lease_owner = ?,
              lease_expires_at = ?,
              updated_at = ?
          where id = ? and profile_id = ? and status = 'pending'`
        )
        .run(now, ownerId, leaseExpiresAt, now, next.id, profileId);
      if (result.changes === 1) {
        claimed = this.#getScopedRow(next.id, profileId);
      }
    });

    return claimed === null ? undefined : rowToJob(claimed);
  }

  renewLease(input: {
    id: string;
    profileId: string;
    ownerId: string;
    leaseMs: number;
  }): boolean {
    const nowDate = this.#now();
    const now = nowDate.toISOString();
    const result = this.#db
      .query(
        `update session_finalization_jobs
        set lease_expires_at = ?, updated_at = ?
        where id = ? and profile_id = ? and status = 'running' and lease_owner = ? and lease_expires_at > ?`
      )
      .run(
        new Date(nowDate.getTime() + requirePositiveInteger(input.leaseMs, "leaseMs")).toISOString(),
        now,
        requireScopeValue(input.id, "id"),
        requireScopeValue(input.profileId, "profileId"),
        requireScopeValue(input.ownerId, "ownerId"),
        now
      );
    return result.changes === 1;
  }

  complete(input: {
    id: string;
    profileId: string;
    ownerId: string;
    outcomeCode: string;
  }): boolean {
    return this.#finishRunningJob({
      ...input,
      status: "completed",
      code: requireSafeCode(input.outcomeCode, "outcomeCode"),
    });
  }

  fail(input: {
    id: string;
    profileId: string;
    ownerId: string;
    errorCode: string;
  }): boolean {
    return this.#finishRunningJob({
      ...input,
      status: "failed",
      code: requireSafeCode(input.errorCode, "errorCode"),
    });
  }

  retry(input: {
    id: string;
    profileId: string;
    ownerId: string;
    errorCode: string;
    delayMs: number;
  }): boolean {
    const nowDate = this.#now();
    const now = nowDate.toISOString();
    const availableAt = new Date(nowDate.getTime() + requireNonNegativeInteger(input.delayMs, "delayMs")).toISOString();
    const result = this.#db
      .query(
        `update session_finalization_jobs
        set status = 'pending',
            available_at = ?,
            claimed_at = null,
            lease_owner = null,
            lease_expires_at = null,
            last_error_code = ?,
            updated_at = ?
        where id = ? and profile_id = ? and status = 'running' and lease_owner = ? and lease_expires_at > ?`
      )
      .run(
        availableAt,
        requireSafeCode(input.errorCode, "errorCode"),
        now,
        requireScopeValue(input.id, "id"),
        requireScopeValue(input.profileId, "profileId"),
        requireScopeValue(input.ownerId, "ownerId"),
        now
      );
    return result.changes === 1;
  }

  retryFailed(input: {
    id: string;
    profileId: string;
  }): SessionFinalizationJob | undefined {
    const id = requireScopeValue(input.id, "id");
    const profileId = requireScopeValue(input.profileId, "profileId");
    const now = this.#now().toISOString();
    const result = this.#db
      .query(
        `update session_finalization_jobs
        set status = 'pending',
            attempts = 0,
            available_at = ?,
            claimed_at = null,
            lease_owner = null,
            lease_expires_at = null,
            failed_at = null,
            last_error_code = null,
            updated_at = ?
        where id = ? and profile_id = ? and status = 'failed'`
      )
      .run(now, now, id, profileId);
    return result.changes === 1 ? this.get(id, profileId) : undefined;
  }

  pruneTerminal(input: {
    profileId: string;
    keepLatest?: number;
  }): number {
    const profileId = requireScopeValue(input.profileId, "profileId");
    const keepLatest = input.keepLatest === undefined
      ? DEFAULT_TERMINAL_RETENTION
      : requireBoundedNonNegativeInteger(input.keepLatest, "keepLatest", 10_000);
    const result = this.#db
      .query(
        `delete from session_finalization_jobs
        where profile_id = ?
          and status in ('completed', 'failed')
          and id not in (
            select id from session_finalization_jobs
            where profile_id = ? and status in ('completed', 'failed')
            order by coalesce(completed_at, failed_at, updated_at) desc, id desc
            limit ?
          )`
      )
      .run(profileId, profileId, keepLatest);
    return result.changes;
  }

  get(id: string, profileId: string): SessionFinalizationJob | undefined {
    const row = this.#getScopedRow(
      requireScopeValue(id, "id"),
      requireScopeValue(profileId, "profileId")
    );
    return row === null ? undefined : rowToJob(row);
  }

  list(input: {
    profileId: string;
    status?: SessionFinalizationStatus;
    limit?: number;
  }): SessionFinalizationJob[] {
    const profileId = requireScopeValue(input.profileId, "profileId");
    const limit = input.limit === undefined ? 100 : requireBoundedPositiveInteger(input.limit, "limit", 1_000);
    if (input.status !== undefined && !FINALIZATION_STATUSES.has(input.status)) {
      throw new Error("Unsupported session finalization status.");
    }
    const rows = input.status === undefined
      ? this.#db
          .query<SessionFinalizationRow>(
            `select * from session_finalization_jobs
            where profile_id = ? order by created_at desc, id desc limit ?`
          )
          .all(profileId, limit)
      : this.#db
          .query<SessionFinalizationRow>(
            `select * from session_finalization_jobs
            where profile_id = ? and status = ? order by created_at desc, id desc limit ?`
          )
          .all(profileId, input.status, limit);
    return rows.map(rowToJob);
  }

  summarize(profileIdInput: string): SessionFinalizationQueueSummary {
    const profileId = requireScopeValue(profileIdInput, "profileId");
    const now = this.#now().toISOString();
    const row = this.#db
      .query<SessionFinalizationQueueSummary>(
        `select
          coalesce(sum(case when status = 'pending' and attempts = 0 then 1 else 0 end), 0) as pending,
          coalesce(sum(case when status = 'running' and lease_expires_at > ? then 1 else 0 end), 0) as running,
          coalesce(sum(case
            when status = 'pending' and attempts > 0 then 1
            when status = 'running' and lease_expires_at <= ? then 1
            else 0
          end), 0) as retrying,
          coalesce(sum(case when status = 'failed' then 1 else 0 end), 0) as failed
        from session_finalization_jobs
        where profile_id = ?`
      )
      .get(now, now, profileId);
    return row ?? { pending: 0, running: 0, retrying: 0, failed: 0 };
  }

  #finishRunningJob(input: {
    id: string;
    profileId: string;
    ownerId: string;
    status: "completed" | "failed";
    code: string;
  }): boolean {
    const now = this.#now().toISOString();
    const terminalColumn = input.status === "completed" ? "completed_at" : "failed_at";
    const codeColumn = input.status === "completed" ? "outcome_code" : "last_error_code";
    const result = this.#db
      .query(
        `update session_finalization_jobs
        set status = ?,
            ${terminalColumn} = ?,
            ${codeColumn} = ?,
            lease_owner = null,
            lease_expires_at = null,
            updated_at = ?
        where id = ? and profile_id = ? and status = 'running' and lease_owner = ? and lease_expires_at > ?`
      )
      .run(
        input.status,
        now,
        input.code,
        now,
        requireScopeValue(input.id, "id"),
        requireScopeValue(input.profileId, "profileId"),
        requireScopeValue(input.ownerId, "ownerId"),
        now
      );
    return result.changes === 1;
  }

  #getScopedRow(id: string, profileId: string): SessionFinalizationRow | null {
    return this.#db
      .query<SessionFinalizationRow>(
        "select * from session_finalization_jobs where id = ? and profile_id = ?"
      )
      .get(id, profileId);
  }

  #withWriteTransaction(write: () => void, busyTimeoutMs?: number): void {
    if (busyTimeoutMs === undefined) {
      this.#executeWriteTransaction(write);
      return;
    }

    const previousBusyTimeout = this.#db
      .query<{ timeout: number }>("pragma busy_timeout")
      .get()?.timeout;
    this.#db.exec(`pragma busy_timeout = ${busyTimeoutMs}`);
    let failure: unknown;
    try {
      this.#executeWriteTransaction(write);
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      try {
        if (previousBusyTimeout !== undefined) {
          this.#db.exec(`pragma busy_timeout = ${previousBusyTimeout}`);
        }
      } catch (error) {
        if (failure === undefined) {
          throw error;
        }
      }
    }
  }

  #executeWriteTransaction(write: () => void): void {
    this.#db.exec("begin immediate");
    try {
      write();
      this.#db.exec("commit");
    } catch (error) {
      try {
        this.#db.exec("rollback");
      } catch {
        // Preserve the original transaction failure.
      }
      throw error;
    }
  }
}

function rowToJob(row: SessionFinalizationRow): SessionFinalizationJob {
  return {
    id: row.id,
    profileId: row.profile_id,
    sessionId: row.session_id,
    reason: row.reason,
    status: row.status,
    sourceMessageCount: row.source_message_count,
    cutoffMessageId: row.cutoff_message_id.length === 0 ? undefined : row.cutoff_message_id,
    attempts: row.attempts,
    availableAt: row.available_at,
    claimedAt: row.claimed_at ?? undefined,
    leaseOwner: row.lease_owner ?? undefined,
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    failedAt: row.failed_at ?? undefined,
    outcomeCode: row.outcome_code ?? undefined,
    lastErrorCode: row.last_error_code ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function requireScopeValue(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized !== value) {
    throw new Error(`${label} must be a non-empty value without surrounding whitespace.`);
  }
  return normalized;
}

function requireSafeCode(value: string, label: string): string {
  if (!SAFE_CODE.test(value)) {
    throw new Error(`${label} must be a short lowercase operational code.`);
  }
  return value;
}

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function requireBoundedNonNegativeInteger(value: number, label: string, max: number): number {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new Error(`${label} must be an integer between 0 and ${max}.`);
  }
  return value;
}

function requireBoundedPositiveInteger(value: number, label: string, maximum: number): number {
  const normalized = requirePositiveInteger(value, label);
  if (normalized > maximum) {
    throw new Error(`${label} must not exceed ${maximum}.`);
  }
  return normalized;
}

function requireNonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return value;
}
