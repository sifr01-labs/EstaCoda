import { describe, expect, it } from "vitest";
import {
  createDefaultToolActivityState,
  createInitialOperatorConsoleState,
  createOperatorConsoleLayout,
  type OperatorConsoleLayout,
  type OperatorConsoleRegion,
  type OperatorConsoleState,
} from "./index.js";

describe("Papyrus operator console layout", () => {
  it("includes prompt and status rail regions for minimal state", () => {
    const layout = createOperatorConsoleLayout(createState(), { width: 80, height: 10, isTty: true });

    expect(regionKinds(layout)).toEqual(["prompt", "statusRail"]);
    expect(region(layout, "prompt")?.visible).toBe(true);
    expect(region(layout, "prompt")?.height).toBe(1);
    expect(region(layout, "statusRail")?.visible).toBe(true);
  });

  it("orders present regions by the canonical vertical surface order", () => {
    const layout = createOperatorConsoleLayout(createFullState(), { width: 80, height: 24, isTty: true });

    expect(regionKinds(layout)).toEqual([
      "startupDashboard",
      "setupPanel",
      "transcript",
      "streaming",
      "approvals",
      "turnActivity",
      "queuedSteer",
      "attachments",
      "prompt",
      "slashMenu",
      "statusRail",
    ]);
    expect(layout.regions.map((item) => item.y)).toEqual([...layout.regions.map((item) => item.y)].sort((a, b) => a - b));
  });

  it("includes startup dashboard only when startup state exists", () => {
    expect(regionKinds(createOperatorConsoleLayout(createState()))).not.toContain("startupDashboard");

    const layout = createOperatorConsoleLayout(createState({
      startup: startupDashboard(),
    }));
    expect(regionKinds(layout)).toContain("startupDashboard");
  });

  it("includes setup panel only when setup state exists", () => {
    expect(regionKinds(createOperatorConsoleLayout(createState()))).not.toContain("setupPanel");

    const layout = createOperatorConsoleLayout(createState({
      setupPanel: setupPanel(),
    }));
    expect(regionKinds(layout)).toContain("setupPanel");
  });

  it("allocates only setup-owned surfaces in setup mode", () => {
    const layout = createOperatorConsoleLayout(createFullState({
      mode: "setup",
    }), { width: 80, height: 24, isTty: true });

    expect(regionKinds(layout)).toEqual(["setupPanel"]);
    expect(visibleRegionKinds(layout)).toEqual(["setupPanel"]);
    expect(region(layout, "setupPanel")).toMatchObject({ visible: true });
  });

  it("allocates no session fallback surfaces in empty setup mode", () => {
    const layout = createOperatorConsoleLayout(createState({
      mode: "setup",
    }), { width: 80, height: 24, isTty: true });

    expect(regionKinds(layout)).toEqual([]);
  });

  it("keeps live active work out of the default layout", () => {
    expect(regionKinds(createOperatorConsoleLayout(createState()))).not.toContain("activeWork");

    const layout = createOperatorConsoleLayout(createState({
      activeWork: {
        items: [toolItem("tool-1", "running")],
        scrollOffset: 0,
        expanded: true,
      },
    }));
    expect(regionKinds(layout)).not.toContain("activeWork");
  });

  it("makes a live-region exception only for running delegation work", () => {
    const activeWork = {
      items: [
        {
          id: "delegate",
          toolName: "delegate_task",
          status: "running" as const,
          summary: "preparing",
          target: "starting subagents",
        },
        {
          id: "child-1",
          toolName: "delegate_task",
          source: "subagent" as const,
          groupId: "batch-1",
          status: "running" as const,
          summary: "Read File",
          target: "Read File",
        },
      ],
      scrollOffset: 0,
      expanded: true,
    };

    expect(regionKinds(createOperatorConsoleLayout(createState({ activeWork })))).toContain("activeWork");
    expect(regionKinds(createOperatorConsoleLayout(createState({
      activeWork,
      streaming: streamingState(),
    })))).not.toContain("activeWork");
    expect(regionKinds(createOperatorConsoleLayout(createState({
      activeWork,
      streaming: streamingState({ tail: "" }),
    })))).toEqual(expect.arrayContaining(["streaming", "activeWork"]));
    expect(regionKinds(createOperatorConsoleLayout(createState({
      activeWork: {
        ...activeWork,
        items: activeWork.items.map((item) => ({ ...item, status: "succeeded" as const })),
      },
    })))).not.toContain("activeWork");
  });

  it("places durable Subagent cards below streaming and suppresses the bordered delegation fallback", () => {
    const activeWork = {
      items: [
        {
          id: "delegate",
          toolName: "delegate_task",
          status: "running" as const,
          summary: "preparing",
          target: "starting subagents",
        },
        {
          id: "subagent:child-1",
          toolName: "delegate_task",
          source: "subagent" as const,
          taskId: "task-current",
          status: "running" as const,
          summary: "reading",
        },
      ],
      scrollOffset: 0,
      expanded: true,
    };
    const taskCard = { taskId: "task-current", subagents: [{}] } as unknown as OperatorConsoleState["tasks"]["cards"][number];
    const layout = createOperatorConsoleLayout(createState({
      activeWork,
      streaming: streamingState({ tail: "" }),
      tasks: { cards: [taskCard], scrollOffset: 0 },
    }), { width: 100, height: 40, isTty: true });

    expect(regionKinds(layout)).not.toContain("activeWork");
    expect(regionKinds(layout)).toEqual(expect.arrayContaining(["streaming", "taskCards"]));
    expect(region(layout, "streaming")!.y).toBeLessThan(region(layout, "taskCards")!.y);

    const unrelatedTaskCard = { taskId: "task-earlier", subagents: [{}] } as unknown as OperatorConsoleState["tasks"]["cards"][number];
    const unrelated = createOperatorConsoleLayout(createState({
      activeWork,
      tasks: { cards: [unrelatedTaskCard], scrollOffset: 0 },
    }), { width: 100, height: 40, isTty: true });
    expect(regionKinds(unrelated)).toContain("activeWork");
  });

  it("includes turn activity only when turn activity state exists", () => {
    expect(regionKinds(createOperatorConsoleLayout(createState()))).not.toContain("turnActivity");

    const layout = createOperatorConsoleLayout(createState({
      turnActivity: { phase: "thinking" },
    }));
    expect(regionKinds(layout)).toContain("turnActivity");
  });

  it("includes streaming only when streaming state is active", () => {
    expect(regionKinds(createOperatorConsoleLayout(createState()))).not.toContain("streaming");

    const layout = createOperatorConsoleLayout(createState({
      streaming: streamingState(),
    }));
    expect(regionKinds(layout)).toContain("streaming");

    const idle = createOperatorConsoleLayout(createState({
      streaming: streamingState({ isStreaming: false }),
    }));
    expect(regionKinds(idle)).not.toContain("streaming");
  });

  it("includes approvals only when approval state is non-empty", () => {
    expect(regionKinds(createOperatorConsoleLayout(createState()))).not.toContain("approvals");

    const layout = createOperatorConsoleLayout(createState({
      approvals: [approval("approval-1")],
    }));
    expect(regionKinds(layout)).toContain("approvals");
  });

  it("includes queued steer only when queued steer state is active", () => {
    expect(regionKinds(createOperatorConsoleLayout(createState()))).not.toContain("queuedSteer");

    const layout = createOperatorConsoleLayout(createState({
      steer: {
        draft: "",
        cursorOffset: 0,
        mode: "queued",
        queued: {
          id: "steer-1",
          text: "focus on approvals",
          status: "queued",
        },
      },
    }));
    expect(regionKinds(layout)).toContain("queuedSteer");

    const applied = createOperatorConsoleLayout(createState({
      steer: {
        draft: "",
        cursorOffset: 0,
        mode: "queued",
        queued: {
          id: "steer-1",
          text: "focus on approvals",
          status: "applied",
        },
      },
    }));
    expect(regionKinds(applied)).not.toContain("queuedSteer");

    const cancelled = createOperatorConsoleLayout(createState({
      steer: {
        draft: "",
        cursorOffset: 0,
        mode: "queued",
        queued: {
          id: "steer-1",
          text: "focus on approvals",
          status: "cancelled",
        },
      },
    }));
    expect(regionKinds(cancelled)).not.toContain("queuedSteer");
  });

  it("includes attachments only when attachments exist", () => {
    expect(regionKinds(createOperatorConsoleLayout(createState()))).not.toContain("attachments");

    const layout = createOperatorConsoleLayout(createState({
      attachments: [pastedAttachment("paste-1")],
    }));
    expect(regionKinds(layout)).toContain("attachments");
  });

  it("includes slash menu only when slash state exists", () => {
    expect(regionKinds(createOperatorConsoleLayout(createState()))).not.toContain("slashMenu");

    const layout = createOperatorConsoleLayout(createState({
      slash: {
        query: "/mo",
        items: [{ id: "model", label: "/model" }],
      },
    }));
    expect(regionKinds(layout)).toContain("slashMenu");
  });

  it("allocates up to fourteen slash menu rows when enough commands match", () => {
    const layout = createOperatorConsoleLayout(createState({
      slash: {
        query: "/",
        items: Array.from({ length: 16 }, (_, index) => ({
          id: `cmd-${index + 1}`,
          label: `/cmd${index + 1}`,
        })),
      },
    }), { width: 80, height: 24, isTty: true });

    expect(region(layout, "slashMenu")).toMatchObject({ height: 14, visible: true });
  });

  it("keeps prompt and status rail allocated under constrained height", () => {
    const layout = createOperatorConsoleLayout(createFullState(), { width: 60, height: 2, isTty: true });

    expect(region(layout, "prompt")).toMatchObject({ height: 1, visible: true });
    expect(region(layout, "statusRail")).toMatchObject({ height: 1, visible: true });
  });

  it("allocates prompt height from prompt surface content within terminal constraints", () => {
    const layout = createOperatorConsoleLayout(createState({
      prompt: {
        value: [
          "write a migration plan for:",
          "- approval cards",
          "- pasted attachments",
          "- tool activity",
        ].join("\n"),
        cursorOffset: 0,
        multiline: true,
        scrollOffset: 0,
        mode: "prompt",
      },
    }), { width: 80, height: 20, isTty: true });

    expect(region(layout, "prompt")?.height).toBe(4);
  });

  it("caps multiline prompt allocation at 8 content rows", () => {
    const value = numberedLines(14);
    const layout = createOperatorConsoleLayout(createState({
      prompt: {
        value,
        cursorOffset: value.length,
        multiline: true,
        scrollOffset: 0,
        mode: "prompt",
      },
    }), { width: 80, height: 80, isTty: true });

    expect(region(layout, "prompt")?.height).toBe(8);
  });

  it("caps multiline prompt allocation at 30 percent of terminal height when constrained", () => {
    const value = numberedLines(14);
    const layout = createOperatorConsoleLayout(createState({
      prompt: {
        value,
        cursorOffset: value.length,
        multiline: true,
        scrollOffset: 0,
        mode: "prompt",
      },
    }), { width: 80, height: 20, isTty: true });

    expect(region(layout, "prompt")?.height).toBe(6);
  });

  it("hides optional regions before prompt and status rail under constrained height", () => {
    const layout = createOperatorConsoleLayout(createFullState(), { width: 60, height: 2, isTty: true });

    expect(visibleRegionKinds(layout)).toEqual(["prompt", "statusRail"]);
    expect(region(layout, "activeWork")).toBeUndefined();
    expect(region(layout, "streaming")).toMatchObject({ height: 0, visible: false });
    expect(region(layout, "turnActivity")).toMatchObject({ height: 0, visible: false });
    expect(region(layout, "approvals")).toMatchObject({ height: 0, visible: false });
    expect(region(layout, "attachments")).toMatchObject({ height: 0, visible: false });
    expect(region(layout, "startupDashboard")).toMatchObject({ height: 0, visible: false });
    expect(region(layout, "setupPanel")).toMatchObject({ height: 0, visible: false });
    expect(region(layout, "transcript")).toMatchObject({ height: 0, visible: false });
  });

  it("hides the full active work region while streaming is visible", () => {
    const layout = createOperatorConsoleLayout(createState({
      activeWork: {
        items: [toolItem("tool-1", "running")],
        scrollOffset: 0,
        expanded: true,
      },
      streaming: streamingState(),
      attachments: [pastedAttachment("paste-1")],
    }), { width: 80, height: 3, isTty: true });

    expect(regionKinds(layout)).not.toContain("activeWork");
    expect(visibleRegionKinds(layout)).toEqual(["streaming", "prompt", "statusRail"]);
    expect(region(layout, "streaming")).toMatchObject({ height: 1, visible: true });
    expect(region(layout, "attachments")).toMatchObject({ height: 0, visible: false });
  });

  it("keeps streaming ahead of attachments on their priority tie", () => {
    const layout = createOperatorConsoleLayout(createState({
      streaming: streamingState(),
      attachments: [pastedAttachment("paste-1")],
    }), { width: 80, height: 3, isTty: true });

    expect(visibleRegionKinds(layout)).toEqual(["streaming", "prompt", "statusRail"]);
    expect(region(layout, "streaming")).toMatchObject({ height: 1, visible: true });
    expect(region(layout, "attachments")).toMatchObject({ height: 0, visible: false });
  });

  it("allocates live streaming into the remaining space after required prompt and status rows", () => {
    const state = createState({
      streaming: streamingState({
        segments: [],
        tail: numberedLines(80),
      }),
    });

    expect(region(createOperatorConsoleLayout(state, { width: 80, height: 24, isTty: true }), "streaming")?.height).toBe(22);
    expect(region(createOperatorConsoleLayout(state, { width: 80, height: 80, isTty: true }), "streaming")?.height).toBe(78);
  });

  it("keeps region bounds inside the terminal rectangle", () => {
    const layout = createOperatorConsoleLayout(createFullState(), { width: 32, height: 8, isTty: true });

    for (const item of layout.regions) {
      expect(item.x).toBe(0);
      expect(item.y).toBeGreaterThanOrEqual(0);
      expect(item.width).toBeLessThanOrEqual(layout.width);
      expect(item.height).toBeGreaterThanOrEqual(0);
      expect(item.y + item.height).toBeLessThanOrEqual(layout.height);
    }
  });

  it("is pure and deterministic", () => {
    const state = createFullState();
    const before = JSON.stringify(state);
    const terminal = { width: 80, height: 12, isTty: true };

    expect(createOperatorConsoleLayout(state, terminal)).toEqual(createOperatorConsoleLayout(state, terminal));
    expect(JSON.stringify(state)).toBe(before);
  });
});

