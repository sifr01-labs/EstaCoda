import type { RuntimeEvent } from "../contracts/runtime-event.js";
import type { ToolActivityRailEvent } from "../contracts/view-model.js";
import { toolDisplayLabel, type ToolDisplayLocale } from "../ui/tool-display.js";
import type { ActiveWorkRuntimeEvent } from "../ui/papyrus/operator-console/index.js";

export function activeWorkEventFromToolRail(input: {
  readonly railEvent: ToolActivityRailEvent;
  readonly runtimeEvent: Extract<RuntimeEvent, { kind: "tool-start" | "tool-result" }>;
  readonly locale?: ToolDisplayLocale;
}): ActiveWorkRuntimeEvent {
  return {
    id: input.railEvent.activityId,
    toolName: input.railEvent.tool,
    displayLabel: toolDisplayLabel(input.railEvent.tool, input.locale),
    status: input.railEvent.status,
    summary: input.railEvent.label,
    target: input.runtimeEvent.displayPreview ?? input.railEvent.target,
    durationMs: input.railEvent.elapsedMs,
    detailsRef: input.railEvent.activityId,
    riskClass: input.railEvent.riskClass,
    fileChangeInspected: input.runtimeEvent.kind === "tool-result" && input.runtimeEvent.fileChangePreview !== undefined,
  };
}
