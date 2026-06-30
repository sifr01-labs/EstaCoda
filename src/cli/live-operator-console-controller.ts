import type { Writable } from "node:stream";
import type { TerminalCapabilities } from "../contracts/ui.js";
import { createLineEditorState } from "../ui/input/lineEditor.js";
import {
  applyActiveWorkRuntimeEvent,
  createActiveWorkRuntimeState,
  getActiveWorkSurfaceDesiredHeight,
  normalizeActiveWorkRuntimeEventId,
  type ActiveWorkItem,
  type ActiveWorkRuntimeEvent,
  type InlineToolTrailEntry,
  type OperatorConsoleRuntimeHost,
  type StatusRailState,
  type SteerState,
  type StreamingSegment,
  type StreamingState,
  type TerminalMetrics,
  type ToolActivityState,
  type TranscriptBlock,
  type TurnActivityState,
} from "../ui/papyrus/operator-console/index.js";
import { RawPromptRenderLoop } from "./rawPromptRenderLoop.js";

export type LiveOperatorConsoleControllerOptions = {
  readonly output: Pick<Writable, "write"> & {
    readonly columns?: number;
    readonly rows?: number;
    readonly isTTY?: boolean;
  };
  readonly runtimeHost: OperatorConsoleRuntimeHost;
  readonly terminal: Partial<TerminalMetrics>;
  readonly capabilities?: Pick<TerminalCapabilities, "supportsAnimation">;
  readonly animationIntervalMs?: number;
  readonly streamingRefreshIntervalMs?: number;
  readonly getStatus: () => StatusRailState;
  readonly turnStartedAtMs?: number;
  readonly now?: () => number;
};

const DEFAULT_OPERATOR_CONSOLE_ANIMATION_INTERVAL_MS = 90;
const DEFAULT_STREAMING_REFRESH_INTERVAL_MS = 75;
const MIN_TIMER_REFRESH_INTERVAL_MS = 16;
const MAX_STREAMING_TAIL_CHARS = 4_000;

export class LiveOperatorConsoleController {
  readonly #output: LiveOperatorConsoleControllerOptions["output"];
  readonly #renderLoop: RawPromptRenderLoop;
  readonly #runtimeHost: OperatorConsoleRuntimeHost;
  readonly #terminal: Partial<TerminalMetrics>;
  readonly #supportsAnimation: boolean;
  readonly #animationIntervalMs: number;
  readonly #streamingRefreshIntervalMs: number;
  readonly #getStatus: () => StatusRailState;
  readonly #turnStartedAtMs: number | undefined;
  readonly #now: () => number;
  #activeWork: ToolActivityState = createActiveWorkRuntimeState();
  #activeWorkFrameIndex = 0;
  #steer: SteerState | undefined;
  #turnActivity: TurnActivityState | undefined;
  #turnActivityFrameIndex = 0;
  #transcript: readonly TranscriptBlock[];
  #streamingSegments: readonly StreamingSegment[] = [];
  #streamingCurrentSegmentText = "";
  #streamingTail = "";
  #streamingSegmentSequence = 0;
  #streamingToolTrail: readonly InlineToolTrailEntry[] = [];
  #streamingToolTrailSequence = 0;
  #animationTimer: ReturnType<typeof setInterval> | undefined;
  #streamingRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  #lastTimerRefreshAtMs = Number.NEGATIVE_INFINITY;

