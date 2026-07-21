import type {
  Task,
  TaskApprovalLink,
  TaskAttempt,
  TaskAttemptLease,
  TaskBudgetPolicy,
  TaskBudgetReservation,
  TaskDeliveryBinding,
  TaskEvent,
  TaskGuidance,
  TaskHostKind,
  TaskHostLease,
  TaskPlanRevision,
  TaskResult,
  TaskSessionLink,
  TaskStep
} from "../contracts/task.js";
import type { ProviderUsageEntry, ProviderUsageQuery } from "../contracts/provider-usage.js";
import {
  TASK_GRAPH_LIMITS,
  assertTaskAttemptTransition,
  assertTaskPlanRevisionTransition,
  assertTaskStepTransition,
  assertTaskTransition,
  isTaskDeliveryDestination,
  isTerminalTaskAttemptStatus,
  isTerminalTaskPlanRevisionStatus,
  isTerminalTaskStatus,
  isTerminalTaskStepStatus,
  validateTaskPlan
} from "../contracts/task.js";
import type { SQLiteDatabase, SQLiteValue } from "../storage/sqlite.js";
import { insertProviderUsageEntry, selectProviderUsageEntries } from "./sqlite-provider-usage.js";
import type {
  AcquireTaskAttemptLeaseInput,
  AcquireTaskHostLeaseInput,
  CreateTaskGraphInput,
  ListTaskEventsOptions,
  ListTaskApprovalLinksOptions,
  ListTaskDeliveryBindingsOptions,
  ListTasksOptions,
  ListTaskHostLeasesOptions,
  ReleaseTaskAttemptLeaseInput,
  ReleaseTaskHostLeaseInput,
  RenewTaskAttemptLeaseInput,
  RenewTaskHostLeaseInput,
  SettleTaskDeliveryInput,
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
    if ((input.initialEvents ?? []).some((event) =>
      event.profileId !== input.task.profileId || event.taskId !== input.task.id ||
      (event.planRevisionId !== undefined && event.planRevisionId !== input.revision.id) ||
      (event.stepId !== undefined && !input.steps.some((step) => step.id === event.stepId))
    )) {
      throw new TaskStoreIntegrityError("Initial Task events must belong to the supplied Task graph.");
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
      for (const event of input.initialEvents ?? []) store.appendEvent(event);
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
    requireBoundedText(task.rootTaskId, "Task root ID", 256);
    requireBoundedText(task.originSessionId, "Task origin session ID", 256);
    if (task.originTurnId !== undefined) requireBoundedText(task.originTurnId, "Task origin turn ID", 256);
    if (task.creatorSessionId !== undefined) this.#assertSessionOwned(task.creatorSessionId);
    this.#assertSessionOwned(task.originSessionId);
    if (task.parentTaskId === undefined) {
      if (task.rootTaskId !== task.id || task.originSessionId !== task.creatorSessionId) {
        throw new TaskStoreIntegrityError("A root Task must own its root and origin session attribution.");
      }
    } else if (task.rootTaskId === task.id) {
      throw new TaskStoreIntegrityError("A child Task cannot identify itself as the Task-tree root.");
    }
    if (task.rootTaskId !== task.id) this.#assertTaskOwned(task.rootTaskId);
    if (task.parentTaskId !== undefined) {
      if (task.parentAttemptId === undefined) {
        throw new TaskStoreIntegrityError("A child Task requires a parent Attempt.");
      }
      this.#assertTaskOwned(task.parentTaskId);
      const parent = this.getTask(task.parentTaskId)!;
      if (task.rootTaskId !== parent.rootTaskId || task.originSessionId !== parent.originSessionId ||
        task.originTurnId !== parent.originTurnId) {
        throw new TaskStoreIntegrityError("A child Task must inherit its parent Task lineage attribution.");
      }
    }
    if (task.parentAttemptId !== undefined) {
      if (task.parentTaskId === undefined) {
        throw new TaskStoreIntegrityError("A parent Attempt requires a parent Task.");
      }
      this.#assertAttemptOwned(task.parentAttemptId, task.parentTaskId);
    }

    this.#db.query(
      `insert into tasks (
        id, profile_id, creator_session_id, root_task_id, origin_session_id, origin_turn_id,
        parent_task_id, parent_attempt_id,
        source, creation_key, objective, status, workspace_path, workspace_identity_hash,
        authority_policy_json, budget_policy_json, active_plan_revision_id,
        wait_reason_json, failure_json, created_by_json,
        created_at, updated_at, started_at, completed_at, cancelled_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      rootTaskId: existing.rootTaskId,
      originSessionId: existing.originSessionId,
      originTurnId: existing.originTurnId,
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
      rootTaskId: task.rootTaskId,
      originSessionId: task.originSessionId,
      originTurnId: task.originTurnId,
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
        creator_session_id = ?, root_task_id = ?, origin_session_id = ?, origin_turn_id = ?,
        parent_task_id = ?, parent_attempt_id = ?, source = ?,
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

  getTaskByCreationKey(creationKey: string): Task | null {
    const key = requireBoundedText(creationKey, "Task creation key", 256);
    const row = this.#db.query<TaskRow>(
      "select * from tasks where creation_key = ? and profile_id = ?"
    ).get(key, this.#profileId);
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

  listChildTasks(parentTaskId: string): Task[] {
    this.#assertTaskOwned(parentTaskId);
    return this.#db.query<TaskRow>(
      `select * from tasks
       where profile_id = ? and parent_task_id = ?
       order by created_at, id`
    ).all(this.#profileId, parentTaskId).map(rowToTask);
  }

  reserveChildTaskBudget(reservation: TaskBudgetReservation): void {
    this.#assertTransactionActive();
    this.#assertProfile(reservation.profileId, "TaskBudgetReservation", reservation.childTaskId);
    requireBoundedText(reservation.childTaskId, "child Task ID", 256);
    requireBoundedText(reservation.rootTaskId, "root Task ID", 256);
    requireBoundedText(reservation.parentTaskId, "parent Task ID", 256);
    requireBoundedText(reservation.parentStepId, "parent Step ID", 256);
    requireBoundedText(reservation.parentAttemptId, "parent Attempt ID", 256);
    assertTimestamp(reservation.createdAt, "Task budget reservation creation");
    assertBudgetPolicy(reservation.budget, "Child Task budget reservation");
    if (this.getTask(reservation.childTaskId) !== null) {
      throw new TaskStoreIntegrityError(`Child Task ${reservation.childTaskId} already exists.`);
    }

    const parent = this.getTask(reservation.parentTaskId);
    const root = this.getTask(reservation.rootTaskId);
    const attempt = this.getAttempt(reservation.parentAttemptId);
    const step = this.getStep(reservation.parentStepId);
    if (parent === null || root === null || attempt === null || step === null ||
        parent.rootTaskId !== root.id || attempt.taskId !== parent.id || attempt.stepId !== step.id ||
        step.taskId !== parent.id || step.planRevisionId !== attempt.planRevisionId) {
      throw new TaskStoreIntegrityError("Child Task budget reservation lineage is invalid.");
    }
    if (attempt.status !== "running" || step.childTaskPolicy !== "fire_and_forget" ||
        isTerminalTaskStatus(parent.status)) {
      throw new TaskStoreIntegrityError("Child Task budget reservations require an active authorized parent Attempt.");
    }
    if (reservation.budget.maxConcurrentAttempts > parent.budgetPolicy.maxConcurrentAttempts ||
        reservation.budget.maxConcurrentAttempts > root.budgetPolicy.maxConcurrentAttempts ||
        reservation.budget.maxWallClockMs > parent.budgetPolicy.maxWallClockMs ||
        reservation.budget.maxWallClockMs > step.budget.maxWallClockMs ||
        reservation.budget.maxWallClockMs > root.budgetPolicy.maxWallClockMs) {
      throw new TaskStoreIntegrityError("Child Task concurrency or wall-clock budget exceeds its Task-tree ceiling.");
    }

    const taskUsage = sumAttemptBudgetUsage(this.listAttempts(parent.id));
    const stepUsage = sumAttemptBudgetUsage(this.listAttempts(parent.id, step.id));
    const taskReservations = this.listChildTaskBudgetReservations(parent.id);
    const stepReservations = taskReservations.filter((entry) => entry.parentStepId === step.id);
    if (!reservationFits(
      taskUsage,
      sumReservedBudget(taskReservations),
      reservation.budget,
      parent.budgetPolicy
    )) {
      throw new TaskStoreIntegrityError("Child Task budget reservation exceeds the parent Task's remaining budget.");
    }
    if (!reservationFits(
      stepUsage,
      sumReservedBudget(stepReservations),
      reservation.budget,
      step.budget
    )) {
      throw new TaskStoreIntegrityError("Child Task budget reservation exceeds the parent Step's remaining budget.");
    }

    this.#db.query(
      `insert into task_budget_reservations (
        child_task_id, profile_id, root_task_id, parent_task_id, parent_step_id, parent_attempt_id,
        max_concurrent_attempts, max_provider_calls, max_total_tokens,
        max_estimated_cost_usd, max_wall_clock_ms, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      reservation.childTaskId,
      this.#profileId,
      reservation.rootTaskId,
      reservation.parentTaskId,
      reservation.parentStepId,
      reservation.parentAttemptId,
      reservation.budget.maxConcurrentAttempts,
      reservation.budget.maxProviderCalls,
      reservation.budget.maxTotalTokens,
      reservation.budget.maxEstimatedCostUsd,
      reservation.budget.maxWallClockMs,
      reservation.createdAt
    );
  }

  listChildTaskBudgetReservations(parentTaskId: string, parentStepId?: string): TaskBudgetReservation[] {
    this.#assertTaskOwned(parentTaskId);
    let sql = `select * from task_budget_reservations
      where profile_id = ? and parent_task_id = ?`;
    const params: SQLiteValue[] = [this.#profileId, parentTaskId];
    if (parentStepId !== undefined) {
      requireBoundedText(parentStepId, "parent Step ID", 256);
      sql += " and parent_step_id = ?";
      params.push(parentStepId);
    }
    sql += " order by created_at, child_task_id";
    return this.#db.query<BudgetReservationRow>(sql).all(...params).map(rowToBudgetReservation);
  }

  acquireTaskHostLease(input: AcquireTaskHostLeaseInput): TaskHostLease | null {
    const ownerId = requireBoundedText(input.ownerId, "Task host owner ID", 256);
    const workspaceIdentityHash = requireBoundedText(
      input.workspaceIdentityHash,
      "Task host workspace identity",
      256
    );
    assertTaskHostKind(input.kind);
    assertLeaseWindow(input.acquiredAt, input.expiresAt, "Task host lease acquisition");

    const task = this.getTask(input.taskId);
    if (task === null) {
      throw new TaskStoreProfileError(
        this.#profileId,
        `Task ${input.taskId} is not accessible in profile ${this.#profileId}.`
      );
    }
    if (task.workspace.identityHash !== workspaceIdentityHash) {
      throw new TaskStoreIntegrityError(`Task host workspace does not match Task ${input.taskId}.`);
    }

    return this.atomicWrite(() => {
      const current = this.getTaskHostLease(input.taskId);
      if (current !== null && Date.parse(current.expiresAt) > Date.parse(input.acquiredAt)) {
        return current.ownerId === ownerId && current.kind === input.kind ? current : null;
      }
      if (current !== null) {
        const removed = this.#db.query(
          `delete from task_host_leases
           where task_id = ? and profile_id = ? and workspace_identity_hash = ? and fencing_token = ?`
        ).run(input.taskId, this.#profileId, workspaceIdentityHash, current.fencingToken);
        if (removed.changes !== 1) return null;
      }

      const owner = this.#db.query<{ host_lease_generation: number }>(
        `select host_lease_generation from tasks
         where id = ? and profile_id = ? and workspace_identity_hash = ?
           and status in ('queued', 'running', 'waiting_for_host', 'waiting_for_approval')`
      ).get(input.taskId, this.#profileId, workspaceIdentityHash);
      if (owner === null) return null;

      const lease: TaskHostLease = {
        taskId: input.taskId,
        profileId: this.#profileId,
        workspaceIdentityHash,
        ownerId,
        kind: input.kind,
        fencingToken: owner.host_lease_generation + 1,
        acquiredAt: input.acquiredAt,
        heartbeatAt: input.acquiredAt,
        expiresAt: input.expiresAt
      };
      this.#db.query(
        `insert into task_host_leases (
          task_id, profile_id, workspace_identity_hash, owner_id, owner_kind,
          fencing_token, acquired_at, heartbeat_at, expires_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        lease.taskId,
        lease.profileId,
        lease.workspaceIdentityHash,
        lease.ownerId,
        lease.kind,
        lease.fencingToken,
        lease.acquiredAt,
        lease.heartbeatAt,
        lease.expiresAt
      );
      return lease;
    });
  }

  renewTaskHostLease(input: RenewTaskHostLeaseInput): TaskHostLease | null {
    const ownerId = requireBoundedText(input.ownerId, "Task host owner ID", 256);
    const workspaceIdentityHash = requireBoundedText(
      input.workspaceIdentityHash,
      "Task host workspace identity",
      256
    );
    assertTaskHostKind(input.kind);
    assertFencingToken(input.fencingToken, "Task host lease");
    assertLeaseWindow(input.heartbeatAt, input.expiresAt, "Task host lease renewal");
    return this.atomicWrite(() => {
      const current = this.getTaskHostLease(input.taskId);
      const currentHeartbeat = current === null ? Number.NaN : Date.parse(current.heartbeatAt);
      const currentExpiry = current === null ? Number.NaN : Date.parse(current.expiresAt);
      if (
        current === null ||
        !Number.isFinite(currentHeartbeat) ||
        !Number.isFinite(currentExpiry) ||
        current.workspaceIdentityHash !== workspaceIdentityHash ||
        current.ownerId !== ownerId ||
        current.kind !== input.kind ||
        current.fencingToken !== input.fencingToken ||
        currentHeartbeat > Date.parse(input.heartbeatAt) ||
        currentExpiry <= Date.parse(input.heartbeatAt)
      ) {
        return null;
      }
      const row = this.#db.query<TaskHostLeaseRow>(
        `update task_host_leases
         set heartbeat_at = ?, expires_at = ?
         where task_id = ? and profile_id = ? and workspace_identity_hash = ?
           and owner_id = ? and owner_kind = ? and fencing_token = ?
         returning *`
      ).get(
        input.heartbeatAt,
        input.expiresAt,
        input.taskId,
        this.#profileId,
        workspaceIdentityHash,
        ownerId,
        input.kind,
        input.fencingToken
      );
      return row === null ? null : rowToTaskHostLease(row);
    });
  }

  releaseTaskHostLease(input: ReleaseTaskHostLeaseInput): boolean {
    const ownerId = requireBoundedText(input.ownerId, "Task host owner ID", 256);
    const workspaceIdentityHash = requireBoundedText(
      input.workspaceIdentityHash,
      "Task host workspace identity",
      256
    );
    assertTaskHostKind(input.kind);
    assertFencingToken(input.fencingToken, "Task host lease");
    const result = this.#db.query(
      `delete from task_host_leases
       where task_id = ? and profile_id = ? and workspace_identity_hash = ?
         and owner_id = ? and owner_kind = ? and fencing_token = ?`
    ).run(
      input.taskId,
      this.#profileId,
      workspaceIdentityHash,
      ownerId,
      input.kind,
      input.fencingToken
    );
    return result.changes === 1;
  }

  getTaskHostLease(taskId: string): TaskHostLease | null {
    const row = this.#db.query<TaskHostLeaseRow>(
      "select * from task_host_leases where task_id = ? and profile_id = ?"
    ).get(taskId, this.#profileId);
    return row === null ? null : rowToTaskHostLease(row);
  }

  listTaskHostLeases(options: ListTaskHostLeasesOptions = {}): TaskHostLease[] {
    let sql = "select * from task_host_leases where profile_id = ?";
    const params: SQLiteValue[] = [this.#profileId];
    if (options.workspaceIdentityHash !== undefined) {
      sql += " and workspace_identity_hash = ?";
      params.push(requireBoundedText(options.workspaceIdentityHash, "Task host workspace identity", 256));
    }
    if (options.ownerId !== undefined) {
      sql += " and owner_id = ?";
      params.push(requireBoundedText(options.ownerId, "Task host owner ID", 256));
    }
    if (options.kind !== undefined) {
      assertTaskHostKind(options.kind);
      sql += " and owner_kind = ?";
      params.push(options.kind);
    }
    sql += " order by expires_at, task_id limit ?";
    params.push(boundedLimit(options.limit));
    return this.#db.query<TaskHostLeaseRow>(sql).all(...params).map(rowToTaskHostLease);
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
      const persistedAttempt = attempt.lease === undefined
        ? attempt
        : { ...attempt, status: "queued" as const, lease: undefined };
      this.#db.query(
        `insert into task_attempts (
          id, profile_id, task_id, plan_revision_id, step_id, attempt_number, status,
          dispatch_key, worker_session_id, trajectory_id, usage_json, failure_json,
          created_at, updated_at, started_at, completed_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(...attemptValues(persistedAttempt));
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
    const existing = this.getAttempt(input.attemptId);
    if (existing === null) throw new TaskStoreIntegrityError(`Attempt ${input.attemptId} was not found.`);
    if (existing.status === "leased" && existing.lease?.ownerId === ownerId) return existing.lease;

    const row = this.#db.query<LeaseRow>(
      `insert into task_attempt_leases (
         attempt_id, profile_id, task_id, owner_id, fencing_token,
         acquired_at, heartbeat_at, expires_at, cancellation_requested_at
       )
       select a.id, a.profile_id, a.task_id, ?, a.lease_generation + 1, ?, ?, ?, null
       from task_attempts a
       where a.id = ? and a.profile_id = ? and a.status = 'queued'
         and not exists (
           select 1 from task_attempt_leases l
           where l.attempt_id = a.id and l.profile_id = a.profile_id
         )
       returning *`
    ).get(ownerId, input.acquiredAt, input.acquiredAt, input.expiresAt, input.attemptId, this.#profileId);
    return row === null ? null : rowToLease(row);
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

  recordProviderUsageEntry(entry: ProviderUsageEntry): void {
    this.#assertTransactionActive();
    this.#assertProfile(entry.profileId, "ProviderUsageEntry", entry.id);
    if (entry.attemptId !== undefined && entry.taskId !== undefined) this.#assertAttemptOwned(entry.attemptId, entry.taskId);
    insertProviderUsageEntry(this.#db, entry);
  }

  listProviderUsageEntries(query: ProviderUsageQuery = {}): ProviderUsageEntry[] {
    if (query.taskId !== undefined && this.getTask(query.taskId) === null) return [];
    return selectProviderUsageEntries(this.#db, this.#profileId, query);
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
    sql += options.order === "desc"
      ? " order by timestamp desc, id desc limit ?"
      : " order by timestamp, id limit ?";
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

  createGuidance(guidance: TaskGuidance): void {
    this.#assertTransactionActive();
    this.#assertProfile(guidance.profileId, "TaskGuidance", guidance.id);
    this.#assertTaskOwned(guidance.taskId);
    this.#assertSessionOwned(guidance.authorizedSessionId);
    requireBoundedText(guidance.id, "Task Guidance ID", 256);
    const text = requireBoundedContent(guidance.guidance, "Task guidance", 4_000);
    assertTimestamp(guidance.createdAt, "Task guidance creation");
    const linked = this.listSessionLinks(guidance.taskId)
      .some((link) => link.sessionId === guidance.authorizedSessionId && link.relationship !== "worker");
    if (!linked) {
      throw new TaskStoreProfileError(
        this.#profileId,
        `Session ${guidance.authorizedSessionId} is not authorized for Task ${guidance.taskId}.`
      );
    }
    this.#db.query(
      `insert into task_guidance (
        id, profile_id, task_id, authorized_session_id, guidance, created_at
      ) values (?, ?, ?, ?, ?, ?)`
    ).run(
      guidance.id,
      this.#profileId,
      guidance.taskId,
      guidance.authorizedSessionId,
      text,
      guidance.createdAt
    );
  }

  listGuidance(taskId: string): TaskGuidance[] {
    if (this.getTask(taskId) === null) return [];
    return this.#db.query<GuidanceRow>(
      `select id, profile_id, task_id, authorized_session_id, guidance, created_at
       from task_guidance where profile_id = ? and task_id = ? order by created_at, id`
    ).all(this.#profileId, taskId).map(rowToGuidance);
  }

  createApprovalLink(link: TaskApprovalLink): void {
    this.#assertTransactionActive();
    this.#assertProfile(link.profileId, "TaskApprovalLink", link.id);
    this.#assertAttemptOwned(link.attemptId, link.taskId);
    this.#assertSessionOwned(link.authorizedSessionId);
    assertApprovalLink(link);
    if (link.status !== "requesting" || link.pendingApprovalId !== undefined ||
        link.resolvedAt !== undefined || link.consumedAt !== undefined) {
      throw new TaskStoreIntegrityError("A new Task approval link must start in requesting state.");
    }
    const attempt = this.getAttempt(link.attemptId)!;
    if (attempt.planRevisionId !== link.planRevisionId || attempt.stepId !== link.stepId) {
      throw new TaskStoreIntegrityError("Task approval hierarchy does not match its Attempt.");
    }
    const linked = this.listSessionLinks(link.taskId).some((candidate) =>
      candidate.sessionId === link.authorizedSessionId
    );
    if (!linked) {
      throw new TaskStoreProfileError(
        this.#profileId,
        `Session ${link.authorizedSessionId} is not authorized for Task ${link.taskId}.`
      );
    }
    this.#db.query(
      `insert into task_approval_links (
        id, profile_id, task_id, plan_revision_id, step_id, attempt_id,
        authorized_session_id, pending_approval_id, tool_name, risk_class,
        target_fingerprint, target_preview, status, requested_at, expires_at,
        updated_at, resolved_at, consumed_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(...approvalLinkValues(link));
  }

  updateApprovalLink(link: TaskApprovalLink): void {
    this.#assertTransactionActive();
    this.#assertProfile(link.profileId, "TaskApprovalLink", link.id);
    assertApprovalLink(link);
    const existing = this.getApprovalLink(link.id);
    if (existing === null) throw new TaskStoreIntegrityError(`Task approval ${link.id} was not found.`);
    assertUnchanged("Task approval identity", {
      taskId: existing.taskId, planRevisionId: existing.planRevisionId, stepId: existing.stepId,
      attemptId: existing.attemptId, authorizedSessionId: existing.authorizedSessionId,
      toolName: existing.toolName, riskClass: existing.riskClass,
      targetFingerprint: existing.targetFingerprint, targetPreview: existing.targetPreview,
      requestedAt: existing.requestedAt, expiresAt: existing.expiresAt
    }, {
      taskId: link.taskId, planRevisionId: link.planRevisionId, stepId: link.stepId,
      attemptId: link.attemptId, authorizedSessionId: link.authorizedSessionId,
      toolName: link.toolName, riskClass: link.riskClass,
      targetFingerprint: link.targetFingerprint, targetPreview: link.targetPreview,
      requestedAt: link.requestedAt, expiresAt: link.expiresAt
    });
    const allowed: Record<TaskApprovalLink["status"], readonly TaskApprovalLink["status"][]> = {
      requesting: ["pending", "denied", "expired"], pending: ["approved", "denied", "expired"],
      approved: ["consumed"], denied: [], expired: [], consumed: []
    };
    if (existing.status !== link.status && !allowed[existing.status].includes(link.status)) {
      throw new TaskStoreIntegrityError(`Illegal Task approval transition: ${existing.status} -> ${link.status}.`);
    }
    const result = this.#db.query(
      `update task_approval_links set pending_approval_id = ?, status = ?, updated_at = ?,
       resolved_at = ?, consumed_at = ? where id = ? and profile_id = ?`
    ).run(link.pendingApprovalId ?? null, link.status, link.updatedAt, link.resolvedAt ?? null,
      link.consumedAt ?? null, link.id, this.#profileId);
    this.#assertChanged(result.changes, "TaskApprovalLink", link.id);
  }

  getApprovalLink(id: string): TaskApprovalLink | null {
    const row = this.#db.query<ApprovalLinkRow>(
      "select * from task_approval_links where id = ? and profile_id = ?"
    ).get(id, this.#profileId);
    return row === null ? null : rowToApprovalLink(row);
  }

  listApprovalLinks(options: ListTaskApprovalLinksOptions = {}): TaskApprovalLink[] {
    let sql = "select * from task_approval_links where profile_id = ?";
    const params: SQLiteValue[] = [this.#profileId];
    if (options.taskId !== undefined) { sql += " and task_id = ?"; params.push(options.taskId); }
    if (options.attemptId !== undefined) { sql += " and attempt_id = ?"; params.push(options.attemptId); }
    const statuses = [...(options.statuses ?? [])];
    if (statuses.length > 0) {
      sql += ` and status in (${statuses.map(() => "?").join(", ")})`;
      params.push(...statuses);
    }
    sql += " order by requested_at, id limit ?";
    params.push(boundedLimit(options.limit));
    return this.#db.query<ApprovalLinkRow>(sql).all(...params).map(rowToApprovalLink);
  }

  createDeliveryBinding(binding: TaskDeliveryBinding): void {
    this.#assertTransactionActive();
    this.#assertProfile(binding.profileId, "TaskDeliveryBinding", binding.id);
    this.#assertTaskOwned(binding.taskId);
    this.#assertSessionOwned(binding.authorizedSessionId);
    if (binding.status !== "pending" || binding.startedAt !== undefined || binding.deliveredAt !== undefined ||
        binding.failedAt !== undefined || binding.failureClass !== undefined || binding.failureMessage !== undefined) {
      throw new TaskStoreIntegrityError("A new Task Delivery binding must start pending without settlement metadata.");
    }
    requireBoundedText(binding.id, "Task Delivery ID", 256);
    requireBoundedText(binding.deliveryKey, "Task Delivery key", 256);
    requireBoundedText(binding.authorizedSessionId, "Task Delivery authorized session ID", 256);
    if (!isTaskDeliveryDestination(binding.destination) || Buffer.byteLength(stringify(binding.destination), "utf8") > 2_048) {
      throw new TaskStoreIntegrityError("Task Delivery destination is invalid or exceeds its persistence limit.");
    }
    const linked = this.listSessionLinks(binding.taskId)
      .some((link) => link.sessionId === binding.authorizedSessionId && link.relationship !== "worker");
    if (!linked) {
      throw new TaskStoreProfileError(
        this.#profileId,
        `Session ${binding.authorizedSessionId} is not authorized for Task ${binding.taskId}.`
      );
    }
    assertTimestamp(binding.createdAt, "Task Delivery creation");
    assertTimestamp(binding.updatedAt, "Task Delivery update");
    this.#db.query(
      `insert into task_delivery_bindings (
        id, profile_id, task_id, authorized_session_id, delivery_key, destination_json,
        status, failure_class, failure_message, created_at, updated_at, started_at,
        delivered_at, failed_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(...deliveryBindingValues(binding));
  }

  getDeliveryBinding(id: string): TaskDeliveryBinding | null {
    const row = this.#db.query<DeliveryBindingRow>(
      "select * from task_delivery_bindings where id = ? and profile_id = ?"
    ).get(id, this.#profileId);
    return row === null ? null : rowToDeliveryBinding(row);
  }

  listDeliveryBindings(options: ListTaskDeliveryBindingsOptions = {}): TaskDeliveryBinding[] {
    const statuses = [...(options.statuses ?? [])];
    let sql = "select * from task_delivery_bindings where profile_id = ?";
    const params: SQLiteValue[] = [this.#profileId];
    if (options.taskId !== undefined) {
      if (this.getTask(options.taskId) === null) return [];
      sql += " and task_id = ?";
      params.push(options.taskId);
    }
    if (statuses.length > 0) {
      sql += ` and status in (${statuses.map(() => "?").join(", ")})`;
      params.push(...statuses);
    }
    sql += " order by updated_at, id limit ?";
    params.push(boundedLimit(options.limit));
    return this.#db.query<DeliveryBindingRow>(sql).all(...params).map(rowToDeliveryBinding);
  }

  claimDeliveryBinding(id: string, startedAt: string): TaskDeliveryBinding | null {
    assertTimestamp(startedAt, "Task Delivery start");
    return this.atomicWrite(() => {
      const binding = this.getDeliveryBinding(id);
      if (binding === null || binding.status !== "pending") return null;
      const task = this.getTask(binding.taskId);
      if (task === null || !isTerminalTaskStatus(task.status)) return null;
      const result = this.#db.query(
        `update task_delivery_bindings set status = 'delivering', started_at = ?, updated_at = ?
         where id = ? and profile_id = ? and status = 'pending'`
      ).run(startedAt, startedAt, id, this.#profileId);
      if (result.changes !== 1) return null;
      return this.getDeliveryBinding(id);
    });
  }

  settleDeliveryBinding(input: SettleTaskDeliveryInput): TaskDeliveryBinding {
    assertTimestamp(input.settledAt, "Task Delivery settlement");
    return this.atomicWrite(() => {
      const binding = this.getDeliveryBinding(input.id);
      if (binding === null || binding.status !== "delivering") {
        throw new TaskStoreIntegrityError(`Task Delivery ${input.id} is not in delivering state.`);
      }
      if (input.status === "delivered" && (input.failureClass !== undefined || input.failureMessage !== undefined)) {
        throw new TaskStoreIntegrityError("A delivered Task Delivery cannot carry failure metadata.");
      }
      if (input.status === "failed" && input.failureClass === undefined) {
        throw new TaskStoreIntegrityError("A failed Task Delivery requires a bounded failure class.");
      }
      if (input.failureClass !== undefined) requireBoundedText(input.failureClass, "Task Delivery failure class", 128);
      if (input.failureMessage !== undefined) requireBoundedText(input.failureMessage, "Task Delivery failure message", 1_000);
      const updated = this.#db.query(
        `update task_delivery_bindings set
          status = ?, failure_class = ?, failure_message = ?, updated_at = ?,
          delivered_at = ?, failed_at = ?
         where id = ? and profile_id = ? and status = 'delivering'`
      ).run(
        input.status,
        input.failureClass ?? null,
        input.failureMessage ?? null,
        input.settledAt,
        input.status === "delivered" ? input.settledAt : null,
        input.status === "failed" ? input.settledAt : null,
        input.id,
        this.#profileId
      );
      this.#assertChanged(updated.changes, "TaskDeliveryBinding", input.id);
      return this.getDeliveryBinding(input.id)!;
    });
  }

  retryDeliveryBinding(id: string, retriedAt: string): TaskDeliveryBinding {
    assertTimestamp(retriedAt, "Task Delivery retry");
    return this.atomicWrite(() => {
      const binding = this.getDeliveryBinding(id);
      if (binding === null || binding.status !== "failed") {
        throw new TaskStoreIntegrityError(`Task Delivery ${id} is not in failed state.`);
      }
      if (binding.failureClass === "delivery-outcome-unknown") {
        throw new TaskStoreIntegrityError("A Task Delivery with an ambiguous external outcome cannot be retried.");
      }
      if (binding.failureClass !== "delivery-failed" && binding.failureClass !== "delivery-preparation-failed") {
        throw new TaskStoreIntegrityError("This Task Delivery failure class is not safely retryable.");
      }
      const updated = this.#db.query(
        `update task_delivery_bindings set
          status = 'pending', failure_class = null, failure_message = null,
          updated_at = ?, started_at = null, delivered_at = null, failed_at = null
         where id = ? and profile_id = ? and status = 'failed'
           and failure_class in ('delivery-failed', 'delivery-preparation-failed')`
      ).run(retriedAt, id, this.#profileId);
      this.#assertChanged(updated.changes, "TaskDeliveryBinding", id);
      return this.getDeliveryBinding(id)!;
    });
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
        objective, executor_json, child_task_policy, authority_policy_json, budget_json, retry_policy_json,
        failure_policy_json, idempotency, result_policy_json, created_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      step.childTaskPolicy,
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
    childTaskPolicy: step.childTaskPolicy,
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
    task.rootTaskId,
    task.originSessionId,
    task.originTurnId ?? null,
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

function approvalLinkValues(link: TaskApprovalLink): SQLiteValue[] {
  return [
    link.id,
    link.profileId,
    link.taskId,
    link.planRevisionId,
    link.stepId,
    link.attemptId,
    link.authorizedSessionId,
    link.pendingApprovalId ?? null,
    link.toolName,
    link.riskClass,
    link.targetFingerprint,
    link.targetPreview,
    link.status,
    link.requestedAt,
    link.expiresAt,
    link.updatedAt,
    link.resolvedAt ?? null,
    link.consumedAt ?? null
  ];
}

function deliveryBindingValues(binding: TaskDeliveryBinding): SQLiteValue[] {
  return [
    binding.id,
    binding.profileId,
    binding.taskId,
    binding.authorizedSessionId,
    binding.deliveryKey,
    stringify(binding.destination),
    binding.status,
    binding.failureClass ?? null,
    binding.failureMessage ?? null,
    binding.createdAt,
    binding.updatedAt,
    binding.startedAt ?? null,
    binding.deliveredAt ?? null,
    binding.failedAt ?? null
  ];
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    profileId: row.profile_id,
    ...(row.creator_session_id === null ? {} : { creatorSessionId: row.creator_session_id }),
    rootTaskId: requirePersistedLineage(row.root_task_id, "Task.rootTaskId"),
    originSessionId: requirePersistedLineage(row.origin_session_id, "Task.originSessionId"),
    ...(row.origin_turn_id === null ? {} : { originTurnId: row.origin_turn_id }),
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
    childTaskPolicy: row.child_task_policy as TaskStep["childTaskPolicy"],
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

function rowToLease(row: LeaseRow): TaskAttemptLease {
  return {
    attemptId: row.attempt_id,
    profileId: row.profile_id,
    taskId: row.task_id,
    ownerId: row.owner_id,
    fencingToken: row.fencing_token,
    acquiredAt: row.acquired_at,
    heartbeatAt: row.heartbeat_at,
    expiresAt: row.expires_at,
    ...(row.cancellation_requested_at === null
      ? {}
      : { cancellationRequestedAt: row.cancellation_requested_at })
  };
}

function rowToTaskHostLease(row: TaskHostLeaseRow): TaskHostLease {
  return {
    taskId: row.task_id,
    profileId: row.profile_id,
    workspaceIdentityHash: row.workspace_identity_hash,
    ownerId: row.owner_id,
    kind: row.owner_kind as TaskHostKind,
    fencingToken: row.fencing_token,
    acquiredAt: row.acquired_at,
    heartbeatAt: row.heartbeat_at,
    expiresAt: row.expires_at
  };
}

function rowToBudgetReservation(row: BudgetReservationRow): TaskBudgetReservation {
  return {
    profileId: row.profile_id,
    childTaskId: row.child_task_id,
    rootTaskId: row.root_task_id,
    parentTaskId: row.parent_task_id,
    parentStepId: row.parent_step_id,
    parentAttemptId: row.parent_attempt_id,
    budget: {
      maxConcurrentAttempts: row.max_concurrent_attempts,
      maxProviderCalls: row.max_provider_calls,
      maxTotalTokens: row.max_total_tokens,
      maxEstimatedCostUsd: row.max_estimated_cost_usd,
      maxWallClockMs: row.max_wall_clock_ms
    },
    createdAt: row.created_at
  };
}

function rowToApprovalLink(row: ApprovalLinkRow): TaskApprovalLink {
  return {
    id: row.id,
    profileId: row.profile_id,
    taskId: row.task_id,
    planRevisionId: row.plan_revision_id,
    stepId: row.step_id,
    attemptId: row.attempt_id,
    authorizedSessionId: row.authorized_session_id,
    ...(row.pending_approval_id === null ? {} : { pendingApprovalId: row.pending_approval_id }),
    toolName: row.tool_name,
    riskClass: row.risk_class as TaskApprovalLink["riskClass"],
    targetFingerprint: row.target_fingerprint,
    targetPreview: row.target_preview,
    status: row.status as TaskApprovalLink["status"],
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
    updatedAt: row.updated_at,
    ...(row.resolved_at === null ? {} : { resolvedAt: row.resolved_at }),
    ...(row.consumed_at === null ? {} : { consumedAt: row.consumed_at })
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

function rowToGuidance(row: GuidanceRow): TaskGuidance {
  return {
    id: row.id,
    profileId: row.profile_id,
    taskId: row.task_id,
    authorizedSessionId: row.authorized_session_id,
    guidance: row.guidance,
    createdAt: row.created_at
  };
}

function rowToDeliveryBinding(row: DeliveryBindingRow): TaskDeliveryBinding {
  return {
    id: row.id,
    profileId: row.profile_id,
    taskId: row.task_id,
    authorizedSessionId: row.authorized_session_id,
    deliveryKey: row.delivery_key,
    destination: parseJson(row.destination_json, "TaskDeliveryBinding.destination"),
    status: row.status as TaskDeliveryBinding["status"],
    ...(row.failure_class === null ? {} : { failureClass: row.failure_class }),
    ...(row.failure_message === null ? {} : { failureMessage: row.failure_message }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.delivered_at === null ? {} : { deliveredAt: row.delivered_at }),
    ...(row.failed_at === null ? {} : { failedAt: row.failed_at })
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

function requireBoundedText(value: string, label: string, maxChars: number): string {
  const normalized = requireNonEmpty(value, label);
  if (normalized.length > maxChars || /[\u0000-\u001F\u007F]/u.test(normalized)) {
    throw new TaskStoreIntegrityError(`${label} is invalid or exceeds ${maxChars} characters.`);
  }
  return normalized;
}

function requirePersistedLineage(value: string | null, label: string): string {
  if (value === null) throw new TaskStoreIntegrityError(`Stored ${label} is missing.`);
  return requireBoundedText(value, label, 256);
}

function requireBoundedContent(value: string, label: string, maxChars: number): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxChars || /\u0000/u.test(normalized)) {
    throw new TaskStoreIntegrityError(`${label} is invalid or exceeds ${maxChars} characters.`);
  }
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

function assertTaskHostKind(kind: string): asserts kind is TaskHostKind {
  if (kind !== "foreground" && kind !== "background") {
    throw new TaskStoreIntegrityError("Task host kind must be foreground or background.");
  }
}

function assertFencingToken(token: number, label: string): void {
  if (!Number.isSafeInteger(token) || token < 1) {
    throw new TaskStoreIntegrityError(`${label} fencing token is invalid.`);
  }
}

function assertBudgetPolicy(budget: TaskBudgetPolicy, label: string): void {
  if (!Number.isSafeInteger(budget.maxConcurrentAttempts) || budget.maxConcurrentAttempts < 1 ||
      !Number.isSafeInteger(budget.maxProviderCalls) || budget.maxProviderCalls < 0 ||
      !Number.isSafeInteger(budget.maxTotalTokens) || budget.maxTotalTokens < 0 ||
      !Number.isFinite(budget.maxEstimatedCostUsd) || budget.maxEstimatedCostUsd < 0 ||
      !Number.isSafeInteger(budget.maxWallClockMs) || budget.maxWallClockMs < 1) {
    throw new TaskStoreIntegrityError(`${label} is invalid.`);
  }
}

type ConsumableBudget = Pick<TaskBudgetPolicy, "maxProviderCalls" | "maxTotalTokens" | "maxEstimatedCostUsd">;

function sumAttemptBudgetUsage(attempts: readonly TaskAttempt[]): ConsumableBudget {
  return attempts.reduce<ConsumableBudget>((total, attempt) => ({
    maxProviderCalls: total.maxProviderCalls + attempt.usage.providerCalls,
    maxTotalTokens: total.maxTotalTokens + attempt.usage.totalTokens,
    maxEstimatedCostUsd: total.maxEstimatedCostUsd + attempt.usage.estimatedCostUsd
  }), emptyConsumableBudget());
}

function sumReservedBudget(reservations: readonly TaskBudgetReservation[]): ConsumableBudget {
  return reservations.reduce<ConsumableBudget>((total, reservation) => ({
    maxProviderCalls: total.maxProviderCalls + reservation.budget.maxProviderCalls,
    maxTotalTokens: total.maxTotalTokens + reservation.budget.maxTotalTokens,
    maxEstimatedCostUsd: total.maxEstimatedCostUsd + reservation.budget.maxEstimatedCostUsd
  }), emptyConsumableBudget());
}

function emptyConsumableBudget(): ConsumableBudget {
  return { maxProviderCalls: 0, maxTotalTokens: 0, maxEstimatedCostUsd: 0 };
}

function reservationFits(
  usage: ConsumableBudget,
  reserved: ConsumableBudget,
  requested: TaskBudgetPolicy,
  ceiling: ConsumableBudget
): boolean {
  return usage.maxProviderCalls + reserved.maxProviderCalls + requested.maxProviderCalls <= ceiling.maxProviderCalls &&
    usage.maxTotalTokens + reserved.maxTotalTokens + requested.maxTotalTokens <= ceiling.maxTotalTokens &&
    usage.maxEstimatedCostUsd + reserved.maxEstimatedCostUsd + requested.maxEstimatedCostUsd <=
      ceiling.maxEstimatedCostUsd;
}

function assertApprovalLink(link: TaskApprovalLink): void {
  requireBoundedText(link.id, "Task approval ID", 256);
  requireBoundedText(link.authorizedSessionId, "Task approval authorized session ID", 256);
  requireBoundedText(link.toolName, "Task approval tool name", 256);
  requireBoundedText(link.targetPreview, "Task approval target preview", 500);
  if (!/^sha256:[a-f0-9]{64}$/u.test(link.targetFingerprint)) {
    throw new TaskStoreIntegrityError("Task approval target fingerprint is invalid.");
  }
  assertTimestamp(link.requestedAt, "Task approval request");
  assertTimestamp(link.expiresAt, "Task approval expiry");
  assertTimestamp(link.updatedAt, "Task approval update");
  if (Date.parse(link.expiresAt) <= Date.parse(link.requestedAt)) {
    throw new TaskStoreIntegrityError("Task approval expiry must be later than its request.");
  }
  if (link.resolvedAt !== undefined) assertTimestamp(link.resolvedAt, "Task approval resolution");
  if (link.consumedAt !== undefined) assertTimestamp(link.consumedAt, "Task approval consumption");
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
  root_task_id: string | null;
  origin_session_id: string | null;
  origin_turn_id: string | null;
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
  child_task_policy: string;
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
  lease_generation: number;
};

type LeaseRow = {
  attempt_id: string;
  profile_id: string;
  task_id: string;
  owner_id: string;
  fencing_token: number;
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
  cancellation_requested_at: string | null;
};

type TaskHostLeaseRow = {
  task_id: string;
  profile_id: string;
  workspace_identity_hash: string;
  owner_id: string;
  owner_kind: string;
  fencing_token: number;
  acquired_at: string;
  heartbeat_at: string;
  expires_at: string;
};

type BudgetReservationRow = {
  child_task_id: string;
  profile_id: string;
  root_task_id: string;
  parent_task_id: string;
  parent_step_id: string;
  parent_attempt_id: string;
  max_concurrent_attempts: number;
  max_provider_calls: number;
  max_total_tokens: number;
  max_estimated_cost_usd: number;
  max_wall_clock_ms: number;
  created_at: string;
};

type ApprovalLinkRow = {
  id: string;
  profile_id: string;
  task_id: string;
  plan_revision_id: string;
  step_id: string;
  attempt_id: string;
  authorized_session_id: string;
  pending_approval_id: string | null;
  tool_name: string;
  risk_class: string;
  target_fingerprint: string;
  target_preview: string;
  status: string;
  requested_at: string;
  expires_at: string;
  updated_at: string;
  resolved_at: string | null;
  consumed_at: string | null;
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

type GuidanceRow = {
  id: string;
  profile_id: string;
  task_id: string;
  authorized_session_id: string;
  guidance: string;
  created_at: string;
};

type DeliveryBindingRow = {
  id: string;
  profile_id: string;
  task_id: string;
  authorized_session_id: string;
  delivery_key: string;
  destination_json: string;
  status: string;
  failure_class: string | null;
  failure_message: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  delivered_at: string | null;
  failed_at: string | null;
};
