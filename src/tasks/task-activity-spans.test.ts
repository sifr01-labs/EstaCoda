import { describe, expect, it } from "vitest";
import {
  deriveTaskActivitySpans,
  type TaskActivitySpanEvent,
} from "./task-activity-spans.js";

describe("deriveTaskActivitySpans", () => {
  it("merges only adjacent category, scope, and Attempt matches while preserving stable identity", () => {
    const spans = deriveTaskActivitySpans([
      event("write-1", "answer", "2026-01-01T00:00:01.000Z", "worker-a", "attempt-a", "private answer fragment one"),
      event("write-2", "answer", "2026-01-01T00:00:02.000Z", "worker-a", "attempt-a", "private answer fragment two"),
      event("read-b", "read", "2026-01-01T00:00:03.000Z", "worker-b", "attempt-b", "Reading sources"),
      event("write-3", "answer", "2026-01-01T00:00:04.000Z", "worker-a", "attempt-a", "private answer fragment three"),
      event("execute-a", "terminal", "2026-01-01T00:00:05.000Z", "worker-a", "attempt-a", "Running command"),
    ], {
      steps: [
        { stepId: "worker-a", kind: "subagent", label: "Subagent 1" },
        { stepId: "worker-b", kind: "subagent", label: "Subagent 2" },
      ],
      attempts: [
        { attemptId: "attempt-a", attemptNumber: 1, status: "completed", completedAt: "2026-01-01T00:00:08.000Z" },
        { attemptId: "attempt-b", attemptNumber: 1, status: "completed", completedAt: "2026-01-01T00:00:06.000Z" },
      ],
      projectionTimestamp: "2026-01-01T00:00:10.000Z",
    });

    expect(spans.map((span) => ({ id: span.id, category: span.category, count: span.eventCount }))).toEqual([
      { id: "write-1", category: "write", count: 2 },
      { id: "read-b", category: "read", count: 1 },
      { id: "write-3", category: "write", count: 1 },
      { id: "execute-a", category: "execute", count: 1 },
    ]);
    expect(spans[0]).toMatchObject({
      scope: { kind: "subagent", stepId: "worker-a", label: "Subagent 1" },
      label: "Writing response",
      startedAt: "2026-01-01T00:00:01.000Z",
      endedAt: "2026-01-01T00:00:04.000Z",
      durationMs: 3_000,
    });
    expect(JSON.stringify(spans)).not.toContain("private answer fragment");
  });

  it("keeps Retry and Failure separate and uses projection time only for the active span", () => {
    const spans = deriveTaskActivitySpans([
      {
        ...event("retry", "plan", "2026-01-01T00:00:01.000Z", "worker-a", "attempt-2", "Attempt queued"),
        kind: "attempt-created",
      },
      event("plan", "plan", "2026-01-01T00:00:02.000Z", "worker-a", "attempt-2", "Planning next action"),
      event("failure", "failed", "2026-01-01T00:00:03.000Z", "worker-b", "attempt-b", "Provider failed"),
    ], {
      steps: [
        { stepId: "worker-a", kind: "subagent", label: "Subagent 1" },
        { stepId: "worker-b", kind: "subagent", label: "Subagent 2" },
      ],
      attempts: [
        { attemptId: "attempt-2", attemptNumber: 2, status: "running" },
        { attemptId: "attempt-b", attemptNumber: 1, status: "failed", completedAt: "2026-01-01T00:00:04.000Z" },
      ],
      projectionTimestamp: "2026-01-01T00:00:10.000Z",
    });

    expect(spans).toEqual([
      expect.objectContaining({
        id: "retry",
        category: "retry",
        status: "completed",
        label: "Retrying attempt",
        endedAt: "2026-01-01T00:00:02.000Z",
        durationMs: 1_000,
      }),
      expect.objectContaining({
        id: "plan",
        category: "plan",
        status: "running",
        durationMs: 8_000,
      }),
      expect.objectContaining({
        id: "failure",
        category: "failure",
        status: "failed",
        endedAt: "2026-01-01T00:00:04.000Z",
        durationMs: 1_000,
      }),
    ]);
    expect(spans[1]).not.toHaveProperty("endedAt");
  });

  it("projects a provider fallback checkpoint as Retry even when the Step suffix is present", () => {
    const spans = deriveTaskActivitySpans([
      event(
        "fallback",
        "plan",
        "2026-01-01T00:00:01.000Z",
        "worker-a",
        "attempt-a",
        "Provider route failed; switching fallback · Research authentication"
      ),
      event("read", "read", "2026-01-01T00:00:02.000Z", "worker-a", "attempt-a", "Reading sources"),
    ], {
      steps: [{ stepId: "worker-a", kind: "subagent", label: "Subagent 1" }],
      attempts: [{ attemptId: "attempt-a", attemptNumber: 1, status: "running" }],
      projectionTimestamp: "2026-01-01T00:00:04.000Z",
    });

    expect(spans[0]).toMatchObject({
      category: "retry",
      label: "Retrying attempt",
      status: "completed",
      endedAt: "2026-01-01T00:00:02.000Z",
    });
    expect(spans[1]).toMatchObject({ category: "read", status: "running", durationMs: 2_000 });
  });

  it("maps synthesis and terminal task settlement to explicit scopes without leaking unsafe labels", () => {
    const spans = deriveTaskActivitySpans([
      event(
        "synthesis-write",
        "edit",
        "2026-01-01T00:00:01.000Z",
        "synthesis",
        "attempt-synthesis",
        "Writing sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ123456 findings"
      ),
      {
        ...event("delivery", "finish", "2026-01-01T00:00:05.000Z", undefined, undefined, "Task status changed"),
        kind: "task-state-changed",
      },
    ], {
      steps: [{ stepId: "synthesis", kind: "synthesis", label: "Synthesis" }],
      attempts: [{
        attemptId: "attempt-synthesis",
        attemptNumber: 1,
        status: "completed",
        completedAt: "2026-01-01T00:00:04.000Z",
      }],
      projectionTimestamp: "2026-01-01T00:00:06.000Z",
      taskCompletedAt: "2026-01-01T00:00:05.000Z",
    });

    expect(spans[0]).toMatchObject({
      category: "write",
      scope: { kind: "synthesis", stepId: "synthesis", label: "Synthesis" },
      label: "Writing [REDACTED] findings",
    });
    expect(spans[1]).toMatchObject({
      category: "deliver",
      scope: { kind: "delivery", label: "Delivery" },
      label: "Finalizing task delivery",
    });
  });
});

function event(
  eventId: string,
  category: TaskActivitySpanEvent["category"],
  timestamp: string,
  stepId: string | undefined,
  attemptId: string | undefined,
  label: string
): TaskActivitySpanEvent {
  return {
    eventId,
    kind: "attempt-progressed",
    label,
    category,
    timestamp,
    ...(stepId === undefined ? {} : { stepId }),
    ...(attemptId === undefined ? {} : { attemptId }),
  };
}
