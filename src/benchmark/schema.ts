export const BENCHMARK_SCHEMA_VERSION = 1;

export const BENCHMARK_RUN_STATUSES = [
  "success",
  "task_failed",
  "timeout",
  "model_error",
  "provider_error",
  "tool_error",
  "runtime_error",
  "adapter_error",
  "config_error"
] as const;

export type BenchmarkRunStatus = typeof BENCHMARK_RUN_STATUSES[number];

export type BenchmarkIdentity = {
  name: string;
  version: string;
  taskId: string;
  attempt: number;
};

export type BenchmarkHomeMode = "explicit" | "generated";

export type BenchmarkPolicy = "container-benchmark";

export type BenchmarkModelSettings = {
  temperature: number | null;
  maxTokens: number | null;
};

export type BenchmarkModelSummary = {
  provider: string;
  id: string;
  settings: BenchmarkModelSettings;
};

export type BenchmarkMetrics = {
  providerCalls: number;
  providerToolCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number | null;
};

export type BenchmarkExecutionSummary = {
  status: BenchmarkRunStatus;
  startedAt: string;
  endedAt: string;
  wallClockMs: number;
  workspace: string;
  home: string;
  homeMode: BenchmarkHomeMode;
  policy: BenchmarkPolicy;
  sessionId: string | null;
  trajectoryId: string | null;
};

export type BenchmarkArtifactSummary = {
  summary: string;
  eventLog: string;
  trajectory: string | null;
  stdout: string | null;
  stderr: string | null;
};

export type BenchmarkFailureSummary = {
  status: BenchmarkRunStatus;
  message: string;
  code?: string;
  details?: unknown;
};

export type EstaCodaBenchmarkIdentity = {
  version: string;
  gitCommit: string | null;
};

export type BenchmarkRunSummary = {
  schemaVersion: typeof BENCHMARK_SCHEMA_VERSION;
  runMode: "headless-benchmark";
  benchmark: BenchmarkIdentity | null;
  estacoda: EstaCodaBenchmarkIdentity;
  execution: BenchmarkExecutionSummary;
  model: BenchmarkModelSummary;
  metrics: BenchmarkMetrics;
  finalAnswer: string;
  artifacts: BenchmarkArtifactSummary;
  failure: BenchmarkFailureSummary | null;
};

export function isBenchmarkRunStatus(value: unknown): value is BenchmarkRunStatus {
  return typeof value === "string" && (BENCHMARK_RUN_STATUSES as readonly string[]).includes(value);
}

export function createEmptyBenchmarkMetrics(): BenchmarkMetrics {
  return {
    providerCalls: 0,
    providerToolCalls: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: null
  };
}

export function createBenchmarkRunSummary(input: {
  benchmark?: BenchmarkIdentity | null;
  estacoda: EstaCodaBenchmarkIdentity;
  execution: BenchmarkExecutionSummary;
  model: BenchmarkModelSummary;
  metrics?: BenchmarkMetrics;
  finalAnswer?: string;
  artifacts: BenchmarkArtifactSummary;
  failure?: BenchmarkFailureSummary | null;
}): BenchmarkRunSummary {
  return {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    runMode: "headless-benchmark",
    benchmark: input.benchmark ?? null,
    estacoda: input.estacoda,
    execution: input.execution,
    model: input.model,
    metrics: input.metrics ?? createEmptyBenchmarkMetrics(),
    finalAnswer: input.finalAnswer ?? "",
    artifacts: input.artifacts,
    failure: input.failure ?? null
  };
}
