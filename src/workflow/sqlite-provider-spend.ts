import { createHash } from "node:crypto";
import type { SpendingLimit } from "../contracts/budget.js";
import { assertSpendingLimit } from "../contracts/budget.js";
import type { ProviderUsageEntry } from "../contracts/provider-usage.js";
import type {
  ProviderSpendAllocation,
  ProviderSpendAttempt,
  ProviderSpendDenialReason,
  ProviderSpendRequest,
  ProviderSpendReservationResult,
  ProviderSpendScopeKind,
  ProviderSpendingScope
} from "../contracts/provider-spend.js";
import { assertProviderSpendRequest } from "../contracts/provider-spend.js";
import type { SQLiteDatabase } from "../storage/sqlite.js";
import {
  insertProviderUsageEntry,
  providerUsageLineageIsValid
} from "./sqlite-provider-usage.js";

const BALANCE_EPSILON_USD = 1e-9;
const RECOVERY_UNCERTAINTY_REASON = "dispatch-outcome-unknown-after-recovery";
const TERMINAL_SYNTHESIS_STEP_STATUSES = new Set(["completed", "failed", "skipped", "cancelled"]);

export class ProviderSpendIntegrityError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProviderSpendIntegrityError";
  }
}

export type ProviderSpendBalanceIssue = {
  profileId: string;
  scopeKind?: ProviderSpendScopeKind;
  scopeOwnerId?: string;
  requestKey?: string;
  code:
    | "MATERIALIZED_RESERVED_MISMATCH"
    | "MATERIALIZED_SPENT_MISMATCH"
    | "MATERIALIZED_STATE_MISMATCH"
    | "SETTLED_USAGE_MISSING"
    | "SETTLED_COST_MISMATCH";
  expected?: number | string;
  actual?: number | string;
};

export type ProviderSpendRecoveryResult = {
  releasedRequestKeys: readonly string[];
  uncertainRequestKeys: readonly string[];
};

type ScopeSource = {
  kind: ProviderSpendScopeKind;
  ownerId: string;
  limit: SpendingLimit;
  ownerCreatedAt: string;
};

/** Durable, profile-scoped controller for provider spend reservations and settlement. */
export class SQLiteProviderSpendController {
  readonly #db: SQLiteDatabase;
  readonly #profileId: string;

  constructor(input: { db: SQLiteDatabase; profileId: string }) {
    if (input.profileId.trim().length === 0 || input.profileId.length > 128) {
      throw new ProviderSpendIntegrityError("Provider spend controller profile ID is invalid.");
    }
    this.#db = input.db;
    this.#profileId = input.profileId;
    this.#db.exec("pragma foreign_keys = on");
  }

