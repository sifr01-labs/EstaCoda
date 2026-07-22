import type {
  OperatorConsoleState,
  OperatorConsoleSurface,
  TerminalMetrics,
} from "./operatorConsoleState.js";
import {
  getActiveWorkSurfaceDesiredHeight,
  hasActiveWork,
  hasRunningDelegationWork,
} from "./activeWorkSurface.js";
import { getApprovalSurfaceDesiredHeight } from "./approvalSurface.js";
import { getAttachmentSurfaceDesiredHeight } from "./attachmentSurface.js";
import { getPromptSurfaceDesiredHeight } from "./promptSurface.js";
import { getSetupPanelSurfaceDesiredHeight } from "./setupPanelSurface.js";
import { getSlashSurfaceDesiredHeight } from "./slashSurface.js";
import { getStartupDashboardSurfaceDesiredHeight } from "./startupDashboardSurface.js";
import {
  getStreamingSurfaceDesiredHeight,
  hasLiveStreamingTail,
  hasStreamingSurface,
} from "./streamingSurface.js";
import { getTurnActivitySurfaceDesiredHeight } from "./turnActivitySurface.js";
import {
  getQueuedSteerSurfaceDesiredHeight,
  getSteerInputSurfaceDesiredHeight,
  hasQueuedSteer,
  isSteerInputActive,
} from "./steerSurface.js";
import { getTranscriptSurfaceDesiredHeight } from "./transcriptSurface.js";
import {
  getTaskCardSurfaceDesiredHeight,
  getTaskInspectionSurfaceDesiredHeight,
  hasTaskCards,
} from "./taskSurface.js";

export type OperatorConsoleRegionKind = OperatorConsoleSurface;

export type OperatorConsoleRegion = {
  readonly kind: OperatorConsoleRegionKind;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly visible: boolean;
};

export type OperatorConsoleLayout = {
  readonly width: number;
  readonly height: number;
  readonly regions: readonly OperatorConsoleRegion[];
};

type RegionDescriptor = {
  readonly kind: OperatorConsoleRegionKind;
  readonly priority: number;
  readonly desiredHeight: number;
  readonly minHeight: number;
};

const PROMPT_PRIORITY = 1;
const STATUS_PRIORITY = 2;
const INTERACTIVE_OPTIONAL_PRIORITY = 3;
const APPROVAL_PRIORITY = 3;
const TURN_ACTIVITY_PRIORITY = 3;
const ACTIVE_WORK_PRIORITY = 4;
const STREAMING_PRIORITY = 5;
const ATTACHMENTS_PRIORITY = 5;
const TRANSCRIPT_PRIORITY = 6;
const STARTUP_PRIORITY = 7;
const TASK_CARD_PRIORITY = 4;
const SHOW_LIVE_ACTIVE_WORK_REGION = false;

export function createOperatorConsoleLayout(
  state: OperatorConsoleState,
  terminal: TerminalMetrics = state.terminal
): OperatorConsoleLayout {
  const width = normalizeTerminalDimension(terminal.width);
  const height = normalizeTerminalDimension(terminal.height);
  const descriptors = createRegionDescriptors(state, { width, height, isTty: terminal.isTty });
  const allocatedHeights = allocateRegionHeights(descriptors, height);

  let y = 0;
  const regions = descriptors.map((descriptor) => {
    const regionHeight = allocatedHeights.get(descriptor.kind) ?? 0;
    const region = {
      kind: descriptor.kind,
      x: 0,
      y,
      width,
      height: regionHeight,
      visible: regionHeight > 0 && width > 0,
    };
    y += regionHeight;
    return region;
  });

  return {
    width,
    height,
    regions,
  };
}

