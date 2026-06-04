import { describe, it, expect } from "vitest";
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
import {
  renderPlain,
  renderPlainFallback,
  renderWarningError,
  renderKeyValueBlock,
  renderList,
  renderOnboardingPromptCard,
  renderTable,
  renderApprovalSecurity,
  renderActivityTimeline,
  renderProgressRail,
  renderPicker,
  renderStartup,
  renderStatus,
  renderCommandResult,
  renderAssistantResponse,
  renderStartupDashboard,
  renderConversationMessage,
  renderSessionStatusRail,
  renderShortcutHintRail,
  renderUserPromptRail,
  renderActiveTurnSpinner,
  renderFileChangePreview,
} from "./plain-renderer.js";
import { isolateLtr, isolateRtl, RLI } from "../bidi.js";
import { measureVisibleWidth } from "./layout.js";

function assertNoAnsi(text: string): void {
  expect(text).not.toMatch(/\x1b\[/);
}

function assertAsciiSafe(text: string): void {
  for (const ch of text) {
    expect(ch.charCodeAt(0)).toBeLessThan(128);
  }
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

// ──────────────────────────────────────────────────
describe("PlainRenderer — renderPlainFallback", () => {
  it("renders lines joined by newline", () => {
    const vm = buildPlainFallbackViewModel({
      lines: ["line one", "line two", "line three"],
    });
    expect(renderPlainFallback(vm)).toBe("line one\nline two\nline three");
  });

  it("renders empty lines as empty string", () => {
    const vm = buildPlainFallbackViewModel({ lines: [] });
    expect(renderPlainFallback(vm)).toBe("");
  });
});

describe("PlainRenderer — renderOnboardingPromptCard", () => {
  it("renders deterministic readable onboarding output", () => {
    const out = renderOnboardingPromptCard(onboardingTrustCard());
    expect(out).toBe([
      "Workspace trust",
      "Trust this workspace?",
      "EstaCoda can read project files and request approval before risky actions.",
      "/workspace",
      "",
      "> Trust workspace",
      "  Not now",
    ].join("\n"));
    assertNoAnsi(out);
    assertAsciiSafe(out);
  });

  it("does not insert prompt-card spacing for option-only cards", () => {
    const out = renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({
      title: "Choose",
      bodyLines: [],
      options: [{ id: "continue", label: "Continue" }],
      selectedOptionIndex: 0,
    }));
    expect(out).toBe([
      "Choose",
      "> Continue",
    ].join("\n"));
  });

  it("does not insert prompt-card spacing for content-only cards", () => {
    const out = renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({
      title: "Notice",
      bodyLines: ["Nothing to choose."],
      options: [],
      selectedOptionIndex: 0,
    }));
    expect(out).toBe([
      "Notice",
      "Nothing to choose.",
    ].join("\n"));
  });

  it("renders selected option marker at the selected index", () => {
    const out = renderOnboardingPromptCard(onboardingTrustCard({ selectedOptionIndex: 1 }));
    expect(out).toContain("  Trust workspace");
    expect(out).toContain("> Not now");
  });

  it("isolates Arabic technical lines and mirrors selected option marker", () => {
    const out = renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({
      title: "الثقة بمساحة العمل",
      bodyLines: ["هل تثق بمساحة العمل هذه؟"],
      technicalLines: ["/workspace", "KIMI_API_KEY", "kimi-k2", "openrouter"],
      options: [
        { id: "trust", label: "ثق بمساحة العمل" },
        { id: "skip", label: "ليس الآن" },
      ],
      selectedOptionIndex: 0,
      locale: "ar",
      direction: "rtl",
    }), "ar");
    expect(out).toContain(isolateLtr("/workspace"));
    expect(out).toContain(isolateLtr("KIMI_API_KEY"));
    expect(out).toContain(isolateLtr("kimi-k2"));
    expect(out).toContain(isolateLtr("openrouter"));
    expect(out).toContain(`${isolateRtl("ثق بمساحة العمل")} <`);
    expect(out).not.toContain(`> ${isolateRtl("ثق بمساحة العمل")}`);
    expect(out).toContain(`${isolateRtl("ليس الآن")}  `);
  });

  it("wraps Arabic option descriptions while keeping technical tokens isolated", () => {
    const out = renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({
      title: "تعلّم المهارات",
      bodyLines: ["اختر طريقة التعلّم."],
      options: [
        {
          id: "enabled",
          label: "فعّل التعلّم",
          description: `يسمح هذا الخيار لـ ${isolateLtr("EstaCoda")} بتعلّم مهارات قابلة لإعادة الاستخدام من الأنماط المتكررة في العمل اليومي، مع إبقاء الاقتراحات قابلة للمراجعة قبل اعتمادها، ويعرض التفاصيل بطريقة واضحة في السجلات النصية الطويلة.`,
        },
      ],
      selectedOptionIndex: 0,
      locale: "ar",
      direction: "rtl",
    }), "ar");
    const descriptionLines = out
      .split("\n")
      .filter((line) => line.startsWith(`  ${RLI}`));

    expect(descriptionLines.length).toBeGreaterThan(1);
    expect(out).not.toContain("...");
    expect(out).toContain(isolateLtr("EstaCoda"));
    for (const line of descriptionLines) {
      expect(line).toMatch(/^  /u);
      expect(measureVisibleWidth(line)).toBeLessThanOrEqual(90);
    }
  });
});

