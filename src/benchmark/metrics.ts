import type { RuntimeEvent } from "../contracts/runtime-event.js";
import type { BenchmarkMetrics } from "./schema.js";
import { createEmptyBenchmarkMetrics } from "./schema.js";

export type BenchmarkCostRates = {
  inputPerMillionTokens?: number;
  outputPerMillionTokens?: number;
};

export function aggregateBenchmarkMetrics(
  events: readonly RuntimeEvent[],
  costRates?: BenchmarkCostRates
): BenchmarkMetrics {
  const metrics = createEmptyBenchmarkMetrics();

  for (const event of events) {
    switch (event.kind) {
      case "provider-result":
        metrics.providerCalls += 1;
        metrics.inputTokens += normalizeTokenCount(event.usage?.inputTokens);
        metrics.outputTokens += normalizeTokenCount(event.usage?.outputTokens);
        metrics.totalTokens += normalizeTokenCount(event.usage?.totalTokens);
        break;
      case "provider-tool-call":
        metrics.providerToolCalls += 1;
        break;
      case "tool-start":
        metrics.toolCalls += 1;
        break;
      case "delegation-progress":
        if (event.childEvent.kind === "provider-result") {
          metrics.providerCalls += 1;
        } else if (event.childEvent.kind === "tool-start") {
          metrics.toolCalls += 1;
        }
        break;
    }
  }

  metrics.estimatedCostUsd = estimateBenchmarkCostUsd(metrics, costRates);
  return metrics;
}

export function estimateBenchmarkCostUsd(
  metrics: Pick<BenchmarkMetrics, "inputTokens" | "outputTokens">,
  costRates?: BenchmarkCostRates
): number | null {
  if (
    costRates?.inputPerMillionTokens === undefined &&
    costRates?.outputPerMillionTokens === undefined
  ) {
    return null;
  }

  const inputCost = costRates.inputPerMillionTokens === undefined
    ? 0
    : (metrics.inputTokens / 1_000_000) * costRates.inputPerMillionTokens;
  const outputCost = costRates.outputPerMillionTokens === undefined
    ? 0
    : (metrics.outputTokens / 1_000_000) * costRates.outputPerMillionTokens;

  return roundCost(inputCost + outputCost);
}

function normalizeTokenCount(value: number | undefined): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? Math.round(value) : 0;
}

function roundCost(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
