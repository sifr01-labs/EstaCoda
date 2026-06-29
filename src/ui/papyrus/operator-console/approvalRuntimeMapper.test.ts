import { describe, expect, it } from "vitest";
import type { ToolExecutionRecord } from "../../../tools/tool-executor.js";
import { approvalCardStateFromToolExecution } from "./approvalRuntimeMapper.js";

describe("approval runtime mapper", () => {
  it("maps ask executions into pending approval card state", () => {
    expect(approvalCardStateFromToolExecution(execution(), { focused: true })).toMatchObject({
      id: "src/app.ts",
      status: "pending",
      action: "Workspace Write",
      target: "src/app.ts",
      risk: "workspace-write",
      focusedControl: "approve",
    });
  });

  it("localizes approval card actions without changing stable approval identity", () => {
    expect(approvalCardStateFromToolExecution(execution({
      tool: {
        ...execution().tool,
        name: "terminal.run",
        progressLabel: "running",
      },
      input: {
        command: "cd app && export CI=true && pnpm test && echo done",
      },
      targetKey: "terminal.run:cd app && export CI=true && pnpm test && echo done",
      targetSummary: "cd app && export CI=true && pnpm test && echo done",
    }), { locale: "ar" })).toMatchObject({
      id: "terminal.run:cd app && export CI=true && pnpm test && echo done",
      action: "تشغيل أمر",
      target: "pnpm test",
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
    const card = approvalCardStateFromToolExecution(execution({ decision: "deny" }), { focused: true });

    expect(card).toMatchObject({
      status: "rejected",
    });
    expect(card).not.toHaveProperty("focusedControl");
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
