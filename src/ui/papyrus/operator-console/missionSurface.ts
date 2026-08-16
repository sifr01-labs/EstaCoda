import type { ExecutionPlan, ExecutionPlanItemStatus } from "../../../contracts/execution-plan.js";
import { truncateVisible } from "../../renderers/layout.js";

export type MissionSurfaceRenderOptions = {
  readonly width: number;
  readonly height?: number;
  readonly locale?: "en" | "ar";
};

export function getMissionSurfaceDesiredHeight(plan: ExecutionPlan | undefined): number {
  return isLiveMission(plan) ? Math.min(17, 1 + plan.items.length) : 0;
}

export function renderMissionSurface(
  plan: ExecutionPlan | undefined,
  options: MissionSurfaceRenderOptions
): readonly string[] {
  const width = Math.max(0, Math.floor(options.width));
  const height = Math.max(0, Math.floor(options.height ?? getMissionSurfaceDesiredHeight(plan)));
  if (!isLiveMission(plan) || width === 0 || height === 0) return [];
  return missionRows(plan, width, options.locale).slice(0, height);
}

function missionRows(plan: ExecutionPlan, width: number, locale: "en" | "ar" | undefined): string[] {
  const label = locale === "ar" ? "خطة التنفيذ" : "Mission";
  return [
    truncateVisible(`${label} · ${plan.objective}`, width, ""),
    ...plan.items.map((item) => truncateVisible(`${statusGlyph(item.status)} ${item.content}`, width, ""))
  ];
}

export function formatPlainExecutionPlan(
  plan: ExecutionPlan | undefined,
  locale: "en" | "ar" = "en"
): string | undefined {
  if (plan === undefined) return undefined;
  return missionRows(plan, Number.MAX_SAFE_INTEGER, locale).slice(0, 17).join("\n");
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
