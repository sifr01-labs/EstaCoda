import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { createLineEditorState } from "../ui/input/lineEditor.js";
import {
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
    expect(output.text()).toContain("› review the Papyrus rollout plan");
    expect(output.text()).toContain("kimi-k2.7-code ● │ ctx [▰▱▱▱▱▱▱▱▱▱] 18.4k/262k 7% │ ◷ 01:12");
    expect(output.text()).not.toMatch(forbiddenManagedRegionOutput);
  });

  it("redraws Operator Console frames from the previous prompt cursor row", () => {
    const output = fakeOutput();
    const loop = new RawPromptRenderLoop(output);

    expect(loop.render({
      prompt: "> ",
      state: createLineEditorState("h"),
      operatorConsole: {
        enabled: true,
        terminal: { width: 72, height: 12, isTty: true },
        status: status({ usedTokens: 0, elapsedMs: 0 }),
      },
    })).toBe(4);

    const secondRenderStart = output.chunks().length;
    expect(loop.render({
      prompt: "> ",
      state: createLineEditorState("he"),
      operatorConsole: {
        enabled: true,
        terminal: { width: 72, height: 12, isTty: true },
        status: status({ usedTokens: 0, elapsedMs: 0 }),
      },
    })).toBe(4);

    const secondRender = output.chunks().slice(secondRenderStart).join("");
    expect(secondRender.startsWith("\x1b[1A\r")).toBe(true);
    expect(secondRender.startsWith("\x1b[3A\r")).toBe(false);
  });

  it("redraws fallback overlay rows from the previous prompt cursor row", () => {
    const output = fakeOutput();
    const loop = new RawPromptRenderLoop(output);

    expect(loop.render({
      prompt: "> ",
      state: createLineEditorState("/"),
      fallbackRows: [
        { id: "help", text: "> /help - Show help" },
        { id: "status", text: "  /status - Show status" },
      ],
    })).toBe(3);

    const secondRenderStart = output.chunks().length;
    expect(loop.render({
      prompt: "> ",
      state: createLineEditorState("/s"),
      fallbackRows: [
        { id: "status", text: "> /status - Show status" },
      ],
    })).toBe(2);

    const secondRender = output.chunks().slice(secondRenderStart).join("");
    expect(secondRender.startsWith("\r")).toBe(true);
    expect(secondRender.startsWith("\x1b[2A\r")).toBe(false);
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

  it("renders active work and steer through the same Operator Console frame", () => {
    const output = fakeOutput();
    const host = createOperatorConsoleRuntimeHost();
    const setActiveWork = vi.spyOn(host, "setActiveWork");
    const setSteer = vi.spyOn(host, "setSteer");
    const loop = new RawPromptRenderLoop(output, {
      operatorConsoleHostFactory: () => host,
    });

    const rows = loop.render({
      prompt: "",
      state: createLineEditorState("focus approvals"),
      operatorConsole: {
        enabled: true,
        terminal: { width: 96, height: 16, isTty: true },
        status: status({ usedTokens: 18000, elapsedMs: 13000 }),
        activeWork: {
          expanded: false,
          scrollOffset: 0,
          items: [
            {
              id: "tool-1",
              toolName: "read_file",
              status: "running",
              summary: "src/cli/session-loop.ts",
              durationMs: 3000,
            },
          ],
        },
        steer: {
          mode: "drafting",
          draft: "focus approvals",
          cursorOffset: "focus approvals".length,
        },
        promptMode: "steer",
      },
    });
    const text = output.text();

    expect(rows).toBeGreaterThan(4);
    expect(setActiveWork).toHaveBeenCalledWith(expect.objectContaining({
      items: [expect.objectContaining({ toolName: "read_file" })],
    }));
    expect(setSteer).toHaveBeenCalledWith(expect.objectContaining({
      mode: "drafting",
      draft: "focus approvals",
    }));
    expect(text.indexOf("╭─ Active work")).toBeLessThan(text.indexOf("╭─ Steer current turn"));
    expect(text.indexOf("╭─ Steer current turn")).toBeLessThan(text.indexOf("◷ 00:13"));
    expect(text).toContain("› focus approvals");
    expect(text).not.toMatch(forbiddenManagedRegionOutput);
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
    expect(output.text()).not.toContain("◷ 00:00");
    expect(factory).not.toHaveBeenCalled();
  });

  it("does not insert legacy raw overlay rows into Operator Console frames", () => {
    const output = fakeOutput();
    const loop = new RawPromptRenderLoop(output);

    const rows = loop.render({
      prompt: "> ",
      state: createLineEditorState("/h"),
      fallbackRows: [{ text: "> /help - Show help" }],
      operatorConsole: {
        enabled: true,
        terminal: { width: 72, height: 12, isTty: true },
      },
    });
    const text = output.text();

    expect(rows).toBe(4);
    expect(text).toContain("› /h");
    expect(text).not.toContain("> /help - Show help");
    expect(text.indexOf("› /h")).toBeLessThan(text.indexOf("◷ 00:00"));
    expect(text).not.toMatch(forbiddenManagedRegionOutput);
  });

  it("passes Operator Console slash state through the persistent runtime host", () => {
    const output = fakeOutput();
    const host = createOperatorConsoleRuntimeHost();
    const setSlash = vi.spyOn(host, "setSlash");
    const loop = new RawPromptRenderLoop(output, {
      operatorConsoleHostFactory: () => host,
    });

    const rows = loop.render({
      prompt: "> ",
      state: createLineEditorState("/mo"),
      operatorConsole: {
        enabled: true,
        terminal: { width: 72, height: 12, isTty: true },
        status: status({ usedTokens: 18000, elapsedMs: 13000 }),
        slash: {
          query: "/mo",
          activeItemId: "slash.model",
          items: [
            { id: "slash.model", label: "/model", detail: "show or change active model route" },
            { id: "slash.model.setup", label: "/model setup", detail: "configure provider/model credentials" },
          ],
        },
      },
    });
    const text = output.text();

    expect(rows).toBeGreaterThan(4);
    expect(setSlash).toHaveBeenCalledWith(expect.objectContaining({ query: "/mo" }));
    expect(host.getState().slash?.activeItemId).toBe("slash.model");
    expect(text.indexOf("› /mo")).toBeLessThan(text.indexOf("╭─ Commands"));
    expect(text.indexOf("╭─ Commands")).toBeLessThan(text.indexOf("◷ 00:13"));
    expect(text).toContain("❯ /model  show or change active model route");
    expect(text).not.toMatch(/\b(command palette|slash|model setup)\b.*session/iu);
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
    expect(text.indexOf("Attachments")).toBeLessThan(text.indexOf("› summarize this"));
    expect(text).toContain("MVP known issue...");
    expect(text).toContain("› summarize this");
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
    expect(text.indexOf("╭─ pasted text")).toBeLessThan(text.indexOf("› summarize"));
    expect(text).toContain("20 chars");
    expect(text).toContain("21 chars");
    expect(text).not.toMatch(/\b(attachment|pasted text)\b.*session/iu);
  });

  it("passes Operator Console attachment focus through the persistent runtime host", () => {
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
        terminal: { width: 96, height: 18, isTty: true },
        status: status({ usedTokens: 18000, elapsedMs: 72000 }),
        attachments: [
          createPastedTextAttachment({
            id: "paste-1",
            content: "first pasted payload",
          }),
        ],
        focus: { target: { kind: "attachment", attachmentId: "paste-1" } },
      },
    });

    expect(host.getState().focus.target).toEqual({ kind: "attachment", attachmentId: "paste-1" });
    expect(output.text()).toContain("╭─ › pasted text");
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

  it("keeps fallback overlay rows only when Operator Console is disabled", () => {
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
      fallbackRows: host.getRows(),
    })).toBe(3);

    host.clear();
    expect(loop.render({
      prompt: "> ",
      state: createLineEditorState(""),
      fallbackRows: host.getRows(),
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
      fallbackRows: [
        { id: "help", text: "> /help - Show help" },
        { id: "status", text: "  /status - Show status" },
        { id: "model", text: "  /model - Show model" },
      ],
    })).toBe(4);

    expect(loop.render({
      prompt: "> ",
      state: createLineEditorState("/s"),
      fallbackRows: [
        { id: "status", text: "> /status - Show status" },
      ],
    })).toBe(2);

    expect(loop.render({
      prompt: "> ",
      state: createLineEditorState("/"),
      fallbackRows: [
        { id: "help", text: "  /help - Show help" },
        { id: "status", text: "> /status - Show status" },
      ],
    })).toBe(3);

    expect(output.text()).toContain("> /status - Show status");
    expect(output.text()).not.toMatch(forbiddenManagedRegionOutput);
  });

  it("coexists with surrounding console writes without destructive terminal sequences", () => {
    const output = fakeOutput();
    const loop = new RawPromptRenderLoop(output);

    output.write("console before\n");
    loop.render({
      prompt: "> ",
      state: createLineEditorState("/h"),
      fallbackRows: [{ id: "help", text: "> /help - Show help" }],
    });
    output.write("\nconsole after");

    expect(output.text()).toContain("console before");
    expect(output.text()).toContain("> /help - Show help");
    expect(output.text()).toContain("console after");
    expect(output.text()).toContain("\x1b[0K");
    expect(output.text()).not.toMatch(forbiddenManagedRegionOutput);
  });

  it("clears previously rendered prompt and overlay rows safely", () => {
    const output = fakeOutput();
    const loop = new RawPromptRenderLoop(output);

    loop.render({
      prompt: "> ",
      state: createLineEditorState("draft"),
      fallbackRows: [{ text: "overlay" }],
    });
    loop.clear();

    expect(output.text()).toContain("\x1b[0K");
    expect(output.text()).not.toMatch(forbiddenManagedRegionOutput);
  });

  it("does not export the retired raw prompt frame builder", async () => {
    const module = await import("./rawPromptRenderLoop.js");
    const source = await readFile(new URL("./rawPromptRenderLoop.ts", import.meta.url), "utf8");

    expect(module).not.toHaveProperty("buildRawPromptFrame");
    expect(source).not.toMatch(/export function buildRawPromptFrame/u);
  });
});

function fakeOutput(): RawPromptRenderOutput & { text(): string; chunks(): readonly string[] } {
  const writes: string[] = [];
  return {
    write: vi.fn((chunk: string) => {
      writes.push(chunk);
    }),
    text: () => writes.join(""),
    chunks: () => [...writes],
  };
}

function status(input: { readonly usedTokens: number; readonly elapsedMs: number }): StatusRailState {
  return {
    model: { label: "kimi-k2.7-code", state: "working" },
    context: { usedTokens: input.usedTokens, totalTokens: 262_000, percent: 7 },
    sessionTimer: { elapsedMs: input.elapsedMs },
  };
}
