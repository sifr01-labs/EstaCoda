import { getActivityTraceHitLayout, renderActivityTraceSurface } from "./activityTraceSurface.js";
import type { OperatorConsoleLayout, OperatorConsoleRegion } from "./operatorConsoleLayout.js";
import type { OperatorConsoleState, TaskCardState, TaskCardSubagentState } from "./operatorConsoleState.js";
import { subagentInspectionContentLines } from "./subagentInspectionSurface.js";
import {
  getTaskCardHitTargets,
  type TaskSurfacePointerAction,
} from "./taskSurface.js";
import { taskOverviewContentLines } from "./taskOverviewSurface.js";

const WIDE_OVERVIEW_WIDTH = 100;
const WIDE_COLUMN_GAP = 3;

export type OperatorConsoleHitRegion = {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly action: TaskSurfacePointerAction;
};

export function createOperatorConsoleHitRegions(
  state: OperatorConsoleState,
  layout: OperatorConsoleLayout
): readonly OperatorConsoleHitRegion[] {
  const regions: OperatorConsoleHitRegion[] = [];
  const taskCards = layout.regions.find((region) => region.kind === "taskCards" && region.visible);
  if (taskCards !== undefined) {
    for (const target of getTaskCardHitTargets(state.tasks, taskCards.width, taskCards.height)) {
      if (target.kind === "taskHeader") {
        regions.push({
          id: `task:${target.taskId}`,
          x: taskCards.x + target.x,
          y: taskCards.y + target.y,
          width: target.width,
          height: target.height,
          action: { type: "openTask", taskId: target.taskId },
        });
      } else if (target.stepId !== undefined) {
        regions.push({
          id: `task:${target.taskId}:subagent:${target.stepId}`,
          x: taskCards.x + target.x,
          y: taskCards.y + target.y,
          width: target.width,
          height: target.height,
          action: { type: "openSubagent", taskId: target.taskId, stepId: target.stepId },
        });
      }
    }
  }

  const inspection = layout.regions.find((region) => region.kind === "taskInspection" && region.visible);
  if (inspection !== undefined) regions.push(...inspectionHitRegions(state, inspection));
  return regions;
}

export function findOperatorConsoleHitRegion(
  regions: readonly OperatorConsoleHitRegion[],
  x: number,
  y: number
): OperatorConsoleHitRegion | undefined {
  return [...regions].reverse().find((region) =>
    x >= region.x && x < region.x + region.width && y >= region.y && y < region.y + region.height
  );
}

function inspectionHitRegions(
  state: OperatorConsoleState,
  region: OperatorConsoleRegion
): readonly OperatorConsoleHitRegion[] {
  const card = state.tasks.cards.find((candidate) => candidate.taskId === state.tasks.inspectedTaskId);
  if (card === undefined) return [];
  const inspectedSubagent = card.subagents.find((candidate) =>
    candidate.stepId === state.tasks.inspection?.inspectedSubagentStepId
  );
  const content = inspectedSubagent === undefined
    ? taskOverviewContentLines(card, region.width, {
        locale: state.locale,
        inspection: state.tasks.inspection,
      })
    : subagentInspectionContentLines(card, inspectedSubagent, region.width, {
        locale: state.locale,
        inspection: state.tasks.inspection,
      });
  const contentHeight = Math.max(0, region.height - 2);
  const maxOffset = Math.max(0, content.length - contentHeight);
  const offset = Math.min(maxOffset, Math.max(0, state.tasks.scrollOffset));
  const regions: OperatorConsoleHitRegion[] = [{
    id: inspectedSubagent === undefined ? `task:${card.taskId}:back` : `task:${card.taskId}:subagent:back`,
    x: region.x,
    y: region.y,
    width: region.width,
    height: 1,
    action: { type: "back" },
  }];

  if (inspectedSubagent === undefined) {
    const subagentWidth = region.width >= WIDE_OVERVIEW_WIDTH
      ? Math.max(1, Math.floor((Math.max(1, region.width - 2) - WIDE_COLUMN_GAP) / 2))
      : region.width;
    for (const subagent of card.subagents) {
      const contentRow = content.findIndex((line) => line.includes(subagent.displayLabel));
      addVisibleRegion(regions, {
        id: `task:${card.taskId}:row:${subagent.stepId}`,
        x: region.x,
        contentRow,
        offset,
        contentHeight,
        region,
        width: subagentWidth,
        action: { type: "openSubagent", taskId: card.taskId, stepId: subagent.stepId },
      });
    }
    addTraceRegions(regions, state, region, card, undefined, content, offset, contentHeight);
  } else {
    addTraceRegions(regions, state, region, card, inspectedSubagent, content, offset, contentHeight);
  }
  return regions;
}

