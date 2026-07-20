import type { SQLiteDatabase } from "../storage/sqlite.js";

export const TASK_SCHEMA_VERSION = 15;

const OBSOLETE_EXECUTION_TABLES = [
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

/** Drops incompatible pre-Task state before installing the authoritative Task schema. */
export function migrateTaskSchemaV10(db: SQLiteDatabase): void {
  for (const table of OBSOLETE_EXECUTION_TABLES) {
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
      lease_generation integer not null default 0 check(lease_generation >= 0),
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

    create trigger trg_task_attempt_lease_acquired
    after insert on task_attempt_leases
    begin
      update task_attempts
      set status = 'leased', lease_generation = new.fencing_token, updated_at = new.acquired_at
      where id = new.attempt_id
        and profile_id = new.profile_id
        and task_id = new.task_id
        and status = 'queued'
        and lease_generation < new.fencing_token;
      select case when changes() <> 1 then raise(abort, 'Task Attempt lease acquisition lost') end;
    end;

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

/** Adds the durable, profile-owned completion-delivery outbox used by the supervisor host. */
export function migrateTaskBackgroundHostSchemaV13(db: SQLiteDatabase): void {
  db.exec(`
    create table if not exists task_delivery_bindings (
      id text primary key check(length(id) between 1 and 256),
      profile_id text not null,
      task_id text not null,
      authorized_session_id text not null check(length(authorized_session_id) between 1 and 256),
      delivery_key text not null check(length(delivery_key) between 1 and 256),
      destination_json text not null check(json_valid(destination_json) and length(destination_json) <= 2048),
      status text not null check(status in ('pending', 'delivering', 'delivered', 'failed')),
      failure_class text check(failure_class is null or length(failure_class) between 1 and 128),
      failure_message text check(failure_message is null or length(failure_message) between 1 and 1000),
      created_at text not null,
      updated_at text not null,
      started_at text,
      delivered_at text,
      failed_at text,
      check(
        (status = 'pending' and started_at is null and delivered_at is null and failed_at is null and failure_class is null and failure_message is null) or
        (status = 'delivering' and started_at is not null and delivered_at is null and failed_at is null and failure_class is null and failure_message is null) or
        (status = 'delivered' and started_at is not null and delivered_at is not null and failed_at is null and failure_class is null and failure_message is null) or
        (status = 'failed' and started_at is not null and delivered_at is null and failed_at is not null and failure_class is not null)
      ),
      unique(profile_id, id),
      unique(profile_id, task_id, delivery_key),
      foreign key(profile_id, task_id)
        references tasks(profile_id, id) on delete cascade,
      foreign key(profile_id, authorized_session_id)
        references sessions(profile_id, id) on delete restrict
    );

    create index if not exists idx_task_delivery_bindings_pending
      on task_delivery_bindings(profile_id, status, updated_at, id);
    create index if not exists idx_task_delivery_bindings_task
      on task_delivery_bindings(profile_id, task_id, created_at, id);
  `);
}

/** Adds durable Task approvals, canonical provider-call usage, and monotonic lease generations. */
export function migrateTaskCorrectiveFoundationSchemaV14(db: SQLiteDatabase): void {
  const attemptColumns = db.query<{ name: string }>("pragma table_info(task_attempts)").all();
  if (!attemptColumns.some((column) => column.name === "lease_generation")) {
    db.exec("alter table task_attempts add column lease_generation integer not null default 0 check(lease_generation >= 0)");
  }

  // Preserve the strongest known pre-v14 fence before the trigger begins issuing generations.
  db.exec(`
    update task_attempts
    set lease_generation = max(
      lease_generation,
      coalesce((
        select fencing_token from task_attempt_leases
        where task_attempt_leases.attempt_id = task_attempts.id
          and task_attempt_leases.profile_id = task_attempts.profile_id
      ), 0)
    );
  `);

  db.exec(`
    drop trigger if exists trg_task_attempt_lease_acquired;
    create trigger trg_task_attempt_lease_acquired
    after insert on task_attempt_leases
    begin
      update task_attempts
      set status = 'leased', lease_generation = new.fencing_token, updated_at = new.acquired_at
      where id = new.attempt_id
        and profile_id = new.profile_id
        and task_id = new.task_id
        and status = 'queued'
        and lease_generation < new.fencing_token;
      select case when changes() <> 1 then raise(abort, 'Task Attempt lease acquisition lost') end;
    end;

    create table if not exists task_usage_entries (
      id text primary key,
      profile_id text not null,
      task_id text not null,
      plan_revision_id text not null,
      step_id text not null,
      attempt_id text not null,
      request_key text not null check(length(request_key) between 1 and 512),
      turn_id text not null check(length(turn_id) between 1 and 512),
      provider_attempt_index integer not null check(provider_attempt_index >= 0),
      provider text not null check(length(provider) between 1 and 128),
      model text not null check(length(model) between 1 and 256),
      route_role text not null check(route_role in ('primary', 'fallback')),
      route_index integer not null check(route_index >= 0),
      dispatched integer not null check(dispatched in (0, 1)),
      input_tokens integer not null check(input_tokens >= 0),
      output_tokens integer not null check(output_tokens >= 0),
      reasoning_tokens integer not null check(reasoning_tokens >= 0),
      total_tokens integer not null check(total_tokens >= 0),
      estimated_cost_usd real not null check(estimated_cost_usd >= 0),
      usage_complete integer not null check(usage_complete in (0, 1)),
      pricing_complete integer not null check(pricing_complete in (0, 1)),
      incomplete_reasons_json text not null check(json_valid(incomplete_reasons_json)),
      occurred_at text not null,
      unique(profile_id, id),
      unique(profile_id, request_key),
      foreign key(profile_id, task_id, plan_revision_id, step_id, attempt_id)
        references task_attempts(profile_id, task_id, plan_revision_id, step_id, id) on delete cascade
    );
    create index if not exists idx_task_usage_attempt
      on task_usage_entries(profile_id, attempt_id, occurred_at, provider_attempt_index);
    create index if not exists idx_task_usage_task
      on task_usage_entries(profile_id, task_id, occurred_at);

    create table if not exists task_approval_links (
      id text primary key,
      profile_id text not null,
      task_id text not null,
      plan_revision_id text not null,
      step_id text not null,
      attempt_id text not null,
      authorized_session_id text not null,
      pending_approval_id text,
      tool_name text not null check(length(tool_name) between 1 and 256),
      risk_class text not null check(risk_class in (
        'read-only-local', 'read-only-network', 'workspace-write', 'external-side-effect',
        'credential-access', 'destructive-local', 'shared-state-mutation', 'spend-money', 'sandbox-escape'
      )),
      target_fingerprint text not null check(length(target_fingerprint) = 71 and target_fingerprint like 'sha256:%'),
      target_preview text not null check(length(target_preview) between 1 and 500),
      status text not null check(status in ('requesting', 'pending', 'approved', 'denied', 'expired', 'consumed')),
      requested_at text not null,
      expires_at text not null,
      updated_at text not null,
      resolved_at text,
      consumed_at text,
      unique(profile_id, id),
      unique(profile_id, pending_approval_id),
      foreign key(profile_id, task_id, plan_revision_id, step_id, attempt_id)
        references task_attempts(profile_id, task_id, plan_revision_id, step_id, id) on delete cascade,
      foreign key(profile_id, authorized_session_id)
        references sessions(profile_id, id) on delete restrict,
      foreign key(pending_approval_id)
        references pending_approvals(id) on delete restrict,
      check(
        (status = 'requesting' and pending_approval_id is null and resolved_at is null and consumed_at is null) or
        (status = 'pending' and pending_approval_id is not null and resolved_at is null and consumed_at is null) or
        (status in ('approved', 'denied', 'expired') and pending_approval_id is not null and resolved_at is not null and consumed_at is null) or
        (status = 'consumed' and pending_approval_id is not null and resolved_at is not null and consumed_at is not null)
      )
    );
    create index if not exists idx_task_approval_reconcile
      on task_approval_links(profile_id, status, updated_at, id);
    create index if not exists idx_task_approval_attempt
      on task_approval_links(profile_id, attempt_id, status);
    create index if not exists idx_task_approval_target
      on task_approval_links(profile_id, attempt_id, target_fingerprint, status);
  `);
}

/** Adds durable steering context and its bounded audit event for fixed Task graphs. */
export function migrateTaskVerticalSliceSchemaV15(db: SQLiteDatabase): void {
  db.exec(`
    create table if not exists task_guidance (
      id text primary key check(length(id) between 1 and 256),
      profile_id text not null,
      task_id text not null,
      authorized_session_id text not null check(length(authorized_session_id) between 1 and 256),
      guidance text not null check(length(guidance) between 1 and 4000),
      created_at text not null,
      unique(profile_id, id),
      foreign key(profile_id, task_id)
        references tasks(profile_id, id) on delete cascade,
      foreign key(profile_id, authorized_session_id)
        references sessions(profile_id, id) on delete restrict
    );
    create index if not exists idx_task_guidance_task
      on task_guidance(profile_id, task_id, created_at, id);
  `);

  const definition = db.query<{ sql: string | null }>(
    "select sql from sqlite_master where type = 'table' and name = 'task_events'"
  ).get()?.sql;
  if (definition?.includes("task-steered")) return;

  db.exec(`
    alter table task_events rename to task_events_v14;

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
        'attempt-expired', 'approval-requested', 'approval-resolved', 'task-steered',
        'usage-recorded', 'result-recorded'
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
    from task_events_v14;

    drop table task_events_v14;

    create index idx_task_events_task
      on task_events(profile_id, task_id, timestamp, id);
    create index idx_task_events_attempt
      on task_events(profile_id, attempt_id, timestamp);
  `);
}
