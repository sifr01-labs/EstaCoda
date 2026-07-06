import type { BenchmarkHistoryRecord } from "./history.js";
import { scenarioKey } from "./history.js";

export type BenchmarkComparisonMetric =
  | "successRate"
  | "durationSeconds"
  | "inputTokens"
  | "outputTokens"
  | "totalTokens"
  | "estimatedCostUsd"
  | "toolCalls"
  | "toolFailures"
  | "providerIterations"
  | "providerBudgetExhaustions"
  | "memoryWrites"
  | "memoryPromotions"
  | "sessionRecallCount"
  | "externalMemoryRecallCount"
  | "securityEscalations";

export type BenchmarkMetricDelta = {
  metric: BenchmarkComparisonMetric;
  baseline: number | null;
  current: number | null;
  delta: number | null;
  percentDelta: number | null;
};

export type BenchmarkScenarioComparison = {
  key: string;
  baseline: BenchmarkHistoryRecord | null;
  current: BenchmarkHistoryRecord | null;
  deltas: BenchmarkMetricDelta[];
  warnings: string[];
  improvements: string[];
  regressions: string[];
};

export type BenchmarkComparison = {
  generatedAt: string;
  baseline: BenchmarkComparisonAggregate;
  current: BenchmarkComparisonAggregate;
  aggregateDeltas: BenchmarkMetricDelta[];
  scenarios: BenchmarkScenarioComparison[];
  warnings: string[];
  improvements: string[];
  regressions: string[];
};

export type BenchmarkComparisonAggregate = {
  runs: number;
  successes: number;
  successRate: number;
  durationSeconds: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number | null;
  toolCalls: number;
  toolFailures: number;
  providerIterations: number;
  providerBudgetExhaustions: number;
  memoryWrites: number;
  memoryPromotions: number;
  sessionRecallCount: number;
  externalMemoryRecallCount: number;
  securityEscalations: number;
};

const METRICS: readonly BenchmarkComparisonMetric[] = [
  "successRate",
  "durationSeconds",
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "estimatedCostUsd",
  "toolCalls",
  "toolFailures",
  "providerIterations",
  "providerBudgetExhaustions",
  "memoryWrites",
  "memoryPromotions",
  "sessionRecallCount",
  "externalMemoryRecallCount",
  "securityEscalations"
];

export function compareBenchmarkHistories(input: {
  baseline: readonly BenchmarkHistoryRecord[];
  current: readonly BenchmarkHistoryRecord[];
  generatedAt?: Date | string;
}): BenchmarkComparison {
  const baselineByKey = indexByScenario(input.baseline);
  const currentByKey = indexByScenario(input.current);
  const keys = Array.from(new Set([...baselineByKey.keys(), ...currentByKey.keys()])).sort();
  const scenarios = keys.map((key) => compareScenario(key, baselineByKey.get(key) ?? null, currentByKey.get(key) ?? null));
  const baseline = aggregateRecords(input.baseline);
  const current = aggregateRecords(input.current);
  const aggregateDeltas = deltasForValues(baseline, current);
  const aggregateWarnings = thresholdWarnings("aggregate", aggregateDeltas, baseline.runs, current.runs);
  const scenarioWarnings = scenarios.flatMap((scenario) => scenario.warnings);
  const improvements = [
    ...aggregateImprovements(aggregateDeltas),
    ...scenarios.flatMap((scenario) => scenario.improvements)
  ];
  const regressions = [
    ...aggregateRegressions(aggregateDeltas),
    ...scenarios.flatMap((scenario) => scenario.regressions)
  ];

  return {
    generatedAt: toIsoString(input.generatedAt ?? new Date()),
    baseline,
    current,
    aggregateDeltas,
    scenarios,
    warnings: [...aggregateWarnings, ...scenarioWarnings],
    improvements,
    regressions
  };
}

function compareScenario(
  key: string,
  baseline: BenchmarkHistoryRecord | null,
  current: BenchmarkHistoryRecord | null
): BenchmarkScenarioComparison {
  if (baseline === null || current === null) {
    const message = baseline === null
      ? `${key}: missing from baseline`
      : `${key}: missing from current`;
    return {
      key,
      baseline,
      current,
      deltas: [],
      warnings: [message],
      improvements: [],
      regressions: [message]
    };
  }

  const baselineValues = valuesForRecord(baseline);
  const currentValues = valuesForRecord(current);
  const deltas = deltasForValues(baselineValues, currentValues);
  return {
    key,
    baseline,
    current,
    deltas,
    warnings: thresholdWarnings(key, deltas, 1, 1),
    improvements: scenarioImprovements(key, deltas),
    regressions: scenarioRegressions(key, deltas)
  };
}

