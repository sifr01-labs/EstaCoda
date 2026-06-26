import { describe, expect, it } from "vitest";
import type { ToolExecutionRecord } from "../../../tools/tool-executor.js";
import { approvalCardStateFromToolExecution } from "./approvalRuntimeMapper.js";

describe("approval runtime mapper", () => {
  it("maps ask executions into pending approval card state", () => {
    expect(approvalCardStateFromToolExecution(execution(), { focused: true })).toMatchObject({
      id: "src/app.ts",
      status: "pending",
      action: "workspace.write",
      target: "src/app.ts",
      risk: "workspace-write",
      focusedControl: "approve",
    });
  });

  it("extracts file diff stats when execution metadata already carries a preview", () => {
    expect(approvalCardStateFromToolExecution(execution({
      result: {
        ok: true,
        content: "",
        metadata: {
          fileChangePreview: {
            kind: "fileChangePreview",
            path: "src/app.ts",
            changeType: "modified",
            diff: "+++ b/src/app.ts\n--- a/src/app.ts\n+new\n+line\n-old",
          },
        },
      },
    })).diffStats).toEqual({ added: 2, removed: 1 });
  });

  it("does not turn non-ask executions into actionable pending approval controls", () => {
    expect(approvalCardStateFromToolExecution(execution({ decision: "deny" }))).toMatchObject({
      status: "rejected",
    });
  });
});

function execution(input: Partial<ToolExecutionRecord> = {}): ToolExecutionRecord {
  return {
    tool: {
      name: "workspace.write",
      description: "Write a workspace file",
      inputSchema: {},
      riskClass: "workspace-write",
      toolsets: ["workspace-write"],
      progressLabel: "writing",
      maxResultSizeChars: 1000,
    },
    input: { path: "src/app.ts" },
    decision: "ask",
    riskClass: "workspace-write",
    targetKey: "src/app.ts",
    targetSummary: "src/app.ts",
    ...input,
  };
}
