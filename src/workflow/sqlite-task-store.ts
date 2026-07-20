import type {
  Task,
  TaskAttempt,
  TaskAttemptLease,
  TaskEvent,
  TaskPlanRevision,
  TaskResult,
  TaskSessionLink,
  TaskStep
} from "../contracts/task.js";
import {
  TASK_GRAPH_LIMITS,
  assertTaskAttemptTransition,
  assertTaskPlanRevisionTransition,
  assertTaskStepTransition,
  assertTaskTransition,
  isTerminalTaskAttemptStatus,
  isTerminalTaskPlanRevisionStatus,
  isTerminalTaskStatus,
  isTerminalTaskStepStatus,
  validateTaskPlan
} from "../contracts/task.js";
import type { SQLiteDatabase, SQLiteValue } from "../storage/sqlite.js";
import type {
  AcquireTaskAttemptLeaseInput,
  CreateTaskGraphInput,
  ListTaskEventsOptions,
  ListTasksOptions,
  ReleaseTaskAttemptLeaseInput,
  RenewTaskAttemptLeaseInput,
  TaskStore
} from "./task-store.js";

export type SQLiteTaskStoreOptions = {
  db: SQLiteDatabase;
  profileId: string;
};

export class TaskStoreProfileError extends Error {
  constructor(public readonly profileId: string, message: string) {
    super(message);
    this.name = "TaskStoreProfileError";
  }
}

export class TaskStoreIntegrityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TaskStoreIntegrityError";
  }
}

export class SQLiteTaskStore implements TaskStore {
  readonly #db: SQLiteDatabase;
  readonly #profileId: string;
  #transactional = false;
  #transactionState: { active: boolean } | undefined = undefined;

  constructor(options: SQLiteTaskStoreOptions) {
    const profileId = options.profileId.trim();
    if (profileId.length === 0) {
      throw new TaskStoreProfileError(options.profileId, "TaskStore requires a non-empty profile ID.");
    }
    this.#db = options.db;
    this.#profileId = profileId;
    this.#db.exec("pragma foreign_keys = on");
  }

  get profileId(): string {
    return this.#profileId;
  }

  createTaskGraph(input: CreateTaskGraphInput): void {
    this.#assertProfile(input.task.profileId, "Task", input.task.id);
    const validation = validateTaskPlan(input);
    if (!validation.ok) {
      throw new TaskStoreIntegrityError(
        `Task graph is invalid: ${validation.issues.map((issue) => issue.code).join(", ")}`
      );
    }
    if (input.task.activePlanRevisionId !== undefined && input.task.activePlanRevisionId !== input.revision.id) {
      throw new TaskStoreIntegrityError("A newly persisted Task graph can only activate its supplied PlanRevision.");
    }
    if ((input.task.activePlanRevisionId === input.revision.id) !== (input.revision.status === "active")) {
      throw new TaskStoreIntegrityError("Task.activePlanRevisionId and the active PlanRevision status must agree.");
    }

    this.atomicWrite((store) => {
      store.createTask(input.task);
      this.#insertPlanRevisionRecord(input.revision);
      for (const step of input.steps) {
        this.#insertStepRecord(step);
      }
      for (const step of input.steps) {
        this.#replaceDependencies(step);
      }
      if (input.task.creatorSessionId !== undefined) {
        store.linkSession({
          taskId: input.task.id,
          profileId: this.#profileId,
          sessionId: input.task.creatorSessionId,
          relationship: "creator",
          createdAt: input.task.createdAt
        });
      }
    });
  }

  createPlanRevisionGraph(revision: TaskPlanRevision, steps: readonly TaskStep[]): void {
    this.#assertTransactionActive();
    this.#assertProfile(revision.profileId, "PlanRevision", revision.id);
    const task = this.getTask(revision.taskId);
    if (task === null) {
      throw new TaskStoreProfileError(
        this.#profileId,
        `Task ${revision.taskId} is not accessible in profile ${this.#profileId}.`
      );
    }
    if (revision.status === "active") {
      throw new TaskStoreIntegrityError("A new PlanRevision graph must be persisted before it is activated.");
    }
    const validation = validateTaskPlan({ task, revision, steps });
    if (!validation.ok) {
      throw new TaskStoreIntegrityError(
        `Task graph is invalid: ${validation.issues.map((issue) => issue.code).join(", ")}`
      );
    }
    this.atomicWrite(() => {
      this.#insertPlanRevisionRecord(revision);
      for (const step of steps) this.#insertStepRecord(step);
      for (const step of steps) this.#replaceDependencies(step);
    });
  }

