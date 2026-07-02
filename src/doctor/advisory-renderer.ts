import { isolateLtr, isolateRtl } from "../ui/bidi.js";
import {
  measureVisibleWidth,
  padVisibleEnd,
  padVisibleStart,
  truncateVisible
} from "../ui/renderers/layout.js";
import type { AdvisoryAckResult } from "./advisory-store.js";
import type { DoctorLocale } from "./types.js";

export type DoctorAdvisoryAckReport = {
  readonly locale: DoctorLocale;
  readonly profile: string;
  readonly home: string;
  readonly result: AdvisoryAckResult;
};

const DEFAULT_WIDTH = 72;
const MIN_WIDTH = 48;
const MAX_WIDTH = 100;

export function renderDoctorAdvisoryAckReport(
  report: DoctorAdvisoryAckReport,
  options: { readonly width?: number } = {}
): string {
  const width = clampWidth(options.width ?? DEFAULT_WIDTH);
  const contentWidth = Math.max(1, width - 4);
  const copy = advisoryAckCopy(report.locale);
  const rows = [
    ...frameRows(copy.title, [
      report.result.created ? copy.acknowledged : copy.alreadyAcknowledged,
      pairLine(copy.profile, technical(report.profile, report.locale), report.locale),
      pairLine(copy.home, technical(report.home, report.locale), report.locale),
      pairLine(copy.advisory, technical(report.result.id, report.locale), report.locale),
      pairLine(copy.acknowledgedAt, technical(report.result.acknowledgedAt, report.locale), report.locale),
    ], width, contentWidth),
    "",
    `✓ ${report.result.created ? copy.recorded : copy.alreadyRecorded}`,
    "",
    `${copy.next}: ${technical("estacoda doctor", report.locale)}`
  ];
  return rows.join("\n");
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
  return `│ ${padVisibleEnd(truncateVisible(localizeDynamicText(row), contentWidth), contentWidth)} │`;
}

function pairLine(label: string, value: string, locale: DoctorLocale): string {
  if (locale === "ar") {
    return `${padVisibleStart(label, 14)}   ${value}`;
  }
  return `${padVisibleEnd(`${label}:`, 16)} ${value}`;
}

function technical(value: string, locale: DoctorLocale): string {
  return locale === "ar" ? isolateLtr(value) : value;
}

function localizeDynamicText(value: string): string {
  if (/[\u0600-\u06ff]/u.test(value)) return isolateRtl(value);
  return value;
}

function clampWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_WIDTH;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.trunc(width)));
}

type AdvisoryAckCopy = {
  readonly title: string;
  readonly acknowledged: string;
  readonly alreadyAcknowledged: string;
  readonly profile: string;
  readonly home: string;
  readonly advisory: string;
  readonly acknowledgedAt: string;
  readonly recorded: string;
  readonly alreadyRecorded: string;
  readonly next: string;
};

function advisoryAckCopy(locale: DoctorLocale): AdvisoryAckCopy {
  if (locale === "ar") {
    return {
      title: `${isolateLtr("𓂀  EstaCoda Doctor")} إقرار تنبيه`,
      acknowledged: "تم تسجيل إقرار التنبيه",
      alreadyAcknowledged: "التنبيه مُقرّ به مسبقًا",
      profile: "الملف الشخصي",
      home: "المنزل",
      advisory: "التنبيه",
      acknowledgedAt: "وقت الإقرار",
      recorded: "تم تسجيل الإقرار في الملف الشخصي المحدد",
      alreadyRecorded: "الإقرار موجود بالفعل في الملف الشخصي المحدد",
      next: "التالي"
    };
  }
  return {
    title: "𓂀  EstaCoda Doctor Advisory",
    acknowledged: "Advisory acknowledgement recorded",
    alreadyAcknowledged: "Advisory already acknowledged",
    profile: "Profile",
    home: "Home",
    advisory: "Advisory",
    acknowledgedAt: "Acknowledged",
    recorded: "Acknowledgement recorded for selected profile",
    alreadyRecorded: "Acknowledgement already exists for selected profile",
    next: "Next"
  };
}