  reserve(request: ProviderSpendRequest, reservedAt: string): ProviderSpendReservationResult {
    assertProviderSpendRequest(request);
    this.#assertProfile(request.profileId);
    assertTimestamp(reservedAt, "Provider spend reservation");

    return this.#write(() => {
      const resolved = this.#resolveRequestAndScopes(request);
      const persisted = this.#selectAttempt(resolved.request.requestKey);
      if (persisted !== null) {
        if (stableJson(persisted.request) !== stableJson(resolved.request)) {
          throw new ProviderSpendIntegrityError(
            `Provider spend request key ${request.requestKey} conflicts with another request.`
          );
        }
        return { ok: true, attempt: persisted };
      }

      const scopes = resolved.scopes.map((source) => this.#ensureScope(source, reservedAt));
      for (const scope of scopes) {
        this.#assertScopeBalance(scope);
        const denial = reservationDenial(
          scope,
          resolved.request.maximumEstimatedCostUsd,
          this.#synthesisEarmarkUsd(scope, resolved.request)
        );
        if (denial !== undefined) return denial;
      }

      const id = spendAttemptId(this.#profileId, resolved.request.requestKey);
      this.#db.query(
        `insert into provider_spend_attempts (
          id, profile_id, request_key, attribution_json, provider, model,
          pricing_snapshot_json, pricing_fingerprint, maximum_estimated_exposure_usd,
          state, reserved_cost_usd, created_at, reserved_at
        ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?)`
      ).run(
        id,
        this.#profileId,
        resolved.request.requestKey,
        stableJson(resolved.request),
        resolved.request.provider,
        resolved.request.model,
        stableJson(resolved.request.pricing),
        resolved.request.pricing.fingerprint,
        resolved.request.maximumEstimatedCostUsd,
        resolved.request.maximumEstimatedCostUsd,
        reservedAt,
        reservedAt
      );

      for (const scope of scopes) {
        this.#db.query(
          `insert into provider_spend_scope_allocations (
            profile_id, request_key, scope_kind, scope_owner_id, reserved_cost_usd, created_at
          ) values (?, ?, ?, ?, ?, ?)`
        ).run(
          this.#profileId,
          resolved.request.requestKey,
          scope.kind,
          scope.ownerId,
          resolved.request.maximumEstimatedCostUsd,
          reservedAt
        );
        this.#db.query(
          `update provider_spending_scopes
           set reserved_cost_usd = reserved_cost_usd + ?
           where profile_id = ? and kind = ? and owner_id = ?`
        ).run(resolved.request.maximumEstimatedCostUsd, this.#profileId, scope.kind, scope.ownerId);
        this.#refreshScopeState(scope.kind, scope.ownerId, reservedAt);
      }

      return { ok: true, attempt: this.#requireAttempt(resolved.request.requestKey) };
    });
  }

  markDispatching(requestKey: string, dispatchingAt: string): ProviderSpendAttempt {
    requireText(requestKey, "Provider spend request key", 512);
    assertTimestamp(dispatchingAt, "Provider spend dispatch");
    return this.#write(() => {
      const attempt = this.#requireAttempt(requestKey);
      if (attempt.state === "dispatching") return attempt;
      if (attempt.state !== "reserved") {
        throw new ProviderSpendIntegrityError(
          `Provider spend Attempt ${requestKey} cannot dispatch from ${attempt.state}.`
        );
      }
      assertNotBefore(dispatchingAt, attempt.reservedAt, "Provider spend dispatch");
      this.#db.query(
        `update provider_spend_attempts set state = 'dispatching', dispatching_at = ?
         where profile_id = ? and request_key = ? and state = 'reserved'`
      ).run(dispatchingAt, this.#profileId, requestKey);
      return this.#requireAttempt(requestKey);
    });
  }

  releaseBeforeDispatch(requestKey: string, releasedAt: string): ProviderSpendAttempt {
    requireText(requestKey, "Provider spend request key", 512);
    assertTimestamp(releasedAt, "Provider spend release");
    return this.#write(() => {
      const attempt = this.#requireAttempt(requestKey);
      if (attempt.state === "released") return attempt;
      if (attempt.state !== "reserved") {
        throw new ProviderSpendIntegrityError(
          `Provider spend Attempt ${requestKey} cannot be safely released from ${attempt.state}.`
        );
      }
      assertNotBefore(releasedAt, attempt.reservedAt, "Provider spend release");
      this.#releaseReservedAttempt(attempt, releasedAt);
      return this.#requireAttempt(requestKey);
    });
  }

  settle(requestKey: string, usage: ProviderUsageEntry, settledAt: string): ProviderSpendAttempt {
    requireText(requestKey, "Provider spend request key", 512);
    assertTimestamp(settledAt, "Provider spend settlement");
    return this.#write(() => {
      const attempt = this.#requireAttempt(requestKey);
      this.#assertUsageMatchesAttempt(attempt, usage);
      if (attempt.state === "settled") {
        if (attempt.usageEntryId !== usage.id ||
            !amountsEqual(attempt.actualEstimatedCostUsd!, usage.estimatedCostUsd)) {
          throw new ProviderSpendIntegrityError(`Provider spend settlement ${requestKey} conflicts with persisted usage.`);
        }
        insertProviderUsageEntry(this.#db, usage);
        return attempt;
      }
      if (attempt.state !== "dispatching") {
        throw new ProviderSpendIntegrityError(
          `Provider spend Attempt ${requestKey} cannot settle from ${attempt.state}.`
        );
      }

      assertNotBefore(settledAt, attempt.dispatchingAt!, "Provider spend settlement");
      this.#assertAllocationsBalanced(attempt);
      insertProviderUsageEntry(this.#db, usage);
      this.#db.query(
        `update provider_spend_attempts
         set state = 'settled', actual_estimated_cost_usd = ?, usage_entry_id = ?, settled_at = ?
         where profile_id = ? and request_key = ? and state = 'dispatching'`
      ).run(usage.estimatedCostUsd, usage.id, settledAt, this.#profileId, requestKey);

      for (const allocation of attempt.allocations) {
        this.#moveReservedToSpent(allocation, usage.estimatedCostUsd, settledAt);
      }
      return this.#requireAttempt(requestKey);
    });
  }

  recoverStale(input: {
    reservedBefore: string;
    dispatchingBefore: string;
    recoveredAt: string;
  }): ProviderSpendRecoveryResult {
    assertTimestamp(input.reservedBefore, "Stale reservation cutoff");
    assertTimestamp(input.dispatchingBefore, "Stale dispatch cutoff");
    assertTimestamp(input.recoveredAt, "Provider spend recovery");
    assertNotBefore(input.recoveredAt, input.reservedBefore, "Provider spend recovery");
    assertNotBefore(input.recoveredAt, input.dispatchingBefore, "Provider spend recovery");
    return this.#write(() => {
      const reserved = this.#db.query<{ request_key: string }>(
        `select request_key from provider_spend_attempts
         where profile_id = ? and state = 'reserved' and julianday(reserved_at) < julianday(?)
         order by reserved_at, request_key`
      ).all(this.#profileId, input.reservedBefore).map((row) => row.request_key);
      const dispatching = this.#db.query<{ request_key: string }>(
        `select request_key from provider_spend_attempts
         where profile_id = ? and state = 'dispatching' and julianday(dispatching_at) < julianday(?)
         order by dispatching_at, request_key`
      ).all(this.#profileId, input.dispatchingBefore).map((row) => row.request_key);

      for (const requestKey of reserved) {
        this.#releaseReservedAttempt(this.#requireAttempt(requestKey), input.recoveredAt);
      }
      for (const requestKey of dispatching) {
        this.#db.query(
          `update provider_spend_attempts
           set state = 'uncertain', uncertain_at = ?, uncertainty_reason = ?
           where profile_id = ? and request_key = ? and state = 'dispatching'`
        ).run(input.recoveredAt, RECOVERY_UNCERTAINTY_REASON, this.#profileId, requestKey);
      }
      return { releasedRequestKeys: reserved, uncertainRequestKeys: dispatching };
    });
  }

  getAttempt(requestKey: string): ProviderSpendAttempt | null {
    requireText(requestKey, "Provider spend request key", 512);
    return this.#selectAttempt(requestKey);
  }

  getScope(kind: ProviderSpendScopeKind, ownerId: string): ProviderSpendingScope | null {
    assertScopeKind(kind);
    requireText(ownerId, "Provider spending scope owner ID", 256);
    const row = this.#db.query<SpendingScopeRow>(
      `select * from provider_spending_scopes
       where profile_id = ? and kind = ? and owner_id = ?`
    ).get(this.#profileId, kind, ownerId);
    return row === null ? null : rowToScope(row);
  }

  verifyMaterializedBalances(): ProviderSpendBalanceIssue[] {
    return this.#write(() => this.#balanceIssues());
  }

  rebuildMaterializedBalances(rebuiltAt: string): ProviderSpendingScope[] {
    assertTimestamp(rebuiltAt, "Provider spend balance rebuild");
    return this.#write(() => {
      const sourceIssues = this.#balanceIssues().filter((issue) =>
        issue.code === "SETTLED_USAGE_MISSING" || issue.code === "SETTLED_COST_MISMATCH"
      );
      if (sourceIssues.length > 0) {
        throw new ProviderSpendIntegrityError(
          "Provider spend balances cannot be rebuilt while settled usage facts are inconsistent."
        );
      }
      const scopes = this.#listScopes();
      for (const scope of scopes) {
        const expected = this.#expectedScopeBalance(scope.kind, scope.ownerId);
        this.#db.query(
          `update provider_spending_scopes set spent_cost_usd = ?, reserved_cost_usd = ?
           where profile_id = ? and kind = ? and owner_id = ?`
        ).run(expected.spent, expected.reserved, this.#profileId, scope.kind, scope.ownerId);
        this.#refreshScopeState(scope.kind, scope.ownerId, rebuiltAt);
      }
      return this.#listScopes();
    });
  }

  #resolveRequestAndScopes(request: ProviderSpendRequest): {
    request: ProviderSpendRequest;
    scopes: ScopeSource[];
  } {
    const scopes: ScopeSource[] = [];
    let sessionBudgetScopeId: string | undefined;
    if (request.executionSessionId !== undefined) {
      const execution = this.#db.query<SessionSpendRow>(
        `select id, spending_scope_session_id, spending_limit_json, created_at
         from sessions where profile_id = ? and id = ?`
      ).get(this.#profileId, request.executionSessionId);
      if (execution === null) {
        throw new ProviderSpendIntegrityError("Provider spend execution Session was not found in this profile.");
      }
      sessionBudgetScopeId = execution.spending_scope_session_id ?? undefined;
      if (request.sessionBudgetScopeId !== undefined && request.sessionBudgetScopeId !== sessionBudgetScopeId) {
        throw new ProviderSpendIntegrityError("Provider spend Session scope does not match the execution Session.");
      }
      if (sessionBudgetScopeId !== undefined) {
        const owner = this.#db.query<SessionSpendRow>(
          `select id, spending_scope_session_id, spending_limit_json, created_at
           from sessions where profile_id = ? and id = ?`
        ).get(this.#profileId, sessionBudgetScopeId);
        if (owner === null || owner.spending_scope_session_id !== owner.id || owner.spending_limit_json === null ||
            owner.spending_limit_json !== execution.spending_limit_json) {
          throw new ProviderSpendIntegrityError("Provider spend Session scope owner is invalid.");
        }
        scopes.push({
          kind: "session",
          ownerId: owner.id,
          limit: parseSpendingLimit(owner.spending_limit_json),
          ownerCreatedAt: owner.created_at
        });
      }
    } else if (request.sessionBudgetScopeId !== undefined) {
      throw new ProviderSpendIntegrityError("Provider spend Session scope requires an execution Session.");
    }

    if (request.taskId !== undefined) {
      const task = this.#db.query<TaskSpendRow>(
        `select task.root_task_id, root.id as root_id, root.spending_limit_json, root.created_at
         from tasks task
         join tasks root on root.profile_id = task.profile_id and root.id = task.root_task_id
         join task_attempts attempt on attempt.profile_id = task.profile_id
           and attempt.task_id = task.id and attempt.plan_revision_id = ?
           and attempt.step_id = ? and attempt.id = ?
         where task.profile_id = ? and task.id = ?`
      ).get(request.planRevisionId!, request.stepId!, request.attemptId!, this.#profileId, request.taskId);
      if (task === null || task.root_task_id !== request.rootTaskId || task.root_id !== request.rootTaskId) {
        throw new ProviderSpendIntegrityError("Provider spend Task leaf or root attribution is invalid.");
      }
      if (task.spending_limit_json !== null) {
        scopes.push({
          kind: "root_task",
          ownerId: task.root_id,
          limit: parseSpendingLimit(task.spending_limit_json),
          ownerCreatedAt: task.created_at
        });
      }
    }

    const normalized = sessionBudgetScopeId === undefined
      ? { ...request, sessionBudgetScopeId: undefined }
      : { ...request, sessionBudgetScopeId };
    if (!providerUsageLineageIsValid(this.#db, {
      profileId: normalized.profileId,
      sessionId: normalized.executionSessionId,
      sessionBudgetScopeId: normalized.sessionBudgetScopeId,
      visibleTurnId: normalized.visibleTurnId,
      sourceKind: normalized.sourceKind
    })) {
      throw new ProviderSpendIntegrityError("Provider spend Session or visible-turn lineage is invalid.");
    }
    return { request: normalized, scopes };
  }

  #ensureScope(source: ScopeSource, createdAt: string): ProviderSpendingScope {
    assertSpendingLimit(source.limit);
    const initialState = scopeState(0, 0, source.limit.maxEstimatedCostUsd, source.limit.warningThresholdPercent);
    this.#db.query(
      `insert into provider_spending_scopes (
        profile_id, kind, owner_id, max_estimated_cost_usd, warning_threshold_percent,
        state, owner_created_at, created_at, warning_reached_at, exhausted_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(profile_id, kind, owner_id) do nothing`
    ).run(
      this.#profileId,
      source.kind,
      source.ownerId,
      source.limit.maxEstimatedCostUsd,
      source.limit.warningThresholdPercent,
      initialState,
      source.ownerCreatedAt,
      createdAt,
      initialState === "available" ? null : createdAt,
      initialState === "exhausted" ? createdAt : null
    );
    const scope = this.getScope(source.kind, source.ownerId);
    if (scope === null || !amountsEqual(scope.maxEstimatedCostUsd, source.limit.maxEstimatedCostUsd) ||
        !amountsEqual(scope.warningThresholdPercent, source.limit.warningThresholdPercent) ||
        scope.ownerCreatedAt !== source.ownerCreatedAt) {
      throw new ProviderSpendIntegrityError("Persisted provider spending scope conflicts with its immutable owner policy.");
    }
    return scope;
  }

  #assertScopeBalance(scope: ProviderSpendingScope): void {
    const expected = this.#expectedScopeBalance(scope.kind, scope.ownerId);
    if (!amountsEqual(scope.spentCostUsd, expected.spent) ||
        !amountsEqual(scope.reservedCostUsd, expected.reserved)) {
      throw new ProviderSpendIntegrityError(
        `Provider spending scope ${scope.kind}:${scope.ownerId} has inconsistent materialized balances.`
      );
    }
  }

  /**
   * Protects fixed-plan synthesis using its proportional execution share. The earmark is
   * inside the immutable root-Task limit and is waived only for the synthesis request
   * that is consuming it. Session admission also honors earmarks from budgeted root Tasks.
   */
  #synthesisEarmarkUsd(scope: ProviderSpendingScope, request: ProviderSpendRequest): number {
    const roots = scope.kind === "root_task"
      ? this.#db.query<SynthesisRootRow>(
          `select id, spending_limit_json from tasks
           where profile_id = ? and id = ? and root_task_id = id`
        ).all(this.#profileId, scope.ownerId)
      : this.#db.query<SynthesisRootRow>(
          `select task.id, task.spending_limit_json from tasks task
           join sessions origin on origin.profile_id = task.profile_id and origin.id = task.origin_session_id
           where task.profile_id = ? and task.root_task_id = task.id
             and (task.origin_session_id = ? or origin.spending_scope_session_id = ?)
             and task.spending_limit_json is not null
             and task.status in ('planning', 'queued', 'running', 'waiting_for_host',
               'waiting_for_input', 'waiting_for_approval', 'paused')`
        ).all(this.#profileId, scope.ownerId, scope.ownerId);
    let totalEarmark = 0;
    for (const root of roots) {
      if (root.spending_limit_json === null) continue;
      const rootLimit = parseSpendingLimit(root.spending_limit_json).maxEstimatedCostUsd;
      const steps = this.#db.query<SynthesisStepRow>(
        `select step.id, step.status, step.executor_json, step.execution_limits_json
         from task_steps step
         join tasks task on task.profile_id = step.profile_id and task.id = step.task_id
         where step.profile_id = ? and task.root_task_id = ?
           and step.plan_revision_id = task.active_plan_revision_id`
      ).all(this.#profileId, root.id);
      let allTokenCapacity = 0;
      let protectedSynthesisCapacity = 0;
      for (const step of steps) {
        const executionLimits = parseExecutionLimits(step.execution_limits_json);
        allTokenCapacity += executionLimits.maxTotalTokens;
        const executor = parseTaskExecutor(step.executor_json);
        const isCurrentRequest = request.rootTaskId === root.id && request.stepId === step.id;
        if (executor.kind === "agent" && executor.role === "synthesis" &&
            !TERMINAL_SYNTHESIS_STEP_STATUSES.has(step.status) && !isCurrentRequest) {
          protectedSynthesisCapacity += executionLimits.maxTotalTokens;
        }
      }
      if (allTokenCapacity > 0 && protectedSynthesisCapacity > 0) {
        totalEarmark += rootLimit * Math.min(1, protectedSynthesisCapacity / allTokenCapacity);
      }
    }
    return Math.min(scope.maxEstimatedCostUsd, totalEarmark);
  }

  #releaseReservedAttempt(attempt: ProviderSpendAttempt, releasedAt: string): void {
    this.#assertAllocationsBalanced(attempt);
    this.#db.query(
      `update provider_spend_attempts set state = 'released', released_at = ?
       where profile_id = ? and request_key = ? and state = 'reserved'`
    ).run(releasedAt, this.#profileId, attempt.request.requestKey);
    for (const allocation of attempt.allocations) {
      this.#db.query(
        `update provider_spending_scopes
         set reserved_cost_usd = case
           when reserved_cost_usd > ? then reserved_cost_usd - ? else 0 end
         where profile_id = ? and kind = ? and owner_id = ?`
      ).run(
        allocation.reservedCostUsd,
        allocation.reservedCostUsd,
        this.#profileId,
        allocation.scopeKind,
        allocation.scopeOwnerId
      );
      this.#refreshScopeState(allocation.scopeKind, allocation.scopeOwnerId, releasedAt);
    }
  }

  #moveReservedToSpent(allocation: ProviderSpendAllocation, actualCostUsd: number, settledAt: string): void {
    this.#db.query(
      `update provider_spending_scopes
       set reserved_cost_usd = case when reserved_cost_usd > ? then reserved_cost_usd - ? else 0 end,
           spent_cost_usd = spent_cost_usd + ?
       where profile_id = ? and kind = ? and owner_id = ?`
    ).run(
      allocation.reservedCostUsd,
      allocation.reservedCostUsd,
      actualCostUsd,
      this.#profileId,
      allocation.scopeKind,
      allocation.scopeOwnerId
    );
    this.#refreshScopeState(allocation.scopeKind, allocation.scopeOwnerId, settledAt);
  }

  #assertAllocationsBalanced(attempt: ProviderSpendAttempt): void {
    for (const allocation of attempt.allocations) {
      const scope = this.getScope(allocation.scopeKind, allocation.scopeOwnerId);
      if (scope === null) {
        throw new ProviderSpendIntegrityError("Provider spend allocation scope is missing.");
      }
      this.#assertScopeBalance(scope);
      if (scope.reservedCostUsd + BALANCE_EPSILON_USD < allocation.reservedCostUsd) {
        throw new ProviderSpendIntegrityError("Provider spend allocation exceeds its materialized reservation.");
      }
    }
  }

  #refreshScopeState(kind: ProviderSpendScopeKind, ownerId: string, occurredAt: string): void {
    const scope = this.getScope(kind, ownerId);
    if (scope === null) throw new ProviderSpendIntegrityError("Provider spending scope disappeared during accounting.");
    const state = scopeState(
      scope.spentCostUsd,
      scope.reservedCostUsd,
      scope.maxEstimatedCostUsd,
      scope.warningThresholdPercent
    );
    this.#db.query(
      `update provider_spending_scopes
       set state = ?,
         warning_reached_at = case when ? <> 'available' then coalesce(warning_reached_at, ?) else warning_reached_at end,
         exhausted_at = case when ? = 'exhausted' then coalesce(exhausted_at, ?) else exhausted_at end
       where profile_id = ? and kind = ? and owner_id = ?`
    ).run(state, state, occurredAt, state, occurredAt, this.#profileId, kind, ownerId);
  }

  #assertUsageMatchesAttempt(attempt: ProviderSpendAttempt, usage: ProviderUsageEntry): void {
    const request = attempt.request;
    const matches = usage.profileId === request.profileId && usage.requestKey === request.requestKey &&
      usage.provider === request.provider && usage.model === request.model &&
      usage.routeRole === request.routeRole && usage.routeIndex === request.routeIndex &&
      usage.providerAttemptIndex === request.providerAttemptIndex && usage.sourceKind === request.sourceKind &&
      usage.auxiliaryKind === request.auxiliaryKind && usage.sessionId === request.executionSessionId &&
      usage.sessionBudgetScopeId === request.sessionBudgetScopeId && usage.visibleTurnId === request.visibleTurnId &&
      usage.taskId === request.taskId && usage.rootTaskId === request.rootTaskId &&
      usage.planRevisionId === request.planRevisionId && usage.stepId === request.stepId &&
      usage.attemptId === request.attemptId && usage.pricingFingerprint === request.pricing.fingerprint &&
      stableJson(usage.pricing) === stableJson(request.pricing);
    if (!matches) {
      throw new ProviderSpendIntegrityError(`Provider usage does not match spend reservation ${request.requestKey}.`);
    }
  }

  #selectAttempt(requestKey: string): ProviderSpendAttempt | null {
    const row = this.#db.query<SpendAttemptRow>(
      "select * from provider_spend_attempts where profile_id = ? and request_key = ?"
    ).get(this.#profileId, requestKey);
    if (row === null) return null;
    const allocations = this.#db.query<SpendAllocationRow>(
      `select * from provider_spend_scope_allocations
       where profile_id = ? and request_key = ? order by scope_kind, scope_owner_id`
    ).all(this.#profileId, requestKey).map(rowToAllocation);
    return rowToAttempt(row, allocations);
  }

  #requireAttempt(requestKey: string): ProviderSpendAttempt {
    const attempt = this.#selectAttempt(requestKey);
    if (attempt === null) throw new ProviderSpendIntegrityError(`Provider spend Attempt ${requestKey} was not found.`);
    return attempt;
  }

  #expectedScopeBalance(kind: ProviderSpendScopeKind, ownerId: string): { spent: number; reserved: number } {
    const row = this.#db.query<{ spent: number; reserved: number }>(
      `select
        coalesce(sum(case when attempt.state = 'settled' then usage.estimated_cost_usd else 0 end), 0) as spent,
        coalesce(sum(case when attempt.state in ('reserved', 'dispatching', 'uncertain')
          then allocation.reserved_cost_usd else 0 end), 0) as reserved
       from provider_spend_scope_allocations allocation
       join provider_spend_attempts attempt
         on attempt.profile_id = allocation.profile_id and attempt.request_key = allocation.request_key
       left join provider_usage_entries usage
         on usage.profile_id = attempt.profile_id and usage.id = attempt.usage_entry_id
       where allocation.profile_id = ? and allocation.scope_kind = ? and allocation.scope_owner_id = ?`
    ).get(this.#profileId, kind, ownerId);
    return { spent: row?.spent ?? 0, reserved: row?.reserved ?? 0 };
  }

  #balanceIssues(): ProviderSpendBalanceIssue[] {
    const issues: ProviderSpendBalanceIssue[] = [];
    for (const row of this.#db.query<SettledIntegrityRow>(
      `select attempt.request_key, attempt.actual_estimated_cost_usd, usage.estimated_cost_usd
       from provider_spend_attempts attempt
       left join provider_usage_entries usage
         on usage.profile_id = attempt.profile_id and usage.id = attempt.usage_entry_id
       where attempt.profile_id = ? and attempt.state = 'settled'`
    ).all(this.#profileId)) {
      if (row.estimated_cost_usd === null) {
        issues.push({ profileId: this.#profileId, requestKey: row.request_key, code: "SETTLED_USAGE_MISSING" });
      } else if (row.actual_estimated_cost_usd === null ||
          !amountsEqual(row.actual_estimated_cost_usd, row.estimated_cost_usd)) {
        issues.push({
          profileId: this.#profileId,
          requestKey: row.request_key,
          code: "SETTLED_COST_MISMATCH",
          expected: row.estimated_cost_usd,
          actual: row.actual_estimated_cost_usd ?? "missing"
        });
      }
    }
    for (const scope of this.#listScopes()) {
      const expected = this.#expectedScopeBalance(scope.kind, scope.ownerId);
      if (!amountsEqual(scope.reservedCostUsd, expected.reserved)) {
        issues.push({
          profileId: this.#profileId,
          scopeKind: scope.kind,
          scopeOwnerId: scope.ownerId,
          code: "MATERIALIZED_RESERVED_MISMATCH",
          expected: expected.reserved,
          actual: scope.reservedCostUsd
        });
      }
      if (!amountsEqual(scope.spentCostUsd, expected.spent)) {
        issues.push({
          profileId: this.#profileId,
          scopeKind: scope.kind,
          scopeOwnerId: scope.ownerId,
          code: "MATERIALIZED_SPENT_MISMATCH",
          expected: expected.spent,
          actual: scope.spentCostUsd
        });
      }
      const expectedState = scopeState(
        expected.spent,
        expected.reserved,
        scope.maxEstimatedCostUsd,
        scope.warningThresholdPercent
      );
      if (scope.state !== expectedState) {
        issues.push({
          profileId: this.#profileId,
          scopeKind: scope.kind,
          scopeOwnerId: scope.ownerId,
          code: "MATERIALIZED_STATE_MISMATCH",
          expected: expectedState,
          actual: scope.state
        });
      }
    }
    return issues;
  }

  #listScopes(): ProviderSpendingScope[] {
    return this.#db.query<SpendingScopeRow>(
      "select * from provider_spending_scopes where profile_id = ? order by kind, owner_id"
    ).all(this.#profileId).map(rowToScope);
  }

  #assertProfile(profileId: string): void {
    if (profileId !== this.#profileId) {
      throw new ProviderSpendIntegrityError("Provider spend request belongs to another profile.");
    }
  }

  #write<T>(operation: () => T): T {
    this.#db.exec("begin immediate");
    try {
      const result = operation();
      this.#db.exec("commit");
      return result;
    } catch (error) {
      try {
        this.#db.exec("rollback");
      } catch {
        // Preserve the accounting error that caused rollback.
      }
      throw error;
    }
  }
}