function createState(input: Partial<OperatorConsoleState> = {}): OperatorConsoleState {
  return createInitialOperatorConsoleState({
    activeWork: createDefaultToolActivityState(),
    terminal: { width: 80, height: 24, isTty: true },
    ...input,
  });
}

function createFullState(input: Partial<OperatorConsoleState> = {}): OperatorConsoleState {
  return createState({
    startup: startupDashboard(),
    setupPanel: setupPanel(),
    transcript: [{ id: "t1", role: "assistant", text: "Ready." }],
    streaming: streamingState(),
    approvals: [approval("approval-1")],
    turnActivity: { phase: "thinking" },
    activeWork: {
      items: [toolItem("tool-1", "running")],
      scrollOffset: 0,
      expanded: true,
    },
    steer: {
      draft: "",
      cursorOffset: 0,
      mode: "queued",
      queued: {
        id: "steer-1",
        text: "focus on approvals",
        status: "queued",
      },
    },
    attachments: [pastedAttachment("paste-1")],
    slash: {
      query: "/mo",
      items: [{ id: "model", label: "/model" }],
    },
    ...input,
  });
}

function startupDashboard() {
  return {
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
    commands: [
      { command: "/tools", description: "inspect tools" },
      { command: "/skills", description: "loaded skills" },
      { command: "/model", description: "active model route" },
      { command: "/status", description: "runtime state" },
      { command: "/setup", description: "setup editor" },
    ],
    tips: [
      "Paste large context as attachments.",
      "Approvals appear inline when an action needs permission.",
    ],
  };
}

