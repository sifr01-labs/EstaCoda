import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createPromptForInputMode, createRawPrompt, RawPromptController, type RawPromptInput, type RawPromptOutput } from "./rawPromptController.js";
import type { TerminalLifecycle } from "../ui/input/terminalLifecycle.js";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

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
  const lifecycle: TerminalLifecycle = {
    start: vi.fn(() => {
      calls.push("start");
      started = true;
    }),
    stop: vi.fn(() => {
      calls.push("stop");
      started = false;
      return { errors: [] };
    }),
    isStarted: vi.fn(() => started),
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

describe("raw prompt controller", () => {
  it("does not construct a raw controller in readline mode", async () => {
    const input = new FakeInput();
    const output = fakeOutput();
    const readlinePrompt = Object.assign(vi.fn(async () => "legacy"), { close: vi.fn() });
    const createReadline = vi.fn(() => readlinePrompt);
    const createRaw = vi.fn(() => Object.assign(vi.fn(async () => "raw"), { close: vi.fn() }));

    const prompt = createPromptForInputMode({
      mode: "readline",
      input,
      output,
      createReadline,
      createRaw,
    });

    expect(await prompt("> ")).toBe("legacy");
    expect(createReadline).toHaveBeenCalledOnce();
    expect(createRaw).not.toHaveBeenCalled();
  });

  it("constructs and uses the raw prompt in raw mode", async () => {
    const input = new FakeInput();
    const output = fakeOutput();
    const rawPrompt = Object.assign(vi.fn(async () => "raw"), { close: vi.fn() });
    const createReadline = vi.fn(() => Object.assign(vi.fn(async () => "legacy"), { close: vi.fn() }));
    const createRaw = vi.fn(() => rawPrompt);

    const prompt = createPromptForInputMode({
      mode: "raw",
      input,
      output,
      createReadline,
      createRaw,
    });

    expect(await prompt("> ")).toBe("raw");
    expect(createRaw).toHaveBeenCalledOnce();
    expect(createReadline).not.toHaveBeenCalled();
  });

  it("submits ASCII text", async () => {
    const { result, output, lifecycle } = await readWithFakeInput("hello\r");

    expect(result).toEqual({ type: "submit", text: "hello" });
    expect(output.writes).toEqual(["> ", "\n"]);
    expect(lifecycle.calls).toEqual(["start", "stop"]);
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

  it("applies backspace and delete edits before submit", async () => {
    expect((await readWithFakeInput("abc\x7f\r")).result).toEqual({ type: "submit", text: "ab" });
    expect((await readWithFakeInput("abc\x1b[D\x1b[3~\r")).result).toEqual({ type: "submit", text: "ab" });
  });

  it("inserts bracketed paste without submitting until enter", async () => {
    const read = startPendingRead();

    read.input.send(`${PASTE_START}line one\nline two${PASTE_END}`);
    await Promise.resolve();
    expect(read.isResolved()).toBe(false);

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

  it("treats Up and Down history keys as safe no-ops for now", async () => {
    const { result } = await readWithFakeInput("draft\x1b[A\x1b[B\r");

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
});
