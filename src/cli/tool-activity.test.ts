import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveTokens } from "../theme/token-resolver.js";
import type { TerminalCapabilities } from "../contracts/ui.js";
import type { RuntimeEvent } from "../contracts/runtime-event.js";
import type { ViewModel } from "../contracts/view-model.js";
import type { ToolDefinition } from "../contracts/tool.js";
import { StandardRenderer } from "../ui/renderers/standard-renderer.js";
import { renderPlain } from "../ui/renderers/plain-renderer.js";
import {
  ToolActivityViewModelBuilder,
  buildApprovalPromptViewModel,
  buildSecurityAuditViewModel,
  buildSetupNeededViewModel,
  buildTurnProgressRail,
} from "./tool-activity-view-models.js";
import {
  buildActivityTimelineViewModel,
  buildProgressContextRailViewModel,
  buildToolActivityRailViewModel,
  timelineEvent,
  progressStep,
  toolActivityRailEvent,
} from "../ui/view-models/builders.js";
import { ToolActivityRenderer } from "./tool-activity-renderer.js";
import { renderRuntimeEvent } from "./session-loop.js";

// ──────────────────────────────────────
// Global deterministic timer for animated snapshots
// ──────────────────────────────────────
describe("tool-activity", () => {
  let dateNowSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    dateNowSpy = vi.spyOn(Date, "now").mockReturnValue(0);
  });

  afterEach(() => {
    dateNowSpy?.mockRestore();
  });

// ──────────────────────────────────────
// Rendering context factories
// ──────────────────────────────────────

function fullCaps(): TerminalCapabilities {
  return {
    isTTY: true,
    supportsColor: true,
    supportsTrueColor: true,
    supportsUnicode: true,
    supportsEmoji: true,
    terminalWidth: 120,
    isDumb: false,
    isCI: false,
    supportsAnimation: true,
  };
}

function noColorCaps(): TerminalCapabilities {
  return {
    ...fullCaps(),
    supportsColor: false,
    supportsTrueColor: false,
  };
}

function noUnicodeCaps(): TerminalCapabilities {
  return {
    ...fullCaps(),
    supportsUnicode: false,
    supportsEmoji: false,
  };
}

function plainCaps(): TerminalCapabilities {
  return {
    isTTY: false,
    supportsColor: false,
    supportsTrueColor: false,
    supportsUnicode: false,
    supportsEmoji: false,
    terminalWidth: 80,
    isDumb: true,
    isCI: false,
    supportsAnimation: false,
  };
}

function narrowCaps(): TerminalCapabilities {
  return {
    ...fullCaps(),
    terminalWidth: 40,
  };
}

function ciCaps(): TerminalCapabilities {
  return {
    ...fullCaps(),
    isCI: true,
    supportsAnimation: false,
  };
}

function dumbCaps(): TerminalCapabilities {
  return {
    ...fullCaps(),
    isDumb: true,
    supportsAnimation: false,
  };
}

function nonTtyCaps(): TerminalCapabilities {
  return {
    ...fullCaps(),
    isTTY: false,
    supportsAnimation: false,
  };
}

// ──────────────────────────────────────
// Renderer factories per context
// ──────────────────────────────────────

function standardDarkRenderer() {
  const tokens = resolveTokens("standard", "dark", "kemetBlue");
  return new StandardRenderer({ tokens, capabilities: fullCaps() });
}

function standardLightRenderer() {
  const tokens = resolveTokens("standard", "light", "kemetBlue");
  return new StandardRenderer({ tokens, capabilities: fullCaps() });
}

function noColorRenderer() {
  const tokens = resolveTokens("standard", "dark", "kemetBlue");
  return new StandardRenderer({ tokens, capabilities: noColorCaps() });
}

function noUnicodeRenderer() {
  const tokens = resolveTokens("standard", "dark", "kemetBlue");
  return new StandardRenderer({ tokens, capabilities: noUnicodeCaps() });
}

function narrowRenderer() {
  const tokens = resolveTokens("standard", "dark", "kemetBlue");
  return new StandardRenderer({ tokens, capabilities: narrowCaps() });
}

function plainRenderer() {
  return { render: renderPlain };
}

function animatedDisabledRenderer() {
  const tokens = resolveTokens("standard", "dark", "kemetBlue");
  return new StandardRenderer({ tokens, capabilities: ciCaps() });
}