  createTask(task: Task): void {
    this.#assertTransactionActive();
    this.#assertProfile(task.profileId, "Task", task.id);
    if (task.creatorSessionId !== undefined) this.#assertSessionOwned(task.creatorSessionId);
    if (task.parentTaskId !== undefined) this.#assertTaskOwned(task.parentTaskId);
    if (task.parentAttemptId !== undefined) {
      if (task.parentTaskId === undefined) {
        throw new TaskStoreIntegrityError("A parent Attempt requires a parent Task.");
      }
      this.#assertAttemptOwned(task.parentAttemptId, task.parentTaskId);
    }

    this.#db.query(
      `insert into tasks (
        id, profile_id, creator_session_id, parent_task_id, parent_attempt_id,
        source, creation_key, objective, status, workspace_path, workspace_identity_hash,
        authority_policy_json, budget_policy_json, active_plan_revision_id,
        wait_reason_json, failure_json, created_by_json,
        created_at, updated_at, started_at, completed_at, cancelled_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(...taskValues(task));
  }

  updateTask(task: Task): void {
    this.#assertTransactionActive();
    this.#assertProfile(task.profileId, "Task", task.id);
    this.#assertTaskOwned(task.id);
    const existing = this.getTask(task.id)!;
    if (existing.status !== task.status) assertTaskTransition(existing.status, task.status);
    if (isTerminalTaskStatus(existing.status)) assertUnchanged("Terminal Task", existing, task);
    assertUnchanged("Task creation fields", {
      creatorSessionId: existing.creatorSessionId,
      parentTaskId: existing.parentTaskId,
      parentAttemptId: existing.parentAttemptId,
      source: existing.source,
      creationKey: existing.creationKey,
      objective: existing.objective,
      workspace: existing.workspace,
      createdBy: existing.createdBy,
      createdAt: existing.createdAt
    }, {
      creatorSessionId: task.creatorSessionId,
      parentTaskId: task.parentTaskId,
      parentAttemptId: task.parentAttemptId,
      source: task.source,
      creationKey: task.creationKey,
      objective: task.objective,
      workspace: task.workspace,
      createdBy: task.createdBy,
      createdAt: task.createdAt
    });
    if (task.creatorSessionId !== undefined) this.#assertSessionOwned(task.creatorSessionId);
    if (task.parentTaskId !== undefined) this.#assertTaskOwned(task.parentTaskId);

    const result = this.#db.query(
      `update tasks set
        creator_session_id = ?, parent_task_id = ?, parent_attempt_id = ?, source = ?,
        creation_key = ?, objective = ?, status = ?, workspace_path = ?, workspace_identity_hash = ?,
        authority_policy_json = ?, budget_policy_json = ?, active_plan_revision_id = ?,
        wait_reason_json = ?, failure_json = ?, created_by_json = ?, created_at = ?,
        updated_at = ?, started_at = ?, completed_at = ?, cancelled_at = ?
       where id = ? and profile_id = ?`
    ).run(...taskValues(task).slice(2), task.id, this.#profileId);
    this.#assertChanged(result.changes, "Task", task.id);
  }

  getTask(id: string): Task | null {
    const row = this.#db.query<TaskRow>("select * from tasks where id = ? and profile_id = ?").get(id, this.#profileId);
    return row === null ? null : rowToTask(row);
  }

  listTasks(options: ListTasksOptions = {}): Task[] {
    const statuses = [...(options.statuses ?? [])];
    const limit = boundedLimit(options.limit);
    let sql = "select * from tasks where profile_id = ?";
    const params: SQLiteValue[] = [this.#profileId];
    if (statuses.length > 0) {
      sql += ` and status in (${statuses.map(() => "?").join(", ")})`;
      params.push(...statuses);
    }
    sql += " order by updated_at desc, id limit ?";
    params.push(limit);
    return this.#db.query<TaskRow>(sql).all(...params).map(rowToTask);
  }

  #insertPlanRevisionRecord(revision: TaskPlanRevision): void {
    this.#assertProfile(revision.profileId, "PlanRevision", revision.id);
    this.#assertTaskOwned(revision.taskId);
    this.#db.query(
      `insert into task_plan_revisions (
        id, profile_id, task_id, revision, status, reason, created_by_json,
        created_at, validated_at, activated_at, superseded_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(...planRevisionValues(revision));
  }

  updatePlanRevision(revision: TaskPlanRevision): void {
    this.#assertTransactionActive();
    this.#assertProfile(revision.profileId, "PlanRevision", revision.id);
    this.#assertTaskOwned(revision.taskId);
    const existing = this.getPlanRevision(revision.id);
    if (existing === null) throw new TaskStoreIntegrityError(`PlanRevision ${revision.id} was not found.`);
    if (existing.status !== revision.status) {
      assertTaskPlanRevisionTransition(existing.status, revision.status);
    }
    if (isTerminalTaskPlanRevisionStatus(existing.status)) {
      assertUnchanged("Terminal PlanRevision", existing, revision);
    }
    assertUnchanged("PlanRevision definition", {
      taskId: existing.taskId,
      revision: existing.revision,
      reason: existing.reason,
      createdBy: existing.createdBy,
      createdAt: existing.createdAt
    }, {
      taskId: revision.taskId,
      revision: revision.revision,
      reason: revision.reason,
      createdBy: revision.createdBy,
      createdAt: revision.createdAt
    });
    const result = this.#db.query(
      `update task_plan_revisions set revision = ?, status = ?, reason = ?, created_by_json = ?,
        created_at = ?, validated_at = ?, activated_at = ?, superseded_at = ?
       where id = ? and profile_id = ? and task_id = ?`
    ).run(
      revision.revision,
      revision.status,
      revision.reason,
      stringify(revision.createdBy),
      revision.createdAt,
      revision.validatedAt ?? null,
      revision.activatedAt ?? null,
      revision.supersededAt ?? null,
      revision.id,
      this.#profileId,
      revision.taskId
    );
    this.#assertChanged(result.changes, "PlanRevision", revision.id);
  }

  getPlanRevision(id: string): TaskPlanRevision | null {
    const row = this.#db.query<PlanRevisionRow>(
      "select * from task_plan_revisions where id = ? and profile_id = ?"
    ).get(id, this.#profileId);
    return row === null ? null : rowToPlanRevision(row);
  }

  listPlanRevisions(taskId: string): TaskPlanRevision[] {
    if (this.getTask(taskId) === null) return [];
    return this.#db.query<PlanRevisionRow>(
      `select * from task_plan_revisions
       where profile_id = ? and task_id = ? order by revision desc`
    ).all(this.#profileId, taskId).map(rowToPlanRevision);
  }

