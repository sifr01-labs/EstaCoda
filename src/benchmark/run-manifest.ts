import type {
  BenchmarkArtifactSummary,
  BenchmarkExecutionSummary,
  BenchmarkHomeMode,
  BenchmarkIdentity,
  BenchmarkModelSummary,
  BenchmarkPolicy,
  BenchmarkRunStatus,
  EstaCodaBenchmarkIdentity
} from "./schema.js";
import { createBenchmarkRunSummary, type BenchmarkRunSummary, type BenchmarkMetrics } from "./schema.js";

export const CONTAINER_BENCHMARK_POLICY = {
  name: "container-benchmark" as const satisfies BenchmarkPolicy,
  rules: [
    "workspace must be explicit",
    "workspace is trusted for this run only",
    "no interactive approval prompts",
    "hard-deny command floor remains active",
    "no access to real user home unless explicitly passed",
    "no memory/session carryover when using a generated isolated home",
    "artifacts are redacted by default"
  ] as const
};

export function buildBenchmarkExecutionSummary(input: {
  status: BenchmarkRunStatus;
  startedAt: Date | string;
  endedAt: Date | string;
  workspace: string;
  home: string;
  homeMode: BenchmarkHomeMode;
  sessionId?: string | null;
  trajectoryId?: string | null;
}): BenchmarkExecutionSummary {
  const startedAt = toIsoString(input.startedAt);
  const endedAt = toIsoString(input.endedAt);
  return {
    status: input.status,
    startedAt,
    endedAt,
    wallClockMs: Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)),
    workspace: input.workspace,
    home: input.home,
    homeMode: input.homeMode,
    policy: CONTAINER_BENCHMARK_POLICY.name,
    sessionId: input.sessionId ?? null,
    trajectoryId: input.trajectoryId ?? null
  };
}

export function buildBenchmarkRunManifest(input: {
  benchmark?: BenchmarkIdentity | null;
  estacoda: EstaCodaBenchmarkIdentity;
  execution: BenchmarkExecutionSummary;
  model: BenchmarkModelSummary;
  metrics?: BenchmarkMetrics;
  finalAnswer?: string;
  artifacts: BenchmarkArtifactSummary;
  failure?: BenchmarkRunSummary["failure"];
}): BenchmarkRunSummary {
  return createBenchmarkRunSummary(input);
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
