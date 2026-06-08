// SQLite-backed WorkflowStore implementation

import type {
  WorkflowRun,
  WorkflowRunId,
  WorkflowStep,
  WorkflowStepId,
  WorkflowEvent,
  WorkflowOperatorEvent,
  WorkflowCheckpoint,
  WorkflowCheckpointId,
  WorkflowApprovalGate,
  WorkflowArtifactLink,
  WorkflowAgentRunLink,
  WorkflowProcess,
  WorkflowLock,
  WorkflowEventSummary,
  RunId,
  EventId
} from "./types.js";
import type { WorkflowStore } from "./workflow-store.js";
import type { IntentRoute } from "../contracts/intent.js";
import type { ToolCallPlan } from "../contracts/tool-plan.js";
import type { SQLiteDatabase } from "../storage/sqlite.js";

export type SQLiteWorkflowStoreOptions = {
  db: SQLiteDatabase;
  profileId?: string;
  now?: () => Date;
  id?: () => string;
};

export class SQLiteWorkflowStore implements WorkflowStore {
  readonly #db: SQLiteDatabase;
  readonly #profileId: string | undefined;
  readonly #now: () => Date;
  readonly #id: () => string;

  constructor(options: SQLiteWorkflowStoreOptions) {
    this.#db = options.db;
    this.#profileId = options.profileId;
    this.#now = options.now ?? (() => new Date());
    this.#id = options.id ?? (() => crypto.randomUUID());
  }

  // ─── WorkflowRun ───