function reservationDenial(
  scope: ProviderSpendingScope,
  requestedCostUsd: number,
  earmarkedCostUsd = 0
): Extract<ProviderSpendReservationResult, { ok: false }> | undefined {
  const withoutReservations = Math.max(0, scope.maxEstimatedCostUsd - scope.spentCostUsd);
  const available = Math.max(0, withoutReservations - scope.reservedCostUsd - earmarkedCostUsd);
  // Admission is deliberately conservative: floating-point drift may deny a request,
  // but it must never admit one beyond the configured hard ceiling.
  if (requestedCostUsd <= available) return undefined;
  const exhausted = requestedCostUsd > withoutReservations;
  const reason: ProviderSpendDenialReason = scope.kind === "session"
    ? exhausted ? "SESSION_LIMIT_EXHAUSTED" : "SESSION_CAPACITY_RESERVED"
    : exhausted ? "TASK_LIMIT_EXHAUSTED" : "TASK_CAPACITY_RESERVED";
  return { ok: false, reason, scope, requestedCostUsd, availableCostUsd: available };
}

function scopeState(
  spentCostUsd: number,
  reservedCostUsd: number,
  maxEstimatedCostUsd: number,
  warningThresholdPercent: number
): ProviderSpendingScope["state"] {
  const committed = spentCostUsd + reservedCostUsd;
  if (committed + BALANCE_EPSILON_USD >= maxEstimatedCostUsd) return "exhausted";
  const warningAt = maxEstimatedCostUsd * warningThresholdPercent / 100;
  return committed + BALANCE_EPSILON_USD >= warningAt ? "warning" : "available";
}

