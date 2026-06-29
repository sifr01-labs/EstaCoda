import type { Writable } from "node:stream";
import type { TerminalCapabilities } from "../contracts/ui.js";
import { createLineEditorState } from "../ui/input/lineEditor.js";
import {
  applyActiveWorkRuntimeEvent,
  createActiveWorkRuntimeState,
  getActiveWorkSurfaceDesiredHeight,
  type ActiveWorkRuntimeEvent,
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
  #animationTimer: ReturnType<typeof setInterval> | undefined;
  #streamingRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  #lastTimerRefreshAtMs = Number.NEGATIVE_INFINITY;

  constructor(options: LiveOperatorConsoleControllerOptions) {
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
    if (event.status === "running") {
      this.#flushStreamingSegment();
    }
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
    if (!this.#flushStreamingSegment()) return;
    this.refresh();
  }

  completeStreaming(): readonly TranscriptBlock[] {
    this.#flushStreamingSegment();
    const blocks = this.#streamingSegments
      .filter((segment) => segment.text.trim().length > 0)
      .map((segment) => streamingSegmentToTranscriptBlock(segment));
    if (blocks.length > 0) {
      this.#transcript = [...this.#transcript, ...blocks];
    }
    this.#streamingSegments = [];
    this.#streamingCurrentSegmentText = "";
    this.#streamingTail = "";
    this.#stopStreamingRefreshTimer();
    this.#runtimeHost.setStreaming(undefined);
    this.refresh();
    return blocks;
  }

  resetStreaming(): void {
    this.#streamingSegments = [];
    this.#streamingCurrentSegmentText = "";
    this.#streamingTail = "";
    this.#stopStreamingRefreshTimer();
    this.#runtimeHost.setStreaming(undefined);
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
    return {
      ...this.#terminal,
      height: Math.max(currentHeight, requestedHeight + surroundingChromeRows),
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
    if (this.#streamingSegments.length === 0 && this.#streamingTail.length === 0) return undefined;
    return {
      segments: this.#streamingSegments,
      tail: this.#streamingTail,
      isStreaming: true,
    };
  }

  #syncStreamingState(): void {
    this.#runtimeHost.setStreaming(this.#streamingSnapshotForRender());
  }

  #flushStreamingSegment(): boolean {
    this.#stopStreamingRefreshTimer();
    const text = this.#streamingCurrentSegmentText;
    this.#streamingCurrentSegmentText = "";
    this.#streamingTail = "";
    if (text.trim().length === 0) {
      this.#syncStreamingState();
      return false;
    }
    this.#streamingSegmentSequence += 1;
    this.#streamingSegments = [
      ...this.#streamingSegments,
      {
        id: `streaming-segment-${this.#streamingSegmentSequence}`,
        role: "assistant",
        text,
        createdAtMs: this.#now(),
      },
    ];
    this.#syncStreamingState();
    return true;
  }
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

function clampStreamingTail(text: string): string {
  if (text.length <= MAX_STREAMING_TAIL_CHARS) return text;
  return text.slice(text.length - MAX_STREAMING_TAIL_CHARS);
}

function streamingSegmentToTranscriptBlock(segment: StreamingSegment): TranscriptBlock {
  return {
    id: `streaming-transcript-${segment.id}`,
    role: segment.role,
    text: segment.text,
    ...(segment.createdAtMs === undefined ? {} : { createdAtMs: segment.createdAtMs }),
  };
}
