// Persistent bottom chrome for interactive CLI turns.
// Keeps active-turn status/prompt chrome redrawable while transcript output
// is written above it.

import type { TerminalCapabilities } from "../contracts/ui.js";
import type {
  ActiveTurnSpinnerViewModel,
  SessionStatusRailViewModel,
  ShortcutHintRailViewModel,
  SlashMenuViewModel,
  ViewModel,
} from "../contracts/view-model.js";
import { truncateVisible } from "../ui/renderers/layout.js";

export interface BottomChromeState {
  readonly statusRail?: SessionStatusRailViewModel;
  readonly shortcutRail?: ShortcutHintRailViewModel;
  readonly activeSpinner?: ActiveTurnSpinnerViewModel;
  readonly slashMenu?: SlashMenuViewModel;
  readonly prompt?: {
    readonly text: string;
    readonly readOnly: boolean;
  };
}

export interface BottomChromeControllerOptions {
  readonly output: NodeJS.WritableStream;
  readonly capabilities: TerminalCapabilities;
  readonly renderViewModel: (vm: ViewModel) => string;
  readonly enabled?: boolean;
  readonly tickMs?: number;
  readonly readlineTickMs?: number;
}

export class BottomChromeController {
  readonly #output: NodeJS.WritableStream;
  readonly #capabilities: TerminalCapabilities;
  readonly #renderViewModel: (vm: ViewModel) => string;
  readonly #enabled: boolean;
  readonly #tickMs: number;
  readonly #readlineTickMs: number;
  #activeLineCount = 0;
  #lastRenderedLines?: readonly string[];
  #currentState: BottomChromeState = {};
  #ticker?: ReturnType<typeof setInterval>;
  #stateFactory?: () => BottomChromeState;
  #readlinePromptLineCountFactory?: () => number;
  #isDrawing = false;
  #disposed = false;

