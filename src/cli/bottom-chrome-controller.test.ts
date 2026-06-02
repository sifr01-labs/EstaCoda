import { describe, it, expect, vi } from "vitest";
import { BottomChromeController } from "./bottom-chrome-controller.js";
import { buildActiveTurnSpinnerViewModel, buildSessionStatusRailViewModel, buildSlashMenuViewModel, slashMenuOption } from "../ui/view-models/builders.js";
import type { TerminalCapabilities } from "../contracts/ui.js";
import type { ViewModel } from "../contracts/view-model.js";

function makeCaps(partial: Partial<TerminalCapabilities> = {}): TerminalCapabilities {
  return {
    isTTY: true,
    supportsColor: true,
    supportsTrueColor: true,
    supportsUnicode: true,
    supportsEmoji: true,
    terminalWidth: 40,
    isDumb: false,
    isCI: false,
    supportsAnimation: true,
    ...partial,
  };
}

function mockOutput(): { chunks: string[]; stream: NodeJS.WritableStream } {
  const chunks: string[] = [];
  const stream = {
    write: (chunk: string | Buffer) => {
      chunks.push(String(chunk));
      return true;
    },
    end: () => {},
  } as NodeJS.WritableStream;
  return { chunks, stream };
}

function renderViewModel(vm: ViewModel): string {
  if (vm.kind === "sessionStatusRail") return `${vm.modelLabel} | ${vm.turnState}`;
  if (vm.kind === "activeTurnSpinner") return `spinner:${vm.phase ?? "none"}`;
  if (vm.kind === "slashMenu") return vm.options.map((option) => `${option.label} ${option.description ?? ""}`.trim()).join("\n");
  return `[unsupported ${vm.kind}]`;
}

function makeController(
  stream: NodeJS.WritableStream,
  caps: TerminalCapabilities = makeCaps(),
  enabled?: boolean
): BottomChromeController {
  return new BottomChromeController({ output: stream, capabilities: caps, renderViewModel, enabled });
}

function status(text = "model") {
  return buildSessionStatusRailViewModel({ modelLabel: text, turnState: "idle" });
}

function slashMenu() {
  return buildSlashMenuViewModel({
    query: "/h",
    options: [slashMenuOption("help", "/help", { description: "Show command help" })],
    selectedIndex: 0,
  });
}