function parseSpendingLimit(json: string): SpendingLimit {
  try {
    const value = JSON.parse(json) as SpendingLimit;
    assertSpendingLimit(value);
    return value;
  } catch (error) {
    throw new ProviderSpendIntegrityError("Provider spending scope owner has an invalid limit.", { cause: error });
  }
}

function parseExecutionLimits(json: string): { maxTotalTokens: number } {
  try {
    const value = JSON.parse(json) as { maxTotalTokens?: unknown };
    if (!Number.isSafeInteger(value.maxTotalTokens) || (value.maxTotalTokens as number) < 0) {
      throw new Error("maxTotalTokens is invalid");
    }
    return { maxTotalTokens: value.maxTotalTokens as number };
  } catch (error) {
    throw new ProviderSpendIntegrityError("Task synthesis execution limits are invalid.", { cause: error });
  }
}

function parseTaskExecutor(json: string): { kind: string; role?: string } {
  try {
    const value = JSON.parse(json) as { kind?: unknown; role?: unknown };
    if (typeof value.kind !== "string" ||
        (value.role !== undefined && typeof value.role !== "string")) {
      throw new Error("executor is invalid");
    }
    return {
      kind: value.kind,
      ...(value.role === undefined ? {} : { role: value.role as string })
    };
  } catch (error) {
    throw new ProviderSpendIntegrityError("Task synthesis executor is invalid.", { cause: error });
  }
}

