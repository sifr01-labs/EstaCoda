import { describe, expect, it } from "vitest";
import { compareBenchmarkHistories } from "./compare.js";
import { renderBenchmarkComparisonMarkdown } from "./report.js";
import type { BenchmarkHistoryRecord } from "./history.js";
import { createEmptyBenchmarkMetrics } from "./schema.js";

describe("benchmark comparison", () => {
  it("computes aggregate and per-scenario deltas with warning-only regressions", () => {
    const baseline = [
      recordFixture("task-a", {
        durationSeconds: 10,
        inputTokens: 100,
        outputTokens: 50,
        toolFailures: 0,
        estimatedCostUsd: 0.01
      })
    ];
    const current = [
      recordFixture("task-a", {
        durationSeconds: 14,
        inputTokens: 160,
        outputTokens: 70,
        toolFailures: 1,
        estimatedCostUsd: 0.02
      })
    ];

    const comparison = compareBenchmarkHistories({
      baseline,
      current,
      generatedAt: "2026-07-06T00:00:00.000Z"
    });

    expect(comparison.aggregateDeltas).toContainEqual(expect.objectContaining({
      metric: "totalTokens",
      baseline: 150,
      current: 230,
      delta: 80
    }));
    expect(comparison.warnings).toEqual(expect.arrayContaining([
      "aggregate: duration increased by 40%.",
      "aggregate: estimated cost increased by 100%.",
      "aggregate: tool failures increased by 1.",
      "fixture-suite/1/task-a: duration increased by 40%.",
      "fixture-suite/1/task-a: estimated cost increased by 100%.",
      "fixture-suite/1/task-a: tool failures increased by 1."
    ]));
  });

  it("keeps cost nullable while comparing token counts as primary measurements", () => {
    const comparison = compareBenchmarkHistories({
      baseline: [recordFixture("task-a", { inputTokens: 10, outputTokens: 10, estimatedCostUsd: null })],
      current: [recordFixture("task-a", { inputTokens: 20, outputTokens: 20, estimatedCostUsd: null })]
    });

    expect(comparison.aggregateDeltas).toContainEqual(expect.objectContaining({
      metric: "estimatedCostUsd",
      baseline: null,
      current: null,
      delta: null,
      percentDelta: null
    }));
    expect(comparison.aggregateDeltas).toContainEqual(expect.objectContaining({
      metric: "totalTokens",
      baseline: 20,
      current: 40,
      delta: 20
    }));
  });

  it("renders concise markdown reports", () => {
    const comparison = compareBenchmarkHistories({
      baseline: [recordFixture("task-a", { status: "success", toolFailures: 1 })],
      current: [recordFixture("task-a", { status: "success", toolFailures: 0 })],
      generatedAt: "2026-07-06T00:00:00.000Z"
    });

    const markdown = renderBenchmarkComparisonMarkdown(comparison);

    expect(markdown).toContain("# Benchmark Comparison");
    expect(markdown).toContain("| total tokens |");
    expect(markdown).toContain("| fixture-suite/1/task-a | success -> success |");
    expect(markdown).toContain("tool failures improved by 1");
  });
});

function recordFixture(
  taskId: string,
  input: Partial<{
    status: string;
    durationSeconds: number;
    inputTokens: number;
    outputTokens: number;
    toolCalls: number;
    toolFailures: number;
    providerIterations: number;
    providerBudgetExhaustions: number;
    memoryWrites: number;
    memoryPromotions: number;
    sessionRecallCount: number;
    externalMemoryRecallCount: number;
    securityEscalations: number;
    estimatedCostUsd: number | null;
  }> = {}
): BenchmarkHistoryRecord {
  const inputTokens = input.inputTokens ?? 100;
  const outputTokens = input.outputTokens ?? 50;
  const totalTokens = inputTokens + outputTokens;
  const metrics = {
    ...createEmptyBenchmarkMetrics(),
    inputTokens,
    outputTokens,
    totalTokens,
    toolCalls: input.toolCalls ?? 2,
    toolFailures: input.toolFailures ?? 0,
    providerIterations: input.providerIterations ?? 1,
    providerBudgetExhaustions: input.providerBudgetExhaustions ?? 0,
    memoryWrites: input.memoryWrites ?? 0,
    memoryPromotions: input.memoryPromotions ?? 0,
    sessionRecallCount: input.sessionRecallCount ?? 0,
    externalMemoryRecallCount: input.externalMemoryRecallCount ?? 0,
    securityEscalations: input.securityEscalations ?? 0,
    estimatedCostUsd: input.estimatedCostUsd ?? null
  };
  return {
    schemaVersion: 1,
    kind: "benchmark-history-record",
    timestamp: "2026-07-06T00:00:00.000Z",
    estacoda: { version: "0.1.0", gitCommit: "abc123", branch: "main" },
    benchmark: { name: "fixture-suite", version: "1", taskId, attempt: 1 },
    provider: "openai",
    model: "gpt-test",
    executionSettings: { temperature: 0, maxTokens: null },
    execution: {
      status: input.status ?? "success",
      durationSeconds: input.durationSeconds ?? 10,
      wallClockMs: (input.durationSeconds ?? 10) * 1000
    },
    metrics,
    tokenCounts: { inputTokens, outputTokens, totalTokens },
    estimatedCostUsd: metrics.estimatedCostUsd
  };
}
