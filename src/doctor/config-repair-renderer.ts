import { isolateLtr, isolateRtl } from "../ui/bidi.js";
import {
  measureVisibleWidth,
  padVisibleEnd,
  padVisibleStart,
  truncateVisible,
  wrapText
} from "../ui/renderers/layout.js";
import type { DoctorConfigRepairOperation, DoctorConfigRepairResult } from "./config-repair.js";
import type { DoctorLocale } from "./types.js";

const DEFAULT_WIDTH = 72;
const MIN_WIDTH = 48;
const MAX_WIDTH = 100;

export function renderDoctorConfigRepairReport(
  result: DoctorConfigRepairResult,
  options: { readonly width?: number } = {}
): string {
  const width = clampWidth(options.width ?? DEFAULT_WIDTH);
  const contentWidth = Math.max(1, width - 4);
  const copy = configRepairCopy(result.locale);
  const rows: string[] = [
    ...frameRows(copy.title, [
      subtitle(result.status, copy),
      pairLine(copy.profile, technical(result.profile, result.locale), result.locale),
      pairLine(copy.configBackup, technical(result.backupPath ?? copy.none, result.locale), result.locale),
      pairLine(copy.envBackup, technical(result.envBackupPath ?? copy.none, result.locale), result.locale),
    ], width, contentWidth),
    "",
    sectionHeading(result.status === "blocked" ? copy.blocked : copy.applied),
    "",
    ...renderOperations(result.operations, result.locale, contentWidth, copy),
    "",
    sectionHeading(copy.notChanged),
    "",
    ...result.notChanged.flatMap((line) => renderBullet(line, result.locale, contentWidth, copy.noteMarker)),
  ];

  if (result.warnings.length > 0) {
    rows.push("", sectionHeading(copy.warnings), "", ...result.warnings.flatMap((line) => renderBullet(line, result.locale, contentWidth, "▲")));
  }

  rows.push("", `${copy.next}: ${technical("estacoda doctor", result.locale)}`);
  return rows.join("\n");
}

function renderOperations(
  operations: readonly DoctorConfigRepairOperation[],
  locale: DoctorLocale,
  contentWidth: number,
  copy: ConfigRepairCopy
): readonly string[] {
  if (operations.length === 0) {
    return [`  ${copy.noteMarker} ${copy.noChanges}`];
  }
  return operations.flatMap((operation) => renderBullet(operationLabel(operation, copy), locale, contentWidth, "✓"));
}

function operationLabel(operation: DoctorConfigRepairOperation, copy: ConfigRepairCopy): string {
  switch (operation.kind) {
    case "backup-config":
      return `${copy.backedUpConfig} ${operation.path ?? ""}`.trim();
    case "apply-migration":
      return `${copy.appliedMigration} ${operation.migrationId ?? ""}`.trim();
    case "backup-env":
      return `${copy.backedUpEnv} ${operation.path ?? ""}`.trim();
    case "remove-env-ghost":
      return `${copy.removedEnvGhost} ${operation.key ?? ""}`.trim();
  }
}

function subtitle(status: DoctorConfigRepairResult["status"], copy: ConfigRepairCopy): string {
  switch (status) {
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
    return `${padVisibleStart(label, 16)}   ${value}`;
  }
  return `${padVisibleEnd(`${label}:`, 16)} ${value}`;
}

function sectionHeading(label: string): string {
  return `◇ ${label}`;
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

type ConfigRepairCopy = {
  readonly title: string;
  readonly repairedSubtitle: string;
  readonly noopSubtitle: string;
  readonly blockedSubtitle: string;
  readonly profile: string;
  readonly configBackup: string;
  readonly envBackup: string;
  readonly none: string;
  readonly applied: string;
  readonly blocked: string;
  readonly notChanged: string;
  readonly warnings: string;
  readonly noChanges: string;
  readonly backedUpConfig: string;
  readonly appliedMigration: string;
  readonly backedUpEnv: string;
  readonly removedEnvGhost: string;
  readonly noteMarker: string;
  readonly next: string;
};

function configRepairCopy(locale: DoctorLocale): ConfigRepairCopy {
  if (locale === "ar") {
    return {
      title: `${isolateLtr("𓂀  EstaCoda Doctor")} إصلاح الإعدادات`,
      repairedSubtitle: "تم تطبيق إصلاحات الإعدادات الآمنة",
      noopSubtitle: "لا توجد إصلاحات إعدادات مطلوبة",
      blockedSubtitle: "تعذر إصلاح الإعدادات",
      profile: "الملف الشخصي",
      configBackup: "نسخة الإعدادات",
      envBackup: "نسخة .env",
      none: "لا توجد",
      applied: "تم التطبيق",
      blocked: "محظور",
      notChanged: "لم يتغير",
      warnings: "تحذيرات",
      noChanges: "لا توجد تغييرات مطلوبة",
      backedUpConfig: "تم نسخ الإعدادات احتياطيًا",
      appliedMigration: "تم تطبيق ترحيل الإعدادات",
      backedUpEnv: "تم نسخ .env احتياطيًا",
      removedEnvGhost: "تمت إزالة مفتاح .env غير المستخدم",
      noteMarker: "•",
      next: "التالي"
    };
  }
  return {
    title: "𓂀  EstaCoda Doctor Config Repair",
    repairedSubtitle: "Applied safe config repairs",
    noopSubtitle: "No config repairs needed",
    blockedSubtitle: "Config repair blocked",
    profile: "Profile",
    configBackup: "Config backup",
    envBackup: ".env backup",
    none: "none",
    applied: "Applied",
    blocked: "Blocked",
    notChanged: "Not Changed",
    warnings: "Warnings",
    noChanges: "No config changes were needed",
    backedUpConfig: "Backed up config",
    appliedMigration: "Applied config migration",
    backedUpEnv: "Backed up .env",
    removedEnvGhost: "Removed unreferenced .env key",
    noteMarker: "•",
    next: "Next"
  };
}