function aggregateRecords(records: readonly BenchmarkHistoryRecord[]): BenchmarkComparisonAggregate {
  const costs = records.map((record) => record.estimatedCostUsd);
  const costAvailable = records.length > 0 && costs.every((cost) => cost !== null);
  return records.reduce<BenchmarkComparisonAggregate>((aggregate, record) => {
    aggregate.runs += 1;
    aggregate.successes += isSuccess(record) ? 1 : 0;
    aggregate.successRate = aggregate.runs === 0 ? 0 : aggregate.successes / aggregate.runs;
    aggregate.durationSeconds += record.execution.durationSeconds;
    aggregate.inputTokens += record.tokenCounts.inputTokens;
    aggregate.outputTokens += record.tokenCounts.outputTokens;
    aggregate.totalTokens += record.tokenCounts.totalTokens;
    aggregate.toolCalls += record.metrics.toolCalls;
    aggregate.toolFailures += record.metrics.toolFailures;
    aggregate.providerIterations += record.metrics.providerIterations;
    aggregate.providerBudgetExhaustions += record.metrics.providerBudgetExhaustions;
    aggregate.memoryWrites += record.metrics.memoryWrites;
    aggregate.memoryPromotions += record.metrics.memoryPromotions;
    aggregate.sessionRecallCount += record.metrics.sessionRecallCount;
    aggregate.externalMemoryRecallCount += record.metrics.externalMemoryRecallCount;
    aggregate.securityEscalations += record.metrics.securityEscalations;
    if (costAvailable) {
      aggregate.estimatedCostUsd = (aggregate.estimatedCostUsd ?? 0) + (record.estimatedCostUsd ?? 0);
    }
    return aggregate;
  }, emptyAggregate(costAvailable));
}

function emptyAggregate(costAvailable: boolean): BenchmarkComparisonAggregate {
  return {
    runs: 0,
    successes: 0,
    successRate: 0,
    durationSeconds: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: costAvailable ? 0 : null,
    toolCalls: 0,
    toolFailures: 0,
    providerIterations: 0,
    providerBudgetExhaustions: 0,
    memoryWrites: 0,
    memoryPromotions: 0,
    sessionRecallCount: 0,
    externalMemoryRecallCount: 0,
    securityEscalations: 0
  };
}

function valuesForRecord(record: BenchmarkHistoryRecord): BenchmarkComparisonAggregate {
  return {
    runs: 1,
    successes: isSuccess(record) ? 1 : 0,
    successRate: isSuccess(record) ? 1 : 0,
    durationSeconds: record.execution.durationSeconds,
    inputTokens: record.tokenCounts.inputTokens,
    outputTokens: record.tokenCounts.outputTokens,
    totalTokens: record.tokenCounts.totalTokens,
    estimatedCostUsd: record.estimatedCostUsd,
    toolCalls: record.metrics.toolCalls,
    toolFailures: record.metrics.toolFailures,
    providerIterations: record.metrics.providerIterations,
    providerBudgetExhaustions: record.metrics.providerBudgetExhaustions,
    memoryWrites: record.metrics.memoryWrites,
    memoryPromotions: record.metrics.memoryPromotions,
    sessionRecallCount: record.metrics.sessionRecallCount,
    externalMemoryRecallCount: record.metrics.externalMemoryRecallCount,
    securityEscalations: record.metrics.securityEscalations
  };
}

function deltasForValues(
  baseline: Pick<BenchmarkComparisonAggregate, BenchmarkComparisonMetric>,
  current: Pick<BenchmarkComparisonAggregate, BenchmarkComparisonMetric>
): BenchmarkMetricDelta[] {
  return METRICS.map((metric) => {
    const baselineValue = baseline[metric];
    const currentValue = current[metric];
    const delta = baselineValue === null || currentValue === null ? null : currentValue - baselineValue;
    return {
      metric,
      baseline: baselineValue,
      current: currentValue,
      delta,
      percentDelta: percentDelta(baselineValue, currentValue)
    };
  });
}