describe("PlainRenderer — renderFileChangePreview", () => {
  it("renders bounded file change previews without expansion command", () => {
    const vm = buildFileChangePreviewViewModel({
      path: "src/app.ts",
      changeType: "added",
      summary: ["Added 12 line(s)."],
      diff: Array.from({ length: 10 }, (_, index) => `+ line ${index + 1}`).join("\n"),
      omittedLineCount: 2,
    });

    const out = renderFileChangePreview(vm);
    expect(out).toContain("* created src/app.ts");
    expect(out).toContain("Added 12 line(s).");
    expect(out).toContain("+ line 8");
    expect(out).not.toContain("+ line 9");
    expect(out).toContain("omitted 4 diff line(s).");
    expect(out).not.toContain("/diff latest");
    assertNoAnsi(out);
    assertAsciiSafe(out);
  });
});

// ──────────────────────────────────────────────────
describe("PlainRenderer — renderWarningError", () => {
  it("renders error with title and message", () => {
    const vm = buildWarningErrorViewModel({
      severity: "error",
      title: "Missing config",
      message: "BOT_TOKEN is not set",
    });
    const out = renderWarningError(vm);
    expect(out).toBe("[ERROR] Missing config: BOT_TOKEN is not set");
    assertNoAnsi(out);
    assertAsciiSafe(out);
  });

  it("renders warn with details", () => {
    const vm = buildWarningErrorViewModel({
      severity: "warn",
      title: "Skill load",
      message: "1 warning",
      details: ["foo.skill missing description"],
    });
    const out = renderWarningError(vm);
    expect(out).toBe("[WARN] Skill load: 1 warning\n  foo.skill missing description");
    assertNoAnsi(out);
    assertAsciiSafe(out);
  });

  it("renders info without details", () => {
    const vm = buildWarningErrorViewModel({
      severity: "info",
      title: "Note",
      message: "All systems nominal",
    });
    expect(renderWarningError(vm)).toBe("[INFO] Note: All systems nominal");
  });
});

// ──────────────────────────────────────────────────
describe("PlainRenderer — renderStatus", () => {
  it("renders full status block", () => {
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
    const out = renderStatus(vm);
    expect(out).toContain("EstaCoda is ready");
    expect(out).toContain("model: openrouter/claude-sonnet-4");
    expect(out).toContain("security: open");
    expect(out).toContain("skills: 12 (suggest)");
    expect(out).toContain("tools: 34");
    expect(out).toContain("mcp: 2/3");
    expect(out).toContain("taskflow: active");
    assertNoAnsi(out);
    assertAsciiSafe(out);
  });

  it("renders without skillAutonomy when omitted", () => {
    const vm = buildStatusViewModel({
      agentName: "EstaCoda",
      model: { provider: "p", id: "i" },
      securityMode: "closed",
      skillCount: 0,
      toolCount: 0,
      mcpActive: 0,
      mcpTotal: 0,
      taskflowActive: false,
    });
    const out = renderStatus(vm);
    expect(out).toContain("skills: 0");
    expect(out).not.toContain("skills: 0 (");
  });

  it("renders warnings inline", () => {
    const vm = buildStatusViewModel({
      agentName: "EstaCoda",
      model: { provider: "p", id: "i" },
      securityMode: "open",
      skillCount: 1,
      toolCount: 1,
      mcpActive: 0,
      mcpTotal: 0,
      taskflowActive: false,
      warnings: [
        buildWarningErrorViewModel({ severity: "warn", title: "T", message: "M" }),
      ],
    });
    const out = renderStatus(vm);
    expect(out).toContain("[WARN] T: M");
  });
});

// ──────────────────────────────────────────────────
describe("PlainRenderer — renderTable", () => {
  it("renders table with title", () => {
    const vm = buildTableViewModel({
      title: "Cron jobs",
      columns: [
        { key: "id", header: "ID" },
        { key: "name", header: "Name" },
        { key: "status", header: "Status", alignment: "center" },
      ],
      rows: [
        { id: "job-1", name: "Daily report", status: "active" },
        { id: "job-2", name: "Weekly sync", status: "paused" },
      ],
    });
    const out = renderTable(vm);
    expect(out).toContain("Cron jobs");
    expect(out).toContain("ID");
    expect(out).toContain("Daily report");
    expect(out).toContain("active");
    assertNoAnsi(out);
    assertAsciiSafe(out);
  });

  it("renders empty table with custom message", () => {
    const vm = buildTableViewModel({
      title: "Jobs",
      columns: [{ key: "id", header: "ID" }],
      rows: [],
      emptyMessage: "No jobs found.",
    });
    expect(renderTable(vm)).toBe("Jobs\nNo jobs found.");
  });

  it("renders empty table with default message", () => {
    const vm = buildTableViewModel({
      columns: [{ key: "id", header: "ID" }],
      rows: [],
    });
    expect(renderTable(vm)).toBe("No data.");
  });

  it("right-aligns numeric columns", () => {
    const vm = buildTableViewModel({
      columns: [
        { key: "name", header: "Name", alignment: "left" },
        { key: "count", header: "Count", alignment: "right" },
      ],
      rows: [
        { name: "A", count: 1 },
        { name: "BB", count: 22 },
      ],
    });
    const out = renderTable(vm);
    const lines = out.split("\n");
    const dataLine = lines[lines.length - 2]; // second to last row
    expect(dataLine).toMatch(/A\s+1/);
  });
});

