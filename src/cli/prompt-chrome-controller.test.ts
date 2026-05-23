import { describe, it, expect } from "vitest";
import { PromptChromeController } from "./prompt-chrome-controller.js";
import { buildSessionStatusRailViewModel, buildShortcutHintRailViewModel, buildSlashMenuViewModel, slashMenuOption } from "../ui/view-models/builders.js";
import type { TerminalCapabilities } from "../contracts/ui.js";
import type { ViewModel } from "../contracts/view-model.js";

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

function rail(text = "● model | idle") {
  return buildSessionStatusRailViewModel({ modelLabel: text, turnState: "idle" });
}

function shortcut(text = "/help · /tools") {
  return buildShortcutHintRailViewModel({ hints: [{ key: "", description: text }] });
}

function renderViewModel(vm: ViewModel): string {
  if (vm.kind === "sessionStatusRail") return vm.modelLabel ?? "";
  if (vm.kind === "shortcutHintRail") return vm.hints?.[0]?.description ?? "";
  if (vm.kind === "slashMenu") return vm.options.map((option) => `${option.label} ${option.description ?? ""}`.trim()).join("\n");
  return `[unsupported view model: ${vm.kind}]`;
}

function makeController(stream: NodeJS.WritableStream, caps: TerminalCapabilities = makeCaps(), enabled?: boolean): PromptChromeController {
  return new PromptChromeController({ output: stream, capabilities: caps, renderViewModel, enabled });
}

describe("PromptChromeController — capability gating", () => {
  it("is enabled for full TTY capabilities", () => {
    const { stream } = mockOutput();
    const ctrl = makeController(stream);
    expect(ctrl.enabled).toBe(true);
  });

  it("is disabled for non-TTY", () => {
    const { stream } = mockOutput();
    const ctrl = makeController(stream, makeCaps({ isTTY: false }));
    expect(ctrl.enabled).toBe(false);
  });

  it("is disabled for CI", () => {
    const { stream } = mockOutput();
    const ctrl = makeController(stream, makeCaps({ isCI: true }));
    expect(ctrl.enabled).toBe(false);
  });

  it("is disabled for dumb terminal", () => {
    const { stream } = mockOutput();
    const ctrl = makeController(stream, makeCaps({ isDumb: true }));
    expect(ctrl.enabled).toBe(false);
  });

  it("stays enabled for no-color TTY fallback", () => {
    const { stream } = mockOutput();
    const ctrl = makeController(stream, makeCaps({ supportsColor: false }));
    expect(ctrl.enabled).toBe(true);
  });

  it("respects explicit enabled override", () => {
    const { stream } = mockOutput();
    const ctrl = makeController(stream, makeCaps(), false);
    expect(ctrl.enabled).toBe(false);
  });
});

describe("PromptChromeController — chrome lifecycle", () => {
  it("renders status line when enabled", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = makeController(stream);
    ctrl.renderChrome({ statusRail: rail("● model | idle") });
    expect(chunks).toEqual(["● model | idle\n"]);
  });

  it("emits nothing when disabled", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = makeController(stream, makeCaps({ isTTY: false }));
    ctrl.renderChrome({ statusRail: rail("● model | idle") });
    expect(chunks).toEqual([]);
  });

  it("clears previous chrome before re-rendering", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = makeController(stream);
    ctrl.renderChrome({ statusRail: rail("first") });
    ctrl.renderChrome({ statusRail: rail("second") });
    expect(chunks).toEqual(["first\n", "\x1b[2A\x1b[2K\x1b[2B", "second\n"]);
  });


  it("renders status and shortcut rails as bounded chrome", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = makeController(stream);
    ctrl.renderChrome({ statusRail: rail("status"), shortcutRail: shortcut("/help · Ctrl+C exit") });
    expect(chunks).toEqual(["status\n/help · Ctrl+C exit\n"]);
  });

  it("renders slash completion rows as bounded chrome", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = makeController(stream);
    ctrl.renderChrome({
      statusRail: rail("status"),
      slashMenu: buildSlashMenuViewModel({
        query: "/",
        options: [slashMenuOption("help", "/help", { description: "Show command help" })],
        selectedIndex: 0,
      }),
    });
    expect(chunks).toEqual(["status\n/help Show command help\n"]);
  });

  it("trims rail output to terminal width", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = makeController(stream, makeCaps({ terminalWidth: 12 }));
    ctrl.renderChrome({ statusRail: rail("deepseek-reasoner | idle") });
    expect(chunks.join("")).toBe("deepseek-...\n");
  });

  it("clearChrome emits escape sequence when active", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = makeController(stream);
    ctrl.renderChrome({ statusRail: rail("status") });
    chunks.length = 0;
    ctrl.clearChrome();
    expect(chunks).toEqual(["\x1b[2A\x1b[2K\x1b[2B"]);
  });

  it("clearChrome clears multiple rail lines without restoring them", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = makeController(stream);
    ctrl.renderChrome({ statusRail: rail("status"), shortcutRail: shortcut("shortcuts") });
    chunks.length = 0;
    ctrl.clearChrome();
    expect(chunks).toEqual(["\x1b[3A\x1b[2K\x1b[1B\x1b[2K\x1b[2B"]);
  });

  it("clearChrome is a no-op when not active", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = makeController(stream);
    ctrl.clearChrome();
    expect(chunks).toEqual([]);
  });

  it("dispose clears active chrome", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = makeController(stream);
    ctrl.renderChrome({ statusRail: rail("status") });
    chunks.length = 0;
    ctrl.dispose();
    expect(chunks).toEqual(["\x1b[2A\x1b[2K\x1b[2B"]);
  });

  it("invalidate clears active chrome", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = makeController(stream);
    ctrl.renderChrome({ statusRail: rail("status") });
    chunks.length = 0;
    ctrl.invalidate();
    expect(chunks).toEqual(["\x1b[2A\x1b[2K\x1b[2B"]);
  });

  it("suspendChromeForTranscript clears before fn and does not restore", async () => {
    const { chunks, stream } = mockOutput();
    const ctrl = makeController(stream);
    ctrl.renderChrome({ statusRail: rail("status") });
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
    const ctrl = makeController(stream);
    const result = await ctrl.suspendChromeForTranscript(() => 42);
    expect(result).toBe(42);
    expect(chunks).toEqual([]);
  });

  it("suspendChromeForTranscript is a no-op when disabled", async () => {
    const { chunks, stream } = mockOutput();
    const ctrl = makeController(stream, makeCaps({ isTTY: false }));
    const result = await ctrl.suspendChromeForTranscript(() => 42);
    expect(result).toBe(42);
    expect(chunks).toEqual([]);
  });
});

