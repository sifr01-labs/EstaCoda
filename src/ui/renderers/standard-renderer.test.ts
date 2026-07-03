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
  buildAssistantResponseViewModel,
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
import { closeOpenBidiIsolates, isolateLtr, isolateRtl, LRI, PDI, RLI } from "../bidi.js";
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

function expectBalancedBidiIsolates(text: string): void {
  let depth = 0;
  for (const char of text) {
    if (char === LRI || char === RLI) {
      depth += 1;
    } else if (char === PDI) {
      depth -= 1;
    }
    expect(depth).toBeGreaterThanOrEqual(0);
  }
  expect(depth).toBe(0);
}

function stripTrailingBidiControls(text: string): string {
  return text.replace(/[\u2066\u2067\u2069]+$/gu, "");
}

function visibleMarkerColumn(line: string, marker: string): number {
  const markerIndex = line.indexOf(marker);
  expect(markerIndex).toBeGreaterThanOrEqual(0);
  return measureVisibleWidth(line.slice(0, markerIndex));
}

function visibleTextEndColumn(line: string, text: string): number {
  const textIndex = line.indexOf(text);
  expect(textIndex).toBeGreaterThanOrEqual(0);
  return measureVisibleWidth(line.slice(0, textIndex)) + measureVisibleWidth(text);
}

function visibleTextStartColumn(line: string, text: string): number {
  const textIndex = line.indexOf(text);
  expect(textIndex).toBeGreaterThanOrEqual(0);
  return measureVisibleWidth(line.slice(0, textIndex));
}

