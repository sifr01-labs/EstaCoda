import { measureVisibleWidth, padVisibleEnd, truncateVisible } from "../../renderers/layout.js";
import { formatUsageCost } from "../../usage-cost-format.js";
import type { OperatorConsoleLocale } from "./activeWorkCopy.js";
import type { OperatorConsoleStyle } from "./operatorConsoleStyle.js";
import { styleBold, styleColor } from "./operatorConsoleStyle.js";
import type { TaskCardState } from "./operatorConsoleState.js";
import { deriveTaskStageModel, type TaskStageName, type TaskStageStatus } from "./taskStageModel.js";

type StageCopy = {
  readonly task: string;
  readonly plan: string;
  readonly subagents: string;
  readonly synthesis: string;
  readonly deliver: string;
  readonly live: string;
  readonly synthesizing: string;
  readonly complete: string;
  readonly completeWarnings: string;
  readonly failed: string;
  readonly waiting: string;
  readonly elapsed: string;
  readonly cost: string;
  readonly tokens: string;
  readonly workerOutcomes: (usable: number, failed: number, cancelled: number) => string;
};

const COPY: Readonly<Record<OperatorConsoleLocale, StageCopy>> = {
  en: {
    task: "Task",
    plan: "Plan",
    subagents: "Subagents",
    synthesis: "Synthesis",
    deliver: "Deliver",
    live: "LIVE",
    synthesizing: "SYNTHESIZING",
    complete: "COMPLETE",
    completeWarnings: "COMPLETE WITH WARNINGS",
    failed: "FAILED",
    waiting: "WAITING",
    elapsed: "Elapsed",
    cost: "Est. provider cost",
    tokens: "tokens",
    workerOutcomes: (usable, failed, cancelled) => [
      `${usable} usable ${usable === 1 ? "report" : "reports"}`,
      ...(failed === 0 ? [] : [`${failed} failed`]),
      ...(cancelled === 0 ? [] : [`${cancelled} cancelled`]),
    ].join(" · "),
  },
  ar: {
    task: "المهمة",
    plan: "التخطيط",
    subagents: "الوكلاء الفرعيون",
    synthesis: "التجميع",
    deliver: "التسليم",
    live: "مباشر",
    synthesizing: "قيد التجميع",
    complete: "مكتملة",
    completeWarnings: "مكتملة مع تحذيرات",
    failed: "فشلت",
    waiting: "بانتظار المتابعة",
    elapsed: "المدة",
    cost: "تكلفة المزود التقديرية",
    tokens: "رمز",
    workerOutcomes: (usable, failed, cancelled) => [
      `نتائج صالحة: ${isolate(String(usable))}`,
      ...(failed === 0 ? [] : [`فشل: ${isolate(String(failed))}`]),
      ...(cancelled === 0 ? [] : [`أُلغي: ${isolate(String(cancelled))}`]),
    ].join(" · "),
  },
};

export function taskStageHeaderHeight(width: number): number {
  if (width < 60) return 2;
  if (width < 100) return 3;
  return 5;
}

export function renderTaskStageSurface(
  card: TaskCardState,
  options: {
    readonly width: number;
    readonly locale?: OperatorConsoleLocale;
    readonly style?: OperatorConsoleStyle;
    readonly focused?: boolean;
  }
): readonly string[] {
  const width = Math.max(1, Math.floor(options.width));
  const locale = options.locale ?? "en";
  const copy = COPY[locale];
  const style = options.style;
  const tokens = style?.tokens.contract;
  const model = deriveTaskStageModel(card);
  const status = taskStatus(card, copy);
  const titleValue = locale === "ar" ? isolate(card.objective) : card.objective;
  const titleColor = options.focused ? tokens?.palette.action : tokens?.palette.brand;
  const title = titleColor === undefined
    ? titleValue
    : styleColor(style, styleBold(style, titleValue), titleColor);
  const styledStatus = styleStatus(status, card, style);
  const id = isolate(`${copy.task} #${formatTaskDisplayId(card.taskId)}`);
  const outcomes = model.workerOutcomes === undefined
    ? ""
    : copy.workerOutcomes(
        model.workerOutcomes.usable,
        model.workerOutcomes.failed,
        model.workerOutcomes.cancelled
      );
  const cost = formatUsageCost({
    estimatedCostUsd: card.usage.estimatedCostUsd,
    costComplete: card.usage.pricingComplete,
  }, { locale, compact: true });
  const metrics = `${copy.elapsed} ${isolate(formatDuration(card.elapsedMs))} · ${copy.cost} ${isolate(cost)} · ${isolate(formatCompactTokenCount(card.usage.totalTokens))} ${copy.tokens}`;
  const tracker = renderStageTracker(model.stages, copy, style, locale);
  const separator = muted(style, " · ");

  if (width < 60) {
    return fitRows([
      `${title}${separator}${styledStatus}`,
      `${stageLabel(model.current, copy)}${separator}${outcomes || id}`,
    ], width);
  }
  if (width < 100) {
    return fitRows([
      `${title}${separator}${styledStatus}${separator}${id}`,
      tracker,
      [outcomes, metrics].filter(Boolean).join(separator),
    ], width);
  }
  return fitRows([
    alignStatus(title, styledStatus, width),
    id,
    tracker,
    outcomes,
    muted(style, metrics),
  ], width);
}

