// v0.95 Prompt Chrome Controller — Pass 7B persistent rails.
// Bounded prompt chrome using ANSI cursor control.
// Disabled for non-TTY, CI, dumb, or plain terminals.

import type { TerminalCapabilities } from "../contracts/ui.js";
import type {
  ActiveTurnSpinnerViewModel,
  SessionStatusRailViewModel,
  SlashMenuViewModel,
  ShortcutHintRailViewModel,
  ViewModel,
} from "../contracts/view-model.js";
import { truncateVisible } from "../ui/renderers/layout.js";

export interface PromptChromeState {
  readonly statusRail?: SessionStatusRailViewModel;
  readonly shortcutRail?: ShortcutHintRailViewModel;
  readonly activeSpinner?: ActiveTurnSpinnerViewModel;
  readonly slashMenu?: SlashMenuViewModel;
}

export interface PromptChromeControllerOptions {
  readonly output: NodeJS.WritableStream;
  readonly capabilities: TerminalCapabilities;
  readonly renderViewModel: (vm: ViewModel) => string;
  readonly enabled?: boolean;
}

/**
 * Controller for drawing a bounded status row above the prompt line
 * and clearing it before transcript output so it never enters scrollback.
 *
 * This is a feasibility prototype (Pass 7A). It assumes the prompt
 * fits on one line; wrapped prompts may leave the status line uncleared.
 */
export class PromptChromeController {
  readonly #output: NodeJS.WritableStream;
  readonly #capabilities: TerminalCapabilities;
  readonly #renderViewModel: (vm: ViewModel) => string;
  readonly #enabled: boolean;
  readonly #supportsAnimation: boolean;
  readonly #tickMs: number;
  #active: boolean;
  #activeLineCount: number;
  #inlineTimer?: ReturnType<typeof setInterval>;
  #inlinePhase?: string;
  #inlineRender?: (phase: string) => string;
  #inlineActive = false;
  #inlineLineCount = 0;

  constructor(options: PromptChromeControllerOptions) {
    this.#output = options.output;
    this.#capabilities = options.capabilities;
    this.#renderViewModel = options.renderViewModel;
    this.#enabled = options.enabled ?? detectEnabled(options.capabilities);
    this.#supportsAnimation = options.capabilities.supportsAnimation;
    this.#tickMs = 200;
    this.#active = false;
    this.#activeLineCount = 0;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  /** Draw bounded chrome rails above the upcoming prompt. */
  renderChrome(state: PromptChromeState): void {
    if (!this.#enabled) return;
    const lines = this.#renderChromeLines(state);
    if (lines.length === 0) return;
    this.clearChrome();
    this.#output.write(`${lines.join("\n")}\n`);
    this.#active = true;
    this.#activeLineCount = lines.length;
  }

  /** Clear previously drawn rail lines using cursor-control sequences. */
  clearChrome(): void {
    if (!this.#enabled || !this.#active) return;
    // From the line below the submitted prompt, move up across the prompt line
    // plus all rail lines, clear only rail lines, then return to the original
    // cursor position. The prompt line belongs to readline until a future input
    // rewrite owns it fully.
    const railLines = Math.max(1, this.#activeLineCount);
    let sequence = `\x1b[${railLines + 1}A`;
    for (let index = 0; index < railLines; index += 1) {
      sequence += "\x1b[2K";
      if (index < railLines - 1) {
        sequence += "\x1b[1B";
      }
    }
    sequence += "\x1b[2B";
    this.#output.write(sequence);
    this.#active = false;
    this.#activeLineCount = 0;
  }

  /** Clear chrome, run the given function, and leave chrome cleared. */
  async suspendChromeForTranscript<T>(fn: () => T | Promise<T>): Promise<T> {
    if (!this.#enabled || !this.#active) {
      return await fn();
    }
    this.clearChrome();
    return await fn();
  }

  /** Invalidate the currently drawn chrome region. */
  invalidate(): void {
    this.clearChrome();
  }

  /** Final cleanup — clear any active chrome and inline spinner. */
  dispose(): void {
    this.clearChrome();
    this.clearInlineSpinner();
  }

  /** Render an inline spinner line for the active turn.
   *  In animated terminals, starts a timer that re-renders the line.
   *  In static terminals, writes the line once. */
  renderInlineSpinner(phase: string, render: (phase: string) => string): void {
    if (!this.#enabled) return;

    if (this.#inlineActive && this.#inlinePhase !== phase) {
      this.#clearInlineActiveLines();
    }

    this.#inlinePhase = phase;
    this.#inlineRender = render;

    if (this.#supportsAnimation) {
      if (this.#inlineTimer === undefined) {
        this.#inlineTimer = setInterval(() => this.#tickInlineSpinner(), this.#tickMs);
      }
      this.#tickInlineSpinner();
    } else {
      this.#writeInlineSpinner();
    }
  }

  /** Clear the inline spinner line and stop any animation timer. */
  clearInlineSpinner(): void {
    this.#stopInlineAnimation();
    if (this.#inlineActive) {
      this.#clearInlineActiveLines();
    }
    this.#inlinePhase = undefined;
    this.#inlineRender = undefined;
  }

  #stopInlineAnimation(): void {
    if (this.#inlineTimer !== undefined) {
      clearInterval(this.#inlineTimer);
      this.#inlineTimer = undefined;
    }
  }

  #tickInlineSpinner(): void {
    if (this.#inlinePhase === undefined || this.#inlineRender === undefined) return;
    if (this.#inlineActive) {
      this.#clearInlineActiveLines();
    }
    this.#writeInlineSpinner();
  }

  #writeInlineSpinner(): void {
    if (this.#inlinePhase === undefined || this.#inlineRender === undefined) return;
    const text = this.#inlineRender(this.#inlinePhase);
    const lines = this.#boundedLines(text, Math.max(1, this.#capabilities.terminalWidth));
    if (lines.length === 0) return;
    this.#output.write(`${lines.join("\n")}\n`);
    this.#inlineActive = true;
    this.#inlineLineCount = lines.length;
  }

  #clearInlineActiveLines(): void {
    const lineCount = Math.max(1, this.#inlineLineCount);
    let sequence = "";
    for (let index = 0; index < lineCount; index += 1) {
      sequence += "\x1b[1A\x1b[2K";
    }
    sequence += "\r";
    this.#output.write(sequence);
    this.#inlineActive = false;
    this.#inlineLineCount = 0;
  }

  #renderChromeLines(state: PromptChromeState): string[] {
    const width = Math.max(1, this.#capabilities.terminalWidth);
    const rendered: string[] = [];

    if (state.statusRail !== undefined) {
      rendered.push(...this.#boundedLines(this.#renderViewModel(state.statusRail), width));
    }

    if (state.shortcutRail !== undefined) {
      rendered.push(...this.#boundedLines(this.#renderViewModel(state.shortcutRail), width));
    }

    if (state.activeSpinner !== undefined) {
      rendered.push(...this.#boundedLines(this.#renderViewModel(state.activeSpinner), width));
    }

    if (state.slashMenu !== undefined) {
      rendered.push(...this.#boundedLines(this.#renderViewModel(state.slashMenu), width));
    }

    return rendered;
  }

  #boundedLines(value: string, width: number): string[] {
    return value
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => truncateVisible(line.replace(/[\r\n]+/gu, " "), width));
  }
}

function detectEnabled(caps: TerminalCapabilities): boolean {
  return caps.isTTY && !caps.isCI && !caps.isDumb;
}