function rowToScope(row: SpendingScopeRow): ProviderSpendingScope {
  return {
    profileId: row.profile_id,
    kind: row.kind,
    ownerId: row.owner_id,
    maxEstimatedCostUsd: row.max_estimated_cost_usd,
    warningThresholdPercent: row.warning_threshold_percent,
    spentCostUsd: row.spent_cost_usd,
    reservedCostUsd: row.reserved_cost_usd,
    state: row.state,
    ownerCreatedAt: row.owner_created_at,
    createdAt: row.created_at,
    ...(row.warning_reached_at === null ? {} : { warningReachedAt: row.warning_reached_at }),
    ...(row.exhausted_at === null ? {} : { exhaustedAt: row.exhausted_at })
  };
}

function rowToAllocation(row: SpendAllocationRow): ProviderSpendAllocation {
  return {
    profileId: row.profile_id,
    requestKey: row.request_key,
    scopeKind: row.scope_kind,
    scopeOwnerId: row.scope_owner_id,
    reservedCostUsd: row.reserved_cost_usd,
    createdAt: row.created_at
  };
}

function rowToAttempt(row: SpendAttemptRow, allocations: ProviderSpendAllocation[]): ProviderSpendAttempt {
  const request = JSON.parse(row.attribution_json) as ProviderSpendRequest;
  assertProviderSpendRequest(request);
  return {
    id: row.id,
    request,
    state: row.state,
    reservedCostUsd: row.reserved_cost_usd,
    ...(row.actual_estimated_cost_usd === null ? {} : { actualEstimatedCostUsd: row.actual_estimated_cost_usd }),
    ...(row.usage_entry_id === null ? {} : { usageEntryId: row.usage_entry_id }),
    createdAt: row.created_at,
    reservedAt: row.reserved_at,
    ...(row.dispatching_at === null ? {} : { dispatchingAt: row.dispatching_at }),
    ...(row.settled_at === null ? {} : { settledAt: row.settled_at }),
    ...(row.released_at === null ? {} : { releasedAt: row.released_at }),
    ...(row.uncertain_at === null ? {} : { uncertainAt: row.uncertain_at }),
    ...(row.uncertainty_reason === null ? {} : { uncertaintyReason: row.uncertainty_reason }),
    allocations
  };
}