function setupPanel() {
  return {
    kind: "table" as const,
    title: "Model route",
    description: "Choose the active provider and model route.",
    rows: [
      { id: "openai", provider: "OpenAI", model: "gpt-5.5", status: "ready", notes: "API key set" },
      { id: "local", provider: "Local", model: "qwen3-coder", status: "offline", notes: "endpoint unset" },
    ],
    selectedRowId: "openai",
  };
}

function regionKinds(layout: OperatorConsoleLayout): readonly OperatorConsoleRegion["kind"][] {
  return layout.regions.map((item) => item.kind);
}

function visibleRegionKinds(layout: OperatorConsoleLayout): readonly OperatorConsoleRegion["kind"][] {
  return layout.regions.filter((item) => item.visible).map((item) => item.kind);
}

function region(layout: OperatorConsoleLayout, kind: OperatorConsoleRegion["kind"]): OperatorConsoleRegion | undefined {
  return layout.regions.find((item) => item.kind === kind);
}

function numberedLines(count: number): string {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");
}

function pastedAttachment(id: string) {
  return {
    id,
    kind: "pastedText" as const,
    title: "pasted text",
    preview: "MVP known issue",
    content: "MVP known issue details",
    metadata: { chars: 2_481 },
  };
}

function approval(id: string) {
  return {
    id,
    status: "pending" as const,
    action: "write file",
    target: "src/runtime/provider-turn-loop.ts",
    risk: "runtime behavior change",
  };
}

function streamingState(input: Partial<NonNullable<OperatorConsoleState["streaming"]>> = {}) {
  return {
    segments: input.segments ?? [{
      id: "segment-1",
      role: "assistant" as const,
      text: "Reviewing the runtime path.",
    }],
    tail: input.tail ?? "Checking the operator console",
    isStreaming: input.isStreaming ?? true,
  };
}

function toolItem(id: string, status: "queued" | "running" | "succeeded" | "failed" | "cancelled" | "awaitingApproval") {
  return {
    id,
    toolName: "read_file",
    status,
    summary: "src/cli/session-loop.ts",
    target: "src/cli/session-loop.ts",
    durationMs: 1_000,
  };
}
