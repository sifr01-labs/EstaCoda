import { createHash } from "node:crypto";
import type { ResolvedModelRoute } from "../contracts/provider.js";
import type {
  ProviderUsageEntry,
  ProviderUsageQuery,
  ProviderUsageTotals
} from "../contracts/provider-usage.js";
import type { ProviderExecutionResult } from "./provider-executor.js";
import { estimateProviderUsage } from "./provider-usage-estimator.js";

export type ProviderUsageTaskAttribution = {
  taskId: string;
  rootTaskId: string;
  planRevisionId: string;
  stepId: string;
  attemptId: string;
};

export function providerUsageEntriesFromExecution(input: {
  execution: ProviderExecutionResult;
  profileId: string;
  sessionId: string;
  visibleTurnId: string;
  requestSequence: number;
  routes: readonly ResolvedModelRoute[];
  task?: ProviderUsageTaskAttribution;
}): ProviderUsageEntry[] {
  return input.execution.attempts.flatMap((attempt, providerAttemptIndex) => {
    if (attempt.dispatched !== true) return [];
    if (attempt.dispatchedAt === undefined || !Number.isFinite(Date.parse(attempt.dispatchedAt))) {
      throw new Error("A dispatched provider request is missing its dispatch timestamp.");
    }
    const inferredRouteIndex = input.routes.findIndex((route) =>
      route.provider === attempt.provider && route.id === attempt.model
    );
    if (attempt.routeIndex !== undefined &&
        (!Number.isSafeInteger(attempt.routeIndex) || attempt.routeIndex < 0)) {
      throw new Error("A dispatched provider request has an invalid resolved route index.");
    }
    const routeIndex = attempt.routeIndex ?? Math.max(0, inferredRouteIndex);
    const route = attempt.routeIndex === undefined && inferredRouteIndex < 0
      ? undefined
      : input.routes[routeIndex];
    if (attempt.routeIndex !== undefined &&
        (route?.provider !== attempt.provider || route.id !== attempt.model)) {
      throw new Error("A dispatched provider request does not match its resolved route.");
    }
    const routeRole = attempt.routeRole ?? (
      inferredRouteIndex < 0 ? "unknown" as const : routeIndex === 0 ? "primary" as const : "fallback" as const
    );
    const requestIdentity = [
      input.sessionId,
      input.visibleTurnId,
      String(input.requestSequence),
      String(providerAttemptIndex)
    ].join("\0");
    const requestKey = `sha256:${createHash("sha256").update(requestIdentity).digest("hex")}`;
    return [{
      id: createHash("sha256").update(`${input.profileId}\0${requestKey}`).digest("hex"),
      profileId: input.profileId,
      sessionId: input.sessionId,
      visibleTurnId: input.visibleTurnId,
      requestKey,
      provider: attempt.provider,
      model: attempt.model,
      routeRole,
      routeIndex,
      providerAttemptIndex,
      ...estimateProviderUsage(attempt.usage, route, providerAttemptIndex),
      ...(input.task ?? {}),
      dispatchedAt: attempt.dispatchedAt
    }];
  });
}

export function providerUsageTotals(
  entries: readonly ProviderUsageEntry[],
  options: { readonly emptyUsageIsComplete?: boolean } = {}
): ProviderUsageTotals {
  const reasons = new Set(entries.flatMap((entry) => entry.incompleteReasons));
  const emptyComplete = entries.length === 0 && options.emptyUsageIsComplete === true;
  if (entries.length === 0 && !emptyComplete) reasons.add("provider-usage-unavailable");
  return {
    providerCalls: entries.length,
    inputTokens: sum(entries, "inputTokens"),
    outputTokens: sum(entries, "outputTokens"),
    reasoningTokens: sum(entries, "reasoningTokens"),
    cacheReadTokens: sum(entries, "cacheReadTokens"),
    cacheWriteTokens: sum(entries, "cacheWriteTokens"),
    totalTokens: sum(entries, "totalTokens"),
    estimatedCostUsd: entries.reduce((total, entry) => total + entry.estimatedCostUsd, 0),
    usageComplete: emptyComplete || (entries.length > 0 && entries.every((entry) => entry.usageComplete)),
    pricingComplete: emptyComplete || (entries.length > 0 && entries.every((entry) => entry.pricingComplete)),
    incompleteReasons: [...reasons].slice(0, 32)
  };
}

export function providerUsageMatches(entry: ProviderUsageEntry, query: ProviderUsageQuery): boolean {
  return (query.sessionId === undefined || entry.sessionId === query.sessionId) &&
    (query.visibleTurnId === undefined || entry.visibleTurnId === query.visibleTurnId) &&
    (query.taskId === undefined || entry.taskId === query.taskId) &&
    (query.rootTaskId === undefined || entry.rootTaskId === query.rootTaskId) &&
    (query.attemptId === undefined || entry.attemptId === query.attemptId);
}

function sum(
  entries: readonly ProviderUsageEntry[],
  field: "inputTokens" | "outputTokens" | "reasoningTokens" | "cacheReadTokens" | "cacheWriteTokens" | "totalTokens"
): number {
  return entries.reduce((total, entry) => total + entry[field], 0);
}
