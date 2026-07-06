import { describe, expect, it } from "vitest";
import { buildBenchmarkExecutionSummary, buildBenchmarkRunManifest, CONTAINER_BENCHMARK_POLICY } from "./run-manifest.js";

describe("benchmark run manifest", () => {
  it("documents the concrete container benchmark policy", () => {
    expect(CONTAINER_BENCHMARK_POLICY.rules).toContain("hard-deny command floor remains active");
    expect(CONTAINER_BENCHMARK_POLICY.rules).toContain("artifacts are redacted by default");
  });

  it("builds execution summary with wall-clock duration", () => {
    expect(buildBenchmarkExecutionSummary({
      status: "success",
      startedAt: "2026-07-05T00:00:00.000Z",
      endedAt: "2026-07-05T00:00:02.500Z",
      workspace: "/app",
      home: "/tmp/home",
      homeMode: "explicit",
      sessionId: "session-1"
    })).toMatchObject({
      wallClockMs: 2_500,
      policy: "container-benchmark",
      trajectoryId: null
    });
  });

  it("builds a full benchmark manifest", () => {
    const execution = buildBenchmarkExecutionSummary({
      status: "success",
      startedAt: new Date("2026-07-05T00:00:00.000Z"),
      endedAt: new Date("2026-07-05T00:00:01.000Z"),
      workspace: "/app",
      home: "/tmp/home",
      homeMode: "generated"
    });

    const manifest = buildBenchmarkRunManifest({
      benchmark: { name: "terminal-bench", version: "2.0", taskId: "task-a", attempt: 1 },
      estacoda: { version: "0.1.0", gitCommit: "abc123" },
      execution,
      model: { provider: "openai", id: "gpt-5", settings: { temperature: 0, maxTokens: 1200 } },
      artifacts: { summary: "/tmp/summary.json", eventLog: "/tmp/events.jsonl", trajectory: null, trajectorySummary: null, history: null, stdout: null, stderr: null },
      finalAnswer: "done"
    });

    expect(manifest.benchmark?.name).toBe("terminal-bench");
    expect(manifest.finalAnswer).toBe("done");
  });
});
