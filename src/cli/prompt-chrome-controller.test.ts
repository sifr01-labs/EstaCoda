import { describe, it, expect } from "vitest";
import { PromptChromeController } from "./prompt-chrome-controller.js";
import type { TerminalCapabilities } from "../contracts/ui.js";

function makeCaps(partial: Partial<TerminalCapabilities> = {}): TerminalCapabilities {
  return {
    isTTY: true,
    supportsColor: true,
    supportsTrueColor: true,
    supportsUnicode: true,
    supportsEmoji: true,
    terminalWidth: 80,
    isDumb: false,
    isCI: false,
    supportsAnimation: true,
    ...partial,
  };
}

function mockOutput(): { chunks: string[]; stream: NodeJS.WritableStream } {
  const chunks: string[] = [];
  const stream = {
    write: (chunk: string | Buffer) => { chunks.push(String(chunk)); },
    end: () => {},
  } as NodeJS.WritableStream;
  return { chunks, stream };
}

describe("PromptChromeController — capability gating", () => {
  it("is enabled for full TTY capabilities", () => {
    const { stream } = mockOutput();
    const ctrl = new PromptChromeController({ output: stream, capabilities: makeCaps() });
    expect(ctrl.enabled).toBe(true);
  });

  it("is disabled for non-TTY", () => {
    const { stream } = mockOutput();
    const ctrl = new PromptChromeController({ output: stream, capabilities: makeCaps({ isTTY: false }) });
    expect(ctrl.enabled).toBe(false);
  });

  it("is disabled for CI", () => {
    const { stream } = mockOutput();
    const ctrl = new PromptChromeController({ output: stream, capabilities: makeCaps({ isCI: true }) });
    expect(ctrl.enabled).toBe(false);
  });

  it("is disabled for dumb terminal", () => {
    const { stream } = mockOutput();
    const ctrl = new PromptChromeController({ output: stream, capabilities: makeCaps({ isDumb: true }) });
    expect(ctrl.enabled).toBe(false);
  });

  it("is disabled for no-color", () => {
    const { stream } = mockOutput();
    const ctrl = new PromptChromeController({ output: stream, capabilities: makeCaps({ supportsColor: false }) });
    expect(ctrl.enabled).toBe(false);
  });

  it("respects explicit enabled override", () => {
    const { stream } = mockOutput();
    const ctrl = new PromptChromeController({ output: stream, capabilities: makeCaps(), enabled: false });
    expect(ctrl.enabled).toBe(false);
  });
});

describe("PromptChromeController — chrome lifecycle", () => {
  it("renders status line when enabled", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = new PromptChromeController({ output: stream, capabilities: makeCaps() });
    ctrl.renderChrome({ statusRail: "● model | idle" });
    expect(chunks).toEqual(["● model | idle\n"]);
  });

  it("emits nothing when disabled", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = new PromptChromeController({ output: stream, capabilities: makeCaps({ isTTY: false }) });
    ctrl.renderChrome({ statusRail: "● model | idle" });
    expect(chunks).toEqual([]);
  });

  it("clears previous chrome before re-rendering", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = new PromptChromeController({ output: stream, capabilities: makeCaps() });
    ctrl.renderChrome({ statusRail: "first" });
    ctrl.renderChrome({ statusRail: "second" });
    expect(chunks).toEqual(["first\n", "\x1b[2A\x1b[2K\x1b[2B", "second\n"]);
  });

  it("clearChrome emits escape sequence when active", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = new PromptChromeController({ output: stream, capabilities: makeCaps() });
    ctrl.renderChrome({ statusRail: "status" });
    chunks.length = 0;
    ctrl.clearChrome();
    expect(chunks).toEqual(["\x1b[2A\x1b[2K\x1b[2B"]);
  });

  it("clearChrome is a no-op when not active", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = new PromptChromeController({ output: stream, capabilities: makeCaps() });
    ctrl.clearChrome();
    expect(chunks).toEqual([]);
  });

  it("dispose clears active chrome", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = new PromptChromeController({ output: stream, capabilities: makeCaps() });
    ctrl.renderChrome({ statusRail: "status" });
    chunks.length = 0;
    ctrl.dispose();
    expect(chunks).toEqual(["\x1b[2A\x1b[2K\x1b[2B"]);
  });

  it("suspendChromeForTranscript clears before fn and does not restore", async () => {
    const { chunks, stream } = mockOutput();
    const ctrl = new PromptChromeController({ output: stream, capabilities: makeCaps() });
    ctrl.renderChrome({ statusRail: "status" });
    chunks.length = 0;

    let fnRan = false;
    const result = await ctrl.suspendChromeForTranscript(async () => {
      fnRan = true;
      return 42;
    });

    expect(fnRan).toBe(true);
    expect(result).toBe(42);
    expect(chunks).toEqual(["\x1b[2A\x1b[2K\x1b[2B"]);
  });

  it("suspendChromeForTranscript is a no-op when inactive", async () => {
    const { chunks, stream } = mockOutput();
    const ctrl = new PromptChromeController({ output: stream, capabilities: makeCaps() });
    const result = await ctrl.suspendChromeForTranscript(() => 42);
    expect(result).toBe(42);
    expect(chunks).toEqual([]);
  });

  it("suspendChromeForTranscript is a no-op when disabled", async () => {
    const { chunks, stream } = mockOutput();
    const ctrl = new PromptChromeController({ output: stream, capabilities: makeCaps({ isTTY: false }) });
    const result = await ctrl.suspendChromeForTranscript(() => 42);
    expect(result).toBe(42);
    expect(chunks).toEqual([]);
  });
});

describe("PromptChromeController — scrollback safety", () => {
  it("never writes cursor-control sequences when disabled", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = new PromptChromeController({ output: stream, capabilities: makeCaps({ isTTY: false }) });
    ctrl.renderChrome({ statusRail: "x" });
    ctrl.clearChrome();
    ctrl.dispose();
    ctrl.suspendChromeForTranscript(() => {});
    expect(chunks).toEqual([]);
    expect(chunks.some((c) => c.includes("\x1b["))).toBe(false);
  });

  it("writes only deterministic output when enabled", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = new PromptChromeController({ output: stream, capabilities: makeCaps() });
    ctrl.renderChrome({ statusRail: "● deepseek-reasoner | idle" });
    ctrl.clearChrome();
    const joined = chunks.join("");
    // The only non-escape output is the status line.
    expect(joined).toContain("● deepseek-reasoner | idle");
    // Escape sequences are limited to the clear pattern.
    expect(joined).toContain("\x1b[2A\x1b[2K\x1b[2B");
  });
});
