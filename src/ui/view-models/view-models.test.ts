import { describe, it, expect } from "vitest";
import {
  approvalAction,
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
  kv,
  listItem,
  pickerOption,
  progressStep,
  timelineEvent,
  toolActivityRailEvent,
  fileChangeHunk,
  shortcutHint,
  slashMenuOption,
} from "./builders.js";

describe("ViewModel builders", () => {
  it("buildStatusViewModel produces plain structured object", () => {
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
      warnings: [
        buildWarningErrorViewModel({
          severity: "warn",
          title: "Skill load",
          message: "1 warning",
        }),
      ],
    });

    expect(vm.kind).toBe("status");
    expect(vm.agentName).toBe("EstaCoda");
    expect(vm.model.provider).toBe("openrouter");
    expect(vm.securityMode).toBe("open");
    expect(vm.skillCount).toBe(12);
    expect(vm.skillAutonomy).toBe("suggest");
    expect(vm.toolCount).toBe(34);
    expect(vm.mcp).toEqual({ active: 2, total: 3 });
    expect(vm.workflowRunActive).toBe(true);
    expect(vm.warnings).toHaveLength(1);
    expect(vm.warnings[0].kind).toBe("warning");
    expect(vm.sections).toBeUndefined();

    // Must be a plain object with no methods
    expect(Object.getPrototypeOf(vm)).toBe(Object.prototype);
  });

  it("buildStatusViewModel defaults warnings to empty array", () => {
    const vm = buildStatusViewModel({
      agentName: "EstaCoda",
      model: { provider: "openrouter", id: "claude-sonnet" },
      securityMode: "closed",
      skillCount: 0,
      toolCount: 0,
      mcpActive: 0,
      mcpTotal: 0,
      workflowAvailable: false,
      workflowRunActive: false,
    });

    expect(vm.warnings).toEqual([]);
  });

  it("buildTableViewModel produces plain structured object", () => {
    const vm = buildTableViewModel({
      title: "Cron jobs",
      columns: [
        { key: "id", header: "ID", alignment: "left" },
        { key: "name", header: "Name", alignment: "left" },
        { key: "status", header: "Status", alignment: "center" },
      ],
      rows: [
        { id: "job-1", name: "Daily report", status: "active" },
        { id: "job-2", name: "Weekly sync", status: "paused" },
      ],
      emptyMessage: "No jobs",
    });

    expect(vm.kind).toBe("table");
    expect(vm.title).toBe("Cron jobs");
    expect(vm.columns).toHaveLength(3);
    expect(vm.columns[2].alignment).toBe("center");
    expect(vm.rows).toHaveLength(2);
    expect(vm.emptyMessage).toBe("No jobs");
    expect(Object.getPrototypeOf(vm)).toBe(Object.prototype);
  });

  it("buildKeyValueBlockViewModel produces plain structured object", () => {
    const vm = buildKeyValueBlockViewModel({
      title: "Channel status",
      entries: [
        kv("Telegram", "ready", "ok"),
        kv("Discord", "configured, missing credentials", "warn"),
        kv("Email", "disabled"),
      ],
    });

    expect(vm.kind).toBe("kv");
    expect(vm.title).toBe("Channel status");
    expect(vm.entries).toHaveLength(3);
    expect(vm.entries[0]).toEqual({ key: "Telegram", value: "ready", severity: "ok" });
    expect(vm.entries[1]).toEqual({
      key: "Discord",
      value: "configured, missing credentials",
      severity: "warn",
    });
    expect(Object.getPrototypeOf(vm)).toBe(Object.prototype);
  });

  it("buildListViewModel produces plain structured object", () => {
    const vm = buildListViewModel({
      title: "Delivery platforms",
      items: [
        listItem("telegram"),
        listItem("discord", undefined, "ok"),
        listItem("email", "not ready", "warn"),
      ],
      ordered: false,
      emptyMessage: "none configured",
    });

    expect(vm.kind).toBe("list");
    expect(vm.title).toBe("Delivery platforms");
    expect(vm.items).toHaveLength(3);
    expect(vm.items[2]).toEqual({ label: "email", value: "not ready", severity: "warn" });
    expect(vm.ordered).toBe(false);
    expect(vm.emptyMessage).toBe("none configured");
    expect(Object.getPrototypeOf(vm)).toBe(Object.prototype);
  });

  it("buildWarningErrorViewModel produces plain structured object", () => {
    const vm = buildWarningErrorViewModel({
      severity: "error",
      title: "Missing config",
      message: "BOT_TOKEN is not set",
      details: ["Set ESTACODA_TELEGRAM_BOT_TOKEN in your environment"],
    });

    expect(vm.kind).toBe("warning");
    expect(vm.severity).toBe("error");
    expect(vm.title).toBe("Missing config");
    expect(vm.message).toBe("BOT_TOKEN is not set");
    expect(vm.details).toEqual(["Set ESTACODA_TELEGRAM_BOT_TOKEN in your environment"]);
    expect(Object.getPrototypeOf(vm)).toBe(Object.prototype);
  });

  it("buildApprovalSecurityViewModel produces plain structured object", () => {
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

    expect(vm.kind).toBe("approval");
    expect(vm.toolName).toBe("terminal");
    expect(vm.riskClass).toBe("destructive-local");
    expect(vm.targetSummary).toBe("rm -rf /home/user/project");
    expect(vm.severity).toBe("warn");
    expect(vm.actions).toHaveLength(2);
    expect(vm.actions[0]).toEqual({ id: "allow", label: "Allow once", severity: "ok" });
    expect(vm.details).toEqual(["This action cannot be undone"]);
    expect(Object.getPrototypeOf(vm)).toBe(Object.prototype);
  });

  it("buildActivityTimelineViewModel produces plain structured object", () => {
    const vm = buildActivityTimelineViewModel({
      events: [
        timelineEvent("terminal", "running", { elapsedMs: 1200 }),
        timelineEvent("web.extract", "done", { elapsedMs: 3400, chars: 1200, sentChars: 800 }),
        timelineEvent("terminal", "gated", { decision: "ask", riskClass: "destructive-local" }),
      ],
    });

    expect(vm.kind).toBe("timeline");
    expect(vm.events).toHaveLength(3);
    expect(vm.events[0]).toEqual({ tool: "terminal", status: "running", elapsedMs: 1200 });
    expect(vm.events[1]).toEqual({
      tool: "web.extract",
      status: "done",
      elapsedMs: 3400,
      chars: 1200,
      sentChars: 800,
    });
    expect(vm.events[2]).toEqual({
      tool: "terminal",
      status: "gated",
      decision: "ask",
      riskClass: "destructive-local",
    });
    expect(Object.getPrototypeOf(vm)).toBe(Object.prototype);
  });

  it("buildProgressContextRailViewModel produces plain structured object", () => {
    const vm = buildProgressContextRailViewModel({
      title: "Setup",
      steps: [
        progressStep("Config loaded", "done"),
        progressStep("Skills loaded", "done"),
        progressStep("MCP connected", "active"),
        progressStep("Ready", "pending"),
      ],
    });

    expect(vm.kind).toBe("progress");
    expect(vm.title).toBe("Setup");
    expect(vm.steps).toHaveLength(4);
    expect(vm.steps[2]).toEqual({ label: "MCP connected", status: "active" });
    expect(Object.getPrototypeOf(vm)).toBe(Object.prototype);
  });

  it("buildPickerViewModel produces plain structured object", () => {
    const vm = buildPickerViewModel({
      title: "Select a model",
      options: [
        pickerOption("claude-sonnet", "Claude Sonnet", { selected: true }),
        pickerOption("gpt-4o", "GPT-4o", { description: "Fast and capable" }),
        pickerOption("gemini-pro", "Gemini Pro"),
      ],
    });

    expect(vm.kind).toBe("picker");
    expect(vm.title).toBe("Select a model");
    expect(vm.options).toHaveLength(3);
    expect(vm.options[0]).toEqual({ id: "claude-sonnet", label: "Claude Sonnet", selected: true });
    expect(vm.options[1]).toEqual({
      id: "gpt-4o",
      label: "GPT-4o",
      description: "Fast and capable",
    });
    expect(Object.getPrototypeOf(vm)).toBe(Object.prototype);
  });

  it("buildOnboardingPromptCardViewModel produces plain structured object", () => {
    const vm = buildOnboardingPromptCardViewModel({
      title: "Workspace trust",
      bodyLines: ["Trust this workspace?"],
      bodyLineStyles: [{ emphasis: "strong" }],
      technicalLines: ["/workspace"],
      statusLines: [
        { text: "Current: alpha", tone: "active", direction: "ltr" },
      ],
      columns: [
        { key: "name", header: "Name", align: "right" },
        { key: "description", header: "Description" },
      ],
      options: [
        {
          id: "alpha",
          label: "Alpha",
          cells: { name: "Alpha", description: "First generic option" },
          badges: ["Current"],
          current: true,
        },
        { id: "skip", label: "Not now", description: "Return later", group: "navigation" },
      ],
      selectedOptionIndex: 0,
      hint: "Use arrow keys to choose.",
      showCurrentBadge: false,
      showColumnHeaders: false,
      tableDirection: "rtl",
      tableWidth: "content",
      tableMaxWidth: 88,
      tableAlign: "right",
      locale: "en",
      direction: "ltr",
    });

    expect(vm.kind).toBe("onboardingPromptCard");
    expect(vm.title).toBe("Workspace trust");
    expect(vm.bodyLines).toEqual(["Trust this workspace?"]);
    expect(vm.bodyLineStyles).toEqual([{ emphasis: "strong" }]);
    expect(vm.technicalLines).toEqual(["/workspace"]);
    expect(vm.statusLines).toEqual([
      { text: "Current: alpha", tone: "active", direction: "ltr" },
    ]);
    expect(vm.columns).toEqual([
      { key: "name", header: "Name", align: "right" },
      { key: "description", header: "Description" },
    ]);
    expect(vm.options).toHaveLength(2);
    expect(vm.options[0]).toEqual({
      id: "alpha",
      label: "Alpha",
      cells: { name: "Alpha", description: "First generic option" },
      badges: ["Current"],
      current: true,
    });
    expect(vm.options[1]).toEqual({
      id: "skip",
      label: "Not now",
      description: "Return later",
      group: "navigation",
    });
    expect(vm.selectedOptionIndex).toBe(0);
    expect(vm.hint).toBe("Use arrow keys to choose.");
    expect(vm.showCurrentBadge).toBe(false);
    expect(vm.showColumnHeaders).toBe(false);
    expect(vm.tableDirection).toBe("rtl");
    expect(vm.tableWidth).toBe("content");
    expect(vm.tableMaxWidth).toBe(88);
    expect(vm.tableAlign).toBe("right");
    expect(vm.locale).toBe("en");
    expect(vm.direction).toBe("ltr");
    expect(Object.getPrototypeOf(vm)).toBe(Object.prototype);
  });

  it("buildStartupViewModel produces plain structured object", () => {
    const vm = buildStartupViewModel({
      agentName: "EstaCoda",
      taglines: ["⟡ SIFR01 ⟡", "Autonomous Engineering"],
      model: { provider: "openrouter", id: "claude-sonnet-4" },
      readiness: "ready",
      warnings: [],
    });

    expect(vm.kind).toBe("startup");
    expect(vm.agentName).toBe("EstaCoda");
    expect(vm.taglines).toEqual(["⟡ SIFR01 ⟡", "Autonomous Engineering"]);
    expect(vm.model.id).toBe("claude-sonnet-4");
    expect(vm.readiness).toBe("ready");
    expect(vm.warnings).toEqual([]);
    expect(Object.getPrototypeOf(vm)).toBe(Object.prototype);
  });

  it("buildStartupViewModel defaults warnings to empty array", () => {
    const vm = buildStartupViewModel({
      agentName: "EstaCoda",
      taglines: [],
      model: { provider: "openrouter", id: "claude-sonnet" },
      readiness: "degraded",
    });

    expect(vm.warnings).toEqual([]);
  });

  it("buildCommandResultViewModel produces plain structured object", () => {
    const inner = buildKeyValueBlockViewModel({
      entries: [kv("result", "ok")],
    });

    const vm = buildCommandResultViewModel({
      ok: true,
      title: "Gateway status",
      blocks: [inner],
    });

    expect(vm.kind).toBe("commandResult");
    expect(vm.ok).toBe(true);
    expect(vm.title).toBe("Gateway status");
    expect(vm.blocks).toHaveLength(1);
    expect(vm.blocks[0].kind).toBe("kv");
    expect(Object.getPrototypeOf(vm)).toBe(Object.prototype);
  });

  it("buildPlainFallbackViewModel produces plain structured object", () => {
    const vm = buildPlainFallbackViewModel({
      lines: ["EstaCoda is ready", "model: openrouter/claude-sonnet"],
    });

    expect(vm.kind).toBe("plainFallback");
    expect(vm.lines).toEqual(["EstaCoda is ready", "model: openrouter/claude-sonnet"]);
    expect(Object.getPrototypeOf(vm)).toBe(Object.prototype);
  });

  it("buildStartupDashboardViewModel produces plain structured object", () => {
    const vm = buildStartupDashboardViewModel({
      agentName: "EstaCoda",
      taglines: ["⟡ SIFR01 ⟡", "السيادة التكنولوجية العربية"],
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
      availableCommands: [
        { name: "verify", description: "Check workspace, model, and skill integrity" },
        { name: "tools", description: "Browse available runtime tools" },
      ],
      warnings: [],
    });

    expect(vm.kind).toBe("startupDashboard");
    expect(vm.agentName).toBe("EstaCoda");
    expect(vm.taglines).toHaveLength(2);
    expect(vm.version).toBe("v0.0.5");
    expect(vm.sessionId).toBe("sess-9f7a2c1b");
    expect(vm.model.provider).toBe("openrouter");
    expect(vm.model.id).toBe("deepseek-reasoner");
    expect(vm.workspaceTrust).toBe("trusted");
    expect(vm.workspaceVerification).toBe("verified");
    expect(vm.workspaceDirectory).toBe("/workspace");
    expect(vm.securityMode).toBe("high");
    expect(vm.skillAutonomy).toBe("autonomous");
    expect(vm.providerReadiness).toBe("ready");
    expect(vm.versionStatus).toBe("unknown");
    expect(vm.availableCommands).toHaveLength(2);
    expect(vm.warnings).toEqual([]);
    expect(Object.getPrototypeOf(vm)).toBe(Object.prototype);
  });

  it("buildStartupDashboardViewModel defaults warnings to empty array", () => {
    const vm = buildStartupDashboardViewModel({
      agentName: "EstaCoda",
      taglines: [],
      version: "v0.0.5",
      model: { provider: "p", id: "i" },
      workspaceTrust: "unknown",
      workspaceVerification: "unknown",
      securityMode: "open",
      providerReadiness: "unknown",
      availableCommands: [],
    });

    expect(vm.warnings).toEqual([]);
  });

  it("buildStartupRuntimeViewModel produces plain structured object", () => {
    const vm = buildStartupRuntimeViewModel({
      workspaceTrust: "untrusted",
      workspaceVerification: "unverified",
      providerReadiness: "degraded",
      versionStatus: "update-available",
      warnings: [
        buildWarningErrorViewModel({ severity: "warn", title: "T", message: "M" }),
      ],
    });

    expect(vm.kind).toBe("startupRuntime");
    expect(vm.workspaceTrust).toBe("untrusted");
    expect(vm.workspaceVerification).toBe("unverified");
    expect(vm.providerReadiness).toBe("degraded");
    expect(vm.versionStatus).toBe("update-available");
    expect(vm.warnings).toHaveLength(1);
    expect(Object.getPrototypeOf(vm)).toBe(Object.prototype);
  });

  it("buildStartupRuntimeViewModel defaults warnings to empty array", () => {
    const vm = buildStartupRuntimeViewModel({
      workspaceTrust: "unknown",
      workspaceVerification: "unknown",
      providerReadiness: "missing-config",
    });

    expect(vm.warnings).toEqual([]);
  });

  it("buildConversationMessageViewModel produces plain structured object", () => {
    const vm = buildConversationMessageViewModel({
      role: "assistant",
      text: "Here are the files:",
      label: "EstaCoda",
      turnId: "turn-1",
      matchedSkills: ["file-search"],
      progress: ["searching"],
    });

    expect(vm.kind).toBe("conversationMessage");
    expect(vm.role).toBe("assistant");
    expect(vm.text).toBe("Here are the files:");
    expect(vm.label).toBe("EstaCoda");
    expect(vm.turnId).toBe("turn-1");
    expect(vm.matchedSkills).toEqual(["file-search"]);
    expect(vm.progress).toEqual(["searching"]);
    expect(Object.getPrototypeOf(vm)).toBe(Object.prototype);
  });

  it("buildActiveTurnSpinnerViewModel produces plain structured object", () => {
    const vm = buildActiveTurnSpinnerViewModel({
      label: "\u13080",
      phase: "thinking",
      elapsedMs: 1200,
    });

    expect(vm.kind).toBe("activeTurnSpinner");
    expect(vm.label).toBe("\u13080");
    expect(vm.phase).toBe("thinking");
    expect(vm.elapsedMs).toBe(1200);
    expect(Object.getPrototypeOf(vm)).toBe(Object.prototype);
  });

  it("buildToolActivityRailViewModel produces plain structured object", () => {
    const vm = buildToolActivityRailViewModel({
      events: [
        toolActivityRailEvent("terminal", "running", { elapsedMs: 500 }),
        toolActivityRailEvent("web.extract", "done", { elapsedMs: 1200, glyph: "→" }),
      ],
    });

    expect(vm.kind).toBe("toolActivityRail");
    expect(vm.events).toHaveLength(2);
    expect(vm.events[0]).toEqual({ tool: "terminal", status: "running", elapsedMs: 500 });
    expect(vm.events[1]).toEqual({ tool: "web.extract", status: "done", elapsedMs: 1200, glyph: "→" });
    expect(Object.getPrototypeOf(vm)).toBe(Object.prototype);
  });

  it("buildFileChangePreviewViewModel produces plain structured object", () => {
    const vm = buildFileChangePreviewViewModel({
      path: "src/app.ts",
      changeType: "modified",
      diff: "-old\n+new",
      hunks: [
        fileChangeHunk(1, 2, 1, 2, ["-old", "+new"]),
      ],
    });

    expect(vm.kind).toBe("fileChangePreview");
    expect(vm.path).toBe("src/app.ts");
    expect(vm.changeType).toBe("modified");
    expect(vm.diff).toBe("-old\n+new");
    expect(vm.hunks).toHaveLength(1);
    expect(vm.hunks![0]).toEqual({ oldStart: 1, oldCount: 2, newStart: 1, newCount: 2, lines: ["-old", "+new"] });
    expect(Object.getPrototypeOf(vm)).toBe(Object.prototype);
  });

  it("buildSessionStatusRailViewModel produces plain structured object", () => {
    const vm = buildSessionStatusRailViewModel({
      modelLabel: "deepseek-reasoner",
      turnState: "running",
      showTurnState: false,
      sessionElapsedMs: 3600000,
      currentTurnSeconds: 24,
      contextUsage: { filled: 3, total: 8 },
    });

    expect(vm.kind).toBe("sessionStatusRail");
    expect(vm.modelLabel).toBe("deepseek-reasoner");
    expect(vm.turnState).toBe("running");
    expect(vm.showTurnState).toBe(false);
    expect(vm.sessionElapsedMs).toBe(3600000);
    expect(vm.currentTurnSeconds).toBe(24);
    expect(vm.contextUsage).toEqual({ filled: 3, total: 8 });
    expect(Object.getPrototypeOf(vm)).toBe(Object.prototype);
  });

  it("buildShortcutHintRailViewModel produces plain structured object", () => {
    const vm = buildShortcutHintRailViewModel({
      hints: [
        shortcutHint("Ctrl+C", "Cancel"),
        shortcutHint("Tab", "Complete"),
      ],
    });

    expect(vm.kind).toBe("shortcutHintRail");
    expect(vm.hints).toHaveLength(2);
    expect(vm.hints[0]).toEqual({ key: "Ctrl+C", description: "Cancel" });
    expect(Object.getPrototypeOf(vm)).toBe(Object.prototype);
  });

  it("buildSlashMenuViewModel produces plain structured object", () => {
    const vm = buildSlashMenuViewModel({
      query: "/ver",
      options: [
        slashMenuOption("verify", "verify", { description: "Check integrity" }),
        slashMenuOption("version", "version"),
      ],
      selectedIndex: 0,
    });

    expect(vm.kind).toBe("slashMenu");
    expect(vm.query).toBe("/ver");
    expect(vm.options).toHaveLength(2);
    expect(vm.options[0]).toEqual({ id: "verify", label: "verify", description: "Check integrity" });
    expect(vm.selectedIndex).toBe(0);
    expect(Object.getPrototypeOf(vm)).toBe(Object.prototype);
  });
});

