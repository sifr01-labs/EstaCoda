import type { ResolvedModelRoute } from "../contracts/provider.js";
import type { ProviderUsageEntry } from "../contracts/provider-usage.js";
import type { TaskUsageTotals } from "../contracts/task.js";
import { assertProviderAttemptState, type ProviderExecutionResult } from "../providers/provider-executor.js";
import { estimateProviderUsage } from "../providers/provider-usage-estimator.js";
import { providerUsageTotals } from "../providers/provider-usage-ledger.js";
import type { AgentLoopRouteInput } from "../runtime/agent-loop-builder.js";

/** Fallback for injected executors that do not expose the canonical Session ledger. */
export function taskUsageFromAgentResponse(
  execution: ProviderExecutionResult | undefined,
  routes: AgentLoopRouteInput
): TaskUsageTotals {
  const catalog = routeCatalog(routes);
  const estimates = (execution?.attempts ?? []).flatMap((attempt, index) => {
    assertProviderAttemptState(attempt);
    if (attempt.state === "preflight") return [];
    const indexedRoute = attempt.routeIndex === undefined ? undefined : catalog[attempt.routeIndex];
    const route = indexedRoute?.provider === attempt.provider && indexedRoute.id === attempt.model
      ? indexedRoute
      : catalog.find((candidate) => candidate.provider === attempt.provider && candidate.id === attempt.model);
    return [estimateProviderUsage(attempt.usage, route, index)];
  });
  const reasons = new Set(estimates.flatMap((estimate) => estimate.incompleteReasons));
  if (estimates.length === 0) reasons.add("provider-usage-unavailable");
  return {
    providerCalls: estimates.length,
    inputTokens: estimates.reduce((sum, estimate) => sum + estimate.inputTokens, 0),
    outputTokens: estimates.reduce((sum, estimate) => sum + estimate.outputTokens, 0),
    reasoningTokens: estimates.reduce((sum, estimate) => sum + estimate.reasoningTokens, 0),
    cacheReadTokens: estimates.reduce((sum, estimate) => sum + estimate.cacheReadTokens, 0),
    cacheWriteTokens: estimates.reduce((sum, estimate) => sum + estimate.cacheWriteTokens, 0),
    totalTokens: estimates.reduce((sum, estimate) => sum + estimate.totalTokens, 0),
    estimatedCostUsd: estimates.reduce((sum, estimate) => sum + estimate.estimatedCostUsd, 0),
    usageComplete: estimates.length > 0 && estimates.every((estimate) => estimate.usageComplete),
    pricingComplete: estimates.length > 0 && estimates.every((estimate) => estimate.pricingComplete),
    incompleteReasons: [...reasons].slice(0, 32)
  };
}

export function taskUsageFromEntries(entries: readonly ProviderUsageEntry[]): TaskUsageTotals {
  return providerUsageTotals(entries);
}

function routeCatalog(routes: AgentLoopRouteInput): ResolvedModelRoute[] {
  return [
    routes.primaryModelRoute,
    ...(routes.primaryModelRoute === undefined ? [routes.mainRoute] : []),
    ...(routes.modelFallbackRoutes ?? [])
  ].filter((route): route is ResolvedModelRoute => route !== undefined);
}
