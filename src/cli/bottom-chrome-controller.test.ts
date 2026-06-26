import { describe, expect, it, vi } from "vitest";
import type { TerminalCapabilities } from "../contracts/ui.js";
import type { ViewModel } from "../contracts/view-model.js";
import type { PapyrusSurfaceFrame } from "../ui/papyrus/papyrus-surface-controller.js";
import { buildActiveTurnSpinnerViewModel, buildSessionStatusRailViewModel } from "../ui/view-models/builders.js";
import { BottomChromeController } from "./bottom-chrome-controller.js";

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

function expectManagedRegionSafeOutput(output: string): void {
  expect(output).not.toContain("\x1b[3J");
  expect(output).not.toContain("\x1b[2J");
  expect(output).not.toContain("\x1b[H");
  expect(output).not.toMatch(/\x1b\[\d+;\d+H/u);
}

function fakePapyrusFactory(options: {
  renderRows?: (frame: PapyrusSurfaceFrame) => readonly string[];
} = {}) {
  const calls: {
    created: Array<{ rendererMode: "papyrus"; size: { width: number; height: number } }>;
    initialized: Array<{ width: number; height: number }>;
    rendered: PapyrusSurfaceFrame[];
    resetCount: number;
  } = {
    created: [],
    initialized: [],
    rendered: [],
    resetCount: 0,
  };
  let size = { width: 0, height: 0 };
  return {
    calls,
    factory: (rendererMode: "papyrus", requestedSize: { width: number; height: number }) => {
      calls.created.push({ rendererMode, size: requestedSize });
      size = requestedSize;
      return {
        initialize: (width: number, height: number) => {
          calls.initialized.push({ width, height });
          size = { width, height };
          return { frame: undefined as never, diff: [], output: "" };
        },
        getSize: () => size,
        render: (frame: PapyrusSurfaceFrame) => {
          calls.rendered.push(frame);
          return {
            frame: undefined as never,
            diff: [{ type: "stdout" as const, content: "fake" }],
            output: `papyrus:${frame.surfaces.map((surface) => surface.text).join("|")}`,
          };
        },
        renderRows: (frame: PapyrusSurfaceFrame) => {
          calls.rendered.push(frame);
          return {
            frame: undefined as never,
            diff: [],
            output: "",
            rows: options.renderRows?.(frame) ?? frame.surfaces.map((surface) => surface.text),
          };
        },
        reset: () => {
          calls.resetCount += 1;
          return { frame: undefined as never, diff: [], output: "" };
        },
      };
    },
  };
}

describe("BottomChromeController", () => {
  it("renders status chrome through the Papyrus-managed surface by default", () => {
    const { chunks, stream } = mockOutput();
    const papyrus = fakePapyrusFactory({
      renderRows: (frame) => frame.surfaces.map((surface) => `papyrus:${surface.text}`),
    });
    const ctrl = new BottomChromeController({
      output: stream,
      capabilities: makeCaps(),
      renderViewModel,
      createPapyrusSurfaceControllerForMode: papyrus.factory,
    });

    ctrl.updateState({ statusRail: status("deepseek") });

    expect(papyrus.calls.created).toEqual([
      { rendererMode: "papyrus", size: { width: 40, height: 0 } },
    ]);
    expect(papyrus.calls.rendered[0]?.surfaces.map((surface) => surface.text)).toEqual([
      "deepseek | idle",
      "────────────────────────────────────────",
    ]);
    expect(chunks).toEqual([`papyrus:deepseek | idle\npapyrus:${"─".repeat(40)}\n`]);
  });

  it("uses an optional themed horizontal rule renderer", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = new BottomChromeController({
      output: stream,
      capabilities: makeCaps(),
      renderViewModel,
      renderHorizontalRule: (width) => "=".repeat(width),
    });

    ctrl.updateState({ statusRail: status("deepseek") });

    expect(chunks).toEqual([`deepseek | idle\n${"=".repeat(40)}\n`]);
  });

  it("updates Papyrus bottom chrome in place without unsafe absolute positioning", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = makeController(stream);

    ctrl.updateState({ statusRail: status("before") });
    chunks.length = 0;
    ctrl.updateStateInPlace({ statusRail: status("after") });

    expect(chunks).toEqual([
      `\x1b7\x1b[2A\x1b[2K\rafter | idle\x1b[1B\x1b[2K\r${"─".repeat(40)}\x1b8`,
    ]);
    expectManagedRegionSafeOutput(chunks.join(""));
  });

  it("keeps Papyrus status and spinner updates managed-region safe", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = makeController(stream);

    ctrl.updateState({
      statusRail: status("status"),
      activeSpinner: buildActiveTurnSpinnerViewModel({ phase: "thinking" }),
    });
    chunks.length = 0;

    ctrl.updateStateInPlace({
      statusRail: status("status"),
      activeSpinner: buildActiveTurnSpinnerViewModel({ phase: "tool" }),
    });

    const rendered = chunks.join("");
    expect(rendered).toBe(
      `\x1b7\x1b[3A\x1b[2K\rstatus | idle\x1b[1B\x1b[2K\rspinner:tool\x1b[1B\x1b[2K\r${"─".repeat(40)}\x1b8`,
    );
    expect(rendered).toContain("spinner:tool");
    expect(rendered).not.toContain("spinner:thinking");
    expectManagedRegionSafeOutput(rendered);
  });

  it("updates transient active-turn lines above chrome", () => {
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
    ctrl.updateTransientLines(["spinner:tool"]);
    expect(chunks).toEqual(["\x1b7\x1b[3A\x1b[2K\rspinner:tool\x1b8"]);
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

  it("writes above chrome without restoring transient lines", () => {
    const { chunks, stream } = mockOutput();
    const ctrl = makeController(stream);
    ctrl.updateState({ statusRail: status("status") });
    ctrl.updateTransientLines(["tool one", "tool two"]);

    chunks.length = 0;
    ctrl.writeAboveChromeNoRestore(() => {
      stream.write("durable tool rows\n");
    });

    expect(chunks).toEqual(["\x1b[4A\x1b[1G\x1b[0J", "durable tool rows\n"]);

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

  it("redraws state from the ticker factory", () => {
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

  it("disposes active chrome and stops its ticker", () => {
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
