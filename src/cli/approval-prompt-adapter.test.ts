import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import { createOperatorConsoleRuntimeHost } from "../ui/papyrus/operator-console/index.js";
import {
  papyrusApprovalPromptAdapter,
  type ApprovalPromptAdapterInput,
} from "./approval-prompt-adapter.js";

function approvalExecution(overrides: Partial<ToolExecutionRecord> = {}): ToolExecutionRecord {
  return {
    tool: {
      name: "terminal.run",
      description: "Run a bounded shell command",
      inputSchema: {},
      riskClass: "destructive-local",
      toolsets: ["shell-write"],
      progressLabel: "running",
      maxResultSizeChars: 1000,
    },
    input: { command: "npm install left-pad" },
    decision: "ask",
    riskClass: "destructive-local",
    targetKey: "npm install left-pad",
    targetSummary: "npm install left-pad",
    ...overrides,
  };
}

function adapterInput(answer: string, options: {
  allowPersistentApproval?: boolean;
  execution?: ToolExecutionRecord;
} = {}): {
  input: ApprovalPromptAdapterInput;
  outputChunks: string[];
} {
  const outputChunks: string[] = [];
  return {
    outputChunks,
    input: {
      prompt: vi.fn(async () => answer),
      output: {
        write(chunk: string | Uint8Array): boolean {
          outputChunks.push(String(chunk));
          return true;
        },
      },
      renderer: {
        render: () => "legacy approval card",
      },
      chrome: {
        enabled: false,
        clearInlineSpinner: vi.fn(),
      },
      execution: options.execution ?? approvalExecution(),
      allowPersistentApproval: options.allowPersistentApproval ?? true,
    },
  };
}

function makeTtyInput(): NodeJS.ReadStream & {
  readonly rawModes: boolean[];
  press(chunk: string): void;
} {
  const input = new PassThrough() as unknown as NodeJS.ReadStream & {
    rawModes: boolean[];
    press(chunk: string): void;
  };
  input.isTTY = true;
  input.isRaw = false;
  input.rawModes = [];
  input.setRawMode = (mode: boolean) => {
    input.isRaw = mode;
    input.rawModes.push(mode);
    return input;
  };
  input.press = (chunk: string) => {
    input.emit("data", Buffer.from(chunk, "utf8"));
  };
  return input;
}

