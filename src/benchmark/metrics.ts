import type { RuntimeEvent } from "../contracts/runtime-event.js";
import type { Trajectory } from "../contracts/trajectory.js";
import type { BenchmarkMetrics } from "./schema.js";
import { createEmptyBenchmarkMetrics } from "./schema.js";

export type BenchmarkCostRates = {
  inputPerMillionTokens?: number;
  outputPerMillionTokens?: number;
};

export function aggregateBenchmarkMetrics(
  events: readonly RuntimeEvent[],
  costRates?: BenchmarkCostRates,
  trajectory?: Trajectory
): BenchmarkMetrics {
  const metrics = createEmptyBenchmarkMetrics();
  let runtimeProviderBudgetExhaustions = 0;
  let runtimeSecurityEscalations = 0;
  let runtimeSessionRecallCount = 0;

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
      case "tool-result":
        if (event.ok === false) {
          metrics.toolFailures += 1;
        }
        break;
      case "provider-budget-exhausted":
        runtimeProviderBudgetExhaustions += 1;
        metrics.providerBudgetExhaustions = runtimeProviderBudgetExhaustions;
        break;
      case "security-risk-escalated":
        runtimeSecurityEscalations += 1;
        metrics.securityEscalations = runtimeSecurityEscalations;
        break;
      case "context-usage":
        metrics.contextUsageEvents += 1;
        break;
      case "session-recall-decision":
        metrics.sessionRecallTriggered ||= event.triggered;
        runtimeSessionRecallCount += 1;
        metrics.sessionRecallCount = runtimeSessionRecallCount;
        break;
      case "agent-cancelled":
        metrics.agentCancelled = true;
        break;
      case "delegation-progress":
        if (event.childEvent.kind === "provider-result") {
          metrics.providerCalls += 1;
        } else if (event.childEvent.kind === "tool-start") {
          metrics.toolCalls += 1;
        } else if (event.childEvent.kind === "tool-result" && event.childEvent.ok === false) {
          metrics.toolFailures += 1;
        } else if (event.childEvent.kind === "provider-budget-exhausted") {
          runtimeProviderBudgetExhaustions += 1;
          metrics.providerBudgetExhaustions = runtimeProviderBudgetExhaustions;
        } else if (event.childEvent.kind === "agent-cancelled") {
          metrics.agentCancelled = true;
        }
        break;
    }
  }

  if (trajectory !== undefined) {
    applyTrajectoryMetrics(metrics, trajectory, {
      runtimeProviderBudgetExhaustions,
      runtimeSecurityEscalations,
      runtimeSessionRecallCount
    });
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

function applyTrajectoryMetrics(
  metrics: BenchmarkMetrics,
  trajectory: Trajectory,
  runtimeCounts: {
    runtimeProviderBudgetExhaustions: number;
    runtimeSecurityEscalations: number;
    runtimeSessionRecallCount: number;
  }
): void {
  let trajectoryProviderBudgetExhaustions = 0;
  let trajectorySecurityEscalations = 0;
  let trajectorySessionRecallCount = 0;
  let trajectorySessionRecallWarningCount = 0;

  for (const event of trajectory.events) {
    switch (event.kind) {
      case "provider-iteration":
        metrics.providerIterations += 1;
        break;
      case "provider-budget-exhausted":
        trajectoryProviderBudgetExhaustions += 1;
        break;
      case "prompt-assembled":
        metrics.promptAssemblies += 1;
        break;
      case "skill-route-usage":
      case "skill-route-telemetry":
        metrics.skillRouteEvents += 1;
        break;
      case "session-recall-decision":
        metrics.sessionRecallTriggered ||= readBoolean(event.data.triggered);
        trajectorySessionRecallCount += 1;
        trajectorySessionRecallWarningCount += readNonNegativeInteger(event.data.warningCount);
        break;
      case "external-memory-recall":
        metrics.externalMemoryRecallCount += 1;
        break;
      case "memory-write":
        metrics.memoryWrites += 1;
        break;
      case "memory-promotion":
        metrics.memoryPromotions += 1;
        break;
      case "security-risk-escalated":
        trajectorySecurityEscalations += 1;
        break;
      case "agent-cancelled":
        metrics.agentCancelled = true;
        break;
    }
  }

  metrics.providerBudgetExhaustions = Math.max(
    metrics.providerBudgetExhaustions,
    runtimeCounts.runtimeProviderBudgetExhaustions,
    trajectoryProviderBudgetExhaustions
  );
  metrics.securityEscalations = Math.max(
    metrics.securityEscalations,
    runtimeCounts.runtimeSecurityEscalations,
    trajectorySecurityEscalations
  );
  metrics.sessionRecallCount = Math.max(
    metrics.sessionRecallCount,
    runtimeCounts.runtimeSessionRecallCount,
    trajectorySessionRecallCount
  );
  metrics.sessionRecallWarningCount = trajectorySessionRecallWarningCount;
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

function readNonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
