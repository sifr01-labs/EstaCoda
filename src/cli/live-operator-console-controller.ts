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
  #steer: SteerState | undefined;

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

  clear(): void {
    this.#renderLoop.clear();
  }

  refresh(): void {
    const steerVisible = this.#steer?.mode === "drafting" || this.#steer?.mode === "queued";
    this.#renderLoop.render({
      prompt: "",
      state: createLineEditorState(this.#steer?.mode === "drafting" ? this.#steer.draft : ""),
      operatorConsole: {
        enabled: true,
        terminal: this.#terminal,
        status: this.#getStatus(),
        activeWork: this.#activeWork,
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
}