  updateStep(step: TaskStep): void {
    this.#assertTransactionActive();
    this.#assertStepInput(step);
    const existing = this.getStep(step.id);
    if (existing === null) throw new TaskStoreIntegrityError(`Step ${step.id} was not found.`);
    if (existing.status !== step.status) assertTaskStepTransition(existing.status, step.status);
    if (isTerminalTaskStepStatus(existing.status)) assertUnchanged("Terminal Step", existing, step);
    assertUnchanged("Step definition", immutableStepFields(existing), immutableStepFields(step));
    this.atomicWrite(() => {
      const result = this.#db.query(
        `update task_steps set step_key = ?, position = ?, status = ?, title = ?, objective = ?,
          executor_json = ?, authority_policy_json = ?, budget_json = ?, retry_policy_json = ?,
          failure_policy_json = ?, idempotency = ?, result_policy_json = ?, created_at = ?, updated_at = ?
         where id = ? and profile_id = ? and task_id = ? and plan_revision_id = ?`
      ).run(
        step.key,
        step.position,
        step.status,
        step.title,
        step.objective,
        stringify(step.executor),
        stringify(step.authorityPolicy),
        stringify(step.budget),
        stringify(step.retryPolicy),
        stringify(step.failurePolicy),
        step.idempotency,
        stringify(step.resultPolicy),
        step.createdAt,
        step.updatedAt,
        step.id,
        this.#profileId,
        step.taskId,
        step.planRevisionId
      );
      this.#assertChanged(result.changes, "Step", step.id);
      this.#replaceDependencies(step);
    });
  }

  getStep(id: string): TaskStep | null {
    const row = this.#db.query<StepRow>("select * from task_steps where id = ? and profile_id = ?").get(id, this.#profileId);
    return row === null ? null : this.#rowToStep(row);
  }

  listSteps(taskId: string, planRevisionId: string): TaskStep[] {
    if (this.getTask(taskId) === null) return [];
    return this.#db.query<StepRow>(
      `select * from task_steps where profile_id = ? and task_id = ? and plan_revision_id = ?
       order by position, id`
    ).all(this.#profileId, taskId, planRevisionId).map((row) => this.#rowToStep(row));
  }

  createAttempt(attempt: TaskAttempt): void {
    this.#assertTransactionActive();
    this.#assertAttemptInput(attempt);
    this.atomicWrite(() => {
      this.#db.query(
        `insert into task_attempts (
          id, profile_id, task_id, plan_revision_id, step_id, attempt_number, status,
          dispatch_key, worker_session_id, trajectory_id, usage_json, failure_json,
          created_at, updated_at, started_at, completed_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(...attemptValues(attempt));
      if (attempt.lease !== undefined) this.#insertLease(attempt.lease);
    });
  }

  updateAttempt(attempt: TaskAttempt): void {
    this.#assertTransactionActive();
    this.#assertAttemptInput(attempt);
    const existing = this.getAttempt(attempt.id);
    if (existing === null) throw new TaskStoreIntegrityError(`Attempt ${attempt.id} was not found.`);
    if (existing.status !== attempt.status) assertTaskAttemptTransition(existing.status, attempt.status);
    if (isTerminalTaskAttemptStatus(existing.status)) assertUnchanged("Terminal Attempt", existing, attempt);
    assertUnchanged("Attempt identity", {
      attemptNumber: existing.attemptNumber,
      dispatchKey: existing.dispatchKey,
      createdAt: existing.createdAt
    }, {
      attemptNumber: attempt.attemptNumber,
      dispatchKey: attempt.dispatchKey,
      createdAt: attempt.createdAt
    });
    const result = this.#db.query(
      `update task_attempts set attempt_number = ?, status = ?, dispatch_key = ?,
        worker_session_id = ?, trajectory_id = ?, usage_json = ?, failure_json = ?,
        created_at = ?, updated_at = ?, started_at = ?, completed_at = ?
       where id = ? and profile_id = ? and task_id = ? and plan_revision_id = ? and step_id = ?`
    ).run(
      attempt.attemptNumber,
      attempt.status,
      attempt.dispatchKey,
      attempt.workerSessionId ?? null,
      attempt.trajectoryId ?? null,
      stringify(attempt.usage),
      optionalJson(attempt.failure),
      attempt.createdAt,
      attempt.updatedAt,
      attempt.startedAt ?? null,
      attempt.completedAt ?? null,
      attempt.id,
      this.#profileId,
      attempt.taskId,
      attempt.planRevisionId,
      attempt.stepId
    );
    this.#assertChanged(result.changes, "Attempt", attempt.id);
  }

  getAttempt(id: string): TaskAttempt | null {
    const row = this.#db.query<AttemptWithLeaseRow>(ATTEMPT_SELECT + " where a.id = ? and a.profile_id = ?")
      .get(id, this.#profileId);
    return row === null ? null : this.#rowToAttempt(row);
  }

  listAttempts(taskId: string, stepId?: string): TaskAttempt[] {
    if (this.getTask(taskId) === null) return [];
    const sql = ATTEMPT_SELECT +
      " where a.profile_id = ? and a.task_id = ?" +
      (stepId === undefined ? "" : " and a.step_id = ?") +
      " order by a.created_at, a.attempt_number";
    const rows = stepId === undefined
      ? this.#db.query<AttemptWithLeaseRow>(sql).all(this.#profileId, taskId)
      : this.#db.query<AttemptWithLeaseRow>(sql).all(this.#profileId, taskId, stepId);
    return rows.map((row) => this.#rowToAttempt(row));
  }

  acquireAttemptLease(input: AcquireTaskAttemptLeaseInput): TaskAttemptLease | null {
    const ownerId = requireNonEmpty(input.ownerId, "Attempt lease owner ID");
    assertLeaseWindow(input.acquiredAt, input.expiresAt, "Attempt lease acquisition");
    return this.atomicWrite(() => {
      const attempt = this.getAttempt(input.attemptId);
      if (attempt === null) throw new TaskStoreIntegrityError(`Attempt ${input.attemptId} was not found.`);
      if (attempt.status === "leased" && attempt.lease?.ownerId === ownerId) return attempt.lease;
      if (attempt.status !== "queued" || attempt.lease !== undefined) return null;

      const lease: TaskAttemptLease = {
        attemptId: attempt.id,
        profileId: this.#profileId,
        taskId: attempt.taskId,
        ownerId,
        fencingToken: 1,
        acquiredAt: input.acquiredAt,
        heartbeatAt: input.acquiredAt,
        expiresAt: input.expiresAt
      };
      this.#insertLease(lease);
      const update = this.#db.query(
        `update task_attempts set status = 'leased', updated_at = ?
         where id = ? and profile_id = ? and status = 'queued'`
      ).run(input.acquiredAt, attempt.id, this.#profileId);
      this.#assertChanged(update.changes, "Attempt", attempt.id);
      return lease;
    });
  }

  renewAttemptLease(input: RenewTaskAttemptLeaseInput): TaskAttemptLease | null {
    assertLeaseWindow(input.heartbeatAt, input.expiresAt, "Attempt lease renewal");
    return this.atomicWrite(() => {
      const attempt = this.getAttempt(input.attemptId);
      const lease = attempt?.lease;
      if (
        attempt === null ||
        lease === undefined ||
        lease.ownerId !== input.ownerId ||
        lease.fencingToken !== input.fencingToken ||
        Date.parse(lease.expiresAt) <= Date.parse(input.heartbeatAt)
      ) {
        return null;
      }
      if (lease.cancellationRequestedAt !== undefined) return lease;

      const update = this.#db.query(
        `update task_attempt_leases set heartbeat_at = ?, expires_at = ?
         where attempt_id = ? and profile_id = ? and owner_id = ? and fencing_token = ?`
      ).run(
        input.heartbeatAt,
        input.expiresAt,
        input.attemptId,
        this.#profileId,
        input.ownerId,
        input.fencingToken
      );
      this.#assertChanged(update.changes, "AttemptLease", input.attemptId);
      return { ...lease, heartbeatAt: input.heartbeatAt, expiresAt: input.expiresAt };
    });
  }

  requestAttemptCancellation(attemptId: string, requestedAt: string): TaskAttemptLease | null {
    assertTimestamp(requestedAt, "Attempt cancellation request");
    return this.atomicWrite(() => {
      const attempt = this.getAttempt(attemptId);
      if (attempt === null) throw new TaskStoreIntegrityError(`Attempt ${attemptId} was not found.`);
      if (attempt.lease === undefined) return null;
      this.#db.query(
        `update task_attempt_leases set cancellation_requested_at = coalesce(cancellation_requested_at, ?)
         where attempt_id = ? and profile_id = ?`
      ).run(requestedAt, attemptId, this.#profileId);
      return this.getAttempt(attemptId)?.lease ?? null;
    });
  }

  releaseAttemptLease(input: ReleaseTaskAttemptLeaseInput): boolean {
    return this.atomicWrite(() => {
      const result = this.#db.query(
        `delete from task_attempt_leases
         where attempt_id = ? and profile_id = ? and owner_id = ? and fencing_token = ?`
      ).run(input.attemptId, this.#profileId, input.ownerId, input.fencingToken);
      return result.changes === 1;
    });
  }

  recordResult(result: TaskResult): void {
    this.#assertTransactionActive();
    this.#assertProfile(result.profileId, "Result", result.id);
    this.#assertTaskOwned(result.taskId);
    if (result.byteLength > TASK_GRAPH_LIMITS.maxResultBytesPerStep) {
      throw new TaskStoreIntegrityError(
        `Result ${result.id} exceeds the ${TASK_GRAPH_LIMITS.maxResultBytesPerStep}-byte persistence limit.`
      );
    }
    this.#db.query(
      `insert into task_results (
        id, profile_id, task_id, step_id, attempt_id, kind, status, handle,
        byte_length, content_hash, mime_type, summary, created_at, expires_at, pruned_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      result.id,
      this.#profileId,
      result.taskId,
      result.stepId ?? null,
      result.attemptId ?? null,
      result.kind,
      result.status,
      result.handle,
      result.byteLength,
      result.contentHash,
      result.mimeType ?? null,
      result.summary ?? null,
      result.createdAt,
      result.expiresAt ?? null,
      result.prunedAt ?? null
    );
  }

  updateResult(result: TaskResult): void {
    this.#assertTransactionActive();
    this.#assertProfile(result.profileId, "Result", result.id);
    this.#assertTaskOwned(result.taskId);
    const existing = this.getResult(result.id);
    if (existing === null || existing.taskId !== result.taskId) {
      throw new TaskStoreIntegrityError(`Result ${result.id} was not found.`);
    }
    assertUnchanged("Result identity", {
      taskId: existing.taskId,
      stepId: existing.stepId,
      attemptId: existing.attemptId,
      kind: existing.kind,
      handle: existing.handle,
      byteLength: existing.byteLength,
      contentHash: existing.contentHash,
      mimeType: existing.mimeType,
      summary: existing.summary,
      createdAt: existing.createdAt,
      expiresAt: existing.expiresAt
    }, {
      taskId: result.taskId,
      stepId: result.stepId,
      attemptId: result.attemptId,
      kind: result.kind,
      handle: result.handle,
      byteLength: result.byteLength,
      contentHash: result.contentHash,
      mimeType: result.mimeType,
      summary: result.summary,
      createdAt: result.createdAt,
      expiresAt: result.expiresAt
    });
    if (existing.status === "pruned" && stringify(existing) !== stringify(result)) {
      throw new TaskStoreIntegrityError("Pruned Result is immutable.");
    }
    if (existing.status === "available" && result.status === "pruned" && result.prunedAt === undefined) {
      throw new TaskStoreIntegrityError("Pruned Result requires prunedAt.");
    }
    if (result.status === "available" && result.prunedAt !== undefined) {
      throw new TaskStoreIntegrityError("Available Result cannot have prunedAt.");
    }
    if (existing.status !== result.status && !(existing.status === "available" && result.status === "pruned")) {
      throw new TaskStoreIntegrityError(`Illegal Result transition: ${existing.status} -> ${result.status}.`);
    }

    const update = this.#db.query(
      `update task_results set status = ?, pruned_at = ?
       where id = ? and profile_id = ? and task_id = ?`
    ).run(result.status, result.prunedAt ?? null, result.id, this.#profileId, result.taskId);
    this.#assertChanged(update.changes, "Result", result.id);
  }

  getResult(id: string): TaskResult | null {
    const row = this.#db.query<ResultRow>("select * from task_results where id = ? and profile_id = ?")
      .get(id, this.#profileId);
    return row === null ? null : rowToResult(row);
  }

  listResults(taskId: string, attemptId?: string): TaskResult[] {
    if (this.getTask(taskId) === null) return [];
    const sql = "select * from task_results where profile_id = ? and task_id = ?" +
      (attemptId === undefined ? "" : " and attempt_id = ?") + " order by created_at, id";
    const rows = attemptId === undefined
      ? this.#db.query<ResultRow>(sql).all(this.#profileId, taskId)
      : this.#db.query<ResultRow>(sql).all(this.#profileId, taskId, attemptId);
    return rows.map(rowToResult);
  }

  appendEvent(event: TaskEvent): void {
    this.#assertTransactionActive();
    this.#assertProfile(event.profileId, "Event", event.id);
    this.#assertTaskOwned(event.taskId);
    const dataJson = stringify(event.data);
    if (Buffer.byteLength(dataJson, "utf8") > TASK_EVENT_DATA_MAX_BYTES) {
      throw new TaskStoreIntegrityError(`Task Event data exceeds the ${TASK_EVENT_DATA_MAX_BYTES}-byte persistence limit.`);
    }
    this.#db.query(
      `insert into task_events (
        id, profile_id, task_id, plan_revision_id, step_id, attempt_id, kind, timestamp, data_json
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      event.id,
      this.#profileId,
      event.taskId,
      event.planRevisionId ?? null,
      event.stepId ?? null,
      event.attemptId ?? null,
      event.kind,
      event.timestamp,
      dataJson
    );
  }

  listEvents(taskId: string, options: ListTaskEventsOptions = {}): TaskEvent[] {
    if (this.getTask(taskId) === null) return [];
    let sql = "select * from task_events where profile_id = ? and task_id = ?";
    const params: SQLiteValue[] = [this.#profileId, taskId];
    const kinds = [...(options.kinds ?? [])];
    if (kinds.length > 0) {
      sql += ` and kind in (${kinds.map(() => "?").join(", ")})`;
      params.push(...kinds);
    }
    if (options.stepId !== undefined) {
      sql += " and step_id = ?";
      params.push(options.stepId);
    }
    if (options.attemptId !== undefined) {
      sql += " and attempt_id = ?";
      params.push(options.attemptId);
    }
    sql += " order by timestamp, id limit ?";
    params.push(boundedLimit(options.limit));
    return this.#db.query<EventRow>(sql).all(...params).map(rowToEvent);
  }

  linkSession(link: TaskSessionLink): void {
    this.#assertTransactionActive();
    this.#assertProfile(link.profileId, "TaskSessionLink", `${link.taskId}:${link.sessionId}`);
    this.#assertTaskOwned(link.taskId);
    this.#assertSessionOwned(link.sessionId);
    this.#db.query(
      `insert into task_session_links (
        task_id, profile_id, session_id, relationship, step_id, attempt_id, created_at
      ) values (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      link.taskId,
      this.#profileId,
      link.sessionId,
      link.relationship,
      link.stepId ?? null,
      link.attemptId ?? null,
      link.createdAt
    );
  }

  listSessionLinks(taskId: string): TaskSessionLink[] {
    if (this.getTask(taskId) === null) return [];
    return this.#db.query<SessionLinkRow>(
      `select task_id, profile_id, session_id, relationship, step_id, attempt_id, created_at
       from task_session_links where profile_id = ? and task_id = ? order by created_at, id`
    ).all(this.#profileId, taskId).map(rowToSessionLink);
  }

  atomicWrite<T>(work: (store: TaskStore) => T): T {
    this.#assertTransactionActive();
    if (this.#transactional) return work(this);
    this.#db.exec("begin immediate");
    const transactionState = { active: true };
    try {
      const transactionStore = SQLiteTaskStore.#createTransactionStore(
        this.#db,
        this.#profileId,
        transactionState
      );
      const result = work(transactionStore);
      if (isPromiseLike(result)) {
        transactionState.active = false;
        throw new TaskStoreIntegrityError("TaskStore.atomicWrite callbacks must be synchronous.");
      }
      transactionState.active = false;
      this.#db.exec("commit");
      return result;
    } catch (error) {
      transactionState.active = false;
      try {
        this.#db.exec("rollback");
      } catch {
        // Preserve the write failure.
      }
      throw error;
    }
  }

  #insertStepRecord(step: TaskStep): void {
    this.#assertTransactionActive();
    this.#assertStepInput(step);
    this.#db.query(
      `insert into task_steps (
        id, profile_id, task_id, plan_revision_id, step_key, position, status, title,
        objective, executor_json, authority_policy_json, budget_json, retry_policy_json,
        failure_policy_json, idempotency, result_policy_json, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      step.id,
      this.#profileId,
      step.taskId,
      step.planRevisionId,
      step.key,
      step.position,
      step.status,
      step.title,
      step.objective,
      stringify(step.executor),
      stringify(step.authorityPolicy),
      stringify(step.budget),
      stringify(step.retryPolicy),
      stringify(step.failurePolicy),
      step.idempotency,
      stringify(step.resultPolicy),
      step.createdAt,
      step.updatedAt
    );
  }

  #replaceDependencies(step: TaskStep): void {
    this.#assertTransactionActive();
    this.#db.query(
      "delete from task_step_dependencies where profile_id = ? and step_id = ?"
    ).run(this.#profileId, step.id);
    const insert = this.#db.query(
      `insert into task_step_dependencies (
        profile_id, task_id, plan_revision_id, step_id, dependency_step_id
      ) values (?, ?, ?, ?, ?)`
    );
    for (const dependencyId of step.dependsOn) {
      insert.run(this.#profileId, step.taskId, step.planRevisionId, step.id, dependencyId);
    }
  }

  #insertLease(lease: TaskAttemptLease): void {
    this.#assertTransactionActive();
    this.#assertProfile(lease.profileId, "AttemptLease", lease.attemptId);
    this.#db.query(
      `insert into task_attempt_leases (
        attempt_id, profile_id, task_id, owner_id, fencing_token, acquired_at, heartbeat_at,
        expires_at, cancellation_requested_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      lease.attemptId,
      this.#profileId,
      lease.taskId,
      lease.ownerId,
      lease.fencingToken,
      lease.acquiredAt,
      lease.heartbeatAt,
      lease.expiresAt,
      lease.cancellationRequestedAt ?? null
    );
  }

  #assertStepInput(step: TaskStep): void {
    this.#assertProfile(step.profileId, "Step", step.id);
    this.#assertTaskOwned(step.taskId);
    const revision = this.getPlanRevision(step.planRevisionId);
    if (revision === null || revision.taskId !== step.taskId) {
      throw new TaskStoreIntegrityError(`PlanRevision ${step.planRevisionId} does not belong to Task ${step.taskId}.`);
    }
  }

  #assertAttemptInput(attempt: TaskAttempt): void {
    this.#assertProfile(attempt.profileId, "Attempt", attempt.id);
    const step = this.getStep(attempt.stepId);
    if (step === null || step.taskId !== attempt.taskId || step.planRevisionId !== attempt.planRevisionId) {
      throw new TaskStoreIntegrityError(`Step ${attempt.stepId} does not belong to the Attempt's Task and PlanRevision.`);
    }
    if (attempt.workerSessionId !== undefined) this.#assertSessionOwned(attempt.workerSessionId);
    if (attempt.trajectoryId !== undefined) this.#assertTrajectoryOwned(attempt.trajectoryId);
    if (attempt.lease !== undefined &&
        (attempt.lease.attemptId !== attempt.id || attempt.lease.taskId !== attempt.taskId)) {
      throw new TaskStoreIntegrityError("Attempt lease identity does not match its Attempt.");
    }
  }

  #assertProfile(actualProfileId: string, entity: string, id: string): void {
    if (actualProfileId !== this.#profileId) {
      throw new TaskStoreProfileError(
        this.#profileId,
        `${entity} ${id} belongs to profile ${actualProfileId}, not ${this.#profileId}.`
      );
    }
  }

  #assertTaskOwned(taskId: string): void {
    const row = this.#db.query<{ id: string }>(
      "select id from tasks where id = ? and profile_id = ?"
    ).get(taskId, this.#profileId);
    if (row === null) {
      throw new TaskStoreProfileError(this.#profileId, `Task ${taskId} is not accessible in profile ${this.#profileId}.`);
    }
  }

  #assertAttemptOwned(attemptId: string, taskId?: string): void {
    let sql = "select id from task_attempts where id = ? and profile_id = ?";
    const params: SQLiteValue[] = [attemptId, this.#profileId];
    if (taskId !== undefined) {
      sql += " and task_id = ?";
      params.push(taskId);
    }
    if (this.#db.query<{ id: string }>(sql).get(...params) === null) {
      throw new TaskStoreProfileError(this.#profileId, `Attempt ${attemptId} is not accessible in profile ${this.#profileId}.`);
    }
  }

  #assertSessionOwned(sessionId: string): void {
    const row = this.#db.query<{ id: string }>(
      "select id from sessions where id = ? and profile_id = ?"
    ).get(sessionId, this.#profileId);
    if (row === null) {
      throw new TaskStoreProfileError(this.#profileId, `Session ${sessionId} is not accessible in profile ${this.#profileId}.`);
    }
  }

  #assertTrajectoryOwned(trajectoryId: string): void {
    const row = this.#db.query<{ id: string }>(
      "select id from trajectories where id = ? and profile_id = ?"
    ).get(trajectoryId, this.#profileId);
    if (row === null) {
      throw new TaskStoreProfileError(this.#profileId, `Trajectory ${trajectoryId} is not accessible in profile ${this.#profileId}.`);
    }
  }

  #assertChanged(changes: number, entity: string, id: string): void {
    if (changes !== 1) {
      throw new TaskStoreIntegrityError(`${entity} ${id} was not updated.`);
    }
  }

  #assertTransactionActive(): void {
    if (this.#transactionState?.active === false) {
      throw new TaskStoreIntegrityError("TaskStore transaction is no longer active.");
    }
  }

  static #createTransactionStore(
    db: SQLiteDatabase,
    profileId: string,
    transactionState: { active: boolean }
  ): SQLiteTaskStore {
    const store = new SQLiteTaskStore({ db, profileId });
    store.#transactional = true;
    store.#transactionState = transactionState;
    return store;
  }

  #rowToStep(row: StepRow): TaskStep {
    const dependencies = this.#db.query<{ dependency_step_id: string }>(
      `select dependency_step_id from task_step_dependencies
       where profile_id = ? and step_id = ? order by dependency_step_id`
    ).all(this.#profileId, row.id).map((entry) => entry.dependency_step_id);
    return rowToStep(row, dependencies);
  }

  #rowToAttempt(row: AttemptWithLeaseRow): TaskAttempt {
    const resultIds = this.#db.query<{ id: string }>(
      "select id from task_results where profile_id = ? and attempt_id = ? order by created_at, id"
    ).all(this.#profileId, row.id).map((entry) => entry.id);
    return rowToAttempt(row, resultIds);
  }
}