// ──────────────────────────────────────
// Snapshot helpers
// ──────────────────────────────────────

function snapshotContexts() {
  return [
    { name: "plain", renderer: plainRenderer() },
    { name: "standard dark", renderer: standardDarkRenderer() },
    { name: "standard light", renderer: standardLightRenderer() },
    { name: "no color", renderer: noColorRenderer() },
    { name: "no Unicode", renderer: noUnicodeRenderer() },
    { name: "narrow width", renderer: narrowRenderer() },
  ];
}

function snapshotOutput(output: string): string {
  return output.split("\n").map((line) => line.trimEnd()).join("\n");
}

// ──────────────────────────────────────
// ViewModel fixtures
// ──────────────────────────────────────

function emptyTimelineVm(): ViewModel {
  return buildActivityTimelineViewModel({ events: [] });
}

function singleRunningVm(): ViewModel {
  return buildActivityTimelineViewModel({
    events: [timelineEvent("artifact.store", "running")],
  });
}

function singleDoneVm(): ViewModel {
  return buildActivityTimelineViewModel({
    events: [
      timelineEvent("artifact.store", "done", { elapsedMs: 120, chars: 1200, sentChars: 1000 }),
    ],
  });
}

function singleFailedVm(): ViewModel {
  return buildActivityTimelineViewModel({
    events: [timelineEvent("terminal.exec", "failed", { elapsedMs: 500 })],
  });
}

function singleGatedVm(): ViewModel {
  return buildActivityTimelineViewModel({
    events: [
      timelineEvent("workspace.write", "gated", {
        elapsedMs: 50,
        decision: "ask",
        riskClass: "destructive-local",
      }),
    ],
  });
}

function multipleMixedVm(): ViewModel {
  return buildActivityTimelineViewModel({
    events: [
      timelineEvent("web.extract", "done", { elapsedMs: 800 }),
      timelineEvent("memory.write", "running"),
      timelineEvent("terminal.exec", "failed", { elapsedMs: 300 }),
    ],
  });
}

function approvalPromptVm(): ViewModel {
  return buildApprovalPromptViewModel({
    tool: { name: "workspace.write" } as Parameters<typeof buildApprovalPromptViewModel>[0]["tool"],
    riskClass: "destructive-local",
    targetKey: "src/index.ts",
    targetSummary: "src/index.ts",
    decision: "ask",
    result: undefined,
    input: undefined,
  } as Parameters<typeof buildApprovalPromptViewModel>[0]);
}

function securityAuditEmptyVm(): ViewModel {
  return buildSecurityAuditViewModel({ events: [], debug: false });
}

function securityAuditCompactVm(): ViewModel {
  return buildSecurityAuditViewModel({
    events: [
      {
        kind: "security-assessed",
        tool: "workspace.write",
        riskClass: "destructive-local",
        assessment: {
          decision: "allow",
          mode: "adaptive",
          risk: "low",
          deterministicRule: "trusted-workspace",
          reason: "Workspace is trusted",
        },
      },
      {
        kind: "security-assessed",
        tool: "terminal.exec",
        riskClass: "external-side-effect",
        assessment: {
          decision: "ask",
          mode: "adaptive",
          risk: "high",
          deterministicRule: undefined,
          reason: "High risk action requires approval",
        },
      },
    ] as Parameters<typeof buildSecurityAuditViewModel>[0]["events"],
    debug: false,
  });
}

function securityAuditDebugVm(): ViewModel {
  return buildSecurityAuditViewModel({
    events: [
      {
        kind: "security-assessed",
        tool: "workspace.write",
        riskClass: "destructive-local",
        assessment: {
          decision: "allow",
          mode: "adaptive",
          risk: "low",
          deterministicRule: "trusted-workspace",
          reason: "Workspace is trusted",
          assessor: { used: false, status: "disabled" },
        },
      },
    ] as Parameters<typeof buildSecurityAuditViewModel>[0]["events"],
    debug: true,
  });
}

function setupNeededImageVm(): ViewModel {
  return buildSetupNeededViewModel({
    capability: "image_generation",
    provider: "fal",
    model: "fal-ai/flux/dev",
    requiredSecret: "FAL_KEY",
  });
}

