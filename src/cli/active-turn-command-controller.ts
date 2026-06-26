import { parseKeypress, type ParsedKeypress } from "../ui/input/parseKeypress.js";

export type ActiveTurnCommandControllerOptions = {
  readonly input: NodeJS.ReadStream;
  readonly enabled?: boolean;
  readonly onActiveInputPreviewChange?: (
    preview: { kind: "message" | "command"; text: string } | undefined
  ) => void;
  readonly onInputLineChange?: (line: string | undefined) => void;
  readonly onQueueText?: (text: string) => void;
  readonly onInterrupt: () => void;
  readonly onSteer?: (note: string) => void;
  readonly onStatusMessage?: (message: string) => void;
  readonly emitSigint?: () => void;
};

export class ActiveTurnCommandController {
  readonly #input: NodeJS.ReadStream;
  readonly #enabled: boolean;
  readonly #onActiveInputPreviewChange?: (
    preview: { kind: "message" | "command"; text: string } | undefined
  ) => void;
  readonly #onInputLineChange?: (line: string | undefined) => void;
  readonly #onQueueText?: (text: string) => void;
  readonly #onInterrupt: () => void;
  readonly #onSteer?: (note: string) => void;
  readonly #onStatusMessage?: (message: string) => void;
  readonly #emitSigint: () => void;
  readonly #onData = (chunk: string | Buffer | Uint8Array) => this.#handleData(chunk);
  #buffer: string | undefined;
  #attached = false;
  #disposed = false;
  #wasRaw = false;

  constructor(options: ActiveTurnCommandControllerOptions) {
    this.#input = options.input;
    this.#enabled = options.enabled ?? true;
    this.#onActiveInputPreviewChange = options.onActiveInputPreviewChange;
    this.#onInputLineChange = options.onInputLineChange;
    this.#onQueueText = options.onQueueText;
    this.#onInterrupt = options.onInterrupt;
    this.#onSteer = options.onSteer;
    this.#onStatusMessage = options.onStatusMessage;
    this.#emitSigint = options.emitSigint ?? (() => process.emit("SIGINT"));
  }

  start(): void {
    if (this.#disposed || this.#attached || !this.#enabled || this.#input.isTTY !== true) {
      return;
    }
    this.#wasRaw = this.#input.isRaw === true;
    this.#input.on("data", this.#onData);
    this.#input.setRawMode?.(true);
    this.#input.resume();
    this.#attached = true;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#clearBuffer();
    if (!this.#attached) return;
    this.#input.off("data", this.#onData);
    if (!this.#wasRaw) {
      this.#input.setRawMode?.(false);
    }
    this.#attached = false;
  }

  #handleData(chunk: string | Buffer | Uint8Array): void {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    for (const event of parseKeypress(text)) {
      this.#handleKeypress(event);
    }
  }

  #handleKeypress(event: ParsedKeypress): void {
    if (this.#disposed) return;
    if (event.type === "key" && event.ctrl === true && event.key === "c") {
      this.#emitSigint();
      return;
    }

    if (event.type === "key" && event.key === "escape") {
      this.#clearBuffer();
      return;
    }
    if (event.type === "key" && event.ctrl === true && event.key === "u") {
      this.#clearBuffer();
      return;
    }
    if (event.type === "key" && event.key === "backspace") {
      if (this.#buffer === undefined) {
        return;
      }
      this.#buffer = this.#buffer.slice(0, -1);
      if (this.#buffer.length === 0) {
        this.#clearBuffer();
      } else {
        this.#renderBuffer();
      }
      return;
    }
    if (event.type === "key" && event.key === "enter") {
      const command = this.#buffer ?? "";
      this.#clearBuffer();
      this.#submit(command);
      return;
    }
    if (event.type !== "text" && event.type !== "paste") {
      return;
    }

    this.#buffer = `${this.#buffer ?? ""}${event.text}`;
    this.#renderBuffer();
  }

  #submit(command: string): void {
    const trimmed = command.trim();
    const normalized = trimmed.replace(/\s+/gu, " ");
    if (trimmed.length === 0 || trimmed === "/") {
      return;
    }
    if (!trimmed.startsWith("/")) {
      if (this.#onQueueText === undefined) {
        return;
      }
      this.#onQueueText(trimmed);
      return;
    }
    if (normalized === "/interrupt") {
      this.#onInterrupt();
      return;
    }
    const steerMatch = /^\/steer(?:\s+([\s\S]*))?$/u.exec(trimmed);
    if (steerMatch !== null) {
      const note = steerMatch[1]?.trim() ?? "";
      if (note.length === 0) {
        this.#onStatusMessage?.("Usage: /steer <note>");
        return;
      }
      if (this.#onSteer === undefined) {
        this.#onStatusMessage?.("Unknown active command: /steer");
        return;
      }
      this.#onSteer(note);
      return;
    }
    this.#onStatusMessage?.(`Unknown active command: ${normalized}`);
  }

  #renderBuffer(): void {
    if (this.#buffer === undefined) return;
    const kind = this.#buffer.startsWith("/") ? "command" : "message";
    this.#onActiveInputPreviewChange?.({ kind, text: this.#buffer });
    this.#onInputLineChange?.(this.#buffer);
  }

  #clearBuffer(): void {
    if (this.#buffer === undefined) return;
    this.#buffer = undefined;
    this.#onActiveInputPreviewChange?.(undefined);
    this.#onInputLineChange?.(undefined);
  }
}
