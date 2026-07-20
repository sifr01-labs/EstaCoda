import type { SQLiteDatabase } from "../storage/sqlite.js";

export const TASK_SCHEMA_VERSION = 12;

const WORKFLOW_TABLES = [
  "workflow_event_summaries",
  "workflow_approval_gates",
  "workflow_operator_events",
  "workflow_events",
  "workflow_checkpoints",
  "workflow_locks",
  "workflow_processes",
  "workflow_artifacts",
  "workflow_agent_run_links",
  "workflow_steps",
  "workflow_runs",
  "compact_summaries",
  "approval_gates",
  "operator_events",
  "flow_events",
  "checkpoints",
  "flow_locks",
  "flow_processes",
  "flow_artifacts",
  "flow_run_links",
  "flow_steps",
  "flows"
] as const;

/**
 * Replaces the pre-Task Workflow persistence model. Legacy Workflow rows are
 * intentionally not converted: Task authority, immutable plans, attempts, and
 * profile ownership cannot be inferred safely from those records.
 */
export function migrateTaskSchemaV10(db: SQLiteDatabase): void {
  for (const table of WORKFLOW_TABLES) {
    db.exec(`drop table if exists ${table}`);
  }

  db.exec(`
    create unique index if not exists uq_sessions_profile_id on sessions(profile_id, id);
    create unique index if not exists uq_trajectories_profile_id on trajectories(profile_id, id);

    create table tasks (
      id text primary key,
      profile_id text not null check(length(profile_id) > 0),
      creator_session_id text,
      parent_task_id text,
      parent_attempt_id text,
      source text not null check(source in ('cli', 'gateway', 'delegation', 'runtime')),
      creation_key text,
      objective text not null check(length(objective) > 0),
      status text not null check(status in (
        'planning', 'queued', 'running', 'waiting_for_host', 'waiting_for_input',
        'waiting_for_approval', 'paused', 'completed', 'partial', 'failed', 'cancelled'
      )),
      workspace_path text not null check(length(workspace_path) > 0),
      workspace_identity_hash text not null check(length(workspace_identity_hash) > 0),
      authority_policy_json text not null check(json_valid(authority_policy_json)),
      budget_policy_json text not null check(json_valid(budget_policy_json)),
      active_plan_revision_id text,
      wait_reason_json text check(wait_reason_json is null or json_valid(wait_reason_json)),
      failure_json text check(failure_json is null or json_valid(failure_json)),
      created_by_json text not null check(json_valid(created_by_json)),
      created_at text not null,
      updated_at text not null,
      started_at text,
      completed_at text,
      cancelled_at text,
      unique(profile_id, id),
      check(parent_attempt_id is null or parent_task_id is not null),
      foreign key(profile_id, creator_session_id)
        references sessions(profile_id, id) on delete restrict,
      foreign key(profile_id, parent_task_id)
        references tasks(profile_id, id) on delete restrict,
      foreign key(profile_id, parent_task_id, parent_attempt_id)
        references task_attempts(profile_id, task_id, id) on delete restrict,
      foreign key(profile_id, id, active_plan_revision_id)
        references task_plan_revisions(profile_id, task_id, id)
        deferrable initially deferred
    );

    create unique index uq_tasks_profile_creation_key
      on tasks(profile_id, creation_key) where creation_key is not null;
    create index idx_tasks_profile_status_updated
      on tasks(profile_id, status, updated_at desc);
    create index idx_tasks_profile_workspace
      on tasks(profile_id, workspace_identity_hash, updated_at desc);
    create index idx_tasks_parent
      on tasks(profile_id, parent_task_id, created_at);

    create table task_plan_revisions (
      id text primary key,
      profile_id text not null,
      task_id text not null,
      revision integer not null check(revision > 0),
      status text not null check(status in ('draft', 'validated', 'active', 'superseded', 'rejected')),
      reason text not null,
      created_by_json text not null check(json_valid(created_by_json)),
      created_at text not null,
      validated_at text,
      activated_at text,
      superseded_at text,
      unique(profile_id, id),
      unique(profile_id, task_id, id),
      unique(profile_id, task_id, revision),
      foreign key(profile_id, task_id)
        references tasks(profile_id, id) on delete cascade
    );

    create unique index uq_task_plan_active
      on task_plan_revisions(profile_id, task_id) where status = 'active';
    create index idx_task_plan_revisions_task
      on task_plan_revisions(profile_id, task_id, revision desc);

    create table task_steps (
      id text primary key,
      profile_id text not null,
      task_id text not null,
      plan_revision_id text not null,
      step_key text not null check(length(step_key) > 0),
      position integer not null check(position >= 0),
      status text not null check(status in (
        'pending', 'ready', 'running', 'waiting_for_input', 'waiting_for_approval',
        'completed', 'failed', 'skipped', 'cancelled'
      )),
      title text not null check(length(title) > 0),
      objective text not null check(length(objective) > 0),
      executor_json text not null check(json_valid(executor_json)),
      authority_policy_json text not null check(json_valid(authority_policy_json)),
      budget_json text not null check(json_valid(budget_json)),
      retry_policy_json text not null check(json_valid(retry_policy_json)),
      failure_policy_json text not null check(json_valid(failure_policy_json)),
      idempotency text not null check(idempotency in ('idempotent', 'retry_safe', 'non_idempotent', 'unknown')),
      result_policy_json text not null check(json_valid(result_policy_json)),
      created_at text not null,
      updated_at text not null,
      unique(profile_id, id),
      unique(profile_id, task_id, id),
      unique(profile_id, task_id, plan_revision_id, id),
      unique(profile_id, task_id, plan_revision_id, step_key),
      unique(profile_id, task_id, plan_revision_id, position),
      foreign key(profile_id, task_id, plan_revision_id)
        references task_plan_revisions(profile_id, task_id, id) on delete cascade
    );

    create index idx_task_steps_ready
      on task_steps(profile_id, task_id, plan_revision_id, status, position);

    create table task_step_dependencies (
      profile_id text not null,
      task_id text not null,
      plan_revision_id text not null,
      step_id text not null,
      dependency_step_id text not null,
      primary key(profile_id, step_id, dependency_step_id),
      check(step_id <> dependency_step_id),
      foreign key(profile_id, task_id, plan_revision_id, step_id)
        references task_steps(profile_id, task_id, plan_revision_id, id) on delete cascade,
      foreign key(profile_id, task_id, plan_revision_id, dependency_step_id)
        references task_steps(profile_id, task_id, plan_revision_id, id) on delete cascade
    );

    create index idx_task_step_dependencies_plan
      on task_step_dependencies(profile_id, task_id, plan_revision_id, step_id);
    create index idx_task_step_dependents
      on task_step_dependencies(profile_id, dependency_step_id);

    create table task_attempts (
      id text primary key,
      profile_id text not null,
      task_id text not null,
      plan_revision_id text not null,
      step_id text not null,
      attempt_number integer not null check(attempt_number > 0),
      status text not null check(status in (
        'queued', 'leased', 'running', 'waiting_for_input', 'waiting_for_approval',
        'completed', 'failed', 'cancelled', 'interrupted', 'expired'
      )),
      dispatch_key text not null check(length(dispatch_key) > 0),
      worker_session_id text,
      trajectory_id text,
      usage_json text not null check(json_valid(usage_json)),
      failure_json text check(failure_json is null or json_valid(failure_json)),
      created_at text not null,
      updated_at text not null,
      started_at text,
      completed_at text,
      unique(profile_id, id),
      unique(profile_id, task_id, id),
      unique(profile_id, task_id, plan_revision_id, step_id, id),
      unique(profile_id, task_id, plan_revision_id, step_id, attempt_number),
      unique(profile_id, dispatch_key),
      foreign key(profile_id, task_id, plan_revision_id, step_id)
        references task_steps(profile_id, task_id, plan_revision_id, id) on delete cascade,
      foreign key(profile_id, worker_session_id)
        references sessions(profile_id, id) on delete restrict,
      foreign key(profile_id, trajectory_id)
        references trajectories(profile_id, id) on delete restrict
    );

    create index idx_task_attempts_dispatch
      on task_attempts(profile_id, status, created_at);
    create index idx_task_attempts_step
      on task_attempts(profile_id, task_id, step_id, attempt_number desc);

    create table task_attempt_leases (
      attempt_id text primary key,
      profile_id text not null,
      task_id text not null,
      owner_id text not null check(length(owner_id) > 0),
      fencing_token integer not null check(fencing_token > 0),
      acquired_at text not null,
      heartbeat_at text not null,
      expires_at text not null,
      unique(profile_id, task_id, attempt_id),
      foreign key(profile_id, task_id, attempt_id)
        references task_attempts(profile_id, task_id, id) on delete cascade
    );

    create index idx_task_attempt_leases_expiry
      on task_attempt_leases(profile_id, expires_at);

    create table task_results (
      id text primary key,
      profile_id text not null,
      task_id text not null,
      step_id text,
      attempt_id text,
      kind text not null check(kind in ('text', 'json', 'artifact', 'summary')),
      status text not null check(status in ('available', 'pruned')),
      handle text not null check(length(handle) > 0),
      byte_length integer not null check(byte_length >= 0),
      content_hash text not null check(length(content_hash) > 0),
      mime_type text,
      summary text,
      created_at text not null,
      expires_at text,
      pruned_at text,
      unique(profile_id, id),
      unique(profile_id, handle),
      foreign key(profile_id, task_id)
        references tasks(profile_id, id) on delete cascade,
      foreign key(profile_id, task_id, step_id)
        references task_steps(profile_id, task_id, id) on delete cascade,
      foreign key(profile_id, task_id, attempt_id)
        references task_attempts(profile_id, task_id, id) on delete cascade
    );

    create index idx_task_results_task
      on task_results(profile_id, task_id, created_at);
    create index idx_task_results_attempt
      on task_results(profile_id, attempt_id, created_at);

    create table task_events (
      id text primary key,
      profile_id text not null,
      task_id text not null,
      plan_revision_id text,
      step_id text,
      attempt_id text,
      kind text not null check(kind in (
        'task-created', 'task-state-changed', 'plan-revision-created',
        'plan-revision-validated', 'plan-revision-activated', 'plan-revision-rejected',
        'plan-revision-superseded', 'step-state-changed', 'attempt-created',
        'attempt-leased', 'attempt-started', 'attempt-progressed', 'attempt-waiting', 'attempt-completed',
        'attempt-failed', 'attempt-cancelled', 'attempt-interrupted', 'attempt-expired',
        'approval-requested', 'approval-resolved', 'usage-recorded', 'result-recorded'
      )),
      timestamp text not null,
      data_json text not null check(json_valid(data_json)),
      unique(profile_id, id),
      foreign key(profile_id, task_id)
        references tasks(profile_id, id) on delete cascade,
      foreign key(profile_id, task_id, plan_revision_id)
        references task_plan_revisions(profile_id, task_id, id) on delete cascade,
      foreign key(profile_id, task_id, step_id)
        references task_steps(profile_id, task_id, id) on delete cascade,
      foreign key(profile_id, task_id, attempt_id)
        references task_attempts(profile_id, task_id, id) on delete cascade
    );

    create index idx_task_events_task
      on task_events(profile_id, task_id, timestamp, id);
    create index idx_task_events_attempt
      on task_events(profile_id, attempt_id, timestamp);

    create table task_session_links (
      id integer primary key autoincrement,
      task_id text not null,
      profile_id text not null,
      session_id text not null,
      relationship text not null check(relationship in ('creator', 'worker', 'observer')),
      step_id text,
      attempt_id text,
      created_at text not null,
      foreign key(profile_id, task_id)
        references tasks(profile_id, id) on delete cascade,
      foreign key(profile_id, session_id)
        references sessions(profile_id, id) on delete cascade,
      foreign key(profile_id, task_id, step_id)
        references task_steps(profile_id, task_id, id) on delete cascade,
      foreign key(profile_id, task_id, attempt_id)
        references task_attempts(profile_id, task_id, id) on delete cascade
    );

    create unique index uq_task_session_links_identity on task_session_links(
      profile_id, task_id, session_id, relationship,
      ifnull(step_id, ''), ifnull(attempt_id, '')
    );
    create index idx_task_session_links_session
      on task_session_links(profile_id, session_id, created_at);
  `);
}