function renderStageTracker(
  stages: ReturnType<typeof deriveTaskStageModel>["stages"],
  copy: StageCopy,
  style: OperatorConsoleStyle | undefined,
  locale: OperatorConsoleLocale
): string {
  const connector = muted(style, " ─── ");
  const tracker = stages.map((stage) => {
    const label = stageLabel(stage.name, copy);
    const glyph = stageGlyph(stage.status, style);
    const value = `${label} ${glyph}`;
    return styleStage(value, stage.status, style);
  }).join(connector);
  return locale === "ar" ? isolate(tracker) : tracker;
}

function stageLabel(stage: TaskStageName, copy: StageCopy): string {
  return copy[stage];
}

function stageGlyph(status: TaskStageStatus, style: OperatorConsoleStyle | undefined): string {
  const tokens = style?.tokens.contract;
  const plain = style?.tokens.mode === "plain";
  switch (status) {
    case "completed": return tokens?.glyph.check ?? "✓";
    case "warning": return plain ? "!" : "⚠";
    case "active": return tokens?.glyph.bullet ?? "●";
    case "failed": return tokens?.glyph.cross ?? "×";
    case "pending": return plain ? "[ ]" : "○";
  }
}

function styleStage(value: string, status: TaskStageStatus, style: OperatorConsoleStyle | undefined): string {
  const tokens = style?.tokens.contract;
  if (tokens === undefined) return value;
  switch (status) {
    case "completed": return styleColor(style, value, tokens.severity.ok);
    case "warning": return styleColor(style, value, tokens.severity.warn);
    case "active": return styleColor(style, styleBold(style, value), tokens.palette.action);
    case "failed": return styleColor(style, value, tokens.severity.error);
    case "pending": return styleColor(style, value, tokens.text.muted);
  }
}

function taskStatus(card: TaskCardState, copy: StageCopy): string {
  if (card.status === "completed") return copy.complete;
  if (card.status === "partial") return copy.completeWarnings;
  if (card.status === "failed" || card.status === "cancelled") return copy.failed;
  if (card.status === "waiting_for_input" || card.status === "waiting_for_approval" ||
    card.phase.name === "waiting_for_input" || card.phase.name === "waiting_for_approval") return copy.waiting;
  if (card.phase.name === "synthesizing") return copy.synthesizing;
  return copy.live;
}

function styleStatus(value: string, card: TaskCardState, style: OperatorConsoleStyle | undefined): string {
  const tokens = style?.tokens.contract;
  if (tokens === undefined) return value;
  if (card.status === "completed") return styleColor(style, styleBold(style, value), tokens.severity.ok);
  if (card.status === "partial" || card.status === "waiting_for_input" || card.status === "waiting_for_approval" ||
    card.phase.name === "waiting_for_input" || card.phase.name === "waiting_for_approval") {
    return styleColor(style, styleBold(style, value), tokens.severity.warn);
  }
  if (card.status === "failed" || card.status === "cancelled") {
    return styleColor(style, styleBold(style, value), tokens.severity.error);
  }
  return styleColor(style, styleBold(style, value), tokens.palette.action);
}

function alignStatus(left: string, right: string, width: number): string {
  const plainLeft = measureVisibleWidth(left);
  const plainRight = measureVisibleWidth(right);
  return plainLeft + plainRight + 1 >= width
    ? `${left} · ${right}`
    : `${left}${" ".repeat(width - plainLeft - plainRight)}${right}`;
}

function fitRows(rows: readonly string[], width: number): readonly string[] {
  return rows.map((row) => padVisibleEnd(truncateVisible(row, width, "…"), width));
}

function muted(style: OperatorConsoleStyle | undefined, value: string): string {
  const color = style?.tokens.contract.text.muted;
  return color === undefined ? value : styleColor(style, value, color);
}

function isolate(value: string): string {
  if (/^[\u2066-\u2068].*\u2069$/u.test(value)) return value;
  return `\u2068${value}\u2069`;
}

function formatTaskDisplayId(taskId: string): string {
  const uuid = taskId.match(/^([A-Za-z][A-Za-z0-9_-]{0,15}[_-])?([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu);
  return uuid === null ? taskId : `${uuid[1] ?? ""}${uuid[2]}`;
}

function formatDuration(value: number): string {
  const totalSeconds = Math.max(0, Math.floor(value / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatCompactTokenCount(value: number): string {
  const count = Math.max(0, Number.isFinite(value) ? value : 0);
  if (count < 1_000) return String(Math.floor(count));
  if (count < 1_000_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/u, "")}k`;
  return `${(count / 1_000_000).toFixed(1).replace(/\.0$/u, "")}m`;
}
