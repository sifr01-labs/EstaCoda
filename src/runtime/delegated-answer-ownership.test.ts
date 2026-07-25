import { describe, expect, it } from "vitest";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import {
  pendingDelegatedAnswerOwnership,
  renderDelegatedAnswerAcknowledgement
} from "./delegated-answer-ownership.js";

describe("delegated answer ownership", () => {
  it("accepts only successful non-terminal root delegations with a primary Result Step", () => {
    const ownership = pendingDelegatedAnswerOwnership([
      delegationExecution({ taskId: "task-owned", status: "running", primaryResultStepId: "step-synthesis" }),
      delegationExecution({ taskId: "task-owned", status: "running", primaryResultStepId: "step-synthesis" }),
      delegationExecution({ taskId: "task-terminal", status: "completed", primaryResultStepId: "step-done" }),
      delegationExecution({
        taskId: "task-nested",
        status: "running",
        primaryResultStepId: "step-nested",
        childTask: true
      }),
      delegationExecution({ taskId: "task-inspection", status: "running" }),
      delegationExecution({ taskId: "task-failed-call", status: "running", primaryResultStepId: "step-x" }, false)
    ]);

    expect(ownership).toEqual({
      tasks: [{ taskId: "task-owned", status: "running", execution: "foreground" }]
    });
  });

  it("renders bounded deterministic English and Arabic acknowledgements", () => {
    const ownership = {
      tasks: [{ taskId: "task-123", status: "queued" as const, execution: "background" as const }]
    };

    expect(renderDelegatedAnswerAcknowledgement(ownership)).toBe([
      "Task created: task-123.",
      "Current state: queued (background).",
      "This Task owns the requested answer. The result will be delivered when the Task settles."
    ].join("\n"));
    const arabic = renderDelegatedAnswerAcknowledgement(ownership, "ar");
    expect(arabic).toContain("تم إنشاء");
    expect(arabic).toContain("task-123");
  });
});

function delegationExecution(
  metadata: Record<string, unknown>,
  ok = true
): ToolExecutionRecord {
  return {
    tool: {
      name: "delegate_task",
      description: "Create durable Task",
      inputSchema: {},
      riskClass: "shared-state-mutation",
      toolsets: ["core"],
      progressLabel: "delegating",
      maxResultSizeChars: 8_000
    },
    decision: "allow",
    riskClass: "shared-state-mutation",
    result: {
      ok,
      content: "Task creation result",
      metadata: { execution: "foreground", childTask: false, ...metadata }
    }
  };
}
