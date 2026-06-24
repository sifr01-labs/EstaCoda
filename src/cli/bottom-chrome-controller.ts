// Persistent bottom chrome for interactive CLI turns.
// Keeps active-turn status chrome redrawable while transcript output is written
// above it.

import type { TerminalCapabilities } from "../contracts/ui.js";
import type {
  ActiveTurnSpinnerViewModel,
  SessionStatusRailViewModel,
  ShortcutHintRailViewModel,
  SlashMenuViewModel,
  ViewModel,
} from "../contracts/view-model.js";
import type { PapyrusSurfaceFrame, PapyrusSurfaceRenderResult, PapyrusSurfaceRowsResult } from "../ui/papyrus/papyrus-surface-controller.js";
import { createPapyrusSurfaceControllerForMode } from "../ui/papyrus/papyrus-surface-controller.js";
import type { UiRendererMode } from "../ui/renderer-mode.js";
import { truncateVisible } from "../ui/renderers/layout.js";

export interface BottomChromeState {
  readonly statusRail?: SessionStatusRailViewModel;
  readonly shortcutRail?: ShortcutHintRailViewModel;
  readonly activeSpinner?: ActiveTurnSpinnerViewModel;
  readonly slashMenu?: SlashMenuViewModel;
  readonly slashMenuMinRows?: number;
}

export interface BottomChromeControllerOptions {
  readonly output: NodeJS.WritableStream;
  readonly capabilities: TerminalCapabilities;
  readonly renderViewModel: (vm: ViewModel) => string;
  readonly renderHorizontalRule?: (width: number) => string;
  readonly rendererMode?: UiRendererMode;
  readonly createPapyrusSurfaceControllerForMode?: PapyrusSurfaceControllerFactory;
  readonly enabled?: boolean;
  readonly tickMs?: number;
  readonly readlineTickMs?: number;
}

export interface UpdateManagedRegionAboveReadlineInput {
  readonly state: BottomChromeState;
  readonly transientLines: readonly string[];
  readonly promptLineCount?: number;
}

type WritableWrite = (chunk: unknown, ...args: unknown[]) => boolean;
type PapyrusSurfaceControllerLike = {
  initialize(width: number, height: number): PapyrusSurfaceRenderResult;
  getSize(): { width: number; height: number };
  render(frame: PapyrusSurfaceFrame): PapyrusSurfaceRenderResult;
  renderRows(frame: PapyrusSurfaceFrame): PapyrusSurfaceRowsResult;
  reset(): PapyrusSurfaceRenderResult;
};

type PapyrusSurfaceControllerFactory = (
  rendererMode: UiRendererMode,
  size: { width: number; height: number }
) => PapyrusSurfaceControllerLike | undefined;

export class BottomChromeController {
  readonly #output: NodeJS.WritableStream;
  readonly #capabilities: TerminalCapabilities;
  readonly #renderViewModel: (vm: ViewModel) => string;
  readonly #renderHorizontalRule?: (width: number) => string;
  readonly #enabled: boolean;
  readonly #tickMs: number;
  readonly #readlineTickMs: number;
  readonly #papyrusSurfaceController?: PapyrusSurfaceControllerLike;
  #activeLineCount = 0;
  #renderedTransientLineCount = 0;
  #transientLines: readonly string[] = [];
  #lastRenderedTransientLines?: readonly string[];
  #lastRenderedLines?: readonly string[];
  #currentState: BottomChromeState = {};
  #ticker?: ReturnType<typeof setInterval>;
  #stateFactory?: () => BottomChromeState;
  #readlinePromptLineCountFactory?: () => number;
  #isDrawing = false;
  #writingAboveChrome = false;
  #disposed = false;

  constructor(options: BottomChromeControllerOptions) {
    this.#output = options.output;
    this.#capabilities = options.capabilities;
    this.#renderViewModel = options.renderViewModel;
    this.#renderHorizontalRule = options.renderHorizontalRule;
    this.#enabled = options.enabled ?? detectEnabled(options.capabilities);
    this.#tickMs = options.tickMs ?? 200;
    this.#readlineTickMs = options.readlineTickMs ?? 1000;
    const rendererMode = options.rendererMode ?? "legacy";
    if (rendererMode === "papyrus") {
      this.#papyrusSurfaceController = (
        options.createPapyrusSurfaceControllerForMode ?? createPapyrusSurfaceControllerForMode
      )(rendererMode, { width: Math.max(1, options.capabilities.terminalWidth), height: 0 });
    }
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
    if (!this.#enabled || this.#disposed || this.#managedLineCount() === 0) return;
    const chromeLines = this.#activeLineCount;
    const transientLines = this.#renderedTransientLineCount;
    const promptRows = Math.max(1, Math.ceil(promptLineCount));
    const managedLines = transientLines + chromeLines;
    let sequence = `\x1b[${managedLines + promptRows}A`;
    for (let index = 0; index < managedLines; index += 1) {
      sequence += "\x1b[2K";
      if (index < managedLines - 1) {
        sequence += "\x1b[1B";
      }
    }
    sequence += `\x1b[${promptRows + 1}B`;
    this.#output.write(sequence);
    this.#activeLineCount = 0;
    this.#renderedTransientLineCount = 0;
    this.#lastRenderedTransientLines = undefined;
    this.#lastRenderedLines = undefined;
    this.#resetPapyrusChromeFrame();
  }

