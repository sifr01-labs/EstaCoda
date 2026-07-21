import type { ProviderUsageEntry, ProviderUsageQuery } from "../contracts/provider-usage.js";
import type { SQLiteDatabase, SQLiteValue } from "../storage/sqlite.js";

export function insertProviderUsageEntry(db: SQLiteDatabase, entry: ProviderUsageEntry): void {
  assertProviderUsageEntry(entry);
  if (!providerUsageLineageIsValid(db, entry)) {
    throw new Error("Provider usage Session or visible-turn lineage is invalid.");
  }
  db.query(`insert into provider_usage_entries (
    id, profile_id, session_id, session_budget_scope_id, visible_turn_id, request_key, provider, model,
    route_role, route_index, provider_attempt_index, source_kind, auxiliary_kind,
    pricing_snapshot_json, pricing_fingerprint, input_tokens, output_tokens,
    reasoning_tokens, cache_read_tokens, cache_write_tokens, total_tokens,
    estimated_cost_usd, usage_complete, pricing_complete, incomplete_reasons_json,
    task_id, root_task_id, plan_revision_id, step_id, attempt_id, dispatched_at
  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  on conflict(profile_id, request_key) do nothing`).run(
    entry.id, entry.profileId, entry.sessionId ?? null, entry.sessionBudgetScopeId ?? null,
    entry.visibleTurnId ?? null, entry.requestKey,
    entry.provider, entry.model, entry.routeRole, entry.routeIndex, entry.providerAttemptIndex,
    entry.sourceKind, entry.auxiliaryKind ?? null, JSON.stringify(entry.pricing), entry.pricingFingerprint,
    entry.inputTokens, entry.outputTokens, entry.reasoningTokens, entry.cacheReadTokens,
    entry.cacheWriteTokens, entry.totalTokens, entry.estimatedCostUsd,
    entry.usageComplete ? 1 : 0, entry.pricingComplete ? 1 : 0,
    JSON.stringify(entry.incompleteReasons), entry.taskId ?? null, entry.rootTaskId ?? null,
    entry.planRevisionId ?? null, entry.stepId ?? null, entry.attemptId ?? null,
    entry.dispatchedAt
  );
  const persisted = db.query<ProviderUsageRow>(
    "select * from provider_usage_entries where profile_id = ? and request_key = ?"
  ).get(entry.profileId, entry.requestKey);
  if (persisted === null || stableValue(rowToProviderUsageEntry(persisted)) !== stableValue(entry)) {
    throw new Error(`Provider usage request key ${entry.requestKey} conflicts with another entry.`);
  }
}

function providerUsageLineageIsValid(
  db: SQLiteDatabase,
  entry: Pick<ProviderUsageEntry, "profileId" | "sessionId" | "sessionBudgetScopeId" | "visibleTurnId" | "sourceKind">
): boolean {
  const executionSession = entry.sessionId === undefined ? null : db.query<SessionLineageRow>(
    `select id, parent_session_id, end_reason, metadata_json,
      spending_scope_session_id, spending_limit_json
     from sessions where profile_id = ? and id = ?`
  ).get(entry.profileId, entry.sessionId);
  if (entry.sessionId !== undefined && executionSession === null) return false;
  if (entry.sessionBudgetScopeId !== undefined) {
    const scope = db.query<SessionLineageRow>(
      `select id, parent_session_id, end_reason, metadata_json,
        spending_scope_session_id, spending_limit_json
       from sessions where profile_id = ? and id = ?`
    ).get(entry.profileId, entry.sessionBudgetScopeId);
    if (scope === null || scope.spending_scope_session_id !== scope.id || scope.spending_limit_json === null ||
        executionSession?.spending_scope_session_id !== scope.id) return false;
  } else if (executionSession?.spending_scope_session_id !== null && executionSession !== null) {
    return false;
  }
  if (entry.visibleTurnId === undefined) return true;
  const lineageRoot = entry.sourceKind === "task" && executionSession?.parent_session_id !== null
    ? executionSession?.parent_session_id
    : entry.sessionId;
  if (lineageRoot === undefined) return false;
  const lineage = new Set<string>();
  let currentId = lineageRoot;
  let complete = false;
  for (let depth = 0; depth < 32; depth++) {
    if (lineage.has(currentId)) return false;
    const current = db.query<SessionLineageRow>(
      `select id, parent_session_id, end_reason, metadata_json,
        spending_scope_session_id, spending_limit_json
       from sessions where profile_id = ? and id = ?`
    ).get(entry.profileId, currentId);
    if (current === null) return false;
    if (entry.sessionBudgetScopeId !== undefined &&
        current.spending_scope_session_id !== entry.sessionBudgetScopeId) return false;
    lineage.add(current.id);
    const compactedFrom = compactedFromSessionId(current.metadata_json);
    if (current.parent_session_id === null || compactedFrom !== current.parent_session_id) {
      complete = true;
      break;
    }
    const parent = db.query<SessionLineageRow>(
      `select id, parent_session_id, end_reason, metadata_json,
        spending_scope_session_id, spending_limit_json
       from sessions where profile_id = ? and id = ?`
    ).get(entry.profileId, current.parent_session_id);
    if (parent === null || parent.end_reason !== "compression") {
      complete = true;
      break;
    }
    currentId = parent.id;
  }
  if (!complete) return false;
  const turn = db.query<{ session_id: string }>(
    "select session_id from messages where id = ? and role = 'user'"
  ).get(entry.visibleTurnId);
  return turn !== null && lineage.has(turn.session_id);
}