describe("PromptChromeController — scrollback safety", () => {
  it("clears rails before transcript output and does not redraw them into scrollback", async () => {
    const { chunks, stream } = mockOutput();
    const ctrl = makeController(stream);
    ctrl.renderChrome({ statusRail: rail("status"), shortcutRail: shortcut("shortcuts") });
    await ctrl.suspendChromeForTranscript(() => {
      stream.write("assistant transcript\n");
    });

    expect(chunks).toEqual([
      "status\nshortcuts\n",
      "\x1b[3A\x1b[2K\x1b[1B\x1b[2K\x1b[2B",
      "assistant transcript\n",
    ]);
    expect(chunks.slice(2).join("")).not.toContain("status");
    expect(chunks.slice(2).join("")).not.toContain("shortcuts");
  });

  it("never writes cursor-control sequences when disabled", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = makeController(stream, makeCaps({ isTTY: false }));
    ctrl.renderChrome({ statusRail: rail("x") });
    ctrl.clearChrome();
    ctrl.dispose();
    ctrl.suspendChromeForTranscript(() => {});
    expect(chunks).toEqual([]);
    expect(chunks.some((c) => c.includes("\x1b["))).toBe(false);
  });

  it("writes only deterministic output when enabled", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = makeController(stream);
    ctrl.renderChrome({ statusRail: rail("● deepseek-reasoner | idle") });
    ctrl.clearChrome();
    const joined = chunks.join("");
    // The only non-escape output is the status line.
    expect(joined).toContain("● deepseek-reasoner | idle");
    // Escape sequences are limited to the clear pattern.
    expect(joined).toContain("\x1b[2A\x1b[2K\x1b[2B");
  });
});

describe("PromptChromeController — inline spinner", () => {
  it("renders static inline spinner when animation is unsupported", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = makeController(stream, makeCaps({ supportsAnimation: false }));
    ctrl.renderInlineSpinner("thinking", (phase) => `* ${phase}`);
    expect(chunks).toEqual(["* thinking\n"]);
  });

  it("starts timer and writes animated inline spinner when supported", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = makeController(stream, makeCaps({ supportsAnimation: true }));
    ctrl.renderInlineSpinner("thinking", (phase) => `* ${phase}`);
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0]).toBe("* thinking\n");
  });

  it("clears previous line when phase changes", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = makeController(stream, makeCaps({ supportsAnimation: false }));
    ctrl.renderInlineSpinner("thinking", (phase) => `* ${phase}`);
    chunks.length = 0;
    ctrl.renderInlineSpinner("routing", (phase) => `* ${phase}`);
    expect(chunks[0]).toBe("\x1b[1A\x1b[2K\r");
    expect(chunks[1]).toBe("* routing\n");
  });

  it("clears all previous inline lines when the spinner render is multiline", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = makeController(stream, makeCaps({ supportsAnimation: false }));
    ctrl.renderInlineSpinner("thinking", (phase) => `status\n* ${phase}`);
    chunks.length = 0;
    ctrl.renderInlineSpinner("routing", (phase) => `status\n* ${phase}`);
    expect(chunks[0]).toBe("\x1b[1A\x1b[2K\x1b[1A\x1b[2K\r");
    expect(chunks[1]).toBe("status\n* routing\n");
  });

  it("clearInlineSpinner stops timer and clears line", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = makeController(stream, makeCaps({ supportsAnimation: true }));
    ctrl.renderInlineSpinner("thinking", (phase) => `* ${phase}`);
    chunks.length = 0;
    ctrl.clearInlineSpinner();
    expect(chunks).toContain("\x1b[1A\x1b[2K\r");
  });

  it("clearInlineSpinner is a no-op when no inline spinner is active", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = makeController(stream);
    ctrl.clearInlineSpinner();
    expect(chunks).toEqual([]);
  });

  it("dispose clears both chrome and inline spinner", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = makeController(stream);
    ctrl.renderInlineSpinner("thinking", (phase) => `* ${phase}`);
    chunks.length = 0;
    ctrl.dispose();
    expect(chunks).toContain("\x1b[1A\x1b[2K\r");
  });

  it("inline spinner is a no-op when disabled", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = makeController(stream, makeCaps({ isTTY: false }));
    ctrl.renderInlineSpinner("thinking", (phase) => `* ${phase}`);
    expect(chunks).toEqual([]);
  });
});
