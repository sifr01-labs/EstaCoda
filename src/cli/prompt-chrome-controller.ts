// v0.95 Prompt Chrome Controller — Pass 7A feasibility spike.
// Minimal bounded prompt chrome using ANSI cursor control.
// Disabled for non-TTY, CI, dumb, plain, or no-color terminals.

import type { TerminalCapabilities } from "../contracts/ui.js";

export interface PromptChromeState {
  readonly statusRail: string;
}

export interface PromptChromeControllerOptions {
  readonly output: NodeJS.WritableStream;
  readonly capabilities: TerminalCapabilities;
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
  readonly #enabled: boolean;
  #active: boolean;

  constructor(options: PromptChromeControllerOptions) {
    this.#output = options.output;
    this.#enabled = options.enabled ?? detectEnabled(options.capabilities);
    this.#active = false;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  /** Draw the status line on the line above the upcoming prompt. */
  renderChrome(state: PromptChromeState): void {
    if (!this.#enabled) return;
    this.clearChrome();
    this.#output.write(`${state.statusRail}\n`);
    this.#active = true;
  }

  /** Clear the previously drawn status line using cursor-control sequences. */
  clearChrome(): void {
    if (!this.#enabled || !this.#active) return;
    // Move up 2 lines (from below prompt to status line),
    // clear the entire status line,
    // then move back down 2 lines to the original position.
    this.#output.write("\x1b[2A\x1b[2K\x1b[2B");
    this.#active = false;
  }

  /** Clear chrome, run the given function, and leave chrome cleared. */
  async suspendChromeForTranscript<T>(fn: () => T | Promise<T>): Promise<T> {
    if (!this.#enabled || !this.#active) {
      return await fn();
    }
    this.clearChrome();
    return await fn();
  }

  /** Final cleanup — clear any active chrome. */
  dispose(): void {
    this.clearChrome();
  }
}

function detectEnabled(caps: TerminalCapabilities): boolean {
  return caps.isTTY && !caps.isCI && !caps.isDumb && caps.supportsColor;
}