function setupNeededOtherVm(): ViewModel {
  return buildSetupNeededViewModel({
    capability: "tts",
    requiredSecret: "ELEVENLABS_API_KEY",
  });
}

function progressRailEmptyVm(): ViewModel {
  return buildProgressContextRailViewModel({ title: "Turn progress", steps: [] });
}

function progressRailActiveVm(): ViewModel {
  return buildProgressContextRailViewModel({
    title: "Turn progress",
    steps: [
      progressStep("web.extract", "done"),
      progressStep("memory.write", "active"),
      progressStep("terminal.exec", "pending"),
    ],
  });
}

function progressRailFailedVm(): ViewModel {
  return buildProgressContextRailViewModel({
    title: "Turn progress",
    steps: [
      progressStep("web.extract", "done"),
      progressStep("terminal.exec", "failed"),
    ],
  });
}

function progressRailTimerVm(): ViewModel {
  return buildProgressContextRailViewModel({
    title: "Turn progress",
    steps: [
      progressStep("web.extract", "done"),
      progressStep("memory.write", "active"),
      progressStep("terminal.exec", "pending"),
    ],
    sessionElapsedMs: 58_000,
    taskElapsedMs: 16_000,
  });
}

function progressRailIdleVm(): ViewModel {
  return buildProgressContextRailViewModel({
    title: "Turn progress",
    steps: [],
    sessionElapsedMs: 120_000,
    taskElapsedMs: "idle",
  });
}

// ──────────────────────────────────────
// Tool Activity Rail fixtures
// ──────────────────────────────────────

function emptyToolRailVm(): ViewModel {
  return buildToolActivityRailViewModel({ events: [] });
}

function singleToolRunningVm(): ViewModel {
  return buildToolActivityRailViewModel({
    events: [toolActivityRailEvent("readFile", "running", { label: "preparing", target: "/workspace/Stage-9B-plan.md" })],
  });
}

function singleToolDoneVm(): ViewModel {
  return buildToolActivityRailViewModel({
    events: [toolActivityRailEvent("readFile", "done", { elapsedMs: 1_400, label: "read", target: "/workspace/Stage-9B-plan.md" })],
  });
}

function singleToolFailedVm(): ViewModel {
  return buildToolActivityRailViewModel({
    events: [toolActivityRailEvent("terminal.exec", "failed", { elapsedMs: 500, label: "run", target: "npm test" })],
  });
}

function singleToolGatedVm(): ViewModel {
  return buildToolActivityRailViewModel({
    events: [toolActivityRailEvent("workspace.write", "gated", { elapsedMs: 50, label: "write", target: "src/index.ts", riskClass: "destructive-local" })],
  });
}

function multipleToolMixedVm(): ViewModel {
  return buildToolActivityRailViewModel({
    events: [
      toolActivityRailEvent("readFile", "done", { elapsedMs: 1_400, label: "read", target: "/workspace/Stage-9B-plan.md" }),
      toolActivityRailEvent("writeFile", "running", { label: "preparing", target: "/workspace/Stage-9B-plan.md" }),
      toolActivityRailEvent("terminal.exec", "failed", { elapsedMs: 500, label: "run", target: "npm test" }),
      toolActivityRailEvent("searchFiles", "done", { elapsedMs: 1_200, label: "review", target: "diff" }),
    ],
  });
}

function longPathToolRailVm(): ViewModel {
  return buildToolActivityRailViewModel({
    events: [
      toolActivityRailEvent("readFile", "done", {
        elapsedMs: 1_400,
        label: "read",
        target: "/workspace/very/long/path/to/the/file/that/exceeds/terminal/width/limit.md",
      }),
    ],
  });
}

function arabicToolRailVm(): ViewModel {
  return buildToolActivityRailViewModel({
    events: [
      toolActivityRailEvent("writeFile", "done", { elapsedMs: 1_200, label: "write", target: "/workspace/Stage-9B-plan.md" }),
    ],
  });
}

// ──────────────────────────────────────
// Test suites
// ──────────────────────────────────────