function countBidiControl(line: string, control: string): number {
  return [...line].filter((char) => char === control).length;
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

function ansiBgForHex(hex: string): string {
  const { r, g, b } = hexToRgbForTest(hex);
  return `\x1b[48;2;${r};${g};${b}m`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
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
        workflowAvailable: false,
        workflowRunActive: false,
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
      workflowAvailable: true,
      workflowRunActive: true,
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
    expect(out).toBe([
      "╭──── 𓂀  Workspace trust ────────────────────────────────────────────────────╮",
      "  Trust this workspace?",
      "  EstaCoda can read project files and request approval before risky actions.",
      "  /workspace",
      "  ",
      "  ▸ Trust workspace",
      "    Not now",
      "╰────────────────────────────────────────────────────────────────────────────╯",
    ].join("\n"));
  });

  it("inserts aligned prompt-card spacing between pre-option content and options", () => {
    const r = renderer("dark", noColorCaps());
    const out = r.renderOnboardingPromptCard(onboardingTrustCard());
    expect(out).toContain("/workspace\n  \n  ▸ Trust workspace");
  });

  it("does not insert prompt-card spacing for option-only cards", () => {
    const r = renderer("dark", noColorCaps());
    const out = r.renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({
      title: "Choose",
      bodyLines: [],
      options: [{ id: "continue", label: "Continue" }],
      selectedOptionIndex: 0,
    }));
    expect(out).not.toContain("\n  \n");
  });

  it("does not insert prompt-card spacing for content-only cards", () => {
    const r = renderer("dark", noColorCaps());
    const out = r.renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({
      title: "Notice",
      bodyLines: ["Nothing to choose."],
      options: [],
      selectedOptionIndex: 0,
    }));
    expect(out).not.toContain("\n  \n");
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

  it("renders generic structured prompt-card rows with columns, badges, current, and hint", () => {
    const r = renderer("dark", noColorCaps());
    const out = r.renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({
      title: "Choose mode",
      bodyLines: ["Pick a generic mode."],
      statusLines: [
        { text: "Current: Alpha", tone: "active", direction: "ltr" },
      ],
      columns: [
        { key: "name", header: "Name" },
        { key: "description", header: "Description" },
      ],
      options: [
        {
          id: "alpha",
          label: "Alpha",
          cells: { name: "Alpha", description: "First generic option" },
          badges: ["Recommended"],
          current: true,
        },
        {
          id: "beta",
          label: "Beta",
          cells: { name: "Beta", description: "Second generic option" },
        },
        {
          id: "back",
          label: "Back",
          group: "navigation",
          cells: { name: "Back", description: "Return to previous step" },
        },
        {
          id: "cancel",
          label: "Cancel",
          group: "navigation",
          cells: { name: "Cancel", description: "Exit without changes" },
        },
      ],
      selectedOptionIndex: 0,
      hint: "↑↓ navigate   ENTER select",
    }));
    const plain = stripAnsi(out);

    expect(plain).toContain("Name");
    expect(plain).toContain("Description");
    expect(plain).toContain("Current: Alpha");
    expect(plain).toContain("▸ Alpha");
    expect(plain).toContain("First generic option");
    expect(plain).toContain("Recommended  Current");
    expect(plain).toContain("  Beta");
    expect(plain).toContain("Back");
    expect(plain).toContain("Cancel");
    expect(plain).toContain("↑↓ navigate   ENTER select");
    const lines = plain.split("\n");
    const backIndex = lines.findIndex((line) => line.includes("Back"));
    const cancelIndex = lines.findIndex((line) => line.includes("Cancel"));
    expect(backIndex).toBeGreaterThan(0);
    expect(lines[backIndex - 1]?.trim()).toBe("");
    expect(cancelIndex).toBe(backIndex + 1);
  });

  it("styles strong prompt-card body lines without embedding style in copy", () => {
    const r = renderer("dark", fullCaps());
    const out = r.renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({
      title: "Setup editor",
      bodyLines: ["Choose what to configure:"],
      bodyLineStyles: [{ emphasis: "strong" }],
      options: [
        { id: "primary", label: "Primary model", description: "Default model used by the agent." },
      ],
      selectedOptionIndex: 0,
    }));

    expect(out).toMatch(/\x1b\[1mChoose what to configure:/u);
    expect(stripAnsi(out)).toContain("Choose what to configure:");
  });

  it("hides structured prompt-card headers when explicitly disabled", () => {
    const r = renderer("dark", noColorCaps());
    const plain = stripAnsi(r.renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({
      title: "Choose mode",
      bodyLines: [],
      showColumnHeaders: false,
      columns: [
        { key: "name", header: "Name" },
        { key: "description", header: "Description" },
      ],
      options: [
        { id: "alpha", label: "Alpha", description: "First generic option" },
        { id: "beta", label: "Beta", description: "Second generic option" },
      ],
      selectedOptionIndex: 0,
    })));

    expect(plain).not.toContain("Name");
    expect(plain).not.toContain("Description");
    const selectedLine = plain.split("\n").find((line) => line.includes("▸ Alpha"));
    const betaLine = plain.split("\n").find((line) => line.includes("  Beta"));
    expect(selectedLine).toBeDefined();
    expect(selectedLine).toContain("First generic option");
    expect(betaLine).toBeDefined();
    expect(betaLine).toContain("Second generic option");
  });

  it("inserts one generic separator before non-structured navigation prompt-card rows", () => {
    const r = renderer("dark", noColorCaps());
    const plain = stripAnsi(r.renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({
      title: "Choose mode",
      bodyLines: [],
      options: [
        { id: "alpha", label: "Alpha" },
        { id: "beta", label: "Beta" },
        { id: "back", label: "Back", group: "navigation" },
        { id: "cancel", label: "Cancel", group: "navigation" },
      ],
      selectedOptionIndex: 0,
    })));
    const lines = plain.split("\n");
    const backIndex = lines.findIndex((line) => line.includes("Back"));
    const cancelIndex = lines.findIndex((line) => line.includes("Cancel"));
    expect(lines[backIndex - 1]?.trim()).toBe("");
    expect(cancelIndex).toBe(backIndex + 1);
  });

  it("uses active status coloring for prompt-card status lines", () => {
    const tokens = resolveTokens("standard", "dark", "kemetBlue");
    const r = new StandardRenderer({ tokens, capabilities: fullCaps() });
    const out = r.renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({
      title: "Choose mode",
      bodyLines: [],
      statusLines: [
        { text: "Current: Alpha", tone: "active", direction: "ltr" },
      ],
      options: [{ id: "alpha", label: "Alpha" }],
      selectedOptionIndex: 0,
    }));

    expect(out).toContain(`${ansiFgForHex(tokens.contract.severity.ok)}Current: Alpha`);
  });

  it("suppresses automatic current badges while preserving explicit badges", () => {
    const r = renderer("dark", noColorCaps());
    const plain = stripAnsi(r.renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({
      title: "Choose mode",
      bodyLines: [],
      showCurrentBadge: false,
      columns: [
        { key: "name", header: "Name" },
        { key: "description", header: "Description" },
      ],
      options: [
        {
          id: "alpha",
          label: "Alpha",
          cells: { name: "Alpha", description: "First generic option" },
          badges: ["Recommended"],
          current: true,
        },
      ],
      selectedOptionIndex: 0,
    })));

    const selectedLine = plain.split("\n").find((line) => line.includes("▸ Alpha"));
    expect(selectedLine).toBeDefined();
    expect(selectedLine).toContain("Recommended");
    expect(selectedLine).not.toContain("Current");
  });

  it("renders structured columns from label and description without cells", () => {
    const r = renderer("dark", noColorCaps());
    const plain = stripAnsi(r.renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({
      title: "Choose mode",
      bodyLines: [],
      columns: [
        { key: "name", header: "Name" },
        { key: "description", header: "Description" },
      ],
      options: [
        { id: "alpha", label: "Alpha", description: "First generic option" },
        { id: "beta", label: "Beta", description: "Second generic option" },
      ],
      selectedOptionIndex: 0,
    })));

    const selectedLine = plain.split("\n").find((line) => line.includes("▸ Alpha"));
    expect(selectedLine).toBeDefined();
    expect(selectedLine).toContain("First generic option");
    expect(plain).toContain("Description");
  });

  it("keeps structured prompt-card rows inside narrow terminal width", () => {
    const r = renderer("dark", narrowCaps());
    const plain = stripAnsi(r.renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({
      title: "Choose mode",
      bodyLines: ["Pick a generic mode."],
      columns: [
        { key: "name", header: "Name" },
        { key: "description", header: "Description" },
      ],
      options: [
        {
          id: "alpha-long",
          label: "Alpha with a long name",
          cells: {
            name: "Alpha with a long name",
            description: "A very long generic description that should truncate cleanly in a narrow terminal.",
          },
          current: true,
        },
      ],
      selectedOptionIndex: 0,
    })));

    expect(plain).toContain("...");
    expect(plain).toContain("Current");
    for (const line of plain.split("\n")) {
      expect(measureVisibleWidth(line)).toBeLessThanOrEqual(narrowCaps().terminalWidth);
    }
  });

  it("keeps current visible when structured descriptions are long", () => {
    const r = renderer("dark", { ...noColorCaps(), terminalWidth: 60 });
    const plain = stripAnsi(r.renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({
      title: "Choose mode",
      bodyLines: [],
      columns: [
        { key: "name", header: "Name" },
        { key: "description", header: "Description" },
      ],
      options: [
        {
          id: "alpha",
          label: "Alpha",
          cells: {
            name: "Alpha",
            description: "A very long generic option description that would previously hide the current badge.",
          },
          current: true,
        },
      ],
      selectedOptionIndex: 0,
    })));

    const selectedLine = plain.split("\n").find((line) => line.includes("▸ Alpha"));
    expect(selectedLine).toBeDefined();
    expect(selectedLine).toContain("...");
    expect(selectedLine).toContain("Current");
  });

  it("renders structured prompt-card rows with no Unicode fallback", () => {
    const r = renderer("dark", noUnicodeCaps());
    const plain = stripAnsi(r.renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({
      title: "Choose mode",
      bodyLines: [],
      columns: [
        { key: "name", header: "Name" },
        { key: "description", header: "Description" },
      ],
      options: [
        { id: "alpha", label: "Alpha", cells: { name: "Alpha", description: "First option" }, current: true },
        { id: "beta", label: "Beta", cells: { name: "Beta", description: "Second option" } },
      ],
      selectedOptionIndex: 0,
    })));

    expect(plain).toContain("> Alpha");
    expect(plain).toContain("Current");
    expect(plain).not.toContain("▸");
  });

  it("keeps structured prompt-card tables full-width by default", () => {
    const r = renderer("dark", noColorCaps());
    const plain = stripAnsi(r.renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({
      title: "Choose mode",
      bodyLines: [],
      showColumnHeaders: false,
      columns: [
        { key: "name", header: "Name" },
        { key: "description", header: "Description" },
      ],
      options: [
        { id: "alpha", label: "Alpha", description: "First option" },
      ],
      selectedOptionIndex: 0,
    })));

    const selectedLine = plain.split("\n").find((line) => line.includes("Alpha"));
    expect(selectedLine).toBeDefined();
    expect(measureVisibleWidth(selectedLine!)).toBe(noColorCaps().terminalWidth - 2);
  });

  it("renders compact structured prompt-card tables as content-width blocks", () => {
    const r = renderer("dark", noColorCaps());
    const plain = stripAnsi(r.renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({
      title: "Choose mode",
      bodyLines: [],
      showColumnHeaders: false,
      tableWidth: "content",
      columns: [
        { key: "name", header: "Name" },
        { key: "description", header: "Description" },
      ],
      options: [
        { id: "alpha", label: "Alpha", description: "First option", current: true },
      ],
      selectedOptionIndex: 0,
    })));

    const selectedLine = plain.split("\n").find((line) => line.includes("Alpha"));
    expect(selectedLine).toBeDefined();
    expect(measureVisibleWidth(selectedLine!.trimStart())).toBeLessThan(40);
    expect(selectedLine!.startsWith("  ▸ Alpha")).toBe(true);
    expect(selectedLine).toContain("Current");
  });

  it("caps compact structured prompt-card tables with tableMaxWidth", () => {
    const r = renderer("dark", noColorCaps());
    const plain = stripAnsi(r.renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({
      title: "Choose mode",
      bodyLines: [],
      showColumnHeaders: false,
      tableWidth: "content",
      tableMaxWidth: 36,
      columns: [
        { key: "name", header: "Name" },
        { key: "description", header: "Description" },
      ],
      options: [
        {
          id: "alpha",
          label: "Alpha",
          description: "This long description should be capped by compact table max width.",
        },
      ],
      selectedOptionIndex: 0,
    })));

    const selectedLine = plain.split("\n").find((line) => line.includes("Alpha"));
    expect(selectedLine).toBeDefined();
    expect(measureVisibleWidth(selectedLine!.trimStart())).toBeLessThanOrEqual(36);
    expect(selectedLine).toContain("...");
  });

  it("physically aligns compact structured prompt-card tables", () => {
    const r = renderer("dark", noColorCaps());
    const base = {
      title: "Choose mode",
      bodyLines: [],
      showColumnHeaders: false,
      tableWidth: "content" as const,
      tableMaxWidth: 36,
      columns: [
        { key: "name", header: "Name" },
        { key: "description", header: "Description" },
      ],
      options: [
        { id: "alpha", label: "Alpha", description: "First option" },
      ],
      selectedOptionIndex: 0,
    };
    const lineFor = (tableAlign: "left" | "center" | "right") => {
      const plain = stripAnsi(r.renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({ ...base, tableAlign })));
      return plain.split("\n").find((line) => line.includes("Alpha")) ?? "";
    };

    const left = lineFor("left");
    const center = lineFor("center");
    const right = lineFor("right");
    expect(left.indexOf("▸")).toBe(2);
    expect(center.indexOf("▸")).toBeGreaterThan(left.indexOf("▸"));
    expect(right.indexOf("▸")).toBeGreaterThan(center.indexOf("▸"));
  });

  it("renders explicit RTL structured prompt-card rows in declared physical column order", () => {
    const r = renderer("dark", noColorCaps());
    const plain = stripAnsi(r.renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({
      title: "اختر الوضع",
      bodyLines: ["اختر وضعًا عامًا."],
      showColumnHeaders: false,
      tableDirection: "rtl",
      columns: [
        { key: "description", header: "التفاصيل", align: "right" },
        { key: "name", header: "الاسم", align: "right" },
      ],
      options: [
        {
          id: "alpha",
          label: "ألفا",
          cells: { description: `خيار عام مع ${isolateLtr("CLI")} مستقر.`, name: "ألفا" },
        },
        {
          id: "back",
          label: "رجوع",
          group: "navigation",
          cells: { description: "ارجع إلى الخطوة السابقة.", name: "رجوع" },
        },
      ],
      selectedOptionIndex: 0,
      hint: "↑↓ navigate   ENTER select   CTRL+C exit",
      locale: "ar",
      direction: "rtl",
    })));

    expect(plain).not.toContain("التفاصيل");
    expect(plain).not.toContain("الاسم");
    const selectedLine = plain.split("\n").find((line) => line.includes("ألفا"));
    expect(selectedLine).toBeDefined();
    expect(selectedLine!.indexOf("خيار عام")).toBeLessThan(selectedLine!.indexOf("ألفا"));
    expect(selectedLine!.indexOf("ألفا")).toBeLessThan(selectedLine!.indexOf("◂"));
    expect(stripTrailingBidiControls(selectedLine!.trimEnd()).endsWith("◂")).toBe(true);
    expect(plain).toContain(isolateLtr("CLI"));
    expect(plain).toContain(isolateLtr("↑↓ navigate   ENTER select   CTRL+C exit"));
    const lines = plain.split("\n");
    const backIndex = lines.findIndex((line) => line.includes("رجوع"));
    expect(backIndex).toBeGreaterThan(0);
    expect(lines[backIndex - 1]?.trim()).toBe("");
  });

  it("uses label and description fallback in explicit RTL prompt-card tables", () => {
    const r = renderer("dark", noColorCaps());
    const plain = stripAnsi(r.renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({
      title: "اختر الوضع",
      bodyLines: [],
      showColumnHeaders: false,
      tableDirection: "rtl",
      columns: [
        { key: "description", header: "التفاصيل", align: "right" },
        { key: "name", header: "الاسم", align: "right" },
      ],
      options: [
        {
          id: "alpha",
          label: "ألفا",
          description: "وصف عربي طويل يثبت أن التفاصيل تأخذ المساحة الأكبر.",
        },
      ],
      selectedOptionIndex: 0,
      locale: "ar",
      direction: "rtl",
    })));

    const selectedLine = plain.split("\n").find((line) => line.includes("ألفا"));
    expect(selectedLine).toBeDefined();
    const descriptionIndex = selectedLine!.indexOf("وصف عربي");
    const labelIndex = selectedLine!.indexOf("ألفا");
    expect(descriptionIndex).toBeGreaterThanOrEqual(0);
    expect(labelIndex).toBeGreaterThan(descriptionIndex);
    expect(labelIndex - descriptionIndex).toBeGreaterThan(20);
    const markerIndex = selectedLine!.indexOf("◂");
    expect(markerIndex).toBeGreaterThan(labelIndex);
    expect(markerIndex - labelIndex).toBeLessThan(12);
    expect(stripTrailingBidiControls(selectedLine!.trimEnd()).endsWith("◂")).toBe(true);
  });

  it("keeps Arabic descriptions with technical tokens in the RTL description column", () => {
    const r = renderer("dark", noColorCaps());
    const description = `اضبط كيف تعثر ${isolateLtr("EstaCoda")} على نتائج الويب وتسترجعها.`;
    const plain = stripAnsi(r.renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({
      title: "محرر الإعدادات",
      bodyLines: [],
      showColumnHeaders: false,
      tableDirection: "rtl",
      columns: [
        { key: "description", header: "التفاصيل", align: "right" },
        { key: "name", header: "الاسم", align: "right" },
      ],
      options: [
        {
          id: "search",
          label: "البحث",
          description,
        },
      ],
      selectedOptionIndex: 0,
      locale: "ar",
      direction: "rtl",
    })));

    const selectedLine = plain.split("\n").find((line) => line.includes("البحث"));
    expect(selectedLine).toBeDefined();
    expect(selectedLine).toContain(isolateRtl(closeOpenBidiIsolates(description)));
    expect(selectedLine).not.toContain(isolateLtr(description));
    expect(selectedLine!.indexOf("اضبط كيف")).toBeLessThan(selectedLine!.indexOf("البحث"));
    expect(stripTrailingBidiControls(selectedLine!.trimEnd()).endsWith("◂")).toBe(true);
  });

  it("keeps RTL structured prompt-card markers in one fixed visible column", () => {
    const r = renderer("dark", noColorCaps());
    const base = {
      title: "محرر الإعدادات",
      bodyLines: [],
      showColumnHeaders: false,
      tableDirection: "rtl" as const,
      tableWidth: "content" as const,
      tableMaxWidth: 88,
      tableAlign: "right" as const,
      columns: [
        { key: "description", header: "التفاصيل", align: "left" as const },
        { key: "name", header: "الاسم", align: "right" as const },
      ],
      options: [
        {
          id: "primary",
          label: "النموذج الأساسي",
          description: "النموذج الافتراضي الذي يستخدمه الوكيل.",
        },
        {
          id: "security",
          label: "وضع الأمان",
          description: "سياسة المراجعة للإجراءات عالية المخاطر.",
        },
        {
          id: "diagnostics",
          label: "التشخيصات",
          description: "اعرض العوائق، والتحذيرات، والحالة المكتشفة.",
        },
      ],
      locale: "ar" as const,
      direction: "rtl" as const,
    };
    const markerLineFor = (selectedOptionIndex: number) => {
      const plain = stripAnsi(r.renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({
        ...base,
        selectedOptionIndex,
      })));
      return plain.split("\n").find((line) => line.includes("◂")) ?? "";
    };

    const firstMarkerColumn = visibleMarkerColumn(markerLineFor(0), "◂");
    const lastMarkerColumn = visibleMarkerColumn(markerLineFor(2), "◂");
    expect(lastMarkerColumn).toBe(firstMarkerColumn);
  });

  it("renders Arabic setup-editor style RTL rows as physical cells without a row-level LTR isolate", () => {
    const r = renderer("dark", noColorCaps());
    const base = {
      title: "محرّر الإعدادات",
      bodyLines: ["اختار اللي تحب تضبطه:"],
      showColumnHeaders: false,
      tableDirection: "rtl" as const,
      tableWidth: "content" as const,
      tableMaxWidth: 88,
      tableAlign: "right" as const,
      columns: [
        { key: "description", header: "التفاصيل", align: "left" as const },
        { key: "name", header: "الاسم", align: "right" as const },
      ],
      options: [
        {
          id: "primary",
          label: "النموذج الأساسي",
          description: "النموذج الافتراضي الذي يستخدمه الوكيل.",
        },
        {
          id: "fallback",
          label: "النماذج الاحتياطية",
          description: "نماذج احتياطية تُستخدم إذا فشل النموذج الأساسي.",
        },
        {
          id: "auxiliary",
          label: "النماذج المساعدة",
          description: "نماذج تُستخدم للتقييم، والضغط، والاستدعاء، والذاكرة.",
        },
        {
          id: "channels",
          label: "القنوات",
          description: `قنوات تحكم عن بُعد مثل ${isolateLtr("Telegram")} و${isolateLtr("WhatsApp")}.`,
        },
        {
          id: "search",
          label: "البحث",
          description: `اضبط كيف تعثر ${isolateLtr("EstaCoda")} على نتائج الويب وتسترجعها.`,
        },
        {
          id: "evolution",
          label: isolateLtr("Agent Evolution"),
          description: "مقترحات تحسين ذاتي قابلة للمراجعة.",
        },
        {
          id: "exit",
          label: "الخروج دون تغييرات",
          description: "غادر الإعداد دون تعديل التكوين.",
          group: "navigation" as const,
        },
      ],
      locale: "ar" as const,
      direction: "rtl" as const,
    };
    const renderedFor = (selectedOptionIndex: number) => stripAnsi(r.renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({
      ...base,
      selectedOptionIndex,
    })));
    const markerLineFor = (selectedOptionIndex: number) =>
      renderedFor(selectedOptionIndex).split("\n").find((line) => line.includes("◂")) ?? "";

    const auxiliaryLine = markerLineFor(2);
    expect(auxiliaryLine.trimStart().startsWith(LRI)).toBe(true);
    expect(countBidiControl(auxiliaryLine, LRI)).toBeGreaterThanOrEqual(3);
    expect(auxiliaryLine.indexOf("نماذج تُستخدم")).toBeLessThan(auxiliaryLine.indexOf("النماذج المساعدة"));
    expect(stripTrailingBidiControls(auxiliaryLine.trimEnd()).endsWith("◂")).toBe(true);

    const searchLine = markerLineFor(4);
    expect(searchLine).toContain(isolateLtr("EstaCoda"));
    expect(searchLine.indexOf("اضبط كيف")).toBeLessThan(searchLine.indexOf("البحث"));
    expect(visibleMarkerColumn(searchLine, "◂")).toBe(visibleMarkerColumn(auxiliaryLine, "◂"));
    expect(visibleTextStartColumn(searchLine, "اضبط كيف")).toBe(visibleTextStartColumn(auxiliaryLine, "نماذج تُستخدم"));
    expect(visibleTextEndColumn(searchLine, "البحث")).toBe(visibleTextEndColumn(auxiliaryLine, "النماذج المساعدة"));

    const evolutionLine = markerLineFor(5);
    expect(evolutionLine).toContain(isolateLtr("Agent Evolution"));
    expect(evolutionLine.indexOf("مقترحات تحسين")).toBeLessThan(evolutionLine.indexOf("Agent Evolution"));
    expect(visibleMarkerColumn(evolutionLine, "◂")).toBe(visibleMarkerColumn(auxiliaryLine, "◂"));
    expect(visibleTextStartColumn(evolutionLine, "مقترحات تحسين")).toBe(visibleTextStartColumn(auxiliaryLine, "نماذج تُستخدم"));
    expect(visibleTextEndColumn(evolutionLine, "Agent Evolution")).toBe(visibleTextEndColumn(auxiliaryLine, "النماذج المساعدة"));

    const channelLine = renderedFor(2).split("\n").find((line) => line.includes("Telegram"));
    expect(channelLine).toContain(isolateLtr("Telegram"));
    expect(channelLine).toContain(isolateLtr("WhatsApp"));
  });

  it("keeps narrow Arabic setup-editor rows bounded with technical tokens and Unicode clusters", () => {
    const caps = { ...fullCaps(), supportsColor: false, supportsTrueColor: false, terminalWidth: 56 };
    const r = new StandardRenderer({ tokens: resolveTokens("standard", "dark", "kemetBlue"), capabilities: caps, locale: "ar" });
    const plain = stripAnsi(r.renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({
      title: "محرّر الإعدادات",
      bodyLines: ["راجع القيم قبل الحفظ."],
      showColumnHeaders: false,
      tableDirection: "rtl",
      tableWidth: "content",
      tableMaxWidth: 50,
      tableAlign: "right",
      columns: [
        { key: "description", header: "التفاصيل", align: "right" },
        { key: "name", header: "الاسم", align: "right" },
      ],
      options: [
        {
          id: "route",
          label: "المزوّد الأساسي",
          description: `استخدم ${isolateLtr("OPENAI_API_KEY")} مع ${isolateLtr("openrouter/kimi-k2.6")}.`,
        },
        {
          id: "endpoint",
          label: "نقطة النهاية",
          description: `اختبر ${isolateLtr("https://api.example.test/v1")} قبل الحفظ.`,
        },
        {
          id: "unicode",
          label: "فحص Unicode",
          description: `يعرض 👩🏽‍💻 و${isolateLtr("表")} وCafe\u0301 بدون كسر القياس.`,
        },
      ],
      selectedOptionIndex: 2,
      locale: "ar",
      direction: "rtl",
    })));

    expect(plain).toContain(isolateLtr("OPENAI_API_KEY"));
    expect(plain).toContain("open...");
    expect(plain).not.toContain(isolateLtr("openrouter/kimi-k2.6"));
    expect(plain).toContain("https://api.example.tes...");
    expect(plain).toContain("👩🏽‍💻");
    expect(plain).toContain(isolateLtr("表"));
    expect(plain).toContain("Cafe\u0301");
    const selectedLine = plain.split("\n").find((line) => line.includes("فحص Unicode"));
    expect(selectedLine).toBeDefined();
    expect(selectedLine).toContain("👩🏽‍💻");
    expect(stripTrailingBidiControls(selectedLine!.trimEnd()).endsWith("◂")).toBe(true);
    expectBalancedBidiIsolates(plain);
    for (const line of plain.split("\n")) {
      expect(measureVisibleWidth(line)).toBeLessThanOrEqual(caps.terminalWidth);
    }
  });

  it("keeps explicit RTL structured prompt-card rows bounded with no Unicode fallback", () => {
    const r = renderer("dark", { ...narrowCaps(), supportsUnicode: false });
    const plain = stripAnsi(r.renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({
      title: "اختر الوضع",
      bodyLines: ["اختر وضعًا عامًا."],
      tableDirection: "rtl",
      columns: [
        { key: "description", header: "التفاصيل", align: "right" },
        { key: "name", header: "الاسم", align: "right" },
      ],
      options: [
        {
          id: "alpha",
          label: "ألفا طويلة",
          cells: {
            description: "وصف عربي طويل يجب أن يظل داخل عرض الطرفية الضيق دون إفساد الصف.",
            name: "ألفا طويلة",
          },
        },
      ],
      selectedOptionIndex: 0,
      locale: "ar",
      direction: "rtl",
    })));

    const selectedLine = plain.split("\n").find((line) => line.includes("ألفا"));
    expect(selectedLine).toBeDefined();
    expect(stripTrailingBidiControls(selectedLine!.trimEnd()).endsWith("<")).toBe(true);
    expect(plain).not.toContain("▸");
    for (const line of plain.split("\n")) {
      expect(measureVisibleWidth(line)).toBeLessThanOrEqual(narrowCaps().terminalWidth);
    }
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
      bodyLines: ["هل تثق بمساحة العمل هذه؟", `يمكن لـ ${isolateLtr("EstaCoda")} قراءة ملفات المشروع وطلب الموافقة قبل الإجراءات الخطرة.`],
      technicalLines: ["/workspace", "KIMI_API_KEY", "kimi-k2", "openrouter"],
      options: [
        { id: "trust", label: "ثق بمساحة العمل", description: "اسمح بالعمل المحلي هنا." },
        { id: "skip", label: "ليس الآن", description: "ارجع لاحقًا." },
      ],
      selectedOptionIndex: 0,
      locale: "ar",
      direction: "rtl",
    }));

    const plain = stripAnsi(out);
    const topLine = plain.split("\n")[0] ?? "";
    expect(plain).toContain(isolateRtl("الثقة بمساحة العمل  𓂀"));
    expect(topLine).not.toContain(`╭──── ${isolateRtl("الثقة بمساحة العمل  𓂀")}`);
    expect(topLine.indexOf(isolateRtl("الثقة بمساحة العمل  𓂀"))).toBeGreaterThan(4);
    expect(plain).toContain(`${isolateRtl("ثق بمساحة العمل")} ▸`);
    expect(plain).not.toContain(`▸ ${isolateRtl("ثق بمساحة العمل")}`);
    const optionLine = plain.split("\n").find((line) => line.includes(isolateRtl("ثق بمساحة العمل")));
    const descriptionLine = plain.split("\n").find((line) => line.includes(isolateRtl("اسمح بالعمل المحلي هنا.")));
    expect(optionLine).toBeDefined();
    const optionLabelIndex = optionLine!.indexOf(isolateRtl("ثق بمساحة العمل"));
    const optionMarkerIndex = optionLine!.indexOf("▸");
    expect(optionLabelIndex).toBeGreaterThanOrEqual(0);
    expect(optionMarkerIndex).toBeGreaterThan(optionLabelIndex);
    expect(descriptionLine).toMatch(/^\s{4,}/u);
    expect(out).toContain(isolateLtr("EstaCoda"));
    expect(out).toContain(isolateLtr("/workspace"));
    expect(out).toContain(isolateLtr("KIMI_API_KEY"));
    expect(out).toContain(isolateLtr("kimi-k2"));
    expect(out).toContain(isolateLtr("openrouter"));
  });

  it("keeps Arabic structured prompt-card marker placement stable", () => {
    const r = new StandardRenderer({ tokens: resolveTokens("standard", "dark", "kemetBlue"), capabilities: fullCaps(), locale: "ar" });
    const plain = stripAnsi(r.renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({
      title: "اختر الوضع",
      bodyLines: ["اختر وضعًا عامًا."],
      columns: [
        { key: "name", header: "الاسم" },
        { key: "description", header: "الوصف" },
      ],
      options: [
        {
          id: "alpha",
          label: "ألفا",
          cells: { name: "ألفا", description: `خيار عام مع ${isolateLtr("CLI")} مستقر.` },
          current: true,
        },
        {
          id: "beta",
          label: "بيتا",
          cells: { name: "بيتا", description: "خيار عام آخر." },
        },
      ],
      selectedOptionIndex: 0,
      locale: "ar",
      direction: "rtl",
    })));

    const selectedLine = plain.split("\n").find((line) => line.includes("ألفا"));
    expect(selectedLine).toBeDefined();
    expect(selectedLine!.trimStart().startsWith("▸ ")).toBe(true);
    expect(selectedLine!.indexOf("▸")).toBeLessThan(selectedLine!.indexOf("ألفا"));
    expect(plain).toContain(isolateLtr("CLI"));
  });

  it("renders Arabic prompt-card hints as LTR technical text", () => {
    const r = new StandardRenderer({ tokens: resolveTokens("standard", "dark", "kemetBlue"), capabilities: fullCaps(), locale: "ar" });
    const plain = stripAnsi(r.renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({
      title: "اختر الوضع",
      bodyLines: ["اختر وضعًا عامًا."],
      options: [{ id: "alpha", label: "ألفا" }],
      selectedOptionIndex: 0,
      hint: "↑↓ navigate   ENTER select   CTRL+C exit",
      locale: "ar",
      direction: "rtl",
    })));

    const hint = isolateLtr("↑↓ navigate   ENTER select   CTRL+C exit");
    const hintLine = plain.split("\n").find((line) => line.includes(hint));
    expect(hintLine).toBeDefined();
    expect(hintLine!.trim()).toBe(hint);
    expect(hintLine).toMatch(/^  /u);
    expect(hintLine!.indexOf(hint)).toBe(2);
  });

  it("right-aligns English prompt-card hints", () => {
    const r = new StandardRenderer({ tokens: resolveTokens("standard", "dark", "kemetBlue"), capabilities: fullCaps(), locale: "en" });
    const hint = "↑↓ navigate   ENTER select   CTRL+C exit";
    const plain = stripAnsi(r.renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({
      title: "Choose mode",
      bodyLines: ["Pick a mode from this wider prompt card so hint alignment is visible."],
      options: [{ id: "alpha", label: "Alpha" }],
      selectedOptionIndex: 0,
      hint,
      locale: "en",
      direction: "ltr",
    })));

    const hintLine = plain.split("\n").find((line) => line.includes(hint));
    expect(hintLine).toBeDefined();
    expect(hintLine!.trim()).toBe(hint);
    expect(hintLine!.indexOf(hint)).toBeGreaterThan(2);
  });

  it("renders Arabic onboarding selected marker after the label without Unicode", () => {
    const r = new StandardRenderer({ tokens: resolveTokens("standard", "dark", "kemetBlue"), capabilities: noUnicodeCaps(), locale: "ar" });
    const plain = stripAnsi(r.renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({
      title: "الثقة بمساحة العمل",
      bodyLines: ["هل تثق بمساحة العمل هذه؟"],
      options: [
        { id: "trust", label: "ثق بمساحة العمل" },
        { id: "skip", label: "ليس الآن" },
      ],
      selectedOptionIndex: 0,
      locale: "ar",
      direction: "rtl",
    })));

    expect(plain).toContain(`${isolateRtl("ثق بمساحة العمل")} >`);
    expect(plain).not.toContain(`> ${isolateRtl("ثق بمساحة العمل")}`);
    expect(plain).not.toContain("<");
    expect(plain).not.toContain("◂");
  });

  it("keeps Arabic prompt-card markers after mixed-direction voice option labels", () => {
    const caps = { ...fullCaps(), terminalWidth: 64 };
    const r = new StandardRenderer({ tokens: resolveTokens("standard", "dark", "kemetBlue"), capabilities: caps, locale: "ar" });
    const plain = stripAnsi(r.renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({
      title: "اضبط الصوت",
      bodyLines: ["اختر مزوّد الصوت الذي تريد ضبطه."],
      options: [
        {
          id: "voice-stt",
          label: `اضبط مزوّد تحويل الكلام إلى نص (${isolateLtr("STT")})`,
          description: "اضبط مزوّد تحويل الكلام إلى نص فقط.",
        },
        {
          id: "voice-tts",
          label: `اضبط مزوّد تحويل النص إلى كلام (${isolateLtr("TTS")})`,
          description: "اضبط مزوّد تحويل النص إلى كلام فقط.",
        },
      ],
      selectedOptionIndex: 0,
      locale: "ar",
      direction: "rtl",
    })));

    const selectedLine = plain.split("\n").find((line) => line.includes(isolateLtr("STT")));
    expect(selectedLine).toBeDefined();
    expect(selectedLine).not.toContain("...");
    expect(selectedLine!.indexOf("▸")).toBeGreaterThan(selectedLine!.indexOf("اضبط"));
    expect(plain).toContain(isolateLtr("TTS"));
    for (const line of plain.split("\n")) {
      expect(measureVisibleWidth(line)).toBeLessThanOrEqual(caps.terminalWidth);
    }
  });

  it("keeps English no-Unicode onboarding selected marker before the label", () => {
    const r = renderer("dark", noUnicodeCaps());
    const plain = stripAnsi(r.renderOnboardingPromptCard(onboardingTrustCard()));

    expect(plain).toContain("> Trust workspace");
    expect(plain).not.toContain("Trust workspace <");
  });

  it("wraps long Arabic onboarding option descriptions without truncating technical tokens", () => {
    const caps = { ...fullCaps(), terminalWidth: 64 };
    const r = new StandardRenderer({ tokens: resolveTokens("standard", "dark", "kemetBlue"), capabilities: caps, locale: "ar" });
    const out = r.renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({
      title: "تعلّم المهارات",
      bodyLines: ["اختر طريقة التعلّم."],
      options: [
        {
          id: "enabled",
          label: "فعّل التعلّم",
          description: `يسمح هذا الخيار لـ ${isolateLtr("EstaCoda")} بتعلّم مهارات قابلة لإعادة الاستخدام من الأنماط المتكررة في العمل اليومي.`,
        },
      ],
      selectedOptionIndex: 0,
      locale: "ar",
      direction: "rtl",
    }));
    const plain = stripAnsi(out);
    const descriptionLines = plain
      .split("\n")
      .filter((line) => line.includes("يسمح") || line.includes("إعادة") || line.includes("الأنماط"));

    expect(descriptionLines.length).toBeGreaterThan(1);
    expect(plain).not.toContain("...");
    expect(out).toContain(isolateLtr("EstaCoda"));
    for (const line of plain.split("\n")) {
      expect(measureVisibleWidth(line)).toBeLessThanOrEqual(caps.terminalWidth);
    }
    for (const line of descriptionLines) {
      expect(line).toMatch(/^\s{2,}/u);
    }
  });

  it("renders Arabic numbered onboarding body rows with controlled marker placement", () => {
    const r = new StandardRenderer({ tokens: resolveTokens("standard", "dark", "kemetBlue"), capabilities: fullCaps(), locale: "ar" });
    const out = r.renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({
      title: `ضبط ${isolateLtr("Telegram")}`,
      bodyLines: [
        `ربط بوت ${isolateLtr("Telegram")}`,
        `يمكن لـ ${isolateLtr("EstaCoda")} تلقّي الأوامر من ${isolateLtr("Telegram")} بعد ربط بوت. اتبع الخطوات التالية:`,
        `1. افتح ${isolateLtr("Telegram")} وابحث عن الحساب الرسمي ${isolateLtr("@BotFather")}. استخدم الحساب الموثّق بعلامة التحقق الزرقاء.`,
        `2. أرسل الأمر ${isolateLtr("/newbot")} واتبع تعليمات ${isolateLtr("BotFather")} لإنشاء بوت إذا لم يكن لديك بوت بالفعل.`,
        `3. انسخ رمز ${isolateLtr("API")} الذي يرسله لك ${isolateLtr("BotFather")}.`,
      ],
      options: [],
      selectedOptionIndex: 0,
      locale: "ar",
      direction: "rtl",
    }));

    const plain = stripAnsi(out);
    expectBalancedBidiIsolates(plain);
    expect(plain).toContain(isolateLtr("Telegram"));
    expect(plain).toContain(isolateLtr("@BotFather"));
    expect(plain).toContain(isolateLtr("/newbot"));
    expect(plain).toContain(isolateLtr("API"));
    expect(plain).toContain(isolateLtr("1."));
    expect(plain).toContain(isolateLtr("2."));
    expect(plain).toContain(isolateLtr("3."));

    const numberedRows = plain.split("\n").filter((line) => /\d\./u.test(line));
    expect(numberedRows.length).toBeGreaterThanOrEqual(3);
    for (const row of numberedRows) {
      expect(row).not.toMatch(/^\s*\d+\.\s+[\u0600-\u06FF]/u);
      expect(measureVisibleWidth(row)).toBeLessThanOrEqual(fullCaps().terminalWidth);
    }
    for (const line of plain.split("\n")) {
      expect(measureVisibleWidth(line)).toBeLessThanOrEqual(fullCaps().terminalWidth);
    }
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
      taglines: ["⟡ SIFR01 ⟡"],
      model: { provider: "p", id: "i" },
      readiness: "ready",
    });
    const out = r.renderStartup(vm);
    expect(out).toContain("EstaCoda");
    expect(out).toContain("⟡ SIFR01 ⟡");
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
      workflowAvailable: false,
      workflowRunActive: false,
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
      workflowAvailable: false,
      workflowRunActive: false,
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
      workflowAvailable: false,
      workflowRunActive: false,
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
      workflowAvailable: false,
      workflowRunActive: false,
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
      workflowAvailable: false,
      workflowRunActive: false,
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
      workflowAvailable: false,
      workflowRunActive: false,
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
      taglines: ["⟡ SIFR01 ⟡"],
      model: { provider: "p", id: "i" },
      readiness: "ready",
    });
    const out = r.renderStartup(vm);
    expect(out).toContain("EstaCoda");
    expect(out).toContain("⟡ SIFR01 ⟡");
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
      taglines: ["⟡ SIFR01 ⟡", "السيادة التكنولوجية العربية"],
      version: "v0.0.5",
      sessionId: "4c6d7f55-7e8b-4f4f-8f39-111111111111",
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
    expect(out).toContain("⟡ SIFR01 ⟡");
    expect(out).toContain("v0.0.5");
    expect(out).toContain("session 4c6d7f55");
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
    expect(stripAnsi(out)).not.toContain("│");
    const top = stripAnsi(out).split("\n").find((line) => line.startsWith("╭"));
    expect(top).toContain(" v0.0.5  𓂀  session 4c6d7f55 ");
    expect(top).not.toContain("4c6d7f55-7e8b-4f4f-8f39-111111111111");
    expect(top).not.toContain("─v0.0.5");
    for (const line of stripAnsi(out).split("\n")) {
      expect(measureVisibleWidth(line)).toBeLessThanOrEqual(fullCaps().terminalWidth);
    }
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
      taglines: ["⟡ SIFR01 ⟡"],
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
      taglines: ["⟡ SIFR01 ⟡"],
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
    expect(out).not.toContain("𓂀");
    expect(out).toContain("v0.0.5  *  session sess-abc");
  });

  it("keeps startup dashboard border styling isolated when title truncates", () => {
    const tokens = resolveTokens("standard", "dark", "kemetBlue");
    const r = new StandardRenderer({ tokens, capabilities: narrowCaps() });
    const vm = buildStartupDashboardViewModel({
      agentName: "EstaCoda",
      taglines: [],
      version: "v0.0.5-build-that-is-long-enough-to-truncate",
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
    expect(top).toMatch(new RegExp(`\\.\\.\\. \\x1b\\[0m\\x1b\\[0m${escapeRegExp(ansiFgForHex(tokens.contract.surface.border))}─*╮`));
  });

  it("renders Arabic dashboard chrome and isolates startup technical tokens", () => {
    const r = new StandardRenderer({ tokens: resolveTokens("standard", "dark", "kemetBlue"), capabilities: fullCaps(), locale: "ar" });
    const vm = buildStartupDashboardViewModel({
      agentName: "EstaCoda",
      taglines: ["⟡ SIFR01 ⟡"],
      version: "v0.0.5",
      sessionId: "sess-9f7a2c1b",
      model: { provider: "openrouter", id: "deepseek-reasoner" },
      workspaceTrust: "trusted",
      workspaceVerification: "verified",
      workspaceDirectory: "/workspace",
      securityMode: "open",
      skillAutonomy: "autonomous",
      providerReadiness: "ready",
      versionStatus: "update-available",
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
    expect(out).toContain(isolateLtr("v0.0.5  𓂀  session sess-9f7"));
    expect(out).not.toContain(isolateLtr("sess-9f7a2c1b"));
    expect(out).toContain(isolateLtr("deepseek-reasoner"));
    expect(out).toContain(isolateLtr("/workspace"));
    expect(out).toContain(isolateLtr("open"));
    expect(out).toContain(isolateLtr("autonomous"));
    expect(out).toContain(isolateLtr("update-available"));
    expect(out).toContain(isolateLtr("/tools"));
    expect(out).toContain(isolateLtr("/skills"));
    expect(out).toContain(isolateLtr("/model"));
    expect(out).toContain(isolateLtr("/status"));
    expect(stripAnsi(out)).not.toContain("│");
    const plain = stripAnsi(out);
    const columnHeaderLine = plain.split("\n").find((line) => line.includes("الأوامر التفاعلية:") && line.includes("ثقة مساحة العمل"));
    expect(columnHeaderLine).toBeDefined();
    expect(columnHeaderLine?.indexOf("الأوامر التفاعلية:")).toBeLessThan(columnHeaderLine?.indexOf("ثقة مساحة العمل") ?? 0);
    const commandFactLine = plain.split("\n").find((line) => line.includes("استعرض أدوات التشغيل") && line.includes("حالة تحقق مساحة العمل"));
    expect(commandFactLine).toBeDefined();
    expect(commandFactLine?.indexOf("استعرض أدوات التشغيل")).toBeLessThan(commandFactLine?.indexOf("حالة تحقق مساحة العمل") ?? 0);
    const top = plain.split("\n").find((line) => line.startsWith("╭"));
    const bottom = plain.split("\n").find((line) => line.startsWith("╰"));
    expect(top).toContain(` ${isolateLtr("v0.0.5  𓂀  session sess-9f7")} `);
    expect(bottom).toBeDefined();
    expectBalancedBidiIsolates(plain);
    for (const line of plain.split("\n")) {
      expect(measureVisibleWidth(line)).toBeLessThanOrEqual(fullCaps().terminalWidth);
    }
  });

  it("centers Arabic startup dashboard rows when the title widens the frame", () => {
    const r = new StandardRenderer({ tokens: resolveTokens("standard", "dark", "kemetBlue"), capabilities: fullCaps(), locale: "ar" });
    const vm = buildStartupDashboardViewModel({
      agentName: "EstaCoda",
      taglines: [],
      version: "v0.0.5-build-title-wide-enough-to-drive-the-frame-width",
      sessionId: "session-title-wide",
      model: { provider: "openrouter", id: "i" },
      workspaceTrust: "trusted",
      workspaceVerification: "verified",
      securityMode: "open",
      providerReadiness: "ready",
      availableCommands: [{ name: "/x", description: "س" }],
      warnings: [],
    });
    const lines = stripAnsi(r.renderStartupDashboard(vm)).split("\n");
    const top = lines.find((line) => line.startsWith("╭"));
    const modelLine = lines.find((line) => line.includes("النموذج"));
    expect(top).toBeDefined();
    expect(modelLine).toBeDefined();

    const contentWidth = measureVisibleWidth(top ?? "") - 4;
    const frameRows = lines.filter((line) => !line.startsWith("╭") && !line.startsWith("╰"));
    const rawBlockWidth = Math.max(
      0,
      ...frameRows
        .map((line) => line.trimStart())
        .filter((line) => line.length > 0)
        .map((line) => measureVisibleWidth(line))
    );
    expect(rawBlockWidth).toBeLessThan(contentWidth);

    const modelTextWidth = measureVisibleWidth((modelLine ?? "").trimStart());
    const blockOffset = Math.floor((contentWidth - rawBlockWidth) / 2);
    const expectedLeadingSpaces = 2 + blockOffset + rawBlockWidth - modelTextWidth;
    expect((modelLine ?? "").match(/^ */u)?.[0].length).toBe(expectedLeadingSpaces);
  });

  it("keeps narrow Arabic startup dashboard stacked and bounded", () => {
    const r = new StandardRenderer({ tokens: resolveTokens("standard", "dark", "kemetBlue"), capabilities: narrowCaps(), locale: "ar" });
    const vm = buildStartupDashboardViewModel({
      agentName: "EstaCoda",
      taglines: ["⟡ SIFR01 ⟡"],
      version: "v0.0.5",
      sessionId: "session-id-that-is-long-enough-to-truncate",
      model: { provider: "openrouter", id: "deepseek-reasoner-with-a-long-name" },
      workspaceTrust: "trusted",
      workspaceVerification: "verified",
      workspaceDirectory: "/workspace/with/a/long/path",
      securityMode: "adaptive",
      skillAutonomy: "proactive",
      providerReadiness: "ready",
      versionStatus: "unknown",
      availableCommands: [],
      warnings: [],
    });
    const out = stripAnsi(r.renderStartupDashboard(vm));

    expect(out).toContain("...");
    expect(out).toContain("النموذج");
    expect(out).toContain("ثقة مساحة العمل");
    expect(out).toContain("الأوامر التفاعلية:");
    expect(out).toContain(isolateLtr("v0.0.5  𓂀  session session-"));
    expect(out).not.toContain("│");
    expect(out.split("\n").some((line) => line.includes("الأوامر التفاعلية:") && line.includes("ثقة مساحة العمل"))).toBe(false);
    expectBalancedBidiIsolates(out);
    for (const line of out.split("\n")) {
      expect(measureVisibleWidth(line)).toBeLessThanOrEqual(narrowCaps().terminalWidth);
    }
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
      workflowAvailable: false,
      workflowRunActive: false,
    });
    const a = r.render(vm);
    const b = r.render(vm);
    expect(a).toBe(b);
  });
});