  constructor(options: BottomChromeControllerOptions) {
    this.#output = options.output;
    this.#capabilities = options.capabilities;
    this.#renderViewModel = options.renderViewModel;
    this.#enabled = options.enabled ?? detectEnabled(options.capabilities);
    this.#tickMs = options.tickMs ?? 200;
    this.#readlineTickMs = options.readlineTickMs ?? 1000;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  updateState(state: BottomChromeState): void {
    if (!this.#enabled || this.#disposed) return;
    this.#currentState = state;
    this.#redraw();
  }

  clearForReadline(promptLineCount = 1): void {
    if (!this.#enabled || this.#disposed || this.#activeLineCount === 0) return;
    const chromeLines = Math.max(1, this.#activeLineCount);
    const promptRows = Math.max(1, Math.ceil(promptLineCount));
    let sequence = `\x1b[${chromeLines + promptRows}A`;
    for (let index = 0; index < chromeLines; index += 1) {
      sequence += "\x1b[2K";
      if (index < chromeLines - 1) {
        sequence += "\x1b[1B";
      }
    }
    sequence += `\x1b[${promptRows + 1}B`;
    this.#output.write(sequence);
    this.#activeLineCount = 0;
    this.#lastRenderedLines = undefined;
  }

  writeAboveChromeSync<T>(fn: () => T): T {
    if (!this.#enabled || this.#disposed) {
      return fn();
    }
    this.#clearForOutput();
    try {
      return fn();
    } finally {
      this.#draw();
    }
  }

  async writeAboveChrome<T>(fn: () => T | Promise<T>): Promise<T> {
    if (!this.#enabled || this.#disposed) {
      return await fn();
    }
    this.#clearForOutput();
    try {
      return await fn();
    } finally {
      this.#draw();
    }
  }

  async suspendChromeForTranscript<T>(fn: () => T | Promise<T>): Promise<T> {
    return await this.writeAboveChrome(fn);
  }

  async suspendForPrompt<T>(fn: () => T | Promise<T>): Promise<T> {
    if (!this.#enabled || this.#disposed) {
      return await fn();
    }

    const hadTicker = this.#ticker !== undefined;
    if (hadTicker) {
      clearInterval(this.#ticker);
      this.#ticker = undefined;
    }

    this.#clearForOutput();
    try {
      return await fn();
    } finally {
      if (!this.#disposed) {
        if (this.#stateFactory !== undefined) {
          this.#currentState = this.#stateFactory();
        }
        this.#draw();
        if (hadTicker && this.#stateFactory !== undefined) {
          this.#ticker = setInterval(() => {
            if (this.#stateFactory === undefined) return;
            this.updateState(this.#stateFactory());
          }, this.#tickMs);
        }
      }
    }
  }

  clearInlineSpinner(): void {
    // The active indicator is part of bottom chrome state in this controller.
  }

  // Active-turn cancellation should clear both the drawn region and the saved
  // render state so late runtime events cannot redraw stale active chrome.
  clearActiveChrome(): void {
    if (!this.#enabled || this.#disposed) return;
    this.stopTicker();
    this.#stateFactory = undefined;
    this.#clearForOutput();
    this.#currentState = {};
    this.#lastRenderedLines = undefined;
  }

  startTicker(stateFactory: () => BottomChromeState): void {
    if (!this.#enabled || this.#disposed) return;
    this.#stateFactory = stateFactory;
    this.stopTicker();
    this.#ticker = setInterval(() => {
      if (this.#stateFactory === undefined) return;
      this.updateState(this.#stateFactory());
    }, this.#tickMs);
  }

  startReadlineTicker(stateFactory: () => BottomChromeState, promptLineCountFactory: () => number = () => 1): void {
    if (!this.#enabled || this.#disposed) return;
    this.#stateFactory = stateFactory;
    this.#readlinePromptLineCountFactory = promptLineCountFactory;
    this.stopTicker();
    this.#ticker = setInterval(() => {
      if (this.#stateFactory === undefined) return;
      this.updateStateAboveReadline(this.#stateFactory(), this.#readlinePromptLineCountFactory?.() ?? 1);
    }, this.#readlineTickMs);
  }

  updateStateAboveReadline(state: BottomChromeState, promptLineCount = 1): void {
    if (!this.#enabled || this.#disposed) return;
    this.#currentState = state;
    const lines = this.#buildChromeLines();
    if (lines.length === 0) {
      return;
    }
    if (this.#activeLineCount === 0 || this.#activeLineCount !== lines.length) {
      this.#redraw();
      return;
    }
    if (linesEqual(lines, this.#lastRenderedLines)) {
      return;
    }

    const promptRows = Math.max(1, Math.ceil(promptLineCount));
    let sequence = "\x1b7";
    sequence += `\x1b[${this.#activeLineCount + promptRows - 1}A`;
    for (let index = 0; index < lines.length; index += 1) {
      sequence += `\x1b[2K\r${lines[index]}`;
      if (index < lines.length - 1) {
        sequence += "\x1b[1B";
      }
    }
    sequence += "\x1b8";
    this.#output.write(sequence);
    this.#lastRenderedLines = lines;
  }

  stopTicker(): void {
    if (this.#ticker !== undefined) {
      clearInterval(this.#ticker);
      this.#ticker = undefined;
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.stopTicker();
    this.#stateFactory = undefined;
    if (!this.#enabled) return;
    this.#clearForOutput();
    this.#currentState = {};
    this.#lastRenderedLines = undefined;
  }

  #redraw(): void {
    if (this.#isDrawing) return;
    this.#clearForOutput();
    this.#draw();
  }

  #clearForOutput(): void {
    if (this.#activeLineCount === 0) return;
    const lineCount = Math.max(1, this.#activeLineCount);
    this.#output.write(`\x1b[${lineCount}A\x1b[1G\x1b[0J`);
    this.#activeLineCount = 0;
    this.#lastRenderedLines = undefined;
  }

  #draw(): void {
    if (this.#isDrawing) return;
    this.#isDrawing = true;
    try {
      const lines = this.#buildChromeLines();
      if (lines.length === 0) return;
      this.#output.write(`${lines.join("\n")}\n`);
      this.#activeLineCount = lines.length;
      this.#lastRenderedLines = lines;
    } finally {
      this.#isDrawing = false;
    }
  }

  #buildChromeLines(): string[] {
    const width = Math.max(1, this.#capabilities.terminalWidth);
    const lines: string[] = [];

    if (this.#currentState.statusRail !== undefined) {
      lines.push(...this.#boundedLines(this.#renderViewModel(this.#currentState.statusRail), width));
    }
    if (this.#currentState.activeSpinner !== undefined) {
      lines.push(...this.#boundedLines(this.#renderViewModel(this.#currentState.activeSpinner), width));
    }
    if (this.#currentState.shortcutRail !== undefined) {
      lines.push(...this.#boundedLines(this.#renderViewModel(this.#currentState.shortcutRail), width));
    }
    if (this.#currentState.slashMenu !== undefined) {
      lines.push(...this.#boundedLines(this.#renderViewModel(this.#currentState.slashMenu), width));
    }

    if (this.#currentState.prompt !== undefined) {
      lines.push(this.#horizontalRule(width));
      lines.push(this.#promptLine(this.#currentState.prompt.text, width));
      lines.push(this.#horizontalRule(width));
    } else if (
      this.#currentState.statusRail !== undefined ||
      this.#currentState.shortcutRail !== undefined ||
      this.#currentState.slashMenu !== undefined
    ) {
      lines.push(this.#horizontalRule(width));
    }

    return lines;
  }

  #boundedLines(value: string, width: number): string[] {
    return value
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => truncateVisible(line.replace(/[\r\n]+/gu, " "), width));
  }

  #horizontalRule(width: number): string {
    const fill = this.#capabilities.supportsUnicode ? "─" : "-";
    return fill.repeat(width);
  }

  #promptLine(text: string, width: number): string {
    const prompt = this.#capabilities.supportsUnicode ? "▸" : ">";
    return truncateVisible(`${prompt} ${text}`, width);
  }
}

function detectEnabled(caps: TerminalCapabilities): boolean {
  return caps.isTTY && !caps.isCI && !caps.isDumb;
}

function linesEqual(a: readonly string[], b: readonly string[] | undefined): boolean {
  if (b === undefined || a.length !== b.length) {
    return false;
  }
  return a.every((line, index) => line === b[index]);
}