const ATTEMPT_SELECT = `select a.*,
  l.owner_id as lease_owner_id,
  l.fencing_token as lease_fencing_token,
  l.acquired_at as lease_acquired_at,
  l.heartbeat_at as lease_heartbeat_at,
  l.expires_at as lease_expires_at,
  l.cancellation_requested_at as lease_cancellation_requested_at
 from task_attempts a
 left join task_attempt_leases l
   on l.attempt_id = a.id and l.profile_id = a.profile_id`;

const TASK_EVENT_DATA_MAX_BYTES = 16 * 1024;

function immutableStepFields(step: TaskStep): unknown {
  return {
    taskId: step.taskId,
    planRevisionId: step.planRevisionId,
    key: step.key,
    position: step.position,
    title: step.title,
    objective: step.objective,
    dependsOn: step.dependsOn,
    executor: step.executor,
    authorityPolicy: step.authorityPolicy,
    budget: step.budget,
    retryPolicy: step.retryPolicy,
    failurePolicy: step.failurePolicy,
    idempotency: step.idempotency,
    resultPolicy: step.resultPolicy,
    createdAt: step.createdAt
  };
}

function assertUnchanged(label: string, existing: unknown, updated: unknown): void {
  if (stringify(existing) !== stringify(updated)) {
    throw new TaskStoreIntegrityError(`${label} is immutable.`);
  }
}