  async createWorkflowRun(flow: WorkflowRun): Promise<void> {
    this.#assertSessionInProfile(flow.sessionId);
    this.#db
      .query(
        `insert into workflow_runs (
          id, session_id, status, intent_json, selected_skill, current_workflow_step_id,
          created_at, updated_at, completed_at, cancelled_at, failed_at,
          pause_requested_at, pause_reason, interrupt_reason, cancel_reason,
          wait_reason_json, operator_summary, compacted_at,
          checkpoint_count, step_count, retry_count, metadata_json
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        flow.id,
        flow.sessionId,
        flow.status,
        JSON.stringify(flow.intent),
        flow.selectedSkill ?? null,
        flow.currentStepId ?? null,
        flow.createdAt,
        flow.updatedAt,
        flow.completedAt ?? null,
        flow.cancelledAt ?? null,
        flow.failedAt ?? null,
        flow.pauseRequestedAt ?? null,
        flow.pauseReason ?? null,
        flow.interruptReason ?? null,
        flow.cancelReason ?? null,
        flow.waitReason ? JSON.stringify(flow.waitReason) : null,
        flow.operatorSummary ?? null,
        flow.compactedAt ?? null,
        flow.checkpointCount,
        flow.stepCount,
        flow.retryCount,
        JSON.stringify(flow.metadata)
      );
  }

  async updateWorkflowRun(flow: WorkflowRun): Promise<void> {
    this.#assertSessionInProfile(flow.sessionId);
    this.#db
      .query(
        `update workflow_runs set
          status = ?, intent_json = ?, selected_skill = ?, current_workflow_step_id = ?,
          updated_at = ?, completed_at = ?, cancelled_at = ?, failed_at = ?,
          pause_requested_at = ?, pause_reason = ?, interrupt_reason = ?, cancel_reason = ?,
          wait_reason_json = ?, operator_summary = ?, compacted_at = ?,
          checkpoint_count = ?, step_count = ?, retry_count = ?, metadata_json = ?
        where id = ?`
      )
      .run(
        flow.status,
        JSON.stringify(flow.intent),
        flow.selectedSkill ?? null,
        flow.currentStepId ?? null,
        flow.updatedAt,
        flow.completedAt ?? null,
        flow.cancelledAt ?? null,
        flow.failedAt ?? null,
        flow.pauseRequestedAt ?? null,
        flow.pauseReason ?? null,
        flow.interruptReason ?? null,
        flow.cancelReason ?? null,
        flow.waitReason ? JSON.stringify(flow.waitReason) : null,
        flow.operatorSummary ?? null,
        flow.compactedAt ?? null,
        flow.checkpointCount,
        flow.stepCount,
        flow.retryCount,
        JSON.stringify(flow.metadata),
        flow.id
      );
  }

  async getWorkflowRun(id: WorkflowRunId): Promise<WorkflowRun | null> {
    const row =
      this.#profileId === undefined
        ? this.#db.query<WorkflowRunRow>("select * from workflow_runs where id = ?").get(id)
        : this.#db
            .query<WorkflowRunRow>(
              `select f.*
               from workflow_runs f
               join sessions s on s.id = f.session_id
               where f.id = ? and s.profile_id = ?`
            )
            .get(id, this.#profileId);
    return row ? rowToWorkflowRun(row) : null;
  }

  async listWorkflowRuns(sessionId?: string): Promise<WorkflowRun[]> {
    const rows =
      this.#profileId === undefined
        ? sessionId
          ? this.#db.query<WorkflowRunRow>("select * from workflow_runs where session_id = ? order by created_at desc").all(sessionId)
          : this.#db.query<WorkflowRunRow>("select * from workflow_runs order by created_at desc").all()
        : sessionId
          ? this.#db
              .query<WorkflowRunRow>(
                `select f.*
                 from workflow_runs f
                 join sessions s on s.id = f.session_id
                 where f.session_id = ? and s.profile_id = ?
                 order by f.created_at desc`
              )
              .all(sessionId, this.#profileId)
          : this.#db
              .query<WorkflowRunRow>(
                `select f.*
                 from workflow_runs f
                 join sessions s on s.id = f.session_id
                 where s.profile_id = ?
                 order by f.created_at desc`
              )
              .all(this.#profileId);
    return rows.map(rowToWorkflowRun);
  }

  async listActiveWorkflowRuns(): Promise<WorkflowRun[]> {
    const rows =
      this.#profileId === undefined
        ? this.#db
            .query<WorkflowRunRow>(`select * from workflow_runs where status in ('pending','running','paused','waiting','interrupted') order by updated_at desc`)
            .all()
        : this.#db
            .query<WorkflowRunRow>(
              `select f.*
               from workflow_runs f
               join sessions s on s.id = f.session_id
               where s.profile_id = ? and f.status in ('pending','running','paused','waiting','interrupted')
               order by f.updated_at desc`
            )
            .all(this.#profileId);
    return rows.map(rowToWorkflowRun);
  }

  // ─── Step ───

  async createWorkflowStep(step: WorkflowStep): Promise<void> {
    this.#assertFlowInProfile(step.flowId);
    this.#db
      .query(
        `insert into workflow_steps (
          id, workflow_run_id, step_index, status, name, description,
          tool_plans_json, executions_json, retry_policy_json, retry_count, max_retries,
          idempotent, safe_to_retry, failure_policy_json, wait_reason_json,
          pause_reason, interrupt_reason, skip_reason, retry_of_workflow_step_id, attempt_number,
          started_at, completed_at, failed_at, cancelled_at, paused_at, resumed_at,
          wait_started_at, wait_ended_at, created_at, updated_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        step.id,
        step.flowId,
        step.index,
        step.status,
        step.name,
        step.description,
        JSON.stringify(step.toolPlans),
        JSON.stringify(step.executions),
        JSON.stringify(step.retryPolicy),
        step.retryCount,
        step.maxRetries,
        step.idempotent ? 1 : 0,
        step.safeToRetry ? 1 : 0,
        JSON.stringify(step.failurePolicy),
        step.waitReason ? JSON.stringify(step.waitReason) : null,
        step.pauseReason ?? null,
        step.interruptReason ?? null,
        step.skipReason ?? null,
        step.retryOfStepId ?? null,
        step.attemptNumber,
        step.startedAt ?? null,
        step.completedAt ?? null,
        step.failedAt ?? null,
        step.cancelledAt ?? null,
        step.pausedAt ?? null,
        step.resumedAt ?? null,
        step.waitStartedAt ?? null,
        step.waitEndedAt ?? null,
        step.createdAt,
        step.updatedAt
      );
  }

  async updateWorkflowStep(step: WorkflowStep): Promise<void> {
    this.#assertFlowInProfile(step.flowId);
    this.#db
      .query(
        `update workflow_steps set
          workflow_run_id = ?, step_index = ?, status = ?, name = ?, description = ?,
          tool_plans_json = ?, executions_json = ?, retry_policy_json = ?, retry_count = ?, max_retries = ?,
          idempotent = ?, safe_to_retry = ?, failure_policy_json = ?, wait_reason_json = ?,
          pause_reason = ?, interrupt_reason = ?, skip_reason = ?, retry_of_workflow_step_id = ?, attempt_number = ?,
          started_at = ?, completed_at = ?, failed_at = ?, cancelled_at = ?, paused_at = ?, resumed_at = ?,
          wait_started_at = ?, wait_ended_at = ?, updated_at = ?
        where id = ?`
      )
      .run(
        step.flowId,
        step.index,
        step.status,
        step.name,
        step.description,
        JSON.stringify(step.toolPlans),
        JSON.stringify(step.executions),
        JSON.stringify(step.retryPolicy),
        step.retryCount,
        step.maxRetries,
        step.idempotent ? 1 : 0,
        step.safeToRetry ? 1 : 0,
        JSON.stringify(step.failurePolicy),
        step.waitReason ? JSON.stringify(step.waitReason) : null,
        step.pauseReason ?? null,
        step.interruptReason ?? null,
        step.skipReason ?? null,
        step.retryOfStepId ?? null,
        step.attemptNumber,
        step.startedAt ?? null,
        step.completedAt ?? null,
        step.failedAt ?? null,
        step.cancelledAt ?? null,
        step.pausedAt ?? null,
        step.resumedAt ?? null,
        step.waitStartedAt ?? null,
        step.waitEndedAt ?? null,
        step.updatedAt,
        step.id
      );
  }

  async getWorkflowStep(id: WorkflowStepId): Promise<WorkflowStep | null> {
    const row =
      this.#profileId === undefined
        ? this.#db.query<WorkflowStepRow>("select * from workflow_steps where id = ?").get(id)
        : this.#db
            .query<WorkflowStepRow>(
              `select fs.*
               from workflow_steps fs
               join workflow_runs f on f.id = fs.workflow_run_id
               join sessions s on s.id = f.session_id
               where fs.id = ? and s.profile_id = ?`
            )
            .get(id, this.#profileId);
    return row ? rowToWorkflowStep(row) : null;
  }

  async listWorkflowSteps(flowId: WorkflowRunId): Promise<WorkflowStep[]> {
    const rows =
      this.#profileId === undefined
        ? this.#db.query<WorkflowStepRow>("select * from workflow_steps where workflow_run_id = ? order by step_index, created_at").all(flowId)
        : this.#db
            .query<WorkflowStepRow>(
              `select fs.*
               from workflow_steps fs
               join workflow_runs f on f.id = fs.workflow_run_id
               join sessions s on s.id = f.session_id
               where fs.workflow_run_id = ? and s.profile_id = ?
               order by fs.step_index, fs.created_at`
            )
            .all(flowId, this.#profileId);
    return rows.map(rowToWorkflowStep);
  }

  // ─── Events ───

  async appendWorkflowEvent(event: WorkflowEvent): Promise<void> {
    this.#db
      .query("insert into workflow_events (id, workflow_run_id, workflow_step_id, kind, data_json, timestamp) values (?, ?, ?, ?, ?, ?)")
      .run(event.id, event.flowId, event.stepId ?? null, event.kind, JSON.stringify(event.data), event.timestamp);
  }

  async appendWorkflowOperatorEvent(event: WorkflowOperatorEvent): Promise<void> {
    this.#db
      .query(
        `insert into workflow_operator_events (
          id, workflow_run_id, workflow_step_id, kind, operator, command, effect, previous_state, new_state, metadata_json, timestamp,
          consumed_at, consumed_by_workflow_step_id, consumed_by_run_id, consumed_by_workflow_event_id
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.id,
        event.flowId,
        event.stepId ?? null,
        event.kind,
        event.operator,
        event.command,
        event.effect,
        event.previousState,
        event.newState,
        event.metadata ? JSON.stringify(event.metadata) : null,
        event.timestamp,
        event.consumedAt ?? null,
        event.consumedByStepId ?? null,
        event.consumedByRunId ?? null,
        event.consumedByFlowEventId ?? null
      );
  }

  async listWorkflowEvents(flowId: WorkflowRunId, options?: { stepId?: WorkflowStepId; kind?: string; limit?: number }): Promise<WorkflowEvent[]> {
    let sql = "select * from workflow_events where workflow_run_id = ?";
    const params: (string | number)[] = [flowId];
    if (options?.stepId) {
      sql += " and workflow_step_id = ?";
      params.push(options.stepId);
    }
    if (options?.kind) {
      sql += " and kind = ?";
      params.push(options.kind);
    }
    sql += " order by timestamp desc";
    if (options?.limit) {
      sql += " limit ?";
      params.push(options.limit);
    }
    const rows = this.#db.query<WorkflowEventRow>(sql).all(...params);
    return rows.map(rowToWorkflowEvent);
  }

  async listWorkflowOperatorEvents(flowId: WorkflowRunId, options?: { stepId?: WorkflowStepId; kind?: string; limit?: number }): Promise<WorkflowOperatorEvent[]> {
    let sql = "select * from workflow_operator_events where workflow_run_id = ?";
    const params: (string | number)[] = [flowId];
    if (options?.stepId) {
      sql += " and workflow_step_id = ?";
      params.push(options.stepId);
    }
    if (options?.kind) {
      sql += " and kind = ?";
      params.push(options.kind);
    }
    sql += " order by timestamp desc";
    if (options?.limit) {
      sql += " limit ?";
      params.push(options.limit);
    }
    const rows = this.#db.query<WorkflowOperatorEventRow>(sql).all(...params);
    return rows.map(rowToWorkflowOperatorEvent);
  }

  // ─── Linkage ───

  async linkWorkflowArtifact(link: WorkflowArtifactLink): Promise<void> {
    this.#db
      .query("insert into workflow_artifacts (artifact_id, workflow_step_id, workflow_run_id, kind, linked_at) values (?, ?, ?, ?, ?)")
      .run(link.artifactId, link.stepId, link.flowId, link.kind, link.linkedAt);
  }

  async listWorkflowArtifactLinks(flowId: WorkflowRunId, stepId?: WorkflowStepId): Promise<WorkflowArtifactLink[]> {
    let sql = "select * from workflow_artifacts where workflow_run_id = ?";
    const params: (string | number)[] = [flowId];
    if (stepId) {
      sql += " and workflow_step_id = ?";
      params.push(stepId);
    }
    sql += " order by linked_at desc";
    const rows = this.#db.query<WorkflowArtifactRow>(sql).all(...params);
    return rows.map(rowToWorkflowArtifactLink);
  }

  async linkWorkflowAgentRun(link: WorkflowAgentRunLink): Promise<void> {
    this.#db
      .query("insert into workflow_agent_run_links (run_id, workflow_step_id, workflow_run_id, turn_index, linked_at) values (?, ?, ?, ?, ?)")
      .run(link.runId, link.stepId, link.flowId, link.turnIndex, link.linkedAt);
  }

  async listWorkflowAgentRunLinks(flowId: WorkflowRunId, stepId?: WorkflowStepId): Promise<WorkflowAgentRunLink[]> {
    let sql = "select * from workflow_agent_run_links where workflow_run_id = ?";
    const params: (string | number)[] = [flowId];
    if (stepId) {
      sql += " and workflow_step_id = ?";
      params.push(stepId);
    }
    sql += " order by linked_at desc";
    const rows = this.#db.query<WorkflowAgentRunLinkRow>(sql).all(...params);
    return rows.map(rowToWorkflowAgentRunLink);
  }

  // ─── Checkpoints ───

  async createWorkflowCheckpoint(checkpoint: WorkflowCheckpoint): Promise<void> {
    this.#db
      .query("insert into workflow_checkpoints (id, workflow_run_id, workflow_step_id, name, description, snapshot_json, created_at, created_by) values (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        checkpoint.id,
        checkpoint.flowId,
        checkpoint.stepId ?? null,
        checkpoint.name,
        checkpoint.description ?? null,
        JSON.stringify(checkpoint.snapshot),
        checkpoint.createdAt,
        checkpoint.createdBy
      );
  }

  async getWorkflowCheckpoint(id: WorkflowCheckpointId): Promise<WorkflowCheckpoint | null> {
    const row = this.#db.query<WorkflowCheckpointRow>("select * from workflow_checkpoints where id = ?").get(id);
    return row ? rowToWorkflowCheckpoint(row) : null;
  }

  async listWorkflowCheckpoints(flowId: WorkflowRunId): Promise<WorkflowCheckpoint[]> {
    const rows = this.#db.query<WorkflowCheckpointRow>("select * from workflow_checkpoints where workflow_run_id = ? order by created_at desc").all(flowId);
    return rows.map(rowToWorkflowCheckpoint);
  }

  // ─── Approval gates ───

  async createWorkflowApprovalGate(gate: WorkflowApprovalGate): Promise<void> {
    this.#db
      .query(
        `insert into workflow_approval_gates (
          id, workflow_step_id, workflow_run_id, status, requested_at, resolved_at, resolved_by,
          reason, risk_class, tool_name, target_key, target_summary, scope,
          controller_grant_id, tool_executor_decision, deterministic_rule
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        gate.id,
        gate.stepId,
        gate.flowId,
        gate.status,
        gate.requestedAt,
        gate.resolvedAt ?? null,
        gate.resolvedBy ?? null,
        gate.reason,
        gate.riskClass,
        gate.toolName ?? null,
        gate.targetKey ?? null,
        gate.targetSummary ?? null,
        gate.scope ?? null,
        gate.controllerGrantId ?? null,
        gate.toolExecutorDecision,
        gate.deterministicRule ?? null
      );
  }

  async updateWorkflowApprovalGate(gate: WorkflowApprovalGate): Promise<void> {
    this.#db
      .query(
        `update workflow_approval_gates set
          status = ?, resolved_at = ?, resolved_by = ?, reason = ?,
          risk_class = ?, tool_name = ?, target_key = ?, target_summary = ?, scope = ?,
          controller_grant_id = ?, tool_executor_decision = ?, deterministic_rule = ?
        where id = ?`
      )
      .run(
        gate.status,
        gate.resolvedAt ?? null,
        gate.resolvedBy ?? null,
        gate.reason,
        gate.riskClass,
        gate.toolName ?? null,
        gate.targetKey ?? null,
        gate.targetSummary ?? null,
        gate.scope ?? null,
        gate.controllerGrantId ?? null,
        gate.toolExecutorDecision,
        gate.deterministicRule ?? null,
        gate.id
      );
  }

  async getWorkflowApprovalGate(id: string): Promise<WorkflowApprovalGate | null> {
    const row =
      this.#profileId === undefined
        ? this.#db.query<WorkflowApprovalGateRow>("select * from workflow_approval_gates where id = ?").get(id)
        : this.#db
            .query<WorkflowApprovalGateRow>(
              `select ag.*
               from workflow_approval_gates ag
               join workflow_runs f on f.id = ag.workflow_run_id
               join sessions s on s.id = f.session_id
               where ag.id = ? and s.profile_id = ?`
            )
            .get(id, this.#profileId);
    return row ? rowToWorkflowApprovalGate(row) : null;
  }

  async listWorkflowApprovalGates(flowId: WorkflowRunId, options?: { stepId?: WorkflowStepId; status?: string }): Promise<WorkflowApprovalGate[]> {
    let sql = "select * from workflow_approval_gates where workflow_run_id = ?";
    const params: (string | number)[] = [flowId];
    if (options?.stepId) {
      sql += " and workflow_step_id = ?";
      params.push(options.stepId);
    }
    if (options?.status) {
      sql += " and status = ?";
      params.push(options.status);
    }
    sql += " order by requested_at desc";
    const rows = this.#db.query<WorkflowApprovalGateRow>(sql).all(...params);
    return rows.map(rowToWorkflowApprovalGate);
  }

  // ─── Locks ───

  async acquireLock(flowId: WorkflowRunId, ownerId: string, leaseMs: number): Promise<boolean> {
    const now = this.#now().toISOString();
    const expires = new Date(this.#now().getTime() + leaseMs).toISOString();

    // Try insert first (no existing lock)
    try {
      this.#db
        .query("insert into workflow_locks (workflow_run_id, owner_id, locked_at, heartbeat_at, expires_at) values (?, ?, ?, ?, ?)")
        .run(flowId, ownerId, now, now, expires);
      return true;
    } catch {
      // Lock exists; try to take it if expired
      const existing = this.#db.query<WorkflowLockRow>("select * from workflow_locks where workflow_run_id = ?").get(flowId);
      if (existing && existing.expires_at < now) {
        this.#db
          .query("update workflow_locks set owner_id = ?, locked_at = ?, heartbeat_at = ?, expires_at = ? where workflow_run_id = ?")
          .run(ownerId, now, now, expires, flowId);
        return true;
      }
      return false;
    }
  }

  async releaseLock(flowId: WorkflowRunId, ownerId: string): Promise<void> {
    this.#db.query("delete from workflow_locks where workflow_run_id = ? and owner_id = ?").run(flowId, ownerId);
  }

  async heartbeatLock(flowId: WorkflowRunId, ownerId: string, leaseMs: number): Promise<void> {
    const now = this.#now().toISOString();
    const expires = new Date(this.#now().getTime() + leaseMs).toISOString();
    this.#db
      .query("update workflow_locks set heartbeat_at = ?, expires_at = ? where workflow_run_id = ? and owner_id = ?")
      .run(now, expires, flowId, ownerId);
  }

  async getLock(flowId: WorkflowRunId): Promise<WorkflowLock | null> {
    const row = this.#db.query<WorkflowLockRow>("select * from workflow_locks where workflow_run_id = ?").get(flowId);
    return row ? rowToWorkflowLock(row) : null;
  }

  async recoverStaleLocks(before: string): Promise<number> {
    const result = this.#db.query<{ workflow_run_id: string }>("delete from workflow_locks where expires_at < ? returning workflow_run_id").all(before);
    return result.length;
  }

  // ─── Process registry ───

  async registerWorkflowProcess(process: WorkflowProcess): Promise<void> {
    this.#db
      .query(
        `insert into workflow_processes (id, workflow_run_id, workflow_step_id, process_manager_id, process_type, command_summary, started_at, expected_exit_at, status)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        process.id,
        process.flowId,
        process.stepId,
        process.processManagerId,
        process.processType,
        process.commandSummary ?? null,
        process.startedAt,
        process.expectedExitAt ?? null,
        process.status
      );
  }

  async updateWorkflowProcess(process: WorkflowProcess): Promise<void> {
    this.#db
      .query("update workflow_processes set status = ? where id = ?")
      .run(process.status, process.id);
  }

  async getWorkflowProcess(id: string): Promise<WorkflowProcess | null> {
    const row = this.#db.query<WorkflowProcessRow>("select * from workflow_processes where id = ?").get(id);
    return row ? rowToWorkflowProcess(row) : null;
  }

  async listWorkflowProcesses(flowId: WorkflowRunId, stepId?: WorkflowStepId): Promise<WorkflowProcess[]> {
    let sql = "select * from workflow_processes where workflow_run_id = ?";
    const params: (string | number)[] = [flowId];
    if (stepId) {
      sql += " and workflow_step_id = ?";
      params.push(stepId);
    }
    sql += " order by started_at desc";
    const rows = this.#db.query<WorkflowProcessRow>(sql).all(...params);
    return rows.map(rowToWorkflowProcess);
  }

  // ─── Compact summaries ───

  async saveWorkflowEventSummary(summary: WorkflowEventSummary): Promise<void> {
    this.#db
      .query(
        `insert into workflow_event_summaries (
          id, workflow_run_id, from_workflow_event_id, to_workflow_event_id,
          turn_summaries_json, tool_outcome_summaries_json, operator_action_summaries_json, created_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        summary.id,
        summary.flowId,
        summary.compactedRange.fromEventId,
        summary.compactedRange.toEventId,
        JSON.stringify(summary.turnSummaries),
        JSON.stringify(summary.toolOutcomeSummaries),
        JSON.stringify(summary.operatorActionSummaries),
        summary.createdAt
      );
  }

  async listWorkflowEventSummaries(flowId: WorkflowRunId): Promise<WorkflowEventSummary[]> {
    const rows = this.#db
      .query<WorkflowEventSummaryRow>("select * from workflow_event_summaries where workflow_run_id = ? order by created_at desc")
      .all(flowId);
    return rows.map(rowToWorkflowEventSummary);
  }

  // ─── Steer consumption ───

  async listUnconsumedSteerEvents(flowId: WorkflowRunId): Promise<WorkflowOperatorEvent[]> {
    const rows = this.#db
      .query<WorkflowOperatorEventRow>(
        `select * from workflow_operator_events
         where workflow_run_id = ? and kind = 'operator-steered' and consumed_at is null
         order by timestamp asc`
      )
      .all(flowId);
    return rows.map(rowToWorkflowOperatorEvent);
  }

  async markSteerConsumed(
    eventId: string,
    consumption: { consumedByStepId?: WorkflowStepId; consumedByRunId?: RunId; consumedByFlowEventId?: EventId }
  ): Promise<void> {
    this.#db
      .query(
        `update workflow_operator_events set
          consumed_at = ?,
          consumed_by_workflow_step_id = ?,
          consumed_by_run_id = ?,
          consumed_by_workflow_event_id = ?
        where id = ?`
      )
      .run(
        this.#now().toISOString(),
        consumption.consumedByStepId ?? null,
        consumption.consumedByRunId ?? null,
        consumption.consumedByFlowEventId ?? null,
        eventId
      );
  }

  // ─── Atomic transition ───

  async atomicTransition<T>(
    _flowId: WorkflowRunId,
    work: (tx: WorkflowStore) => Promise<T>
  ): Promise<T> {
    this.#db.exec("begin transaction");
    try {
      const txStore = new SQLiteWorkflowStore({
        db: this.#db,
        profileId: this.#profileId,
        now: this.#now,
        id: this.#id
      });
      const result = await work(txStore);
      this.#db.exec("commit");
      return result;
    } catch (error) {
      this.#db.exec("rollback");
      throw error;
    }
  }

  #assertSessionInProfile(sessionId: string): void {
    if (this.#profileId === undefined) {
      return;
    }

    const row = this.#db.query<{ id: string }>("select id from sessions where id = ? and profile_id = ?").get(sessionId, this.#profileId);
    if (row === null) {
      throw new Error(`Session ${sessionId} does not belong to profile ${this.#profileId}.`);
    }
  }

  #assertFlowInProfile(flowId: WorkflowRunId): void {
    if (this.#profileId === undefined) {
      return;
    }

    const row = this.#db
      .query<{ id: string }>(
        `select f.id
         from workflow_runs f
         join sessions s on s.id = f.session_id
         where f.id = ? and s.profile_id = ?`
      )
      .get(flowId, this.#profileId);
    if (row === null) {
      throw new Error(`WorkflowRun ${flowId} does not belong to profile ${this.#profileId}.`);
    }
  }
}

// ─── Row types ───

type WorkflowRunRow = {
  id: string;
  session_id: string;
  status: string;
  intent_json: string;
  selected_skill: string | null;
  current_workflow_step_id: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  cancelled_at: string | null;
  failed_at: string | null;
  pause_requested_at: string | null;
  pause_reason: string | null;
  interrupt_reason: string | null;
  cancel_reason: string | null;
  wait_reason_json: string | null;
  operator_summary: string | null;
  compacted_at: string | null;
  checkpoint_count: number;
  step_count: number;
  retry_count: number;
  metadata_json: string | null;
};

type WorkflowStepRow = {
  id: string;
  workflow_run_id: string;
  step_index: number;
  status: string;
  name: string;
  description: string;
  tool_plans_json: string | null;
  executions_json: string | null;
  retry_policy_json: string;
  retry_count: number;
  max_retries: number;
  idempotent: number;
  safe_to_retry: number;
  failure_policy_json: string;
  wait_reason_json: string | null;
  pause_reason: string | null;
  interrupt_reason: string | null;
  skip_reason: string | null;
  retry_of_workflow_step_id: string | null;
  attempt_number: number;
  started_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
  cancelled_at: string | null;
  paused_at: string | null;
  resumed_at: string | null;
  wait_started_at: string | null;
  wait_ended_at: string | null;
  created_at: string;
  updated_at: string;
};

type WorkflowEventRow = {
  id: string;
  workflow_run_id: string;
  workflow_step_id: string | null;
  kind: string;
  data_json: string;
  timestamp: string;
};

type WorkflowOperatorEventRow = {
  id: string;
  workflow_run_id: string;
  workflow_step_id: string | null;
  kind: string;
  operator: string;
  command: string;
  effect: string;
  previous_state: string;
  new_state: string;
  metadata_json: string | null;
  timestamp: string;
  consumed_at: string | null;
  consumed_by_workflow_step_id: string | null;
  consumed_by_run_id: string | null;
  consumed_by_workflow_event_id: string | null;
};

type WorkflowCheckpointRow = {
  id: string;
  workflow_run_id: string;
  workflow_step_id: string | null;
  name: string;
  description: string | null;
  snapshot_json: string;
  created_at: string;
  created_by: string;
};

type WorkflowApprovalGateRow = {
  id: string;
  workflow_step_id: string;
  workflow_run_id: string;
  status: string;
  requested_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  reason: string;
  risk_class: string;
  tool_name: string | null;
  target_key: string | null;
  target_summary: string | null;
  scope: string | null;
  controller_grant_id: string | null;
  tool_executor_decision: string;
  deterministic_rule: string | null;
};

type WorkflowLockRow = {
  workflow_run_id: string;
  owner_id: string;
  locked_at: string;
  heartbeat_at: string;
  expires_at: string;
};

type WorkflowProcessRow = {
  id: string;
  workflow_run_id: string;
  workflow_step_id: string;
  process_manager_id: string;
  process_type: string;
  command_summary: string | null;
  started_at: string;
  expected_exit_at: string | null;
  status: string;
};

type WorkflowArtifactRow = {
  artifact_id: string;
  workflow_step_id: string;
  workflow_run_id: string;
  kind: string;
  linked_at: string;
};

type WorkflowAgentRunLinkRow = {
  run_id: string;
  workflow_step_id: string;
  workflow_run_id: string;
  turn_index: number;
  linked_at: string;
};

type WorkflowEventSummaryRow = {
  id: string;
  workflow_run_id: string;
  from_workflow_event_id: string;
  to_workflow_event_id: string;
  turn_summaries_json: string;
  tool_outcome_summaries_json: string;
  operator_action_summaries_json: string;
  created_at: string;
};

// ─── Row mappers ───

function rowToWorkflowRun(row: WorkflowRunRow): WorkflowRun {
  return {
    id: row.id,
    sessionId: row.session_id,
    status: row.status as WorkflowRun["status"],
    intent: JSON.parse(row.intent_json) as IntentRoute,
    selectedSkill: row.selected_skill ?? undefined,
    currentStepId: row.current_workflow_step_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
    cancelledAt: row.cancelled_at ?? undefined,
    failedAt: row.failed_at ?? undefined,
    pauseRequestedAt: row.pause_requested_at ?? undefined,
    pauseReason: row.pause_reason ?? undefined,
    interruptReason: row.interrupt_reason ?? undefined,
    cancelReason: row.cancel_reason ?? undefined,
    waitReason: row.wait_reason_json ? JSON.parse(row.wait_reason_json) as WorkflowRun["waitReason"] : undefined,
    operatorSummary: row.operator_summary ?? undefined,
    compactedAt: row.compacted_at ?? undefined,
    checkpointCount: row.checkpoint_count,
    stepCount: row.step_count,
    retryCount: row.retry_count,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) as WorkflowRun["metadata"] : {}
  };
}

function rowToWorkflowStep(row: WorkflowStepRow): WorkflowStep {
  return {
    id: row.id,
    flowId: row.workflow_run_id,
    index: row.step_index,
    status: row.status as WorkflowStep["status"],
    name: row.name,
    description: row.description,
    toolPlans: row.tool_plans_json ? JSON.parse(row.tool_plans_json) as ToolCallPlan[] : [],
    executions: row.executions_json ? JSON.parse(row.executions_json) as ToolCallPlan[] : [],
    retryPolicy: JSON.parse(row.retry_policy_json) as WorkflowStep["retryPolicy"],
    retryCount: row.retry_count,
    maxRetries: row.max_retries,
    idempotent: row.idempotent === 1,
    safeToRetry: row.safe_to_retry === 1,
    failurePolicy: JSON.parse(row.failure_policy_json) as WorkflowStep["failurePolicy"],
    waitReason: row.wait_reason_json ? JSON.parse(row.wait_reason_json) as WorkflowStep["waitReason"] : undefined,
    pauseReason: row.pause_reason ?? undefined,
    interruptReason: row.interrupt_reason ?? undefined,
    skipReason: row.skip_reason ?? undefined,
    retryOfStepId: row.retry_of_workflow_step_id ?? undefined,
    attemptNumber: row.attempt_number,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    failedAt: row.failed_at ?? undefined,
    cancelledAt: row.cancelled_at ?? undefined,
    pausedAt: row.paused_at ?? undefined,
    resumedAt: row.resumed_at ?? undefined,
    waitStartedAt: row.wait_started_at ?? undefined,
    waitEndedAt: row.wait_ended_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowToWorkflowEvent(row: WorkflowEventRow): WorkflowEvent {
  return {
    id: row.id,
    flowId: row.workflow_run_id,
    stepId: row.workflow_step_id ?? undefined,
    kind: row.kind as WorkflowEvent["kind"],
    data: JSON.parse(row.data_json) as Record<string, unknown>,
    timestamp: row.timestamp
  };
}

function rowToWorkflowOperatorEvent(row: WorkflowOperatorEventRow): WorkflowOperatorEvent {
  return {
    id: row.id,
    flowId: row.workflow_run_id,
    stepId: row.workflow_step_id ?? undefined,
    kind: row.kind as WorkflowOperatorEvent["kind"],
    operator: row.operator,
    command: row.command,
    effect: row.effect,
    previousState: row.previous_state as WorkflowRun["status"] | WorkflowStep["status"],
    newState: row.new_state as WorkflowRun["status"] | WorkflowStep["status"],
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) as Record<string, unknown> : undefined,
    timestamp: row.timestamp,
    consumedAt: row.consumed_at ?? undefined,
    consumedByStepId: row.consumed_by_workflow_step_id ?? undefined,
    consumedByRunId: row.consumed_by_run_id ?? undefined,
    consumedByFlowEventId: row.consumed_by_workflow_event_id ?? undefined
  };
}

function rowToWorkflowCheckpoint(row: WorkflowCheckpointRow): WorkflowCheckpoint {
  return {
    id: row.id,
    flowId: row.workflow_run_id,
    stepId: row.workflow_step_id ?? undefined,
    name: row.name,
    description: row.description ?? undefined,
    snapshot: JSON.parse(row.snapshot_json) as WorkflowCheckpoint["snapshot"],
    createdAt: row.created_at,
    createdBy: row.created_by
  };
}

function rowToWorkflowApprovalGate(row: WorkflowApprovalGateRow): WorkflowApprovalGate {
  return {
    id: row.id,
    stepId: row.workflow_step_id,
    flowId: row.workflow_run_id,
    status: row.status as WorkflowApprovalGate["status"],
    requestedAt: row.requested_at,
    resolvedAt: row.resolved_at ?? undefined,
    resolvedBy: row.resolved_by ?? undefined,
    reason: row.reason,
    riskClass: row.risk_class as WorkflowApprovalGate["riskClass"],
    toolName: row.tool_name ?? undefined,
    targetKey: row.target_key ?? undefined,
    targetSummary: row.target_summary ?? undefined,
    scope: row.scope ?? undefined,
    controllerGrantId: row.controller_grant_id ?? undefined,
    toolExecutorDecision: row.tool_executor_decision as WorkflowApprovalGate["toolExecutorDecision"],
    deterministicRule: row.deterministic_rule ?? undefined
  };
}

function rowToWorkflowLock(row: WorkflowLockRow): WorkflowLock {
  return {
    flowId: row.workflow_run_id,
    ownerId: row.owner_id,
    lockedAt: row.locked_at,
    heartbeatAt: row.heartbeat_at,
    expiresAt: row.expires_at
  };
}

function rowToWorkflowProcess(row: WorkflowProcessRow): WorkflowProcess {
  return {
    id: row.id,
    flowId: row.workflow_run_id,
    stepId: row.workflow_step_id,
    processManagerId: row.process_manager_id,
    processType: row.process_type as WorkflowProcess["processType"],
    commandSummary: row.command_summary ?? undefined,
    startedAt: row.started_at,
    expectedExitAt: row.expected_exit_at ?? undefined,
    status: row.status as WorkflowProcess["status"]
  };
}

function rowToWorkflowArtifactLink(row: WorkflowArtifactRow): WorkflowArtifactLink {
  return {
    artifactId: row.artifact_id,
    stepId: row.workflow_step_id,
    flowId: row.workflow_run_id,
    kind: row.kind as WorkflowArtifactLink["kind"],
    linkedAt: row.linked_at
  };
}

function rowToWorkflowAgentRunLink(row: WorkflowAgentRunLinkRow): WorkflowAgentRunLink {
  return {
    runId: row.run_id,
    stepId: row.workflow_step_id,
    flowId: row.workflow_run_id,
    turnIndex: row.turn_index,
    linkedAt: row.linked_at
  };
}

function rowToWorkflowEventSummary(row: WorkflowEventSummaryRow): WorkflowEventSummary {
  return {
    id: row.id,
    flowId: row.workflow_run_id,
    compactedRange: { fromEventId: row.from_workflow_event_id, toEventId: row.to_workflow_event_id },
    turnSummaries: JSON.parse(row.turn_summaries_json) as string[],
    toolOutcomeSummaries: JSON.parse(row.tool_outcome_summaries_json) as string[],
    operatorActionSummaries: JSON.parse(row.operator_action_summaries_json) as string[],
    createdAt: row.created_at
  };
}