describe("BottomChromeController", () => {
  it("renders status chrome", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = makeController(stream);
    ctrl.updateState({ statusRail: status("deepseek") });
    expect(chunks).toEqual(["deepseek | idle\n────────────────────────────────────────\n"]);
  });

  it("bounds rendered chrome lines to terminal width", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = makeController(stream, makeCaps({ terminalWidth: 12 }));
    ctrl.updateState({ statusRail: status("deepseek-reasoner") });
    expect(chunks.join("").split("\n").filter(Boolean)).toEqual([
      "deepseek-...",
      "────────────",
    ]);
  });

  it("clears for readline with wrapped submitted prompt rows", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = makeController(stream);
    ctrl.updateState({ statusRail: status("status") });
    chunks.length = 0;
    ctrl.clearForReadline(3);
    expect(chunks).toEqual(["\x1b[5A\x1b[2K\x1b[1B\x1b[2K\x1b[4B"]);
  });

  it("writes above chrome by clearing and redrawing around output", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = makeController(stream);
    ctrl.updateState({ statusRail: status("status") });
    chunks.length = 0;
    ctrl.writeAboveChromeSync(() => {
      stream.write("tool output\n");
    });
    expect(chunks).toEqual([
      "\x1b[2A\x1b[1G\x1b[0J",
      "tool output\n",
      "status | idle\n────────────────────────────────────────\n",
    ]);
  });

  it("updates transient lines above chrome without redrawing chrome", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = makeController(stream);
    ctrl.updateState({ statusRail: status("status") });

    chunks.length = 0;
    ctrl.updateTransientLines(["spinner:thinking"]);
    expect(chunks).toEqual([
      "\x1b[2A\x1b[1G\x1b[0J",
      "spinner:thinking\nstatus | idle\n────────────────────────────────────────\n",
    ]);

    chunks.length = 0;
    ctrl.updateTransientLines(["spinner:thinking"]);
    expect(chunks).toEqual([]);

    ctrl.updateTransientLines(["spinner:tool"]);
    expect(chunks).toEqual([
      "\x1b7\x1b[3A\x1b[2K\rspinner:tool\x1b8",
    ]);
  });

  it("writes transcript output above transient lines and chrome", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = makeController(stream);
    ctrl.updateState({ statusRail: status("status") });
    ctrl.updateTransientLines(["spinner:thinking"]);

    chunks.length = 0;
    ctrl.writeAboveChromeSync(() => {
      stream.write("tool output\n");
    });

    expect(chunks).toEqual([
      "\x1b[3A\x1b[1G\x1b[0J",
      "tool output\n",
      "spinner:thinking\nstatus | idle\n────────────────────────────────────────\n",
    ]);
  });

  it("writes above chrome without restoring rail or transient lines", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = makeController(stream);
    ctrl.updateState({ statusRail: status("status") });
    ctrl.updateTransientLines(["tool one", "tool two"]);

    chunks.length = 0;
    ctrl.writeAboveChromeNoRestore(() => {
      stream.write("durable tool rows\n");
    });

    expect(chunks).toEqual([
      "\x1b[4A\x1b[1G\x1b[0J",
      "durable tool rows\n",
    ]);

    chunks.length = 0;
    ctrl.writeAboveChromeSync(() => {
      stream.write("assistant response\n");
    });

    expect(chunks).toEqual([
      "assistant response\n",
      "status | idle\n────────────────────────────────────────\n",
    ]);
    expect(chunks.join("")).not.toContain("tool one");
    expect(chunks.join("")).not.toContain("tool two");
  });

  it("runs no-restore callbacks directly when disabled", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = makeController(stream, makeCaps({ isTTY: false }));
    let called = false;

    ctrl.updateState({ statusRail: status("status") });
    ctrl.writeAboveChromeNoRestore(() => {
      called = true;
      stream.write("plain durable\n");
    });

    expect(called).toBe(true);
    expect(chunks).toEqual(["plain durable\n"]);
  });

  it("runs no-restore callbacks directly after disposal", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = makeController(stream);
    ctrl.updateState({ statusRail: status("status") });
    chunks.length = 0;

    ctrl.dispose();
    ctrl.writeAboveChromeNoRestore(() => {
      stream.write("after dispose\n");
    });

    expect(chunks).toEqual([
      "\x1b[2A\x1b[1G\x1b[0J",
      "after dispose\n",
    ]);
  });

  it("can clear transient lines while transcript output is being written", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = makeController(stream);
    ctrl.updateState({ statusRail: status("status") });
    ctrl.updateTransientLines(["spinner:thinking"]);

    chunks.length = 0;
    ctrl.writeAboveChromeSync(() => {
      ctrl.clearTransientLines();
      stream.write("tool output\n");
    });

    expect(chunks).toEqual([
      "\x1b[3A\x1b[1G\x1b[0J",
      "tool output\n",
      "status | idle\n────────────────────────────────────────\n",
    ]);
  });

  it("clears transient lines while preserving chrome", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = makeController(stream);
    ctrl.updateState({ statusRail: status("status") });
    ctrl.updateTransientLines(["spinner:thinking"]);

    chunks.length = 0;
    ctrl.clearTransientLines();

    expect(chunks).toEqual([
      "\x1b[3A\x1b[1G\x1b[0J",
      "status | idle\n────────────────────────────────────────\n",
    ]);
  });

  it("patches chrome state in place below transient lines", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = makeController(stream);
    ctrl.updateState({ statusRail: status("status") });
    ctrl.updateTransientLines(["spinner:thinking"]);

    chunks.length = 0;
    ctrl.updateStateInPlace({ statusRail: status("next") });

    expect(chunks).toEqual([
      "\x1b7\x1b[2A\x1b[2K\rnext | idle\x1b[1B\x1b8",
    ]);
  });

  it("redraws state from the ticker factory", () => {
    vi.useFakeTimers();
    try {
      const { chunks, stream } = mockOutput();
      const ctrl = new BottomChromeController({
        output: stream,
        capabilities: makeCaps(),
        renderViewModel,
        tickMs: 100,
        readlineTickMs: 100,
      });
      let phase = "thinking";
      ctrl.updateState({ activeSpinner: buildActiveTurnSpinnerViewModel({ phase }) });
      chunks.length = 0;
      ctrl.startTicker(() => ({ activeSpinner: buildActiveTurnSpinnerViewModel({ phase }) }));
      phase = "tool";
      vi.advanceTimersByTime(100);
      expect(chunks).toEqual(["\x1b[1A\x1b[1G\x1b[0J", "spinner:tool\n"]);
      ctrl.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("redraws chrome above an active readline prompt without clearing the prompt row", () => {
    vi.useFakeTimers();
    try {
      const { chunks, stream } = mockOutput();
      const ctrl = new BottomChromeController({
        output: stream,
        capabilities: makeCaps(),
        renderViewModel,
        tickMs: 100,
        readlineTickMs: 100,
      });
      let label = "first";
      ctrl.updateState({ statusRail: status(label) });
      chunks.length = 0;
      ctrl.startReadlineTicker(() => ({ statusRail: status(label) }));
      label = "second";
      vi.advanceTimersByTime(100);
      expect(chunks).toEqual([
        `\x1b7\x1b[2A\x1b[2K\rsecond | idle\x1b[1B\x1b[2K\r${"─".repeat(40)}\x1b8`,
      ]);
      ctrl.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("redraws chrome above a wrapped active readline prompt", () => {
    vi.useFakeTimers();
    try {
      const { chunks, stream } = mockOutput();
      const ctrl = new BottomChromeController({
        output: stream,
        capabilities: makeCaps(),
        renderViewModel,
        tickMs: 100,
        readlineTickMs: 100,
      });
      let label = "first";
      let promptRows = 3;
      ctrl.updateState({ statusRail: status(label) });
      chunks.length = 0;
      ctrl.startReadlineTicker(() => ({ statusRail: status(label) }), () => promptRows);
      label = "second";
      vi.advanceTimersByTime(100);
      expect(chunks).toEqual([
        `\x1b7\x1b[4A\x1b[2K\rsecond | idle\x1b[1B\x1b[2K\r${"─".repeat(40)}\x1b8`,
      ]);
      ctrl.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("grows the managed readline region for transient lines and slash menu chrome", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = makeController(stream);
    ctrl.updateState({ statusRail: status("status") });

    chunks.length = 0;
    ctrl.updateManagedRegionAboveReadline({
      state: { statusRail: status("status"), slashMenu: slashMenu() },
      transientLines: ["paste preview"],
      promptLineCount: 1,
    });

    expect(chunks).toEqual([
      `\x1b7\x1b[2A\x1b[2L\x1b[2K\rpaste preview\x1b[1B\x1b[2K\rstatus | idle\x1b[1B\x1b[2K\r/help Show command help\x1b[1B\x1b[2K\r${"─".repeat(40)}\x1b8\x1b[2B`,
    ]);
  });

  it("keeps slash completion panel height stable with fewer results", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = makeController(stream);
    ctrl.updateState({ statusRail: status("status") });

    chunks.length = 0;
    ctrl.updateManagedRegionAboveReadline({
      state: { statusRail: status("status"), slashMenu: slashMenu(), slashMenuMinRows: 4 },
      transientLines: [],
      promptLineCount: 1,
    });

    const rendered = chunks.join("");
    expect(rendered).toContain("/help Show command help");
    expect(rendered).toContain(`\x1b[4L`);
    expect(rendered).toContain(`\r${"─".repeat(40)}`);
  });

  it("clears slash and transient readline chrome when the managed region shrinks", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = makeController(stream);
    ctrl.updateState({ statusRail: status("status") });
    ctrl.updateManagedRegionAboveReadline({
      state: { statusRail: status("status"), slashMenu: slashMenu() },
      transientLines: ["paste preview"],
      promptLineCount: 1,
    });

    chunks.length = 0;
    ctrl.updateManagedRegionAboveReadline({
      state: { statusRail: status("status") },
      transientLines: [],
      promptLineCount: 1,
    });

    expect(chunks).toEqual([
      `\x1b7\x1b[4A\x1b[2M\x1b[2K\rstatus | idle\x1b[1B\x1b[2K\r${"─".repeat(40)}\x1b8\x1b[2A`,
    ]);
  });

  it("clears the full managed readline region when no chrome remains", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = makeController(stream);
    ctrl.updateState({ statusRail: status("status") });

    chunks.length = 0;
    ctrl.updateManagedRegionAboveReadline({
      state: {},
      transientLines: [],
      promptLineCount: 1,
    });

    expect(chunks).toEqual(["\x1b7\x1b[2A\x1b[2M\x1b8\x1b[2A"]);
  });

  it("renders paste preview-style transient lines above an active readline prompt", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = makeController(stream);
    ctrl.updateState({ statusRail: status("status") });

    chunks.length = 0;
    ctrl.updateManagedRegionAboveReadline({
      state: { statusRail: status("status") },
      transientLines: ["line one", "line two"],
      promptLineCount: 1,
    });

    expect(chunks).toEqual([
      `\x1b7\x1b[2A\x1b[2L\x1b[2K\rline one\x1b[1B\x1b[2K\rline two\x1b[1B\x1b[2K\rstatus | idle\x1b[1B\x1b[2K\r${"─".repeat(40)}\x1b8\x1b[2B`,
    ]);
  });

  it("accounts for wrapped prompt rows when growing the managed readline region", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = makeController(stream);
    ctrl.updateState({ statusRail: status("status") });

    chunks.length = 0;
    ctrl.updateManagedRegionAboveReadline({
      state: { statusRail: status("next") },
      transientLines: ["paste preview"],
      promptLineCount: 3,
    });

    expect(chunks).toEqual([
      `\x1b7\x1b[4A\x1b[1L\x1b[2K\rpaste preview\x1b[1B\x1b[2K\rnext | idle\x1b[1B\x1b[2K\r${"─".repeat(40)}\x1b8\x1b[1B`,
    ]);
  });

  it("handles transient line-count changes above readline safely", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = makeController(stream);
    ctrl.updateState({ statusRail: status("status") });
    ctrl.updateManagedRegionAboveReadline({
      state: { statusRail: status("status") },
      transientLines: ["one"],
      promptLineCount: 1,
    });

    chunks.length = 0;
    ctrl.updateManagedRegionAboveReadline({
      state: { statusRail: status("status") },
      transientLines: ["one", "two"],
      promptLineCount: 1,
    });
    expect(chunks).toEqual([
      `\x1b7\x1b[3A\x1b[1L\x1b[2K\rone\x1b[1B\x1b[2K\rtwo\x1b[1B\x1b[2K\rstatus | idle\x1b[1B\x1b[2K\r${"─".repeat(40)}\x1b8\x1b[1B`,
    ]);

    chunks.length = 0;
    ctrl.updateManagedRegionAboveReadline({
      state: { statusRail: status("status") },
      transientLines: ["two"],
      promptLineCount: 1,
    });
    expect(chunks).toEqual([
      `\x1b7\x1b[4A\x1b[1M\x1b[2K\rtwo\x1b[1B\x1b[2K\rstatus | idle\x1b[1B\x1b[2K\r${"─".repeat(40)}\x1b8\x1b[1A`,
    ]);
  });

  it("skips managed readline updates when disabled", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = makeController(stream, makeCaps({ isTTY: false }));

    ctrl.updateManagedRegionAboveReadline({
      state: { statusRail: status("status") },
      transientLines: ["paste preview"],
      promptLineCount: 2,
    });

    expect(chunks).toEqual([]);
  });

  it("skips identical readline redraw frames", () => {
    vi.useFakeTimers();
    try {
      const { chunks, stream } = mockOutput();
      const ctrl = new BottomChromeController({
        output: stream,
        capabilities: makeCaps(),
        renderViewModel,
        tickMs: 100,
        readlineTickMs: 100,
      });
      ctrl.updateState({ statusRail: status("same") });
      chunks.length = 0;
      ctrl.startReadlineTicker(() => ({ statusRail: status("same") }));
      vi.advanceTimersByTime(300);
      expect(chunks).toEqual([]);

      ctrl.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a slower default readline ticker than active-turn animation", () => {
    vi.useFakeTimers();
    try {
      const { chunks, stream } = mockOutput();
      const ctrl = new BottomChromeController({
        output: stream,
        capabilities: makeCaps(),
        renderViewModel,
        tickMs: 100,
      });
      let label = "first";
      ctrl.updateState({ statusRail: status(label) });
      chunks.length = 0;
      ctrl.startReadlineTicker(() => ({ statusRail: status(label) }));
      label = "second";
      vi.advanceTimersByTime(999);
      expect(chunks).toEqual([]);
      vi.advanceTimersByTime(1);
      expect(chunks).toEqual([
        `\x1b7\x1b[2A\x1b[2K\rsecond | idle\x1b[1B\x1b[2K\r${"─".repeat(40)}\x1b8`,
      ]);

      ctrl.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("suspends chrome for nested prompts and redraws afterward", async () => {
    const { chunks, stream } = mockOutput();
    const ctrl = makeController(stream);
    ctrl.updateState({ statusRail: status("status") });
    chunks.length = 0;

    const answer = await ctrl.suspendForPrompt(async () => {
      stream.write("approval card\n");
      return "once";
    });

    expect(answer).toBe("once");
    expect(chunks).toEqual([
      "\x1b[2A\x1b[1G\x1b[0J",
      "approval card\n",
      "status | idle\n────────────────────────────────────────\n",
    ]);
  });

  it("pauses and resumes the ticker while a nested prompt is active", async () => {
    vi.useFakeTimers();
    try {
      const { chunks, stream } = mockOutput();
      const ctrl = new BottomChromeController({
        output: stream,
        capabilities: makeCaps(),
        renderViewModel,
        tickMs: 100,
      });
      let phase = "thinking";
      ctrl.updateState({ activeSpinner: buildActiveTurnSpinnerViewModel({ phase }) });
      ctrl.startTicker(() => ({ activeSpinner: buildActiveTurnSpinnerViewModel({ phase }) }));
      chunks.length = 0;

      const pending = ctrl.suspendForPrompt(async () => {
        phase = "tool";
        vi.advanceTimersByTime(100);
        stream.write("approval card\n");
        return "once";
      });

      await expect(pending).resolves.toBe("once");
      expect(chunks).toEqual([
        "\x1b[1A\x1b[1G\x1b[0J",
        "approval card\n",
        "spinner:tool\n",
      ]);

      phase = "done";
      chunks.length = 0;
      vi.advanceTimersByTime(100);
      expect(chunks).toEqual(["\x1b[1A\x1b[1G\x1b[0J", "spinner:done\n"]);
      ctrl.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not redraw suspended chrome after disposal", async () => {
    vi.useFakeTimers();
    try {
      const { chunks, stream } = mockOutput();
      const ctrl = new BottomChromeController({
        output: stream,
        capabilities: makeCaps(),
        renderViewModel,
        tickMs: 100,
      });
      let release!: () => void;
      const blocker = new Promise<void>((resolve) => {
        release = resolve;
      });

      ctrl.updateState({ statusRail: status("status") });
      ctrl.startTicker(() => ({ statusRail: status("next") }));
      chunks.length = 0;

      const pending = ctrl.suspendForPrompt(async () => {
        stream.write("approval card\n");
        await blocker;
        return "once";
      });
      expect(chunks).toEqual(["\x1b[2A\x1b[1G\x1b[0J", "approval card\n"]);

      chunks.length = 0;
      ctrl.dispose();
      release();
      await expect(pending).resolves.toBe("once");
      vi.advanceTimersByTime(100);
      expect(chunks).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears active chrome without disposing the controller", () => {
    vi.useFakeTimers();
    try {
      const { chunks, stream } = mockOutput();
      const ctrl = new BottomChromeController({
        output: stream,
        capabilities: makeCaps(),
        renderViewModel,
        tickMs: 100,
      });
      ctrl.updateState({ statusRail: status("status") });
      ctrl.startTicker(() => ({ statusRail: status("next") }));
      chunks.length = 0;

      ctrl.clearActiveChrome();
      vi.advanceTimersByTime(100);
      ctrl.writeAboveChromeSync(() => {
        stream.write("cancelled\n");
      });
      ctrl.updateState({ statusRail: status("after") });

      expect(chunks).toEqual([
        "\x1b[2A\x1b[1G\x1b[0J",
        "cancelled\n",
        "after | idle\n────────────────────────────────────────\n",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is disabled for non-TTY and still runs broker callbacks", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = makeController(stream, makeCaps({ isTTY: false }));
    let called = false;
    ctrl.updateState({ statusRail: status("status") });
    ctrl.writeAboveChromeSync(() => {
      called = true;
      stream.write("plain\n");
    });
    expect(called).toBe(true);
    expect(chunks).toEqual(["plain\n"]);
  });

  it("dispose clears active chrome and stops ticker", () => {
    vi.useFakeTimers();
    try {
      const { chunks, stream } = mockOutput();
      const ctrl = new BottomChromeController({
        output: stream,
        capabilities: makeCaps(),
        renderViewModel,
        tickMs: 100,
      });
      ctrl.updateState({ statusRail: status("status") });
      ctrl.startTicker(() => ({ statusRail: status("next") }));
      chunks.length = 0;
      ctrl.dispose();
      vi.advanceTimersByTime(100);
      expect(chunks).toEqual(["\x1b[2A\x1b[1G\x1b[0J"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
