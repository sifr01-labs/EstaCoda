import { describe, expect, it } from "vitest";
import {
  BENCHMARK_SCHEMA_VERSION,
  createBenchmarkRunSummary,
  createEmptyBenchmarkMetrics,
  isBenchmarkRunStatus
} from "./schema.js";

describe("benchmark schema", () => {
  it("builds a valid success summary with nullable benchmark identity", () => {
    const summary = createBenchmarkRunSummary({
      estacoda: { version: "0.1.0", gitCommit: "abc123" },
      execution: {
        status: "success",
        startedAt: "2026-07-05T00:00:00.000Z",
        endedAt: "2026-07-05T00:01:00.000Z",
        wallClockMs: 60_000,
        workspace: "/app",
        home: "/tmp/estacoda-home",
        homeMode: "explicit",
        policy: "container-benchmark",
        sessionId: "session-1",
        trajectoryId: "trajectory-1"
      },
      model: {
        provider: "anthropic",
        id: "claude-sonnet",
        settings: { temperature: 0, maxTokens: 1200 }
      },
      artifacts: {
        summary: "/tmp/summary.json",
        eventLog: "/tmp/events.jsonl",
        trajectory: null,
        stdout: null,
        stderr: null
      }
    });

    expect(summary.schemaVersion).toBe(BENCHMARK_SCHEMA_VERSION);
    expect(summary.runMode).toBe("headless-benchmark");
    expect(summary.benchmark).toBeNull();
    expect(summary.metrics.estimatedCostUsd).toBeNull();
    expect(summary.failure).toBeNull();
  });

  it("preserves benchmark identity when provided", () => {
    const summary = createBenchmarkRunSummary({
      benchmark: { name: "terminal-bench", version: "2.0", taskId: "task-a", attempt: 1 },
      estacoda: { version: "0.1.0", gitCommit: null },
      execution: {
        status: "task_failed",
        startedAt: "2026-07-05T00:00:00.000Z",
        endedAt: "2026-07-05T00:00:10.000Z",
        wallClockMs: 10_000,
        workspace: "/app",
        home: "/tmp/home",
        homeMode: "generated",
        policy: "container-benchmark",
        sessionId: null,
        trajectoryId: null
      },
      model: {
        provider: "openai",
        id: "gpt-5",
        settings: { temperature: 0, maxTokens: null }
      },
      metrics: createEmptyBenchmarkMetrics(),
      artifacts: {
        summary: "/tmp/summary.json",
        eventLog: "/tmp/events.jsonl",
        trajectory: "/tmp/trajectory.json",
        stdout: "/tmp/stdout.log",
        stderr: "/tmp/stderr.log"
      },
      failure: {
        status: "task_failed",
        message: "Verifier failed."
      }
    });

    expect(summary.benchmark).toEqual({ name: "terminal-bench", version: "2.0", taskId: "task-a", attempt: 1 });
    expect(summary.failure?.status).toBe("task_failed");
  });

  it("recognizes only supported status values", () => {
    expect(isBenchmarkRunStatus("success")).toBe(true);
    expect(isBenchmarkRunStatus("config_error")).toBe(true);
    expect(isBenchmarkRunStatus("unknown")).toBe(false);
  });
});