describe("StandardRenderer — assistant response", () => {
  it("renders assistant body with agentMessage color while title remains brand", () => {
    const tokens = resolveTokens("standard", "dark", "kemetBlue");
    const r = new StandardRenderer({ tokens, capabilities: fullCaps() });
    const vm = buildAssistantResponseViewModel({
      label: "𓂀 EstaCoda",
      text: "Hello, body!",
    });
    const out = r.renderAssistantResponse(vm);
    const titleLine = out.split("\n")[1] ?? "";
    const plain = stripAnsi(out);

    expect(titleLine).toContain(ansiFgForHex(tokens.contract.palette.brand));
    expect(stripAnsi(titleLine)).toContain("𓂀  EstaCoda");
    expect(stripAnsi(titleLine)).toContain(" 𓂀  EstaCoda ");
    expect(plain).not.toContain("│");
    expect(plain).toContain("  Hello, body!");
    for (const line of plain.split("\n")) {
      expect(measureVisibleWidth(line)).toBeLessThanOrEqual(fullCaps().terminalWidth);
    }
    expect(out).toContain(`${ansiFgForHex(tokens.contract.text.agentMessage)}Hello, body!`);
  });

  it("keeps Arabic assistant response text directionally stable", () => {
    const r = new StandardRenderer({ tokens: resolveTokens("standard", "dark", "kemetBlue"), capabilities: fullCaps(), locale: "ar" });
    const out = stripAnsi(r.renderAssistantResponse(buildAssistantResponseViewModel({
      label: "𓂀 إستاكودا",
      text: "مرحبا يا إدريس",
    })));

    expect(out).toContain(isolateRtl("𓂀  إستاكودا"));
    expect(out).toContain(isolateRtl("مرحبا يا إدريس"));
    expect(out).not.toContain("│");
    expectBalancedBidiIsolates(out);
  });
});

