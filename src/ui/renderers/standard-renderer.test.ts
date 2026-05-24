import { describe, it, expect } from "vitest";
import { resolveTokens } from "../../theme/token-resolver.js";
import type { TerminalCapabilities } from "../../contracts/ui.js";
import {
  buildActivityTimelineViewModel,
  buildApprovalSecurityViewModel,
  buildCommandResultViewModel,
  buildKeyValueBlockViewModel,
  buildListViewModel,
  buildOnboardingPromptCardViewModel,
  buildPickerViewModel,
  buildPlainFallbackViewModel,
  buildProgressContextRailViewModel,
  buildStartupViewModel,
  buildStatusViewModel,
  buildTableViewModel,
  buildWarningErrorViewModel,
  buildStartupDashboardViewModel,
  buildStartupRuntimeViewModel,
  buildConversationMessageViewModel,
  buildActiveTurnSpinnerViewModel,
  buildToolActivityRailViewModel,
  buildFileChangePreviewViewModel,
  buildSessionStatusRailViewModel,
  buildShortcutHintRailViewModel,
  buildSlashMenuViewModel,
  buildUserPromptRailViewModel,
  kv,
  listItem,
  timelineEvent,
  progressStep,
  pickerOption,
  approvalAction,
  toolActivityRailEvent,
  shortcutHint,
  slashMenuOption,
} from "../view-models/builders.js";
import { StandardRenderer } from "./standard-renderer.js";
import { isolateLtr } from "../bidi.js";
import { measureVisibleWidth, stripAnsi } from "./layout.js";

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

function renderer(theme: "light" | "dark", caps: TerminalCapabilities) {
  const tokens = resolveTokens("standard", theme, "kemetBlue");
  return new StandardRenderer({ tokens, capabilities: caps });
}

