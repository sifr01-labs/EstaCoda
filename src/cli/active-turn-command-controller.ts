import { emitKeypressEvents } from "node:readline";

export type ActiveTurnCommandControllerOptions = {
  readonly input: NodeJS.ReadStream;
  readonly enabled?: boolean;
  readonly onCommandLaneChange: (line: string | undefined) => void;
  readonly onInterrupt: () => void;
  readonly onStatusMessage?: (message: string) => void;
  readonly emitSigint?: () => void;
};

type Keypress = {
  readonly name?: string;
  readonly ctrl?: boolean;
  readonly sequence?: string;
};

export class ActiveTurnCommandController {
  readonly #input: NodeJS.ReadStream;
  readonly #enabled: boolean;
  readonly #onCommandLaneChange: (line: string | undefined) => void;
  readonly #onInterrupt: () => void;
  readonly #onStatusMessage?: (message: string) => void;
  readonly #emitSigint: () => void;
  readonly #onKeypress = (chunk: string, key: Keypress = {}) => this.#handleKeypress(chunk, key);
  #buffer: string | undefined;
  #attached = false;
  #disposed = false;
  #wasRaw = false;

  constructor(options: ActiveTurnCommandControllerOptions) {
    this.#input = options.input;
    this.#enabled = options.enabled ?? true;
    this.#onCommandLaneChange = options.onCommandLaneChange;
    this.#onInterrupt = options.onInterrupt;
    this.#onStatusMessage = options.onStatusMessage;
    this.#emitSigint = options.emitSigint ?? (() => process.emit("SIGINT"));
  }

  start(): void {
    if (this.#disposed || this.#attached || !this.#enabled || this.#input.isTTY !== true) {
      return;
    }
    this.#wasRaw = this.#input.isRaw === true;
    emitKeypressEvents(this.#input);
    this.#input.on("keypress", this.#onKeypress);
    this.#input.setRawMode?.(true);
    this.#input.resume();
    this.#attached = true;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#clearBuffer();
    if (!this.#attached) return;
    this.#input.off("keypress", this.#onKeypress);
    if (!this.#wasRaw) {
      this.#input.setRawMode?.(false);
    }
    this.#attached = false;
  }

  #handleKeypress(chunk: string, key: Keypress): void {
    if (this.#disposed) return;
    if (key.ctrl === true && key.name === "c") {
      this.#emitSigint();
      return;
    }

    if (this.#buffer === undefined) {
      if (chunk === "/" || key.sequence === "/") {
        this.#buffer = "/";
        this.#renderBuffer();
      }
      return;
    }

    if (key.name === "escape") {
      this.#clearBuffer();
      return;
    }
    if (key.ctrl === true && key.name === "u") {
      this.#clearBuffer();
      return;
    }
    if (key.name === "backspace") {
      this.#buffer = this.#buffer.slice(0, -1);
      if (this.#buffer.length === 0) {
        this.#clearBuffer();
      } else {
        this.#renderBuffer();
      }
      return;
    }
    if (key.name === "return" || key.name === "enter") {
      const command = this.#buffer;
      this.#clearBuffer();
      this.#submit(command);
      return;
    }
    if (isPrintableInput(chunk)) {
      this.#buffer += chunk;
      this.#renderBuffer();
    }
  }

  #submit(command: string): void {
    const normalized = command.trim().replace(/\s+/gu, " ");
    if (normalized.length === 0 || normalized === "/") {
      return;
    }
    if (normalized === "/interrupt") {
      this.#onInterrupt();
      return;
    }
    if (normalized.startsWith("/steer")) {
      this.#onStatusMessage?.("/steer is reserved for a later active-turn flow.");
      return;
    }
    this.#onStatusMessage?.(`Unknown active command: ${normalized}`);
  }

  #renderBuffer(): void {
    if (this.#buffer === undefined) return;
    this.#onCommandLaneChange(`active command: ${this.#buffer}`);
  }

  #clearBuffer(): void {
    if (this.#buffer === undefined) return;
    this.#buffer = undefined;
    this.#onCommandLaneChange(undefined);
  }
}

function isPrintableInput(value: string): boolean {
  return value.length > 0 && !/[\u0000-\u001f\u007f]/u.test(value);
}