function taskValues(task: Task): SQLiteValue[] {
  return [
    task.id,
    task.profileId,
    task.creatorSessionId ?? null,
    task.parentTaskId ?? null,
    task.parentAttemptId ?? null,
    task.source,
    task.creationKey ?? null,
    task.objective,
    task.status,
    task.workspace.canonicalPath,
    task.workspace.identityHash,
    stringify(task.authorityPolicy),
    stringify(task.budgetPolicy),
    task.activePlanRevisionId ?? null,
    optionalJson(task.waitReason),
    optionalJson(task.failure),
    stringify(task.createdBy),
    task.createdAt,
    task.updatedAt,
    task.startedAt ?? null,
    task.completedAt ?? null,
    task.cancelledAt ?? null
  ];
}

function planRevisionValues(revision: TaskPlanRevision): SQLiteValue[] {
  return [
    revision.id,
    revision.profileId,
    revision.taskId,
    revision.revision,
    revision.status,
    revision.reason,
    stringify(revision.createdBy),
    revision.createdAt,
    revision.validatedAt ?? null,
    revision.activatedAt ?? null,
    revision.supersededAt ?? null
  ];
}

function attemptValues(attempt: TaskAttempt): SQLiteValue[] {
  return [
    attempt.id,
    attempt.profileId,
    attempt.taskId,
    attempt.planRevisionId,
    attempt.stepId,
    attempt.attemptNumber,
    attempt.status,
    attempt.dispatchKey,
    attempt.workerSessionId ?? null,
    attempt.trajectoryId ?? null,
    stringify(attempt.usage),
    optionalJson(attempt.failure),
    attempt.createdAt,
    attempt.updatedAt,
    attempt.startedAt ?? null,
    attempt.completedAt ?? null
  ];
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    profileId: row.profile_id,
    ...(row.creator_session_id === null ? {} : { creatorSessionId: row.creator_session_id }),
    ...(row.parent_task_id === null ? {} : { parentTaskId: row.parent_task_id }),
    ...(row.parent_attempt_id === null ? {} : { parentAttemptId: row.parent_attempt_id }),
    source: row.source as Task["source"],
    ...(row.creation_key === null ? {} : { creationKey: row.creation_key }),
    objective: row.objective,
    status: row.status as Task["status"],
    workspace: { canonicalPath: row.workspace_path, identityHash: row.workspace_identity_hash },
    authorityPolicy: parseJson(row.authority_policy_json, "Task.authorityPolicy"),
    budgetPolicy: parseJson(row.budget_policy_json, "Task.budgetPolicy"),
    ...(row.active_plan_revision_id === null ? {} : { activePlanRevisionId: row.active_plan_revision_id }),
    ...(row.wait_reason_json === null ? {} : { waitReason: parseJson(row.wait_reason_json, "Task.waitReason") }),
    ...(row.failure_json === null ? {} : { failure: parseJson(row.failure_json, "Task.failure") }),
    createdBy: parseJson(row.created_by_json, "Task.createdBy"),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    ...(row.cancelled_at === null ? {} : { cancelledAt: row.cancelled_at })
  };
}