// ──────────────────────────────────────────────────
describe("PlainRenderer — renderKeyValueBlock", () => {
  it("renders title and entries", () => {
    const vm = buildKeyValueBlockViewModel({
      title: "Channel status",
      entries: [
        kv("Telegram", "ready", "ok"),
        kv("Discord", "not ready", "warn"),
        kv("Email", "disabled"),
      ],
    });
    const out = renderKeyValueBlock(vm);
    expect(out).toContain("Channel status");
    expect(out).toContain("[OK] Telegram: ready");
    expect(out).toContain("[WARN] Discord: not ready");
    expect(out).toContain("Email: disabled");
    assertNoAnsi(out);
    assertAsciiSafe(out);
  });

  it("renders without title", () => {
    const vm = buildKeyValueBlockViewModel({
      entries: [kv("key", "value")],
    });
    expect(renderKeyValueBlock(vm)).toBe("key: value");
  });
});

// ──────────────────────────────────────────────────
describe("PlainRenderer — renderList", () => {
  it("renders unordered list with title", () => {
    const vm = buildListViewModel({
      title: "Platforms",
      items: [listItem("telegram"), listItem("discord", "ready", "ok")],
    });
    const out = renderList(vm);
    expect(out).toContain("Platforms");
    expect(out).toContain("- telegram");
    expect(out).toContain("- [OK] discord: ready");
    assertNoAnsi(out);
    assertAsciiSafe(out);
  });

  it("renders ordered list", () => {
    const vm = buildListViewModel({
      items: [listItem("a"), listItem("b")],
      ordered: true,
    });
    const out = renderList(vm);
    expect(out).toContain("1. a");
    expect(out).toContain("2. b");
  });

  it("renders empty list with custom message", () => {
    const vm = buildListViewModel({
      title: "Items",
      items: [],
      emptyMessage: "none",
    });
    expect(renderList(vm)).toBe("Items\nnone");
  });
});

// ──────────────────────────────────────────────────
describe("PlainRenderer — renderApprovalSecurity", () => {
  it("renders approval prompt", () => {
    const vm = buildApprovalSecurityViewModel({
      toolName: "terminal",
      riskClass: "destructive-local",
      targetSummary: "rm -rf /home/user/project",
      severity: "warn",
      actions: [
        approvalAction("allow", "Allow once", "ok"),
        approvalAction("deny", "Deny", "error"),
      ],
      details: ["This action cannot be undone"],
    });
    const out = renderApprovalSecurity(vm);
    expect(out).toContain("[WARN] Approval required: terminal");
    expect(out).toContain("Target: rm -rf /home/user/project");
    expect(out).toContain("Risk: destructive-local");
    expect(out).toContain("  This action cannot be undone");
    expect(out).toContain("Actions:");
    expect(out).toContain("  allow) [OK] Allow once");
    expect(out).toContain("  deny) [ERROR] Deny");
    assertNoAnsi(out);
    assertAsciiSafe(out);
  });

  it("renders approval without riskClass or details", () => {
    const vm = buildApprovalSecurityViewModel({
      toolName: "web.search",
      targetSummary: "search query",
      severity: "info",
      actions: [approvalAction("allow", "Allow")],
    });
    const out = renderApprovalSecurity(vm);
    expect(out).toContain("[INFO] Approval required: web.search");
    expect(out).not.toContain("Risk:");
  });

  it("renders deterministically with all required fields visible in non-TTY mode", () => {
    const vm = buildApprovalSecurityViewModel({
      toolName: "terminal.run",
      riskClass: "destructive-local",
      targetSummary: "rm -rf /home/user/project",
      severity: "warn",
      actions: [
        approvalAction("once", "Allow once"),
        approvalAction("session", "Allow session"),
        approvalAction("always", "Always allow"),
        approvalAction("deny", "Deny", "error"),
      ],
      details: ["This action cannot be undone"],
    });
    const out = renderApprovalSecurity(vm);
    assertNoAnsi(out);
    assertAsciiSafe(out);
    expect(out).not.toContain("⚠");
    expect(out).not.toMatch(/[\u250c\u2510\u2514\u2518\u256d\u256e\u2570\u256f]/);
    expect(out).toContain("terminal.run");
    expect(out).toContain("destructive-local");
    expect(out).toContain("rm -rf /home/user/project");
    expect(out).toContain("Allow once");
    expect(out).toContain("Allow session");
    expect(out).toContain("Always allow");
    expect(out).toContain("Deny");
  });
});

