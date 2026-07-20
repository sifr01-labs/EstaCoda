import type {
  OperatorConsoleLayout,
  OperatorConsoleRegion,
} from "./operatorConsoleLayout.js";
import type {
  OperatorConsoleState,
} from "./operatorConsoleState.js";
import { renderActiveWorkSurface } from "./activeWorkSurface.js";
import { renderApprovalSurface } from "./approvalSurface.js";
import { renderAttachmentSurface } from "./attachmentSurface.js";
import { renderPromptSurface } from "./promptSurface.js";
import { renderSetupPanelSurface } from "./setupPanelSurface.js";
import {
  isSteerInputActive,
  renderQueuedSteerSurface,
  renderSteerInputSurface,
} from "./steerSurface.js";
import { renderSlashSurface } from "./slashSurface.js";
import { renderStartupDashboardSurface } from "./startupDashboardSurface.js";
import { renderStatusRailSurface } from "./statusRailSurface.js";
import { renderStreamingSurface } from "./streamingSurface.js";
import { renderTranscriptSurface } from "./transcriptSurface.js";
import { renderTurnActivitySurface } from "./turnActivitySurface.js";
import { renderTaskCardSurface, renderTaskInspectionSurface } from "./taskSurface.js";

export type OperatorConsoleRenderedLine = {
  readonly region: OperatorConsoleRegion["kind"];
  readonly text: string;
};

export function renderOperatorConsoleLines(
  state: OperatorConsoleState,
  layout: OperatorConsoleLayout
): readonly OperatorConsoleRenderedLine[] {
  return layout.regions.flatMap((region) => renderRegionLines(state, region));
}

export function renderOperatorConsoleTextLines(
  state: OperatorConsoleState,
  layout: OperatorConsoleLayout
): readonly string[] {
  return renderOperatorConsoleLines(state, layout).map((line) => line.text);
}