function compactedFromSessionId(metadataJson: string | null): string | undefined {
  if (metadataJson === null) return undefined;
  try {
    const metadata = JSON.parse(metadataJson) as unknown;
    if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return undefined;
    const value = (metadata as Record<string, unknown>).compactedFromSessionId;
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

export function selectProviderUsageEntries(
  db: SQLiteDatabase,
  profileId: string,
  query: ProviderUsageQuery = {}
): ProviderUsageEntry[] {
  const clauses = ["profile_id = ?"];
  const values: SQLiteValue[] = [profileId];
  for (const [column, value] of [
    ["session_id", query.sessionId],
    ["session_budget_scope_id", query.sessionBudgetScopeId],
    ["visible_turn_id", query.visibleTurnId],
    ["task_id", query.taskId],
    ["root_task_id", query.rootTaskId],
    ["attempt_id", query.attemptId]
  ] as const) {
    if (value === undefined) continue;
    clauses.push(`${column} = ?`);
    values.push(value);
  }
  return db.query<ProviderUsageRow>(
    `select * from provider_usage_entries where ${clauses.join(" and ")}
     order by dispatched_at, provider_attempt_index, id`
  ).all(...values).map(rowToProviderUsageEntry);
}

function rowToProviderUsageEntry(row: ProviderUsageRow): ProviderUsageEntry {
  return {
    id: row.id,
    profileId: row.profile_id,
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    ...(row.session_budget_scope_id === null ? {} : { sessionBudgetScopeId: row.session_budget_scope_id }),
    ...(row.visible_turn_id === null ? {} : { visibleTurnId: row.visible_turn_id }),
    requestKey: row.request_key,
    provider: row.provider,
    model: row.model,
    routeRole: row.route_role as ProviderUsageEntry["routeRole"],
    routeIndex: row.route_index,
    providerAttemptIndex: row.provider_attempt_index,
    sourceKind: row.source_kind as ProviderUsageEntry["sourceKind"],
    ...(row.auxiliary_kind === null ? {} : { auxiliaryKind: row.auxiliary_kind }),
    pricing: parsePricing(row.pricing_snapshot_json),
    pricingFingerprint: row.pricing_fingerprint,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    reasoningTokens: row.reasoning_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    totalTokens: row.total_tokens,
    estimatedCostUsd: row.estimated_cost_usd,
    usageComplete: row.usage_complete === 1,
    pricingComplete: row.pricing_complete === 1,
    incompleteReasons: parseReasons(row.incomplete_reasons_json),
    ...(row.task_id === null ? {} : { taskId: row.task_id }),
    ...(row.root_task_id === null ? {} : { rootTaskId: row.root_task_id }),
    ...(row.plan_revision_id === null ? {} : { planRevisionId: row.plan_revision_id }),
    ...(row.step_id === null ? {} : { stepId: row.step_id }),
    ...(row.attempt_id === null ? {} : { attemptId: row.attempt_id }),
    dispatchedAt: row.dispatched_at
  };
}

function assertProviderUsageEntry(entry: ProviderUsageEntry): void {
  const bounded = (value: string, max: number) => value.length > 0 && value.length <= max;
  if (!bounded(entry.id, 256) || !bounded(entry.profileId, 128) ||
      (entry.sessionId !== undefined && !bounded(entry.sessionId, 256)) ||
      (entry.sessionBudgetScopeId !== undefined && !bounded(entry.sessionBudgetScopeId, 256)) ||
      (entry.visibleTurnId !== undefined && !bounded(entry.visibleTurnId, 512)) || !bounded(entry.requestKey, 512) ||
      !bounded(entry.provider, 128) || !bounded(entry.model, 256) ||
      !Number.isSafeInteger(entry.routeIndex) || entry.routeIndex < 0 ||
      !Number.isSafeInteger(entry.providerAttemptIndex) || entry.providerAttemptIndex < 0 ||
      !validCount(entry.inputTokens) || !validCount(entry.outputTokens) ||
      !validCount(entry.reasoningTokens) || !validCount(entry.cacheReadTokens) ||
      !validCount(entry.cacheWriteTokens) || !validCount(entry.totalTokens) ||
      !Number.isFinite(entry.estimatedCostUsd) || entry.estimatedCostUsd < 0 ||
      !Number.isFinite(Date.parse(entry.dispatchedAt)) || entry.incompleteReasons.length > 32 ||
      entry.incompleteReasons.some((reason) => !bounded(reason, 256)) ||
      !bounded(entry.pricingFingerprint, 256) || entry.pricing.fingerprint !== entry.pricingFingerprint) {
    throw new Error("Provider usage entry contains invalid values.");
  }
  assertPricing(entry);
  const taskValues = [entry.taskId, entry.rootTaskId, entry.planRevisionId, entry.stepId, entry.attemptId];
  if (!taskValues.every((value) => value === undefined) && !taskValues.every((value) => value !== undefined)) {
    throw new Error("Provider usage Task attribution must be complete or absent.");
  }
  if (entry.sourceKind === "task" && (!taskValues.every((value) => value !== undefined) || entry.sessionId === undefined)) {
    throw new Error("Task provider usage requires complete leaf and execution Session attribution.");
  }
  if (entry.sourceKind === "main" && (entry.sessionId === undefined || entry.visibleTurnId === undefined)) {
    throw new Error("Main provider usage requires execution Session and visible-turn attribution.");
  }
  if ((entry.sourceKind === "auxiliary") !== (entry.auxiliaryKind !== undefined)) {
    throw new Error("Provider usage auxiliary attribution is invalid.");
  }
}

function assertPricing(entry: ProviderUsageEntry): void {
  if (entry.pricing.currency !== "USD") throw new Error("Provider usage pricing currency is invalid.");
  for (const rate of [
    entry.pricing.inputPerMillionTokens,
    entry.pricing.outputPerMillionTokens,
    entry.pricing.reasoningPerMillionTokens,
    entry.pricing.cacheReadPerMillionTokens,
    entry.pricing.cacheWritePerMillionTokens
  ]) {
    if (rate !== undefined && (!Number.isFinite(rate) || rate < 0)) {
      throw new Error("Provider usage pricing snapshot is invalid.");
    }
  }
}

function validCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function parseReasons(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || !parsed.every((reason) => typeof reason === "string")) {
    throw new Error("Provider usage incomplete reasons are invalid.");
  }
  return parsed;
}

function parsePricing(value: string): ProviderUsageEntry["pricing"] {
  const parsed = JSON.parse(value) as ProviderUsageEntry["pricing"];
  if (typeof parsed !== "object" || parsed === null || parsed.currency !== "USD" ||
      typeof parsed.fingerprint !== "string") {
    throw new Error("Provider usage pricing snapshot is invalid.");
  }
  return parsed;
}

function stableValue(entry: ProviderUsageEntry): string {
  return JSON.stringify(sortValue(entry));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, sortValue(nested)])
    );
  }
  return value;
}

type ProviderUsageRow = {
  id: string;
  profile_id: string;
  session_id: string | null;
  session_budget_scope_id: string | null;
  visible_turn_id: string | null;
  request_key: string;
  provider: string;
  model: string;
  route_role: string;
  route_index: number;
  provider_attempt_index: number;
  source_kind: string;
  auxiliary_kind: string | null;
  pricing_snapshot_json: string;
  pricing_fingerprint: string;
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  estimated_cost_usd: number;
  usage_complete: number;
  pricing_complete: number;
  incomplete_reasons_json: string;
  task_id: string | null;
  root_task_id: string | null;
  plan_revision_id: string | null;
  step_id: string | null;
  attempt_id: string | null;
  dispatched_at: string;
};

type SessionLineageRow = {
  id: string;
  parent_session_id: string | null;
  end_reason: string | null;
  metadata_json: string | null;
  spending_scope_session_id: string | null;
  spending_limit_json: string | null;
};