function rowToPlanRevision(row: PlanRevisionRow): TaskPlanRevision {
  return {
    id: row.id,
    profileId: row.profile_id,
    taskId: row.task_id,
    revision: row.revision,
    status: row.status as TaskPlanRevision["status"],
    reason: row.reason,
    createdBy: parseJson(row.created_by_json, "TaskPlanRevision.createdBy"),
    createdAt: row.created_at,
    ...(row.validated_at === null ? {} : { validatedAt: row.validated_at }),
    ...(row.activated_at === null ? {} : { activatedAt: row.activated_at }),
    ...(row.superseded_at === null ? {} : { supersededAt: row.superseded_at })
  };
}

function rowToStep(row: StepRow, dependsOn: readonly string[]): TaskStep {
  return {
    id: row.id,
    profileId: row.profile_id,
    taskId: row.task_id,
    planRevisionId: row.plan_revision_id,
    key: row.step_key,
    position: row.position,
    status: row.status as TaskStep["status"],
    title: row.title,
    objective: row.objective,
    dependsOn,
    executor: parseJson(row.executor_json, "TaskStep.executor"),
    authorityPolicy: parseJson(row.authority_policy_json, "TaskStep.authorityPolicy"),
    budget: parseJson(row.budget_json, "TaskStep.budget"),
    retryPolicy: parseJson(row.retry_policy_json, "TaskStep.retryPolicy"),
    failurePolicy: parseJson(row.failure_policy_json, "TaskStep.failurePolicy"),
    idempotency: row.idempotency as TaskStep["idempotency"],
    resultPolicy: parseJson(row.result_policy_json, "TaskStep.resultPolicy"),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowToAttempt(row: AttemptWithLeaseRow, resultIds: readonly string[]): TaskAttempt {
  const lease = row.lease_owner_id === null ? undefined : {
    attemptId: row.id,
    profileId: row.profile_id,
    taskId: row.task_id,
    ownerId: row.lease_owner_id,
    fencingToken: row.lease_fencing_token!,
    acquiredAt: row.lease_acquired_at!,
    heartbeatAt: row.lease_heartbeat_at!,
    expiresAt: row.lease_expires_at!,
    ...(row.lease_cancellation_requested_at === null
      ? {}
      : { cancellationRequestedAt: row.lease_cancellation_requested_at })
  };
  return {
    id: row.id,
    profileId: row.profile_id,
    taskId: row.task_id,
    planRevisionId: row.plan_revision_id,
    stepId: row.step_id,
    attemptNumber: row.attempt_number,
    status: row.status as TaskAttempt["status"],
    dispatchKey: row.dispatch_key,
    ...(row.worker_session_id === null ? {} : { workerSessionId: row.worker_session_id }),
    ...(row.trajectory_id === null ? {} : { trajectoryId: row.trajectory_id }),
    ...(lease === undefined ? {} : { lease }),
    usage: parseJson(row.usage_json, "TaskAttempt.usage"),
    ...(row.failure_json === null ? {} : { failure: parseJson(row.failure_json, "TaskAttempt.failure") }),
    resultIds,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at })
  };
}

