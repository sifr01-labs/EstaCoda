import {
  DBP,
  DISABLE_MOUSE_TRACKING,
  EBP,
  ENABLE_MOUSE_TRACKING,
  HIDE_CURSOR,
  SHOW_CURSOR,
} from "../papyrus/termio/dec.js";

export type TerminalLifecycleStdin = {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => unknown;
};

export type TerminalLifecycleStdout = {
  isTTY?: boolean;
  write?: (chunk: string) => unknown;
};

export type TerminalLifecycleOptions = {
  stdin?: TerminalLifecycleStdin;
  stdout?: TerminalLifecycleStdout;
  enableBracketedPaste?: boolean;
  enableMouseTracking?: boolean;
  hideCursor?: boolean;
};

export type TerminalLifecycleStopResult = {
  errors: unknown[];
};

export class TerminalLifecycleError extends Error {
  readonly cause: unknown;
  readonly cleanupErrors: unknown[];

  constructor(cause: unknown, cleanupErrors: unknown[]) {
    super("Failed to start terminal lifecycle.");
    this.name = "TerminalLifecycleError";
    this.cause = cause;
    this.cleanupErrors = cleanupErrors;
  }
}

type Cleanup = () => void;

export type TerminalLifecycle = {
  start(): void;
  stop(): TerminalLifecycleStopResult;
  isStarted(): boolean;
};

export function createTerminalLifecycle(options: TerminalLifecycleOptions = {}): TerminalLifecycle {
  return new InjectedTerminalLifecycle(options);
}

class InjectedTerminalLifecycle implements TerminalLifecycle {
  readonly #stdin?: TerminalLifecycleStdin;
  readonly #stdout?: TerminalLifecycleStdout;
  readonly #enableBracketedPaste: boolean;
  readonly #hideCursor: boolean;
  readonly #enableMouseTracking: boolean;
  readonly #cleanup: Cleanup[] = [];
  #started = false;

  constructor(options: TerminalLifecycleOptions) {
    this.#stdin = options.stdin;
    this.#stdout = options.stdout;
    this.#enableBracketedPaste = options.enableBracketedPaste ?? true;
    this.#hideCursor = options.hideCursor ?? true;
    this.#enableMouseTracking = options.enableMouseTracking ?? false;
  }

  start(): void {
    if (this.#started) return;

    try {
      this.#enableRawMode();
      this.#writeWithCleanup(HIDE_CURSOR, SHOW_CURSOR, this.#hideCursor);
      this.#writeWithCleanup(EBP, DBP, this.#enableBracketedPaste);
      this.#writeWithCleanup(ENABLE_MOUSE_TRACKING, DISABLE_MOUSE_TRACKING, this.#enableMouseTracking);
      this.#started = true;
    } catch (error) {
      const cleanup = this.#runCleanup();
      this.#started = false;
      throw new TerminalLifecycleError(error, cleanup.errors);
    }
  }

  stop(): TerminalLifecycleStopResult {
    if (!this.#started && this.#cleanup.length === 0) return { errors: [] };
    const result = this.#runCleanup();
    this.#started = false;
    return result;
  }

  isStarted(): boolean {
    return this.#started;
  }

  #enableRawMode(): void {
    if (this.#stdin?.isTTY !== true || typeof this.#stdin.setRawMode !== "function") return;
    const previousRaw = this.#stdin.isRaw === true;
    if (!previousRaw) {
      this.#stdin.setRawMode(true);
      this.#cleanup.push(() => {
        this.#stdin?.setRawMode?.(previousRaw);
      });
    }
  }

  #writeWithCleanup(enable: string, disable: string, shouldEnable: boolean): void {
    if (!shouldEnable || this.#stdout?.isTTY !== true || typeof this.#stdout.write !== "function") return;
    this.#cleanup.push(() => {
      this.#stdout?.write?.(disable);
    });
    this.#stdout.write(enable);
  }

  #runCleanup(): TerminalLifecycleStopResult {
    const errors: unknown[] = [];

    while (this.#cleanup.length > 0) {
      const cleanup = this.#cleanup.pop()!;
      try {
        cleanup();
      } catch (error) {
        errors.push(error);
      }
    }

    return { errors };
  }
}
