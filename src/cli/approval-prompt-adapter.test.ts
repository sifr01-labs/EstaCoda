import { describe, expect, it, vi } from "vitest";
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

function adapterInput(answer: string, options: { allowPersistentApproval?: boolean } = {}): {
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
        suspendChromeForTranscript: async (fn) => await fn(),
      },
      execution: approvalExecution(),
      allowPersistentApproval: options.allowPersistentApproval ?? true,
    },
  };
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

  it("renders inline Operator Console approval cards when a runtime host is provided", async () => {
    const { input, outputChunks } = adapterInput("approve once");
    const host = createOperatorConsoleRuntimeHost({
      terminal: { width: 72, height: 14, isTty: true },
    });

    await expect(papyrusApprovalPromptAdapter({
      ...input,
      operatorConsoleHost: host,
    })).resolves.toBe("once");

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
    expect(host.getState().approvals).toHaveLength(1);
    expect(host.getState().status).not.toHaveProperty("approvals");
  });

  it("maps Operator Console reject, escape, and inspect intents without adding approval scope semantics", async () => {
    await expect(papyrusApprovalPromptAdapter({
      ...adapterInput("reject").input,
      operatorConsoleHost: createOperatorConsoleRuntimeHost(),
    })).resolves.toBe("deny");
    await expect(papyrusApprovalPromptAdapter({
      ...adapterInput("esc").input,
      operatorConsoleHost: createOperatorConsoleRuntimeHost(),
    })).resolves.toBe("deny");
    await expect(papyrusApprovalPromptAdapter({
      ...adapterInput("inspect").input,
      operatorConsoleHost: createOperatorConsoleRuntimeHost(),
    })).resolves.toBe("inspect");
  });
});