describe("StandardRenderer — conversation message", () => {
  it("renders assistant message with open horizontal frame and brand title", () => {
    const tokens = resolveTokens("standard", "dark", "kemetBlue");
    const r = new StandardRenderer({ tokens, capabilities: fullCaps() });
    const vm = buildConversationMessageViewModel({
      role: "assistant",
      text: "Hello, world!",
    });
    const out = r.renderConversationMessage(vm);
    // Should contain the Unicode eye symbol and brand name
    expect(out).toContain("𓂀");
    expect(out).toContain("EstaCoda");
    expect(stripAnsi(out).split("\n")[0]).toContain("─ 𓂀 EstaCoda ─");
    // Should have open horizontal frame corners
    expect(out).toContain("╭");
    expect(out).toContain("╮");
    expect(out).toContain("╰");
    expect(out).toContain("╯");
    // Should not have vertical side borders
    expect(out).not.toContain("│");
    // Content should be present, indented by two spaces
    expect(stripAnsi(out)).toContain("  Hello, world!");
    expect(out.split("\n")[0]).toContain(ansiFgForHex(tokens.contract.palette.brand));
    expect(out).toContain(`${ansiFgForHex(tokens.contract.text.agentMessage)}Hello, world!`);
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
    expect(stripAnsi(out).split("\n")[0]).toContain("- * EstaCoda -");
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

  it("keeps Arabic assistant message text directionally stable", () => {
    const r = new StandardRenderer({ tokens: resolveTokens("standard", "dark", "kemetBlue"), capabilities: fullCaps(), locale: "ar" });
    const out = stripAnsi(r.renderConversationMessage(buildConversationMessageViewModel({
      role: "assistant",
      text: "مرحبا يا إدريس",
    })));

    expect(out).toContain(isolateRtl("𓂀 إستاكودا"));
    expect(out).toContain(isolateRtl("مرحبا يا إدريس"));
    expect(out).not.toContain("│");
    expectBalancedBidiIsolates(out);
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
    const tokens = resolveTokens("standard", "dark", "kemetBlue");
    const r = new StandardRenderer({ tokens, capabilities: fullCaps() });
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
    expect(out).toMatch(/\x1b\[1mdeepseek-reasoner\x1b\[0m/u);
    expect(out).toContain("context 32.7k/128k");
    expect(out).toContain("▰ ▰ ▰ ▱ ▱ ▱ ▱ ▱ ▱ ▱ 26%");
    expect(out).toContain("◷ 58s");
    expect(out).toContain("⧖ 5m 12s");
    const { r: sr, g: sg, b: sb } = hexToRgbForTest(tokens.contract.text.secondary);
    expect(out).toContain(`\x1b[38;2;${sr};${sg};${sb}m | context 32.7k/128k`);
    expect(out).not.toContain("idle");
    expect(out.split("\n")).toHaveLength(1);
  });

  it("renders long rail durations as hours and minutes", () => {
    const r = renderer("dark", fullCaps());
    const vm = buildSessionStatusRailViewModel({
      modelLabel: "deepseek-reasoner",
      turnState: "idle",
      sessionElapsedMs: 217 * 60_000,
      currentTurnSeconds: 217 * 60,
      showTurnState: false,
    });
    const out = r.render(vm);

    expect(out).toContain("◷ 3h 37m");
    expect(out).toContain("⧖ 3h 37m");
    expect(out.split("\n")).toHaveLength(1);
  });

  it("renders only the visible model label for fallback-serving state", () => {
    const tokens = resolveTokens("standard", "dark", "kemetBlue");
    const r = new StandardRenderer({ tokens, capabilities: fullCaps() });
    const rendered = r.render(buildSessionStatusRailViewModel({
      modelLabel: "deepseek-v4-pro",
      modelState: "fallback-serving",
      configuredModelLabel: "kimi-k2.7-code",
      servingModelLabel: "deepseek-v4-pro",
      turnState: "idle",
      showTurnState: false,
    }));
    const out = stripAnsi(rendered);

    expect(out).toContain("deepseek-v4-pro");
    expect(out).not.toContain("kimi-k2.7-code");
    expect(out).not.toContain("fallback(");
    expect(out).not.toContain("->");
    expect(rendered).toContain(ansiFgForHex(tokens.contract.severity.warn));
    expect(out.split("\n")).toHaveLength(1);
  });

  it("keeps compact fallback-serving rails bounded without verbose fallback text", () => {
    const compactCaps = { ...fullCaps(), terminalWidth: 56 };
    const r = renderer("dark", compactCaps);
    const out = stripAnsi(r.render(buildSessionStatusRailViewModel({
      modelLabel: "deepseek-v4-pro",
      modelState: "fallback-serving",
      configuredModelLabel: "kimi-k2.7-code",
      servingModelLabel: "deepseek-v4-pro",
      turnState: "idle",
    })));

    expect(out).toContain("deepseek-v4-pro");
    expect(out).not.toContain("fallback(");
    expect(out).not.toContain("kimi-k2.7-code");
    expect(out).not.toContain("->");
    expect(out.split("\n")).toHaveLength(1);
    expect(measureVisibleWidth(out)).toBeLessThanOrEqual(compactCaps.terminalWidth);
  });

  it("renders status and shortcut rails in standard light theme", () => {
    const r = renderer("light", fullCaps());
    const status = r.render(buildSessionStatusRailViewModel({ modelLabel: "deepseek-reasoner", turnState: "idle" }));
    const shortcuts = r.render(buildShortcutHintRailViewModel({ hints: [] }));

    expect(status).toContain("deepseek-reasoner");
    expect(status).toContain("idle");
    expect(status.split("\n")).toHaveLength(1);
    expect(shortcuts).toContain("/help · /tools · /model · /status · /compact · Ctrl+C exit");
    expect(shortcuts.split("\n")).toHaveLength(1);
    expect(hasAnsi(status)).toBe(true);
    expect(hasAnsi(shortcuts)).toBe(true);
  });

  it("keeps narrow status and shortcut rails bounded to one line", () => {
    const r = renderer("dark", narrowCaps());
    const rawStatus = r.render(buildSessionStatusRailViewModel({
      modelLabel: "openrouter/deepseek-reasoner-with-a-very-long-route-name",
      turnState: "running",
      contextUsage: { filled: 98765, total: 128000 },
      sessionElapsedMs: 125000,
    }));
    const status = stripAnsi(rawStatus);
    const shortcuts = stripAnsi(r.render(buildShortcutHintRailViewModel({ hints: [] })));

    for (const out of [status, shortcuts]) {
      const lines = out.split("\n");
      expect(lines).toHaveLength(1);
      expect(measureVisibleWidth(lines[0] ?? "")).toBeLessThanOrEqual(40);
    }
    expect(rawStatus).toMatch(/\x1b\[0m$/u);
    expect(status).toContain("...");
    expect(shortcuts).toContain("...");
  });

  it("renders shortcut hint rail with chrome copy", () => {
    const r = renderer("dark", fullCaps());
    const vm = buildShortcutHintRailViewModel({ hints: [] });
    const out = r.render(vm);
    expect(out).toContain("/help · /tools · /model · /status · /compact · Ctrl+C exit");
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

  it("renders Arabic session status rail in English-like slot order", () => {
    const r = new StandardRenderer({ tokens: resolveTokens("standard", "dark", "kemetBlue"), capabilities: fullCaps(), locale: "ar" });
    const out = stripAnsi(r.render(buildSessionStatusRailViewModel({
      modelLabel: "kimi-k2.6",
      turnState: "idle",
      contextUsage: { filled: 0, total: 262000 },
      sessionElapsedMs: 251000,
    })));
    const expected = isolateLtr(`𓂀  ${isolateLtr("kimi-k2.6")} | ${isolateRtl("السياق")} ${isolateLtr("0/262k")} | ▱ ▱ ▱ ▱ ▱ ▱ ▱ ▱ ▱ ▱ 0% | ${isolateLtr("◷ 4د 11ث")} | ${isolateRtl("خامل")}`);

    expect(out).toContain(expected);
    expect(out).not.toContain("4m 11s");
    expect(out.indexOf(isolateLtr("kimi-k2.6"))).toBeLessThan(out.indexOf(isolateRtl("السياق")));
    expect(out.indexOf(isolateRtl("السياق"))).toBeLessThan(out.indexOf("▱ ▱ ▱"));
    expect(out.indexOf("▱ ▱ ▱")).toBeLessThan(out.indexOf(isolateLtr("◷ 4د 11ث")));
    expect(out.indexOf(isolateLtr("◷ 4د 11ث"))).toBeLessThan(out.indexOf(isolateRtl("خامل")));
    expect(measureVisibleWidth(out)).toBeLessThanOrEqual(fullCaps().terminalWidth);
    expect(out.split("\n")).toHaveLength(1);
    expectBalancedBidiIsolates(out);
  });

  it("renders Arabic active turn timer before the localized running state", () => {
    const r = new StandardRenderer({ tokens: resolveTokens("standard", "dark", "kemetBlue"), capabilities: fullCaps(), locale: "ar" });
    const out = stripAnsi(r.render(buildSessionStatusRailViewModel({
      modelLabel: "kimi-k2.6",
      turnState: "running",
      sessionElapsedMs: 86_000,
      currentTurnSeconds: 12,
    })));

    expect(out).toContain(isolateLtr(`𓂀  ${isolateLtr("kimi-k2.6")} | ${isolateLtr("◷ 1د 26ث")} | ${isolateLtr("⧖ 12ث")} | ${isolateRtl("شغال")}`));
    expect(out).not.toContain("1m 26s");
    expect(out).not.toContain("12s");
    expect(out.indexOf(isolateLtr("◷ 1د 26ث"))).toBeLessThan(out.indexOf(isolateLtr("⧖ 12ث")));
    expect(out.indexOf(isolateLtr("⧖ 12ث"))).toBeLessThan(out.indexOf(isolateRtl("شغال")));
    expect(out.split("\n")).toHaveLength(1);
    expectBalancedBidiIsolates(out);
  });

  it("wraps Arabic shortcut rail text while isolating command tokens", () => {
    const r = new StandardRenderer({ tokens: resolveTokens("standard", "dark", "kemetBlue"), capabilities: fullCaps(), locale: "ar" });
    const out = stripAnsi(r.render(buildShortcutHintRailViewModel({ hints: [] })));

    expect(out).toContain(isolateLtr("/help"));
    expect(out).toContain(isolateLtr("Ctrl+C"));
    expect(out).toContain("خروج");
    expect(out).toContain("\u2067");
    expect(out).toContain("\u2069");
    expect(out.split("\n")).toHaveLength(1);
  });

  it("keeps truncated Arabic prompt rails bidi-balanced", () => {
    const caps = { ...fullCaps(), terminalWidth: 48 };
    const r = new StandardRenderer({ tokens: resolveTokens("standard", "dark", "kemetBlue"), capabilities: caps, locale: "ar" });
    const status = stripAnsi(r.render(buildSessionStatusRailViewModel({
      modelLabel: "openrouter/kimi-k2.6-with-a-very-long-route-name",
      turnState: "idle",
      contextUsage: { filled: 98765, total: 128000 },
      sessionElapsedMs: 251000,
    })));
    const shortcuts = stripAnsi(r.render(buildShortcutHintRailViewModel({ hints: [] })));

    for (const out of [status, shortcuts]) {
      expect(out.split("\n")).toHaveLength(1);
      expect(measureVisibleWidth(out)).toBeLessThanOrEqual(caps.terminalWidth);
      expect(out).toContain("...");
      expectBalancedBidiIsolates(out);
    }
  });

  it("renders user prompt rail with Unicode marker", () => {
    const tokens = resolveTokens("standard", "dark", "kemetBlue");
    const r = renderer("dark", fullCaps());
    const vm = buildUserPromptRailViewModel({ text: "Hello, world!" });
    const out = r.render(vm);
    expect(stripAnsi(out)).toBe("↳ Hello, world!");
    expect(out).toContain(ansiBgForHex(tokens.contract.surface.bgElevated));
  });

  it("renders user prompt rail with ASCII fallback when Unicode is disabled", () => {
    const tokens = resolveTokens("standard", "dark", "kemetBlue");
    const r = renderer("dark", noUnicodeCaps());
    const vm = buildUserPromptRailViewModel({ text: "Hello, world!" });
    const out = r.render(vm);
    expect(stripAnsi(out)).toBe("> Hello, world!");
    expect(out).toContain(ansiBgForHex(tokens.contract.surface.bgElevated));
  });

  it("renders user prompt rail within narrow terminal width", () => {
    const r = renderer("dark", narrowCaps());
    const vm = buildUserPromptRailViewModel({ text: "This is a very long user prompt that should be truncated to fit within the narrow terminal width of forty characters" });
    const out = r.render(vm);
    const lines = out.split("\n");
    expect(lines.length).toBeGreaterThan(1);
    expect(lines[0]).toContain("↳");
    expect(lines.every((line) => measureVisibleWidth(line) <= 40)).toBe(true);
  });

  it("produces no ANSI for user prompt rail in no-color mode", () => {
    const r = renderer("dark", noColorCaps());
    const vm = buildUserPromptRailViewModel({ text: "Plain text" });
    const out = r.render(vm);
    assertNoAnsi(out);
    expect(out).toBe("↳ Plain text");
  });

  it("renders multiline user prompt rail with indented continuations", () => {
    const r = renderer("dark", fullCaps());
    const vm = buildUserPromptRailViewModel({ text: "line one\nline two" });
    const out = r.render(vm);
    expect(stripAnsi(out)).toBe("↳ line one\n  line two");
  });

  it("renders active turn spinner with brand eye and localized label", () => {
    const r = renderer("dark", { ...fullCaps(), supportsAnimation: false });
    const vm = buildActiveTurnSpinnerViewModel({ phase: "thinking" });
    const out = stripAnsi(r.render(vm));
    expect(out).toContain("⣾⣷");
    expect(out).not.toContain("𓇠");
    expect(out).toContain("contemplating");
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

  it("renders running tool activity with tokenized tool spinner", () => {
    const r = renderer("dark", { ...fullCaps(), supportsAnimation: false });
    const vm = buildToolActivityRailViewModel({
      events: [toolActivityRailEvent("readFile", "running", { label: "preparing" })],
    });
    const out = stripAnsi(r.render(vm));
    expect(out).toContain("⣾⣷");
    expect(out).not.toContain("𓇠");
    expect(out).toContain("preparing");
  });
});