/** Adds the durable cancellation signal consumed by the Task scheduler lease owner. */
export function migrateTaskSchedulerSchemaV11(db: SQLiteDatabase): void {
  const columns = db.query<{ name: string }>("pragma table_info(task_attempt_leases)").all();
  if (!columns.some((column) => column.name === "cancellation_requested_at")) {
    db.exec("alter table task_attempt_leases add column cancellation_requested_at text");
  }
}

/** Extends the Task journal with fenced worker-session and trajectory checkpoints. */
export function migrateTaskAgentExecutorSchemaV12(db: SQLiteDatabase): void {
  const definition = db.query<{ sql: string | null }>(
    "select sql from sqlite_master where type = 'table' and name = 'task_events'"
  ).get()?.sql;
  if (definition?.includes("attempt-progressed")) return;

  db.exec(`
    alter table task_events rename to task_events_v11;

    create table task_events (
      id text primary key,
      profile_id text not null,
      task_id text not null,
      plan_revision_id text,
      step_id text,
      attempt_id text,
      kind text not null check(kind in (
        'task-created', 'task-state-changed', 'plan-revision-created',
        'plan-revision-validated', 'plan-revision-activated', 'plan-revision-rejected',
        'plan-revision-superseded', 'step-state-changed', 'attempt-created',
        'attempt-leased', 'attempt-started', 'attempt-progressed', 'attempt-waiting',
        'attempt-completed', 'attempt-failed', 'attempt-cancelled', 'attempt-interrupted',
        'attempt-expired', 'approval-requested', 'approval-resolved', 'usage-recorded',
        'result-recorded'
      )),
      timestamp text not null,
      data_json text not null check(json_valid(data_json)),
      unique(profile_id, id),
      foreign key(profile_id, task_id)
        references tasks(profile_id, id) on delete cascade,
      foreign key(profile_id, task_id, plan_revision_id)
        references task_plan_revisions(profile_id, task_id, id) on delete cascade,
      foreign key(profile_id, task_id, step_id)
        references task_steps(profile_id, task_id, id) on delete cascade,
      foreign key(profile_id, task_id, attempt_id)
        references task_attempts(profile_id, task_id, id) on delete cascade
    );

    insert into task_events (
      id, profile_id, task_id, plan_revision_id, step_id, attempt_id, kind, timestamp, data_json
    ) select
      id, profile_id, task_id, plan_revision_id, step_id, attempt_id, kind, timestamp, data_json
    from task_events_v11;

    drop table task_events_v11;

    create index idx_task_events_task
      on task_events(profile_id, task_id, timestamp, id);
    create index idx_task_events_attempt
      on task_events(profile_id, attempt_id, timestamp);
  `);
}