describe("Tool activity timeline", () => {
  for (const ctx of snapshotContexts()) {
    it(`renders empty in ${ctx.name}`, () => {
      const output = ctx.renderer.render(emptyTimelineVm());
      expect(snapshotOutput(output)).toMatchSnapshot(`timeline-empty-${ctx.name}`);
    });

    it(`renders single running in ${ctx.name}`, () => {
      const output = ctx.renderer.render(singleRunningVm());
      expect(snapshotOutput(output)).toMatchSnapshot(`timeline-running-${ctx.name}`);
    });

    it(`renders single done in ${ctx.name}`, () => {
      const output = ctx.renderer.render(singleDoneVm());
      expect(snapshotOutput(output)).toMatchSnapshot(`timeline-done-${ctx.name}`);
    });

    it(`renders single failed in ${ctx.name}`, () => {
      const output = ctx.renderer.render(singleFailedVm());
      expect(snapshotOutput(output)).toMatchSnapshot(`timeline-failed-${ctx.name}`);
    });

    it(`renders single gated in ${ctx.name}`, () => {
      const output = ctx.renderer.render(singleGatedVm());
      expect(snapshotOutput(output)).toMatchSnapshot(`timeline-gated-${ctx.name}`);
    });

    it(`renders multiple mixed in ${ctx.name}`, () => {
      const output = ctx.renderer.render(multipleMixedVm());
      expect(snapshotOutput(output)).toMatchSnapshot(`timeline-mixed-${ctx.name}`);
    });
  }
});

describe("Approval prompt", () => {
  for (const ctx of snapshotContexts()) {
    it(`renders in ${ctx.name}`, () => {
      const output = ctx.renderer.render(approvalPromptVm());
      expect(snapshotOutput(output)).toMatchSnapshot(`approval-${ctx.name}`);
    });
  }

  it("includes 'Always allow' when allowPersistentApproval is omitted", () => {
    const vm = approvalPromptVm() as Extract<ViewModel, { kind: "approval" }>;
    const actionIds = vm.actions.map((a) => a.id);
    expect(actionIds).toContain("always");
    expect(actionIds).toContain("once");
    expect(actionIds).toContain("session");
    expect(actionIds).toContain("deny");
  });

  it("includes 'Always allow' when allowPersistentApproval is true", () => {
    const vm = buildApprovalPromptViewModel(
      {
        tool: { name: "terminal.run" } as ToolDefinition,
        riskClass: "destructive-local",
        targetSummary: "rm -rf /",
        decision: "ask",
      },
      { allowPersistentApproval: true }
    );
    const actionIds = vm.actions.map((a) => a.id);
    expect(actionIds).toContain("always");
    expect(actionIds).toContain("once");
    expect(actionIds).toContain("session");
    expect(actionIds).toContain("deny");
  });

  it("omits 'Always allow' when allowPersistentApproval is false", () => {
    const vm = buildApprovalPromptViewModel(
      {
        tool: { name: "terminal.run" } as ToolDefinition,
        riskClass: "destructive-local",
        targetSummary: "rm -rf /",
        decision: "ask",
      },
      { allowPersistentApproval: false }
    );
    const actionIds = vm.actions.map((a) => a.id);
    expect(actionIds).not.toContain("always");
    expect(actionIds).toContain("once");
    expect(actionIds).toContain("session");
    expect(actionIds).toContain("deny");
  });
});

describe("Security audit", () => {
  for (const ctx of snapshotContexts()) {
    it(`renders empty in ${ctx.name}`, () => {
      const output = ctx.renderer.render(securityAuditEmptyVm());
      expect(snapshotOutput(output)).toMatchSnapshot(`security-empty-${ctx.name}`);
    });

    it(`renders compact in ${ctx.name}`, () => {
      const output = ctx.renderer.render(securityAuditCompactVm());
      expect(snapshotOutput(output)).toMatchSnapshot(`security-compact-${ctx.name}`);
    });

    it(`renders debug in ${ctx.name}`, () => {
      const output = ctx.renderer.render(securityAuditDebugVm());
      expect(snapshotOutput(output)).toMatchSnapshot(`security-debug-${ctx.name}`);
    });
  }
});

describe("Setup needed", () => {
  for (const ctx of snapshotContexts()) {
    it(`renders image generation in ${ctx.name}`, () => {
      const output = ctx.renderer.render(setupNeededImageVm());
      expect(snapshotOutput(output)).toMatchSnapshot(`setup-image-${ctx.name}`);
    });

    it(`renders other capability in ${ctx.name}`, () => {
      const output = ctx.renderer.render(setupNeededOtherVm());
      expect(snapshotOutput(output)).toMatchSnapshot(`setup-other-${ctx.name}`);
    });
  }
});

