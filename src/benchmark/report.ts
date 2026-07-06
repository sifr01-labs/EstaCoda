import type { BenchmarkComparison, BenchmarkMetricDelta } from "./compare.js";
import { formatNumber, formatPercent, metricLabel } from "./compare.js";

export function renderBenchmarkComparisonMarkdown(comparison: BenchmarkComparison): string {
  const lines = [
    "# Benchmark Comparison",
    "",
    `Generated: ${comparison.generatedAt}`,
    "",
    "## Aggregate Deltas",
    "",
    "| Metric | Baseline | Current | Delta |",
    "| --- | ---: | ---: | ---: |",
    ...comparison.aggregateDeltas.map((delta) => metricRow(delta)),
    "",
    "## Warnings",
    "",
    ...listOrNone(comparison.warnings),
    "",
    "## Per-Scenario Deltas",
    "",
    "| Scenario | Status | Duration | Tokens | Tool failures | Provider iterations | Memory writes | Memory promotions | Session recall | External memory recall | Security escalations |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...comparison.scenarios.map((scenario) => {
      const byMetric = new Map(scenario.deltas.map((delta) => [delta.metric, delta]));
      return [
        escapeCell(scenario.key),
        statusCell(scenario.baseline?.execution.status ?? null, scenario.current?.execution.status ?? null),
        deltaCell(byMetric.get("durationSeconds")),
        deltaCell(byMetric.get("totalTokens")),
        deltaCell(byMetric.get("toolFailures")),
        deltaCell(byMetric.get("providerIterations")),
        deltaCell(byMetric.get("memoryWrites")),
        deltaCell(byMetric.get("memoryPromotions")),
        deltaCell(byMetric.get("sessionRecallCount")),
        deltaCell(byMetric.get("externalMemoryRecallCount")),
        deltaCell(byMetric.get("securityEscalations"))
      ].join(" | ");
    }).map((row) => `| ${row} |`),
    "",
    "## Improvements",
    "",
    ...listOrNone(comparison.improvements),
    "",
    "## Regressions",
    "",
    ...listOrNone(comparison.regressions),
    ""
  ];
  return lines.join("\n");
}

function metricRow(delta: BenchmarkMetricDelta): string {
  return `| ${metricLabel(delta.metric)} | ${valueCell(delta.baseline)} | ${valueCell(delta.current)} | ${deltaCell(delta)} |`;
}

function statusCell(baseline: string | null, current: string | null): string {
  return `${baseline ?? "missing"} -> ${current ?? "missing"}`;
}

function deltaCell(delta: BenchmarkMetricDelta | undefined): string {
  if (delta === undefined) {
    return "n/a";
  }
  if (delta.delta === null) {
    return "n/a";
  }
  const prefix = delta.delta > 0 ? "+" : "";
  const percent = delta.percentDelta === null ? "" : ` (${formatPercent(delta.percentDelta)})`;
  return `${prefix}${formatNumber(delta.delta)}${percent}`;
}

function valueCell(value: number | null): string {
  return value === null ? "n/a" : formatNumber(value);
}

function listOrNone(items: readonly string[]): string[] {
  return items.length === 0 ? ["- None"] : items.map((item) => `- ${item}`);
}

function escapeCell(value: string): string {
  return value.replace(/\|/gu, "\\|");
}