  writeAboveChromeSync<T>(fn: () => T): T {
    if (!this.#enabled || this.#disposed) {
      return fn();
    }
    if (this.#writingAboveChrome) {
      return fn();
    }
    this.#clearForOutput();
    this.#writingAboveChrome = true;
    const tracker = this.#trackOutputWrites();
    try {
      return fn();
    } finally {
      try {
        tracker.restore();
        if (tracker.wroteOutput() && !tracker.lastWriteEndedWithNewline()) {
          this.#output.write("\n");
        }
        this.#drawManagedRegion();
      } finally {
        this.#writingAboveChrome = false;
      }
    }
  }

  writeAboveChromeNoRestore<T>(fn: () => T): T {
    if (!this.#enabled || this.#disposed) {
      return fn();
    }

    this.#clearForOutput();

    // No-restore durable writes intentionally discard transient live UI.
    this.#transientLines = [];
    this.#renderedTransientLineCount = 0;
    this.#lastRenderedTransientLines = undefined;

    return fn();
  }

  async writeAboveChrome<T>(fn: () => T | Promise<T>): Promise<T> {
    if (!this.#enabled || this.#disposed) {
      return await fn();
    }
    if (this.#writingAboveChrome) {
      return await fn();
    }
    this.#clearForOutput();
    this.#writingAboveChrome = true;
    const tracker = this.#trackOutputWrites();
    try {
      return await fn();
    } finally {
      try {
        tracker.restore();
        if (tracker.wroteOutput() && !tracker.lastWriteEndedWithNewline()) {
          this.#output.write("\n");
        }
        this.#drawManagedRegion();
      } finally {
        this.#writingAboveChrome = false;
      }
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
        this.#drawManagedRegion();
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
    this.#transientLines = [];
    this.#renderedTransientLineCount = 0;
    this.#lastRenderedTransientLines = undefined;
    this.#lastRenderedLines = undefined;
    this.#resetPapyrusChromeFrame();
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

  setStateFactory(stateFactory: (() => BottomChromeState) | undefined): void {
    if (!this.#enabled || this.#disposed) return;
    this.#stateFactory = stateFactory;
  }

  startReadlineTicker(stateFactory: () => BottomChromeState, promptLineCountFactory: () => number = () => 1): void {
    if (!this.#enabled || this.#disposed) return;
    this.#stateFactory = stateFactory;
    this.#readlinePromptLineCountFactory = promptLineCountFactory;
    this.stopTicker();
    this.#ticker = setInterval(() => {
      if (this.#stateFactory === undefined) return;
      this.updateManagedRegionAboveReadline({
        state: this.#stateFactory(),
        transientLines: this.#transientLines,
        promptLineCount: this.#readlinePromptLineCountFactory?.() ?? 1,
      });
    }, this.#readlineTickMs);
  }

  updateManagedRegionAboveReadline(input: UpdateManagedRegionAboveReadlineInput): void {
    if (!this.#enabled || this.#disposed) return;
    const nextTransientLines = this.#boundedTransientLines(input.transientLines);
    this.#currentState = input.state;
    this.#transientLines = nextTransientLines;
    const nextChromeLines = this.#buildChromeLines();
    const nextManagedLines = [...nextTransientLines, ...nextChromeLines];
    const previousManagedLineCount = this.#managedLineCount();
    const nextManagedLineCount = nextManagedLines.length;

    if (
      linesEqual(nextTransientLines, this.#lastRenderedTransientLines) &&
      linesEqual(nextChromeLines, this.#lastRenderedLines)
    ) {
      return;
    }

    if (previousManagedLineCount === 0 && nextManagedLineCount === 0) {
      this.#activeLineCount = 0;
      this.#renderedTransientLineCount = 0;
      this.#lastRenderedTransientLines = nextTransientLines;
      this.#lastRenderedLines = nextChromeLines;
      return;
    }

    const promptRows = Math.max(1, Math.ceil(input.promptLineCount ?? 1));
    const lineDelta = nextManagedLineCount - previousManagedLineCount;
    let sequence = "\x1b7";
    const rowsAboveCursor = previousManagedLineCount > 0
      ? previousManagedLineCount + promptRows - 1
      : promptRows - 1;
    if (rowsAboveCursor > 0) {
      sequence += `\x1b[${rowsAboveCursor}A`;
    }
    if (lineDelta > 0) {
      sequence += `\x1b[${lineDelta}L`;
    } else if (lineDelta < 0) {
      sequence += `\x1b[${Math.abs(lineDelta)}M`;
    }

    const renderedManagedLines = this.#shouldUsePapyrusChrome()
      ? this.#renderChromeRowsWithPapyrus(nextManagedLines)
      : nextManagedLines;

    for (let index = 0; index < renderedManagedLines.length; index += 1) {
      sequence += `\x1b[2K\r${renderedManagedLines[index]}`;
      if (index < renderedManagedLines.length - 1) {
        sequence += "\x1b[1B";
      }
    }

    sequence += "\x1b8";
    if (lineDelta > 0) {
      sequence += `\x1b[${lineDelta}B`;
    } else if (lineDelta < 0) {
      sequence += `\x1b[${Math.abs(lineDelta)}A`;
    }
    this.#output.write(sequence);
    this.#renderedTransientLineCount = nextTransientLines.length;
    this.#activeLineCount = nextChromeLines.length;
    this.#lastRenderedTransientLines = nextTransientLines;
    this.#lastRenderedLines = nextChromeLines;
  }

  updateStateAboveReadline(state: BottomChromeState, promptLineCount = 1): void {
    this.updateManagedRegionAboveReadline({
      state,
      transientLines: this.#transientLines,
      promptLineCount,
    });
  }

  updateStateInPlace(state: BottomChromeState): void {
    if (!this.#enabled || this.#disposed) return;
    this.#currentState = state;
    const lines = this.#buildChromeLines();
    if (lines.length === 0) {
      if (this.#activeLineCount > 0) {
        this.#redraw();
      }
      return;
    }
    if (this.#activeLineCount === 0 || this.#activeLineCount !== lines.length) {
      this.#redraw();
      return;
    }
    if (linesEqual(lines, this.#lastRenderedLines)) {
      return;
    }
    if (this.#shouldUsePapyrusChrome()) {
      const managedLines = this.#renderChromeRowsWithPapyrus(lines);
      if (managedLines.length > 0) {
        this.#output.write(this.#relativeManagedRegionUpdate(managedLines));
      }
      this.#lastRenderedLines = lines;
      return;
    }

    let sequence = "\x1b7";
    sequence += `\x1b[${this.#activeLineCount}A`;
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index] !== this.#lastRenderedLines?.[index]) {
        sequence += `\x1b[2K\r${lines[index]}`;
      }
      if (index < lines.length - 1) {
        sequence += "\x1b[1B";
      }
    }
    sequence += "\x1b8";
    this.#output.write(sequence);
    this.#lastRenderedLines = lines;
  }

  updateTransientLines(lines: readonly string[]): void {
    if (!this.#enabled || this.#disposed) return;
    const nextLines = this.#boundedTransientLines(lines);
    this.#transientLines = nextLines;
    if (linesEqual(nextLines, this.#lastRenderedTransientLines)) {
      return;
    }
    if (this.#renderedTransientLineCount === 0 || this.#renderedTransientLineCount !== nextLines.length) {
      this.#redraw();
      return;
    }

    let sequence = "\x1b7";
    sequence += `\x1b[${this.#activeLineCount + this.#renderedTransientLineCount}A`;
    for (let index = 0; index < nextLines.length; index += 1) {
      if (nextLines[index] !== this.#lastRenderedTransientLines?.[index]) {
        sequence += `\x1b[2K\r${nextLines[index]}`;
      }
      if (index < nextLines.length - 1) {
        sequence += "\x1b[1B";
      }
    }
    sequence += "\x1b8";
    this.#output.write(sequence);
    this.#lastRenderedTransientLines = nextLines;
  }

  clearTransientLines(): void {
    if (!this.#enabled || this.#disposed) return;
    if (this.#transientLines.length === 0 && this.#renderedTransientLineCount === 0) return;
    this.#transientLines = [];
    if (this.#renderedTransientLineCount === 0) {
      this.#lastRenderedTransientLines = undefined;
      return;
    }
    this.#redraw();
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
    this.#transientLines = [];
    this.#renderedTransientLineCount = 0;
    this.#lastRenderedTransientLines = undefined;
    this.#lastRenderedLines = undefined;
    this.#resetPapyrusChromeFrame();
  }

  #redraw(): void {
    if (this.#isDrawing) return;
    this.#clearForOutput();
    this.#drawManagedRegion();
  }

  #clearForOutput(): void {
    const lineCount = this.#managedLineCount();
    if (lineCount === 0) return;
    this.#output.write(`\x1b[${lineCount}A\x1b[1G\x1b[0J`);
    this.#activeLineCount = 0;
    this.#renderedTransientLineCount = 0;
    this.#lastRenderedTransientLines = undefined;
    this.#lastRenderedLines = undefined;
    this.#resetPapyrusChromeFrame();
  }

  #drawManagedRegion(): void {
    if (this.#isDrawing) return;
    this.#isDrawing = true;
    try {
      const chromeLines = this.#buildChromeLines();
      const lines = [...this.#transientLines, ...chromeLines];
      if (lines.length === 0) return;
      const papyrusRows = this.#shouldUsePapyrusChrome()
        ? this.#renderChromeRowsWithPapyrus(lines)
        : undefined;
      this.#output.write(papyrusRows === undefined ? `${lines.join("\n")}\n` : `${papyrusRows.join("\n")}\n`);
      this.#renderedTransientLineCount = this.#transientLines.length;
      this.#activeLineCount = chromeLines.length;
      this.#lastRenderedTransientLines = this.#transientLines;
      this.#lastRenderedLines = chromeLines;
    } finally {
      this.#isDrawing = false;
    }
  }

  #managedLineCount(): number {
    return this.#renderedTransientLineCount + this.#activeLineCount;
  }

  #trackOutputWrites(): {
    restore(): void;
    wroteOutput(): boolean;
    lastWriteEndedWithNewline(): boolean;
  } {
    const writable = this.#output as NodeJS.WritableStream & { write: WritableWrite };
    const originalWrite = writable.write;
    const callOriginalWrite = originalWrite.bind(writable);
    let wrote = false;
    let endedWithNewline = true;

    writable.write = ((chunk: unknown, ...args: unknown[]) => {
      if (typeof chunk === "string") {
        if (chunk.length > 0) {
          wrote = true;
          endedWithNewline = chunk.endsWith("\n");
        }
      } else if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) {
        if (chunk.length > 0) {
          wrote = true;
          endedWithNewline = chunk[chunk.length - 1] === 0x0A;
        }
      } else {
        const text = String(chunk);
        if (text.length > 0) {
          wrote = true;
          endedWithNewline = text.endsWith("\n");
        }
      }

      return callOriginalWrite(chunk, ...args);
    }) as WritableWrite;

    return {
      restore: () => {
        writable.write = originalWrite;
      },
      wroteOutput: () => wrote,
      lastWriteEndedWithNewline: () => endedWithNewline,
    };
  }

  #boundedTransientLines(lines: readonly string[]): string[] {
    const width = Math.max(1, this.#capabilities.terminalWidth);
    return lines
      .filter((line) => line.length > 0)
      .map((line) => truncateVisible(line.replace(/[\r\n]+/gu, " "), width));
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
      const slashLines = this.#boundedLines(this.#renderViewModel(this.#currentState.slashMenu), width);
      lines.push(...slashLines);
      const minRows = Math.max(0, Math.floor(this.#currentState.slashMenuMinRows ?? 0));
      for (let index = slashLines.length; index < minRows; index += 1) {
        lines.push("");
      }
    }

    if (
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
    if (this.#renderHorizontalRule !== undefined) {
      return truncateVisible(this.#renderHorizontalRule(width), width);
    }
    const fill = this.#capabilities.supportsUnicode ? "─" : "-";
    return fill.repeat(width);
  }

  #shouldUsePapyrusChrome(): boolean {
    return this.#papyrusSurfaceController !== undefined && this.#currentState.statusRail !== undefined;
  }

  #renderChromeRowsWithPapyrus(lines: readonly string[]): readonly string[] {
    if (this.#papyrusSurfaceController === undefined) return [];
    const width = Math.max(1, this.#capabilities.terminalWidth);
    const height = Math.max(1, lines.length);
    const size = this.#papyrusSurfaceController.getSize();
    if (size.width !== width || size.height !== height) {
      this.#papyrusSurfaceController.initialize(width, height);
    }
    return this.#papyrusSurfaceController.renderRows({
      surfaces: lines.map((text, y) => ({ x: 0, y, text })),
    }).rows;
  }

  #relativeManagedRegionUpdate(lines: readonly string[]): string {
    let sequence = "\x1b7";
    sequence += `\x1b[${this.#activeLineCount}A`;
    for (let index = 0; index < lines.length; index += 1) {
      sequence += `\x1b[2K\r${lines[index]}`;
      if (index < lines.length - 1) {
        sequence += "\x1b[1B";
      }
    }
    sequence += "\x1b8";
    return sequence;
  }

  #resetPapyrusChromeFrame(): void {
    this.#papyrusSurfaceController?.reset();
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
