import { describe, expect, it } from "vitest";
import type { TaskCompletionTraceSnapshot } from "../contracts/task-completion-trace.js";
import { parseTaskCompletionTraceSnapshot } from "./task-completion-trace.js";

describe("persisted Task completion trace", () => {
  it("round-trips one bounded versioned snapshot", () => {
    const snapshot = completionTrace();
    expect(parseTaskCompletionTraceSnapshot(snapshot, "task-1")).toEqual(snapshot);
  });

  it("ignores mismatched or malformed metadata instead of blocking answer delivery", () => {
    const snapshot = completionTrace();
    expect(parseTaskCompletionTraceSnapshot(snapshot, "task-other")).toBeUndefined();
    expect(parseTaskCompletionTraceSnapshot({
      ...snapshot,
      spans: [{ ...snapshot.spans[0], label: "unsafe\nlabel" }],
    }, "task-1")).toBeUndefined();
    expect(parseTaskCompletionTraceSnapshot({
      ...snapshot,
      spans: Array.from({ length: 97 }, () => snapshot.spans[0]),
      activityCount: 97,
    }, "task-1")).toBeUndefined();
  });
});

function completionTrace(): TaskCompletionTraceSnapshot {
  return {
    version: 1,
    taskId: "task-1",
    stage: "delivery",
    outcome: "complete",
    answerAvailable: true,
    activityCount: 1,
    activityCountComplete: true,
    totalDurationMs: 12_000,
    hasEarlierActivities: false,
    spans: [{
      category: "deliver",
      scope: { kind: "delivery", label: "Delivery" },
      status: "completed",
      durationMs: 1_000,
      label: "Finalizing task delivery",
    }],
  };
}
