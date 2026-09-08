import { padVisibleEnd, truncateVisible } from "../../renderers/layout.js";
import { semanticMotionFrame } from "../../semantic-motion.js";
import type { OperatorConsoleLocale } from "./activeWorkCopy.js";
import type { OperatorConsoleStyle } from "./operatorConsoleStyle.js";
import { styleBackgroundRow, styleBold, styleColor } from "./operatorConsoleStyle.js";
import type { TaskCardSubagentState } from "./operatorConsoleState.js";

type WorkerCopy = {
  readonly reportReady: string;
  readonly partialSaved: string;
  readonly noUsableResult: string;
  readonly waitingInput: string;
  readonly waitingApproval: string;
  readonly cancelled: string;
  readonly skipped: string;
  readonly failed: string;
};

const COPY: Readonly<Record<OperatorConsoleLocale, WorkerCopy>> = {
  en: {
    reportReady: "Report ready",
    partialSaved: "Partial saved",
    noUsableResult: "No usable result",
    waitingInput: "Waiting for input",
    waitingApproval: "Waiting for approval",
    cancelled: "Cancelled",
    skipped: "Skipped",
    failed: "Failed",
  },
  ar: {
    reportReady: "التقرير جاهز",
    partialSaved: "حُفظت نتيجة جزئية",
    noUsableResult: "لا توجد نتيجة صالحة",
    waitingInput: "بانتظار إدخال",
    waitingApproval: "بانتظار الموافقة",
    cancelled: "أُلغي",
    skipped: "تم التجاوز",
    failed: "فشل",
  },
};

export type TaskWorkerRowsLayout = {
  readonly columns: number;
  readonly rows: number;
  readonly columnWidth: number;
  readonly height: number;
};

export function resolveTaskWorkerRowsLayout(count: number, width: number): TaskWorkerRowsLayout {
  const normalizedCount = Math.max(0, Math.floor(count));
  const normalizedWidth = Math.max(1, Math.floor(width));
  const columns = normalizedCount > 3 && normalizedWidth >= 100 ? 2 : 1;
  const rows = Math.ceil(normalizedCount / columns);
  const gap = columns - 1;
  return {
    columns,
    rows,
    columnWidth: Math.max(1, Math.floor((normalizedWidth - gap * 2) / columns)),
    height: rows === 0 ? 0 : rows * 2 - 1,
  };
}

export function renderTaskWorkerRows(
  subagents: readonly TaskCardSubagentState[],
  options: {
    readonly width: number;
    readonly locale?: OperatorConsoleLocale;
    readonly style?: OperatorConsoleStyle;
    readonly focusedStepId?: string;
    readonly columns?: number;
    readonly motionElapsedMs?: number;
  }
): readonly string[] {
  const width = Math.max(1, Math.floor(options.width));
  const locale = options.locale ?? "en";
  const naturalLayout = resolveTaskWorkerRowsLayout(subagents.length, width);
  const columns = Math.max(1, Math.min(subagents.length || 1, options.columns ?? naturalLayout.columns));
  const rowsCount = Math.ceil(subagents.length / columns);
  const layout = {
    columns,
    rows: rowsCount,
    columnWidth: Math.max(1, Math.floor((width - Math.max(0, columns - 1) * 2) / columns)),
  };
  const rows: string[] = [];
  for (let rowIndex = 0; rowIndex < layout.rows; rowIndex += 1) {
    if (rowIndex > 0) rows.push("".padEnd(width));
    const cells = Array.from({ length: layout.columns }, (_, columnIndex) => {
      const subagent = subagents[columnIndex * layout.rows + rowIndex];
      if (subagent === undefined) return "".padEnd(layout.columnWidth);
      return renderWorkerRow(
        subagent,
        layout.columnWidth,
        locale,
        options.style,
        options.focusedStepId === subagent.stepId,
        options.motionElapsedMs
      );
    });
    rows.push(padVisibleEnd(truncateVisible(cells.join("  "), width, "…"), width));
  }
  return rows;
}

