import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendBenchmarkHistoryRecord,
  createBenchmarkHistoryRecord,
  parseBenchmarkHistoryRecords,
  readBenchmarkHistoryRecords,
  scenarioKey
} from "./history.js";
import { createBenchmarkRunSummary, createEmptyBenchmarkMetrics } from "./schema.js";

let tempDir: string | undefined;

afterEach(async () => {
  if (tempDir !== undefined) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("benchmark history", () => {
  it("persists benchmark records as JSONL", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "estacoda-benchmark-history-test-"));
    const path = join(tempDir, "history.jsonl");
    const firstRecord = createBenchmarkHistoryRecord(summaryFixture(), {
      timestamp: "2026-07-06T00:00:03.000Z",
      branch: "ame/benchmark-regression-tracking"
    });
    const secondRecord = createBenchmarkHistoryRecord(summaryFixture("task-b"), {
      timestamp: "2026-07-06T00:00:04.000Z",
      branch: "ame/benchmark-regression-tracking"
    });

    await appendBenchmarkHistoryRecord(path, firstRecord);
    await appendBenchmarkHistoryRecord(path, secondRecord);

    expect(await readBenchmarkHistoryRecords(path)).toEqual([firstRecord, secondRecord]);
    expect(await readFile(path, "utf8")).toContain("\"benchmark-history-record\"");
  });

  it("normalizes older summary artifacts and fills missing regression metrics", () => {
    const summary = summaryFixture();
    const oldSummary = {
      ...summary,
      artifacts: {
        summary: "/tmp/summary.json",
        eventLog: "/tmp/events.jsonl"
      },
      metrics: {
        providerCalls: 1,
        inputTokens: 5,
        outputTokens: 7,
        totalTokens: 12,
        estimatedCostUsd: null
      }
    };

    const [record] = parseBenchmarkHistoryRecords(JSON.stringify(oldSummary));

    expect(record).toMatchObject({
      kind: "benchmark-history-record",
      metrics: {
        toolFailures: 0,
        providerBudgetExhaustions: 0,
        memoryPromotions: 0,
        estimatedCostUsd: null
      },
      tokenCounts: {
        totalTokens: 12
      }
    });
  });

  it("uses stable scenario keys for named benchmarks", () => {
    const record = createBenchmarkHistoryRecord(summaryFixture());

    expect(scenarioKey(record)).toBe("fixture-suite/1/task-a");
  });
});

function summaryFixture(taskId = "task-a") {
  return createBenchmarkRunSummary({
    benchmark: { name: "fixture-suite", version: "1", taskId, attempt: 1 },
    estacoda: { version: "0.1.0", gitCommit: "abc123" },
    execution: {
      status: "success",
      startedAt: "2026-07-06T00:00:00.000Z",
      endedAt: "2026-07-06T00:00:03.000Z",
      wallClockMs: 3000,
      workspace: "/tmp/workspace",
      home: "/tmp/home",
      homeMode: "generated",
      policy: "container-benchmark",
      sessionId: "session-1",
      trajectoryId: "trajectory-1"
    },
    model: {
      provider: "openai",
      id: "gpt-test",
      settings: { temperature: 0, maxTokens: null }
    },
    metrics: {
      ...createEmptyBenchmarkMetrics(),
      providerCalls: 1,
      inputTokens: 5,
      outputTokens: 7,
      totalTokens: 12
    },
    finalAnswer: "done",
    artifacts: {
      summary: "/tmp/summary.json",
      eventLog: "/tmp/events.jsonl",
      trajectory: "/tmp/trajectory.jsonl",
      trajectorySummary: "/tmp/trajectory-summary.json",
      history: "/tmp/history.jsonl",
      stdout: "/tmp/stdout.txt",
      stderr: null
    }
  });
}