// ──────────────────────────────────────────────────
describe("PlainRenderer — renderActivityTimeline", () => {
  it("renders timeline events", () => {
    const vm = buildActivityTimelineViewModel({
      events: [
        timelineEvent("terminal", "running", { elapsedMs: 1200 }),
        timelineEvent("web.extract", "done", {
          elapsedMs: 3400,
          chars: 1200,
          sentChars: 800,
        }),
        timelineEvent("terminal", "gated", {
          decision: "ask",
          riskClass: "destructive-local",
        }),
      ],
    });
    const out = renderActivityTimeline(vm);
    expect(out).toContain("[>] terminal | 1.2s");
    expect(out).toContain("[x] web.extract | 3.4s | 1.2k captured / 800 sent");
    expect(out).toContain("[?] terminal | decision: ask | risk: destructive-local");
    assertNoAnsi(out);
    assertAsciiSafe(out);
  });

  it("renders empty timeline", () => {
    const vm = buildActivityTimelineViewModel({ events: [] });
    expect(renderActivityTimeline(vm)).toBe("No activity.");
  });

  it("renders truncated event", () => {
    const vm = buildActivityTimelineViewModel({
      events: [
        timelineEvent("web.extract", "done", {
          chars: 1500,
          sentChars: 900,
          truncated: true,
        }),
      ],
    });
    const out = renderActivityTimeline(vm);
    expect(out).toContain("/ compressed");
  });
});

// ──────────────────────────────────────────────────
describe("PlainRenderer — renderProgressRail", () => {
  it("renders progress steps", () => {
    const vm = buildProgressContextRailViewModel({
      title: "Setup",
      steps: [
        progressStep("Config loaded", "done"),
        progressStep("Skills loaded", "done"),
        progressStep("MCP connected", "active"),
        progressStep("Ready", "pending"),
      ],
    });
    const out = renderProgressRail(vm);
    expect(out).toContain("Setup");
    expect(out).toContain("[x] Config loaded");
    expect(out).toContain("[>] MCP connected");
    expect(out).toContain("[ ] Ready");
    assertNoAnsi(out);
    assertAsciiSafe(out);
  });

  it("renders failed step", () => {
    const vm = buildProgressContextRailViewModel({
      steps: [progressStep("Load", "failed")],
    });
    expect(renderProgressRail(vm)).toContain("[-] Load");
  });

  it("renders empty progress", () => {
    const vm = buildProgressContextRailViewModel({ steps: [] });
    expect(renderProgressRail(vm)).toBe("No steps.");
  });
});

// ──────────────────────────────────────────────────
describe("PlainRenderer — renderPicker", () => {
  it("renders picker with selected option", () => {
    const vm = buildPickerViewModel({
      title: "Select a model",
      options: [
        pickerOption("claude", "Claude", { selected: true }),
        pickerOption("gpt", "GPT", { description: "Fast" }),
        pickerOption("gemini", "Gemini"),
      ],
    });
    const out = renderPicker(vm);
    expect(out).toContain("Select a model");
    expect(out).toContain(">  1) Claude");
    expect(out).toContain("   2) GPT");
    expect(out).toContain("     Fast");
    expect(out).toContain("   3) Gemini");
    assertNoAnsi(out);
    assertAsciiSafe(out);
  });

  it("renders picker without selection", () => {
    const vm = buildPickerViewModel({
      title: "Choose",
      options: [pickerOption("a", "A")],
    });
    const out = renderPicker(vm);
    expect(out).toContain("  1) A");
    expect(out).not.toContain(">");
  });
});

// ──────────────────────────────────────────────────
describe("PlainRenderer — renderStartup", () => {
  it("renders startup with taglines and warnings", () => {
    const vm = buildStartupViewModel({
      agentName: "EstaCoda",
      taglines: ["Kemet Research", "Autonomous Engineering"],
      model: { provider: "openrouter", id: "claude-sonnet-4" },
      readiness: "ready",
      warnings: [],
    });
    const out = renderStartup(vm);
    expect(out).toContain("EstaCoda");
    expect(out).toContain("Kemet Research");
    expect(out).toContain("Autonomous Engineering");
    expect(out).toContain("model: openrouter/claude-sonnet-4");
    expect(out).toContain("readiness: ready");
    assertNoAnsi(out);
    assertAsciiSafe(out);
  });

  it("renders degraded readiness with warnings", () => {
    const vm = buildStartupViewModel({
      agentName: "EstaCoda",
      taglines: [],
      model: { provider: "p", id: "i" },
      readiness: "degraded",
      warnings: [
        buildWarningErrorViewModel({
          severity: "warn",
          title: "Config",
          message: "Missing",
        }),
      ],
    });
    const out = renderStartup(vm);
    expect(out).toContain("readiness: degraded");
    expect(out).toContain("[WARN] Config: Missing");
  });

  it("skips empty taglines", () => {
    const vm = buildStartupViewModel({
      agentName: "X",
      taglines: ["", "Valid"],
      model: { provider: "p", id: "i" },
      readiness: "ready",
    });
    const out = renderStartup(vm);
    expect(out).not.toContain("\n\n");
    expect(out).toContain("Valid");
  });

  it("renders legacy startup chrome in Arabic with isolated technical tokens", () => {
    const vm = buildStartupViewModel({
      agentName: "EstaCoda",
      taglines: [],
      model: { provider: "openrouter", id: "gpt-5.5" },
      readiness: "ready",
    });
    const out = renderStartup(vm, "ar");
    expect(out).toContain("النموذج");
    expect(out).toContain("الجاهزية: جاهز");
    expect(out).toContain(isolateLtr("openrouter"));
    expect(out).toContain(isolateLtr("gpt-5.5"));
    assertNoAnsi(out);
  });
});