function spendAttemptId(profileId: string, requestKey: string): string {
  return `spend_${createHash("sha256").update(`${profileId}\0${requestKey}`).digest("hex")}`;
}

function amountsEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= BALANCE_EPSILON_USD;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortValue(nested)])
    );
  }
  return value;
}

function assertTimestamp(value: string, label: string): void {
  if (!Number.isFinite(Date.parse(value))) throw new ProviderSpendIntegrityError(`${label} timestamp is invalid.`);
}

function assertNotBefore(value: string, lowerBound: string, label: string): void {
  if (Date.parse(value) < Date.parse(lowerBound)) {
    throw new ProviderSpendIntegrityError(`${label} cannot precede the durable state it follows.`);
  }
}

function requireText(value: string, label: string, max: number): void {
  if (value.trim().length === 0 || value.length > max) throw new ProviderSpendIntegrityError(`${label} is invalid.`);
}

function assertScopeKind(kind: string): asserts kind is ProviderSpendScopeKind {
  if (kind !== "session" && kind !== "root_task") {
    throw new ProviderSpendIntegrityError("Provider spending scope kind is invalid.");
  }
}

type SessionSpendRow = {
  id: string;
  spending_scope_session_id: string | null;
  spending_limit_json: string | null;
  created_at: string;
};