describe("Progress context rail", () => {
  for (const ctx of snapshotContexts()) {
    it(`renders empty in ${ctx.name}`, () => {
      const output = ctx.renderer.render(progressRailEmptyVm());
      expect(snapshotOutput(output)).toMatchSnapshot(`rail-empty-${ctx.name}`);
    });

    it(`renders active in ${ctx.name}`, () => {
      const output = ctx.renderer.render(progressRailActiveVm());
      expect(snapshotOutput(output)).toMatchSnapshot(`rail-active-${ctx.name}`);
    });

    it(`renders failed in ${ctx.name}`, () => {
      const output = ctx.renderer.render(progressRailFailedVm());
      expect(snapshotOutput(output)).toMatchSnapshot(`rail-failed-${ctx.name}`);
    });

    it(`renders timers in ${ctx.name}`, () => {
      const output = ctx.renderer.render(progressRailTimerVm());
      expect(snapshotOutput(output)).toMatchSnapshot(`rail-timer-${ctx.name}`);
    });

    it(`renders idle in ${ctx.name}`, () => {
      const output = ctx.renderer.render(progressRailIdleVm());
      expect(snapshotOutput(output)).toMatchSnapshot(`rail-idle-${ctx.name}`);
    });
  }
});

// ──────────────────────────────────────
// Tool Activity Rail
// ──────────────────────────────────────

describe("Tool activity rail", () => {
  for (const ctx of snapshotContexts()) {
    it(`renders empty in ${ctx.name}`, () => {
      const output = ctx.renderer.render(emptyToolRailVm());
      expect(snapshotOutput(output)).toMatchSnapshot(`tool-rail-empty-${ctx.name}`);
    });

    it(`renders single running in ${ctx.name}`, () => {
      const output = ctx.renderer.render(singleToolRunningVm());
      expect(snapshotOutput(output)).toMatchSnapshot(`tool-rail-running-${ctx.name}`);
    });

    it(`renders single done in ${ctx.name}`, () => {
      const output = ctx.renderer.render(singleToolDoneVm());
      expect(snapshotOutput(output)).toMatchSnapshot(`tool-rail-done-${ctx.name}`);
    });

    it(`renders single failed in ${ctx.name}`, () => {
      const output = ctx.renderer.render(singleToolFailedVm());
      expect(snapshotOutput(output)).toMatchSnapshot(`tool-rail-failed-${ctx.name}`);
    });

    it(`renders single gated in ${ctx.name}`, () => {
      const output = ctx.renderer.render(singleToolGatedVm());
      expect(snapshotOutput(output)).toMatchSnapshot(`tool-rail-gated-${ctx.name}`);
    });

    it(`renders multiple mixed in ${ctx.name}`, () => {
      const output = ctx.renderer.render(multipleToolMixedVm());
      expect(snapshotOutput(output)).toMatchSnapshot(`tool-rail-mixed-${ctx.name}`);
    });

    it(`renders long path truncated in ${ctx.name}`, () => {
      const output = ctx.renderer.render(longPathToolRailVm());
      expect(snapshotOutput(output)).toMatchSnapshot(`tool-rail-long-path-${ctx.name}`);
    });
  }

  it("renders Arabic labels with LTR-isolated technical tokens", () => {
    const tokens = resolveTokens("standard", "dark", "kemetBlue");
    const renderer = new StandardRenderer({ tokens, capabilities: fullCaps(), locale: "ar" });
    const output = renderer.render(arabicToolRailVm());
    expect(snapshotOutput(output)).toMatchSnapshot("tool-rail-arabic-standard");
  });

  it("renders Arabic in plain mode with LTR-isolated tokens", () => {
    const output = renderPlain(arabicToolRailVm(), "ar");
    expect(snapshotOutput(output)).toMatchSnapshot("tool-rail-arabic-plain");
  });

  it("static running marker does not animate", () => {
    const renderer = standardDarkRenderer();
    const vm = singleToolRunningVm();
    const output1 = renderer.render(vm);
    const output2 = renderer.render(vm);
    expect(output1).toBe(output2);
  });
});