// ──────────────────────────────────────
// PlainRenderer — renderStartupDashboard
// ──────────────────────────────────────

describe("PlainRenderer — renderStartupDashboard", () => {
  it("renders full dashboard with all fields", () => {
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
    const out = renderStartupDashboard(vm);
    expect(out).toContain("EstaCoda");
    expect(out).toContain("Kemet Research");
    expect(out).toContain("version: v0.0.5");
    expect(out).toContain("session: sess-9f7a2c1b");
    expect(out).toContain("model: deepseek-reasoner - ready");
    expect(out).toContain("workspace trust: trusted");
    expect(out).toContain("workspace verification: verified");
    expect(out).toContain("workspace: /workspace");
    expect(out).toContain("security: high");
    expect(out).toContain("skills: autonomous");
    expect(out).toContain("version status: unknown");
    expect(out).toContain("Interactive commands:");
    expect(out).toContain("  /tools   Browse runtime tools");
    expect(out).toContain("  /status  Show session status");
    assertNoAnsi(out);
    // Tagline contains Arabic text; ASCII-safety does not apply to user content
  });

  it("renders minimal dashboard without optional fields", () => {
    const vm = buildStartupDashboardViewModel({
      agentName: "EstaCoda",
      taglines: [],
      version: "v0.0.1",
      model: { provider: "p", id: "i" },
      workspaceTrust: "unknown",
      workspaceVerification: "unknown",
      securityMode: "open",
      providerReadiness: "unknown",
      availableCommands: [],
      warnings: [],
    });
    const out = renderStartupDashboard(vm);
    expect(out).toBe(
      "EstaCoda\n\nversion: v0.0.1\nmodel: i - unknown\nworkspace trust: unknown\nworkspace verification: unknown\nsecurity: open\n\nInteractive commands:\n  /tools   Browse runtime tools\n  /skills  Browse skills\n  /model   Show active model\n  /status  Show session status"
    );
  });

  it("renders missing-config with fallback label", () => {
    const vm = buildStartupDashboardViewModel({
      agentName: "EstaCoda",
      taglines: [],
      version: "v0.0.1",
      model: { provider: "p", id: "i" },
      workspaceTrust: "unknown",
      workspaceVerification: "unknown",
      securityMode: "open",
      providerReadiness: "missing-config",
      availableCommands: [],
      warnings: [],
    });
    const out = renderStartupDashboard(vm);
    expect(out).toContain("model: model not configured - missing config");
  });

  it("renders dashboard with warnings", () => {
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
    const out = renderStartupDashboard(vm);
    expect(out).toContain("[WARN] Config: Missing");
    assertNoAnsi(out);
    assertAsciiSafe(out);
  });

  it("renders Arabic dashboard chrome and isolates startup technical tokens", () => {
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
    const out = renderStartupDashboard(vm, "ar");
    expect(out).toContain("الإصدار: " + isolateLtr("v0.0.5"));
    expect(out).toContain("الجلسة: " + isolateLtr("sess-9f7a2c1b"));
    expect(out).toContain("النموذج: " + isolateLtr("deepseek-reasoner") + " - جاهز");
    expect(out).toContain("ثقة مساحة العمل: موثوقة");
    expect(out).toContain("حالة تحقق مساحة العمل: متحقق منها");
    expect(out).toContain("مسار مساحة العمل: " + isolateLtr("/workspace"));
    expect(out).toContain("وضع الأمان: " + isolateLtr("high"));
    expect(out).toContain("استقلالية المهارات: " + isolateLtr("autonomous"));
    expect(out).toContain("حالة الإصدار: غير معروف");
    expect(out).toContain("الأوامر التفاعلية:");
    expect(out).toContain(isolateLtr("/tools"));
    expect(out).toContain(isolateLtr("/skills"));
    expect(out).toContain(isolateLtr("/model"));
    expect(out).toContain(isolateLtr("/status"));
    expect(out).toContain("استعرض أدوات التشغيل");
    assertNoAnsi(out);
  });

  it("honors provided startup dashboard commands instead of localized fallbacks", () => {
    const vm = buildStartupDashboardViewModel({
      agentName: "EstaCoda",
      taglines: [],
      version: "v0.0.1",
      model: { provider: "p", id: "i" },
      workspaceTrust: "trusted",
      workspaceVerification: "verified",
      securityMode: "high",
      providerReadiness: "ready",
      availableCommands: [{ name: "/verify", description: "Verify startup" }],
      warnings: [],
    });
    const out = renderStartupDashboard(vm, "ar");
    expect(out).toContain(isolateLtr("/verify"));
    expect(out).toContain("Verify startup");
    expect(out).not.toContain("استعرض أدوات التشغيل");
    expect(out).not.toContain(isolateLtr("/tools"));
  });
});

