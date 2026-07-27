import { describe, expect, it } from "vitest";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import { classifyFailure } from "./failure-classifier.js";

describe("classifyFailure", () => {
  it("classifies structured delegation admission failures as recoverable invalid arguments", () => {
    const execution: ToolExecutionRecord = {
      tool: {
        name: "delegate_task",
        description: "Create durable delegated Tasks.",
        inputSchema: {},
        riskClass: "shared-state-mutation",
        toolsets: ["core"],
        progressLabel: "delegating task",
        maxResultSizeChars: 1_000
      },
      decision: "allow",
      riskClass: "shared-state-mutation",
      result: {
        ok: false,
        content: "delegate_task tasks[0]: Delegated work requested unavailable tools: invented_tool.",
        metadata: {
          reason: "delegation-access-error",
          code: "requested-tool-unavailable",
          taskIndex: 0
        }
      }
    };

    expect(classifyFailure({ kind: "tool-execution", execution })).toEqual({
      class: "tool-invalid-args",
      recoverable: true,
      message: "Tool delegate_task rejected delegated access arguments: delegate_task tasks[0]: Delegated work requested unavailable tools: invented_tool.",
      context: {
        tool: "delegate_task",
        error: "delegate_task tasks[0]: Delegated work requested unavailable tools: invented_tool.",
        reason: "delegation-access-error",
        code: "requested-tool-unavailable",
        taskIndex: 0
      }
    });
  });

  it("retains tool-not-found classification for genuinely unavailable tools", () => {
    const execution: ToolExecutionRecord = {
      tool: {
        name: "missing.tool",
        description: "Missing tool.",
        inputSchema: {},
        riskClass: "read-only-local",
        toolsets: ["core"],
        progressLabel: "missing tool",
        maxResultSizeChars: 1_000
      },
      decision: "allow",
      riskClass: "read-only-local",
      result: { ok: false, content: "Tool is unavailable." }
    };

    expect(classifyFailure({ kind: "tool-execution", execution })).toMatchObject({
      class: "tool-not-found",
      recoverable: false
    });
  });
});
