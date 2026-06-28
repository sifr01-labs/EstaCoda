import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stringWidth } from "../screen/stringWidth.js";
import { createPastedTextAttachment } from "./attachmentSurface.js";
import {
  createOperatorConsoleRuntimeHost,
  type OperatorConsoleRuntimeHost,
} from "./operatorConsoleRuntimeHost.js";
import type {
  ActiveWorkItem,
  ApprovalCardState,
  AttachmentCardState,
  SetupSurfaceState,
  StartupDashboardState,
  StatusRailState,
  SteerState,
} from "./operatorConsoleState.js";

const thisDir = dirname(fileURLToPath(import.meta.url));

describe("OperatorConsoleRuntimeHost", () => {
  it("creates an initial OperatorConsoleState", () => {
    const host = createOperatorConsoleRuntimeHost();
    const state = host.getState();

    expect(state.prompt.value).toBe("");
    expect(state.attachments).toEqual([]);
    expect(state.activeWork.items).toEqual([]);
    expect(state.approvals).toEqual([]);
    expect(state.status).toMatchObject({
      model: { label: "", state: "idle" },
      context: { usedTokens: 0 },
      sessionTimer: { elapsedMs: 0 },
    });
  });

  it("renders an initial prompt and status rail", () => {
    const host = createOperatorConsoleRuntimeHost({
      terminal: { width: 72, height: 12, isTty: true },
    });

    const lines = host.render().lines;

    expect(lines.join("\n")).toContain("›");
    expect(lines.join("\n")).toContain("ctx");
    expect(lines.at(-1)).toContain("◷");
  });

  it("updates prompt state and supports multiline prompts", () => {
    const host = createHost();

    host.setPrompt({ text: "write plan:\n- approvals", cursorOffset: 23 });

    expect(host.getState().prompt).toMatchObject({
      value: "write plan:\n- approvals",
      cursorOffset: 23,
      multiline: true,
    });
    expect(host.render().lines.join("\n")).toContain("› write plan:");
    expect(host.render().lines.join("\n")).toContain("  - approvals");
  });

  it("updates status with only model, context, and session timer fields", () => {
    const host = createHost();
    const noisyStatus = {
      ...status(),
      tools: ["rg"],
      approvals: ["approval-1"],
      workspace: "trusted",
      trust: "trusted",
      setup: "ready",
      steer: "queued",
      channel: "cli",
      activeTurn: "thinking",
    } as unknown as StatusRailState;

    host.setStatus(noisyStatus);

    expect(host.getState().status).toEqual(status());
    expect(Object.keys(host.getState().status).sort()).toEqual(["context", "model", "sessionTimer"]);
    expect(host.render().lines.at(-1)).not.toMatch(/\b(tool|approval|workspace|trust|setup|steer|channel|active)\b/iu);
  });

  it("updates terminal metrics and keeps rendered lines width-bounded", () => {
    const host = createHost();

    host.setTerminal({ width: 36, height: 10, isTty: true });
    host.setPrompt({ text: "review the Papyrus rollout plan with a very long sentence", cursorOffset: 57 });

    expect(host.getState().terminal).toEqual({ width: 36, height: 10, isTty: true });
    for (const line of host.render().lines) {
      expect(stringWidth(line)).toBeLessThanOrEqual(36);
    }
  });

  it("updates attachment, active work, approval, startup, and setup surfaces", () => {
    const host = createHost();

    host.setStartupDashboard(startup());
    host.setSetupPanel(setupPanel());
    host.setAttachments([attachment()]);
    host.setActiveWork(activeWork([workItem("read", "running")]));
    host.setApprovals([approval()]);

    const text = host.render().lines.join("\n");
    expect(text).toContain("EstaCoda");
    expect(text).toContain("Model Route");
    expect(text).toContain("Attachments");
    expect(text).toContain("Active work");
    expect(text).toContain("Approval required");
  });

  it("preserves full pasted attachment content while rendering redacted previews outside the status rail", () => {
    const host = createHost({ width: 80, height: 16 });
    const pasted = createPastedTextAttachment({
      id: "paste-secret",
      content: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456\ncontext",
    });

    host.setAttachments([pasted]);
    host.setPrompt({ text: "summarize", cursorOffset: 9 });

    const lines = host.render().lines;
    const text = lines.join("\n");
    const status = lines.at(-1) ?? "";

    expect(host.getState().attachments[0]?.content).toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(host.getState().attachments[0]?.preview).toContain("Authorization: Bearer [REDACTED]");
    expect(text).toContain("Authorization: Bearer [REDACTED]");
    expect(text).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(status).toContain("◷");
    expect(status).not.toMatch(/\b(Authorization|Bearer|attachment|pasted text)\b/iu);
  });

  it("renders slash menu state below prompt without polluting status rail", () => {
    const host = createHost({ width: 72, height: 12 });

    host.setPrompt({ text: "/mo", cursorOffset: 3 });
    host.setSlash({
      query: "/mo",
      activeItemId: "slash.model",
      items: [
        { id: "slash.model", label: "/model", detail: "show or change active model route" },
        { id: "slash.model.setup", label: "/model setup", detail: "configure provider/model credentials" },
      ],
    });

    const lines = host.render().lines;
    const promptIndex = lines.findIndex((line) => line.includes("› /mo"));
    const slashIndex = lines.findIndex((line) => line.includes("Commands"));
    const status = lines.at(-1) ?? "";

    expect(host.getState().slash?.query).toBe("/mo");
    expect(promptIndex).toBeGreaterThanOrEqual(0);
    expect(slashIndex).toBeGreaterThan(promptIndex);
    expect(lines).toContainEqual(expect.stringContaining("❯ /model        show or change active model route"));
    expect(status).toContain("◷");
    expect(status).not.toMatch(/\b(slash|Commands|model setup)\b/iu);

    host.setSlash(undefined);
    expect(host.render().lines.join("\n")).not.toContain("Commands");
  });

  it("renders queued steer above attachments and prompt while active work stays above queued steer", () => {
    const host = createHost({ height: 28 });
    host.setActiveWork(activeWork([workItem("read", "running")]));
    host.setSteer(steer());
    host.setAttachments([attachment()]);

    const lines = host.render().lines;
    const activeWorkIndex = findLine(lines, "Active work");
    const queuedSteerIndex = findLine(lines, "Queued steer");
    const attachmentsIndex = findLine(lines, "Attachments");
    const steerInputIndex = findLine(lines, "Steer current turn");
    const statusIndex = lines.length - 1;

    expect(activeWorkIndex).toBeGreaterThanOrEqual(0);
    expect(queuedSteerIndex).toBeGreaterThan(activeWorkIndex);
    expect(attachmentsIndex).toBeGreaterThan(queuedSteerIndex);
    expect(steerInputIndex).toBeGreaterThan(attachmentsIndex);
    expect(statusIndex).toBeGreaterThan(steerInputIndex);
  });

  it("does not render applied or cancelled queued steer cards after runtime acknowledgement", () => {
    for (const statusValue of ["applied", "cancelled"] as const) {
      const host = createHost({ height: 16 });
      host.setSteer(steer({
        queued: {
          id: `steer-${statusValue}`,
          text: "focus only on approval cards",
          status: statusValue,
        },
      }));

      const lines = host.render().lines;
      expect(lines.join("\n")).not.toContain("Queued steer");
      expect(lines.at(-1)).toContain("◷");
    }
  });

  it("keeps steer state out of the persistent status rail", () => {
    const host = createHost();
    host.setSteer(steer());
    host.setStatus({
      ...status(),
      steer: "queued",
      activeTurn: "steering",
      approvals: ["approval-1"],
      tools: ["rg"],
    } as unknown as StatusRailState);

    const rail = host.render().lines.at(-1) ?? "";

    expect(rail).toContain("kimi-k2.7-code");
    expect(rail).toContain("ctx");
    expect(rail).toContain("◷");
    expect(rail).not.toMatch(/\b(steer|active|approval|tool|workspace|trust|setup|channel)\b/iu);
  });

  it("renders approvals above active work", () => {
    const host = createHost({ height: 24 });
    host.setApprovals([approval()]);
    host.setActiveWork(activeWork([workItem("typecheck", "running")]));

    const lines = host.render().lines;

    expect(findLine(lines, "Approval required")).toBeLessThan(findLine(lines, "Active work"));
  });

  it("does not reserve rows for absent optional surfaces", () => {
    const host = createHost();
    const text = host.render().lines.join("\n");

    expect(text).not.toContain("Active work");
    expect(text).not.toContain("Approval required");
    expect(text).not.toContain("Attachments");
    expect(text).not.toContain("Queued steer");
  });

  it("renders deterministically without ANSI or cursor-control sequences", () => {
    const host = createHost();
    host.setPrompt({ text: "review the plan", cursorOffset: 15 });
    host.setActiveWork(activeWork([workItem("rg", "succeeded")]));

    const first = host.render().lines;
    const second = host.render().lines;

    expect(second).toEqual(first);
    expect(first.join("\n")).not.toMatch(/\x1b\[[0-?]*[ -/]*[@-~]/u);
    expect(first.join("\n")).not.toMatch(/\x1b[78]/u);
  });

  it("defensively copies caller-owned input objects", () => {
    const host = createHost();
    const attachments = [attachment({ preview: "original" })];
    const workItems = [workItem("read", "running")];
    const approvals = [approval({ action: "original approval" })];

    host.setAttachments(attachments);
    host.setActiveWork(activeWork(workItems));
    host.setApprovals(approvals);

    attachments[0] = attachment({ preview: "mutated" });
    workItems[0] = workItem("mutated", "failed");
    approvals[0] = approval({ action: "mutated approval" });

    expect(host.getState().attachments[0]?.preview).toBe("original");
    expect(host.getState().activeWork.items[0]?.toolName).toBe("read");
    expect(host.getState().approvals[0]?.action).toBe("original approval");
  });

  it("clear resets surfaces without terminal output and dispose ignores later updates", () => {
    const host = createHost();
    host.setAttachments([attachment()]);
    host.setActiveWork(activeWork([workItem("read", "running")]));

    expect(() => host.clear()).not.toThrow();
    expect(host.getState().attachments).toEqual([]);
    expect(host.getState().activeWork.items).toEqual([]);

    host.dispose();
    expect(() => host.setPrompt({ text: "ignored" })).not.toThrow();
    expect(host.getState().prompt.value).toBe("");
  });

  it("does not import live CLI or setup modules", () => {
    const source = readFileSync(join(thisDir, "operatorConsoleRuntimeHost.ts"), "utf8");

    expect(source).not.toMatch(/session-loop|bottom-chrome-controller|active-turn-command-controller/u);
    expect(source).not.toMatch(/approval-prompt-adapter|interactive-select/u);
    expect(source).not.toMatch(/setup\/onboarding-wizard|setup\/config-editor/u);
    expect(source).not.toMatch(/\bstdout\b|\bstderr\b|writeAboveChrome|moveCursor|clearRows|suspendChromeForTranscript/u);
  });
});

function createHost(input: { readonly width?: number; readonly height?: number } = {}): OperatorConsoleRuntimeHost {
  return createOperatorConsoleRuntimeHost({
    terminal: {
      width: input.width ?? 72,
      height: input.height ?? 18,
      isTty: true,
    },
    status: status(),
  });
}

function status(): StatusRailState {
  return {
    model: {
      label: "kimi-k2.7-code",
      state: "idle",
    },
    context: {
      usedTokens: 18_400,
      totalTokens: 262_000,
      percent: 7,
    },
    sessionTimer: {
      elapsedMs: 72_000,
    },
  };
}

function attachment(input: Partial<AttachmentCardState> = {}): AttachmentCardState {
  return {
    id: input.id ?? "paste-1",
    kind: input.kind ?? "pastedText",
    title: input.title ?? "pasted text",
    preview: input.preview ?? "MVP known issue...",
    content: input.content ?? "MVP known issue with enough pasted content to preserve separately.",
    metadata: input.metadata ?? {
      chars: 2481,
    },
  };
}

function activeWork(items: readonly ActiveWorkItem[]) {
  return {
    items,
    scrollOffset: 0,
    expanded: false,
  };
}

function workItem(toolName: string, statusValue: ActiveWorkItem["status"]): ActiveWorkItem {
  return {
    id: `tool-${toolName}`,
    toolName,
    status: statusValue,
    summary: "passed",
    target: "src/ui/papyrus/operator-console",
    durationMs: 18_000,
  };
}

function approval(input: Partial<ApprovalCardState> = {}): ApprovalCardState {
  return {
    id: input.id ?? "approval-1",
    status: input.status ?? "pending",
    action: input.action ?? "run migration",
    target: input.target ?? "production database",
    risk: input.risk ?? "schema change",
    focusedControl: input.focusedControl ?? "approve",
  };
}

function steer(input: Partial<SteerState> = {}): SteerState {
  return {
    draft: input.draft ?? "also keep setup editor tables in scope",
    cursorOffset: input.cursorOffset ?? 39,
    mode: input.mode ?? "queued",
    queued: input.queued ?? {
      id: "steer-1",
      text: "focus only on approval cards and pasted attachments",
      status: "queued",
    },
  };
}

function startup(): StartupDashboardState {
  return {
    productName: "EstaCoda",
    orgName: "Kemet Research",
    tagline: "sovereign agentic infrastructure",
    version: "v0.1.0",
    sessionId: "session-1",
    session: {
      model: "kimi-k2.7-code",
      context: "18.4k / 262k",
      workspace: "verified",
      security: "adaptive",
      autonomy: "reviewable",
    },
    commands: [
      { command: "/tools", description: "inspect tools" },
    ],
    tips: ["Paste large context as attachments."],
  };
}

function setupPanel(): SetupSurfaceState {
  return {
    kind: "table",
    title: "Model route",
    rows: [
      {
        id: "kimi",
        provider: "Kimi",
        model: "kimi-k2.7-code",
        status: "ready",
        notes: "primary",
      },
    ],
    selectedRowId: "kimi",
  };
}

function findLine(lines: readonly string[], text: string): number {
  return lines.findIndex((line) => line.includes(text));
}