function renderRegionLines(
  state: OperatorConsoleState,
  region: OperatorConsoleRegion
): readonly OperatorConsoleRenderedLine[] {
  if (!region.visible || region.height <= 0 || region.width <= 0) return [];
  if (region.kind === "startupDashboard") {
    return renderStartupDashboardSurface(state.startup, {
      width: region.width,
      height: region.height,
      locale: state.locale,
      style: state.style,
    }).map((text) => ({ region: region.kind, text }));
  }
  if (region.kind === "setupPanel" && state.setupPanel !== undefined) {
    return renderSetupPanelSurface(state.setupPanel, {
      width: region.width,
      height: region.height,
      style: state.style,
    }).map((text) => ({ region: region.kind, text }));
  }
  if (region.kind === "prompt") {
    if (isSteerInputActive(state.steer) && state.steer !== undefined) {
      return renderSteerInputSurface(state.steer, {
        width: region.width,
        height: region.height,
      }).map((text) => ({ region: region.kind, text }));
    }
    return renderPromptSurface(state.prompt, {
      width: region.width,
      height: region.height,
      terminalHeight: layoutHeightForRegion(region),
      style: state.style,
    }).map((text) => ({ region: region.kind, text }));
  }
  if (region.kind === "attachments") {
    return renderAttachmentSurface(state.attachments, {
      width: region.width,
      height: region.height,
      focusedAttachmentId: state.focus.target.kind === "attachment" ? state.focus.target.attachmentId : undefined,
    }).map((text) => ({ region: region.kind, text }));
  }
  if (region.kind === "taskCards") {
    return renderTaskCardSurface(state.tasks, {
      width: region.width,
      height: region.height,
      locale: state.locale,
      isTty: state.terminal.isTty,
      focusedTaskId: state.focus.target.kind === "taskCard" ? state.focus.target.taskId : undefined,
    }).map((text) => ({ region: region.kind, text }));
  }
  if (region.kind === "taskInspection") {
    return renderTaskInspectionSurface(state.tasks, {
      width: region.width,
      height: region.height,
      locale: state.locale,
      isTty: state.terminal.isTty,
    }).map((text) => ({ region: region.kind, text }));
  }
  if (region.kind === "activeWork") {
    return renderActiveWorkSurface(state.activeWork, {
      width: region.width,
      height: region.height,
      locale: state.locale,
      style: state.style,
    }).map((text) => ({ region: region.kind, text }));
  }
  if (region.kind === "streaming") {
    return renderStreamingSurface(state.streaming, {
      width: region.width,
      height: region.height,
      style: state.style,
    }).map((text) => ({ region: region.kind, text }));
  }
  if (region.kind === "transcript") {
    return renderTranscriptSurface(state.transcript, {
      width: region.width,
      height: region.height,
      style: state.style,
    }).map((text) => ({ region: region.kind, text }));
  }
  if (region.kind === "turnActivity") {
    return renderTurnActivitySurface(state.turnActivity, {
      width: region.width,
      locale: state.locale,
      activeWork: state.activeWork,
      style: state.style,
    }).map((text) => ({ region: region.kind, text }));
  }
  if (region.kind === "approvals") {
    return renderApprovalSurface(state.approvals, {
      width: region.width,
      height: region.height,
    }).map((text) => ({ region: region.kind, text }));
  }
  if (region.kind === "queuedSteer" && state.steer?.queued !== undefined) {
    return renderQueuedSteerSurface(state.steer.queued, {
      width: region.width,
      height: region.height,
    }).map((text) => ({ region: region.kind, text }));
  }
  if (region.kind === "slashMenu") {
    return renderSlashSurface(state.slash, {
      width: region.width,
      height: region.height,
      style: state.style,
    }).map((text) => ({ region: region.kind, text }));
  }
  if (region.kind === "statusRail") {
    return [{ region: region.kind, text: renderStatusRailSurface(state.status, { width: region.width, style: state.style }) }];
  }
  const lines: OperatorConsoleRenderedLine[] = [];
  for (let row = 0; row < region.height; row += 1) {
    lines.push({
      region: region.kind,
      text: truncateLine(regionLabel(state, region, row), region.width),
    });
  }
  return lines;
}

function regionLabel(
  state: OperatorConsoleState,
  region: OperatorConsoleRegion,
  row: number
): string {
  if (row > 0) return `${region.kind}`;
  switch (region.kind) {
    case "startupDashboard":
      return `Startup: ${state.startup?.productName ?? "EstaCoda"}`;
    case "setupPanel":
      return `Setup: ${state.setupPanel?.title ?? ""}`;
    case "transcript":
      return "";
    case "streaming":
      return `Streaming: ${state.streaming?.segments.length ?? 0} segment${plural(state.streaming?.segments.length ?? 0)}`;
    case "approvals":
      return `Approvals: ${state.approvals.length}`;
    case "turnActivity":
      return `Turn activity: ${state.turnActivity?.phase ?? ""}`;
    case "queuedSteer":
      return `Queued steer: ${state.steer?.queued?.text ?? ""}`;
    case "taskCards":
      return `Tasks: ${state.tasks.cards.length}`;
    case "taskInspection":
      return `Task: ${state.tasks.inspectedTaskId ?? ""}`;
    case "attachments":
      return `Attachments: ${state.attachments.length}`;
    case "prompt":
      return `Prompt: ${state.prompt.value.length > 0 ? state.prompt.value : ">"}`;
    case "slashMenu":
      return `Slash menu: ${state.slash?.query ?? ""}`;
    case "statusRail":
      return renderStatusRailSurface(state.status, { width: region.width, style: state.style });
    case "activeWork":
      return "";
  }
}

function truncateLine(line: string, width: number): string {
  if (width <= 0) return "";
  if (line.length <= width) return line;
  return line.slice(0, width);
}

function plural(count: number): string {
  return count === 1 ? "" : "s";
}

function layoutHeightForRegion(region: OperatorConsoleRegion): number {
  return region.y + region.height;
}
