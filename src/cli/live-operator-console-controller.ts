import type { Writable } from "node:stream";
import type { TerminalCapabilities } from "../contracts/ui.js";
import { createLineEditorState } from "../ui/input/lineEditor.js";
import {
  applyActiveWorkRuntimeEvent,
  createActiveWorkRuntimeState,
  type ActiveWorkRuntimeEvent,
  type OperatorConsoleRuntimeHost,
  type StatusRailState,
  type SteerState,
  type TerminalMetrics,
  type ToolActivityState,
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
  readonly getStatus: () => StatusRailState;
  readonly now?: () => number;
};

const DEFAULT_OPERATOR_CONSOLE_ANIMATION_INTERVAL_MS = 90;

export class LiveOperatorConsoleController {
  readonly #renderLoop: RawPromptRenderLoop;
  readonly #runtimeHost: OperatorConsoleRuntimeHost;
  readonly #terminal: Partial<TerminalMetrics>;
  readonly #supportsAnimation: boolean;
  readonly #animationIntervalMs: number;
  readonly #getStatus: () => StatusRailState;
  readonly #now: () => number;
  #activeWork: ToolActivityState = createActiveWorkRuntimeState();
  #activeWorkFrameIndex = 0;
  #steer: SteerState | undefined;
  #turnActivity: TurnActivityState | undefined;
  #turnActivityFrameIndex = 0;
  #animationTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: LiveOperatorConsoleControllerOptions) {
    this.#runtimeHost = options.runtimeHost;
    this.#terminal = options.terminal;
    this.#supportsAnimation = options.capabilities?.supportsAnimation ?? options.terminal.isTty ?? false;
    this.#animationIntervalMs = normalizePositiveInteger(
      options.animationIntervalMs ?? DEFAULT_OPERATOR_CONSOLE_ANIMATION_INTERVAL_MS,
      DEFAULT_OPERATOR_CONSOLE_ANIMATION_INTERVAL_MS
    );
    this.#getStatus = options.getStatus;
    this.#now = options.now ?? Date.now;
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
    const timestamp = this.#now();
    const baseState: ToolActivityState = {
      items: this.#activeWork.items,
      scrollOffset: this.#activeWork.scrollOffset,
      expanded: this.#activeWork.expanded,
      startedAtMs: this.#activeWork.startedAtMs ?? timestamp,
      updatedAtMs: timestamp,
      ...(this.#activeWork.frameIndex === undefined ? {} : { frameIndex: this.#activeWork.frameIndex }),
    };
    const next = applyActiveWorkRuntimeEvent(baseState, event);
    this.#activeWork = {
      ...next,
      ...(hasOpenActiveWork(next) ? {} : { completedAtMs: timestamp }),
    };
    this.refresh();
    return this.#activeWork;
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
        terminal: this.#terminal,
        status: this.#getStatus(),
        turnActivity: this.#turnActivity,
        activeWork,
        steer: this.#steer,
        promptMode: steerVisible ? "steer" : "prompt",
      },
    });
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
    if (!hasRunningActiveWork(this.#activeWork)) {
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

  #advanceAnimationFrame(): void {
    if (this.#turnActivity !== undefined) {
      this.#turnActivityFrameIndex += 1;
      this.#turnActivity = {
        ...this.#turnActivity,
        frameIndex: this.#turnActivityFrameIndex,
      };
      this.#runtimeHost.setTurnActivity(this.#turnActivity);
    }
    this.refresh();
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

  #shouldAnimate(): boolean {
    if (!this.#supportsAnimation) return false;
    const styleAllowsAnimation = this.#runtimeHost.getState().style?.tokens.contract.behavior.allowAnimation ?? true;
    if (!styleAllowsAnimation) return false;
    return this.#turnActivity !== undefined || hasRunningActiveWork(this.#activeWork);
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

function hasRunningActiveWork(state: ToolActivityState): boolean {
  return state.items.some((item) => item.status === "running");
}

function hasOpenActiveWork(state: ToolActivityState): boolean {
  return state.items.some((item) =>
    item.status === "running" ||
    item.status === "queued" ||
    item.status === "awaitingApproval"
  );
}

function normalizePositiveInteger(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : fallback;
}