// ──────────────────────────────────────
// PlainRenderer — renderCommandResult
// ──────────────────────────────────────

describe("PlainRenderer — renderCommandResult", () => {
  it("renders ok result with blocks", () => {
    const vm = buildCommandResultViewModel({
      ok: true,
      title: "Gateway status",
      blocks: [
        buildKeyValueBlockViewModel({
          entries: [kv("Channels", "4")],
        }),
        buildListViewModel({
          items: [listItem("telegram")],
        }),
      ],
    });
    const out = renderCommandResult(vm);
    expect(out).toContain("[OK] Gateway status");
    expect(out).toContain("Channels: 4");
    expect(out).toContain("- telegram");
    assertNoAnsi(out);
    assertAsciiSafe(out);
  });

  it("renders fail result without blocks", () => {
    const vm = buildCommandResultViewModel({
      ok: false,
      title: "Error",
      blocks: [],
    });
    expect(renderCommandResult(vm)).toBe("[FAIL] Error");
  });

  it("renders nested command result recursively", () => {
    const inner = buildCommandResultViewModel({
      ok: true,
      title: "Inner",
      blocks: [buildPlainFallbackViewModel({ lines: ["inner line"] })],
    });
    const vm = buildCommandResultViewModel({
      ok: true,
      title: "Outer",
      blocks: [inner],
    });
    const out = renderCommandResult(vm);
    expect(out).toContain("[OK] Outer");
    expect(out).toContain("[OK] Inner");
    expect(out).toContain("inner line");
  });
});

// ──────────────────────────────────────────────────
describe("PlainRenderer — renderPlain dispatcher", () => {
  it("dispatches all ViewModel kinds correctly", () => {
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
    ];

    for (const vm of vms) {
      const out = renderPlain(vm);
      expect(typeof out).toBe("string");
      assertNoAnsi(out);
      assertAsciiSafe(out);
    }
  });
});

// ──────────────────────────────────────────────────
describe("PlainRenderer — deterministic output", () => {
  it("produces identical output for identical input", () => {
    const vm = buildStatusViewModel({
      agentName: "EstaCoda",
      model: { provider: "openrouter", id: "claude-sonnet-4" },
      securityMode: "open",
      skillCount: 5,
      toolCount: 10,
      mcpActive: 1,
      mcpTotal: 2,
      taskflowActive: true,
    });
    const a = renderPlain(vm);
    const b = renderPlain(vm);
    expect(a).toBe(b);
  });

  it("produces identical output for identical complex input", () => {
    const vm = buildCommandResultViewModel({
      ok: true,
      title: "Result",
      blocks: [
        buildTableViewModel({
          columns: [
            { key: "a", header: "A" },
            { key: "b", header: "B" },
          ],
          rows: [{ a: "1", b: "2" }],
        }),
        buildListViewModel({
          items: [listItem("x"), listItem("y")],
        }),
      ],
    });
    const a = renderPlain(vm);
    const b = renderPlain(vm);
    expect(a).toBe(b);
  });
});

