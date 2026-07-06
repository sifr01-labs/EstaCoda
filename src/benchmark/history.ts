import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BenchmarkMetrics, BenchmarkModelSettings, BenchmarkRunSummary } from "./schema.js";
import { createEmptyBenchmarkMetrics, createBenchmarkRunSummary } from "./schema.js";

export const BENCHMARK_HISTORY_SCHEMA_VERSION = 1;

export type BenchmarkHistoryRecord = {
  schemaVersion: typeof BENCHMARK_HISTORY_SCHEMA_VERSION;
  kind: "benchmark-history-record";
  timestamp: string;
  estacoda: {
    version: string;
    gitCommit: string | null;
    branch: string | null;
  };
  benchmark: {
    name: string;
    version: string;
    taskId: string;
    attempt: number;
  } | null;
  provider: string;
  model: string;
  executionSettings: BenchmarkModelSettings;
  execution: {
    status: string;
    durationSeconds: number;
    wallClockMs: number;
  };
  metrics: BenchmarkMetrics;
  tokenCounts: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  estimatedCostUsd: number | null;
};

export function createBenchmarkHistoryRecord(
  summary: BenchmarkRunSummary,
  input: { timestamp?: Date | string; branch?: string | null } = {}
): BenchmarkHistoryRecord {
  const metrics = normalizeMetrics(summary.metrics);
  return {
    schemaVersion: BENCHMARK_HISTORY_SCHEMA_VERSION,
    kind: "benchmark-history-record",
    timestamp: toIsoString(input.timestamp ?? summary.execution.endedAt),
    estacoda: {
      version: summary.estacoda.version,
      gitCommit: summary.estacoda.gitCommit,
      branch: input.branch ?? null
    },
    benchmark: summary.benchmark === null ? null : { ...summary.benchmark },
    provider: summary.model.provider,
    model: summary.model.id,
    executionSettings: { ...summary.model.settings },
    execution: {
      status: summary.execution.status,
      durationSeconds: summary.execution.wallClockMs / 1000,
      wallClockMs: summary.execution.wallClockMs
    },
    metrics,
    tokenCounts: {
      inputTokens: metrics.inputTokens,
      outputTokens: metrics.outputTokens,
      totalTokens: metrics.totalTokens
    },
    estimatedCostUsd: metrics.estimatedCostUsd
  };
}

export async function appendBenchmarkHistoryRecord(path: string, record: BenchmarkHistoryRecord): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "a" });
}

export async function readBenchmarkHistoryRecords(path: string): Promise<BenchmarkHistoryRecord[]> {
  const content = await readFile(path, "utf8");
  return parseBenchmarkHistoryRecords(content);
}

export function parseBenchmarkHistoryRecords(content: string): BenchmarkHistoryRecord[] {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return [];
  }

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return normalizeBenchmarkInput(parsed);
    } catch (error) {
      if (!trimmed.includes("\n")) {
        throw error;
      }
    }
  }

  return trimmed.split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => normalizeBenchmarkInput(JSON.parse(line) as unknown));
}

export function normalizeBenchmarkInput(value: unknown): BenchmarkHistoryRecord[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => normalizeBenchmarkInput(item));
  }
  if (isHistoryRecord(value)) {
    return [normalizeHistoryRecord(value)];
  }
  if (isRunSummaryLike(value)) {
    return [createBenchmarkHistoryRecord(normalizeRunSummary(value))];
  }
  throw new Error("Unsupported benchmark history artifact format.");
}

export function scenarioKey(record: BenchmarkHistoryRecord): string {
  if (record.benchmark === null) {
    return `${record.provider}/${record.model}`;
  }
  return `${record.benchmark.name}/${record.benchmark.version}/${record.benchmark.taskId}`;
}

function normalizeHistoryRecord(record: BenchmarkHistoryRecord): BenchmarkHistoryRecord {
  const metrics = normalizeMetrics(record.metrics);
  return {
    ...record,
    schemaVersion: BENCHMARK_HISTORY_SCHEMA_VERSION,
    kind: "benchmark-history-record",
    estacoda: {
      version: record.estacoda.version,
      gitCommit: record.estacoda.gitCommit ?? null,
      branch: record.estacoda.branch ?? null
    },
    benchmark: record.benchmark === null ? null : {
      name: record.benchmark.name,
      version: record.benchmark.version,
      taskId: record.benchmark.taskId,
      attempt: record.benchmark.attempt ?? 1
    },
    execution: {
      status: record.execution.status,
      wallClockMs: readNumber(record.execution.wallClockMs),
      durationSeconds: readNumber(record.execution.durationSeconds) || readNumber(record.execution.wallClockMs) / 1000
    },
    metrics,
    tokenCounts: {
      inputTokens: metrics.inputTokens,
      outputTokens: metrics.outputTokens,
      totalTokens: metrics.totalTokens
    },
    estimatedCostUsd: metrics.estimatedCostUsd
  };
}

function normalizeRunSummary(summary: BenchmarkRunSummary): BenchmarkRunSummary {
  return createBenchmarkRunSummary({
    benchmark: summary.benchmark ?? null,
    estacoda: {
      version: summary.estacoda?.version ?? "unknown",
      gitCommit: summary.estacoda?.gitCommit ?? null
    },
    execution: {
      status: summary.execution.status,
      startedAt: summary.execution.startedAt,
      endedAt: summary.execution.endedAt,
      wallClockMs: readNumber(summary.execution.wallClockMs),
      workspace: summary.execution.workspace ?? "",
      home: summary.execution.home ?? "",
      homeMode: summary.execution.homeMode ?? "generated",
      policy: summary.execution.policy ?? "container-benchmark",
      sessionId: summary.execution.sessionId ?? null,
      trajectoryId: summary.execution.trajectoryId ?? null
    },
    model: {
      provider: summary.model?.provider ?? "unknown",
      id: summary.model?.id ?? "unknown",
      settings: {
        temperature: summary.model?.settings?.temperature ?? null,
        maxTokens: summary.model?.settings?.maxTokens ?? null
      }
    },
    metrics: normalizeMetrics(summary.metrics),
    finalAnswer: summary.finalAnswer ?? "",
    artifacts: {
      summary: summary.artifacts?.summary ?? "",
      eventLog: summary.artifacts?.eventLog ?? "",
      trajectory: summary.artifacts?.trajectory ?? null,
      trajectorySummary: summary.artifacts?.trajectorySummary ?? null,
      history: summary.artifacts?.history ?? null,
      stdout: summary.artifacts?.stdout ?? null,
      stderr: summary.artifacts?.stderr ?? null
    },
    failure: summary.failure ?? null
  });
}

function normalizeMetrics(metrics: Partial<BenchmarkMetrics> | undefined): BenchmarkMetrics {
  return {
    ...createEmptyBenchmarkMetrics(),
    ...(metrics ?? {}),
    estimatedCostUsd: metrics?.estimatedCostUsd ?? null
  };
}

function isHistoryRecord(value: unknown): value is BenchmarkHistoryRecord {
  return value !== null &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === "benchmark-history-record";
}

function isRunSummaryLike(value: unknown): value is BenchmarkRunSummary {
  return value !== null &&
    typeof value === "object" &&
    (value as { runMode?: unknown }).runMode === "headless-benchmark";
}

function readNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
