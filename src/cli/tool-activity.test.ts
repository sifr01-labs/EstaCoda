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
  timelineEvent,
  progressStep,
} from "../ui/view-models/builders.js";
import { ToolActivityRenderer } from "./tool-activity-renderer.js";

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
// Test suites
// ──────────────────────────────────────

describe("Tool activity timeline", () => {
  for (const ctx of snapshotContexts()) {
    it(`renders empty in ${ctx.name}`, () => {
      const output = ctx.renderer.render(emptyTimelineVm());
      expect(output).toMatchSnapshot(`timeline-empty-${ctx.name}`);
    });

    it(`renders single running in ${ctx.name}`, () => {
      const output = ctx.renderer.render(singleRunningVm());
      expect(output).toMatchSnapshot(`timeline-running-${ctx.name}`);
    });

    it(`renders single done in ${ctx.name}`, () => {
      const output = ctx.renderer.render(singleDoneVm());
      expect(output).toMatchSnapshot(`timeline-done-${ctx.name}`);
    });

    it(`renders single failed in ${ctx.name}`, () => {
      const output = ctx.renderer.render(singleFailedVm());
      expect(output).toMatchSnapshot(`timeline-failed-${ctx.name}`);
    });

    it(`renders single gated in ${ctx.name}`, () => {
      const output = ctx.renderer.render(singleGatedVm());
      expect(output).toMatchSnapshot(`timeline-gated-${ctx.name}`);
    });

    it(`renders multiple mixed in ${ctx.name}`, () => {
      const output = ctx.renderer.render(multipleMixedVm());
      expect(output).toMatchSnapshot(`timeline-mixed-${ctx.name}`);
    });
  }
});

describe("Approval prompt", () => {
  for (const ctx of snapshotContexts()) {
    it(`renders in ${ctx.name}`, () => {
      const output = ctx.renderer.render(approvalPromptVm());
      expect(output).toMatchSnapshot(`approval-${ctx.name}`);
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
      expect(output).toMatchSnapshot(`security-empty-${ctx.name}`);
    });

    it(`renders compact in ${ctx.name}`, () => {
      const output = ctx.renderer.render(securityAuditCompactVm());
      expect(output).toMatchSnapshot(`security-compact-${ctx.name}`);
    });

    it(`renders debug in ${ctx.name}`, () => {
      const output = ctx.renderer.render(securityAuditDebugVm());
      expect(output).toMatchSnapshot(`security-debug-${ctx.name}`);
    });
  }
});

describe("Setup needed", () => {
  for (const ctx of snapshotContexts()) {
    it(`renders image generation in ${ctx.name}`, () => {
      const output = ctx.renderer.render(setupNeededImageVm());
      expect(output).toMatchSnapshot(`setup-image-${ctx.name}`);
    });

    it(`renders other capability in ${ctx.name}`, () => {
      const output = ctx.renderer.render(setupNeededOtherVm());
      expect(output).toMatchSnapshot(`setup-other-${ctx.name}`);
    });
  }
});

describe("Progress context rail", () => {
  for (const ctx of snapshotContexts()) {
    it(`renders empty in ${ctx.name}`, () => {
      const output = ctx.renderer.render(progressRailEmptyVm());
      expect(output).toMatchSnapshot(`rail-empty-${ctx.name}`);
    });

    it(`renders active in ${ctx.name}`, () => {
      const output = ctx.renderer.render(progressRailActiveVm());
      expect(output).toMatchSnapshot(`rail-active-${ctx.name}`);
    });

    it(`renders failed in ${ctx.name}`, () => {
      const output = ctx.renderer.render(progressRailFailedVm());
      expect(output).toMatchSnapshot(`rail-failed-${ctx.name}`);
    });

    it(`renders timers in ${ctx.name}`, () => {
      const output = ctx.renderer.render(progressRailTimerVm());
      expect(output).toMatchSnapshot(`rail-timer-${ctx.name}`);
    });

    it(`renders idle in ${ctx.name}`, () => {
      const output = ctx.renderer.render(progressRailIdleVm());
      expect(output).toMatchSnapshot(`rail-idle-${ctx.name}`);
    });
  }
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
    expect(output1).toContain("(⌦)");
  });

  it("returns a spinner frame when animation is enabled", () => {
    const spy = vi.spyOn(Date, "now").mockReturnValue(0);
    const renderer = standardDarkRenderer();
    const vm = singleRunningVm();
    const output = renderer.render(vm);
    spy.mockRestore();
    // With Date.now() = 0, first frame should be returned
    expect(output).toContain("(⌦)");
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
});

});
