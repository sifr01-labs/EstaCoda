import type { Writable } from "node:stream";
import { createLineEditorState } from "../ui/input/lineEditor.js";
import {
  applyActiveWorkRuntimeEvent,
  createActiveWorkRuntimeState,
  formatActiveWorkSummary,
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
  readonly getStatus: () => StatusRailState;
};

export class LiveOperatorConsoleController {
  readonly #renderLoop: RawPromptRenderLoop;
  readonly #runtimeHost: OperatorConsoleRuntimeHost;
  readonly #terminal: Partial<TerminalMetrics>;
  readonly #getStatus: () => StatusRailState;
  #activeWork: ToolActivityState = createActiveWorkRuntimeState();
  #activeWorkFrameIndex = 0;
  #steer: SteerState | undefined;
  #turnActivity: TurnActivityState | undefined;
  #turnActivityFrameIndex = 0;

  constructor(options: LiveOperatorConsoleControllerOptions) {
    this.#runtimeHost = options.runtimeHost;
    this.#terminal = options.terminal;
    this.#getStatus = options.getStatus;
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
    this.#activeWork = applyActiveWorkRuntimeEvent(this.#activeWork, event);
    this.refresh();
    return this.#activeWork;
  }

  resetActiveWork(): void {
    this.#activeWork = createActiveWorkRuntimeState();
    this.#activeWorkFrameIndex = 0;
    this.#runtimeHost.setActiveWork(this.#activeWork);
  }

  activeWorkSummary(): string | undefined {
    return this.#activeWork.items.length === 0 ? undefined : formatActiveWorkSummary(this.#activeWork);
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

  clear(): void {
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
  }

  withDurableWrite(write: () => void, options: { readonly redraw?: boolean } = {}): void {
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
    const snapshot = {
      ...this.#activeWork,
      frameIndex: this.#activeWorkFrameIndex,
    };
    this.#activeWorkFrameIndex += 1;
    return snapshot;
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
