import type { ExecutionPlan, ExecutionPlanItemStatus } from "../../../contracts/execution-plan.js";
import { truncateVisible } from "../../renderers/layout.js";

export type MissionSurfaceRenderOptions = {
  readonly width: number;
  readonly height?: number;
  readonly locale?: "en" | "ar";
};

export function getMissionSurfaceDesiredHeight(plan: ExecutionPlan | undefined): number {
  return plan === undefined ? 0 : Math.min(17, 1 + plan.items.length);
}

export function renderMissionSurface(
  plan: ExecutionPlan | undefined,
  options: MissionSurfaceRenderOptions
): readonly string[] {
  const width = Math.max(0, Math.floor(options.width));
  const height = Math.max(0, Math.floor(options.height ?? getMissionSurfaceDesiredHeight(plan)));
  if (plan === undefined || width === 0 || height === 0) return [];
  const label = options.locale === "ar" ? "خطة التنفيذ" : "Mission";
  return [
    truncateVisible(`${label} · ${plan.objective}`, width, ""),
    ...plan.items.map((item) => truncateVisible(`${statusGlyph(item.status)} ${item.content}`, width, ""))
  ].slice(0, height);
}

export function formatPlainExecutionPlan(
  plan: ExecutionPlan | undefined,
  locale: "en" | "ar" = "en"
): string | undefined {
  if (plan === undefined) return undefined;
  return renderMissionSurface(plan, {
    width: Number.MAX_SAFE_INTEGER,
    height: getMissionSurfaceDesiredHeight(plan),
    locale
  }).join("\n");
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
