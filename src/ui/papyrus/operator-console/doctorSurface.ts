import { isolateLtr, isolateRtl } from "../../bidi.js";
import {
  measureVisibleWidth,
  padVisibleEnd,
  padVisibleStart,
  truncateVisible,
  wrapText
} from "../../renderers/layout.js";
import {
  styleBold,
  styleColor,
  type OperatorConsoleStyle
} from "./operatorConsoleStyle.js";
import type {
  DoctorAction,
  DoctorCheck,
  DoctorCheckSeverity,
  DoctorLocale,
  DoctorProviderRoute,
  DoctorReport
} from "../../../doctor/types.js";

export type DoctorSurfaceRenderOptions = {
  readonly width?: number;
  readonly style?: OperatorConsoleStyle;
};

const DEFAULT_WIDTH = 72;
const MIN_WIDTH = 48;
const MAX_WIDTH = 100;

export function renderDoctorSurface(
  report: DoctorReport,
  options: DoctorSurfaceRenderOptions = {}
): string {
  const width = clampWidth(options.width ?? DEFAULT_WIDTH);
  const contentWidth = Math.max(1, width - 4);
  const copy = doctorSurfaceCopy(report.locale);
  const rows: string[] = [
    ...renderHeader(report, width, contentWidth, copy, options.style),
    "",
    sectionHeading(copy.checks, options.style),
    "",
    ...renderChecks(report, contentWidth, options.style),
    "",
    ...renderProviderRoutesSection(report.providerRoutes, report.locale, contentWidth, copy, options.style),
    ...renderVerdict(report, width, contentWidth, copy, options.style),
    "",
    sectionHeading(copy.actions, options.style),
    "",
    ...renderActions(report.actions, report.locale, contentWidth, copy, options.style),
  ];

  if (report.notes.length > 0) {
    rows.push("", sectionHeading(copy.notes, options.style), "", ...report.notes.map((note) => `  ${copy.noteMarker} ${localizeDynamicText(note, report.locale)}`));
  }

  return rows.join("\n");
}

function renderProviderRoutesSection(
  routes: readonly DoctorProviderRoute[],
  locale: DoctorLocale,
  contentWidth: number,
  copy: DoctorSurfaceCopy,
  style: OperatorConsoleStyle | undefined
): readonly string[] {
  if (routes.length === 0) return [];
  return [
    sectionHeading(copy.providerRoutes, style),
    "",
    ...renderProviderRoutes(routes, locale, contentWidth, style),
    ""
  ];
}

function renderHeader(
  report: DoctorReport,
  width: number,
  contentWidth: number,
  copy: DoctorSurfaceCopy,
  style: OperatorConsoleStyle | undefined
): readonly string[] {
  const rows = [
    copy.subtitle,
    pairLine(copy.profile, technical(report.profile, report.locale), report.locale),
    pairLine(copy.workspace, technical(report.workspace, report.locale), report.locale),
    pairLine(copy.home, technical(report.home, report.locale), report.locale),
    pairLine(copy.model, technical(report.model, report.locale), report.locale),
  ];
  return frameRows(copy.title, rows, width, contentWidth, style, "ok");
}

function renderVerdict(
  report: DoctorReport,
  width: number,
  contentWidth: number,
  copy: DoctorSurfaceCopy,
  style: OperatorConsoleStyle | undefined
): readonly string[] {
  return frameRows(copy.verdict, [
    report.verdict.title,
    copy.counts(report.verdict)
  ], width, contentWidth, style, "brand");
}

