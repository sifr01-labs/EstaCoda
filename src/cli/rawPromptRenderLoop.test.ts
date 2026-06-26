import { describe, expect, it, vi } from "vitest";
import { createLineEditorState } from "../ui/input/lineEditor.js";
import {
  buildRawPromptFrame,
  RawPromptOverlayHost,
  RawPromptRenderLoop,
  type RawPromptRenderOutput,
} from "./rawPromptRenderLoop.js";
import { createOperatorConsoleRuntimeHost } from "../ui/papyrus/operator-console/operatorConsoleRuntimeHost.js";
import type { StatusRailState } from "../ui/papyrus/operator-console/operatorConsoleState.js";
import { createPastedTextAttachment } from "../ui/papyrus/operator-console/index.js";

const forbiddenManagedRegionOutput = /\x1b\[3J|\x1b\[2J|\x1b\[H|\x1b\[\d+;\d+H/u;

describe("raw prompt render loop", () => {
  it("renders prompt line from editor state and positions the cursor deterministically", () => {
    const output = fakeOutput();
    const loop = new RawPromptRenderLoop(output);

    const rows = loop.render({
      prompt: "> ",
      state: createLineEditorState("abc", 1),
    });

    expect(rows).toBe(1);
    expect(output.text()).toContain("> abc");
    expect(output.text()).toContain("\x1b[3C");
    expect(output.text()).not.toMatch(forbiddenManagedRegionOutput);
  });

  it("can render through the Operator Console host when explicitly enabled", () => {
    const output = fakeOutput();
    const loop = new RawPromptRenderLoop(output);

    const rows = loop.render({
      prompt: "> ",
      state: createLineEditorState("review the Papyrus rollout plan"),
      operatorConsole: {
        enabled: true,
        terminal: { width: 72, height: 12, isTty: true },
        status: {
          model: { label: "kimi-k2.7-code", state: "working" },
          context: { usedTokens: 18400, totalTokens: 262000, percent: 7 },
          sessionTimer: { elapsedMs: 72_000 },
        },
      },
    });

    expect(rows).toBe(4);
    expect(output.text()).toContain("╭─ Prompt");
    expect(output.text()).toContain("│ › review the Papyrus rollout plan");
    expect(output.text()).toContain("kimi-k2.7-code ● │ ctx [▰▱▱▱▱▱▱▱▱▱] 18.4k/262k 7% │ session 01:12");
    expect(output.text()).not.toMatch(forbiddenManagedRegionOutput);
  });

  it("uses a persistent Operator Console runtime host for gated prompt/status rendering", () => {
    const output = fakeOutput();
    const host = createOperatorConsoleRuntimeHost();
    const factory = vi.fn(() => host);
    const setPrompt = vi.spyOn(host, "setPrompt");
    const setStatus = vi.spyOn(host, "setStatus");
    const setTerminal = vi.spyOn(host, "setTerminal");
    const render = vi.spyOn(host, "render");
    const loop = new RawPromptRenderLoop(output, {
      operatorConsoleHostFactory: factory,
    });

    loop.render({
      prompt: "> ",
      state: createLineEditorState("first", 2),
      operatorConsole: {
        enabled: true,
        terminal: { width: 72, height: 12, isTty: true },
        status: status({ usedTokens: 1000, elapsedMs: 1000 }),
      },
    });
    loop.render({
      prompt: "> ",
      state: createLineEditorState("second\nline", 8),
      operatorConsole: {
        enabled: true,
        terminal: { width: 60, height: 10, isTty: true },
        status: status({ usedTokens: 2000, elapsedMs: 2000 }),
      },
    });

    expect(factory).toHaveBeenCalledOnce();
    expect(setTerminal).toHaveBeenCalledTimes(2);
    expect(setStatus).toHaveBeenCalledTimes(2);
    expect(setPrompt).toHaveBeenNthCalledWith(1, expect.objectContaining({
      text: "first",
      cursorOffset: 2,
      multiline: false,
      mode: "prompt",
    }));
    expect(setPrompt).toHaveBeenNthCalledWith(2, expect.objectContaining({
      text: "second\nline",
      cursorOffset: 8,
      multiline: true,
      mode: "prompt",
    }));
    expect(render).toHaveBeenCalledTimes(2);
    expect(host.getState().terminal).toEqual({ width: 60, height: 10, isTty: true });
    expect(host.getState().status.context.usedTokens).toBe(2000);
    expect(host.getState().status.sessionTimer.elapsedMs).toBe(2000);
  });

  it("keeps status rail state limited when noisy live status input reaches the runtime host", () => {
    const output = fakeOutput();
    const host = createOperatorConsoleRuntimeHost();
    const loop = new RawPromptRenderLoop(output, {
      operatorConsoleHostFactory: () => host,
    });
    const noisyStatus = {
      ...status({ usedTokens: 18_400, elapsedMs: 72_000 }),
      tools: ["rg"],
      approvals: ["approval-1"],
      workspace: "trusted",
      trust: "trusted",
      setup: "ready",
      steer: "queued",
      channel: "cli",
      activeTurn: "thinking",
    } as unknown as StatusRailState;

    loop.render({
      prompt: "> ",
      state: createLineEditorState("review the plan"),
      operatorConsole: {
        enabled: true,
        terminal: { width: 72, height: 12, isTty: true },
        status: noisyStatus,
      },
    });

    expect(Object.keys(host.getState().status).sort()).toEqual(["context", "model", "sessionTimer"]);
    expect(output.text()).toContain("kimi-k2.7-code ● │ ctx");
    expect(output.text()).not.toMatch(/\b(tool|approval|workspace|trust|setup|steer|channel|active)\b/iu);
  });

  it("keeps non-Operator Console raw rendering unchanged by default", () => {
    const output = fakeOutput();
    const factory = vi.fn(() => createOperatorConsoleRuntimeHost());
    const loop = new RawPromptRenderLoop(output, {
      operatorConsoleHostFactory: factory,
    });

    const rows = loop.render({
      prompt: "> ",
      state: createLineEditorState("plain"),
    });

    expect(rows).toBe(1);
    expect(output.text()).toContain("> plain");
    expect(output.text()).not.toContain("╭─ Prompt");
    expect(output.text()).not.toContain("session 00:00");
    expect(factory).not.toHaveBeenCalled();
  });

  it("places raw overlay rows between Operator Console prompt and status rail", () => {
    const output = fakeOutput();
    const loop = new RawPromptRenderLoop(output);

    const rows = loop.render({
      prompt: "> ",
      state: createLineEditorState("/h"),
      overlayRows: [{ text: "> /help - Show help" }],
      operatorConsole: {
        enabled: true,
        terminal: { width: 72, height: 12, isTty: true },
      },
    });
    const text = output.text();

    expect(rows).toBe(5);
    expect(text.indexOf("╭─ Prompt")).toBeLessThan(text.indexOf("> /help - Show help"));
    expect(text.indexOf("> /help - Show help")).toBeLessThan(text.indexOf("session 00:00"));
    expect(text).not.toMatch(forbiddenManagedRegionOutput);
  });

  it("renders Operator Console attachments above the prompt and below no status pollution", () => {
    const output = fakeOutput();
    const host = createOperatorConsoleRuntimeHost();
    const loop = new RawPromptRenderLoop(output, {
      operatorConsoleHostFactory: () => host,
    });

    const rows = loop.render({
      prompt: "> ",
      state: createLineEditorState("summarize this"),
      operatorConsole: {
        enabled: true,
        terminal: { width: 96, height: 18, isTty: true },
        status: status({ usedTokens: 18000, elapsedMs: 72000 }),
        attachments: [
          createPastedTextAttachment({
            id: "paste-1",
            content: "MVP known issue with enough detail to store outside the prompt.",
            preview: "MVP known issue...",
          }),
        ],
      },
    });
    const text = output.text();

    expect(rows).toBeGreaterThan(4);
    expect(text.indexOf("Attachments")).toBeLessThan(text.indexOf("╭─ Prompt"));
    expect(text).toContain("MVP known issue...");
    expect(text).toContain("│ › summarize this");
    expect(text).toContain("kimi-k2.7-code ● │ ctx");
    expect(text).not.toMatch(/\b(attachment|pasted text)\b.*session/iu);
    expect(host.getState().attachments[0]?.content).toContain("store outside the prompt");
  });

  it("passes multiple Operator Console attachments through the persistent runtime host", () => {
    const output = fakeOutput();
    const host = createOperatorConsoleRuntimeHost();
    const loop = new RawPromptRenderLoop(output, {
      operatorConsoleHostFactory: () => host,
    });

    loop.render({
      prompt: "> ",
      state: createLineEditorState("summarize"),
      operatorConsole: {
        enabled: true,
        terminal: { width: 120, height: 18, isTty: true },
        status: status({ usedTokens: 18000, elapsedMs: 72000 }),
        attachments: [
          createPastedTextAttachment({
            id: "paste-1",
            content: "first pasted payload",
          }),
          createPastedTextAttachment({
            id: "paste-2",
            content: "second pasted payload",
          }),
        ],
      },
    });
    const text = output.text();

    expect(host.getState().attachments.map((attachment) => attachment.content)).toEqual([
      "first pasted payload",
      "second pasted payload",
    ]);
    expect(text.match(/╭─ pasted text/gu)).toHaveLength(2);
    expect(text.indexOf("╭─ pasted text")).toBeLessThan(text.indexOf("╭─ Prompt"));
    expect(text).toContain("20 chars");
    expect(text).toContain("21 chars");
    expect(text).not.toMatch(/\b(attachment|pasted text)\b.*session/iu);
  });

  it("redraws after edits without full-screen or scrollback clear sequences", () => {
    const output = fakeOutput();
    const loop = new RawPromptRenderLoop(output);

    loop.render({ prompt: "> ", state: createLineEditorState("a") });
    loop.render({ prompt: "> ", state: createLineEditorState("ab") });

    expect(output.text()).toContain("> a");
    expect(output.text()).toContain("> ab");
    expect(output.text()).not.toMatch(forbiddenManagedRegionOutput);
  });

  it("renders multiline pasted content as managed prompt rows", () => {
    const output = fakeOutput();
    const loop = new RawPromptRenderLoop(output);

    const rows = loop.render({
      prompt: "> ",
      state: createLineEditorState("line one\nline two"),
    });

    expect(rows).toBe(2);
    expect(output.text()).toContain("> line one");
    expect(output.text()).toContain("line two");
    expect(output.text()).toContain("\x1b[8C");
    expect(output.text()).not.toMatch(forbiddenManagedRegionOutput);
  });

  it("renders inline ghost text without moving the real cursor", () => {
    const output = fakeOutput();
    const loop = new RawPromptRenderLoop(output);

    const rows = loop.render({
      prompt: "> ",
      state: createLineEditorState("hel", 3),
      ghostText: { text: "lo" },
    });

    expect(rows).toBe(1);
    expect(output.text()).toContain("> hello");
    expect(output.text()).toContain("\x1b[5C");
    expect(output.text()).not.toMatch(forbiddenManagedRegionOutput);
  });

  it("renders inert overlay rows and clears them later", () => {
    const output = fakeOutput();
    const host = new RawPromptOverlayHost();
    const loop = new RawPromptRenderLoop(output);

    host.setRows([
      { id: "one", text: "first suggestion" },
      { id: "two", text: "second suggestion" },
    ]);
    expect(loop.render({
      prompt: "> ",
      state: createLineEditorState(""),
      overlayRows: host.getRows(),
    })).toBe(3);

    host.clear();
    expect(loop.render({
      prompt: "> ",
      state: createLineEditorState(""),
      overlayRows: host.getRows(),
    })).toBe(1);

    expect(output.text()).toContain("first suggestion");
    expect(output.text()).toContain("second suggestion");
    expect(output.text()).not.toMatch(forbiddenManagedRegionOutput);
  });

  it("recalculates overlay rows after prompt-region size changes while keeping focus visible", () => {
    const output = fakeOutput();
    const loop = new RawPromptRenderLoop(output);

    expect(loop.render({
      prompt: "> ",
      state: createLineEditorState("/"),
      overlayRows: [
        { id: "help", text: "> /help - Show help" },
        { id: "status", text: "  /status - Show status" },
        { id: "model", text: "  /model - Show model" },
      ],
    })).toBe(4);

    expect(loop.render({
      prompt: "> ",
      state: createLineEditorState("/s"),
      overlayRows: [
        { id: "status", text: "> /status - Show status" },
      ],
    })).toBe(2);

    expect(loop.render({
      prompt: "> ",
      state: createLineEditorState("/"),
      overlayRows: [
        { id: "help", text: "  /help - Show help" },
        { id: "status", text: "> /status - Show status" },
      ],
    })).toBe(3);

    expect(output.text()).toContain("> /status - Show status");
    expect(output.text()).not.toMatch(forbiddenManagedRegionOutput);
  });

  it("coexists with surrounding bottom-chrome writes without destructive terminal sequences", () => {
    const output = fakeOutput();
    const loop = new RawPromptRenderLoop(output);

    output.write("bottom chrome before\n");
    loop.render({
      prompt: "> ",
      state: createLineEditorState("/h"),
      overlayRows: [{ id: "help", text: "> /help - Show help" }],
    });
    output.write("\nbottom chrome after");

    expect(output.text()).toContain("bottom chrome before");
    expect(output.text()).toContain("> /help - Show help");
    expect(output.text()).toContain("bottom chrome after");
    expect(output.text()).toContain("\x1b[0K");
    expect(output.text()).not.toMatch(forbiddenManagedRegionOutput);
  });

  it("clears previously rendered prompt and overlay rows safely", () => {
    const output = fakeOutput();
    const loop = new RawPromptRenderLoop(output);

    loop.render({
      prompt: "> ",
      state: createLineEditorState("draft"),
      overlayRows: [{ text: "overlay" }],
    });
    loop.clear();

    expect(output.text()).toContain("\x1b[0K");
    expect(output.text()).not.toMatch(forbiddenManagedRegionOutput);
  });

  it("builds cursor metadata for prompt and continuation rows", () => {
    expect(buildRawPromptFrame({
      prompt: "> ",
      state: createLineEditorState("abc", 2),
    })).toMatchObject({
      rows: ["> abc"],
      cursorRow: 0,
      cursorColumn: 4,
    });

    expect(buildRawPromptFrame({
      prompt: "> ",
      state: createLineEditorState("one\ntwo", 5),
    })).toMatchObject({
      rows: ["> one", "two"],
      cursorRow: 1,
      cursorColumn: 1,
    });
  });
});

function fakeOutput(): RawPromptRenderOutput & { text(): string } {
  const writes: string[] = [];
  return {
    write: vi.fn((chunk: string) => {
      writes.push(chunk);
    }),
    text: () => writes.join(""),
  };
}

function status(input: { readonly usedTokens: number; readonly elapsedMs: number }): StatusRailState {
  return {
    model: { label: "kimi-k2.7-code", state: "working" },
    context: { usedTokens: input.usedTokens, totalTokens: 262_000, percent: 7 },
    sessionTimer: { elapsedMs: input.elapsedMs },
  };
}