describe("ViewModel convenience helpers", () => {
  it("kv creates a KeyValueEntry", () => {
    const entry = kv("key", "value", "warn");
    expect(entry).toEqual({ key: "key", value: "value", severity: "warn" });
  });

  it("kv without severity omits severity field", () => {
    const entry = kv("key", "value");
    expect(entry).toEqual({ key: "key", value: "value" });
    expect(entry.severity).toBeUndefined();
  });

  it("listItem creates a ListItem", () => {
    const item = listItem("label", "value", "error");
    expect(item).toEqual({ label: "label", value: "value", severity: "error" });
  });

  it("timelineEvent creates a TimelineEvent with overrides", () => {
    const event = timelineEvent("browser.navigate", "running", { elapsedMs: 500 });
    expect(event).toEqual({ tool: "browser.navigate", status: "running", elapsedMs: 500 });
  });

  it("progressStep creates a ProgressStep", () => {
    const step = progressStep("Load", "done");
    expect(step).toEqual({ label: "Load", status: "done" });
  });

  it("pickerOption creates a PickerOption with overrides", () => {
    const option = pickerOption("id", "Label", { description: "desc", selected: true });
    expect(option).toEqual({ id: "id", label: "Label", description: "desc", selected: true });
  });

  it("approvalAction creates an ApprovalAction", () => {
    const action = approvalAction("allow", "Allow", "ok");
    expect(action).toEqual({ id: "allow", label: "Allow", severity: "ok" });
  });

  it("toolActivityRailEvent creates a ToolActivityRailEvent with overrides", () => {
    const event = toolActivityRailEvent("terminal", "running", { elapsedMs: 300 });
    expect(event).toEqual({ tool: "terminal", status: "running", elapsedMs: 300 });
  });

  it("fileChangeHunk creates a FileChangeHunk", () => {
    const hunk = fileChangeHunk(1, 2, 1, 2, ["-a", "+b"]);
    expect(hunk).toEqual({ oldStart: 1, oldCount: 2, newStart: 1, newCount: 2, lines: ["-a", "+b"] });
  });

  it("shortcutHint creates a ShortcutHint", () => {
    const hint = shortcutHint("Esc", "Cancel");
    expect(hint).toEqual({ key: "Esc", description: "Cancel" });
  });

  it("slashMenuOption creates a SlashMenuOption with overrides", () => {
    const option = slashMenuOption("verify", "verify", { description: "Check integrity" });
    expect(option).toEqual({ id: "verify", label: "verify", description: "Check integrity" });
  });
});