function assertNoAnsi(text: string): void {
  expect(text).not.toMatch(/\x1b\[/);
}

function hasAnsi(text: string): boolean {
  return /\x1b\[/.test(text);
}

function hexToRgbForTest(hex: string): { r: number; g: number; b: number } {
  const value = hex.replace(/^#/u, "");
  return {
    r: parseInt(value.slice(0, 2), 16),
    g: parseInt(value.slice(2, 4), 16),
    b: parseInt(value.slice(4, 6), 16),
  };
}

function ansiFgForHex(hex: string): string {
  const { r, g, b } = hexToRgbForTest(hex);
  return `\x1b[38;2;${r};${g};${b}m`;
}

function onboardingTrustCard(overrides: Partial<Parameters<typeof buildOnboardingPromptCardViewModel>[0]> = {}) {
  return buildOnboardingPromptCardViewModel({
    title: "Workspace trust",
    bodyLines: [
      "Trust this workspace?",
      "EstaCoda can read project files and request approval before risky actions.",
    ],
    technicalLines: ["/workspace"],
    options: [
      { id: "trust", label: "Trust workspace" },
      { id: "skip", label: "Not now" },
    ],
    selectedOptionIndex: 0,
    ...overrides,
  });
}

describe("StandardRenderer — dispatch", () => {
  it("renders all ViewModel kinds without throwing", () => {
    const r = renderer("dark", fullCaps());
    const vms = [
      buildStatusViewModel({
        agentName: "A",
        model: { provider: "p", id: "i" },
        securityMode: "open",
        skillCount: 1,
        toolCount: 1,
        mcpActive: 0,
        mcpTotal: 0,
        taskflowActive: false,
      }),
      buildTableViewModel({ columns: [], rows: [] }),
      buildKeyValueBlockViewModel({ entries: [] }),
      buildListViewModel({ items: [] }),
      buildWarningErrorViewModel({ severity: "info", title: "T", message: "M" }),
      buildApprovalSecurityViewModel({
        toolName: "t",
        targetSummary: "s",
        severity: "warn",
        actions: [],
      }),
      buildActivityTimelineViewModel({ events: [] }),
      buildProgressContextRailViewModel({ steps: [] }),
      buildPickerViewModel({ title: "T", options: [] }),
      buildOnboardingPromptCardViewModel({
        title: "T",
        bodyLines: ["Question?"],
        options: [{ id: "yes", label: "Yes" }],
        selectedOptionIndex: 0,
      }),
      buildStartupViewModel({
        agentName: "A",
        taglines: [],
        model: { provider: "p", id: "i" },
        readiness: "ready",
      }),
      buildStartupDashboardViewModel({
        agentName: "A",
        taglines: [],
        version: "v0.0.1",
        model: { provider: "p", id: "i" },
        workspaceTrust: "unknown",
        workspaceVerification: "unknown",
        securityMode: "open",
        providerReadiness: "unknown",
        availableCommands: [],
      }),
      buildCommandResultViewModel({ ok: true, title: "T", blocks: [] }),
      buildPlainFallbackViewModel({ lines: ["line"] }),
      buildConversationMessageViewModel({ role: "assistant", text: "Hello" }),
      buildUserPromptRailViewModel({ text: "Hello" }),
      buildFileChangePreviewViewModel({ path: "src/app.ts", changeType: "modified", diff: "+ changed" }),
    ];

    for (const vm of vms) {
      const out = r.render(vm);
      expect(typeof out).toBe("string");
    }
  });

  it("renders bounded file change previews with omitted count", () => {
    const r = renderer("dark", fullCaps());
    const vm = buildFileChangePreviewViewModel({
      path: "src/app.ts",
      changeType: "modified",
      summary: ["Replaced one exact segment."],
      diff: [
        "@@ exact replacement @@",
        "- old 1",
        "- old 2",
        "- old 3",
        "- old 4",
        "+ new 1",
        "+ new 2",
        "+ new 3",
        "+ new 4",
        "+ new 5",
      ].join("\n"),
      omittedLineCount: 4,
    });

    const out = r.renderFileChangePreview(vm);
    expect(out).toContain("edited");
    expect(out).toContain("src/app.ts");
    expect(out).toContain("Replaced one exact segment.");
    expect(out).toContain("old 1");
    expect(out).not.toContain("new 5");
    expect(out).toContain("omitted 6 diff line(s).");
    expect(out).not.toContain("/diff latest");
  });
});

describe("StandardRenderer — dark theme", () => {
  it("renders status with dark brand color", () => {
    const r = renderer("dark", fullCaps());
    const vm = buildStatusViewModel({
      agentName: "EstaCoda",
      model: { provider: "openrouter", id: "claude-sonnet-4" },
      securityMode: "open",
      skillCount: 12,
      skillAutonomy: "suggest",
      toolCount: 34,
      mcpActive: 2,
      mcpTotal: 3,
      taskflowActive: true,
    });
    const out = r.renderStatus(vm);
    expect(out).toContain("EstaCoda is ready");
    expect(out).toContain("model:");
    expect(out).toContain("security:");
    expect(hasAnsi(out)).toBe(true);
  });

  it("renders warning with dark severity colors", () => {
    const r = renderer("dark", fullCaps());
    const vm = buildWarningErrorViewModel({
      severity: "error",
      title: "Fail",
      message: "Something broke",
    });
    const out = r.renderWarningError(vm);
    expect(out).toContain("[ERROR]");
    expect(out).toContain("Fail");
    expect(hasAnsi(out)).toBe(true);
  });

  it("renders table with colored header", () => {
    const r = renderer("dark", fullCaps());
    const vm = buildTableViewModel({
      title: "Jobs",
      columns: [{ key: "name", header: "Name" }],
      rows: [{ name: "daily" }],
    });
    const out = r.renderTable(vm);
    expect(out).toContain("Jobs");
    expect(out).toContain("Name");
    expect(out).toContain("daily");
    expect(hasAnsi(out)).toBe(true);
  });

  it("renders approval as permission card with caution title", () => {
    const r = renderer("dark", fullCaps());
    const vm = buildApprovalSecurityViewModel({
      toolName: "terminal.run",
      riskClass: "workspace write",
      targetSummary: "bun run smoke",
      severity: "warn",
      actions: [
        approvalAction("once", "Allow once"),
        approvalAction("session", "Allow session"),
        approvalAction("deny", "Deny", "error"),
      ],
    });
    const out = r.renderApprovalSecurity(vm);
    // Rounded corners for permission card (not square like framed panel)
    expect(out).toContain("╭");
    expect(out).toContain("╮");
    expect(out).toContain("╰");
    expect(out).toContain("╯");
    // Caution title, not brand title
    expect(out).toContain("⚠ Permission required");
    expect(out).not.toContain("𓂀 EstaCoda");
    expect(out).not.toContain("Approval required: terminal.run");
    // Key-value rows
    expect(out).toContain("Tool");
    expect(out).toContain("terminal.run");
    expect(out).toContain("Risk");
    expect(out).toContain("workspace write");
    expect(out).toContain("Target");
    expect(out).toContain("bun run smoke");
    // Inline actions
    expect(out).toContain("Allow once");
    expect(out).toContain("Allow session");
    expect(out).toContain("Deny");
    expect(hasAnsi(out)).toBe(true);
  });

  it("renders high-risk permission card with error severity", () => {
    const r = renderer("dark", fullCaps());
    const vm = buildApprovalSecurityViewModel({
      toolName: "terminal.run",
      riskClass: "destructive-local",
      targetSummary: "rm -rf /",
      severity: "error",
      actions: [
        approvalAction("once", "Allow once"),
        approvalAction("deny", "Deny", "error"),
      ],
    });
    const out = r.renderApprovalSecurity(vm);
    expect(out).toContain("⚠ Permission required");
    expect(out).toContain("destructive-local");
    expect(out).toContain("rm -rf /");
    expect(hasAnsi(out)).toBe(true);
  });

  it("renders English onboarding prompt card as setup wizard chrome", () => {
    const r = renderer("dark", fullCaps());
    const out = r.renderOnboardingPromptCard(onboardingTrustCard());
    const plain = stripAnsi(out);

    expect(plain).toContain("╭──── 𓂀  Workspace trust");
    expect(plain).toContain("Trust this workspace?");
    expect(plain).toContain("/workspace");
    expect(plain).toContain("▸ Trust workspace");
    expect(plain).toContain("  Not now");
    expect(plain).not.toContain("𓂀 EstaCoda · Workspace trust");
    expect(plain).not.toContain("Assistant");
    expect(plain).not.toContain("EstaCoda\n");
    expect(hasAnsi(out)).toBe(true);
  });

  it("renders English onboarding prompt card in standard light theme", () => {
    const r = renderer("light", fullCaps());
    const out = r.renderOnboardingPromptCard(onboardingTrustCard());
    const plain = stripAnsi(out);

    expect(plain).toContain("╭──── 𓂀  Workspace trust");
    expect(plain).toContain("▸ Trust workspace");
    expect(plain).not.toContain("Assistant");
    expect(hasAnsi(out)).toBe(true);
  });

  it("uses brand/action tokens for onboarding title and selection while border stays neutral", () => {
    const tokens = resolveTokens("standard", "dark", "kemetBlue");
    const r = new StandardRenderer({ tokens, capabilities: fullCaps() });
    const out = r.renderOnboardingPromptCard(onboardingTrustCard());

    expect(out).toContain(`${ansiFgForHex(tokens.contract.palette.brand)}\x1b[1m𓂀  Workspace trust`);
    expect(out).toContain(`${ansiFgForHex(tokens.contract.palette.action)}▸`);
    expect(out).toContain(`${ansiFgForHex(tokens.contract.surface.border)}╭──── `);
    expect(out).not.toContain(`${ansiFgForHex(tokens.contract.palette.brand)}╭`);
  });

  it("renders English onboarding prompt card at narrow widths without overflow", () => {
    const r = renderer("dark", narrowCaps());
    const out = r.renderOnboardingPromptCard(onboardingTrustCard({
      technicalLines: ["/Users/example/projects/this/is/a/very/long/workspace/path"],
    }));
    const plain = stripAnsi(out);

    expect(plain).toContain("╭──── 𓂀  Workspace trust");
    expect(plain).toContain("...");
    for (const line of plain.split("\n")) {
      expect(measureVisibleWidth(line)).toBeLessThanOrEqual(narrowCaps().terminalWidth);
    }
  });

  it("renders English onboarding card with no ANSI when color is disabled", () => {
    const r = renderer("dark", noColorCaps());
    const out = r.renderOnboardingPromptCard(onboardingTrustCard());
    assertNoAnsi(out);
    expect(out).toContain("𓂀  Workspace trust");
    expect(out).toContain("▸ Trust workspace");
  });

  it("renders no-color onboarding card with tokens removed cleanly", () => {
    const r = renderer("dark", noColorCaps());
    const out = r.renderOnboardingPromptCard(onboardingTrustCard());
    expect(out).toMatchInlineSnapshot(`
      "╭──── 𓂀  Workspace trust ────────────────────────────────────────────────────╮
        Trust this workspace?
        EstaCoda can read project files and request approval before risky actions.
        /workspace
        ▸ Trust workspace
          Not now
      ╰────────────────────────────────────────────────────────────────────────────╯"
    `);
  });

  it("renders English onboarding card with stable no-Unicode fallback", () => {
    const r = renderer("dark", noUnicodeCaps());
    const out = stripAnsi(r.renderOnboardingPromptCard(onboardingTrustCard()));
    expect(out).toContain("+---- *  Workspace trust");
    expect(out).toContain("> Trust workspace");
    expect(out).not.toContain("𓂀");
    expect(out).not.toContain("▸");
  });

  it("renders selected option marker at the selected option index", () => {
    const r = renderer("dark", noColorCaps());
    const out = r.renderOnboardingPromptCard(onboardingTrustCard({ selectedOptionIndex: 1 }));
    expect(out).toContain("  Trust workspace");
    expect(out).toContain("▸ Not now");
  });

  it("truncates long technical paths safely inside onboarding cards", () => {
    const r = renderer("dark", narrowCaps());
    const longPath = "/Users/example/projects/this/is/a/very/long/workspace/path/that/keeps/going";
    const out = stripAnsi(r.renderOnboardingPromptCard(onboardingTrustCard({ technicalLines: [longPath] })));

    expect(out).toContain("/Users/example");
    expect(out).toContain("...");
    expect(out).not.toContain(longPath);
    for (const line of out.split("\n")) {
      expect(measureVisibleWidth(line)).toBeLessThanOrEqual(narrowCaps().terminalWidth);
    }
  });

  it("renders Arabic onboarding card and isolates technical tokens", () => {
    const r = new StandardRenderer({ tokens: resolveTokens("standard", "dark", "kemetBlue"), capabilities: fullCaps(), locale: "ar" });
    const out = r.renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({
      title: "الثقة بمساحة العمل",
      bodyLines: ["هل تثق بمساحة العمل هذه؟", "يمكن لـ EstaCoda قراءة ملفات المشروع وطلب الموافقة قبل الإجراءات الخطرة."],
      technicalLines: ["/workspace", "KIMI_API_KEY", "kimi-k2", "openrouter"],
      options: [
        { id: "trust", label: "ثق بمساحة العمل" },
        { id: "skip", label: "ليس الآن" },
      ],
      selectedOptionIndex: 0,
      locale: "ar",
      direction: "rtl",
    }));

    expect(stripAnsi(out)).toContain("𓂀  الثقة بمساحة العمل");
    expect(out).toContain(isolateLtr("/workspace"));
    expect(out).toContain(isolateLtr("KIMI_API_KEY"));
    expect(out).toContain(isolateLtr("kimi-k2"));
    expect(out).toContain(isolateLtr("openrouter"));
  });

  it("renders permission card with no ANSI when color disabled", () => {
    const r = renderer("dark", noColorCaps());
    const vm = buildApprovalSecurityViewModel({
      toolName: "terminal.run",
      riskClass: "workspace write",
      targetSummary: "bun run smoke",
      severity: "warn",
      actions: [
        approvalAction("once", "Allow once"),
        approvalAction("deny", "Deny", "error"),
      ],
    });
    const out = r.renderApprovalSecurity(vm);
    assertNoAnsi(out);
    expect(out).toContain("Permission required");
    expect(out).toContain("terminal.run");
  });

  it("renders permission card with ASCII fallback in no-Unicode mode", () => {
    const r = renderer("dark", noUnicodeCaps());
    const vm = buildApprovalSecurityViewModel({
      toolName: "terminal.run",
      riskClass: "workspace write",
      targetSummary: "bun run smoke",
      severity: "warn",
      actions: [
        approvalAction("once", "Allow once"),
        approvalAction("deny", "Deny", "error"),
      ],
    });
    const out = r.renderApprovalSecurity(vm);
    expect(out).toContain("+"); // ASCII corners
    expect(out).not.toContain("╭");
    expect(out).not.toContain("╰");
    expect(out).not.toContain("⚠"); // no Unicode warning symbol
    expect(out).toContain("! Permission required"); // ASCII warning symbol
    expect(out).toContain("terminal.run");
  });

  it("renders permission card with Arabic locale and LTR-isolated tool IDs", () => {
    const r = new StandardRenderer({ tokens: resolveTokens("standard", "dark", "kemetBlue"), capabilities: fullCaps(), locale: "ar" });
    const vm = buildApprovalSecurityViewModel({
      toolName: "terminal.run",
      riskClass: "workspace write",
      targetSummary: "bun run smoke",
      severity: "warn",
      actions: [
        approvalAction("once", "Allow once"),
        approvalAction("deny", "Deny", "error"),
      ],
    });
    const out = r.renderApprovalSecurity(vm);
    // Arabic labels
    expect(out).toContain("\u0645\u0637\u0644\u0648\u0628 \u0625\u0630\u0646"); // "مطلوب إذن"
    expect(out).toContain("\u0627\u0644\u0623\u062f\u0627\u0629"); // "الأداة"
    expect(out).toContain("\u0627\u0644\u0645\u062e\u0627\u0637\u0631\u0629"); // "المخاطرة"
    expect(out).toContain("\u0627\u0644\u0647\u062f\u0641"); // "الهدف"
    // Tool ID should be LTR-isolated
    expect(out).toContain("\u2066terminal.run\u2069");
    expect(hasAnsi(out)).toBe(true);
  });

  it("renders startup hero panel", () => {
    const r = renderer("dark", fullCaps());
    const vm = buildStartupViewModel({
      agentName: "EstaCoda",
      taglines: ["Kemet Research"],
      model: { provider: "p", id: "i" },
      readiness: "ready",
    });
    const out = r.renderStartup(vm);
    expect(out).toContain("EstaCoda");
    expect(out).toContain("Kemet Research");
    expect(out).toContain("readiness:");
    expect(hasAnsi(out)).toBe(true);
  });

  it("renders timeline with Unicode markers", () => {
    const r = renderer("dark", fullCaps());
    const vm = buildActivityTimelineViewModel({
      events: [
        timelineEvent("terminal", "done", { elapsedMs: 1200 }),
        timelineEvent("web.extract", "failed"),
      ],
    });
    const out = r.renderActivityTimeline(vm);
    expect(out).toContain("terminal");
    expect(out).toContain("web.extract");
    expect(hasAnsi(out)).toBe(true);
  });

  it("renders progress with colored markers", () => {
    const r = renderer("dark", fullCaps());
    const vm = buildProgressContextRailViewModel({
      steps: [
        progressStep("Done", "done"),
        progressStep("Active", "active"),
        progressStep("Pending", "pending"),
        progressStep("Failed", "failed"),
      ],
    });
    const out = r.renderProgressRail(vm);
    expect(out).toContain("Done");
    expect(out).toContain("Active");
    expect(out).toContain("Pending");
    expect(out).toContain("Failed");
    expect(hasAnsi(out)).toBe(true);
  });
});

describe("StandardRenderer — light theme", () => {
  it("renders status with light brand color", () => {
    const r = renderer("light", fullCaps());
    const vm = buildStatusViewModel({
      agentName: "EstaCoda",
      model: { provider: "p", id: "i" },
      securityMode: "open",
      skillCount: 1,
      toolCount: 1,
      mcpActive: 0,
      mcpTotal: 0,
      taskflowActive: false,
    });
    const out = r.renderStatus(vm);
    expect(out).toContain("EstaCoda is ready");
    expect(hasAnsi(out)).toBe(true);
  });

  it("uses different color values than dark", () => {
    const darkR = renderer("dark", fullCaps());
    const lightR = renderer("light", fullCaps());

    const vm = buildStatusViewModel({
      agentName: "EstaCoda",
      model: { provider: "p", id: "i" },
      securityMode: "open",
      skillCount: 1,
      toolCount: 1,
      mcpActive: 0,
      mcpTotal: 0,
      taskflowActive: false,
    });

    const darkOut = darkR.renderStatus(vm);
    const lightOut = lightR.renderStatus(vm);

    // Both have ANSI, but the escape sequences should differ
    expect(hasAnsi(darkOut)).toBe(true);
    expect(hasAnsi(lightOut)).toBe(true);
    expect(darkOut).not.toBe(lightOut);
  });
});

describe("StandardRenderer — no-color fallback", () => {
  it("produces no ANSI when color is disabled", () => {
    const r = renderer("dark", noColorCaps());
    const vm = buildStatusViewModel({
      agentName: "EstaCoda",
      model: { provider: "p", id: "i" },
      securityMode: "open",
      skillCount: 1,
      toolCount: 1,
      mcpActive: 0,
      mcpTotal: 0,
      taskflowActive: false,
    });
    const out = r.renderStatus(vm);
    assertNoAnsi(out);
    expect(out).toContain("EstaCoda is ready");
  });

  it("produces no ANSI for warnings", () => {
    const r = renderer("dark", noColorCaps());
    const vm = buildWarningErrorViewModel({
      severity: "error",
      title: "Fail",
      message: "Broke",
    });
    const out = r.renderWarningError(vm);
    assertNoAnsi(out);
  });

  it("produces no ANSI for approval panel", () => {
    const r = renderer("dark", noColorCaps());
    const vm = buildApprovalSecurityViewModel({
      toolName: "t",
      targetSummary: "s",
      severity: "warn",
      actions: [approvalAction("a", "A")],
    });
    const out = r.renderApprovalSecurity(vm);
    assertNoAnsi(out);
  });

  it("produces no ANSI for timeline", () => {
    const r = renderer("dark", noColorCaps());
    const vm = buildActivityTimelineViewModel({
      events: [timelineEvent("tool", "done")],
    });
    const out = r.renderActivityTimeline(vm);
    assertNoAnsi(out);
  });

  it("produces no ANSI for command result", () => {
    const r = renderer("dark", noColorCaps());
    const vm = buildCommandResultViewModel({
      ok: true,
      title: "Result",
      blocks: [buildKeyValueBlockViewModel({ entries: [kv("k", "v")] })],
    });
    const out = r.renderCommandResult(vm);
    assertNoAnsi(out);
  });
});

describe("StandardRenderer — no-Unicode fallback", () => {
  it("uses ASCII markers for timeline", () => {
    const r = renderer("dark", noUnicodeCaps());
    const vm = buildActivityTimelineViewModel({
      events: [
        timelineEvent("t", "pending"),
        timelineEvent("t", "running"),
        timelineEvent("t", "done"),
        timelineEvent("t", "failed"),
        timelineEvent("t", "gated"),
      ],
    });
    const out = r.renderActivityTimeline(vm);
    expect(out).toContain("[ ]");
    expect(out).toContain("[>]");
    expect(out).toContain("[x]");
    expect(out).toContain("[-]");
    expect(out).toContain("[?]");
  });

  it("uses ASCII markers for progress", () => {
    const r = renderer("dark", noUnicodeCaps());
    const vm = buildProgressContextRailViewModel({
      steps: [
        progressStep("a", "pending"),
        progressStep("b", "active"),
        progressStep("c", "done"),
        progressStep("d", "failed"),
      ],
    });
    const out = r.renderProgressRail(vm);
    expect(out).toContain("[ ]");
    expect(out).toContain("[>]");
    expect(out).toContain("[x]");
    expect(out).toContain("[-]");
  });

  it("uses ASCII bullet for list", () => {
    const r = renderer("dark", noUnicodeCaps());
    const vm = buildListViewModel({
      items: [listItem("item")],
    });
    const out = r.renderList(vm);
    // The bullet glyph fallback is "-"
    expect(out).toContain("-");
  });
});

describe("StandardRenderer — plain mode fallback", () => {
  it("produces no ANSI and no Unicode in plain mode", () => {
    const tokens = resolveTokens("plain", "light", "kemetBlue");
    const r = new StandardRenderer({ tokens, capabilities: plainCaps() });

    const vm = buildStatusViewModel({
      agentName: "EstaCoda",
      model: { provider: "p", id: "i" },
      securityMode: "open",
      skillCount: 1,
      toolCount: 1,
      mcpActive: 0,
      mcpTotal: 0,
      taskflowActive: false,
    });
    const out = r.renderStatus(vm);
    assertNoAnsi(out);
    // Should use ASCII pipe "|" for rail
    expect(out).toContain("|");
  });

  it("plain fallback ViewModel passes through unchanged", () => {
    const tokens = resolveTokens("plain", "dark", "kemetBlue");
    const r = new StandardRenderer({ tokens, capabilities: plainCaps() });
    const vm = buildPlainFallbackViewModel({ lines: ["plain text"] });
    expect(r.renderPlainFallback(vm)).toBe("plain text");
  });
});

describe("StandardRenderer — narrow width", () => {
  it("renders within narrow terminal width", () => {
    const r = renderer("dark", narrowCaps());
    const vm = buildStatusViewModel({
      agentName: "EstaCoda",
      model: { provider: "very-long-provider-name", id: "very-long-model-id" },
      securityMode: "open",
      skillCount: 1,
      toolCount: 1,
      mcpActive: 0,
      mcpTotal: 0,
      taskflowActive: false,
    });
    const out = r.renderStatus(vm);
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });

  it("renders table within narrow width", () => {
    const r = renderer("dark", narrowCaps());
    const vm = buildTableViewModel({
      columns: [
        { key: "a", header: "A" },
        { key: "b", header: "B" },
      ],
      rows: [
        { a: "long-value-a", b: "long-value-b" },
      ],
    });
    const out = r.renderTable(vm);
    expect(out).toContain("long-value-a");
  });
});

describe("StandardRenderer — visual primitives", () => {
  it("renders status on rails", () => {
    const r = renderer("dark", fullCaps());
    const vm = buildStatusViewModel({
      agentName: "EstaCoda",
      model: { provider: "p", id: "i" },
      securityMode: "open",
      skillCount: 1,
      toolCount: 1,
      mcpActive: 0,
      mcpTotal: 0,
      taskflowActive: false,
    });
    const out = r.renderStatus(vm);
    // Rail uses toolPrefix glyph ("│" in Unicode mode)
    expect(out).toContain("│");
  });

  it("renders inline signals for severity", () => {
    const r = renderer("dark", fullCaps());
    const vm = buildKeyValueBlockViewModel({
      entries: [
        kv("ok", "value", "ok"),
        kv("warn", "value", "warn"),
        kv("error", "value", "error"),
      ],
    });
    const out = r.renderKeyValueBlock(vm);
    expect(out).toContain("ok");
    expect(out).toContain("warn");
    expect(out).toContain("error");
  });

  it("renders permission card with rounded corners", () => {
    const r = renderer("dark", fullCaps());
    const vm = buildApprovalSecurityViewModel({
      toolName: "terminal.run",
      riskClass: "workspace write",
      targetSummary: "rm -rf /",
      severity: "warn",
      actions: [approvalAction("allow", "Allow")],
    });
    const out = r.renderApprovalSecurity(vm);
    // Permission card uses rounded corners (not square like framed panel)
    expect(out).toContain("╭");
    expect(out).toContain("╮");
    expect(out).toContain("╰");
    expect(out).toContain("╯");
    expect(out).toContain("│");
    expect(out).toContain("⚠ Permission required");
  });

  it("renders hero panel for startup", () => {
    const r = renderer("dark", fullCaps());
    const vm = buildStartupViewModel({
      agentName: "EstaCoda",
      taglines: ["Kemet Research"],
      model: { provider: "p", id: "i" },
      readiness: "ready",
    });
    const out = r.renderStartup(vm);
    expect(out).toContain("EstaCoda");
    expect(out).toContain("Kemet Research");
  });

  it("renders legacy startup chrome in Arabic with isolated technical tokens", () => {
    const r = new StandardRenderer({ tokens: resolveTokens("standard", "dark", "kemetBlue"), capabilities: fullCaps(), locale: "ar" });
    const vm = buildStartupViewModel({
      agentName: "EstaCoda",
      taglines: [],
      model: { provider: "openrouter", id: "gpt-5.5" },
      readiness: "ready",
    });
    const out = r.renderStartup(vm);
    expect(out).toContain("النموذج");
    expect(out).toContain("الجاهزية");
    expect(out).toContain("جاهز");
    expect(out).toContain(isolateLtr("openrouter"));
    expect(out).toContain(isolateLtr("gpt-5.5"));
  });
});

describe("StandardRenderer — startup dashboard", () => {
  it("renders dashboard with hero, version, model readiness, info and commands", () => {
    const r = renderer("dark", fullCaps());
    const vm = buildStartupDashboardViewModel({
      agentName: "EstaCoda",
      taglines: ["Kemet Research", "السيادة التكنولوجية العربية"],
      version: "v0.0.5",
      sessionId: "sess-9f7a2c1b",
      model: { provider: "openrouter", id: "deepseek-reasoner" },
      workspaceTrust: "trusted",
      workspaceVerification: "verified",
      workspaceDirectory: "/workspace",
      securityMode: "high",
      skillAutonomy: "autonomous",
      providerReadiness: "ready",
      versionStatus: "unknown",
      availableCommands: [],
      warnings: [],
    });
    const out = r.renderStartupDashboard(vm);
    expect(out).toContain("EstaCoda");
    expect(out).toContain("Kemet Research");
    expect(out).toContain("v0.0.5");
    expect(out).toContain("sess-9f7a2c1b");
    expect(out).toContain("deepseek-reasoner");
    expect(out).toContain("ready");
    expect(out).toContain("Workspace Trust");
    expect(out).toContain("trusted");
    expect(out).toContain("Workspace Verification");
    expect(out).toContain("verified");
    expect(out).toContain("Workspace Directory");
    expect(out).toContain("/workspace");
    expect(out).toContain("Security Mode");
    expect(out).toContain("Skill Autonomy");
    expect(stripAnsi(out)).toContain("╭");
    expect(stripAnsi(out)).toContain("╰");
    expect(stripAnsi(out)).not.toContain("│ │");
    expect(out).toContain("/tools");
    expect(out).toContain("Browse runtime tools");
    expect(out).toContain("/status");
    expect(hasAnsi(out)).toBe(true);
  });

  it("renders degraded readiness with correct symbol", () => {
    const r = renderer("dark", fullCaps());
    const vm = buildStartupDashboardViewModel({
      agentName: "EstaCoda",
      taglines: [],
      version: "v0.0.5",
      model: { provider: "p", id: "deepseek-reasoner" },
      workspaceTrust: "trusted",
      workspaceVerification: "verified",
      securityMode: "high",
      providerReadiness: "degraded",
      availableCommands: [],
      warnings: [],
    });
    const out = r.renderStartupDashboard(vm);
    expect(out).toContain("degraded");
    expect(out).toContain("deepseek-reasoner");
  });

  it("renders missing-config readiness with fallback label", () => {
    const r = renderer("dark", fullCaps());
    const vm = buildStartupDashboardViewModel({
      agentName: "EstaCoda",
      taglines: [],
      version: "v0.0.5",
      model: { provider: "p", id: "i" },
      workspaceTrust: "unknown",
      workspaceVerification: "unknown",
      securityMode: "open",
      providerReadiness: "missing-config",
      availableCommands: [],
      warnings: [],
    });
    const out = r.renderStartupDashboard(vm);
    expect(out).toContain("model not configured");
    expect(out).toContain("missing config");
  });

  it("renders dashboard with warnings", () => {
    const r = renderer("dark", fullCaps());
    const vm = buildStartupDashboardViewModel({
      agentName: "EstaCoda",
      taglines: [],
      version: "v0.0.5",
      model: { provider: "p", id: "i" },
      workspaceTrust: "unknown",
      workspaceVerification: "unknown",
      securityMode: "open",
      providerReadiness: "missing-config",
      versionStatus: "unknown",
      availableCommands: [],
      warnings: [
        buildWarningErrorViewModel({ severity: "warn", title: "Config", message: "Missing" }),
      ],
    });
    const out = r.renderStartupDashboard(vm);
    expect(out).toContain("Missing");
  });

  it("renders dashboard without ANSI in no-color mode", () => {
    const r = renderer("dark", noColorCaps());
    const vm = buildStartupDashboardViewModel({
      agentName: "EstaCoda",
      taglines: ["Kemet Research"],
      version: "v0.0.5",
      model: { provider: "p", id: "i" },
      workspaceTrust: "trusted",
      workspaceVerification: "verified",
      workspaceDirectory: "/workspace",
      securityMode: "high",
      skillAutonomy: "autonomous",
      providerReadiness: "ready",
      versionStatus: "unknown",
      availableCommands: [],
      warnings: [],
    });
    const out = r.renderStartupDashboard(vm);
    assertNoAnsi(out);
  });

  it("renders dashboard with ASCII fallback in no-Unicode mode", () => {
    const r = renderer("dark", noUnicodeCaps());
    const vm = buildStartupDashboardViewModel({
      agentName: "EstaCoda",
      taglines: ["Kemet Research"],
      version: "v0.0.5",
      sessionId: "sess-abc",
      model: { provider: "p", id: "i" },
      workspaceTrust: "trusted",
      workspaceVerification: "verified",
      workspaceDirectory: "/workspace",
      securityMode: "high",
      skillAutonomy: "autonomous",
      providerReadiness: "ready",
      versionStatus: "unknown",
      availableCommands: [],
      warnings: [],
    });
    const out = r.renderStartupDashboard(vm);
    // Should use ASCII dash for separator, not Unicode box-drawing
    expect(out).not.toContain("─");
    expect(out).toContain("-");
  });

  it("keeps startup dashboard border styling isolated when title truncates", () => {
    const r = renderer("dark", narrowCaps());
    const vm = buildStartupDashboardViewModel({
      agentName: "EstaCoda",
      taglines: [],
      version: "v0.0.5",
      sessionId: "session-id-that-is-long-enough-to-truncate",
      model: { provider: "p", id: "deepseek-reasoner" },
      workspaceTrust: "trusted",
      workspaceVerification: "verified",
      securityMode: "high",
      providerReadiness: "ready",
      availableCommands: [],
      warnings: [],
    });
    const top = r.renderStartupDashboard(vm).split("\n").find((line) => stripAnsi(line).startsWith("╭"));
    expect(top).toBeDefined();
    expect(top).toContain("...");
    expect(top).toMatch(/\.\.\.\x1b\[0m\x1b\[0m\x1b\[38;2;51;51;51m─*╮/);
  });

  it("renders Arabic dashboard chrome and isolates startup technical tokens", () => {
    const r = new StandardRenderer({ tokens: resolveTokens("standard", "dark", "kemetBlue"), capabilities: fullCaps(), locale: "ar" });
    const vm = buildStartupDashboardViewModel({
      agentName: "EstaCoda",
      taglines: ["Kemet Research"],
      version: "v0.0.5",
      sessionId: "sess-9f7a2c1b",
      model: { provider: "openrouter", id: "deepseek-reasoner" },
      workspaceTrust: "trusted",
      workspaceVerification: "verified",
      workspaceDirectory: "/workspace",
      securityMode: "high",
      skillAutonomy: "autonomous",
      providerReadiness: "ready",
      versionStatus: "unknown",
      availableCommands: [],
      warnings: [],
    });
    const out = r.renderStartupDashboard(vm);
    expect(out).toContain("ثقة مساحة العمل");
    expect(out).toContain("حالة تحقق مساحة العمل");
    expect(out).toContain("الأوامر التفاعلية:");
    expect(out).toContain("استعرض أدوات التشغيل");
    expect(out).toContain("موثوقة");
    expect(out).toContain("متحقق منها");
    expect(out).toContain(isolateLtr("v0.0.5"));
    expect(out).toContain(isolateLtr("sess-9f7a2c1b"));
    expect(out).toContain(isolateLtr("deepseek-reasoner"));
    expect(out).toContain(isolateLtr("/workspace"));
    expect(out).toContain(isolateLtr("high"));
    expect(out).toContain(isolateLtr("autonomous"));
    expect(out).toContain(isolateLtr("/tools"));
    expect(out).toContain(isolateLtr("/skills"));
    expect(out).toContain(isolateLtr("/model"));
    expect(out).toContain(isolateLtr("/status"));
  });

  it("honors provided startup dashboard commands instead of localized fallbacks", () => {
    const r = new StandardRenderer({ tokens: resolveTokens("standard", "dark", "kemetBlue"), capabilities: fullCaps(), locale: "ar" });
    const vm = buildStartupDashboardViewModel({
      agentName: "EstaCoda",
      taglines: [],
      version: "v0.0.5",
      model: { provider: "p", id: "i" },
      workspaceTrust: "trusted",
      workspaceVerification: "verified",
      securityMode: "high",
      providerReadiness: "ready",
      availableCommands: [{ name: "/verify", description: "Verify startup" }],
      warnings: [],
    });
    const out = r.renderStartupDashboard(vm);
    expect(out).toContain(isolateLtr("/verify"));
    expect(out).toContain("Verify startup");
    expect(out).not.toContain("استعرض أدوات التشغيل");
    expect(out).not.toContain(isolateLtr("/tools"));
  });

  it("does not invent readiness, active provider state, version status, or command fallbacks", () => {
    const r = renderer("dark", fullCaps());
    const vm = buildStartupDashboardViewModel({
      agentName: "EstaCoda",
      taglines: [],
      version: "",
      model: { provider: "openrouter", id: "deepseek-reasoner" },
      workspaceTrust: "unknown",
      workspaceVerification: "unknown",
      workspaceDirectory: "/workspace",
      securityMode: "open",
      providerReadiness: "unknown",
      versionStatus: "unknown",
      availableCommands: [{ name: "/status", description: "Show session status" }],
      warnings: [],
    });
    const out = stripAnsi(r.renderStartupDashboard(vm));
    expect(out).toContain("unknown");
    expect(out).toContain("deepseek-reasoner");
    expect(out).toContain("/status");
    expect(out).toContain("Show session status");
    expect(out).not.toContain("ready");
    expect(out).not.toContain("active provider");
    expect(out).not.toContain("/tools");
    expect(out).not.toContain("Browse runtime tools");
  });
});

describe("StandardRenderer — empty and edge states", () => {
  it("renders empty table", () => {
    const r = renderer("dark", fullCaps());
    const vm = buildTableViewModel({ columns: [], rows: [] });
    const out = r.renderTable(vm);
    expect(out).toContain("No data.");
  });

  it("renders empty list", () => {
    const r = renderer("dark", fullCaps());
    const vm = buildListViewModel({ items: [] });
    const out = r.renderList(vm);
    expect(out).toContain("No items.");
  });

  it("renders empty timeline", () => {
    const r = renderer("dark", fullCaps());
    const vm = buildActivityTimelineViewModel({ events: [] });
    const out = r.renderActivityTimeline(vm);
    expect(out).toContain("No activity.");
  });

  it("renders empty progress", () => {
    const r = renderer("dark", fullCaps());
    const vm = buildProgressContextRailViewModel({ steps: [] });
    const out = r.renderProgressRail(vm);
    expect(out).toContain("No steps.");
  });

  it("renders command result with nested blocks", () => {
    const r = renderer("dark", fullCaps());
    const vm = buildCommandResultViewModel({
      ok: false,
      title: "Error",
      blocks: [
        buildWarningErrorViewModel({
          severity: "error",
          title: "Detail",
          message: "Something failed",
        }),
        buildKeyValueBlockViewModel({
          entries: [kv("code", 500)],
        }),
      ],
    });
    const out = r.renderCommandResult(vm);
    expect(out).toContain("[FAIL]");
    expect(out).toContain("Detail");
    expect(out).toContain("500");
  });

  it("renders picker with selected option highlighted", () => {
    const r = renderer("dark", fullCaps());
    const vm = buildPickerViewModel({
      title: "Choose",
      options: [
        pickerOption("a", "A", { selected: true }),
        pickerOption("b", "B"),
      ],
    });
    const out = r.renderPicker(vm);
    expect(out).toContain(">");
    expect(out).toContain("A");
    expect(out).toContain("B");
  });
});

describe("StandardRenderer — deterministic output", () => {
  it("produces identical output for identical input", () => {
    const r = renderer("dark", fullCaps());
    const vm = buildStatusViewModel({
      agentName: "EstaCoda",
      model: { provider: "p", id: "i" },
      securityMode: "open",
      skillCount: 1,
      toolCount: 1,
      mcpActive: 0,
      mcpTotal: 0,
      taskflowActive: false,
    });
    const a = r.render(vm);
    const b = r.render(vm);
    expect(a).toBe(b);
  });
});

describe("StandardRenderer — conversation message", () => {
  it("renders assistant message with open horizontal frame and brand title", () => {
    const r = renderer("dark", fullCaps());
    const vm = buildConversationMessageViewModel({
      role: "assistant",
      text: "Hello, world!",
    });
    const out = r.renderConversationMessage(vm);
    // Should contain the Unicode eye symbol and brand name
    expect(out).toContain("𓂀");
    expect(out).toContain("EstaCoda");
    // Should have open horizontal frame corners
    expect(out).toContain("╭");
    expect(out).toContain("╮");
    expect(out).toContain("╰");
    expect(out).toContain("╯");
    // Should not have vertical side borders
    expect(out).not.toContain("│");
    // Content should be present, indented by two spaces
    expect(out).toContain("  Hello, world!");
    expect(hasAnsi(out)).toBe(true);
  });

  it("renders assistant message with no-color capabilities", () => {
    const r = renderer("dark", noColorCaps());
    const vm = buildConversationMessageViewModel({
      role: "assistant",
      text: "No color here.",
    });
    const out = r.renderConversationMessage(vm);
    expect(out).toContain("EstaCoda");
    expect(out).toContain("No color here.");
    assertNoAnsi(out);
  });

  it("renders assistant message with no-Unicode capabilities", () => {
    const r = renderer("dark", noUnicodeCaps());
    const vm = buildConversationMessageViewModel({
      role: "assistant",
      text: "ASCII only.",
    });
    const out = r.renderConversationMessage(vm);
    // Should use ASCII fallback for brand symbol
    expect(out).toContain("* EstaCoda");
    // Should use ASCII corners
    expect(out).toContain("+");
    expect(out).not.toContain("\u256D");
    expect(out).not.toContain("\u256E");
    expect(out).not.toContain("\u2570");
    expect(out).not.toContain("\u256F");
    expect(out).toContain("ASCII only.");
  });

  it("renders assistant message within narrow terminal width", () => {
    const r = renderer("dark", narrowCaps());
    const vm = buildConversationMessageViewModel({
      role: "assistant",
      text: "Short text.",
    });
    const out = r.renderConversationMessage(vm);
    expect(out).toContain("EstaCoda");
    expect(out).toContain("Short text.");
    // Frame should respect narrow terminal width (visible characters only)
    for (const line of out.split("\n")) {
      expect(measureVisibleWidth(line)).toBeLessThanOrEqual(40);
    }
  });

  it("renders assistant message with plain capabilities", () => {
    const tokens = resolveTokens("plain", "light", "kemetBlue");
    const r = new StandardRenderer({ tokens, capabilities: plainCaps() });
    const vm = buildConversationMessageViewModel({
      role: "assistant",
      text: "Plain mode.",
    });
    const out = r.renderConversationMessage(vm);
    expect(out).toContain("* EstaCoda");
    expect(out).toContain("Plain mode.");
    assertNoAnsi(out);
  });

  it("renders assistant message with skills and progress", () => {
    const r = renderer("dark", fullCaps());
    const vm = buildConversationMessageViewModel({
      role: "assistant",
      text: "Done.",
      matchedSkills: ["search", "git"],
      progress: ["plan", "execute"],
    });
    const out = r.renderConversationMessage(vm);
    expect(out).toContain("Done.");
    expect(out).toContain("skills: search, git");
    expect(out).toContain("progress: plan -> execute");
  });

  it("passes through user message text unchanged", () => {
    const r = renderer("dark", fullCaps());
    const vm = buildConversationMessageViewModel({
      role: "user",
      text: "Hello, assistant!",
    });
    const out = r.renderConversationMessage(vm);
    expect(out).toBe("Hello, assistant!");
  });
});

describe("StandardRenderer — prompt chrome rails", () => {
  it("renders session status rail as one bounded line", () => {
    const r = renderer("dark", fullCaps());
    const vm = buildSessionStatusRailViewModel({
      modelLabel: "deepseek-reasoner",
      turnState: "idle",
      contextUsage: { filled: 32700, total: 128000 },
      sessionElapsedMs: 58000,
      currentTurnSeconds: 312,
      showTurnState: false,
    });
    const out = r.render(vm);
    expect(out).toContain("deepseek-reasoner");
    expect(out).toContain("context 32.7k/128k");
    expect(out).toContain("◷ 58s");
    expect(out).toContain("⧖ 5m 12s");
    expect(out).not.toContain("idle");
    expect(out.split("\n")).toHaveLength(1);
  });

  it("renders status and shortcut rails in standard light theme", () => {
    const r = renderer("light", fullCaps());
    const status = r.render(buildSessionStatusRailViewModel({ modelLabel: "deepseek-reasoner", turnState: "idle" }));
    const shortcuts = r.render(buildShortcutHintRailViewModel({ hints: [] }));

    expect(status).toContain("deepseek-reasoner");
    expect(status).toContain("idle");
    expect(status.split("\n")).toHaveLength(1);
    expect(shortcuts).toContain("/help · /tools · /model · /status · Ctrl+C exit");
    expect(shortcuts.split("\n")).toHaveLength(1);
    expect(hasAnsi(status)).toBe(true);
    expect(hasAnsi(shortcuts)).toBe(true);
  });

  it("keeps narrow status and shortcut rails bounded to one line", () => {
    const r = renderer("dark", narrowCaps());
    const status = stripAnsi(r.render(buildSessionStatusRailViewModel({
      modelLabel: "openrouter/deepseek-reasoner-with-a-very-long-route-name",
      turnState: "running",
      contextUsage: { filled: 98765, total: 128000 },
      sessionElapsedMs: 125000,
    })));
    const shortcuts = stripAnsi(r.render(buildShortcutHintRailViewModel({ hints: [] })));

    for (const out of [status, shortcuts]) {
      const lines = out.split("\n");
      expect(lines).toHaveLength(1);
      expect(measureVisibleWidth(lines[0] ?? "")).toBeLessThanOrEqual(40);
    }
    expect(status).toContain("...");
    expect(shortcuts).toContain("...");
  });

  it("renders shortcut hint rail with chrome copy", () => {
    const r = renderer("dark", fullCaps());
    const vm = buildShortcutHintRailViewModel({ hints: [] });
    const out = r.render(vm);
    expect(out).toContain("/help · /tools · /model · /status · Ctrl+C exit");
    expect(out.split("\n")).toHaveLength(1);
  });

  it("renders slash completion rows with token colors and no brand chrome", () => {
    const tokens = resolveTokens("standard", "dark", "kemetBlue");
    const r = new StandardRenderer({ tokens, capabilities: fullCaps() });
    const out = r.render(buildSlashMenuViewModel({
      query: "/",
      options: [
        slashMenuOption("help", "/help", { description: "Show command help" }),
        slashMenuOption("status", "/status", { description: "Show status" }),
      ],
      selectedIndex: 0,
    }));
    const { r: ar, g: ag, b: ab } = hexToRgbForTest(tokens.contract.palette.action);
    const { r: pr, g: pg, b: pb } = hexToRgbForTest(tokens.contract.text.primary);
    const { r: sr, g: sg, b: sb } = hexToRgbForTest(tokens.contract.text.secondary);
    expect(out).toContain(`\x1b[38;2;${ar};${ag};${ab}m>\x1b[0m`);
    expect(out).toContain(`\x1b[38;2;${ar};${ag};${ab}m/help\x1b[0m`);
    expect(out).toContain(`\x1b[38;2;${pr};${pg};${pb}m/status\x1b[0m`);
    expect(out).toContain(`\x1b[38;2;${sr};${sg};${sb}mShow command help\x1b[0m`);
    expect(out).not.toContain("Commands");
    expect(out).not.toContain("𓂀");
  });

  it("uses ASCII/no-ANSI fallback for no-color and no-Unicode rail rendering", () => {
    const tokens = resolveTokens("plain", "light", "kemetBlue");
    const r = new StandardRenderer({ tokens, capabilities: noUnicodeCaps() });
    const out = r.render(buildSessionStatusRailViewModel({ modelLabel: "m", turnState: "idle" }));
    expect(out).toContain("*  m");
    expect(out).toContain("idle");
    assertNoAnsi(out);
  });

  it("keeps Arabic technical tokens LTR-stable", () => {
    const r = new StandardRenderer({ tokens: resolveTokens("standard", "dark", "kemetBlue"), capabilities: fullCaps(), locale: "ar" });
    const status = r.render(buildSessionStatusRailViewModel({ modelLabel: "deepseek-reasoner", turnState: "idle" }));
    const shortcuts = r.render(buildShortcutHintRailViewModel({ hints: [] }));
    expect(status).toContain("\u2066deepseek-reasoner\u2069");
    expect(status).toContain("\u062e\u0627\u0645\u0644");
    expect(shortcuts).toContain("\u2066/help\u2069");
    expect(shortcuts).toContain("\u2066Ctrl+C\u2069");
  });

  it("renders user prompt rail with Unicode bullet and horizontal rule", () => {
    const r = renderer("dark", fullCaps());
    const vm = buildUserPromptRailViewModel({ text: "Hello, world!" });
    const out = r.render(vm);
    expect(out).toContain("\u25b8 Hello, world!");
    expect(out).toContain(`+${"\u2500".repeat(118)}+`);
    expect(out.split("\n")).toHaveLength(2);
  });

  it("renders user prompt rail with ASCII fallback when Unicode is disabled", () => {
    const r = renderer("dark", noUnicodeCaps());
    const vm = buildUserPromptRailViewModel({ text: "Hello, world!" });
    const out = r.render(vm);
    expect(out).toContain("> Hello, world!");
    expect(out).toContain(`+${"-".repeat(118)}+`);
    expect(out.split("\n")).toHaveLength(2);
  });

  it("renders user prompt rail within narrow terminal width", () => {
    const r = renderer("dark", narrowCaps());
    const vm = buildUserPromptRailViewModel({ text: "This is a very long user prompt that should be truncated to fit within the narrow terminal width of forty characters" });
    const out = r.render(vm);
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("\u25b8");
    expect(lines[0].length).toBeLessThanOrEqual(40);
    expect(lines[1]).toBe(`+${"\u2500".repeat(38)}+`);
  });

  it("produces no ANSI for user prompt rail in no-color mode", () => {
    const r = renderer("dark", noColorCaps());
    const vm = buildUserPromptRailViewModel({ text: "Plain text" });
    const out = r.render(vm);
    assertNoAnsi(out);
    expect(out).toContain("\u25b8 Plain text");
  });

  it("renders active turn spinner with brand eye and localized label", () => {
    const r = renderer("dark", fullCaps());
    const vm = buildActiveTurnSpinnerViewModel({ phase: "thinking" });
    const out = r.render(vm);
    expect(out).toContain("contemplating");
    expect(hasAnsi(out)).toBe(true);
  });

  it("renders active turn spinner with explicit label overriding phase", () => {
    const r = renderer("dark", fullCaps());
    const vm = buildActiveTurnSpinnerViewModel({ phase: "thinking", label: "custom label" });
    const out = r.render(vm);
    expect(out).toContain("custom label");
    expect(out).not.toContain("contemplating");
  });

  it("renders active turn spinner with Arabic locale", () => {
    const r = new StandardRenderer({ tokens: resolveTokens("standard", "dark", "kemetBlue"), capabilities: fullCaps(), locale: "ar" });
    const vm = buildActiveTurnSpinnerViewModel({ phase: "thinking" });
    const out = r.render(vm);
    expect(out).toContain("\u0628\u0641\u0643\u0631");
    expect(hasAnsi(out)).toBe(true);
  });

  it("renders active turn spinner with ASCII fallback in no-Unicode mode", () => {
    const r = renderer("dark", noUnicodeCaps());
    const vm = buildActiveTurnSpinnerViewModel({ phase: "provider" });
    const out = r.render(vm);
    expect(out).not.toContain("\uD80C\uDDE0");
    expect(out).toContain("scribbling");
    expect(hasAnsi(out)).toBe(true);
  });
});
