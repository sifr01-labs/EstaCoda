import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createRawPrompt, RawPromptController, type RawPromptControllerOptions, type RawPromptInput, type RawPromptOutput } from "./rawPromptController.js";
import { RawPromptOverlayHost } from "./rawPromptRenderLoop.js";
import type { TerminalLifecycle } from "../ui/input/terminalLifecycle.js";
import { createGhostTextState, setGhostTextSuggestion } from "../ui/papyrus/input/ghostTextController.js";
import {
  SLASH_COMMAND_SUGGESTION_PROVIDER_ID,
  type SlashCommandSuggestionMetadata,
} from "../ui/papyrus/input/providers/slashCommandProvider.js";
import {
  createSuggestionTokenContext,
  normalizeSuggestionProviderResult,
  type SuggestionItem,
  type SuggestionProvider,
  type SuggestionProviderResult,
} from "../ui/papyrus/input/suggestionTypes.js";
import type { TypeaheadState } from "../ui/papyrus/input/typeaheadController.js";
import type {
  TypeaheadProviderRouter,
  TypeaheadProviderSelection,
} from "../ui/papyrus/input/typeaheadProviderRouter.js";
import type { ApprovalCardState, AttachmentCardState, TaskCardState } from "../ui/papyrus/operator-console/index.js";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const forbiddenManagedRegionOutput = /\x1b\[3J|\x1b\[2J|\x1b\[H|\x1b\[\d+;\d+H/u;
const slashSuggestion: SuggestionItem<SlashCommandSuggestionMetadata> = {
  id: "slash.help",
  label: "/help",
  description: "Show help",
  replacementText: "/help",
  replacementRange: { start: 0, end: 2 },
  providerId: SLASH_COMMAND_SUGGESTION_PROVIDER_ID,
  kind: "slash",
  metadata: {
    commandName: "help",
    aliases: [],
    category: "System",
  },
};
const statusSlashSuggestion: SuggestionItem<SlashCommandSuggestionMetadata> = {
  id: "slash.status",
  label: "/status",
  description: "Show status",
  replacementText: "/status",
  replacementRange: { start: 0, end: 2 },
  providerId: SLASH_COMMAND_SUGGESTION_PROVIDER_ID,
  kind: "slash",
  metadata: {
    commandName: "status",
    aliases: [],
    category: "System",
  },
};

class FakeInput extends EventEmitter implements RawPromptInput {
  isTTY = true;
  isRaw = false;
  resume = vi.fn();
  setRawMode = vi.fn((mode: boolean) => {
    this.isRaw = mode;
  });

  send(chunk: string): void {
    this.emit("data", chunk);
  }
}

class BufferedResumeInput extends FakeInput {
  readonly #buffered: string;

  constructor(buffered: string) {
    super();
    this.#buffered = buffered;
    this.resume = vi.fn(() => {
      this.send(this.#buffered);
    });
  }
}

function fakeOutput(): RawPromptOutput & { writes: string[] } {
  const writes: string[] = [];
  return {
    isTTY: true,
    writes,
    write: vi.fn((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    }),
  };
}

function fakeLifecycle(overrides: Partial<TerminalLifecycle> = {}) {
  const calls: string[] = [];
  let started = false;
  let mouseTracking = false;
  const lifecycle: TerminalLifecycle = {
    start: vi.fn(() => {
      calls.push("start");
      started = true;
    }),
    stop: vi.fn(() => {
      calls.push("stop");
      started = false;
      mouseTracking = false;
      return { errors: [] };
    }),
    isStarted: vi.fn(() => started),
    setMouseTracking: vi.fn((enabled: boolean) => (mouseTracking = enabled)),
    resetMouseTracking: vi.fn(() => { mouseTracking = false; }),
    isMouseTrackingEnabled: vi.fn(() => mouseTracking),
    ...overrides,
  };
  return { lifecycle, calls };
}

async function readWithFakeInput(inputText: string) {
  const input = new FakeInput();
  const output = fakeOutput();
  const lifecycle = fakeLifecycle();
  const controller = new RawPromptController({ input, output, lifecycle: lifecycle.lifecycle });

  const pending = controller.read("> ");
  input.send(inputText);

  return {
    result: await pending,
    input,
    output,
    lifecycle,
  };
}

async function readWithVimInput(inputText: string, options: Partial<RawPromptControllerOptions> = {}) {
  return await readWithVimChunks([inputText], options);
}

async function readWithVimChunks(chunks: readonly string[], options: Partial<RawPromptControllerOptions> = {}) {
  const input = new FakeInput();
  const output = fakeOutput();
  const lifecycle = fakeLifecycle();
  const controller = new RawPromptController({
    input,
    output,
    lifecycle: lifecycle.lifecycle,
    keymap: { mode: "vim" },
    ...options,
  });

  const pending = controller.read("> ");
  for (const chunk of chunks) input.send(chunk);

  return {
    result: await pending,
    input,
    output,
    lifecycle,
  };
}

function startPendingRead() {
  const input = new FakeInput();
  const output = fakeOutput();
  const lifecycle = fakeLifecycle();
  const controller = new RawPromptController({ input, output, lifecycle: lifecycle.lifecycle });
  let resolved = false;
  const pending = controller.read("> ").then((result) => {
    resolved = true;
    return result;
  });

  return {
    input,
    output,
    lifecycle,
    pending,
    isResolved: () => resolved,
  };
}

function startPendingOperatorConsoleRead(options: Partial<RawPromptControllerOptions> = {}) {
  const input = new FakeInput();
  const output = fakeOutput();
  output.columns = 72;
  output.rows = 16;
  const lifecycle = fakeLifecycle();
  const controller = new RawPromptController({
    input,
    output,
    lifecycle: lifecycle.lifecycle,
    operatorConsole: {
      enabled: true,
      terminal: { width: 72, height: 16, isTty: true },
      status: {
        model: { label: "kimi-k2.7-code", state: "working" },
        context: { usedTokens: 18400, totalTokens: 262000, percent: 7 },
        sessionTimer: { elapsedMs: 72_000 },
      },
    },
    ...options,
  });
  let resolved = false;
  const pending = controller.read("> ").then((result) => {
    resolved = true;
    return result;
  });

  return {
    input,
    output,
    lifecycle,
    pending,
    isResolved: () => resolved,
  };
}

describe("raw prompt controller", () => {
  it("gives the modal Task inspector first input priority and returns safely to the prompt", async () => {
    const read = startPendingOperatorConsoleRead({
      operatorConsole: {
        enabled: true,
        terminal: { width: 72, height: 16, isTty: true },
        getTasks: () => [promptTaskCard()],
      },
    });

    expect(read.output.writes.join("")).toContain("Retained Task card");
    read.input.send("\t");
    read.input.send("\r");
    read.input.send("ignored while modal");
    read.input.send("\t");
    read.input.send("ok\r");

    expect(await read.pending).toEqual({ type: "submit", text: "ok" });
    expect(read.output.writes.join("")).toContain("Activity trace");
  });

  it("edits normally after Escape returns from Task inspection to the main session", async () => {
    const read = startPendingOperatorConsoleRead({
      operatorConsole: {
        enabled: true,
        terminal: { width: 72, height: 16, isTty: true },
        getTasks: () => [promptTaskCard()],
      },
    });

    read.input.send("\t");
    read.input.send("\r");
    read.input.send("\u001b");
    await flushKeypressTimers();
    read.input.send("ab\u007f\r");

    await expect(read.pending).resolves.toEqual({ type: "submit", text: "a" });
  });

  it("keeps Ctrl-C global while Task inspection owns focus", async () => {
    const read = startPendingOperatorConsoleRead({
      operatorConsole: {
        enabled: true,
        terminal: { width: 72, height: 16, isTty: true },
        getTasks: () => [promptTaskCard()],
      },
    });

    read.input.send("\t");
    read.input.send("\r");
    read.input.send("\u0003");

    await expect(read.pending).resolves.toEqual({ type: "cancel" });
  });

  it("opens Subagent cards and breadcrumbs from SGR mouse input while idle", async () => {
    const read = startPendingOperatorConsoleRead({
      operatorConsole: {
        enabled: true,
        terminal: { width: 72, height: 18, isTty: true },
        getTasks: () => [promptTaskCardWithSubagentTrace(["Read first file"])],
      },
    });

    read.input.send("\u0007");
    await Promise.resolve();
    expect(read.output.writes.join("")).toContain("Mouse Mode");
    read.input.send("\x1b[<0;2;2M\x1b[<0;2;2m");
    await Promise.resolve();
    expect(read.output.writes.join("")).toContain("Retained safe activity");

    read.input.send("\x1b[<0;2;1M\x1b[<0;2;1m");
    await Promise.resolve();
    expect(read.output.writes.join("")).toContain("Plan Steps");

    read.input.send("\x1b[<0;2;1M\x1b[<0;2;1m");
    read.input.send("\t");
    read.input.send("ok\r");
    await expect(read.pending).resolves.toEqual({ type: "submit", text: "ok" });
  });

  it("keeps native mouse behavior until Ctrl-G and releases capture before typing", async () => {
    const read = startPendingOperatorConsoleRead({
      operatorConsole: {
        enabled: true,
        terminal: { width: 72, height: 18, isTty: true },
        getTasks: () => [promptTaskCard()],
      },
    });

    expect(read.lifecycle.lifecycle.resetMouseTracking).toHaveBeenCalledOnce();
    expect(read.lifecycle.lifecycle.setMouseTracking).not.toHaveBeenCalled();

    read.input.send("\u0007");
    expect(read.lifecycle.lifecycle.setMouseTracking).toHaveBeenLastCalledWith(true);
    expect(read.output.writes.join("")).toContain("[Mouse Mode]");

    read.input.send("\u001b");
    await flushKeypressTimers();
    expect(read.lifecycle.lifecycle.setMouseTracking).toHaveBeenLastCalledWith(false);
    expect(read.isResolved()).toBe(false);

    read.input.send("\u0007");
    read.input.send("x");
    expect(read.lifecycle.lifecycle.setMouseTracking).toHaveBeenLastCalledWith(false);
    read.input.send("\r");

    await expect(read.pending).resolves.toEqual({ type: "submit", text: "x" });
  });

  it("releases an active Mouse Mode when the raw prompt is closed", async () => {
    const input = new FakeInput();
    const output = fakeOutput();
    const lifecycle = fakeLifecycle();
    const controller = new RawPromptController({
      input,
      output,
      lifecycle: lifecycle.lifecycle,
      operatorConsole: {
        enabled: true,
        terminal: { width: 72, height: 18, isTty: true },
        getTasks: () => [promptTaskCard()],
      },
    });
    const pending = controller.read("> ");

    input.send("\u0007");
    expect(lifecycle.lifecycle.isMouseTrackingEnabled()).toBe(true);
    controller.close();

    await expect(pending).resolves.toEqual({ type: "cancel" });
    expect(lifecycle.lifecycle.stop).toHaveBeenCalledOnce();
    expect(lifecycle.lifecycle.isMouseTrackingEnabled()).toBe(false);
  });

  it("preserves historical Task trace selection while live Task projections refresh", async () => {
    let card = promptTaskCardWithTrace(["First event", "Second event"]);
    const read = startPendingOperatorConsoleRead({
      operatorConsole: {
        enabled: true,
        terminal: { width: 72, height: 16, isTty: true },
        getTasks: () => [card],
      },
    });

    read.input.send("\t");
    read.input.send("\r");
    read.input.send("\u001b[D");
    await flushKeypressTimers();
    card = promptTaskCardWithTrace(["First event", "Second event", "New live event"]);
    const refreshStart = read.output.writes.length;
    read.input.send("\u001b[A");
    await flushKeypressTimers();
    const refreshedOutput = read.output.writes.slice(refreshStart).join("");

    expect(refreshedOutput).toContain("First event");
    expect(refreshedOutput).toContain("Return to live");
    expect(refreshedOutput).not.toContain("New live event");
    read.input.send("\t");
    read.input.send("ok\r");
    await expect(read.pending).resolves.toEqual({ type: "submit", text: "ok" });
  });

  it("uses current terminal dimensions without losing historical Task selection", async () => {
    let terminal = { width: 72, height: 16, isTty: true };
    const card = promptTaskCardWithTrace(["First event", "Second event"]);
    const read = startPendingOperatorConsoleRead({
      operatorConsole: {
        enabled: true,
        terminal,
        getTerminal: () => terminal,
        getTasks: () => [card],
      },
    });

    read.input.send("\t");
    read.input.send("\r");
    read.input.send("\u001b[D");
    await flushKeypressTimers();
    terminal = { width: 44, height: 12, isTty: true };
    const resizeStart = read.output.writes.length;
    read.input.send("\u001b[A");
    await flushKeypressTimers();
    const resizedOutput = read.output.writes.slice(resizeStart).join("");

    expect(resizedOutput).toContain("First event");
    expect(resizedOutput).toContain("Return to live");
    read.input.send("\t");
    read.input.send("ok\r");
    await expect(read.pending).resolves.toEqual({ type: "submit", text: "ok" });
  });

  it("keeps Subagent inspection anchored by Step ID while its safe activity refreshes", async () => {
    let card = promptTaskCardWithSubagentTrace(["Read first file", "Summarized first file"]);
    const read = startPendingOperatorConsoleRead({
      operatorConsole: {
        enabled: true,
        terminal: { width: 72, height: 18, isTty: true },
        getTasks: () => [card],
      },
    });

    read.input.send("\t");
    read.input.send("\r");
    read.input.send("\r");
    read.input.send("\u001b[D");
    await flushKeypressTimers();
    card = promptTaskCardWithSubagentTrace([
      "Read first file",
      "Summarized first file",
      "New live Subagent event",
    ], "Reading the newly discovered file");
    const refreshStart = read.output.writes.length;
    read.input.send("\u001b[A");
    await flushKeypressTimers();
    const refreshedOutput = read.output.writes.slice(refreshStart).join("");

    expect(refreshedOutput).toContain("Main session / Task");
    expect(refreshedOutput).toContain("Subagent 1");
    expect(refreshedOutput).toContain("Reading the newly discovered file");
    expect(refreshedOutput).toContain("Return to live");
    read.input.send("\u001b");
    read.input.send("\t");
    read.input.send("ok\r");
    await expect(read.pending).resolves.toEqual({ type: "submit", text: "ok" });
  });

  it("submits ASCII text", async () => {
    const { result, output, lifecycle } = await readWithFakeInput("hello\r");

    expect(result).toEqual({ type: "submit", text: "hello" });
    expect(output.writes.join("")).toContain("> hello");
    expect(output.writes.join("")).not.toMatch(forbiddenManagedRegionOutput);
    expect(lifecycle.calls).toEqual(["start", "stop"]);
  });

  it("refreshes Operator Console status from the live supplier while idle", async () => {
    vi.useFakeTimers();
    try {
      let elapsedMs = 0;
      const { input, output, pending } = startPendingOperatorConsoleRead({
        operatorConsole: {
          enabled: true,
          terminal: { width: 72, height: 16, isTty: true },
          getStatus: () => ({
            model: { label: "live-model", state: "idle" },
            context: { usedTokens: 42, totalTokens: 100, percent: 42 },
            sessionTimer: { elapsedMs },
          }),
        },
      });

      elapsedMs = 61_000;
      vi.advanceTimersByTime(1000);
      input.send("\r");

      await expect(pending).resolves.toEqual({ type: "submit", text: "" });
      const rendered = output.writes.join("");
      expect(rendered).toContain("live-model");
      expect(rendered).toContain("42/100");
      expect(rendered).toContain("01:01");
    } finally {
      vi.useRealTimers();
    }
  });

  it("requires explicit approval focus before normal Enter can resolve a Task approval", async () => {
    const onApprovalIntent = vi.fn();
    const read = startPendingOperatorConsoleRead({
      operatorConsole: {
        enabled: true,
        terminal: { width: 72, height: 16, isTty: true },
        getApprovals: () => [promptApprovalCard()],
        onApprovalIntent
      }
    });

    expect(read.output.writes.join("")).toContain("Approval required");
    read.input.send("\r");

    await expect(read.pending).resolves.toEqual({ type: "submit", text: "" });
    expect(onApprovalIntent).not.toHaveBeenCalled();
  });

  it("routes explicit approve-once and rejection controls without submitting the prompt", async () => {
    let approvals: readonly ApprovalCardState[] = [promptApprovalCard()];
    const onApprovalIntent = vi.fn(async () => {
      approvals = [];
    });
    const approved = startPendingOperatorConsoleRead({
      operatorConsole: {
        enabled: true,
        terminal: { width: 72, height: 16, isTty: true },
        getApprovals: () => approvals,
        onApprovalIntent
      }
    });

    approved.input.send("\t");
    approved.input.send("\r");
    await flushPromises();
    expect(approved.isResolved()).toBe(false);
    expect(onApprovalIntent).toHaveBeenCalledWith({ type: "approve", approvalId: "approval-raw-1" });
    approved.input.send("continue\r");
    await expect(approved.pending).resolves.toEqual({ type: "submit", text: "continue" });

    approvals = [promptApprovalCard()];
    onApprovalIntent.mockClear();
    const rejected = startPendingOperatorConsoleRead({
      operatorConsole: {
        enabled: true,
        terminal: { width: 72, height: 16, isTty: true },
        getApprovals: () => approvals,
        onApprovalIntent
      }
    });
    rejected.input.send("\t");
    rejected.input.send("\x1b[C");
    rejected.input.send("\r");
    await flushPromises();
    expect(rejected.isResolved()).toBe(false);
    expect(onApprovalIntent).toHaveBeenCalledWith({ type: "reject", approvalId: "approval-raw-1" });
    rejected.input.send("done\r");
    await expect(rejected.pending).resolves.toEqual({ type: "submit", text: "done" });
  });

  it("captures input that becomes readable immediately on resume", async () => {
    const input = new BufferedResumeInput("buffered\r");
    const output = fakeOutput();
    const lifecycle = fakeLifecycle();
    const controller = new RawPromptController({ input, output, lifecycle: lifecycle.lifecycle });

    await expect(controller.read("> ")).resolves.toEqual({ type: "submit", text: "buffered" });
    expect(input.resume).toHaveBeenCalledOnce();
    expect(lifecycle.calls).toEqual(["start", "stop"]);
  });

  it("submits Arabic and emoji text", async () => {
    const { result } = await readWithFakeInput("مرحبا 🚀\r");

    expect(result).toEqual({ type: "submit", text: "مرحبا 🚀" });
  });

  it("inserts Alt+Enter as a newline without submitting", async () => {
    const read = startPendingRead();

    read.input.send("hello\x1b\rworld");
    await Promise.resolve();

    expect(read.isResolved()).toBe(false);
    expect(read.output.writes.join("")).toContain("> hello");
    expect(read.output.writes.join("")).toContain("world");

    read.input.send("\r");
    expect(await read.pending).toEqual({ type: "submit", text: "hello\nworld" });
  });

  it("submits an existing multiline buffer once with normal Enter", async () => {
    const { result } = await readWithFakeInput("one\x1b\rtwo\x1b\rthree\r");

    expect(result).toEqual({ type: "submit", text: "one\ntwo\nthree" });
  });

  it("keeps Alt+Enter newline insertion editable before submit", async () => {
    const { result } = await readWithFakeInput("abcd\x1b[D\x1b[D\x1b\ref\r");

    expect(result).toEqual({ type: "submit", text: "ab\nefcd" });
  });

  it("applies backspace and delete edits before submit", async () => {
    expect((await readWithFakeInput("abc\x7f\r")).result).toEqual({ type: "submit", text: "ab" });
    expect((await readWithFakeInput("abc\x1b[D\x1b[3~\r")).result).toEqual({ type: "submit", text: "ab" });
  });

  it("inserts bracketed paste without submitting until enter", async () => {
    const read = startPendingRead();

    read.input.send(`${PASTE_START}line one\nline two${PASTE_END}`);
    await Promise.resolve();
    expect(read.isResolved()).toBe(false);
    expect(read.output.writes.join("")).toContain("> line one");
    expect(read.output.writes.join("")).toContain("line two");
    expect(read.output.writes.join("")).not.toMatch(forbiddenManagedRegionOutput);

    read.input.send("\r");
    expect(await read.pending).toEqual({ type: "submit", text: "line one\nline two" });
  });

  it("inserts single-line bracketed paste without auto-submit", async () => {
    const read = startPendingRead();

    read.input.send(`${PASTE_START}pasted text${PASTE_END}`);
    await Promise.resolve();

    expect(read.isResolved()).toBe(false);
    read.input.send("\r");
    expect(await read.pending).toEqual({ type: "submit", text: "pasted text" });
  });

  it("allows pasted text to be edited before submit", async () => {
    const read = startPendingRead();

    read.input.send(`${PASTE_START}abc${PASTE_END}`);
    await Promise.resolve();
    read.input.send("\x1b[D\x7f\r");

    expect(await read.pending).toEqual({ type: "submit", text: "ac" });
  });

  it("keeps large bracketed paste deterministic until enter", async () => {
    const read = startPendingRead();
    const largePaste = Array.from({ length: 150 }, (_, index) => `line-${index}`).join("\n");

    read.input.send(`${PASTE_START}${largePaste}${PASTE_END}`);
    await Promise.resolve();

    expect(read.isResolved()).toBe(false);
    read.input.send("\r");
    expect(await read.pending).toEqual({ type: "submit", text: largePaste });
    expect(read.lifecycle.calls).toEqual(["start", "stop"]);
  });

  it("keeps split multiline bracketed paste deterministic until enter", async () => {
    const read = startPendingRead();

    read.input.send(`${PASTE_START}line one\n`);
    await Promise.resolve();
    expect(read.isResolved()).toBe(false);
    expect(read.output.writes.join("")).not.toContain("> line one");

    read.input.send(`line two${PASTE_END}`);
    await Promise.resolve();
    expect(read.isResolved()).toBe(false);
    expect(read.output.writes.join("")).toContain("> line one");
    expect(read.output.writes.join("")).toContain("line two");

    read.input.send("\r");
    expect(await read.pending).toEqual({ type: "submit", text: "line one\nline two" });
  });

  it("routes Operator Console bracketed paste into attachment cards instead of prompt text", async () => {
    const read = startPendingOperatorConsoleRead();
    const firstPastedLine = "MVP known issue ".repeat(20);
    const pasted = `${firstPastedLine}\nSECRET full pasted payload should stay out of prompt chrome`;

    read.input.send("summarize this");
    read.input.send(`${PASTE_START}${pasted}${PASTE_END}`);
    await Promise.resolve();

    const rendered = read.output.writes.join("");
    expect(read.isResolved()).toBe(false);
    expect(rendered).toContain("Attachments");
    expect(rendered).toContain("pasted text");
    expect(rendered).not.toContain("SECRET full pasted payload");
    expect(rendered).toContain("› summarize this");

    read.input.send("\r");
    expect(await read.pending).toEqual({
      type: "submit",
      text: [
        "summarize this",
        "",
        "[Pasted text 1]",
        pasted,
      ].join("\n"),
      displayText: [
        "summarize this",
        "",
        `Pasted text · 2 lines · ${pasted.length.toLocaleString("en-US")} chars`,
        `${firstPastedLine.slice(0, 157)}...`,
        "SECRET full pasted payload should stay out of prompt chrome",
      ].join("\n"),
    });
  });

  it("routes split Operator Console bracketed paste into one attachment", async () => {
    const attachmentsSeen: Array<readonly AttachmentCardState[]> = [];
    const read = startPendingOperatorConsoleRead({
      operatorConsole: {
        enabled: true,
        terminal: { width: 72, height: 16, isTty: true },
        onAttachmentsChange: (attachments) => {
          attachmentsSeen.push(attachments);
        },
      },
    });

    read.input.send(`${PASTE_START}line one\n`);
    await flushPromises();
    expect(read.isResolved()).toBe(false);
    expect(attachmentsSeen).toEqual([]);

    read.input.send(`line two${PASTE_END}`);
    await flushPromises();
    expect(read.isResolved()).toBe(false);
    expect(attachmentsSeen.at(-1)?.map((attachment) => attachment.content)).toEqual(["line one\nline two"]);
    expect(read.output.writes.join("")).toContain("pasted text");
    expect(read.output.writes.join("")).not.toContain("› line one");

    read.input.send("\r");
    expect(await read.pending).toEqual({
      type: "submit",
      text: ["[Pasted text 1]", "line one\nline two"].join("\n"),
      displayText: ["Pasted text · 2 lines · 17 chars", "line one", "line two"].join("\n"),
    });
  });

  it("stores full Operator Console pasted content in attachment state with preserved newlines", async () => {
    const attachmentsSeen: Array<readonly AttachmentCardState[]> = [];
    const read = startPendingOperatorConsoleRead({
      operatorConsole: {
        enabled: true,
        terminal: { width: 72, height: 16, isTty: true },
        onAttachmentsChange: (attachments) => {
          attachmentsSeen.push(attachments);
        },
      },
    });

    read.input.send(`${PASTE_START}line one\nline two${PASTE_END}`);
    await Promise.resolve();
    read.input.send("\r");

    expect(await read.pending).toEqual({
      type: "submit",
      text: ["[Pasted text 1]", "line one\nline two"].join("\n"),
      displayText: ["Pasted text · 2 lines · 17 chars", "line one", "line two"].join("\n"),
    });
    expect(attachmentsSeen.at(-1)).toHaveLength(1);
    expect(attachmentsSeen.at(-1)?.[0]).toMatchObject({
      kind: "pastedText",
      title: "pasted text",
      content: "line one\nline two",
      metadata: { chars: 17 },
    });
  });

  it("redacts secret-like Operator Console paste previews while preserving full attachment content", async () => {
    const attachmentsSeen: Array<readonly AttachmentCardState[]> = [];
    const pasted = "OPENAI_API_KEY=super-secret-value\ncontext after secret";
    const read = startPendingOperatorConsoleRead({
      operatorConsole: {
        enabled: true,
        terminal: { width: 72, height: 16, isTty: true },
        onAttachmentsChange: (attachments) => {
          attachmentsSeen.push(attachments);
        },
      },
    });

    read.input.send("summarize");
    read.input.send(`${PASTE_START}${pasted}${PASTE_END}`);
    await Promise.resolve();

    const rendered = read.output.writes.join("");
    expect(rendered).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(rendered).not.toContain("super-secret-value");
    expect(attachmentsSeen.at(-1)?.[0]?.content).toBe(pasted);

    read.input.send("\r");
    const result = await read.pending;
    expect(result.type).toBe("submit");
    if (result.type !== "submit") throw new Error("expected submit result");
    expect(result).toEqual({
      type: "submit",
      text: [
        "summarize",
        "",
        "[Pasted text 1]",
        pasted,
      ].join("\n"),
      displayText: [
        "summarize",
        "",
        `Pasted text · 2 lines · ${pasted.length} chars`,
        "OPENAI_API_KEY=[REDACTED]",
        "context after secret",
      ].join("\n"),
    });
    expect(result.text).toContain("super-secret-value");
    expect(result.displayText).not.toContain("super-secret-value");
  });

  it("allows multiple Operator Console paste attachments and submits full payloads with compact display text", async () => {
    const attachmentsSeen: Array<readonly AttachmentCardState[]> = [];
    const read = startPendingOperatorConsoleRead({
      operatorConsole: {
        enabled: true,
        terminal: { width: 72, height: 16, isTty: true },
        onAttachmentsChange: (attachments) => {
          attachmentsSeen.push(attachments);
        },
      },
    });

    read.input.send("summarize");
    read.input.send(`${PASTE_START}first pasted payload${PASTE_END}`);
    read.input.send(`${PASTE_START}second pasted payload${PASTE_END}`);
    await Promise.resolve();
    read.input.send("\r");

    expect(attachmentsSeen.at(-1)?.map((attachment) => attachment.content)).toEqual([
      "first pasted payload",
      "second pasted payload",
    ]);
    expect(await read.pending).toEqual({
      type: "submit",
      text: [
        "summarize",
        "",
        "[Pasted text 1]",
        "first pasted payload",
        "[Pasted text 2]",
        "second pasted payload",
      ].join("\n"),
      displayText: [
        "summarize",
        "",
        "Pasted text · 1 line · 20 chars",
        "first pasted payload",
        "Pasted text · 1 line · 21 chars",
        "second pasted payload",
      ].join("\n"),
    });
  });

  it("focuses Operator Console attachment cards and opens preview without submitting", async () => {
    const previews: AttachmentCardState[] = [];
    const read = startPendingOperatorConsoleRead({
      operatorConsole: {
        enabled: true,
        terminal: { width: 72, height: 16, isTty: true },
        onAttachmentPreview: (attachment) => {
          previews.push(attachment);
        },
      },
    });

    read.input.send("summarize");
    read.input.send(`${PASTE_START}full pasted payload${PASTE_END}`);
    await Promise.resolve();
    read.input.send("\t");
    await Promise.resolve();

    expect(read.output.writes.join("")).toContain("╭─ › pasted text");

    read.input.send("\r");
    await Promise.resolve();

    expect(read.isResolved()).toBe(false);
    expect(previews.map((attachment) => attachment.content)).toEqual(["full pasted payload"]);

    read.input.send("\x1b[Z");
    read.input.send("\r");

    expect(await read.pending).toEqual({
      type: "submit",
      text: ["summarize", "", "[Pasted text 1]", "full pasted payload"].join("\n"),
      displayText: ["summarize", "", "Pasted text · 1 line · 19 chars", "full pasted payload"].join("\n"),
    });
  });

  it("removes focused Operator Console attachments and omits them from submitted refs", async () => {
    const attachmentsSeen: Array<readonly AttachmentCardState[]> = [];
    const read = startPendingOperatorConsoleRead({
      operatorConsole: {
        enabled: true,
        terminal: { width: 72, height: 16, isTty: true },
        onAttachmentsChange: (attachments) => {
          attachmentsSeen.push(attachments);
        },
      },
    });

    read.input.send("summarize");
    read.input.send(`${PASTE_START}first pasted payload${PASTE_END}`);
    read.input.send(`${PASTE_START}second pasted payload${PASTE_END}`);
    await Promise.resolve();
    read.input.send("\t");
    read.input.send("\x1b");
    await flushKeypressTimers();

    expect(read.isResolved()).toBe(false);
    expect(attachmentsSeen.at(-1)?.map((attachment) => attachment.content)).toEqual(["second pasted payload"]);
    expect(read.output.writes.join("")).toContain("╭─ › pasted text");

    read.input.send("\x1b[Z");
    read.input.send("\r");

    expect(await read.pending).toEqual({
      type: "submit",
      text: [
        "summarize",
        "",
        "[Pasted text 1]",
        "second pasted payload",
      ].join("\n"),
      displayText: [
        "summarize",
        "",
        "Pasted text · 1 line · 21 chars",
        "second pasted payload",
      ].join("\n"),
    });
  });

  it("removes the latest Operator Console attachment with Ctrl-U when prompt is empty", async () => {
    const attachmentsSeen: Array<readonly AttachmentCardState[]> = [];
    const read = startPendingOperatorConsoleRead({
      operatorConsole: {
        enabled: true,
        terminal: { width: 72, height: 16, isTty: true },
        onAttachmentsChange: (attachments) => {
          attachmentsSeen.push(attachments);
        },
      },
    });

    read.input.send(`${PASTE_START}first pasted payload${PASTE_END}`);
    read.input.send(`${PASTE_START}second pasted payload${PASTE_END}`);
    await Promise.resolve();
    read.input.send("\x15");
    await Promise.resolve();

    expect(read.isResolved()).toBe(false);
    expect(attachmentsSeen.at(-1)?.map((attachment) => attachment.content)).toEqual(["first pasted payload"]);

    read.input.send("\r");
    expect(await read.pending).toEqual({
      type: "submit",
      text: ["[Pasted text 1]", "first pasted payload"].join("\n"),
      displayText: ["Pasted text · 1 line · 20 chars", "first pasted payload"].join("\n"),
    });
  });

  it("removes the focused Operator Console attachment with Ctrl-U when prompt is empty", async () => {
    const attachmentsSeen: Array<readonly AttachmentCardState[]> = [];
    const read = startPendingOperatorConsoleRead({
      operatorConsole: {
        enabled: true,
        terminal: { width: 72, height: 16, isTty: true },
        onAttachmentsChange: (attachments) => {
          attachmentsSeen.push(attachments);
        },
      },
    });

    read.input.send(`${PASTE_START}first pasted payload${PASTE_END}`);
    read.input.send(`${PASTE_START}second pasted payload${PASTE_END}`);
    await Promise.resolve();
    read.input.send("\t");
    read.input.send("\x15");
    await Promise.resolve();

    expect(read.isResolved()).toBe(false);
    expect(attachmentsSeen.at(-1)?.map((attachment) => attachment.content)).toEqual(["second pasted payload"]);

    read.input.send("\x1b[Z");
    read.input.send("\r");
    expect(await read.pending).toEqual({
      type: "submit",
      text: ["[Pasted text 1]", "second pasted payload"].join("\n"),
      displayText: ["Pasted text · 1 line · 21 chars", "second pasted payload"].join("\n"),
    });
  });

  it("returns attachment focus to the prompt before editing text", async () => {
    const read = startPendingOperatorConsoleRead({
      operatorConsole: {
        enabled: true,
        terminal: { width: 72, height: 16, isTty: true },
      },
    });

    read.input.send(`${PASTE_START}source material${PASTE_END}`);
    await Promise.resolve();
    read.input.send("\t");
    read.input.send("ab\u007f\r");

    await expect(read.pending).resolves.toEqual({
      type: "submit",
      text: ["a", "", "[Pasted text 1]", "source material"].join("\n"),
      displayText: ["a", "", "Pasted text · 1 line · 15 chars", "source material"].join("\n"),
    });
  });

  it("keeps Operator Console attachments when Ctrl-U clears non-empty prompt text", async () => {
    const attachmentsSeen: Array<readonly AttachmentCardState[]> = [];
    const read = startPendingOperatorConsoleRead({
      operatorConsole: {
        enabled: true,
        terminal: { width: 72, height: 16, isTty: true },
        onAttachmentsChange: (attachments) => {
          attachmentsSeen.push(attachments);
        },
      },
    });

    read.input.send("summarize");
    read.input.send(`${PASTE_START}full pasted payload${PASTE_END}`);
    await Promise.resolve();
    read.input.send("\x15");
    await Promise.resolve();

    expect(read.isResolved()).toBe(false);
    expect(attachmentsSeen.at(-1)?.map((attachment) => attachment.content)).toEqual(["full pasted payload"]);

    read.input.send("\r");
    expect(await read.pending).toEqual({
      type: "submit",
      text: ["[Pasted text 1]", "full pasted payload"].join("\n"),
      displayText: ["Pasted text · 1 line · 19 chars", "full pasted payload"].join("\n"),
    });
  });

  it("does not remove Operator Console attachments when Escape cancels from prompt focus", async () => {
    const attachmentsSeen: Array<readonly AttachmentCardState[]> = [];
    const read = startPendingOperatorConsoleRead({
      operatorConsole: {
        enabled: true,
        terminal: { width: 72, height: 16, isTty: true },
        onAttachmentsChange: (attachments) => {
          attachmentsSeen.push(attachments);
        },
      },
    });

    read.input.send(`${PASTE_START}full pasted payload${PASTE_END}`);
    await Promise.resolve();
    read.input.send("\x1b");

    expect(await read.pending).toEqual({ type: "cancel" });
    expect(attachmentsSeen.at(-1)?.map((attachment) => attachment.content)).toEqual(["full pasted payload"]);
  });

  it("returns cancel for Ctrl-C and Escape", async () => {
    expect((await readWithFakeInput("\x03")).result).toEqual({ type: "cancel" });
    expect((await readWithFakeInput("\x1b")).result).toEqual({ type: "cancel" });
  });

  it("cancels without submitting partial input and cleans up once", async () => {
    const { result, lifecycle } = await readWithFakeInput("partial\x03");

    expect(result).toEqual({ type: "cancel" });
    expect(lifecycle.calls).toEqual(["start", "stop"]);
  });

  it("returns eof for Ctrl-D on empty input", async () => {
    const { result } = await readWithFakeInput("\x04");

    expect(result).toEqual({ type: "eof" });
  });

  it("Ctrl-D deletes the next grapheme on non-empty input instead of exiting", async () => {
    const { result } = await readWithFakeInput("ab\x01\x04\r");

    expect(result).toEqual({ type: "submit", text: "b" });
  });

  it("submits after cursor movement and editing", async () => {
    const { result, lifecycle } = await readWithFakeInput("abc\x1b[DX\r");

    expect(result).toEqual({ type: "submit", text: "abXc" });
    expect(lifecycle.calls).toEqual(["start", "stop"]);
  });

  it("routes Vim insert and normal mode transitions behind the raw keymap option", async () => {
    expect((await readWithVimChunks(["abc", "\x1b", "0iX\r"])).result).toEqual({
      type: "submit",
      text: "Xabc",
    });
    expect((await readWithVimChunks(["ab", "\x1b", "0aX\r"])).result).toEqual({
      type: "submit",
      text: "aXb",
    });
    expect((await readWithVimChunks(["ab", "\x1b", "IX\r"])).result).toEqual({
      type: "submit",
      text: "Xab",
    });
    expect((await readWithVimChunks(["ab", "\x1b", "AX\r"])).result).toEqual({
      type: "submit",
      text: "abX",
    });
  });

  it("routes Vim motions and counts through the raw prompt adapter", async () => {
    expect((await readWithVimChunks(["abc", "\x1b", "hhiX\r"])).result).toEqual({
      type: "submit",
      text: "aXbc",
    });
    expect((await readWithVimChunks(["abc", "\x1b", "0$iX\r"])).result).toEqual({
      type: "submit",
      text: "abcX",
    });
    expect((await readWithVimChunks(["  abc", "\x1b", "^iX\r"])).result).toEqual({
      type: "submit",
      text: "  Xabc",
    });
    expect((await readWithVimChunks(["one two three", "\x1b", "02wiX\r"])).result).toEqual({
      type: "submit",
      text: "one two Xthree",
    });
    expect((await readWithVimChunks(["one two", "\x1b", "$biX\r"])).result).toEqual({
      type: "submit",
      text: "one Xtwo",
    });
    expect((await readWithVimChunks(["one two", "\x1b", "0eiX\r"])).result).toEqual({
      type: "submit",
      text: "oneX two",
    });
  });

  it("routes Vim x, dw, and cw operators through the raw prompt adapter", async () => {
    expect((await readWithVimChunks(["abcdef", "\x1b", "02x\r"])).result).toEqual({
      type: "submit",
      text: "cdef",
    });
    expect((await readWithVimChunks(["one two three four", "\x1b", "03dw\r"])).result).toEqual({
      type: "submit",
      text: "four",
    });
    expect((await readWithVimChunks(["one two three", "\x1b", "02cwX\r"])).result).toEqual({
      type: "submit",
      text: "X three",
    });
  });

  it("preserves submit and cancel invariants in Vim keymap mode", async () => {
    expect((await readWithVimInput("insert\r")).result).toEqual({
      type: "submit",
      text: "insert",
    });
    expect((await readWithVimChunks(["normal", "\x1b", "\r"])).result).toEqual({
      type: "submit",
      text: "normal",
    });
    expect((await readWithVimChunks(["cancel", "\x1b", "\x03"])).result).toEqual({ type: "cancel" });
  });

  it("keeps ghost text rendering unaffected by Vim keymap mode", async () => {
    const ghost = setGhostTextSuggestion(
      createGhostTextState({ input: "", cursorOffset: 0 }),
      {
        suggestionText: "hello",
        replacementRange: { start: 0, end: 0 },
      }
    );
    const read = await readWithVimInput("\x03", {
      ghostText: {
        enabled: true,
        getState: () => ghost,
      },
    });

    expect(read.result).toEqual({ type: "cancel" });
    expect(read.output.writes.join("")).toContain("> hello");
  });

  it("redraws after editing and cursor movement through the render loop", async () => {
    const read = startPendingRead();

    read.input.send("abc");
    read.input.send("\x1b[D");
    read.input.send("X\r");

    expect(await read.pending).toEqual({ type: "submit", text: "abXc" });
    expect(read.output.writes.join("")).toContain("> abc");
    expect(read.output.writes.join("")).toContain("> abXc");
    expect(read.output.writes.join("")).toContain("\x1b[4C");
    expect(read.output.writes.join("")).not.toMatch(forbiddenManagedRegionOutput);
  });

  it("renders through Operator Console host when explicitly enabled", async () => {
    const read = startPendingOperatorConsoleRead();

    read.input.send("review the Papyrus rollout plan\r");

    expect(await read.pending).toEqual({ type: "submit", text: "review the Papyrus rollout plan" });
    const output = read.output.writes.join("");
    expect(output).toContain("› review the Papyrus rollout plan");
    expect(output).toContain("kimi-k2.7-code ● · ctx [▰▱▱▱▱▱▱▱▱▱] 18.4k/262k");
    expect(output).toContain("· ◷ 01:12");
    expect(output).not.toMatch(/\b(tool|approval|workspace|trust|steering|setup|channel)\b/iu);
    expect(output).not.toMatch(forbiddenManagedRegionOutput);
  });

  it("submits an Operator Console prompt once without duplicate prompt text", async () => {
    const read = startPendingOperatorConsoleRead();

    read.input.send("hello\r");

    expect(await read.pending).toEqual({ type: "submit", text: "hello" });
    expect(countOccurrences(read.output.writes.join(""), "› hello")).toBe(1);
  });

  it("keeps Alt+Enter multiline insertion under Operator Console routing", async () => {
    const read = startPendingOperatorConsoleRead();

    read.input.send("hello\x1b\rworld");
    await flushPromises();

    expect(read.isResolved()).toBe(false);
    expect(read.output.writes.join("")).toContain("› hello");
    expect(read.output.writes.join("")).toContain("  world");

    read.input.send("\r");
    expect(await read.pending).toEqual({ type: "submit", text: "hello\nworld" });
  });

  it("routes multiline paste into attachments under Operator Console routing", async () => {
    const read = startPendingOperatorConsoleRead();

    read.input.send(`${PASTE_START}line one\nline two${PASTE_END}`);
    await flushPromises();

    expect(read.isResolved()).toBe(false);
    expect(read.output.writes.join("")).toContain("Attachments");
    expect(read.output.writes.join("")).toContain("pasted text");
    expect(read.output.writes.join("")).toContain("17 chars");
    expect(read.output.writes.join("")).not.toContain("Prompt · multiline");
    expect(read.output.writes.join("")).not.toContain("› line one");

    read.input.send("\r");
    expect(await read.pending).toEqual({
      type: "submit",
      text: ["[Pasted text 1]", "line one\nline two"].join("\n"),
      displayText: ["Pasted text · 2 lines · 17 chars", "line one", "line two"].join("\n"),
    });
  });

  it("keeps Escape cancel behavior unchanged under Operator Console routing", async () => {
    const read = startPendingOperatorConsoleRead();

    read.input.send("\x1b");

    expect(await read.pending).toEqual({ type: "cancel" });
    expect(read.lifecycle.calls).toEqual(["start", "stop"]);
  });

  it("renders inert overlay rows and clears them on submit", async () => {
    const input = new FakeInput();
    const output = fakeOutput();
    const lifecycle = fakeLifecycle();
    const overlayHost = new RawPromptOverlayHost();
    overlayHost.setRows([{ id: "overlay", text: "future overlay row" }]);
    const controller = new RawPromptController({
      input,
      output,
      lifecycle: lifecycle.lifecycle,
      overlayHost,
    });
    const pending = controller.read("> ");

    input.send("\r");

    expect(await pending).toEqual({ type: "submit", text: "" });
    expect(output.writes.join("")).toContain("future overlay row");
    expect(overlayHost.getRows()).toEqual([]);
    expect(output.writes.join("")).not.toMatch(forbiddenManagedRegionOutput);
  });

  it("renders injected ghost text when enabled", async () => {
    const input = new FakeInput();
    const output = fakeOutput();
    const lifecycle = fakeLifecycle();
    const ghost = setGhostTextSuggestion(
      createGhostTextState({ input: "", cursorOffset: 0 }),
      {
        suggestionText: "hello",
        replacementRange: { start: 0, end: 0 },
      }
    );
    const controller = new RawPromptController({
      input,
      output,
      lifecycle: lifecycle.lifecycle,
      ghostText: {
        enabled: true,
        getState: () => ghost,
      },
    });
    const pending = controller.read("> ");

    expect(output.writes.join("")).toContain("> hello");
    expect(output.writes.join("")).not.toMatch(forbiddenManagedRegionOutput);

    input.send("\x03");
    expect(await pending).toEqual({ type: "cancel" });
  });

  it("does not render injected ghost text when disabled", async () => {
    const input = new FakeInput();
    const output = fakeOutput();
    const lifecycle = fakeLifecycle();
    const ghost = setGhostTextSuggestion(
      createGhostTextState({ input: "", cursorOffset: 0 }),
      {
        suggestionText: "hello",
        replacementRange: { start: 0, end: 0 },
      }
    );
    const controller = new RawPromptController({
      input,
      output,
      lifecycle: lifecycle.lifecycle,
      ghostText: {
        enabled: false,
        getState: () => ghost,
      },
    });
    const pending = controller.read("> ");

    expect(output.writes.join("")).not.toContain("> hello");

    input.send("\x03");
    expect(await pending).toEqual({ type: "cancel" });
  });

  it("keeps ghost text render-only and does not accept it on submit", async () => {
    const input = new FakeInput();
    const output = fakeOutput();
    const lifecycle = fakeLifecycle();
    const ghost = setGhostTextSuggestion(
      createGhostTextState({ input: "", cursorOffset: 0 }),
      {
        suggestionText: "hello",
        replacementRange: { start: 0, end: 0 },
      }
    );
    const controller = new RawPromptController({
      input,
      output,
      lifecycle: lifecycle.lifecycle,
      ghostText: {
        enabled: true,
        getState: () => ghost,
      },
    });
    const pending = controller.read("> ");

    input.send("\r");

    expect(await pending).toEqual({ type: "submit", text: "" });
    expect(output.writes.join("")).toContain("> hello");
  });

  it("hides ghost text while slash autocomplete overlay rows are active", async () => {
    const input = new FakeInput();
    const output = fakeOutput();
    const lifecycle = fakeLifecycle();
    const overlayHost = new RawPromptOverlayHost();
    overlayHost.setRows([{ text: "> /help - Show help" }]);
    const ghost = setGhostTextSuggestion(
      createGhostTextState({ input: "", cursorOffset: 0 }),
      {
        suggestionText: "hello",
        replacementRange: { start: 0, end: 0 },
      }
    );
    const controller = new RawPromptController({
      input,
      output,
      lifecycle: lifecycle.lifecycle,
      overlayHost,
      ghostText: {
        enabled: true,
        getState: () => ghost,
      },
    });
    const pending = controller.read("> ");

    expect(output.writes.join("")).toContain("> /help - Show help");
    expect(output.writes.join("")).not.toContain("> hello");
    expect(output.writes.join("")).not.toMatch(forbiddenManagedRegionOutput);

    input.send("\x03");
    expect(await pending).toEqual({ type: "cancel" });
  });

  it("does not render overlay rows when none are attached", async () => {
    const { result, output } = await readWithFakeInput("plain\r");

    expect(result).toEqual({ type: "submit", text: "plain" });
    expect(output.writes.join("")).not.toContain("future overlay row");
    expect(output.writes.join("")).not.toMatch(forbiddenManagedRegionOutput);
  });

  it("clears overlay rows on cancel", async () => {
    const input = new FakeInput();
    const output = fakeOutput();
    const lifecycle = fakeLifecycle();
    const overlayHost = new RawPromptOverlayHost();
    overlayHost.setRows([{ text: "dismiss me" }]);
    const controller = new RawPromptController({
      input,
      output,
      lifecycle: lifecycle.lifecycle,
      overlayHost,
    });
    const pending = controller.read("> ");

    input.send("\x1b");

    expect(await pending).toEqual({ type: "cancel" });
    expect(output.writes.join("")).toContain("dismiss me");
    expect(overlayHost.getRows()).toEqual([]);
    expect(output.writes.join("")).not.toMatch(forbiddenManagedRegionOutput);
  });

  it("treats Up and Down history keys as safe no-ops for now", async () => {
    const { result } = await readWithFakeInput("draft\x1b[A\x1b[B\r");

    expect(result).toEqual({ type: "submit", text: "draft" });
  });

  it("treats Ctrl-N and Ctrl-P as safe no-ops when autocomplete is closed", async () => {
    const { result } = await readWithFakeInput("draft\x0e\x10\r");

    expect(result).toEqual({ type: "submit", text: "draft" });
  });

  it("preserves prompt safety for unknown escape sequences", async () => {
    const { result } = await readWithFakeInput("\x1b[999~ok\r");

    expect(result).toEqual({ type: "submit", text: "ok" });
  });

  it("maps cancel and eof to /exit in the Prompt adapter", async () => {
    const cancelInput = new FakeInput();
    const cancelPrompt = createRawPrompt({ input: cancelInput, output: fakeOutput(), lifecycle: fakeLifecycle().lifecycle });
    const cancelPending = cancelPrompt("> ");
    cancelInput.send("\x03");

    const eofInput = new FakeInput();
    const eofPrompt = createRawPrompt({ input: eofInput, output: fakeOutput(), lifecycle: fakeLifecycle().lifecycle });
    const eofPending = eofPrompt("> ");
    eofInput.send("\x04");

    expect(await cancelPending).toBe("/exit");
    expect(await eofPending).toBe("/exit");
  });

  it("runs cleanup after cancel", async () => {
    const { result, lifecycle } = await readWithFakeInput("\x1b");

    expect(result).toEqual({ type: "cancel" });
    expect(lifecycle.calls).toEqual(["start", "stop"]);
  });

  it("stops lifecycle if start throws", async () => {
    const error = new Error("raw start failed");
    const input = new FakeInput();
    const output = fakeOutput();
    const lifecycle = fakeLifecycle({
      start: vi.fn(() => {
        lifecycle.calls.push("start");
        throw error;
      }),
    });
    const controller = new RawPromptController({ input, output, lifecycle: lifecycle.lifecycle });

    await expect(controller.read("> ")).rejects.toBe(error);
    expect(lifecycle.calls).toEqual(["start", "stop"]);
  });

  it("reports lifecycle cleanup errors as prompt failures", async () => {
    const error = new Error("cleanup failed");
    const input = new FakeInput();
    const output = fakeOutput();
    const lifecycle = fakeLifecycle({
      stop: vi.fn(() => {
        lifecycle.calls.push("stop");
        return { errors: [error] };
      }),
    });
    const controller = new RawPromptController({ input, output, lifecycle: lifecycle.lifecycle });
    const pending = controller.read("> ");

    input.send("hello\r");

    await expect(pending).rejects.toBe(error);
    expect(lifecycle.calls).toEqual(["start", "stop"]);
  });

  it("tracks input changes without using global process streams", async () => {
    const input = new FakeInput();
    const output = fakeOutput();
    const lifecycle = fakeLifecycle();
    const changes: string[] = [];
    const controller = new RawPromptController({ input, output, lifecycle: lifecycle.lifecycle });
    const pending = controller.read("> ", { onInputChange: (line) => changes.push(line) });

    input.send("a");
    input.send("ب");
    input.send("\r");

    expect(await pending).toEqual({ type: "submit", text: "aب" });
    expect(changes).toEqual(["a", "aب"]);
  });

  it("updates typeahead for slash input through an explicit router", async () => {
    const provider = providerFor(SLASH_COMMAND_SUGGESTION_PROVIDER_ID, [slashSuggestion]);
    const typeahead = fakeTypeahead(provider);
    const input = new FakeInput();
    const output = fakeOutput();
    const lifecycle = fakeLifecycle();
    const states: TypeaheadState[] = [];
    const controller = new RawPromptController({
      input,
      output,
      lifecycle: lifecycle.lifecycle,
      typeahead: {
        router: typeahead.router,
        onStateChange: (state) => states.push(state),
      },
    });
    const pending = controller.read("> ");

    input.send("/h");
    await flushPromises();
    input.send("\r");
    input.send("\r");

    expect(await pending).toEqual({ type: "submit", text: "/help" });
    expect(typeahead.route).toHaveBeenCalled();
    expect(provider.getSuggestions).toHaveBeenCalled();
    expect(output.writes.join("")).toContain("> /help - Show help");
    expect(states.some((state) => state.status === "open" && state.providerId === SLASH_COMMAND_SUGGESTION_PROVIDER_ID)).toBe(true);
    expect(states.at(-1)?.status).toBe("dismissed");
    expect(output.writes.join("")).not.toMatch(forbiddenManagedRegionOutput);
  });

  it("opens slash autocomplete after / and refreshes rows for a partial query", async () => {
    const provider: SuggestionProvider<SlashCommandSuggestionMetadata> = {
      id: SLASH_COMMAND_SUGGESTION_PROVIDER_ID,
      name: "Slash",
      getSuggestions: vi.fn((context) => {
        const suggestions = context.token === "/"
          ? [slashSuggestion, statusSlashSuggestion]
          : [statusSlashSuggestion];
        return normalizeSuggestionProviderResult(SLASH_COMMAND_SUGGESTION_PROVIDER_ID, {
          suggestions: suggestions.map((suggestion) => ({
            ...suggestion,
            replacementRange: context.tokenRange,
          })),
        });
      }),
    };
    const typeahead = fakeTypeahead(provider);
    const input = new FakeInput();
    const output = fakeOutput();
    const lifecycle = fakeLifecycle();
    const overlayHost = new RawPromptOverlayHost();
    const states: TypeaheadState[] = [];
    const controller = new RawPromptController({
      input,
      output,
      lifecycle: lifecycle.lifecycle,
      overlayHost,
      typeahead: {
        router: typeahead.router,
        onStateChange: (state) => states.push(state),
      },
    });
    const pending = controller.read("> ");

    input.send("/");
    await flushPromises();

    expect(provider.getSuggestions).toHaveBeenLastCalledWith(
      expect.objectContaining({ token: "/" }),
      undefined
    );
    expect(overlayHost.getRows().map((row) => row.text)).toEqual([
      "> /help - Show help",
      "  /status - Show status",
    ]);

    input.send("s");
    await flushPromises();

    expect(provider.getSuggestions).toHaveBeenLastCalledWith(
      expect.objectContaining({ token: "/s" }),
      undefined
    );
    expect(overlayHost.getRows().map((row) => row.text)).toEqual([
      "> /status - Show status",
    ]);
    expect(states.some((state) => state.status === "open")).toBe(true);

    input.send("\r");
    input.send("\r");

    expect(await pending).toEqual({ type: "submit", text: "/status" });
    expect(output.writes.join("")).not.toMatch(forbiddenManagedRegionOutput);
  });

  it("accepts the focused slash suggestion with Enter without submitting", async () => {
    const provider = providerFor(SLASH_COMMAND_SUGGESTION_PROVIDER_ID, [slashSuggestion]);
    const typeahead = fakeTypeahead(provider);
    const input = new FakeInput();
    const output = fakeOutput();
    const lifecycle = fakeLifecycle();
    const changes: string[] = [];
    const states: TypeaheadState[] = [];
    const controller = new RawPromptController({
      input,
      output,
      lifecycle: lifecycle.lifecycle,
      typeahead: {
        router: typeahead.router,
        onStateChange: (state) => states.push(state),
      },
    });
    const pending = controller.read("> ", { onInputChange: (line) => changes.push(line) });

    input.send("/h");
    await flushPromises();
    input.send("\r");
    await flushPromises();

    expect(changes.at(-1)).toBe("/help");
    expect(output.writes.join("")).toContain("> /help");
    expect(states.at(-1)?.status).toBe("closed");

    input.send("\r");
    expect(await pending).toEqual({ type: "submit", text: "/help" });
    expect(output.writes.join("")).not.toMatch(forbiddenManagedRegionOutput);
  });

  it("accepts the focused slash suggestion with Enter under Operator Console routing", async () => {
    const provider = providerFor(SLASH_COMMAND_SUGGESTION_PROVIDER_ID, [slashSuggestion]);
    const typeahead = fakeTypeahead(provider);
    const read = startPendingOperatorConsoleRead({
      typeahead: {
        router: typeahead.router,
      },
    });

    read.input.send("/h");
    await flushPromises();
    read.input.send("\r");
    await flushPromises();

    expect(read.output.writes.join("")).toContain("Command palette");
    expect(read.output.writes.join("")).toContain("❯ /help  Show help");
    expect(read.output.writes.join("")).not.toContain("> /help - Show help");
    expect(read.output.writes.join("")).toContain("› /help");
    expect(read.isResolved()).toBe(false);

    read.input.send("\r");
    expect(await read.pending).toEqual({ type: "submit", text: "/help" });
  });

  it("renders Operator Console slash menu below prompt and clears it after submit", async () => {
    const provider = providerFor(SLASH_COMMAND_SUGGESTION_PROVIDER_ID, [slashSuggestion, statusSlashSuggestion]);
    const typeahead = fakeTypeahead(provider);
    const overlayHost = new RawPromptOverlayHost();
    const read = startPendingOperatorConsoleRead({
      overlayHost,
      typeahead: {
        router: typeahead.router,
      },
    });

    read.input.send("/h");
    await flushPromises();

    const openRender = read.output.writes.join("");
    expect(openRender.indexOf("╭─ Prompt")).toBeLessThan(openRender.indexOf("╭─ Command palette"));
    expect(openRender.indexOf("╭─ Command palette")).toBeLessThan(openRender.lastIndexOf("◷"));
    expect(openRender).toContain("❯ /help    Show help");
    expect(openRender).toContain("  /status  Show status");
    expect(openRender).not.toMatch(/\b(slash|command palette|help)\b.*◷/iu);
    expect(overlayHost.getRows()).toEqual([]);

    read.input.send("\x1b[B");
    await flushPromises();
    expect(read.output.writes.join("")).toContain("❯ /status  Show status");

    read.input.send("\r");
    await flushPromises();
    read.input.send("\r");

    expect(await read.pending).toEqual({ type: "submit", text: "/status" });
    expect(overlayHost.getRows()).toEqual([]);
  });

  it("inserts Alt+Enter instead of accepting an open slash suggestion", async () => {
    const provider = providerFor(SLASH_COMMAND_SUGGESTION_PROVIDER_ID, [slashSuggestion]);
    const typeahead = fakeTypeahead(provider);
    const input = new FakeInput();
    const output = fakeOutput();
    const lifecycle = fakeLifecycle();
    const overlayHost = new RawPromptOverlayHost();
    let resolved = false;
    const controller = new RawPromptController({
      input,
      output,
      lifecycle: lifecycle.lifecycle,
      overlayHost,
      typeahead: {
        router: typeahead.router,
      },
    });
    const pending = controller.read("> ").then((result) => {
      resolved = true;
      return result;
    });

    input.send("/h");
    await flushPromises();
    input.send("\x1b\r");
    await flushPromises();

    expect(resolved).toBe(false);
    expect(output.writes.join("")).toContain("> /h");
    expect(overlayHost.getRows()).toEqual([]);

    input.send("\r");
    expect(await pending).toEqual({ type: "submit", text: "/h\n" });
    expect(output.writes.join("")).not.toMatch(forbiddenManagedRegionOutput);
  });

  it("inserts Alt+Enter instead of accepting an open slash suggestion under Operator Console routing", async () => {
    const provider = providerFor(SLASH_COMMAND_SUGGESTION_PROVIDER_ID, [slashSuggestion]);
    const typeahead = fakeTypeahead(provider);
    const overlayHost = new RawPromptOverlayHost();
    const read = startPendingOperatorConsoleRead({
      overlayHost,
      typeahead: {
        router: typeahead.router,
      },
    });

    read.input.send("/h");
    await flushPromises();
    read.input.send("\x1b\r");
    await flushPromises();

    expect(read.isResolved()).toBe(false);
    const multilineRender = read.output.writes.join("");
    const finalFrame = multilineRender.slice(multilineRender.lastIndexOf("› /h"));
    expect(finalFrame).toContain("› /h");
    expect(finalFrame).not.toContain("❯ /help");
    expect(overlayHost.getRows()).toEqual([]);

    read.input.send("\r");
    expect(await read.pending).toEqual({ type: "submit", text: "/h\n" });
  });

  it("accepts the focused slash suggestion with Tab", async () => {
    const provider = providerFor(SLASH_COMMAND_SUGGESTION_PROVIDER_ID, [slashSuggestion]);
    const typeahead = fakeTypeahead(provider);
    const input = new FakeInput();
    const output = fakeOutput();
    const lifecycle = fakeLifecycle();
    const controller = new RawPromptController({
      input,
      output,
      lifecycle: lifecycle.lifecycle,
      typeahead: {
        router: typeahead.router,
      },
    });
    const pending = controller.read("> ");

    input.send("/h");
    await flushPromises();
    input.send("\t");
    await flushPromises();
    input.send("\r");

    expect(await pending).toEqual({ type: "submit", text: "/help" });
    expect(output.writes.join("")).toContain("> /help");
    expect(output.writes.join("")).not.toMatch(forbiddenManagedRegionOutput);
  });

  it("accepts slash suggestions as text only without executing commands", async () => {
    const executeCommand = vi.fn();
    const provider = providerFor(SLASH_COMMAND_SUGGESTION_PROVIDER_ID, [slashSuggestion]);
    const typeahead = fakeTypeahead(provider);
    const input = new FakeInput();
    const output = fakeOutput();
    const lifecycle = fakeLifecycle();
    const controller = new RawPromptController({
      input,
      output,
      lifecycle: lifecycle.lifecycle,
      typeahead: {
        router: typeahead.router,
      },
    });
    const pending = controller.read("> ");

    input.send("/h");
    await flushPromises();
    input.send("\t");
    await flushPromises();

    expect(executeCommand).not.toHaveBeenCalled();
    input.send("\r");

    expect(await pending).toEqual({ type: "submit", text: "/help" });
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it("applies accepted slash replacement to only the active token range", async () => {
    const provider = providerFor(SLASH_COMMAND_SUGGESTION_PROVIDER_ID, [slashSuggestion]);
    const typeahead = fakeTypeahead(provider);
    const input = new FakeInput();
    const output = fakeOutput();
    const lifecycle = fakeLifecycle();
    const controller = new RawPromptController({
      input,
      output,
      lifecycle: lifecycle.lifecycle,
      typeahead: {
        router: typeahead.router,
      },
    });
    const pending = controller.read("> ");

    input.send("run /h tail\x1b[D\x1b[D\x1b[D\x1b[D\x1b[D");
    await flushPromises();
    input.send("\t");
    await flushPromises();
    input.send("\r");

    expect(await pending).toEqual({ type: "submit", text: "run /help tail" });
    expect(output.writes.join("")).toContain("> run /help tail");
    expect(output.writes.join("")).not.toMatch(forbiddenManagedRegionOutput);
  });

  it("keeps pasted slash text from auto-accepting or auto-submitting", async () => {
    const provider = providerFor(SLASH_COMMAND_SUGGESTION_PROVIDER_ID, [slashSuggestion]);
    const typeahead = fakeTypeahead(provider);
    const input = new FakeInput();
    const output = fakeOutput();
    const lifecycle = fakeLifecycle();
    const overlayHost = new RawPromptOverlayHost();
    const controller = new RawPromptController({
      input,
      output,
      lifecycle: lifecycle.lifecycle,
      overlayHost,
      typeahead: {
        router: typeahead.router,
      },
    });
    let resolved = false;
    const pending = controller.read("> ").then((result) => {
      resolved = true;
      return result;
    });

    input.send(`${PASTE_START}/h${PASTE_END}`);
    await flushPromises();

    expect(resolved).toBe(false);
    expect(output.writes.join("")).toContain("> /h");
    expect(overlayHost.getRows().map((row) => row.text)).toEqual([
      "> /help - Show help",
    ]);

    input.send("\x1b");
    await flushPromises();
    input.send("\r");

    expect(await pending).toEqual({ type: "submit", text: "/h" });
    expect(output.writes.join("")).not.toMatch(forbiddenManagedRegionOutput);
  });

  it("dismisses open autocomplete with Escape without canceling the prompt", async () => {
    const provider = providerFor(SLASH_COMMAND_SUGGESTION_PROVIDER_ID, [slashSuggestion]);
    const typeahead = fakeTypeahead(provider);
    const input = new FakeInput();
    const output = fakeOutput();
    const lifecycle = fakeLifecycle();
    const states: TypeaheadState[] = [];
    const controller = new RawPromptController({
      input,
      output,
      lifecycle: lifecycle.lifecycle,
      typeahead: {
        router: typeahead.router,
        onStateChange: (state) => states.push(state),
      },
    });
    const pending = controller.read("> ");

    input.send("/h");
    await flushPromises();
    input.send("\x1b");
    await flushPromises();
    input.send("\r");

    expect(await pending).toEqual({ type: "submit", text: "/h" });
    expect(states.at(-1)?.status).toBe("dismissed");
    expect(output.writes.join("")).not.toMatch(forbiddenManagedRegionOutput);
  });

  it("keeps late provider results ignored after autocomplete is dismissed", async () => {
    const pendingProviders: Array<(suggestions: readonly SuggestionItem<SlashCommandSuggestionMetadata>[]) => void> = [];
    const provider: SuggestionProvider<SlashCommandSuggestionMetadata> = {
      id: SLASH_COMMAND_SUGGESTION_PROVIDER_ID,
      name: "Slash",
      getSuggestions: vi.fn(() => new Promise<SuggestionProviderResult<SlashCommandSuggestionMetadata>>((resolve) => {
        pendingProviders.push((suggestions) => {
          resolve(normalizeSuggestionProviderResult<SlashCommandSuggestionMetadata>(SLASH_COMMAND_SUGGESTION_PROVIDER_ID, { suggestions }));
        });
      })),
    };
    const typeahead = fakeTypeahead(provider);
    const input = new FakeInput();
    const output = fakeOutput();
    const lifecycle = fakeLifecycle();
    const states: TypeaheadState[] = [];
    const controller = new RawPromptController({
      input,
      output,
      lifecycle: lifecycle.lifecycle,
      typeahead: {
        router: typeahead.router,
        onStateChange: (state) => states.push(state),
      },
    });
    const pending = controller.read("> ");

    input.send("/h");
    input.send("\x1b");
    await flushKeypressTimers();
    pendingProviders[0]?.([slashSuggestion]);
    await flushPromises();
    input.send("\r");

    expect(await pending).toEqual({ type: "submit", text: "/h" });
    expect(states.filter((state) => state.status === "open")).toEqual([]);
    expect(output.writes.join("")).not.toContain("> /help - Show help");
    expect(output.writes.join("")).not.toMatch(forbiddenManagedRegionOutput);
  });

  it("keeps Ctrl-C as prompt cancel even when autocomplete is open", async () => {
    const provider = providerFor(SLASH_COMMAND_SUGGESTION_PROVIDER_ID, [slashSuggestion]);
    const typeahead = fakeTypeahead(provider);
    const input = new FakeInput();
    const output = fakeOutput();
    const lifecycle = fakeLifecycle();
    const controller = new RawPromptController({
      input,
      output,
      lifecycle: lifecycle.lifecycle,
      typeahead: {
        router: typeahead.router,
      },
    });
    const pending = controller.read("> ");

    input.send("/h");
    await flushPromises();
    input.send("\x03");

    expect(await pending).toEqual({ type: "cancel" });
  });

  it("moves slash autocomplete focus with Up and Down and redraws focused row", async () => {
    const provider = providerFor(SLASH_COMMAND_SUGGESTION_PROVIDER_ID, [slashSuggestion, statusSlashSuggestion]);
    const typeahead = fakeTypeahead(provider);
    const input = new FakeInput();
    const output = fakeOutput();
    const lifecycle = fakeLifecycle();
    const states: TypeaheadState[] = [];
    const controller = new RawPromptController({
      input,
      output,
      lifecycle: lifecycle.lifecycle,
      typeahead: {
        router: typeahead.router,
        onStateChange: (state) => states.push(state),
      },
    });
    const pending = controller.read("> ");

    input.send("/h");
    await flushPromises();
    expect(output.writes.join("")).toContain("> /help - Show help");

    input.send("\x1b[B");
    expect(states.at(-1)?.focusedIndex).toBe(1);
    expect(output.writes.join("")).toContain("> /status - Show status");

    input.send("\x1b[A");
    expect(states.at(-1)?.focusedIndex).toBe(0);
    input.send("\r");
    input.send("\r");

    expect(await pending).toEqual({ type: "submit", text: "/help" });
    expect(output.writes.join("")).not.toMatch(forbiddenManagedRegionOutput);
  });

  it("moves slash autocomplete focus with Ctrl-N and Ctrl-P without touching history", async () => {
    const provider = providerFor(SLASH_COMMAND_SUGGESTION_PROVIDER_ID, [slashSuggestion, statusSlashSuggestion]);
    const typeahead = fakeTypeahead(provider);
    const input = new FakeInput();
    const output = fakeOutput();
    const lifecycle = fakeLifecycle();
    const states: TypeaheadState[] = [];
    const controller = new RawPromptController({
      input,
      output,
      lifecycle: lifecycle.lifecycle,
      typeahead: {
        router: typeahead.router,
        onStateChange: (state) => states.push(state),
      },
    });
    const pending = controller.read("> ");

    input.send("/h");
    await flushPromises();
    input.send("\x0e");

    expect(states.at(-1)?.focusedIndex).toBe(1);
    expect(output.writes.join("")).toContain("> /status - Show status");

    input.send("\x10");
    expect(states.at(-1)?.focusedIndex).toBe(0);
    input.send("\r");
    input.send("\r");

    expect(await pending).toEqual({ type: "submit", text: "/help" });
    expect(output.writes.join("")).not.toMatch(forbiddenManagedRegionOutput);
  });

  it("lets slash autocomplete consume Escape before Vim mode handling", async () => {
    const provider = providerFor(SLASH_COMMAND_SUGGESTION_PROVIDER_ID, [slashSuggestion]);
    const typeahead = fakeTypeahead(provider);
    const input = new FakeInput();
    const output = fakeOutput();
    const lifecycle = fakeLifecycle();
    const states: TypeaheadState[] = [];
    const controller = new RawPromptController({
      input,
      output,
      lifecycle: lifecycle.lifecycle,
      keymap: { mode: "vim" },
      typeahead: {
        router: typeahead.router,
        onStateChange: (state) => states.push(state),
      },
    });
    const pending = controller.read("> ");

    input.send("/h");
    await flushPromises();
    input.send("\x1b");
    await flushKeypressTimers();

    expect(states.at(-1)?.status).toBe("dismissed");
    input.send("\r");

    expect(await pending).toEqual({ type: "submit", text: "/h" });
    expect(output.writes.join("")).not.toMatch(forbiddenManagedRegionOutput);
  });

  it("does not trigger the slash provider for non-slash input", async () => {
    const provider = providerFor(SLASH_COMMAND_SUGGESTION_PROVIDER_ID, [slashSuggestion]);
    const typeahead = fakeTypeahead(provider);
    const input = new FakeInput();
    const output = fakeOutput();
    const lifecycle = fakeLifecycle();
    const controller = new RawPromptController({
      input,
      output,
      lifecycle: lifecycle.lifecycle,
      typeahead: {
        router: typeahead.router,
      },
    });
    const pending = controller.read("> ");

    input.send("hello\r");

    expect(await pending).toEqual({ type: "submit", text: "hello" });
    expect(provider.getSuggestions).not.toHaveBeenCalled();
    expect(output.writes.join("")).not.toContain("/help");
  });

  it("ignores stale async typeahead results after input changes", async () => {
    const pendingProviders: Array<(suggestions: readonly SuggestionItem<SlashCommandSuggestionMetadata>[]) => void> = [];
    const provider: SuggestionProvider<SlashCommandSuggestionMetadata> = {
      id: SLASH_COMMAND_SUGGESTION_PROVIDER_ID,
      name: "Slash",
      getSuggestions: vi.fn(() => new Promise<SuggestionProviderResult<SlashCommandSuggestionMetadata>>((resolve) => {
        pendingProviders.push((suggestions) => {
          resolve(normalizeSuggestionProviderResult<SlashCommandSuggestionMetadata>(SLASH_COMMAND_SUGGESTION_PROVIDER_ID, { suggestions }));
        });
      })),
    };
    const typeahead = fakeTypeahead(provider);
    const input = new FakeInput();
    const output = fakeOutput();
    const lifecycle = fakeLifecycle();
    const states: TypeaheadState[] = [];
    const controller = new RawPromptController({
      input,
      output,
      lifecycle: lifecycle.lifecycle,
      typeahead: {
        router: typeahead.router,
        onStateChange: (state) => states.push(state),
      },
    });
    const prompt = controller.read("> ");

    input.send("/h");
    input.send("\x7f\x7fabc");
    for (const resolve of pendingProviders) resolve([slashSuggestion]);
    await flushPromises();
    input.send("\r");

    expect(await prompt).toEqual({ type: "submit", text: "abc" });
    expect(states.at(-2)?.status).not.toBe("open");
    expect(states.filter((state) => state.status === "open")).toEqual([]);
  });

  it("represents provider errors as data without crashing the prompt", async () => {
    const provider: SuggestionProvider<SlashCommandSuggestionMetadata> = {
      id: SLASH_COMMAND_SUGGESTION_PROVIDER_ID,
      name: "Slash",
      getSuggestions: vi.fn(() => {
        throw new Error("provider failed");
      }),
    };
    const typeahead = fakeTypeahead(provider);
    const input = new FakeInput();
    const output = fakeOutput();
    const lifecycle = fakeLifecycle();
    const states: TypeaheadState[] = [];
    const controller = new RawPromptController({
      input,
      output,
      lifecycle: lifecycle.lifecycle,
      typeahead: {
        router: typeahead.router,
        onStateChange: (state) => states.push(state),
      },
    });
    const prompt = controller.read("> ");

    input.send("/h");
    await flushPromises();
    input.send("\r");

    expect(await prompt).toEqual({ type: "submit", text: "/h" });
    expect(states.some((state) => state.status === "error" && state.error?.message === "provider failed")).toBe(true);
    expect(output.writes.join("")).toContain("Slash suggestions unavailable: provider failed");
  });
});

function promptTaskCard(): TaskCardState {
  return {
    taskId: "T-raw-1",
    objective: "Retained Task card",
    status: "completed",
    executionPreference: "auto",
    execution: "waiting",
    foregroundOwnerActive: false,
    backgroundContinuation: "available",
    progress: { completed: 1, skipped: 0, total: 1 },
    planRevision: { revision: 1, status: "active" },
    steps: [{
      stepId: "step-1",
      position: 0,
      title: "Finish work",
      objective: "Finish work",
      executorRole: "worker",
      status: "completed",
      dependsOn: [],
      childTaskPolicy: "forbid",
      usage: { providerCalls: 1, totalTokens: 10, estimatedCostUsd: 0.001, usageComplete: true, pricingComplete: true },
      attempts: []
    }],
    subagents: [],
    trace: { events: [], hasEarlierEvents: false },
    childTasks: [],
    recentActivity: [{ eventId: "event-completed", kind: "attempt-completed", label: "Attempt completed", category: "finish", timestamp: "2026-07-20T10:00:00.000Z" }],
    elapsedMs: 1_000,
    usage: {
      providerCalls: 1,
      totalTokens: 10,
      estimatedCostUsd: 0.001,
      usageComplete: true,
      pricingComplete: true,
    },
    results: [],
    createdAt: "2026-07-20T09:59:59.000Z",
    updatedAt: "2026-07-20T10:00:00.000Z",
  };
}

function promptTaskCardWithTrace(labels: readonly string[]): TaskCardState {
  const card = promptTaskCard();
  return {
    ...card,
    status: "running",
    trace: {
      events: labels.map((label, index) => ({
        eventId: `event-${index}`,
        kind: "attempt-progressed",
        label,
        category: index % 2 === 0 ? "read" : "answer",
        timestamp: `2026-07-20T10:00:0${index}.000Z`,
      })),
      hasEarlierEvents: false,
    },
  };
}

function promptTaskCardWithSubagentTrace(
  labels: readonly string[],
  currentActivity = "Reading the first file"
): TaskCardState {
  const card = promptTaskCardWithTrace(labels);
  const trace = labels.map((label, index) => ({
    eventId: `subagent-event-${index}`,
    kind: "attempt-progressed",
    label,
    category: index % 2 === 0 ? "read" as const : "answer" as const,
    timestamp: `2026-07-20T10:00:0${index}.000Z`,
    stepId: "step-1",
    attemptId: "attempt-1",
    subagentIndex: 1,
  }));
  return {
    ...card,
    subagents: [{
      stepId: "step-1",
      position: 0,
      displayIndex: 1,
      displayLabel: "Subagent 1",
      title: "Finish work",
      objective: "Finish work",
      role: "worker",
      status: "running",
      dependsOn: [],
      elapsedMs: 2_000,
      currentActivity,
      currentToolCategory: "read",
      usage: { total: card.usage, currentAttempt: card.usage },
      attempts: [],
      trace,
      results: [],
    }],
  };
}

function promptApprovalCard(): ApprovalCardState {
  return {
    id: "approval-raw-1",
    status: "pending",
    action: "Write file",
    target: "write the reviewed artifact",
    risk: "workspace-write",
    summary: "Task task-raw-1 · approve once only"
  };
}

function providerFor(
  id: string,
  suggestions: readonly SuggestionItem<SlashCommandSuggestionMetadata>[]
): SuggestionProvider<SlashCommandSuggestionMetadata> {
  return {
    id,
    name: id,
    getSuggestions: vi.fn((context) => normalizeSuggestionProviderResult(id, {
      suggestions: suggestions.map((suggestion) => ({
        ...suggestion,
        replacementRange: context.tokenRange,
      })),
    })),
  };
}

function fakeTypeahead(provider: SuggestionProvider<SlashCommandSuggestionMetadata>): {
  readonly router: TypeaheadProviderRouter<SlashCommandSuggestionMetadata>;
  readonly route: ReturnType<typeof vi.fn>;
} {
  const route = vi.fn((input: { readonly input: string; readonly cursorOffset: number }) => {
    const start = input.input.lastIndexOf("/", input.cursorOffset);
    if (start === -1) return undefined;
    const beforeSlash = input.input[start - 1];
    if (beforeSlash !== undefined && !/\s/u.test(beforeSlash)) return undefined;
    let end = start;
    while (end < input.input.length && !/\s/u.test(input.input[end]!)) end += 1;
    if (input.cursorOffset < start || input.cursorOffset > end) return undefined;
    const context = createSuggestionTokenContext({
      input: input.input,
      cursorOffset: input.cursorOffset,
      tokenRange: { start, end },
      triggerKind: "slash",
    });
    return {
      triggerKind: "slash",
      context,
      provider,
    } satisfies TypeaheadProviderSelection<SlashCommandSuggestionMetadata>;
  });
  return {
    router: { route },
    route,
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function flushKeypressTimers(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 60));
  await flushPromises();
}

function countOccurrences(value: string, needle: string): number {
  if (needle.length === 0) return 0;
  return value.split(needle).length - 1;
}