function renderWorkerRow(
  subagent: TaskCardSubagentState,
  width: number,
  locale: OperatorConsoleLocale,
  style: OperatorConsoleStyle | undefined,
  focused: boolean,
  motionElapsedMs: number | undefined
): string {
  const tokens = style?.tokens.contract;
  const copy = COPY[locale];
  const symbol = workerSymbol(subagent, style, motionElapsedMs);
  const titleText = conciseTitle(isGenericTitle(subagent.title) ? subagent.objective : subagent.title);
  const displayTitle = locale === "ar" ? isolate(titleText) : titleText;
  const titleColor = focused ? tokens?.palette.action : tokens?.palette.accent;
  const title = titleColor === undefined ? displayTitle : styleColor(style, styleBold(style, displayTitle), titleColor);
  const rail = focused ? tokens?.glyph.progress.thumb ?? ">" : " ";
  const styledRail = focused && tokens !== undefined ? styleColor(style, rail, tokens.palette.action) : rail;
  const detail = workerDetail(subagent, copy, locale);
  const row = `${styledRail} ${symbol} ${title} ${muted(style, "·")} ${muted(style, detail)}`;
  return styleBackgroundRow(style, row, width, tokens?.surface.bgElevated ?? "");
}

function workerSymbol(
  subagent: TaskCardSubagentState,
  style: OperatorConsoleStyle | undefined,
  motionElapsedMs: number | undefined
): string {
  const tokens = style?.tokens.contract;
  if (subagent.status === "running") {
    if (tokens === undefined) return ".";
    const motion = tokens.motion.worker;
    const elapsed = tokens.behavior.allowAnimation ? motionElapsedMs : 0;
    return styleColor(style, semanticMotionFrame(motion, elapsed, subagent.displayIndex * 2), motion.color);
  }
  if (subagent.status === "completed" && subagent.outcome.usable) {
    const glyph = tokens?.glyph.check ?? "✓";
    return tokens === undefined ? glyph : styleColor(style, glyph, tokens.severity.ok);
  }
  if (subagent.status === "failed" || subagent.status === "cancelled") {
    const glyph = tokens?.glyph.cross ?? "×";
    return tokens === undefined ? glyph : styleColor(style, glyph, tokens.severity.error);
  }
  if (subagent.status === "waiting_for_input" || subagent.status === "waiting_for_approval") {
    return tokens === undefined ? "!" : styleColor(style, "!", tokens.severity.warn);
  }
  if (subagent.status === "skipped") {
    const glyph = tokens?.glyph.bullet ?? "-";
    return tokens === undefined ? glyph : styleColor(style, glyph, tokens.text.muted);
  }
  const glyph = tokens?.glyph.bullet ?? ".";
  return tokens === undefined ? glyph : styleColor(style, glyph, tokens.palette.action);
}

function workerDetail(
  subagent: TaskCardSubagentState,
  copy: WorkerCopy,
  locale: OperatorConsoleLocale
): string {
  if (subagent.status === "failed") {
    const rawFailure = humanizeFailure(subagent.outcome.failure?.class);
    const failure = rawFailure === undefined ? copy.failed : locale === "ar" ? isolate(rawFailure) : rawFailure;
    return `${failure} · ${subagent.outcome.recovered ? copy.partialSaved : copy.noUsableResult}`;
  }
  if (subagent.status === "cancelled") return `${copy.cancelled} · ${copy.noUsableResult}`;
  if (subagent.status === "skipped") return `${copy.skipped} · ${copy.noUsableResult}`;
  if (subagent.status === "completed") return subagent.outcome.usable ? copy.reportReady : copy.noUsableResult;
  if (subagent.status === "waiting_for_input") return copy.waitingInput;
  if (subagent.status === "waiting_for_approval") return copy.waitingApproval;
  return normalize(subagent.currentActivity ?? subagent.activeAttempt?.currentActivity) ?? subagent.status.replaceAll("_", " ");
}

function humanizeFailure(value: string | undefined): string | undefined {
  const normalized = normalize(value);
  if (normalized === undefined) return undefined;
  return normalized.split(/[-_]/gu).map((part, index) =>
    index === 0 ? `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}` : part
  ).join(" ");
}

function conciseTitle(value: string): string {
  const normalized = normalize(value) ?? "Subagent";
  const words = normalized.split(" ");
  return words.length > 7 ? `${words.slice(0, 7).join(" ")}…` : normalized;
}

function isGenericTitle(value: string): boolean {
  return /^Delegated work(?: \d+)?$/iu.test(value.trim());
}

function normalize(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/gu, " ").trim();
  return normalized === undefined || normalized.length === 0 ? undefined : normalized;
}

function muted(style: OperatorConsoleStyle | undefined, value: string): string {
  const color = style?.tokens.contract.text.muted;
  return color === undefined ? value : styleColor(style, value, color);
}

function isolate(value: string): string {
  return `\u2068${value}\u2069`;
}