function renderChecks(report: DoctorReport, contentWidth: number, style: OperatorConsoleStyle | undefined): readonly string[] {
  const checks = report.sections.flatMap((section) => section.checks);
  const labelWidth = Math.min(
    24,
    Math.max(12, ...checks.map((check) => visibleLengthEstimate(check.label)))
  );
  const summaryWidth = Math.max(8, contentWidth - labelWidth - 7);
  return checks.map((check) => {
    const icon = severityIcon(check.severity, style);
    const label = report.locale === "ar"
      ? padVisibleStart(check.label, labelWidth)
      : padVisibleEnd(check.label, labelWidth);
    const summary = check.summary === undefined ? "" : truncateVisible(localizeDynamicText(check.summary, report.locale), summaryWidth);
    return `  ${icon} ${label}${summary.length === 0 ? "" : `  ${summary}`}`;
  });
}

function renderActions(
  actions: readonly DoctorAction[],
  locale: DoctorLocale,
  contentWidth: number,
  copy: DoctorSurfaceCopy,
  style: OperatorConsoleStyle | undefined
): readonly string[] {
  if (actions.length === 0) {
    return [`  ${copy.noteMarker} ${copy.noActions}`];
  }

  const rows: string[] = [];
  for (const action of actions) {
    rows.push(`  ${severityIcon(action.severity, style)} ${localizeDynamicText(action.title, locale)}`);
    for (const detail of action.detailLines ?? []) {
      for (const line of wrapText(localizeDynamicText(detail, locale), Math.max(1, contentWidth - 4))) {
        rows.push(`    ${line}`);
      }
    }
    if (action.command !== undefined) {
      const commandLabel = action.severity === "info" ? copy.runLabel : copy.fixLabel;
      rows.push(`    ${commandLabel}: ${technical(action.command, locale)}`);
    }
    rows.push("");
  }
  rows.pop();
  return rows;
}

function renderProviderRoutes(
  routes: readonly DoctorProviderRoute[],
  locale: DoctorLocale,
  contentWidth: number,
  style: OperatorConsoleStyle | undefined
): readonly string[] {
  const labelWidth = Math.min(18, Math.max(8, ...routes.map((route) => visibleLengthEstimate(route.label))));
  const rows: string[] = [];
  for (const route of routes) {
    const labelText = locale === "ar"
      ? padVisibleStart(route.label, labelWidth)
      : padVisibleEnd(route.label, labelWidth);
    const hasConcreteRoute = route.provider !== undefined && route.model !== undefined;
    const model = hasConcreteRoute ? `${route.provider}/${route.model}` : route.summary;
    const prefix = `  ${routeStatusIcon(route.status, style)} ${labelText}  `;
    const modelText = localizeDynamicText(model, locale);
    const summary = hasConcreteRoute ? localizeDynamicText(route.summary, locale) : "";
    const fullLine = `${prefix}${modelText}${summary.length === 0 ? "" : `  ${summary}`}`;
    if (visibleLengthEstimate(fullLine) <= contentWidth) {
      rows.push(fullLine);
      continue;
    }

    const routeWidth = Math.max(8, contentWidth - visibleLengthEstimate(prefix));
    const routeLines = wrapText(modelText, routeWidth);
    rows.push(`${prefix}${routeLines[0] ?? ""}`);
    for (const continuation of routeLines.slice(1)) {
      rows.push(`${" ".repeat(visibleLengthEstimate(prefix))}${continuation}`);
    }
    if (summary.length > 0 && summary !== modelText) {
      for (const line of wrapText(summary, Math.max(8, contentWidth - 4))) {
        rows.push(`    ${line}`);
      }
    }
  }
  return rows;
}

function frameRows(
  title: string,
  rows: readonly string[],
  width: number,
  contentWidth: number,
  style: OperatorConsoleStyle | undefined,
  titleTone: "brand" | "accent" | "ok" | "none" = "none"
): readonly string[] {
  const top = renderTopBorder(title, width, style, titleTone);
  const body = rows.map((row) => renderFrameRow(row, contentWidth));
  return [
    top,
    ...body,
    renderBottomBorder(width),
  ];
}

