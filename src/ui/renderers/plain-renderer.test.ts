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
import { closeOpenBidiIsolates, isolateLtr, isolateRtl, LRI, PDI, RLI } from "../bidi.js";
import { measureVisibleWidth } from "./layout.js";

function assertNoAnsi(text: string): void {
  expect(text).not.toMatch(/\x1b\[/);
}

function assertAsciiSafe(text: string): void {
  for (const ch of text) {
    expect(ch.charCodeAt(0)).toBeLessThan(128);
  }
}

function stripTrailingBidiControls(text: string): string {
  return text.replace(new RegExp(`[${LRI}${RLI}${PDI}]+$`, "gu"), "");
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

function countBidiControl(line: string, control: string): number {
  return [...line].filter((char) => char === control).length;
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

  it("renders structured generic prompt-card rows with badges, current, ordinary Back/Cancel, and hint", () => {
    const out = renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({
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
      hint: "Type a number to choose.",
    }));

    expect(out).toContain("  Name");
    expect(out).toContain("Description");
    expect(out).toContain("Current: Alpha");
    expect(out).toContain("> Alpha");
    expect(out).toContain("First generic option");
    expect(out).toContain("Recommended  Current");
    expect(out).toContain("  Beta");
    expect(out).toContain("Back");
    expect(out).toContain("Cancel");
    expect(out).toContain("Type a number to choose.");
    const lines = out.split("\n");
    const backIndex = lines.findIndex((line) => line.includes("Back"));
    const cancelIndex = lines.findIndex((line) => line.includes("Cancel"));
    expect(backIndex).toBeGreaterThan(0);
    expect(lines[backIndex - 1]).toBe("");
    expect(cancelIndex).toBe(backIndex + 1);
    assertNoAnsi(out);
  });

  it("renders strong prompt-card body line metadata as readable plain text", () => {
    const out = renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({
      title: "Setup editor",
      bodyLines: ["Choose what to configure:"],
      bodyLineStyles: [{ emphasis: "strong" }],
      options: [
        { id: "primary", label: "Primary model", description: "Default model used by the agent." },
      ],
      selectedOptionIndex: 0,
    }));

    expect(out).toContain("Choose what to configure:");
    assertNoAnsi(out);
  });

  it("hides structured prompt-card headers when explicitly disabled", () => {
    const out = renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({
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
    }));

    expect(out).not.toContain("  Name");
    expect(out).not.toContain("Description");
    const selectedLine = out.split("\n").find((line) => line.includes("> Alpha"));
    const betaLine = out.split("\n").find((line) => line.includes("  Beta"));
    expect(selectedLine).toBeDefined();
    expect(selectedLine).toContain("First generic option");
    expect(betaLine).toBeDefined();
    expect(betaLine).toContain("Second generic option");
    assertNoAnsi(out);
  });

  it("inserts one generic separator before non-structured navigation prompt-card rows", () => {
    const out = renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({
      title: "Choose mode",
      bodyLines: [],
      options: [
        { id: "alpha", label: "Alpha" },
        { id: "beta", label: "Beta" },
        { id: "back", label: "Back", group: "navigation" },
        { id: "cancel", label: "Cancel", group: "navigation" },
      ],
      selectedOptionIndex: 0,
    }));

    const lines = out.split("\n");
    const backIndex = lines.findIndex((line) => line.includes("Back"));
    const cancelIndex = lines.findIndex((line) => line.includes("Cancel"));
    expect(lines[backIndex - 1]).toBe("");
    expect(cancelIndex).toBe(backIndex + 1);
    assertNoAnsi(out);
  });

  it("renders prompt-card status lines readably without color", () => {
    const out = renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({
      title: "Choose mode",
      bodyLines: [],
      statusLines: [
        { text: "Current: Alpha", tone: "active", direction: "ltr" },
      ],
      options: [{ id: "alpha", label: "Alpha" }],
      selectedOptionIndex: 0,
    }));

    expect(out).toContain("Current: Alpha");
    assertNoAnsi(out);
  });

  it("resolves prompt-card status auto direction from card direction instead of locale", () => {
    const out = renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({
      title: "Choose mode",
      bodyLines: [],
      statusLines: [
        { text: "Current: Alpha", direction: "auto" },
      ],
      options: [{ id: "alpha", label: "Alpha" }],
      selectedOptionIndex: 0,
      locale: "ar",
      direction: "ltr",
    }), "ar");

    expect(out).toContain(isolateLtr("Current: Alpha"));
    expect(out).not.toContain(isolateRtl("Current: Alpha"));
    assertNoAnsi(out);
  });

  it("suppresses automatic current badges while preserving explicit badges", () => {
    const out = renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({
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
    }));

    const selectedLine = out.split("\n").find((line) => line.includes("> Alpha"));
    expect(selectedLine).toBeDefined();
    expect(selectedLine).toContain("Recommended");
    expect(selectedLine).not.toContain("Current");
    assertNoAnsi(out);
  });

  it("renders structured columns from label and description without cells", () => {
    const out = renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({
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
    }));

    const selectedLine = out.split("\n").find((line) => line.includes("> Alpha"));
    expect(selectedLine).toBeDefined();
    expect(selectedLine).toContain("First generic option");
    expect(out).toContain("Description");
    assertNoAnsi(out);
  });

  it("renders compact structured prompt-card tables as content-width blocks", () => {
    const out = renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({
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
    }));

    const selectedLine = out.split("\n").find((line) => line.includes("Alpha"));
    expect(selectedLine).toBeDefined();
    expect(measureVisibleWidth(selectedLine!.trimStart())).toBeLessThan(40);
    expect(selectedLine!.startsWith("> Alpha")).toBe(true);
    expect(selectedLine).toContain("Current");
  });

  it("caps compact structured plain prompt-card tables with tableMaxWidth", () => {
    const out = renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({
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
    }));

    const selectedLine = out.split("\n").find((line) => line.includes("Alpha"));
    expect(selectedLine).toBeDefined();
    expect(measureVisibleWidth(selectedLine!.trimStart())).toBeLessThanOrEqual(36);
    expect(selectedLine).toContain("...");
  });

  it("physically aligns compact structured plain prompt-card tables", () => {
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
      const out = renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({ ...base, tableAlign }));
      return out.split("\n").find((line) => line.includes("Alpha")) ?? "";
    };

    const left = lineFor("left");
    const center = lineFor("center");
    const right = lineFor("right");
    expect(left.indexOf(">")).toBe(0);
    expect(center.indexOf(">")).toBeGreaterThan(left.indexOf(">"));
    expect(right.indexOf(">")).toBeGreaterThan(center.indexOf(">"));
  });

  it("truncates long structured plain rows readably", () => {
    const out = renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({
      title: "Choose mode",
      bodyLines: [],
      columns: [
        { key: "name", header: "Name" },
        { key: "description", header: "Description" },
      ],
      options: [
        {
          id: "alpha",
          label: "Alpha option with a long name",
          cells: {
            name: "Alpha option with a long name",
            description: "A very long generic option description that should truncate in deterministic plain rendering.",
          },
          current: true,
        },
      ],
      selectedOptionIndex: 0,
    }));

    expect(out).toContain("...");
    expect(out).toContain("Current");
    for (const line of out.split("\n")) {
      expect(measureVisibleWidth(line)).toBeLessThanOrEqual(94);
    }
  });

  it("keeps current visible when structured plain descriptions are long", () => {
    const out = renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({
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
    }));

    const selectedLine = out.split("\n").find((line) => line.includes("> Alpha"));
    expect(selectedLine).toBeDefined();
    expect(selectedLine).toContain("...");
    expect(selectedLine).toContain("Current");
    assertNoAnsi(out);
  });

  it("isolates Arabic technical lines and keeps selected marker after the label", () => {
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
    expect(out).toContain(`${isolateRtl("ثق بمساحة العمل")} >`);
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

  it("keeps Arabic structured row marker placement stable", () => {
    const out = renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({
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
          cells: { name: "ألفا", description: `خيار عام مع ${isolateLtr("CLI")}.` },
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
    }), "ar");

    const selectedLine = out.split("\n").find((line) => line.includes(isolateLtr("CLI")));
    expect(selectedLine).toBeDefined();
    expect(selectedLine!.startsWith("> ")).toBe(true);
    expect(out).toContain(isolateLtr("CLI"));
  });

  it("renders explicit RTL structured prompt-card rows in declared physical column order", () => {
    const out = renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({
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
          cells: { description: `خيار عام مع ${isolateLtr("CLI")}.`, name: "ألفا" },
        },
        {
          id: "back",
          label: "رجوع",
          group: "navigation",
          cells: { description: "ارجع إلى الخطوة السابقة.", name: "رجوع" },
        },
      ],
      selectedOptionIndex: 0,
      locale: "ar",
      direction: "rtl",
    }), "ar");

    expect(out).not.toContain("التفاصيل");
    expect(out).not.toContain("الاسم");
    const selectedLine = out.split("\n").find((line) => line.includes("ألفا"));
    expect(selectedLine).toBeDefined();
    expect(selectedLine!.indexOf("خيار عام")).toBeLessThan(selectedLine!.indexOf("ألفا"));
    expect(selectedLine!.indexOf("ألفا")).toBeLessThan(selectedLine!.indexOf("<"));
    expect(stripTrailingBidiControls(selectedLine!.trimEnd()).endsWith("<")).toBe(true);
    expect(out).toContain(isolateLtr("CLI"));
    const lines = out.split("\n");
    const backIndex = lines.findIndex((line) => line.includes("رجوع"));
    expect(backIndex).toBeGreaterThan(0);
    expect(lines[backIndex - 1]).toBe("");
  });

  it("uses label and description fallback in explicit RTL prompt-card tables", () => {
    const out = renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({
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
    }), "ar");

    const selectedLine = out.split("\n").find((line) => line.includes("ألفا"));
    expect(selectedLine).toBeDefined();
    const descriptionIndex = selectedLine!.indexOf("وصف عربي");
    const labelIndex = selectedLine!.indexOf("ألفا");
    expect(descriptionIndex).toBeGreaterThanOrEqual(0);
    expect(labelIndex).toBeGreaterThan(descriptionIndex);
    expect(labelIndex - descriptionIndex).toBeGreaterThan(20);
    const markerIndex = selectedLine!.indexOf("<");
    expect(markerIndex).toBeGreaterThan(labelIndex);
    expect(markerIndex - labelIndex).toBeLessThan(12);
    expect(stripTrailingBidiControls(selectedLine!.trimEnd()).endsWith("<")).toBe(true);
  });

  it("keeps Arabic descriptions with technical tokens in the RTL description column", () => {
    const description = `اضبط كيف تعثر ${isolateLtr("EstaCoda")} على نتائج الويب وتسترجعها.`;
    const out = renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({
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
    }), "ar");

    const selectedLine = out.split("\n").find((line) => line.includes("البحث"));
    expect(selectedLine).toBeDefined();
    expect(selectedLine).toContain(isolateRtl(closeOpenBidiIsolates(description)));
    expect(selectedLine).not.toContain(isolateLtr(description));
    expect(selectedLine!.indexOf("اضبط كيف")).toBeLessThan(selectedLine!.indexOf("البحث"));
    expect(stripTrailingBidiControls(selectedLine!.trimEnd()).endsWith("<")).toBe(true);
  });

  it("keeps RTL structured prompt-card markers in one fixed visible column", () => {
    const base = {
      title: "محرر الإعدادات",
      bodyLines: [],
      showColumnHeaders: false,
      tableDirection: "rtl" as const,
      tableWidth: "content" as const,
      tableMaxWidth: 88,
      tableAlign: "right" as const,
      columns: [
        { key: "description", header: "التفاصيل", align: "right" as const },
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
      const out = renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({
        ...base,
        selectedOptionIndex,
      }), "ar");
      return out.split("\n").find((line) => line.includes("<")) ?? "";
    };

    const firstMarkerColumn = visibleMarkerColumn(markerLineFor(0), "<");
    const lastMarkerColumn = visibleMarkerColumn(markerLineFor(2), "<");
    expect(lastMarkerColumn).toBe(firstMarkerColumn);
  });

  it("renders Arabic setup-editor style RTL rows as physical cells without a row-level LTR isolate", () => {
    const base = {
      title: "محرّر الإعدادات",
      bodyLines: ["اختار اللي تحب تضبطه:"],
      showColumnHeaders: false,
      tableDirection: "rtl" as const,
      tableWidth: "content" as const,
      tableMaxWidth: 88,
      tableAlign: "right" as const,
      columns: [
        { key: "description", header: "التفاصيل", align: "right" as const },
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
    const renderedFor = (selectedOptionIndex: number) => renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({
      ...base,
      selectedOptionIndex,
    }), "ar");
    const markerLineFor = (selectedOptionIndex: number) =>
      renderedFor(selectedOptionIndex).split("\n").find((line) => line.includes("<")) ?? "";

    const auxiliaryLine = markerLineFor(2);
    expect(auxiliaryLine.trimStart().startsWith(LRI)).toBe(true);
    expect(countBidiControl(auxiliaryLine, LRI)).toBeGreaterThanOrEqual(3);
    expect(auxiliaryLine.indexOf("نماذج تُستخدم")).toBeLessThan(auxiliaryLine.indexOf("النماذج المساعدة"));
    expect(stripTrailingBidiControls(auxiliaryLine.trimEnd()).endsWith("<")).toBe(true);

    const searchLine = markerLineFor(4);
    expect(searchLine).toContain(isolateLtr("EstaCoda"));
    expect(searchLine.indexOf("اضبط كيف")).toBeLessThan(searchLine.indexOf("البحث"));
    expect(visibleMarkerColumn(searchLine, "<")).toBe(visibleMarkerColumn(auxiliaryLine, "<"));
    expect(visibleTextEndColumn(searchLine, "البحث")).toBe(visibleTextEndColumn(auxiliaryLine, "النماذج المساعدة"));

    const evolutionLine = markerLineFor(5);
    expect(evolutionLine).toContain(isolateLtr("Agent Evolution"));
    expect(evolutionLine.indexOf("مقترحات تحسين")).toBeLessThan(evolutionLine.indexOf("Agent Evolution"));
    expect(visibleMarkerColumn(evolutionLine, "<")).toBe(visibleMarkerColumn(auxiliaryLine, "<"));
    expect(visibleTextEndColumn(evolutionLine, "Agent Evolution")).toBe(visibleTextEndColumn(auxiliaryLine, "النماذج المساعدة"));

    const channelLine = renderedFor(2).split("\n").find((line) => line.includes("Telegram"));
    expect(channelLine).toContain(isolateLtr("Telegram"));
    expect(channelLine).toContain(isolateLtr("WhatsApp"));
  });

  it("renders Arabic prompt-card hints as LTR technical text", () => {
    const out = renderOnboardingPromptCard(buildOnboardingPromptCardViewModel({
      title: "اختر الوضع",
      bodyLines: ["اختر وضعًا عامًا."],
      options: [{ id: "alpha", label: "ألفا" }],
      selectedOptionIndex: 0,
      hint: "↑↓ navigate   ENTER select   CTRL+C exit",
      locale: "ar",
      direction: "rtl",
    }), "ar");

    expect(out).toContain(isolateLtr("↑↓ navigate   ENTER select   CTRL+C exit"));
    assertNoAnsi(out);
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
      workflowAvailable: true,
      workflowRunActive: true,
    });
    const out = renderStatus(vm);
    expect(out).toContain("EstaCoda is ready");
    expect(out).toContain("model: openrouter/claude-sonnet-4");
    expect(out).toContain("security: open");
    expect(out).toContain("skills: 12 (suggest)");
    expect(out).toContain("tools: 34");
    expect(out).toContain("mcp: 2/3");
    expect(out).toContain("workflow run: active");
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
      workflowAvailable: false,
      workflowRunActive: false,
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
      workflowAvailable: false,
      workflowRunActive: false,
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
      workflowAvailable: true,
      workflowRunActive: true,
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

  it("renders only the visible model label for fallback-serving state", () => {
    const vm = buildSessionStatusRailViewModel({
      modelLabel: "deepseek-v4-pro",
      modelState: "fallback-serving",
      configuredModelLabel: "kimi-k2.7-code",
      servingModelLabel: "deepseek-v4-pro",
      turnState: "idle",
      showTurnState: false,
    });
    const out = renderSessionStatusRail(vm);

    expect(out).toBe("* deepseek-v4-pro");
    expect(out).not.toContain("->");
    expect(out).not.toContain("fallback(");
    expect(out).not.toContain("kimi-k2.7-code");
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
      sessionElapsedMs: 86_000,
    });
    const out = renderSessionStatusRail(vm, "ar");
    expect(out).toContain(isolateLtr(`* ${isolateLtr("openai/gpt-4.1")} | ${isolateRtl("السياق")} ${isolateLtr("1.0k/128k")} | 1% | ${isolateLtr("الجلسة 1د 26ث")} | ${isolateRtl("خامل")}`));
    expect(out).not.toContain("1m 26s");
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

  it("renders user prompt rail with ASCII marker", () => {
    const vm = buildUserPromptRailViewModel({ text: "Hello, world!" });
    const out = renderUserPromptRail(vm);
    expect(out).toBe("> Hello, world!");
    assertNoAnsi(out);
    assertAsciiSafe(out);
  });

  it("dispatches user prompt rail through renderPlain", () => {
    const vm = buildUserPromptRailViewModel({ text: "Plain dispatch" });
    const out = renderPlain(vm);
    expect(out).toBe("> Plain dispatch");
    assertNoAnsi(out);
    assertAsciiSafe(out);
  });

  it("renders multiline user prompt rail with indented continuations", () => {
    const vm = buildUserPromptRailViewModel({ text: "line one\nline two" });
    const out = renderUserPromptRail(vm);
    expect(out).toBe("> line one\n  line two");
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