// ──────────────────────────────────────
// Session-loop tool activity rail wiring
// ──────────────────────────────────────

describe("Session-loop tool activity rail wiring", () => {
  it("emits rail output for tool-start", () => {
    const output = { write: vi.fn() } as unknown as NodeJS.WritableStream;
    const renderer = standardDarkRenderer();
    const builder = new ToolActivityViewModelBuilder({ tools: [] });
    const streamState = { lastWriteEndedWithNewline: true };
    const turnOutput = { hasOutput: false, lastOutputWasSpinner: false };
    const event: RuntimeEvent = { kind: "tool-start", tool: "terminal.run", stepId: "1" };
    renderRuntimeEvent(output, event, builder, renderer, streamState, undefined, turnOutput);
    expect(output.write).toHaveBeenCalled();
    const written = (output.write as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0]).join("");
    expect(written).toContain("Run Command");
    expect(written).not.toContain("terminal.run");
  });

  it("uses target summaries instead of raw provider arguments in rail events", () => {
    const builder = new ToolActivityViewModelBuilder({ tools: [] });

    const start = builder.buildToolActivityRailEvent({
      kind: "tool-start",
      tool: "file.read",
      targetSummary: "src/app.ts",
    });
    const result = builder.buildToolActivityRailEvent({
      kind: "tool-result",
      tool: "file.read",
      ok: true,
      targetSummary: "src/app.ts",
    });
    const provider = builder.buildToolActivityRailEvent({
      kind: "provider-tool-call",
      provider: "mock",
      model: "mock",
      name: "file.read",
      argumentsText: '{"path":"src/app.ts"}',
    });

    expect(start.target).toBe("src/app.ts");
    expect(result.target).toBe("src/app.ts");
    expect(provider.target).toBeUndefined();
  });

  it("does not fall back to raw tool ids as display targets", () => {
    const builder = new ToolActivityViewModelBuilder({ tools: [] });

    const start = builder.buildToolActivityRailEvent({
      kind: "tool-start",
      tool: "terminal.run",
    });

    expect(start.tool).toBe("terminal.run");
    expect(start.target).toBe("Run Command");
  });

  it("builds timeline events with display labels", () => {
    const builder = new ToolActivityViewModelBuilder({ tools: [] });

    const start = builder.buildTimelineEvent({
      kind: "tool-start",
      tool: "terminal.run",
    });

    expect(start.tool).toBe("Run Command");
  });

  it("emits rail output for tool-result", () => {
    const output = { write: vi.fn() } as unknown as NodeJS.WritableStream;
    const renderer = standardDarkRenderer();
    const builder = new ToolActivityViewModelBuilder({ tools: [] });
    const streamState = { lastWriteEndedWithNewline: true };
    const turnOutput = { hasOutput: false, lastOutputWasSpinner: false };
    const event: RuntimeEvent = { kind: "tool-result", tool: "readFile", ok: true };
    renderRuntimeEvent(output, event, builder, renderer, streamState, undefined, turnOutput);
    expect(output.write).toHaveBeenCalled();
    const written = (output.write as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0]).join("");
    expect(written).toContain("read");
  });

  it("emits structured file change preview after write tool-result", () => {
    const output = { write: vi.fn() } as unknown as NodeJS.WritableStream;
    const renderer = standardDarkRenderer();
    const builder = new ToolActivityViewModelBuilder({ tools: [] });
    const streamState = { lastWriteEndedWithNewline: true };
    const turnOutput = { hasOutput: false, lastOutputWasSpinner: false };
    const event: RuntimeEvent = {
      kind: "tool-result",
      tool: "file.write",
      ok: true,
      fileChangePreview: {
        kind: "fileChangePreview",
        path: "src/app.ts",
        changeType: "added",
        summary: ["Added 2 line(s)."],
        diff: "+ one\n+ two",
      },
    };
    renderRuntimeEvent(output, event, builder, renderer, streamState, undefined, turnOutput);
    const written = (output.write as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => c[0]).join("");
    expect(written).toContain("created");
    expect(written).toContain("src/app.ts");
    expect(written).toContain("+ one");
  });

  it("does not emit durable rail output for provider-tool-call", () => {
    const output = { write: vi.fn() } as unknown as NodeJS.WritableStream;
    const renderer = standardDarkRenderer();
    const builder = new ToolActivityViewModelBuilder({ tools: [] });
    const streamState = { lastWriteEndedWithNewline: true };
    const turnOutput = { hasOutput: false, lastOutputWasSpinner: false };
    const event: RuntimeEvent = { kind: "provider-tool-call", provider: "openai", model: "gpt-4", name: "readFile", argumentsText: '{"path": "/workspace/file.md"}' };
    const phase = renderRuntimeEvent(output, event, builder, renderer, streamState, undefined, turnOutput);
    expect(phase).toBe("tool");
    expect(output.write).not.toHaveBeenCalled();
  });

  it("emits only bounded delegated child lifecycle lines in plain session rendering", () => {
    const output = { write: vi.fn() } as unknown as NodeJS.WritableStream;
    const renderer = standardDarkRenderer();
    const builder = new ToolActivityViewModelBuilder({ tools: [] });
    const streamState = { lastWriteEndedWithNewline: true };
    const turnOutput = { hasOutput: false, lastOutputWasSpinner: false };
    const metadata = {
      kind: "delegation-progress" as const,
      subagentId: "child-secret",
      childSessionId: "child-session-secret",
      parentSessionId: "parent-secret",
      role: "leaf" as const,
      depth: 1,
      taskIndex: 1,
      batchId: "batch-secret",
    };

    renderRuntimeEvent(output, {
      ...metadata,
      childEvent: { kind: "agent-start", sessionId: "child-session-secret" },
    }, builder, renderer, streamState, undefined, turnOutput);
    renderRuntimeEvent(output, {
      ...metadata,
      childEvent: { kind: "tool-start", tool: "file.read" },
    }, builder, renderer, streamState, undefined, turnOutput);
    renderRuntimeEvent(output, {
      ...metadata,
      childEvent: { kind: "delegation-result", status: "failed" },
    }, builder, renderer, streamState, undefined, turnOutput);

    const written = (output.write as ReturnType<typeof vi.fn>).mock.calls.map((call: unknown[]) => call[0]).join("");
    expect(written).toContain("Worker 2: started");
    expect(written).toContain("Worker 2: failed");
    expect(written).not.toContain("Read File");
    expect(written).not.toContain("child-session-secret");
    expect(written).not.toContain("batch-secret");
  });
});