// ──────────────────────────────────────────────────
describe("PlainRenderer — edge cases", () => {
  it("handles undefined table cells", () => {
    const vm = buildTableViewModel({
      columns: [{ key: "a", header: "A" }],
      rows: [{ a: undefined }],
    });
    const out = renderTable(vm);
    expect(out).toContain("A");
    expect(out).toContain("-");
  });

  it("handles boolean table cells", () => {
    const vm = buildTableViewModel({
      columns: [{ key: "flag", header: "Flag" }],
      rows: [{ flag: true }, { flag: false }],
    });
    const out = renderTable(vm);
    expect(out).toContain("true");
    expect(out).toContain("false");
  });

  it("handles numeric table cells", () => {
    const vm = buildTableViewModel({
      columns: [{ key: "n", header: "N" }],
      rows: [{ n: 42 }],
    });
    expect(renderTable(vm)).toContain("42");
  });

  it("handles timeline event with only tool and status", () => {
    const vm = buildActivityTimelineViewModel({
      events: [timelineEvent("tool", "pending")],
    });
    expect(renderActivityTimeline(vm)).toBe("[ ] tool");
  });

  it("handles timeline duration formatting for ms", () => {
    const vm = buildActivityTimelineViewModel({
      events: [timelineEvent("t", "done", { elapsedMs: 500 })],
    });
    expect(renderActivityTimeline(vm)).toContain("500ms");
  });

  it("handles timeline duration formatting for seconds", () => {
    const vm = buildActivityTimelineViewModel({
      events: [timelineEvent("t", "done", { elapsedMs: 2500 })],
    });
    expect(renderActivityTimeline(vm)).toContain("2.5s");
  });

  it("handles count formatting for thousands", () => {
    const vm = buildActivityTimelineViewModel({
      events: [timelineEvent("t", "done", { chars: 1500, sentChars: 900 })],
    });
    expect(renderActivityTimeline(vm)).toContain("1.5k captured / 900 sent");
  });

  it("handles empty taglines in startup", () => {
    const vm = buildStartupViewModel({
      agentName: "X",
      taglines: [],
      model: { provider: "p", id: "i" },
      readiness: "ready",
    });
    const out = renderStartup(vm);
    expect(out).toBe("X\nmodel: p/i\nreadiness: ready");
  });

  it("handles kv block with numeric and boolean values", () => {
    const vm = buildKeyValueBlockViewModel({
      entries: [
        kv("count", 42),
        kv("flag", true),
      ],
    });
    const out = renderKeyValueBlock(vm);
    expect(out).toContain("count: 42");
    expect(out).toContain("flag: true");
  });

  it("handles list item without value", () => {
    const vm = buildListViewModel({
      items: [listItem("label")],
    });
    expect(renderList(vm)).toBe("- label");
  });

  it("handles picker with empty options", () => {
    const vm = buildPickerViewModel({ title: "Choose", options: [] });
    expect(renderPicker(vm)).toBe("Choose");
  });

  it("handles progress rail with title and empty steps", () => {
    const vm = buildProgressContextRailViewModel({
      title: "Steps",
      steps: [],
    });
    expect(renderProgressRail(vm)).toBe("Steps\nNo steps.");
  });
});

// ──────────────────────────────────────────────────
describe("PlainRenderer — renderConversationMessage", () => {
  it("renders assistant message with label and text", () => {
    const vm = buildConversationMessageViewModel({
      role: "assistant",
      text: "Here is the result.\nLine two.",
      label: "EstaCoda",
    });
    const out = renderConversationMessage(vm);
    expect(out).toContain("EstaCoda:");
    expect(out).toContain("Here is the result.");
    expect(out).toContain("Line two.");
    assertNoAnsi(out);
    assertAsciiSafe(out);
  });

  it("renders assistant message with matched skills", () => {
    const vm = buildConversationMessageViewModel({
      role: "assistant",
      text: "Done.",
      matchedSkills: ["file-search", "git-status"],
    });
    const out = renderConversationMessage(vm);
    expect(out).toContain("EstaCoda:");
    expect(out).toContain("skills: file-search, git-status");
    assertNoAnsi(out);
    assertAsciiSafe(out);
  });

  it("renders assistant message with progress", () => {
    const vm = buildConversationMessageViewModel({
      role: "assistant",
      text: "Done.",
      progress: ["planning", "coding", "review"],
    });
    const out = renderConversationMessage(vm);
    expect(out).toContain("EstaCoda:");
    expect(out).toContain("progress: planning -> coding -> review");
    assertNoAnsi(out);
    assertAsciiSafe(out);
  });

  it("renders assistant message with skills and progress", () => {
    const vm = buildConversationMessageViewModel({
      role: "assistant",
      text: "Done.",
      matchedSkills: ["search"],
      progress: ["start", "finish"],
    });
    const out = renderConversationMessage(vm);
    expect(out).toContain("EstaCoda:");
    expect(out).toContain("skills: search");
    expect(out).toContain("progress: start -> finish");
    assertNoAnsi(out);
    assertAsciiSafe(out);
  });

  it("falls back to EstaCoda label when label contains non-ASCII", () => {
    const vm = buildConversationMessageViewModel({
      role: "assistant",
      text: "Hello.",
      label: "\u0230 \u0627\u0633\u062a\u0627\u0643\u0648\u062f\u0627",
    });
    const out = renderConversationMessage(vm);
    expect(out).toContain("EstaCoda:");
    assertNoAnsi(out);
    assertAsciiSafe(out);
  });

  it("uses custom label when ASCII-safe", () => {
    const vm = buildConversationMessageViewModel({
      role: "assistant",
      text: "Hello.",
      label: "CustomBot",
    });
    const out = renderConversationMessage(vm);
    expect(out).toContain("CustomBot:");
    assertNoAnsi(out);
    assertAsciiSafe(out);
  });

  it("passes through user message text unchanged", () => {
    const vm = buildConversationMessageViewModel({
      role: "user",
      text: "Hello, assistant!\nSecond line.",
    });
    const out = renderConversationMessage(vm);
    expect(out).toBe("Hello, assistant!\nSecond line.");
    assertNoAnsi(out);
    assertAsciiSafe(out);
  });
});

