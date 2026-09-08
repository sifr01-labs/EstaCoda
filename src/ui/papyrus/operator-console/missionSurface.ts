import type { ExecutionPlan, ExecutionPlanItemStatus } from "../../../contracts/execution-plan.js";
import {
  closeOpenBidiIsolates,
  hasRtlText,
  isolateAuto,
  isolateLtr,
  isolateTechnicalTokens,
  sanitizeBidiControls,
} from "../../bidi.js";
import { truncateVisible } from "../../renderers/layout.js";
import { stringWidth } from "../screen/stringWidth.js";
import {
  styleBold,
  styleColor,
  type OperatorConsoleStyle,
} from "./operatorConsoleStyle.js";

export type PlanSurfaceRenderOptions = {
  readonly width: number;
  readonly height?: number;
  readonly locale?: "en" | "ar";
  readonly style?: OperatorConsoleStyle;
};

export function getMissionSurfaceDesiredHeight(plan: ExecutionPlan | undefined): number {
  return isLiveMission(plan) ? Math.min(17, 1 + plan.items.length) : 0;
}

export function renderMissionSurface(
  plan: ExecutionPlan | undefined,
  options: PlanSurfaceRenderOptions
): readonly string[] {
  const width = Math.max(0, Math.floor(options.width));
  const height = Math.max(0, Math.floor(options.height ?? getMissionSurfaceDesiredHeight(plan)));
  if (!isLiveMission(plan) || width === 0 || height === 0) return [];
  return liveMissionRows(plan, width, options).slice(0, height);
}

function liveMissionRows(
  plan: ExecutionPlan,
  width: number,
  options: Pick<PlanSurfaceRenderOptions, "locale" | "style">
): string[] {
  const locale = options.locale;
  const style = options.style;
  const label = locale === "ar" ? "الخطة" : "Plan";
  const completed = plan.items.filter((item) => item.status === "completed").length;
  const progress = prepareMissionValue(`${completed} / ${plan.items.length}`, locale, true);
  const objective = prepareMissionValue(plan.objective, locale);
  return [
    renderStyledParts([
      { text: label, render: (value) => styleColor(style, value, style?.tokens.contract.palette.accent ?? "") },
      { text: " · " },
      { text: progress, render: (value) => styleColor(style, value, style?.tokens.contract.text.secondary ?? "") },
      { text: " · " },
      { text: objective, render: (value) => styleBold(style, value) },
    ], width),
    ...plan.items.map((item) => renderMissionItem(item.status, item.content, width, locale, style))
  ];
}

export function formatPlainExecutionPlan(
  plan: ExecutionPlan | undefined,
  locale: "en" | "ar" = "en"
): string | undefined {
  if (plan === undefined) return undefined;
  const label = locale === "ar" ? "الخطة" : "Plan";
  return [
    `${label} · ${plan.objective}`,
    ...plan.items.map((item) => `${statusGlyph(item.status)} ${item.content}`),
  ].slice(0, 17).join("\n");
}

function isLiveMission(plan: ExecutionPlan | undefined): plan is ExecutionPlan {
  return plan !== undefined &&
    plan.status !== "completed" &&
    plan.status !== "abandoned" &&
    plan.status !== "transferred";
}

function statusGlyph(status: ExecutionPlanItemStatus): string {
  switch (status) {
    case "completed": return "✓";
    case "in_progress": return "●";
    case "blocked": return "!";
    case "cancelled": return "×";
    case "pending": return "○";
  }
}

function renderMissionItem(
  status: ExecutionPlanItemStatus,
  content: string,
  width: number,
  locale: "en" | "ar" | undefined,
  style: OperatorConsoleStyle | undefined
): string {
  const glyph = statusGlyph(status);
  const value = prepareMissionValue(content, locale);
  const tokens = style?.tokens.contract;
  const glyphColor = tokens === undefined ? undefined : statusColor(status, tokens);
  return renderStyledParts([
    {
      text: glyph,
      render: (part) => glyphColor === undefined ? part : styleColor(style, part, glyphColor),
    },
    { text: " " },
    {
      text: value,
      render: (part) => styleMissionContent(part, status, style),
    },
  ], width);
}

function styleMissionContent(
  value: string,
  status: ExecutionPlanItemStatus,
  style: OperatorConsoleStyle | undefined
): string {
  const tokens = style?.tokens.contract;
  if (tokens === undefined) return value;
  switch (status) {
    case "in_progress":
      return styleColor(style, styleBold(style, value), tokens.palette.action);
    case "blocked":
      return styleColor(style, styleBold(style, value), tokens.severity.warn);
    case "pending":
    case "cancelled":
      return styleColor(style, value, tokens.text.muted);
    case "completed":
      return styleColor(style, value, tokens.text.secondary);
  }
}

function statusColor(
  status: ExecutionPlanItemStatus,
  tokens: OperatorConsoleStyle["tokens"]["contract"]
): string {
  switch (status) {
    case "completed": return tokens.severity.ok;
    case "in_progress": return tokens.palette.action;
    case "blocked": return tokens.severity.warn;
    case "cancelled": return tokens.severity.error;
    case "pending": return tokens.text.muted;
  }
}

function prepareMissionValue(
  value: string,
  locale: "en" | "ar" | undefined,
  technical = false
): string {
  const safe = sanitizeBidiControls(value);
  if (technical) return locale === "ar" ? isolateLtr(safe) : safe;
  if (locale !== "ar" && !hasRtlText(safe)) return safe;
  return isolateAuto(isolateTechnicalTokens(safe));
}

function renderStyledParts(
  parts: readonly {
    readonly text: string;
    readonly render?: (value: string) => string;
  }[],
  width: number
): string {
  let remaining = width;
  let output = "";
  for (const part of parts) {
    if (remaining <= 0) break;
    const fitted = closeOpenBidiIsolates(truncateVisible(part.text, remaining, ""));
    output += part.render?.(fitted) ?? fitted;
    const fittedWidth = stringWidth(fitted);
    remaining -= fittedWidth;
    if (fittedWidth < stringWidth(part.text)) break;
  }
  return output;
}
