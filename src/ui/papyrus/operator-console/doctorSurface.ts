import { isolateLtr, isolateRtl } from "../../bidi.js";
import {
  measureVisibleWidth,
  padVisibleEnd,
  padVisibleStart,
  truncateVisible,
  wrapText
} from "../../renderers/layout.js";
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
    ...renderHeader(report, width, contentWidth, copy),
    "",
    sectionHeading(copy.checks),
    "",
    ...renderChecks(report, contentWidth),
    "",
    ...renderProviderRoutesSection(report.providerRoutes, report.locale, contentWidth, copy),
    ...renderVerdict(report, width, contentWidth, copy),
    "",
    sectionHeading(copy.actions),
    "",
    ...renderActions(report.actions, report.locale, contentWidth, copy),
  ];

  if (report.notes.length > 0) {
    rows.push("", sectionHeading(copy.notes), "", ...report.notes.map((note) => `  ${copy.noteMarker} ${localizeDynamicText(note, report.locale)}`));
  }

  return rows.join("\n");
}

function renderProviderRoutesSection(
  routes: readonly DoctorProviderRoute[],
  locale: DoctorLocale,
  contentWidth: number,
  copy: DoctorSurfaceCopy
): readonly string[] {
  if (routes.length === 0) return [];
  return [
    sectionHeading(copy.providerRoutes),
    "",
    ...renderProviderRoutes(routes, locale, contentWidth),
    ""
  ];
}

function renderHeader(
  report: DoctorReport,
  width: number,
  contentWidth: number,
  copy: DoctorSurfaceCopy
): readonly string[] {
  const rows = [
    copy.subtitle,
    pairLine(copy.profile, technical(report.profile, report.locale), report.locale),
    pairLine(copy.workspace, technical(report.workspace, report.locale), report.locale),
    pairLine(copy.home, technical(report.home, report.locale), report.locale),
    pairLine(copy.model, technical(report.model, report.locale), report.locale),
  ];
  return frameRows(copy.title, rows, width, contentWidth);
}

function renderVerdict(
  report: DoctorReport,
  width: number,
  contentWidth: number,
  copy: DoctorSurfaceCopy
): readonly string[] {
  return frameRows(copy.verdict, [
    report.verdict.title,
    copy.counts(report.verdict)
  ], width, contentWidth);
}

function renderChecks(report: DoctorReport, contentWidth: number): readonly string[] {
  const checks = report.sections.flatMap((section) => section.checks);
  const labelWidth = Math.min(
    24,
    Math.max(12, ...checks.map((check) => visibleLengthEstimate(check.label)))
  );
  const summaryWidth = Math.max(8, contentWidth - labelWidth - 7);
  return checks.map((check) => {
    const icon = severityIcon(check.severity);
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
  copy: DoctorSurfaceCopy
): readonly string[] {
  if (actions.length === 0) {
    return [`  ${copy.noteMarker} ${copy.noActions}`];
  }

  const rows: string[] = [];
  for (const action of actions) {
    rows.push(`  ${severityIcon(action.severity)} ${localizeDynamicText(action.title, locale)}`);
    for (const detail of action.detailLines ?? []) {
      for (const line of wrapText(localizeDynamicText(detail, locale), Math.max(1, contentWidth - 4))) {
        rows.push(`    ${line}`);
      }
    }
    if (action.command !== undefined) {
      rows.push(`    ${copy.fixLabel}: ${technical(action.command, locale)}`);
    }
    rows.push("");
  }
  rows.pop();
  return rows;
}

function renderProviderRoutes(
  routes: readonly DoctorProviderRoute[],
  locale: DoctorLocale,
  contentWidth: number
): readonly string[] {
  const labelWidth = Math.min(18, Math.max(8, ...routes.map((route) => visibleLengthEstimate(route.label))));
  const rows: string[] = [];
  for (const route of routes) {
    const labelText = locale === "ar"
      ? padVisibleStart(route.label, labelWidth)
      : padVisibleEnd(route.label, labelWidth);
    const hasConcreteRoute = route.provider !== undefined && route.model !== undefined;
    const model = hasConcreteRoute ? `${route.provider}/${route.model}` : route.summary;
    const prefix = `  ${routeStatusIcon(route.status)} ${labelText}  `;
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
  contentWidth: number
): readonly string[] {
  const top = renderTopBorder(title, width);
  const body = rows.map((row) => renderFrameRow(row, contentWidth));
  return [
    top,
    ...body,
    renderBottomBorder(width),
  ];
}

function renderTopBorder(title: string, width: number): string {
  const label = ` ${title} `;
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

function sectionHeading(label: string): string {
  return `◇ ${label}`;
}

function severityIcon(severity: DoctorCheckSeverity | DoctorAction["severity"]): string {
  switch (severity) {
    case "healthy":
      return "✓";
    case "warning":
      return "▲";
    case "blocked":
      return "✕";
  }
}

function routeStatusIcon(status: DoctorProviderRoute["status"]): string {
  switch (status) {
    case "ready":
      return "✓";
    case "warning":
      return "▲";
    case "blocked":
      return "✕";
    case "disabled":
      return "•";
  }
}

function technical(value: string, locale: DoctorLocale): string {
  return locale === "ar" ? isolateLtr(value) : value;
}

function localizeDynamicText(value: string, locale: DoctorLocale): string {
  if (locale !== "ar") return value;
  if (/[\u0600-\u06ff]/u.test(value)) return isolateRtl(value);
  return isolateLtr(value);
}

function clampWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_WIDTH;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.trunc(width)));
}

function visibleLengthEstimate(value: string): number {
  return measureVisibleWidth(value);
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
  readonly noActions: string;
  readonly counts: (verdict: DoctorReport["verdict"]) => string;
};

function doctorSurfaceCopy(locale: DoctorLocale): DoctorSurfaceCopy {
  if (locale === "ar") {
    return {
      title: `${isolateLtr("𓂀 EstaCoda")} طبيب`,
      subtitle: "فحص صحة النظام",
      profile: "الملف الشخصي",
      workspace: "مساحة العمل",
      home: "المنزل",
      model: "النموذج",
      checks: "الفحوصات",
      providerRoutes: "مسارات المزوّد",
      verdict: "النتيجة",
      actions: "الإجراءات",
      notes: "ملاحظات",
      noteMarker: "•",
      fixLabel: "الإصلاح",
      noActions: "لا توجد إجراءات مطلوبة",
      counts: (verdict) => `${verdict.blockedCount} محظور · ${verdict.warningCount} تحذيرات · ${verdict.healthyCount} سليمة`,
    };
  }

  return {
    title: "𓂀 EstaCoda Doctor",
    subtitle: "System health inspection",
    profile: "Profile",
    workspace: "Workspace",
    home: "Home",
    model: "Model",
    checks: "Checks",
    providerRoutes: "Provider Routes",
    verdict: "Verdict",
    actions: "Actions",
    notes: "Notes",
    noteMarker: "•",
    fixLabel: "Fix",
    noActions: "No actions needed",
    counts: (verdict) => `${verdict.blockedCount} blocked · ${verdict.warningCount} warnings · ${verdict.healthyCount} healthy`,
  };
}