function addTraceRegions(
  regions: OperatorConsoleHitRegion[],
  state: OperatorConsoleState,
  region: OperatorConsoleRegion,
  card: TaskCardState,
  subagent: TaskCardSubagentState | undefined,
  content: readonly string[],
  offset: number,
  contentHeight: number
): void {
  const scope = subagent === undefined ? "task" as const : "subagent" as const;
  const traceCard: TaskCardState = subagent === undefined
    ? card
    : { ...card, subagents: [subagent], trace: { events: subagent.trace, hasEarlierEvents: false } };
  const traceInspection = subagent === undefined
    ? state.tasks.inspection
    : state.tasks.inspection?.subagentTrace;
  const traceWidth = Math.max(1, region.width - 2);
  const traceLines = renderActivityTraceSurface(traceCard, traceInspection, {
    width: traceWidth,
    locale: state.locale,
  });
  const traceTitleRow = content.findIndex((line) => line === traceLines[0]);
  const traceRow = traceTitleRow < 0 ? -1 : traceTitleRow + 1;
  const hitLayout = getActivityTraceHitLayout(traceCard, traceInspection, {
    width: traceWidth,
    locale: state.locale,
  });
  if (hitLayout !== undefined) {
    for (const event of hitLayout.events) {
      addVisibleRegion(regions, {
        id: `task:${card.taskId}:${scope}:event:${event.eventId}`,
        x: region.x + event.column,
        contentRow: traceRow,
        offset,
        contentHeight,
        region,
        width: 1,
        action: { type: "selectTraceEvent", scope, eventId: event.eventId },
      });
    }
    addVisibleRegion(regions, {
      id: `task:${card.taskId}:${scope}:live`,
      x: region.x + hitLayout.liveColumn,
      contentRow: traceRow,
      offset,
      contentHeight,
      region,
      width: 1,
      action: { type: "returnToLive", scope },
    });
  }
  const returnToLiveRow = traceInspection?.followLive === false
    ? content.findIndex((line) => line.includes(state.locale === "ar" ? "العودة للبث المباشر" : "Return to live"))
    : -1;
  addVisibleRegion(regions, {
    id: `task:${card.taskId}:${scope}:return-live`,
    x: region.x,
    contentRow: returnToLiveRow,
    offset,
    contentHeight,
    region,
    width: region.width,
    action: { type: "returnToLive", scope },
  });
}

function addVisibleRegion(
  regions: OperatorConsoleHitRegion[],
  input: {
    readonly id: string;
    readonly x: number;
    readonly contentRow: number;
    readonly offset: number;
    readonly contentHeight: number;
    readonly region: OperatorConsoleRegion;
    readonly width: number;
    readonly action: TaskSurfacePointerAction;
  }
): void {
  const visibleRow = input.contentRow - input.offset;
  if (input.contentRow < 0 || visibleRow < 0 || visibleRow >= input.contentHeight || input.width <= 0) return;
  regions.push({
    id: input.id,
    x: input.x,
    y: input.region.y + 1 + visibleRow,
    width: input.width,
    height: 1,
    action: input.action,
  });
}