describe("PlainRenderer — prompt chrome rails", () => {
  it("renders deterministic status rail without ANSI", () => {
    const vm = buildSessionStatusRailViewModel({
      modelLabel: "deepseek-reasoner",
      turnState: "idle",
      contextUsage: { filled: 32700, total: 128000 },
      sessionElapsedMs: 58000,
      currentTurnSeconds: 312,
      showTurnState: false,
    });
    const out = renderSessionStatusRail(vm);
    expect(out).toBe("* deepseek-reasoner | context 32.7k/128k | 26% | session 58s | turn 5m 12s");
    assertNoAnsi(out);
  });

  it("renders long status rail durations as hours and minutes without ANSI", () => {
    const vm = buildSessionStatusRailViewModel({
      modelLabel: "deepseek-reasoner",
      turnState: "idle",
      sessionElapsedMs: 217 * 60_000,
      currentTurnSeconds: 217 * 60,
      showTurnState: false,
    });
    const out = renderSessionStatusRail(vm);

    expect(out).toBe("* deepseek-reasoner | session 3h 37m | turn 3h 37m");
    assertNoAnsi(out);
  });

  it("renders deterministic shortcut rail without ANSI", () => {
    const out = renderShortcutHintRail(buildShortcutHintRailViewModel({ hints: [] }));
    expect(out).toBe("> /help · /tools · /model · /status · Ctrl+C exit");
    assertNoAnsi(out);
  });

  it("dispatches rails through renderPlain", () => {
    expect(renderPlain(buildSessionStatusRailViewModel({ modelLabel: "m", turnState: "idle" }))).toBe("* m | idle");
    expect(renderPlain(buildShortcutHintRailViewModel({ hints: [{ key: "/help", description: "help" }] }))).toBe("> /help help");
  });

  it("renders Arabic status rail labels when locale is ar", () => {
    const vm = buildSessionStatusRailViewModel({
      modelLabel: "openai/gpt-4.1",
      turnState: "idle",
      contextUsage: { filled: 1024, total: 128000 },
    });
    const out = renderSessionStatusRail(vm, "ar");
    expect(out).toContain(`خامل | 1% | ${isolateLtr("1.0k/128k")} السياق | ${isolateLtr("openai/gpt-4.1")} *`);
    assertNoAnsi(out);
  });

  it("renders Arabic shortcut rail labels when locale is ar", () => {
    const out = renderShortcutHintRail(buildShortcutHintRailViewModel({ hints: [] }), "ar");
    expect(out).toContain("خروج");
    expect(out).toContain("\u2066/help\u2069");
    assertNoAnsi(out);
  });

  it("keeps plain Arabic technical tokens LTR-isolated", () => {
    const vm = buildSessionStatusRailViewModel({ modelLabel: "deepseek-reasoner", turnState: "idle" });
    const status = renderSessionStatusRail(vm, "ar");
    const shortcuts = renderShortcutHintRail(buildShortcutHintRailViewModel({ hints: [] }), "ar");
    expect(status).toContain(isolateLtr("deepseek-reasoner"));
    expect(shortcuts).toContain("\u2066/help\u2069");
    expect(shortcuts).toContain("\u2066Ctrl+C\u2069");
    expect(shortcuts).toContain(isolateRtl(`${isolateLtr("/help")} · ${isolateLtr("/tools")} · ${isolateLtr("/model")} · ${isolateLtr("/status")} · ${isolateLtr("Ctrl+C")} خروج`));
  });

  it("renders user prompt rail with ASCII bullet and horizontal rule", () => {
    const vm = buildUserPromptRailViewModel({ text: "Hello, world!" });
    const out = renderUserPromptRail(vm);
    expect(out).toBe("> Hello, world!\n" + `+${"-".repeat(58)}+`);
    assertNoAnsi(out);
    assertAsciiSafe(out);
  });

  it("dispatches user prompt rail through renderPlain", () => {
    const vm = buildUserPromptRailViewModel({ text: "Plain dispatch" });
    const out = renderPlain(vm);
    expect(out).toBe("> Plain dispatch\n" + `+${"-".repeat(58)}+`);
    assertNoAnsi(out);
    assertAsciiSafe(out);
  });
});

// ──────────────────────────────────────────────────
describe("PlainRenderer — renderActiveTurnSpinner", () => {
  it("renders English phase label with ASCII eye", () => {
    const vm = buildActiveTurnSpinnerViewModel({ phase: "thinking" });
    const out = renderActiveTurnSpinner(vm, "en");
    expect(out).toBe("* contemplating");
    assertNoAnsi(out);
    assertAsciiSafe(out);
  });

  it("renders Arabic phase label with ASCII eye", () => {
    const vm = buildActiveTurnSpinnerViewModel({ phase: "thinking" });
    const out = renderActiveTurnSpinner(vm, "ar");
    expect(out).toBe("* \u0628\u0641\u0643\u0631");
    assertNoAnsi(out);
  });

  it("uses explicit label over phase lookup", () => {
    const vm = buildActiveTurnSpinnerViewModel({ phase: "thinking", label: "custom" });
    const out = renderActiveTurnSpinner(vm, "en");
    expect(out).toBe("* custom");
  });

  it("falls back to eye-only when phase is unknown and no label given", () => {
    const vm = buildActiveTurnSpinnerViewModel({ phase: "unknown-phase" });
    const out = renderActiveTurnSpinner(vm, "en");
    expect(out).toBe("*");
  });
});