  constructor(options: LiveOperatorConsoleControllerOptions) {
    this.#output = options.output;
    this.#runtimeHost = options.runtimeHost;
    this.#terminal = options.terminal;
    this.#supportsAnimation = options.capabilities?.supportsAnimation ?? options.terminal.isTty ?? false;
    this.#animationIntervalMs = normalizePositiveInteger(
      options.animationIntervalMs ?? DEFAULT_OPERATOR_CONSOLE_ANIMATION_INTERVAL_MS,
      DEFAULT_OPERATOR_CONSOLE_ANIMATION_INTERVAL_MS
    );
    this.#streamingRefreshIntervalMs = normalizePositiveInteger(
      options.streamingRefreshIntervalMs ?? DEFAULT_STREAMING_REFRESH_INTERVAL_MS,
      DEFAULT_STREAMING_REFRESH_INTERVAL_MS
    );
    this.#getStatus = options.getStatus;
    this.#turnStartedAtMs = options.turnStartedAtMs;
    this.#now = options.now ?? Date.now;
    this.#transcript = [...options.runtimeHost.getState().transcript];
    this.#renderLoop = new RawPromptRenderLoop(options.output, {
      operatorConsoleHostFactory: () => options.runtimeHost,
    });
  }

  get activeWork(): ToolActivityState {
    return this.#activeWork;
  }

  get steer(): SteerState | undefined {
    return this.#steer;
  }

  applyActiveWorkEvent(event: ActiveWorkRuntimeEvent): ToolActivityState {
    const trailAnchor = event.status === "running"
      ? this.#flushStreamingSegment()
      : undefined;
    const timestamp = this.#now();
    const baseState: ToolActivityState = {
      items: this.#activeWork.items,
      scrollOffset: this.#activeWork.scrollOffset,
      expanded: this.#activeWork.expanded,
      startedAtMs: this.#activeWork.startedAtMs ?? this.#turnStartedAtMs ?? timestamp,
      updatedAtMs: timestamp,
      ...(this.#activeWork.frameIndex === undefined ? {} : { frameIndex: this.#activeWork.frameIndex }),
    };
    const next = applyActiveWorkRuntimeEvent(baseState, event);
    this.#activeWork = next;
    this.#upsertStreamingToolTrail(event, next, trailAnchor, timestamp);
    this.refresh();
    return this.#activeWork;
  }

  appendStreamingText(text: string): void {
    if (text.length === 0) return;
    this.#streamingCurrentSegmentText = `${this.#streamingCurrentSegmentText}${text}`;
    this.#streamingTail = clampStreamingTail(this.#streamingCurrentSegmentText);
    this.#syncStreamingState();
    this.#scheduleStreamingRefresh();
  }

  flushStreamingSegment(_reason?: string): void {
    if (this.#flushStreamingSegment() === undefined) return;
    this.refresh();
  }

  completeStreaming(): readonly TranscriptBlock[] {
    this.#flushStreamingSegment();
    const blocks = this.#streamingSegments
      .filter((segment) => segment.text.trim().length > 0)
      .map((segment, index) => streamingSegmentToTranscriptBlock(
        segment,
        this.#toolTrailForSegment(segment.id, { includeUnanchored: index === 0 })
      ));
    if (blocks.length > 0) {
      this.#transcript = [...this.#transcript, ...blocks];
    }
    this.#streamingSegments = [];
    this.#streamingCurrentSegmentText = "";
    this.#streamingTail = "";
    this.#streamingToolTrail = [];
    this.#streamingToolTrailSequence = 0;
    this.#stopStreamingRefreshTimer();
    this.#runtimeHost.setStreaming(undefined);
    this.refresh();
    return blocks;
  }

  discardStreaming(): void {
    this.#clearStreamingState();
  }

  resetStreaming(): void {
    this.#clearStreamingState();
    this.refresh();
  }

  hasStreamingOutput(): boolean {
    return this.#streamingCurrentSegmentText.trim().length > 0 ||
      this.#streamingSegments.some((segment) => segment.text.trim().length > 0);
  }

  resetActiveWork(): void {
    this.#activeWork = createActiveWorkRuntimeState();
    this.#activeWorkFrameIndex = 0;
    this.#runtimeHost.setActiveWork(this.#activeWork);
    this.#syncAnimationTimer();
  }

  completeActiveWork(): ToolActivityState | undefined {
    if (this.#activeWork.items.length === 0) return undefined;
    const timestamp = this.#now();
    this.#activeWork = {
      ...this.#activeWork,
      updatedAtMs: timestamp,
      completedAtMs: this.#activeWork.completedAtMs ?? timestamp,
      frameIndex: undefined,
    };
    this.#runtimeHost.setActiveWork(this.#activeWork);
    this.#syncAnimationTimer();
    return this.#activeWork;
  }

  setSteer(state: SteerState | undefined): void {
    this.#steer = state;
    if (state === undefined) {
      this.#runtimeHost.setSteer(undefined);
    }
    this.refresh();
  }

  setTurnActivity(state: TurnActivityState | undefined): void {
    if (state === undefined) {
      this.#turnActivity = undefined;
      this.#turnActivityFrameIndex = 0;
      this.#runtimeHost.setTurnActivity(undefined);
      this.refresh();
      return;
    }

    this.#turnActivityFrameIndex = isSameTurnActivity(this.#turnActivity, state)
      ? this.#turnActivityFrameIndex + 1
      : 0;
    this.#turnActivity = { ...state, frameIndex: this.#turnActivityFrameIndex };
    this.#runtimeHost.setTurnActivity(this.#turnActivity);
    this.refresh();
  }

  clearTurnActivity(): void {
    this.#turnActivity = undefined;
    this.#turnActivityFrameIndex = 0;
    this.#runtimeHost.setTurnActivity(undefined);
    this.#syncAnimationTimer();
  }

  clear(): void {
    this.#stopAnimationTimer();
    this.#stopStreamingRefreshTimer();
    this.#renderLoop.clear();
  }

  refresh(): void {
    const steerVisible = this.#steer?.mode === "drafting" || this.#steer?.mode === "queued";
    const activeWork = this.#activeWorkSnapshotForRender();
    this.#renderLoop.render({
      prompt: "",
      state: createLineEditorState(this.#steer?.mode === "drafting" ? this.#steer.draft : ""),
      operatorConsole: {
        enabled: true,
        terminal: this.#terminalSnapshotForRender(activeWork),
        status: this.#getStatus(),
        transcript: this.#transcript,
        turnActivity: this.#turnActivity,
        activeWork,
        streaming: this.#streamingSnapshotForRender(),
        steer: this.#steer,
        promptMode: steerVisible ? "steer" : "prompt",
      },
    });
    this.#lastTimerRefreshAtMs = Date.now();
    this.#syncAnimationTimer();
  }

  withDurableWrite(write: () => void, options: { readonly redraw?: boolean } = {}): void {
    this.#stopAnimationTimer();
    this.clear();
    write();
    if (options.redraw === true) {
      this.refresh();
    }
  }

  #activeWorkSnapshotForRender(): ToolActivityState {
    if (!hasUnfinishedActiveWork(this.#activeWork)) {
      this.#activeWorkFrameIndex = 0;
      return this.#activeWork;
    }
    const timestamp = this.#now();
    const snapshot = {
      ...this.#activeWork,
      updatedAtMs: timestamp,
      frameIndex: this.#activeWorkFrameIndex,
    };
    this.#activeWorkFrameIndex += 1;
    return snapshot;
  }

  #terminalSnapshotForRender(activeWork: ToolActivityState): Partial<TerminalMetrics> {
    const requestedHeight = getActiveWorkSurfaceDesiredHeight(activeWork);
    if (requestedHeight <= 0) return this.#terminal;
    const surroundingChromeRows = 32;
    const currentHeight = this.#terminal.height ?? 0;
    const expandedHeight = Math.max(currentHeight, requestedHeight + surroundingChromeRows);
    const viewportHeight = normalizeOptionalPositiveInteger(this.#output.rows);
    return {
      ...this.#terminal,
      height: viewportHeight === undefined
        ? expandedHeight
        : Math.min(viewportHeight, expandedHeight),
    };
  }

  #advanceAnimationFrame(): void {
    if (this.#turnActivity !== undefined) {
      this.#turnActivityFrameIndex += 1;
      this.#turnActivity = {
        ...this.#turnActivity,
        frameIndex: this.#turnActivityFrameIndex,
      };
      this.#runtimeHost.setTurnActivity(this.#turnActivity);
    }
    this.#refreshFromTimer();
  }

  #syncAnimationTimer(): void {
    if (!this.#shouldAnimate()) {
      this.#stopAnimationTimer();
      return;
    }
    if (this.#animationTimer !== undefined) return;
    this.#animationTimer = setInterval(() => {
      this.#advanceAnimationFrame();
    }, this.#animationIntervalMs);
    const timer = this.#animationTimer as { unref?: () => void };
    timer.unref?.();
  }

  #stopAnimationTimer(): void {
    if (this.#animationTimer === undefined) return;
    clearInterval(this.#animationTimer);
    this.#animationTimer = undefined;
  }

  #scheduleStreamingRefresh(): void {
    if (this.#streamingRefreshTimer !== undefined) return;
    this.#streamingRefreshTimer = setTimeout(() => {
      this.#streamingRefreshTimer = undefined;
      this.#refreshFromTimer();
    }, this.#streamingRefreshIntervalMs);
    const timer = this.#streamingRefreshTimer as { unref?: () => void };
    timer.unref?.();
  }

  #stopStreamingRefreshTimer(): void {
    if (this.#streamingRefreshTimer === undefined) return;
    clearTimeout(this.#streamingRefreshTimer);
    this.#streamingRefreshTimer = undefined;
  }

  #refreshFromTimer(): void {
    const now = Date.now();
    if (now - this.#lastTimerRefreshAtMs < MIN_TIMER_REFRESH_INTERVAL_MS) return;
    this.refresh();
  }

  #shouldAnimate(): boolean {
    if (!this.#supportsAnimation) return false;
    const styleAllowsAnimation = this.#runtimeHost.getState().style?.tokens.contract.behavior.allowAnimation ?? true;
    if (!styleAllowsAnimation) return false;
    return this.#turnActivity !== undefined || hasUnfinishedActiveWork(this.#activeWork);
  }

  #streamingSnapshotForRender(): StreamingState | undefined {
    if (
      this.#streamingSegments.length === 0 &&
      this.#streamingTail.length === 0 &&
      this.#streamingToolTrail.length === 0
    ) {
      return undefined;
    }
    return {
      segments: this.#streamingSegments,
      tail: this.#streamingTail,
      isStreaming: true,
      ...(this.#streamingToolTrail.length === 0 ? {} : { toolTrail: this.#streamingToolTrail }),
    };
  }

  #syncStreamingState(): void {
    this.#runtimeHost.setStreaming(this.#streamingSnapshotForRender());
  }

  #clearStreamingState(): void {
    this.#streamingSegments = [];
    this.#streamingCurrentSegmentText = "";
    this.#streamingTail = "";
    this.#streamingToolTrail = [];
    this.#streamingToolTrailSequence = 0;
    this.#stopStreamingRefreshTimer();
    this.#runtimeHost.setStreaming(undefined);
  }

  #flushStreamingSegment(): StreamingSegment | undefined {
    this.#stopStreamingRefreshTimer();
    const text = this.#streamingCurrentSegmentText;
    this.#streamingCurrentSegmentText = "";
    this.#streamingTail = "";
    if (text.trim().length === 0) {
      this.#syncStreamingState();
      return undefined;
    }
    this.#streamingSegmentSequence += 1;
    const segment: StreamingSegment = {
      id: `streaming-segment-${this.#streamingSegmentSequence}`,
      role: "assistant",
      text,
      createdAtMs: this.#now(),
    };
    this.#streamingSegments = [
      ...this.#streamingSegments,
      segment,
    ];
    this.#syncStreamingState();
    return segment;
  }

  #upsertStreamingToolTrail(
    event: ActiveWorkRuntimeEvent,
    state: ToolActivityState,
    trailAnchor: StreamingSegment | undefined,
    timestamp: number
  ): void {
    const id = normalizeActiveWorkRuntimeEventId(event);
    const item = state.items.find((current) => current.id === id);
    if (item === undefined) return;

    const existing = this.#streamingToolTrail.find((entry) => entry.id === id);
    const next = this.#toolTrailEntryFromActiveWorkItem(item, existing, trailAnchor, timestamp);
    this.#streamingToolTrail = existing === undefined
      ? [...this.#streamingToolTrail, next]
      : this.#streamingToolTrail.map((entry) => entry.id === id ? next : entry);
    this.#syncStreamingState();
  }

  #toolTrailEntryFromActiveWorkItem(
    item: ActiveWorkItem,
    existing: InlineToolTrailEntry | undefined,
    trailAnchor: StreamingSegment | undefined,
    timestamp: number
  ): InlineToolTrailEntry {
    const terminal = isTerminalActiveWorkStatus(item.status);
    const startedAtMs = existing?.startedAtMs ?? (terminal ? undefined : timestamp);
    const endedAtMs = terminal ? item.endedAtMs ?? timestamp : undefined;
    const durationMs = resolveToolTrailDurationMs(item, existing, startedAtMs, endedAtMs);
    const afterSegmentId = existing?.afterSegmentId ?? trailAnchor?.id ?? this.#streamingSegments.at(-1)?.id;
    const sequence = existing?.sequence ?? this.#nextToolTrailSequence();

    return {
      id: item.id,
      sequence,
      toolName: item.toolName,
      ...(item.displayLabel === undefined ? {} : { displayLabel: item.displayLabel }),
      status: item.status,
      summary: item.summary,
      ...(item.target === undefined ? {} : { target: item.target }),
      ...(startedAtMs === undefined ? {} : { startedAtMs }),
      ...(endedAtMs === undefined ? {} : { endedAtMs }),
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(item.detailsRef === undefined ? {} : { detailsRef: item.detailsRef }),
      ...(item.riskLevel === undefined ? {} : { riskLevel: item.riskLevel }),
      ...(item.approvalRef === undefined ? {} : { approvalRef: item.approvalRef }),
      ...(item.fileChangeInspected === true ? { fileChangeInspected: true } : {}),
      ...(afterSegmentId === undefined ? {} : { afterSegmentId }),
    };
  }

  #nextToolTrailSequence(): number {
    this.#streamingToolTrailSequence += 1;
    return this.#streamingToolTrailSequence;
  }

  #toolTrailForSegment(
    segmentId: string,
    options: { readonly includeUnanchored: boolean }
  ): readonly InlineToolTrailEntry[] {
    return this.#streamingToolTrail.filter((entry) =>
      entry.afterSegmentId === segmentId ||
      (options.includeUnanchored && entry.afterSegmentId === undefined)
    );
  }
}