// ──────────────────────────────────────
// Animation gating
// ──────────────────────────────────────

describe("Animation gating", () => {
  it("returns static first frame when animation is disabled", () => {
    const renderer = animatedDisabledRenderer();
    const vm = singleRunningVm();
    const output1 = renderer.render(vm);
    const output2 = renderer.render(vm);
    // Static frame: both renders produce identical output
    expect(output1).toBe(output2);
    expect(output1).toContain("⠋");
  });

  it("returns the first semantic waiting frame when animation is enabled", () => {
    const spy = vi.spyOn(Date, "now").mockReturnValue(0);
    const renderer = standardDarkRenderer();
    const vm = singleRunningVm();
    const output = renderer.render(vm);
    spy.mockRestore();
    // With Date.now() = 0, first frame should be returned
    expect(output).toContain("⠋");
  });
});

// ──────────────────────────────────────
// Backward-compatibility: string wrappers
// ──────────────────────────────────────

describe("Backward-compatible string wrappers", () => {
  it("ToolActivityRenderer still returns a string", () => {
    const renderer = new ToolActivityRenderer({ tools: [] });
    const event: RuntimeEvent = { kind: "tool-start", tool: "test", stepId: "1" };
    const output = renderer.render(event);
    expect(typeof output).toBe("string");
  });

  it("ToolActivityRenderer does not use raw tool ids as fallback targets", () => {
    const renderer = new ToolActivityRenderer({ tools: [] });
    const output = renderer.render({ kind: "tool-start", tool: "terminal.run" });
    expect(output).toContain("Run Command");
    expect(output).not.toContain("terminal.run");
  });

  it("ToolActivityRenderer includes target summaries", () => {
    const renderer = new ToolActivityRenderer({ tools: [] });
    renderer.render({ kind: "tool-start", tool: "file.read", targetSummary: "src/app.ts" });
    const output = renderer.render({ kind: "tool-result", tool: "file.read", ok: true, targetSummary: "src/app.ts" });
    expect(output).toContain("src/app.ts");
  });
});

});