describe("approval prompt adapter routing", () => {
  it("maps Papyrus approve/reject/cancel selections to existing answer semantics", async () => {
    await expect(papyrusApprovalPromptAdapter(adapterInput("approve-once").input)).resolves.toBe("once");
    await expect(papyrusApprovalPromptAdapter(adapterInput("1").input)).resolves.toBe("once");
    await expect(papyrusApprovalPromptAdapter(adapterInput("reject").input)).resolves.toBe("deny");
    await expect(papyrusApprovalPromptAdapter(adapterInput("cancel").input)).resolves.toBe("cancel");
  });

  it("maps existing session and persistent approval answers without adding new semantics", async () => {
    await expect(papyrusApprovalPromptAdapter(adapterInput("session").input)).resolves.toBe("session");
    await expect(papyrusApprovalPromptAdapter(adapterInput("2").input)).resolves.toBe("session");
    await expect(papyrusApprovalPromptAdapter(adapterInput("always").input)).resolves.toBe("always");
    await expect(papyrusApprovalPromptAdapter(adapterInput("3").input)).resolves.toBe("always");
    await expect(papyrusApprovalPromptAdapter(adapterInput("3", { allowPersistentApproval: false }).input))
      .resolves.toBe("3");
  });

  it("does not expose unsupported rich approval intents in the live Papyrus prompt", async () => {
    const { input, outputChunks } = adapterInput("once");

    await papyrusApprovalPromptAdapter(input);

    const rendered = outputChunks.join("");
    expect(rendered).toContain("[Approval] Approval required: terminal.run");
    expect(rendered).toContain("Allow once");
    expect(rendered).toContain("Allow for this session");
    expect(rendered).toContain("Deny");
    expect(rendered).toContain("Cancel");
    expect(rendered).not.toContain("Feedback");
    expect(rendered).not.toContain("Amend");
    expect(rendered).not.toContain("Ask user");
    expect(rendered).not.toContain("Don't ask again");
  });

  it("leaves unsupported rich approval answers for existing core validation", async () => {
    await expect(papyrusApprovalPromptAdapter(adapterInput("feedback").input)).resolves.toBe("feedback");
    await expect(papyrusApprovalPromptAdapter(adapterInput("amend").input)).resolves.toBe("amend");
    await expect(papyrusApprovalPromptAdapter(adapterInput("ask-user").input)).resolves.toBe("ask-user");
    await expect(papyrusApprovalPromptAdapter(adapterInput("dont-ask-again").input)).resolves.toBe("dont-ask-again");
  });

  it("keeps persistent approval unavailable when the existing adapter input disallows it", async () => {
    const { input, outputChunks } = adapterInput("once", { allowPersistentApproval: false });

    await papyrusApprovalPromptAdapter(input);

    expect(outputChunks.join("")).not.toContain("Always allow");
  });

  it("renders inline Operator Console approval cards and accepts focused approve without typed prompt", async () => {
    const { input, outputChunks } = adapterInput("approve once");
    const ttyInput = makeTtyInput();
    const host = createOperatorConsoleRuntimeHost({
      terminal: { width: 72, height: 14, isTty: true },
    });

    const result = papyrusApprovalPromptAdapter({
      ...input,
      input: ttyInput,
      operatorConsoleHost: host,
    });
    ttyInput.press("\r");
    await expect(result).resolves.toBe("once");

    const rendered = outputChunks.join("");
    expect(rendered).toContain("Approval required");
    expect(rendered).toContain("Action: terminal.run");
    expect(rendered).toContain("Target: npm install left-pad");
    expect(rendered).toContain("Risk: destructive-local");
    expect(rendered).toContain("❯ Approve once");
    expect(rendered).toContain("Reject");
    expect(rendered).toContain("Inspect");
    expect(rendered).not.toContain("Allow for this session");
    expect(rendered).not.toContain("Always allow");
    expect(rendered).not.toContain("Feedback");
    expect(rendered).not.toContain("Amend");
    expect(rendered).not.toContain("Ask user");
    expect(rendered).not.toContain("Don't ask again");
    expect(input.prompt).not.toHaveBeenCalled();
    expect(host.getState().approvals).toHaveLength(0);
    expect(host.getState().status).not.toHaveProperty("approvals");
    expect(ttyInput.rawModes).toEqual([true, false]);
  });

  it("renders inline Operator Console file diff stats without prompt-region suspension", async () => {
    const { input, outputChunks } = adapterInput("approve once", {
      execution: approvalExecution({
        tool: {
          name: "workspace.write",
          description: "Write a workspace file",
          inputSchema: {},
          riskClass: "workspace-write",
          toolsets: ["workspace-write"],
          progressLabel: "writing",
          maxResultSizeChars: 1000,
        },
        input: { path: "src/runtime/provider-turn-loop.ts" },
        riskClass: "workspace-write",
        targetKey: "src/runtime/provider-turn-loop.ts",
        targetSummary: "src/runtime/provider-turn-loop.ts",
        result: {
          ok: true,
          content: "",
          metadata: {
            fileChangePreview: {
              kind: "fileChangePreview",
              path: "src/runtime/provider-turn-loop.ts",
              changeType: "modified",
              diff: "+++ b/src/runtime/provider-turn-loop.ts\n--- a/src/runtime/provider-turn-loop.ts\n+one\n+two\n-old",
            },
          },
        },
      }),
    });
    const host = createOperatorConsoleRuntimeHost({
      terminal: { width: 88, height: 14, isTty: true },
    });
    const ttyInput = makeTtyInput();

    const result = papyrusApprovalPromptAdapter({
      ...input,
      input: ttyInput,
      operatorConsoleHost: host,
    });
    ttyInput.press("\r");
    await expect(result).resolves.toBe("once");

    const rendered = outputChunks.join("");
    expect(rendered).toContain("Action: workspace.write");
    expect(rendered).toContain("Target: src/runtime/provider-turn-loop.ts");
    expect(rendered).toContain("Risk: workspace-write");
    expect(rendered).toContain("+2 lines  -1 lines");
    expect(input.chrome?.clearInlineSpinner).not.toHaveBeenCalled();
    expect(input.prompt).not.toHaveBeenCalled();
  });

  it("maps Operator Console reject, escape, and inspect intents without adding approval scope semantics", async () => {
    const rejectInput = makeTtyInput();
    const reject = papyrusApprovalPromptAdapter({
      ...adapterInput("").input,
      input: rejectInput,
      operatorConsoleHost: createOperatorConsoleRuntimeHost(),
    });
    rejectInput.press("\t");
    rejectInput.press("\r");
    await expect(reject).resolves.toBe("deny");

    const escapeInput = makeTtyInput();
    const escape = papyrusApprovalPromptAdapter({
      ...adapterInput("").input,
      input: escapeInput,
      operatorConsoleHost: createOperatorConsoleRuntimeHost(),
    });
    escapeInput.press("\x1b");
    await expect(escape).resolves.toBe("deny");

    const inspectInput = makeTtyInput();
    const inspect = papyrusApprovalPromptAdapter({
      ...adapterInput("").input,
      input: inspectInput,
      operatorConsoleHost: createOperatorConsoleRuntimeHost(),
    });
    inspectInput.press("\x1b[C");
    inspectInput.press("\x1b[C");
    inspectInput.press("\r");
    await expect(inspect).resolves.toBe("inspect");
  });

  it("cycles Operator Console approval focus with tab and arrow keys", async () => {
    const { input, outputChunks } = adapterInput("");
    const ttyInput = makeTtyInput();
    const result = papyrusApprovalPromptAdapter({
      ...input,
      input: ttyInput,
      operatorConsoleHost: createOperatorConsoleRuntimeHost({
        terminal: { width: 72, height: 14, isTty: true },
      }),
    });

    ttyInput.press("\t");
    ttyInput.press("\x1b[C");
    ttyInput.press("\x1b[D");
    ttyInput.press("\r");
    await expect(result).resolves.toBe("deny");

    const rendered = outputChunks.join("");
    expect(rendered).toContain("❯ Approve once");
    expect(rendered).toContain("❯ Reject");
    expect(rendered).toContain("❯ Inspect");
    expect(input.prompt).not.toHaveBeenCalled();
  });

  it("falls back to typed approval prompt when Operator Console has no TTY input", async () => {
    const { input, outputChunks } = adapterInput("approve once");

    await expect(papyrusApprovalPromptAdapter({
      ...input,
      operatorConsoleHost: createOperatorConsoleRuntimeHost(),
    })).resolves.toBe("once");

    expect(input.prompt).toHaveBeenCalledWith("approval action > ");
    expect(outputChunks.join("")).toContain("Approval required");
  });
});