function createRegionDescriptors(
  state: OperatorConsoleState,
  terminal: TerminalMetrics
): readonly RegionDescriptor[] {
  if (state.mode === "setup") {
    return createSetupRegionDescriptors(state, terminal);
  }

  if (state.tasks.inspectedTaskId !== undefined) {
    return [{
      kind: "taskInspection",
      priority: PROMPT_PRIORITY,
      minHeight: 1,
      desiredHeight: getTaskInspectionSurfaceDesiredHeight(terminal.height),
    }];
  }

  const descriptors: RegionDescriptor[] = [];

  if (state.startup !== undefined) {
    const surfaceHeight = getStartupDashboardSurfaceDesiredHeight(state.startup, terminal.width, state.locale);
    descriptors.push({
      kind: "startupDashboard",
      priority: STARTUP_PRIORITY,
      minHeight: 1,
      desiredHeight: state.locale === "ar" ? Math.max(surfaceHeight, terminal.height - 2) : surfaceHeight,
    });
  }

  if (state.setupPanel !== undefined) {
    descriptors.push({
      kind: "setupPanel",
      priority: STARTUP_PRIORITY,
      minHeight: 1,
      desiredHeight: getSetupPanelSurfaceDesiredHeight(state.setupPanel, terminal.width),
    });
  }

  if (state.transcript.length > 0) {
    descriptors.push({
      kind: "transcript",
      priority: TRANSCRIPT_PRIORITY,
      minHeight: 1,
      desiredHeight: getTranscriptSurfaceDesiredHeight(state.transcript, terminal.width),
    });
  }

  if (hasStreamingSurface(state.streaming)) {
    descriptors.push({
      kind: "streaming",
      priority: STREAMING_PRIORITY,
      minHeight: 1,
      desiredHeight: getStreamingSurfaceDesiredHeight(state.streaming, terminal.width, {
        terminalHeight: terminal.height,
      }),
    });
  }

  if (state.approvals.length > 0) {
    descriptors.push({
      kind: "approvals",
      priority: APPROVAL_PRIORITY,
      minHeight: 1,
      desiredHeight: getApprovalSurfaceDesiredHeight(state.approvals),
    });
  }

  if (state.turnActivity !== undefined) {
    descriptors.push({
      kind: "turnActivity",
      priority: TURN_ACTIVITY_PRIORITY,
      minHeight: 1,
      desiredHeight: getTurnActivitySurfaceDesiredHeight(state.turnActivity),
    });
  }

  if (shouldShowActiveWorkRegion(state)) {
    descriptors.push({
      kind: "activeWork",
      priority: ACTIVE_WORK_PRIORITY,
      minHeight: 1,
      desiredHeight: getActiveWorkSurfaceDesiredHeight(state.activeWork, terminal.width),
    });
  }

  if (hasQueuedSteer(state.steer) && state.steer?.queued !== undefined) {
    descriptors.push({
      kind: "queuedSteer",
      priority: INTERACTIVE_OPTIONAL_PRIORITY,
      minHeight: 1,
      desiredHeight: getQueuedSteerSurfaceDesiredHeight(state.steer.queued),
    });
  }

  if (hasTaskCards(state.tasks)) {
    descriptors.push({
      kind: "taskCards",
      priority: TASK_CARD_PRIORITY,
      minHeight: 1,
      desiredHeight: getTaskCardSurfaceDesiredHeight(state.tasks, terminal.width),
    });
  }

  if (state.attachments.length > 0) {
    descriptors.push({
      kind: "attachments",
      priority: ATTACHMENTS_PRIORITY,
      minHeight: 1,
      desiredHeight: getAttachmentSurfaceDesiredHeight(state.attachments, terminal.width),
    });
  }

  descriptors.push({
    kind: "prompt",
    priority: PROMPT_PRIORITY,
    minHeight: 1,
    desiredHeight: isSteerInputActive(state.steer) && state.steer !== undefined
      ? getSteerInputSurfaceDesiredHeight(state.steer)
      : getPromptSurfaceDesiredHeight(state.prompt, terminal),
  });

  if (state.slash !== undefined) {
    descriptors.push({
      kind: "slashMenu",
      priority: INTERACTIVE_OPTIONAL_PRIORITY,
      minHeight: 1,
      desiredHeight: getSlashSurfaceDesiredHeight(state.slash),
    });
  }

  descriptors.push({
    kind: "statusRail",
    priority: STATUS_PRIORITY,
    minHeight: 1,
    desiredHeight: 1,
  });

  return descriptors;
}

