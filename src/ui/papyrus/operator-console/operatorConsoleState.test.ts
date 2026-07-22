import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  APPROVAL_FOCUS_CONTROLS,
  createApprovalFocusTarget,
  createDefaultStatusRailState,
  createInitialFocusState,
  createInitialOperatorConsoleState,
  getOperatorConsoleSurfaceOrder,
  isApprovalFocusControl,
  isPromptFocused,
  restorePreviousFocus,
  setFocus,
  type OperatorConsoleEvent,
} from "./index.js";

const thisDir = dirname(fileURLToPath(import.meta.url));

describe("Papyrus operator console state model", () => {
  it("creates initial state with prompt focus", () => {
    const state = createInitialOperatorConsoleState();

    expect(state.mode).toBe("session");
    expect(state.focus).toEqual({ target: { kind: "prompt" } });
    expect(isPromptFocused(state.focus)).toBe(true);
  });

  it("supports setup mode without changing the default session mode", () => {
    const setupState = createInitialOperatorConsoleState({ mode: "setup" });
    const sessionState = createInitialOperatorConsoleState();

    expect(setupState.mode).toBe("setup");
    expect(sessionState.mode).toBe("session");
  });

  it("keeps the canonical surface order stable", () => {
    expect(getOperatorConsoleSurfaceOrder()).toEqual([
      "startupDashboard",
      "setupPanel",
      "transcript",
      "streaming",
      "approvals",
      "turnActivity",
      "activeWork",
      "queuedSteer",
      "taskCards",
      "taskInspection",
      "attachments",
      "prompt",
      "slashMenu",
      "statusRail",
    ]);
  });

  it("keeps status rail state limited to model, context, and session timer", () => {
    const status = createDefaultStatusRailState();

    expect(Object.keys(status)).toEqual(["model", "context", "sessionTimer"]);
    expect(status).toEqual({
      model: {
        label: "",
        state: "idle",
      },
      context: {},
      sessionTimer: {
        elapsedMs: 0,
      },
    });
    expect(status).not.toHaveProperty("tools");
    expect(status).not.toHaveProperty("approvals");
    expect(status).not.toHaveProperty("attachments");
    expect(status).not.toHaveProperty("steering");
    expect(status).not.toHaveProperty("workspace");
    expect(status).not.toHaveProperty("trust");
    expect(status).not.toHaveProperty("setup");
    expect(status).not.toHaveProperty("channels");
  });

  it("moves focus from prompt to attachment while preserving previous focus", () => {
    const focus = createInitialFocusState();
    const next = setFocus(focus, { kind: "attachment", attachmentId: "paste-1" });

    expect(next).toEqual({
      target: { kind: "attachment", attachmentId: "paste-1" },
      previous: { kind: "prompt" },
    });
    expect(isPromptFocused(next)).toBe(false);
  });

  it("supports steer focus and queued steer state without runtime coupling", () => {
    const focus = setFocus(createInitialFocusState(), { kind: "steer" });
    const state = createInitialOperatorConsoleState({
      steer: {
        draft: "focus on approvals",
        cursorOffset: 18,
        mode: "queued",
        queued: {
          id: "steer-1",
          text: "focus on approvals",
          status: "queued",
        },
      },
      focus,
    });

    expect(state.focus.target).toEqual({ kind: "steer" });
    expect(state.steer?.queued).toEqual({
      id: "steer-1",
      text: "focus on approvals",
      status: "queued",
    });
  });

  it("restores previous focus", () => {
    const attachment = setFocus(createInitialFocusState(), { kind: "attachment", attachmentId: "paste-1" });
    const restored = restorePreviousFocus(attachment);

    expect(restored).toEqual({
      target: { kind: "prompt" },
      previous: { kind: "attachment", attachmentId: "paste-1" },
    });
  });

  it("limits approval focus controls to approve, reject, and inspect", () => {
    expect(APPROVAL_FOCUS_CONTROLS).toEqual(["approve", "reject", "inspect"]);
    expect(isApprovalFocusControl("approve")).toBe(true);
    expect(isApprovalFocusControl("reject")).toBe(true);
    expect(isApprovalFocusControl("inspect")).toBe(true);
    expect(isApprovalFocusControl("always")).toBe(false);
    expect(isApprovalFocusControl("feedback")).toBe(false);
    expect(createApprovalFocusTarget("approval-1", "inspect")).toEqual({
      kind: "approval",
      approvalId: "approval-1",
      control: "inspect",
    });
    expect(() => createApprovalFocusTarget("approval-1", "always" as never)).toThrow(
      "Unsupported approval focus control: always"
    );
  });

  it("constructs operator console events without terminal dependencies", () => {
    const status = createDefaultStatusRailState();
    const events: readonly OperatorConsoleEvent[] = [
      { type: "key", key: { type: "key", key: "enter" } },
      { type: "paste", text: "line one\nline two" },
      { type: "resize", width: 100, height: 30 },
      {
        type: "toolEvent",
        event: {
          id: "tool-1",
          toolName: "read_file",
          status: "running",
          summary: "src/cli/session-loop.ts",
          target: "src/cli/session-loop.ts",
          detailsRef: "tool://tool-1",
          approvalRef: "approval://tool-1",
          riskLevel: "low",
        },
      },
      {
        type: "approvalRequested",
        request: {
          id: "approval-1",
          title: "Approval required",
          action: "write file",
        },
      },
      { type: "turnStarted" },
      { type: "turnCompleted" },
      { type: "statusChanged", status },
    ];

    expect(events.map((event) => event.type)).toEqual([
      "key",
      "paste",
      "resize",
      "toolEvent",
      "approvalRequested",
      "turnStarted",
      "turnCompleted",
      "statusChanged",
    ]);
  });

  it("starts with inert optional surface state", () => {
    const state = createInitialOperatorConsoleState();

    expect(state.mode).toBe("session");
    expect(state.attachments).toEqual([]);
    expect(state.tasks).toEqual({ cards: [], inspection: { followLive: true }, scrollOffset: 0 });
    expect(state.activeWork).toEqual({
      items: [],
      scrollOffset: 0,
      expanded: false,
    });
    expect(state.streaming).toBeUndefined();
    expect(state.approvals).toEqual([]);
    expect(state.slash).toBeUndefined();
    expect(state.steer).toBeUndefined();
    expect(state.startup).toBeUndefined();
    expect(state.setupPanel).toBeUndefined();
  });

  it("constructs startup dashboard and setup panel state without runtime coupling", () => {
    const state = createInitialOperatorConsoleState({
      startup: {
        productName: "EstaCoda",
        orgName: "⟡ SIFR01 ⟡",
        tagline: "sovereign agentic infrastructure",
        version: "v0.1.0",
        sessionId: "20ea8195",
        session: {
          model: "kimi-k2.6 ◐",
          context: "0 / 262k",
          workspace: "verified",
          security: "open",
          autonomy: "autonomous",
        },
        commands: [{ command: "/tools", description: "inspect tools" }],
        tips: ["Paste large context as attachments."],
      },
      setupPanel: {
        kind: "table",
        title: "Model route",
        rows: [{
          id: "openai",
          provider: "OpenAI",
          model: "gpt-5.5",
          status: "ready",
          notes: "API key set",
        }],
        selectedRowId: "openai",
      },
    });

    expect(state.startup?.productName).toBe("EstaCoda");
    expect(state.startup?.commands).toEqual([{ command: "/tools", description: "inspect tools" }]);
    expect(state.setupPanel).toMatchObject({
      kind: "table",
      title: "Model route",
      selectedRowId: "openai",
    });
  });

  it("constructs streaming state without runtime coupling", () => {
    const state = createInitialOperatorConsoleState({
      streaming: {
        segments: [{
          id: "segment-1",
          role: "assistant",
          text: "I will inspect the runtime path first.",
          createdAtMs: 1_000,
        }],
        tail: "Then I will summarize",
        isStreaming: true,
        toolTrail: [{
          id: "read-1",
          sequence: 1,
          toolName: "read_file",
          status: "running",
          summary: "src/cli/session-loop.ts",
          target: "src/cli/session-loop.ts",
          startedAtMs: 1_100,
          afterSegmentId: "segment-1",
        }],
      },
    });

    expect(state.streaming).toEqual({
      segments: [{
        id: "segment-1",
        role: "assistant",
        text: "I will inspect the runtime path first.",
        createdAtMs: 1_000,
      }],
      tail: "Then I will summarize",
      isStreaming: true,
      toolTrail: [{
        id: "read-1",
        sequence: 1,
        toolName: "read_file",
        status: "running",
        summary: "src/cli/session-loop.ts",
        target: "src/cli/session-loop.ts",
        startedAtMs: 1_100,
        afterSegmentId: "segment-1",
      }],
    });
  });

  it("constructs assistant transcript blocks with inline tool-trail metadata", () => {
    const state = createInitialOperatorConsoleState({
      transcript: [{
        id: "assistant-1",
        role: "assistant",
        text: "I inspected the runtime path.",
        toolTrail: [{
          id: "read-1",
          sequence: 1,
          toolName: "read_file",
          status: "succeeded",
          summary: "src/cli/session-loop.ts",
          target: "src/cli/session-loop.ts",
          durationMs: 1_000,
          afterSegmentId: "segment-1",
        }],
      }],
    });

    expect(state.transcript[0]?.toolTrail).toEqual([{
      id: "read-1",
      sequence: 1,
      toolName: "read_file",
      status: "succeeded",
      summary: "src/cli/session-loop.ts",
      target: "src/cli/session-loop.ts",
      durationMs: 1_000,
      afterSegmentId: "segment-1",
    }]);
  });

  it("does not introduce rendering exports or ANSI strings in the model layer", () => {
    const sourceFiles = readdirSync(thisDir)
      .filter((file) => [
        "focusModel.ts",
        "operatorConsoleEvents.ts",
        "operatorConsoleState.ts",
      ].includes(file));
    const source = sourceFiles
      .map((file) => readFileSync(join(thisDir, file), "utf8"))
      .join("\n");

    expect(source).not.toContain("\\x1b");
    expect(source).not.toContain("\\u001b");
    expect(source).not.toContain("\\033");
    expect(source).not.toContain("\u001b");
  });
});