function rowToResult(row: ResultRow): TaskResult {
  return {
    id: row.id,
    profileId: row.profile_id,
    taskId: row.task_id,
    ...(row.step_id === null ? {} : { stepId: row.step_id }),
    ...(row.attempt_id === null ? {} : { attemptId: row.attempt_id }),
    kind: row.kind as TaskResult["kind"],
    status: row.status as TaskResult["status"],
    handle: row.handle,
    byteLength: row.byte_length,
    contentHash: row.content_hash,
    ...(row.mime_type === null ? {} : { mimeType: row.mime_type }),
    ...(row.summary === null ? {} : { summary: row.summary }),
    createdAt: row.created_at,
    ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
    ...(row.pruned_at === null ? {} : { prunedAt: row.pruned_at })
  };
}

function rowToEvent(row: EventRow): TaskEvent {
  return {
    id: row.id,
    profileId: row.profile_id,
    taskId: row.task_id,
    ...(row.plan_revision_id === null ? {} : { planRevisionId: row.plan_revision_id }),
    ...(row.step_id === null ? {} : { stepId: row.step_id }),
    ...(row.attempt_id === null ? {} : { attemptId: row.attempt_id }),
    kind: row.kind as TaskEvent["kind"],
    timestamp: row.timestamp,
    data: parseJson(row.data_json, "TaskEvent.data")
  };
}

