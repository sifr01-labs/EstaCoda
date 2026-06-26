import type {
  OperatorConsoleState,
  OperatorConsoleSurface,
  TerminalMetrics,
} from "./operatorConsoleState.js";
import { getPromptSurfaceDesiredHeight } from "./promptSurface.js";

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
const ACTIVE_WORK_PRIORITY = 4;
const ATTACHMENTS_PRIORITY = 5;
const TRANSCRIPT_PRIORITY = 6;

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
  const descriptors: RegionDescriptor[] = [];

  if (state.transcript.length > 0) {
    descriptors.push({
      kind: "transcript",
      priority: TRANSCRIPT_PRIORITY,
      minHeight: 1,
      desiredHeight: Math.min(6, Math.max(1, state.transcript.length)),
    });
  }

  if (state.activeWork.events.length > 0 || state.activeWork.turnSummary !== undefined) {
    descriptors.push({
      kind: "activeWork",
      priority: ACTIVE_WORK_PRIORITY,
      minHeight: 1,
      desiredHeight: Math.min(4, Math.max(1, state.activeWork.events.length + 1)),
    });
  }

  if (state.steer?.queued !== undefined) {
    descriptors.push({
      kind: "queuedSteer",
      priority: INTERACTIVE_OPTIONAL_PRIORITY,
      minHeight: 1,
      desiredHeight: 2,
    });
  }

  if (state.attachments.length > 0) {
    descriptors.push({
      kind: "attachments",
      priority: ATTACHMENTS_PRIORITY,
      minHeight: 1,
      desiredHeight: Math.min(4, Math.max(1, state.attachments.length + 1)),
    });
  }

  descriptors.push({
    kind: "prompt",
    priority: PROMPT_PRIORITY,
    minHeight: 1,
    desiredHeight: getPromptSurfaceDesiredHeight(state.prompt, terminal),
  });

  if (state.slash !== undefined) {
    descriptors.push({
      kind: "slashMenu",
      priority: INTERACTIVE_OPTIONAL_PRIORITY,
      minHeight: 1,
      desiredHeight: Math.min(4, Math.max(1, state.slash.items.length + 1)),
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
    case "transcript":
      return 0;
    case "activeWork":
      return 1;
    case "queuedSteer":
      return 2;
    case "attachments":
      return 3;
    case "prompt":
      return 4;
    case "slashMenu":
      return 5;
    case "statusRail":
      return 6;
  }
}

function normalizeTerminalDimension(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}
