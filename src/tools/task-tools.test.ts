import { describe, expect, it, vi } from "vitest";
import { createTaskTools } from "./task-tools.js";

describe("task.status", () => {
  it("returns a bounded authorized projection without workspace paths", async () => {
    const status = vi.fn(() => projection());
    const [tool] = createTaskTools({ service: { status } as never, currentSessionId: () => "session-1" });
    const result = await tool!.run({ task_id: "task-1" });

    expect(status).toHaveBeenCalledWith("task-1", "session-1");
    expect(result).toMatchObject({ ok: true, metadata: { taskId: "task-1", status: "running" } });
    expect(result.content).not.toContain("/private/workspace");
    expect(result.content).not.toContain("secret");
  });

  it("fails closed with one indistinguishable not-found response", async () => {
    const [tool] = createTaskTools({
      service: { status: () => { throw new Error("cross-profile private detail"); } } as never,
      currentSessionId: () => "session-1"
    });
    await expect(tool!.run({ task_id: "missing" })).resolves.toEqual({
      ok: false,
      content: "Task status is unavailable for this session.",
      metadata: { error: "task-not-found" }
    });
  });

  it("rejects unknown or malformed input", async () => {
    const [tool] = createTaskTools({ service: { status: vi.fn() } as never, currentSessionId: () => "session-1" });
    await expect(tool!.run({ task_id: "task-1", extra: true })).resolves.toMatchObject({
      ok: false,
      metadata: { error: "invalid-input" }
    });
  });
});

function projection() {
  return {
    taskId: "task-1",
    objective: "Inspect",
    status: "running",
    source: "cli",
    executionPreference: "auto",
    execution: "foreground",
    foregroundOwnerActive: true,
    backgroundContinuation: "available",
    progress: {
      pending: 0,
      ready: 0,
      running: 1,
      waiting_for_input: 0,
      waiting_for_approval: 0,
      completed: 1,
      failed: 0,
      skipped: 0,
      cancelled: 0,
      total: 2
    },
    activeAttempts: 1,
    usage: {
      providerCalls: 1,
      inputTokens: 10,
      outputTokens: 5,
      reasoningTokens: 0,
      totalTokens: 15,
      estimatedCostUsd: 0.01,
      usageComplete: true,
      pricingComplete: true,
      incompleteReasons: []
    },
    results: [{ id: "result-1", handle: "task-result:opaque", kind: "text", status: "available", byteLength: 10 }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:01:00.000Z"
  };
}