function rowToSessionLink(row: SessionLinkRow): TaskSessionLink {
  return {
    taskId: row.task_id,
    profileId: row.profile_id,
    sessionId: row.session_id,
    relationship: row.relationship as TaskSessionLink["relationship"],
    ...(row.step_id === null ? {} : { stepId: row.step_id }),
    ...(row.attempt_id === null ? {} : { attemptId: row.attempt_id }),
    createdAt: row.created_at
  };
}

function stringify(value: unknown): string {
  const result = JSON.stringify(value);
  if (result === undefined) throw new TaskStoreIntegrityError("Task persistence value is not JSON serializable.");
  return result;
}

function optionalJson(value: unknown | undefined): string | null {
  return value === undefined ? null : stringify(value);
}

function parseJson<T>(value: string, field: string): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new TaskStoreIntegrityError(`Stored ${field} is not valid JSON.`, { cause: error });
  }
}

function requireNonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new TaskStoreIntegrityError(`${label} must not be empty.`);
  return normalized;
}

function assertTimestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new TaskStoreIntegrityError(`${label} must be an ISO-compatible timestamp.`);
  }
}

function assertLeaseWindow(start: string, end: string, label: string): void {
  assertTimestamp(start, label);
  assertTimestamp(end, label);
  if (Date.parse(end) <= Date.parse(start)) {
    throw new TaskStoreIntegrityError(`${label} expiry must be later than its start.`);
  }
}

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined) return 500;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new TaskStoreIntegrityError("TaskStore list limit must be an integer between 1 and 1000.");
  }
  return limit;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === "object" && value !== null && "then" in value &&
    typeof (value as { then?: unknown }).then === "function";
}

type TaskRow = {
  id: string;
  profile_id: string;
  creator_session_id: string | null;
  parent_task_id: string | null;
  parent_attempt_id: string | null;
  source: string;
  creation_key: string | null;
  objective: string;
  status: string;
  workspace_path: string;
  workspace_identity_hash: string;
  authority_policy_json: string;
  budget_policy_json: string;
  active_plan_revision_id: string | null;
  wait_reason_json: string | null;
  failure_json: string | null;
  created_by_json: string;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
};

type PlanRevisionRow = {
  id: string;
  profile_id: string;
  task_id: string;
  revision: number;
  status: string;
  reason: string;
  created_by_json: string;
  created_at: string;
  validated_at: string | null;
  activated_at: string | null;
  superseded_at: string | null;
};

type StepRow = {
  id: string;
  profile_id: string;
  task_id: string;
  plan_revision_id: string;
  step_key: string;
  position: number;
  status: string;
  title: string;
  objective: string;
  executor_json: string;
  authority_policy_json: string;
  budget_json: string;
  retry_policy_json: string;
  failure_policy_json: string;
  idempotency: string;
  result_policy_json: string;
  created_at: string;
  updated_at: string;
};

type AttemptRow = {
  id: string;
  profile_id: string;
  task_id: string;
  plan_revision_id: string;
  step_id: string;
  attempt_number: number;
  status: string;
  dispatch_key: string;
  worker_session_id: string | null;
  trajectory_id: string | null;
  usage_json: string;
  failure_json: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
};

type AttemptWithLeaseRow = AttemptRow & {
  lease_owner_id: string | null;
  lease_fencing_token: number | null;
  lease_acquired_at: string | null;
  lease_heartbeat_at: string | null;
  lease_expires_at: string | null;
  lease_cancellation_requested_at: string | null;
};

type ResultRow = {
  id: string;
  profile_id: string;
  task_id: string;
  step_id: string | null;
  attempt_id: string | null;
  kind: string;
  status: string;
  handle: string;
  byte_length: number;
  content_hash: string;
  mime_type: string | null;
  summary: string | null;
  created_at: string;
  expires_at: string | null;
  pruned_at: string | null;
};

type EventRow = {
  id: string;
  profile_id: string;
  task_id: string;
  plan_revision_id: string | null;
  step_id: string | null;
  attempt_id: string | null;
  kind: string;
  timestamp: string;
  data_json: string;
};

type SessionLinkRow = {
  task_id: string;
  profile_id: string;
  session_id: string;
  relationship: string;
  step_id: string | null;
  attempt_id: string | null;
  created_at: string;
};