function renderTopBorder(
  title: string,
  width: number,
  style: OperatorConsoleStyle | undefined,
  titleTone: "brand" | "accent" | "ok" | "none"
): string {
  const styledTitle = styleFrameTitle(title, style, titleTone);
  const label = ` ${styledTitle} `;
  const remaining = Math.max(0, width - 2 - visibleLengthEstimate(label));
  return `╭─${label}${"─".repeat(Math.max(0, remaining - 1))}╮`;
}

function renderBottomBorder(width: number): string {
  return `╰${"─".repeat(Math.max(0, width - 2))}╯`;
}

function renderFrameRow(row: string, contentWidth: number): string {
  return `│ ${padVisibleEnd(truncateVisible(row, contentWidth), contentWidth)} │`;
}

function pairLine(label: string, value: string, locale: DoctorLocale): string {
  if (locale === "ar") {
    return `${padVisibleStart(label, 14)}   ${value}`;
  }
  return `${padVisibleEnd(`${label}:`, 12)} ${value}`;
}

function sectionHeading(label: string, style: OperatorConsoleStyle | undefined): string {
  return styleColor(style, styleBold(style, `◇ ${label}`), style?.tokens.contract.palette.accent ?? "");
}

function severityIcon(severity: DoctorCheckSeverity | DoctorAction["severity"], style: OperatorConsoleStyle | undefined): string {
  switch (severity) {
    case "healthy":
      return styleColor(style, "✓", style?.tokens.contract.severity.ok ?? "");
    case "info":
      return "•";
    case "warning":
      return styleColor(style, "▲", style?.tokens.contract.palette.caution ?? "");
    case "blocked":
      return styleColor(style, "✕", style?.tokens.contract.severity.error ?? "");
  }
}

function routeStatusIcon(status: DoctorProviderRoute["status"], style: OperatorConsoleStyle | undefined): string {
  switch (status) {
    case "ready":
      return styleColor(style, "✓", style?.tokens.contract.severity.ok ?? "");
    case "warning":
      return styleColor(style, "▲", style?.tokens.contract.palette.caution ?? "");
    case "blocked":
      return styleColor(style, "✕", style?.tokens.contract.severity.error ?? "");
    case "disabled":
      return "•";
  }
}

function technical(value: string, locale: DoctorLocale): string {
  return locale === "ar" ? isolateLtr(value) : value;
}

function localizeDynamicText(value: string, locale: DoctorLocale): string {
  if (locale !== "ar") return value;
  const translated = translateDoctorDynamicText(value);
  if (translated !== undefined) return translated;
  if (/[\u0600-\u06ff]/u.test(value)) return isolateRtl(value);
  return isolateLtr(value);
}

function translateDoctorDynamicText(value: string): string | undefined {
  const memoryFile = /^Memory file will be created on first write: (.+)$/u.exec(value)?.[1];
  if (memoryFile !== undefined) {
    return isolateRtl(`سيتم إنشاء ملف الذاكرة عند أول كتابة: ${isolateLtr(memoryFile)}`);
  }
  const memoryState = /^Memory supporting state will be created by doctor --fix: (.+)$/u.exec(value)?.[1];
  if (memoryState !== undefined) {
    return isolateRtl(`سيتم إنشاء حالة الذاكرة المساندة عبر ${isolateLtr("doctor --fix")}: ${isolateLtr(memoryState)}`);
  }
  const sqlitePath = /^SQLite session DB is not initialized: (.+)$/u.exec(value)?.[1];
  if (sqlitePath !== undefined) {
    return isolateRtl(`قاعدة بيانات الجلسات غير مهيأة: ${isolateLtr(sqlitePath)}`);
  }
  const optionalPython = /^Optional managed Python capabilities not installed: (.+)$/u.exec(value)?.[1];
  if (optionalPython !== undefined) {
    return isolateRtl(`قدرات Python المُدارة الاختيارية غير مثبتة: ${isolateLtr(optionalPython)}`);
  }
  if (value === "Dependency audit not run.") {
    return isolateRtl("لم يتم تشغيل فحص أمان الاعتماديات.");
  }
  if (value === "System Python 3 was not found; managed Python setup would require Python 3.") {
    return isolateRtl(`لم يتم العثور على ${isolateLtr("Python 3")}؛ إعداد بيئة Python المُدارة يتطلب ${isolateLtr("Python 3")}.`);
  }
  if (value === "No configured feature currently requires a managed Python environment.") {
    return isolateRtl("لا توجد ميزة مفعّلة تتطلب بيئة Python مُدارة حاليًا.");
  }
  if (value === "pack registry: no packs installed") {
    return isolateRtl("سجل الحزم: لا توجد حزم مثبتة");
  }
  const packInstalled = /^pack registry: (\d+) installed$/u.exec(value)?.[1];
  if (packInstalled !== undefined) {
    return isolateRtl(`سجل الحزم: ${isolateLtr(packInstalled)} مثبتة`);
  }
  const packsDisabled = /^(\d+) pack\(s\) disabled$/u.exec(value)?.[1];
  if (packsDisabled !== undefined) {
    return isolateRtl(`${isolateLtr(packsDisabled)} حزم معطلة`);
  }
  return undefined;
}

function clampWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_WIDTH;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.trunc(width)));
}

function visibleLengthEstimate(value: string): number {
  return measureVisibleWidth(value);
}

function styleFrameTitle(
  title: string,
  style: OperatorConsoleStyle | undefined,
  tone: "brand" | "accent" | "ok" | "none"
): string {
  if (tone === "none") return title;
  const color = tone === "brand"
    ? style?.tokens.contract.palette.brand
    : tone === "ok"
      ? style?.tokens.contract.severity.ok
      : style?.tokens.contract.palette.accent;
  return styleColor(style, styleBold(style, title), color ?? "");
}

type DoctorSurfaceCopy = {
  readonly title: string;
  readonly subtitle: string;
  readonly profile: string;
  readonly workspace: string;
  readonly home: string;
  readonly model: string;
  readonly checks: string;
  readonly providerRoutes: string;
  readonly verdict: string;
  readonly actions: string;
  readonly notes: string;
  readonly noteMarker: string;
  readonly fixLabel: string;
  readonly runLabel: string;
  readonly noActions: string;
  readonly counts: (verdict: DoctorReport["verdict"]) => string;
};

function doctorSurfaceCopy(locale: DoctorLocale): DoctorSurfaceCopy {
  if (locale === "ar") {
    return {
      title: `${isolateLtr("𓂀  EstaCoda")} طبيب`,
      subtitle: "فحص صحة النظام",
      profile: "الملف الشخصي",
      workspace: "مساحة العمل",
      home: "المنزل",
      model: "النموذج",
      checks: "الفحوصات",
      providerRoutes: "مسارات المزوّد",
      verdict: `${isolateLtr("𓂀")}  النتيجة`,
      actions: "الإجراءات",
      notes: "ملاحظات",
      noteMarker: "•",
      fixLabel: "الإصلاح",
      runLabel: "تشغيل",
      noActions: "لا توجد إجراءات مطلوبة",
      counts: (verdict) => `${verdict.blockedCount} محظور · ${verdict.warningCount} تحذيرات · ${verdict.healthyCount} سليمة`,
    };
  }

  return {
    title: "𓂀  EstaCoda Doctor",
    subtitle: "System health inspection",
    profile: "Profile",
    workspace: "Workspace",
    home: "Home",
    model: "Model",
    checks: "Checks",
    providerRoutes: "Provider Routes",
    verdict: "𓂀  Verdict",
    actions: "Actions",
    notes: "Notes",
    noteMarker: "•",
    fixLabel: "Fix",
    runLabel: "Run",
    noActions: "No actions needed",
    counts: (verdict) => `${verdict.blockedCount} blocked · ${verdict.warningCount} warnings · ${verdict.healthyCount} healthy`,
  };
}
