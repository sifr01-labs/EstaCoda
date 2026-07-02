import { isolateLtr, isolateRtl } from "../../bidi.js";
import {
  measureVisibleWidth,
  padVisibleEnd,
  padVisibleStart,
  truncateVisible,
  wrapText
} from "../../renderers/layout.js";
import type { DoctorFixOperation, DoctorFixResult } from "../../../doctor/fix-engine.js";
import type { DoctorLocale } from "../../../doctor/types.js";

export type DoctorFixSurfaceRenderOptions = {
  readonly width?: number;
};

const DEFAULT_WIDTH = 72;
const MIN_WIDTH = 48;
const MAX_WIDTH = 100;

export function renderDoctorFixSurface(
  result: DoctorFixResult,
  options: DoctorFixSurfaceRenderOptions = {}
): string {
  const width = clampWidth(options.width ?? DEFAULT_WIDTH);
  const contentWidth = Math.max(1, width - 4);
  const copy = doctorFixSurfaceCopy(result.locale);
  const rows: string[] = [
    ...frameRows(copy.title, [
      result.operations.length > 0 ? copy.appliedSubtitle : copy.noopSubtitle,
      pairLine(copy.profile, technical(result.profile, result.locale), result.locale),
      pairLine(copy.home, technical(result.home, result.locale), result.locale),
    ], width, contentWidth),
    "",
    sectionHeading(copy.fixed),
    "",
    ...renderFixedOperations(result.operations, result.home, result.locale, contentWidth, copy),
    "",
    sectionHeading(copy.notChanged),
    "",
    ...result.notChanged.flatMap((line) => renderBullet(line, result.locale, contentWidth, copy.noteMarker)),
  ];

  if (result.warnings.length > 0) {
    rows.push("", sectionHeading(copy.warnings), "", ...result.warnings.flatMap((line) => renderBullet(line, result.locale, contentWidth, "▲")));
  }

  rows.push("", `${copy.nextLabel}: ${technical("estacoda doctor", result.locale)}`);
  return rows.join("\n");
}

function renderFixedOperations(
  operations: readonly DoctorFixOperation[],
  stateRoot: string,
  locale: DoctorLocale,
  contentWidth: number,
  copy: DoctorFixSurfaceCopy
): readonly string[] {
  if (operations.length === 0) {
    return [`  ${copy.noteMarker} ${copy.noFixes}`];
  }
  return operations.flatMap((operation) => renderBullet(operationLabel(operation, stateRoot, copy), locale, contentWidth, "✓"));
}

function operationLabel(operation: DoctorFixOperation, stateRoot: string, copy: DoctorFixSurfaceCopy): string {
  const path = stateRelativePath(operation.path, stateRoot);
  switch (operation.kind) {
    case "create-directory":
      return `${copy.created} ${path}/`;
    case "create-file":
      return `${copy.created} ${path}`;
    case "chmod-private-file":
      return `${copy.setMode} ${path} ${copy.modeSuffix}`;
  }
}

function stateRelativePath(path: string, stateRoot: string): string {
  if (path === stateRoot) return "~/.estacoda";
  const prefix = `${stateRoot}/`;
  if (path.startsWith(prefix)) return `~/.estacoda/${path.slice(prefix.length)}`;
  return path;
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
  return `${padVisibleEnd(`${label}:`, 12)} ${value}`;
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

type DoctorFixSurfaceCopy = {
  readonly title: string;
  readonly appliedSubtitle: string;
  readonly noopSubtitle: string;
  readonly profile: string;
  readonly home: string;
  readonly fixed: string;
  readonly notChanged: string;
  readonly warnings: string;
  readonly created: string;
  readonly setMode: string;
  readonly modeSuffix: string;
  readonly noFixes: string;
  readonly noteMarker: string;
  readonly nextLabel: string;
};

function doctorFixSurfaceCopy(locale: DoctorLocale): DoctorFixSurfaceCopy {
  if (locale === "ar") {
    return {
      title: `${isolateLtr("𓂀 EstaCoda Doctor")} إصلاح`,
      appliedSubtitle: "تم تطبيق إصلاحات آمنة",
      noopSubtitle: "لا توجد إصلاحات آمنة مطلوبة",
      profile: "الملف الشخصي",
      home: "المنزل",
      fixed: "تم الإصلاح",
      notChanged: "لم يتغير",
      warnings: "تحذيرات",
      created: "تم إنشاء",
      setMode: "تم ضبط أذونات",
      modeSuffix: "إلى 0600",
      noFixes: "لا توجد إصلاحات آمنة مطلوبة",
      noteMarker: "•",
      nextLabel: "التالي"
    };
  }

  return {
    title: "𓂀 EstaCoda Doctor Fix",
    appliedSubtitle: "Applied safe repairs",
    noopSubtitle: "No safe repairs needed",
    profile: "Profile",
    home: "Home",
    fixed: "Fixed",
    notChanged: "Not Changed",
    warnings: "Warnings",
    created: "Created",
    setMode: "Set",
    modeSuffix: "mode to 0600",
    noFixes: "No safe repairs were needed",
    noteMarker: "•",
    nextLabel: "Next"
  };
}
