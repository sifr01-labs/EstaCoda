import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RuntimeEvent } from "../contracts/runtime-event.js";
import type { Trajectory } from "../contracts/trajectory.js";
import {
  buildBenchmarkTrajectorySummary,
  writeBenchmarkEventArtifact,
  writeBenchmarkEventLogArtifact,
  writeBenchmarkHistoryArtifact,
  writeBenchmarkSummaryArtifact,
  writeBenchmarkTrajectoryArtifact,
  writeBenchmarkTrajectorySummaryArtifact
} from "./artifacts.js";
import { createEmptyBenchmarkMetrics } from "./schema.js";
import { createBenchmarkRunSummary } from "./schema.js";

describe("benchmark artifact writers", () => {
  it("writes valid redacted summary JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "estacoda-benchmark-artifacts-"));
    const path = join(dir, "summary.json");
    const summary = createBenchmarkRunSummary({
      estacoda: { version: "0.1.0", gitCommit: null },
      execution: {
        status: "runtime_error",
        startedAt: "2026-07-05T00:00:00.000Z",
        endedAt: "2026-07-05T00:00:01.000Z",
        wallClockMs: 1_000,
        workspace: "/app",
        home: "/tmp/home",
        homeMode: "generated",
        policy: "container-benchmark",
        sessionId: null,
        trajectoryId: null
      },
      model: { provider: "openai", id: "gpt-5", settings: { temperature: 0, maxTokens: null } },
      finalAnswer: "OPENAI_API_KEY=super-secret-value",
      artifacts: { summary: path, eventLog: join(dir, "events.jsonl"), trajectory: null, trajectorySummary: null, history: null, stdout: null, stderr: null },
      failure: { status: "runtime_error", message: "Bearer abcdefghijklmnopqrstuvwxyz123456" }
    });

    await writeBenchmarkSummaryArtifact(path, summary);

    const parsed = JSON.parse(await readFile(path, "utf8")) as typeof summary;
    expect(parsed.finalAnswer).toBe("OPENAI_API_KEY=[REDACTED]");
    expect(parsed.failure?.message).toBe("Bearer [REDACTED]");
  });

  it("writes valid event JSONL", async () => {
    const dir = await mkdtemp(join(tmpdir(), "estacoda-benchmark-events-"));
    const path = join(dir, "events.jsonl");
    const events: RuntimeEvent[] = [
      { kind: "agent-start", sessionId: "session-1", input: "token=abcdefghijklmnopqrstuvwxyz1234567890abcdef" },
      { kind: "agent-final", text: "done" }
    ];

    await writeBenchmarkEventLogArtifact(path, events);

    const lines = (await readFile(path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!) as RuntimeEvent).toMatchObject({ kind: "agent-start", input: "token=[REDACTED]" });
    expect(JSON.parse(lines[1]!) as RuntimeEvent).toMatchObject({ kind: "agent-final", text: "done" });
  });

  it("appends one event per line for streaming use", async () => {
    const dir = await mkdtemp(join(tmpdir(), "estacoda-benchmark-event-append-"));
    const path = join(dir, "events.jsonl");

    await writeBenchmarkEventArtifact(path, { kind: "tool-start", tool: "terminal.run", targetSummary: "\u001b[31mverify\u001b[0m" });
    await writeBenchmarkEventArtifact(path, { kind: "tool-result", tool: "terminal.run", ok: true });

    const text = await readFile(path, "utf8");
    expect(text.trim().split("\n")).toHaveLength(2);
    expect(text).not.toMatch(/\u001b\[/u);
    expect(text).not.toContain("\\u001b");
  });

  it("writes redacted trajectory JSONL and ANSI-free trajectory summary artifacts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "estacoda-benchmark-trajectory-"));
    const trajectoryPath = join(dir, "trajectory.jsonl");
    const summaryPath = join(dir, "trajectory-summary.json");
    const trajectory: Trajectory = {
      id: "trajectory-1",
      profileId: "default",
      sessionId: "session-1",
      modelId: "gpt-test",
      events: [
        {
          id: "event-1",
          kind: "memory-write",
          timestamp: "2026-07-06T00:00:00.000Z",
          data: {
            note: "\u001b[31msecret token=abcdefghijklmnopqrstuvwxyz1234567890abcdef\u001b[0m"
          }
        }
      ],
      outcome: {
        success: true,
        summary: "done"
      }
    };
    const summary = buildBenchmarkTrajectorySummary(trajectory, createEmptyBenchmarkMetrics());

    await writeBenchmarkTrajectoryArtifact(trajectoryPath, trajectory);
    await writeBenchmarkTrajectorySummaryArtifact(summaryPath, summary);

    const trajectoryText = await readFile(trajectoryPath, "utf8");
    const summaryText = await readFile(summaryPath, "utf8");
    expect(trajectoryText).not.toMatch(/\u001b\[/u);
    expect(summaryText).not.toMatch(/\u001b\[/u);
    expect(trajectoryText).not.toContain("\\u001b");
    expect(summaryText).not.toContain("\\u001b");
    expect(trajectoryText).toContain("[REDACTED]");
    expect(JSON.parse(summaryText)).toMatchObject({
      id: "trajectory-1",
      eventKinds: {
        "memory-write": 1
      }
    });
  });

  it("appends redacted ANSI-free history records", async () => {
    const dir = await mkdtemp(join(tmpdir(), "estacoda-benchmark-history-"));
    const path = join(dir, "history.jsonl");

    await writeBenchmarkHistoryArtifact(path, {
      schemaVersion: 1,
      kind: "benchmark-history-record",
      timestamp: "2026-07-06T00:00:00.000Z",
      estacoda: { version: "0.1.0", gitCommit: "abc123", branch: "main" },
      benchmark: { name: "fixture", version: "1", taskId: "task-a", attempt: 1 },
      provider: "openai",
      model: "gpt-test",
      executionSettings: { temperature: 0, maxTokens: null },
      execution: { status: "success", durationSeconds: 1, wallClockMs: 1000 },
      metrics: { ...createEmptyBenchmarkMetrics(), totalTokens: 5 },
      tokenCounts: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      estimatedCostUsd: null
    });

    const text = await readFile(path, "utf8");
    expect(text).not.toMatch(/\u001b\[/u);
    expect(JSON.parse(text)).toMatchObject({
      kind: "benchmark-history-record",
      tokenCounts: {
        totalTokens: 5
      }
    });
  });
});