function shouldShowActiveWorkRegion(state: OperatorConsoleState): boolean {
  if (!hasActiveWork(state.activeWork)) return false;
  if (state.activeWork.completedAtMs !== undefined) return true;
  if (hasRunningDelegationWork(state.activeWork)) {
    if (hasMatchingDurableSubagentCards(state)) return false;
    return !hasLiveStreamingTail(state.streaming);
  }
  if (!SHOW_LIVE_ACTIVE_WORK_REGION) return false;
  return !hasStreamingSurface(state.streaming);
}

function hasMatchingDurableSubagentCards(state: OperatorConsoleState): boolean {
  const projectedTaskIds = new Set(
    state.tasks.cards
      .filter((card) => card.subagents.length > 0)
      .map((card) => card.taskId)
  );
  const runningTaskIds = state.activeWork.items
    .filter((item) => item.source === "subagent" && item.status === "running" && item.taskId !== undefined)
    .map((item) => item.taskId!);
  return runningTaskIds.length > 0 && runningTaskIds.every((taskId) => projectedTaskIds.has(taskId));
}

function createSetupRegionDescriptors(
  state: OperatorConsoleState,
  terminal: TerminalMetrics
): readonly RegionDescriptor[] {
  const descriptors: RegionDescriptor[] = [];

  if (state.setupPanel !== undefined) {
    descriptors.push({
      kind: "setupPanel",
      priority: PROMPT_PRIORITY,
      minHeight: 1,
      desiredHeight: getSetupPanelSurfaceDesiredHeight(state.setupPanel, terminal.width),
    });
  }

  return descriptors;
}

function allocateRegionHeights(
  descriptors: readonly RegionDescriptor[],
  totalHeight: number
): ReadonlyMap<OperatorConsoleRegionKind, number> {
  const allocations = new Map<OperatorConsoleRegionKind, number>();
  let remaining = totalHeight;

  for (const descriptor of descriptors) allocations.set(descriptor.kind, 0);

  for (const descriptor of [...descriptors].sort(compareRegionPriority)) {
    if (remaining <= 0) break;
    if (remaining < descriptor.minHeight) continue;
    allocations.set(descriptor.kind, descriptor.minHeight);
    remaining -= descriptor.minHeight;
  }

  for (const descriptor of [...descriptors].sort(compareRegionPriority)) {
    if (remaining <= 0) break;
    const currentHeight = allocations.get(descriptor.kind) ?? 0;
    if (currentHeight === 0) continue;
    const extra = Math.min(remaining, descriptor.desiredHeight - currentHeight);
    if (extra <= 0) continue;
    allocations.set(descriptor.kind, currentHeight + extra);
    remaining -= extra;
  }

  return allocations;
}

function compareRegionPriority(a: RegionDescriptor, b: RegionDescriptor): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  return surfaceOrderIndex(a.kind) - surfaceOrderIndex(b.kind);
}

function surfaceOrderIndex(kind: OperatorConsoleRegionKind): number {
  switch (kind) {
    case "startupDashboard":
      return 0;
    case "setupPanel":
      return 1;
    case "transcript":
      return 2;
    case "streaming":
      return 3;
    case "approvals":
      return 4;
    case "turnActivity":
      return 5;
    case "activeWork":
      return 6;
    case "queuedSteer":
      return 7;
    case "taskCards":
      return 8;
    case "taskInspection":
      return 9;
    case "attachments":
      return 10;
    case "prompt":
      return 11;
    case "slashMenu":
      return 12;
    case "statusRail":
      return 13;
  }
}

function normalizeTerminalDimension(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}