function thresholdWarnings(
  label: string,
  deltas: readonly BenchmarkMetricDelta[],
  baselineRuns: number,
  currentRuns: number
): string[] {
  const warnings: string[] = [];
  const byMetric = new Map(deltas.map((delta) => [delta.metric, delta]));
  const successRate = byMetric.get("successRate");
  if (successRate?.delta !== null && successRate !== undefined && successRate.delta < 0) {
    warnings.push(`${label}: success rate decreased by ${formatPercent(Math.abs(successRate.delta))}.`);
  }
  addGrowthWarning(warnings, label, byMetric.get("durationSeconds"), "duration", 0.2, baselineRuns === currentRuns ? currentRuns : undefined, 1);
  addGrowthWarning(warnings, label, byMetric.get("totalTokens"), "total tokens", 0.2, undefined, 100);
  addGrowthWarning(warnings, label, byMetric.get("estimatedCostUsd"), "estimated cost", 0.2, undefined, 0);
  const toolFailures = byMetric.get("toolFailures");
  if (toolFailures?.delta !== null && toolFailures !== undefined && toolFailures.delta > 0) {
    warnings.push(`${label}: tool failures increased by ${formatNumber(toolFailures.delta)}.`);
  }
  return warnings;
}

function addGrowthWarning(
  warnings: string[],
  label: string,
  delta: BenchmarkMetricDelta | undefined,
  displayName: string,
  ratioThreshold: number,
  denominator?: number,
  absoluteThreshold = 0
): void {
  if (delta === undefined || delta.delta === null || delta.percentDelta === null || delta.delta <= absoluteThreshold) {
    return;
  }
  const perRunDelta = denominator === undefined || denominator <= 0 ? delta.delta : delta.delta / denominator;
  if (delta.percentDelta >= ratioThreshold && perRunDelta > absoluteThreshold) {
    warnings.push(`${label}: ${displayName} increased by ${formatPercent(delta.percentDelta)}.`);
  }
}

function aggregateImprovements(deltas: readonly BenchmarkMetricDelta[]): string[] {
  return improvementsForLabel("aggregate", deltas);
}

function aggregateRegressions(deltas: readonly BenchmarkMetricDelta[]): string[] {
  return regressionsForLabel("aggregate", deltas);
}

function scenarioImprovements(label: string, deltas: readonly BenchmarkMetricDelta[]): string[] {
  return improvementsForLabel(label, deltas);
}

function scenarioRegressions(label: string, deltas: readonly BenchmarkMetricDelta[]): string[] {
  return regressionsForLabel(label, deltas);
}

function improvementsForLabel(label: string, deltas: readonly BenchmarkMetricDelta[]): string[] {
  const messages: string[] = [];
  for (const delta of deltas) {
    if (delta.delta === null) {
      continue;
    }
    if (delta.metric === "successRate" && delta.delta > 0) {
      messages.push(`${label}: success rate improved by ${formatPercent(delta.delta)}.`);
    } else if (isLowerBetter(delta.metric) && delta.delta < 0) {
      messages.push(`${label}: ${metricLabel(delta.metric)} improved by ${formatNumber(Math.abs(delta.delta))}.`);
    }
  }
  return messages;
}

function regressionsForLabel(label: string, deltas: readonly BenchmarkMetricDelta[]): string[] {
  const messages: string[] = [];
  for (const delta of deltas) {
    if (delta.delta === null) {
      continue;
    }
    if (delta.metric === "successRate" && delta.delta < 0) {
      messages.push(`${label}: success rate regressed by ${formatPercent(Math.abs(delta.delta))}.`);
    } else if (isLowerBetter(delta.metric) && delta.delta > 0) {
      messages.push(`${label}: ${metricLabel(delta.metric)} regressed by ${formatNumber(delta.delta)}.`);
    }
  }
  return messages;
}

function indexByScenario(records: readonly BenchmarkHistoryRecord[]): Map<string, BenchmarkHistoryRecord> {
  const indexed = new Map<string, BenchmarkHistoryRecord>();
  for (const record of records) {
    const key = scenarioKey(record);
    const existing = indexed.get(key);
    if (existing === undefined || existing.timestamp < record.timestamp) {
      indexed.set(key, record);
    }
  }
  return indexed;
}

function isSuccess(record: BenchmarkHistoryRecord): boolean {
  return record.execution.status === "success";
}

function percentDelta(baseline: number | null, current: number | null): number | null {
  if (baseline === null || current === null || baseline === 0) {
    return null;
  }
  return (current - baseline) / baseline;
}

function isLowerBetter(metric: BenchmarkComparisonMetric): boolean {
  return metric !== "successRate" && metric !== "sessionRecallCount" && metric !== "externalMemoryRecallCount";
}

export function metricLabel(metric: BenchmarkComparisonMetric): string {
  return metric.replace(/[A-Z]/gu, (match) => ` ${match.toLowerCase()}`);
}

export function formatNumber(value: number): string {
  if (Number.isInteger(value)) {
    return String(value);
  }
  return value.toFixed(3).replace(/\.?0+$/u, "");
}

export function formatPercent(value: number): string {
  return `${formatNumber(value * 100)}%`;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
