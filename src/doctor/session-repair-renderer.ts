import type { SQLiteRepairReport } from "../storage/repair.js";
import { isolateLtr, isolateRtl } from "../ui/bidi.js";
import {
  measureVisibleWidth,
  padVisibleEnd,
  padVisibleStart,
  truncateVisible,
  wrapText
} from "../ui/renderers/layout.js";
import type { DoctorLocale } from "./types.js";

export type DoctorSessionRepairResult = {
  readonly locale: DoctorLocale;
  readonly profile: string;
  readonly home: string;
  readonly report: SQLiteRepairReport;
};

const DEFAULT_WIDTH = 72;
const MIN_WIDTH = 48;
const MAX_WIDTH = 100;

export function renderDoctorSessionRepairReport(
  result: DoctorSessionRepairResult,
  options: { readonly width?: number } = {}
): string {
  const width = clampWidth(options.width ?? DEFAULT_WIDTH);
  const contentWidth = Math.max(1, width - 4);
  const copy = repairCopy(result.locale);
  const rows = [
    ...frameRows(copy.title, [
      repairSubtitle(result.report, copy),
      pairLine(copy.profile, technical(result.profile, result.locale), result.locale),
      pairLine(copy.backup, technical(result.report.backupPath ?? copy.none, result.locale), result.locale)
    ], width, contentWidth),
    "",
    sectionHeading(result.report.status === "blocked" ? copy.blocked : copy.repaired),
    "",
    ...renderReportLines(result.report, result.locale, contentWidth, copy),
    "",
    `${copy.next}: ${technical("estacoda doctor", result.locale)}`
  ];
  return rows.join("\n");
}

function renderReportLines(
  report: SQLiteRepairReport,
  locale: DoctorLocale,
  contentWidth: number,
  copy: RepairCopy
): readonly string[] {
  const lines: string[] = [];
  if (report.repaired) {
    lines.push(...renderBullet(copy.rebuiltFts, locale, contentWidth, "✓"));
  } else if (report.status === "not-needed") {
    lines.push(...renderBullet(copy.noRepairNeeded, locale, contentWidth, "•"));
  }
  if (report.error !== undefined) {
    lines.push(...renderBullet(report.error, locale, contentWidth, "✕"));
  }
  for (const note of report.notes) {
    lines.push(...renderBullet(note, locale, contentWidth, "•"));
  }
  return lines.length === 0 ? [`  • ${copy.noRepairNeeded}`] : lines;
}

function repairSubtitle(report: SQLiteRepairReport, copy: RepairCopy): string {
  switch (report.status) {
    case "repaired":
      return copy.repairedSubtitle;
    case "not-needed":
      return copy.noopSubtitle;
    case "blocked":
      return copy.blockedSubtitle;
  }
}

function renderBullet(text: string, locale: DoctorLocale, contentWidth: number, marker: string): readonly string[] {
  const width = Math.max(1, contentWidth - 4);
  return wrapText(localizeDynamicText(text, locale), width).map((line, index) => {
    const prefix = index === 0 ? `  ${marker} ` : "    ";
    return `${prefix}${line}`;
  });
}

function frameRows(
  title: string,
  rows: readonly string[],
  width: number,
  contentWidth: number
): readonly string[] {
  return [
    renderTopBorder(title, width),
    ...rows.map((row) => renderFrameRow(row, contentWidth)),
    renderBottomBorder(width),
  ];
}

function renderTopBorder(title: string, width: number): string {
  const label = ` ${title} `;
  const remaining = Math.max(0, width - 2 - measureVisibleWidth(label));
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
  return `${padVisibleEnd(label, 8)} ${value}`;
}

function sectionHeading(label: string): string {
  return `◇ ${label}`;
}

function technical(value: string, locale: DoctorLocale): string {
  return locale === "ar" ? isolateLtr(value) : value;
}

function localizeDynamicText(value: string, locale: DoctorLocale): string {
  if (locale !== "ar") return value;
  if (value === "Rebuilt SQLite session DB FTS index from existing messages.") {
    return isolateRtl("تمت إعادة بناء فهرس بحث قاعدة بيانات الجلسات من الرسائل الموجودة.");
  }
  if (value === "SQLite session DB FTS index is already healthy.") {
    return isolateRtl("فهرس بحث قاعدة بيانات الجلسات سليم بالفعل.");
  }
  if (/[\u0600-\u06ff]/u.test(value)) return isolateRtl(value);
  return isolateLtr(value);
}

function clampWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_WIDTH;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.trunc(width)));
}

type RepairCopy = {
  readonly title: string;
  readonly repairedSubtitle: string;
  readonly noopSubtitle: string;
  readonly blockedSubtitle: string;
  readonly profile: string;
  readonly backup: string;
  readonly none: string;
  readonly repaired: string;
  readonly blocked: string;
  readonly rebuiltFts: string;
  readonly noRepairNeeded: string;
  readonly next: string;
};

function repairCopy(locale: DoctorLocale): RepairCopy {
  if (locale === "ar") {
    return {
      title: `${isolateLtr("𓂀  EstaCoda Doctor")} إصلاح`,
      repairedSubtitle: "تم إصلاح قاعدة بيانات الجلسات",
      noopSubtitle: "لا توجد حاجة لإصلاح قاعدة بيانات الجلسات",
      blockedSubtitle: "تعذر إصلاح قاعدة بيانات الجلسات",
      profile: "الملف الشخصي",
      backup: "النسخة الاحتياطية",
      none: "لا توجد",
      repaired: "تم الإصلاح",
      blocked: "محظور",
      rebuiltFts: "تمت إعادة بناء فهرس البحث",
      noRepairNeeded: "لا توجد حاجة لإصلاح قاعدة بيانات الجلسات",
      next: "التالي"
    };
  }
  return {
    title: "𓂀  EstaCoda Doctor Repair",
    repairedSubtitle: "Repaired session database",
    noopSubtitle: "No session database repair needed",
    blockedSubtitle: "Session database repair blocked",
    profile: "Profile",
    backup: "Backup",
    none: "none",
    repaired: "Repaired",
    blocked: "Blocked",
    rebuiltFts: "Rebuilt SQLite FTS index",
    noRepairNeeded: "No session database repair needed",
    next: "Next"
  };
}