type TaskSpendRow = {
  root_task_id: string;
  root_id: string;
  spending_limit_json: string | null;
  created_at: string;
};

type SynthesisRootRow = {
  id: string;
  spending_limit_json: string | null;
};

type SynthesisStepRow = {
  id: string;
  status: string;
  executor_json: string;
  execution_limits_json: string;
};

type SpendingScopeRow = {
  profile_id: string;
  kind: ProviderSpendScopeKind;
  owner_id: string;
  max_estimated_cost_usd: number;
  warning_threshold_percent: number;
  spent_cost_usd: number;
  reserved_cost_usd: number;
  state: ProviderSpendingScope["state"];
  owner_created_at: string;
  created_at: string;
  warning_reached_at: string | null;
  exhausted_at: string | null;
};

type SpendAttemptRow = {
  id: string;
  profile_id: string;
  request_key: string;
  attribution_json: string;
  provider: string;
  model: string;
  pricing_snapshot_json: string;
  pricing_fingerprint: string;
  maximum_estimated_exposure_usd: number;
  state: ProviderSpendAttempt["state"];
  reserved_cost_usd: number;
  actual_estimated_cost_usd: number | null;
  usage_entry_id: string | null;
  created_at: string;
  reserved_at: string;
  dispatching_at: string | null;
  settled_at: string | null;
  released_at: string | null;
  uncertain_at: string | null;
  uncertainty_reason: string | null;
};

type SpendAllocationRow = {
  profile_id: string;
  request_key: string;
  scope_kind: ProviderSpendScopeKind;
  scope_owner_id: string;
  reserved_cost_usd: number;
  created_at: string;
};

type SettledIntegrityRow = {
  request_key: string;
  actual_estimated_cost_usd: number | null;
  estimated_cost_usd: number | null;
};
