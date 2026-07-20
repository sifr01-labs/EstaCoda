import type { ResolvedModelRoute } from "../contracts/provider.js";
import type { TaskUsageTotals } from "../contracts/task.js";
import type { ProviderExecutionResult } from "../providers/provider-executor.js";
import type { AgentLoopRouteInput } from "../runtime/agent-loop-builder.js";

/** Aggregates every finalized provider Attempt in one child turn, including fallbacks and retries. */
export function taskUsageFromAgentResponse(
  execution: ProviderExecutionResult | undefined,
  routes: AgentLoopRouteInput
): TaskUsageTotals {
  const attempts = execution?.attempts ?? [];
  const availableRoutes = routeCatalog(routes);
  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let totalTokens = 0;
  let estimatedCostUsd = 0;
  let usageComplete = attempts.length > 0;
  let pricingComplete = attempts.length > 0;
  const incompleteReasons = new Set<string>();

  attempts.forEach((attempt, index) => {
    const usage = attempt.usage;
    if (usage === undefined) {
      usageComplete = false;
      pricingComplete = false;
      incompleteReasons.add(`provider-attempt-${index + 1}-usage-missing`);
      return;
    }

    const input = tokenCount(usage.inputTokens);
    const output = tokenCount(usage.outputTokens);
    const reasoning = tokenCount(usage.reasoningTokens) ?? 0;
    const reportedTotal = tokenCount(usage.totalTokens);
    if (input === undefined || output === undefined) {
      usageComplete = false;
      pricingComplete = false;
      incompleteReasons.add(`provider-attempt-${index + 1}-token-breakdown-incomplete`);
    }
    const derivedTotal = (input ?? 0) + (output ?? 0);
    if (reportedTotal === undefined && (input === undefined || output === undefined)) {
      usageComplete = false;
      incompleteReasons.add(`provider-attempt-${index + 1}-total-tokens-missing`);
    }
    if (reportedTotal !== undefined && reportedTotal < derivedTotal) {
      usageComplete = false;
      incompleteReasons.add(`provider-attempt-${index + 1}-total-tokens-invalid`);
    }

    inputTokens += input ?? 0;
    outputTokens += output ?? 0;
    reasoningTokens += reasoning;
    totalTokens += reportedTotal ?? derivedTotal;

    const route = availableRoutes.find((candidate) =>
      candidate.provider === attempt.provider && candidate.id === attempt.model
    );
    const inputRate = price(route?.profile.cost?.inputPerMillionTokens);
    const outputRate = price(route?.profile.cost?.outputPerMillionTokens);
    if ((input ?? 0) > 0) {
      if (inputRate === undefined) {
        pricingComplete = false;
        incompleteReasons.add(`provider-attempt-${index + 1}-input-pricing-missing`);
      } else {
        estimatedCostUsd += ((input ?? 0) / 1_000_000) * inputRate;
      }
    }
    if ((output ?? 0) > 0) {
      if (outputRate === undefined) {
        pricingComplete = false;
        incompleteReasons.add(`provider-attempt-${index + 1}-output-pricing-missing`);
      } else {
        estimatedCostUsd += ((output ?? 0) / 1_000_000) * outputRate;
      }
    }
  });

  if (attempts.length === 0) {
    incompleteReasons.add("provider-usage-unavailable");
  }

  return {
    providerCalls: attempts.length,
    inputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
    estimatedCostUsd: roundCost(estimatedCostUsd),
    usageComplete,
    pricingComplete,
    incompleteReasons: [...incompleteReasons].slice(0, 32)
  };
}

function routeCatalog(routes: AgentLoopRouteInput): ResolvedModelRoute[] {
  const values = [
    routes.primaryModelRoute,
    routes.mainRoute,
    ...(routes.modelFallbackRoutes ?? [])
  ].filter((route): route is ResolvedModelRoute => route !== undefined);
  const seen = new Set<string>();
  return values.filter((route) => {
    const key = `${route.provider}\u0000${route.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function tokenCount(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

function price(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function roundCost(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
