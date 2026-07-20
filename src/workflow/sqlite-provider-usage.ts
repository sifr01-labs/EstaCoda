import type { ProviderUsageEntry, ProviderUsageQuery } from "../contracts/provider-usage.js";
import type { SQLiteDatabase, SQLiteValue } from "../storage/sqlite.js";

export function insertProviderUsageEntry(db: SQLiteDatabase, entry: ProviderUsageEntry): void {
  assertProviderUsageEntry(entry);
  const session = db.query<{ id: string }>(
    "select id from sessions where profile_id = ? and id = ?"
  ).get(entry.profileId, entry.sessionId);
  const visibleTurn = db.query<{ role: string }>(
    `select messages.role
     from messages join sessions on sessions.id = messages.session_id
     where sessions.profile_id = ? and messages.id = ? and messages.role = 'user'`
  ).get(entry.profileId, entry.visibleTurnId);
  if (session === null || visibleTurn?.role !== "user") {
    throw new Error("Provider usage attribution does not belong to its profile Session and visible turn.");
  }
  db.query(`insert into provider_usage_entries (
    id, profile_id, session_id, visible_turn_id, request_key, provider, model,
    route_role, route_index, provider_attempt_index, input_tokens, output_tokens,
    reasoning_tokens, cache_read_tokens, cache_write_tokens, total_tokens,
    estimated_cost_usd, usage_complete, pricing_complete, incomplete_reasons_json,
    task_id, root_task_id, plan_revision_id, step_id, attempt_id, dispatched_at
  ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  on conflict(profile_id, request_key) do nothing`).run(
    entry.id, entry.profileId, entry.sessionId, entry.visibleTurnId, entry.requestKey,
    entry.provider, entry.model, entry.routeRole, entry.routeIndex, entry.providerAttemptIndex,
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

export function selectProviderUsageEntries(
  db: SQLiteDatabase,
  profileId: string,
  query: ProviderUsageQuery = {}
): ProviderUsageEntry[] {
  const clauses = ["profile_id = ?"];
  const values: SQLiteValue[] = [profileId];
  for (const [column, value] of [
    ["session_id", query.sessionId],
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
    sessionId: row.session_id,
    visibleTurnId: row.visible_turn_id,
    requestKey: row.request_key,
    provider: row.provider,
    model: row.model,
    routeRole: row.route_role as ProviderUsageEntry["routeRole"],
    routeIndex: row.route_index,
    providerAttemptIndex: row.provider_attempt_index,
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
  if (!bounded(entry.id, 256) || !bounded(entry.profileId, 128) || !bounded(entry.sessionId, 256) ||
      !bounded(entry.visibleTurnId, 512) || !bounded(entry.requestKey, 512) ||
      !bounded(entry.provider, 128) || !bounded(entry.model, 256) ||
      !Number.isSafeInteger(entry.routeIndex) || entry.routeIndex < 0 ||
      !Number.isSafeInteger(entry.providerAttemptIndex) || entry.providerAttemptIndex < 0 ||
      !validCount(entry.inputTokens) || !validCount(entry.outputTokens) ||
      !validCount(entry.reasoningTokens) || !validCount(entry.cacheReadTokens) ||
      !validCount(entry.cacheWriteTokens) || !validCount(entry.totalTokens) ||
      !Number.isFinite(entry.estimatedCostUsd) || entry.estimatedCostUsd < 0 ||
      !Number.isFinite(Date.parse(entry.dispatchedAt)) || entry.incompleteReasons.length > 32 ||
      entry.incompleteReasons.some((reason) => !bounded(reason, 256))) {
    throw new Error("Provider usage entry contains invalid values.");
  }
  const taskValues = [entry.taskId, entry.rootTaskId, entry.planRevisionId, entry.stepId, entry.attemptId];
  if (!taskValues.every((value) => value === undefined) && !taskValues.every((value) => value !== undefined)) {
    throw new Error("Provider usage Task attribution must be complete or absent.");
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
  session_id: string;
  visible_turn_id: string;
  request_key: string;
  provider: string;
  model: string;
  route_role: string;
  route_index: number;
  provider_attempt_index: number;
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