function isTerminalActiveWorkStatus(status: ActiveWorkItem["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function resolveToolTrailDurationMs(
  item: ActiveWorkItem,
  existing: InlineToolTrailEntry | undefined,
  startedAtMs: number | undefined,
  endedAtMs: number | undefined
): number | undefined {
  if (item.durationMs !== undefined) return item.durationMs;
  if (startedAtMs !== undefined && endedAtMs !== undefined) return Math.max(0, endedAtMs - startedAtMs);
  return existing?.durationMs;
}

function isSameTurnActivity(
  current: TurnActivityState | undefined,
  next: TurnActivityState
): boolean {
  return current?.phase === next.phase &&
    current.backgroundKind === next.backgroundKind &&
    current.label === next.label;
}

function hasUnfinishedActiveWork(state: ToolActivityState): boolean {
  return state.items.length > 0 && state.completedAtMs === undefined;
}

function normalizePositiveInteger(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : fallback;
}

function normalizeOptionalPositiveInteger(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

function clampStreamingTail(text: string): string {
  if (text.length <= MAX_STREAMING_TAIL_CHARS) return text;
  return text.slice(text.length - MAX_STREAMING_TAIL_CHARS);
}

function streamingSegmentToTranscriptBlock(
  segment: StreamingSegment,
  toolTrail: readonly InlineToolTrailEntry[]
): TranscriptBlock {
  return {
    id: `streaming-transcript-${segment.id}`,
    role: segment.role,
    text: segment.text,
    ...(segment.createdAtMs === undefined ? {} : { createdAtMs: segment.createdAtMs }),
    ...(toolTrail.length === 0 ? {} : { toolTrail }),
  };
}