describe("ViewModel shape invariants", () => {
  it("all builders produce objects with kind discriminator", () => {
    const status = buildStatusViewModel({
      agentName: "A",
      model: { provider: "p", id: "i" },
      securityMode: "open",
      skillCount: 1,
      toolCount: 1,
      mcpActive: 0,
      mcpTotal: 0,
      workflowAvailable: false,
      workflowRunActive: false,
    });
    const table = buildTableViewModel({ columns: [], rows: [] });
    const kvBlock = buildKeyValueBlockViewModel({ entries: [] });
    const list = buildListViewModel({ items: [] });
    const warning = buildWarningErrorViewModel({ severity: "info", title: "T", message: "M" });
    const approval = buildApprovalSecurityViewModel({
      toolName: "t",
      targetSummary: "s",
      severity: "warn",
      actions: [],
    });
    const timeline = buildActivityTimelineViewModel({ events: [] });
    const progress = buildProgressContextRailViewModel({ steps: [] });
    const picker = buildPickerViewModel({ title: "T", options: [] });
    const startup = buildStartupViewModel({
      agentName: "A",
      taglines: [],
      model: { provider: "p", id: "i" },
      readiness: "ready",
    });
    const result = buildCommandResultViewModel({ ok: true, title: "T", blocks: [] });
    const plain = buildPlainFallbackViewModel({ lines: [] });
    const startupDashboard = buildStartupDashboardViewModel({
      agentName: "A",
      taglines: [],
      version: "v0",
      model: { provider: "p", id: "i" },
      workspaceTrust: "unknown",
      workspaceVerification: "unknown",
      securityMode: "open",
      providerReadiness: "unknown",
      availableCommands: [],
    });
    const startupRuntime = buildStartupRuntimeViewModel({
      workspaceTrust: "unknown",
      workspaceVerification: "unknown",
      providerReadiness: "unknown",
    });
    const conversationMessage = buildConversationMessageViewModel({ role: "assistant", text: "" });
    const activeTurnSpinner = buildActiveTurnSpinnerViewModel({});
    const toolActivityRail = buildToolActivityRailViewModel({ events: [] });
    const fileChangePreview = buildFileChangePreviewViewModel({ path: "p", changeType: "modified" });
    const sessionStatusRail = buildSessionStatusRailViewModel({ modelLabel: "m", turnState: "idle" });
    const shortcutHintRail = buildShortcutHintRailViewModel({ hints: [] });
    const slashMenu = buildSlashMenuViewModel({ query: "", options: [], selectedIndex: 0 });

    expect(status.kind).toBe("status");
    expect(table.kind).toBe("table");
    expect(kvBlock.kind).toBe("kv");
    expect(list.kind).toBe("list");
    expect(warning.kind).toBe("warning");
    expect(approval.kind).toBe("approval");
    expect(timeline.kind).toBe("timeline");
    expect(progress.kind).toBe("progress");
    expect(picker.kind).toBe("picker");
    expect(startup.kind).toBe("startup");
    expect(result.kind).toBe("commandResult");
    expect(plain.kind).toBe("plainFallback");
    expect(startupDashboard.kind).toBe("startupDashboard");
    expect(startupRuntime.kind).toBe("startupRuntime");
    expect(conversationMessage.kind).toBe("conversationMessage");
    expect(activeTurnSpinner.kind).toBe("activeTurnSpinner");
    expect(toolActivityRail.kind).toBe("toolActivityRail");
    expect(fileChangePreview.kind).toBe("fileChangePreview");
    expect(sessionStatusRail.kind).toBe("sessionStatusRail");
    expect(shortcutHintRail.kind).toBe("shortcutHintRail");
    expect(slashMenu.kind).toBe("slashMenu");
  });

  it("builder outputs contain no functions (pure data only)", () => {
    const vm = buildCommandResultViewModel({
      ok: true,
      title: "Test",
      blocks: [
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
        buildKeyValueBlockViewModel({ entries: [kv("k", "v")] }),
        buildListViewModel({ items: [listItem("i")] }),
        buildWarningErrorViewModel({ severity: "info", title: "T", message: "M" }),
        buildApprovalSecurityViewModel({
          toolName: "t",
          targetSummary: "s",
          severity: "warn",
          actions: [approvalAction("a", "A")],
        }),
        buildActivityTimelineViewModel({ events: [timelineEvent("t", "done")] }),
        buildProgressContextRailViewModel({ steps: [progressStep("s", "done")] }),
        buildPickerViewModel({ title: "T", options: [pickerOption("i", "L")] }),
        buildStartupViewModel({
          agentName: "A",
          taglines: [],
          model: { provider: "p", id: "i" },
          readiness: "ready",
        }),
        buildPlainFallbackViewModel({ lines: ["line"] }),
        buildStartupDashboardViewModel({
          agentName: "A",
          taglines: [],
          version: "v0",
          model: { provider: "p", id: "i" },
          workspaceTrust: "unknown",
          workspaceVerification: "unknown",
          securityMode: "open",
          providerReadiness: "unknown",
          availableCommands: [],
        }),
        buildStartupRuntimeViewModel({
          workspaceTrust: "unknown",
          workspaceVerification: "unknown",
          providerReadiness: "unknown",
        }),
        buildConversationMessageViewModel({ role: "assistant", text: "hello" }),
        buildActiveTurnSpinnerViewModel({}),
        buildToolActivityRailViewModel({ events: [toolActivityRailEvent("t", "done")] }),
        buildFileChangePreviewViewModel({ path: "p", changeType: "added" }),
        buildSessionStatusRailViewModel({ modelLabel: "m", turnState: "running" }),
        buildShortcutHintRailViewModel({ hints: [shortcutHint("k", "d")] }),
        buildSlashMenuViewModel({ query: "/", options: [slashMenuOption("i", "L")], selectedIndex: 0 }),
      ],
    });

    function assertNoFunctions(value: unknown): void {
      if (value === null || value === undefined) return;
      if (typeof value === "function") {
        throw new Error("ViewModel must not contain functions");
      }
      if (typeof value === "object") {
        for (const v of Object.values(value)) {
          assertNoFunctions(v);
        }
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          assertNoFunctions(item);
        }
      }
    }

    assertNoFunctions(vm);
  });

  it("builder outputs contain no ANSI escape codes", () => {
    const vm = buildCommandResultViewModel({
      ok: true,
      title: "Test",
      blocks: [
        buildPlainFallbackViewModel({ lines: ["plain text"] }),
        buildWarningErrorViewModel({ severity: "error", title: "Title", message: "Message" }),
      ],
    });

    function assertNoAnsi(value: unknown): void {
      if (typeof value === "string") {
        expect(value).not.toMatch(/\x1b\[/);
      } else if (Array.isArray(value)) {
        for (const item of value) assertNoAnsi(item);
      } else if (value !== null && typeof value === "object") {
        for (const v of Object.values(value)) assertNoAnsi(v);
      }
    }

    assertNoAnsi(vm);
  });
});
