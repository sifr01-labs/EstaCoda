import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createPapyrusPrompt } from "./papyrus-prompt.js";
import { createRawPrompt, type RawPromptInput, type RawPromptOutput } from "./rawPromptController.js";
import type { Prompt, PromptOptions } from "./prompt-contract.js";
import type { TerminalLifecycle } from "../ui/input/terminalLifecycle.js";
import { promptUiContextForLocale } from "../contracts/ui.js";

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

function fakeSecretPrompt(answer = "secret-value") {
  const calls: Array<{ question: string; options?: PromptOptions }> = [];
  const prompt = Object.assign(
    vi.fn(async (question: string, options?: PromptOptions) => {
      calls.push({ question, options });
      return answer;
    }),
    {
      select: vi.fn(),
      onboardingCard: vi.fn(),
      close: vi.fn(),
    }
  ) as Prompt & {
    readonly select: ReturnType<typeof vi.fn>;
    readonly onboardingCard: ReturnType<typeof vi.fn>;
    readonly close: ReturnType<typeof vi.fn>;
  };
  return { prompt, calls };
}

describe("createPapyrusPrompt", () => {
  it("uses the raw prompt path for plain text answers", async () => {
    const input = new FakeInput();
    const output = fakeOutput();
    const lifecycle = fakeLifecycle();
    const prompt = createPapyrusPrompt({
      input,
      output,
      createRaw: (options) => createRawPrompt({ ...options, lifecycle: lifecycle.lifecycle }),
      createSecretPrompt: () => fakeSecretPrompt().prompt,
    });

    const pending = prompt("> ");
    input.send("hello\r");

    await expect(pending).resolves.toBe("hello");
    expect(output.writes.join("")).toContain("> hello");
    expect(lifecycle.calls).toEqual(["start", "stop"]);
  });

  it("supports yes/no confirmation questions as plain prompt answers", async () => {
    const input = new FakeInput();
    const output = fakeOutput();
    const prompt = createPapyrusPrompt({ input, output });

    const pending = prompt("Continue? [y/N] ");
    input.send("y\r");

    await expect(pending).resolves.toBe("y");
  });

  it("routes secret input through the no-echo legacy secret path without paste previews", async () => {
    const input = new FakeInput();
    const output = fakeOutput();
    const secret = fakeSecretPrompt("top-secret");
    const pastePreview = vi.fn();
    const prompt = createPapyrusPrompt({
      input,
      output,
      createRaw: () => Object.assign(vi.fn(async () => "raw"), { close: vi.fn() }),
      createSecretPrompt: () => secret.prompt,
    });

    await expect(prompt("Secret: ", {
      secret: true,
      onPastePreview: pastePreview,
      onInputChange: vi.fn(),
      onRowsChange: vi.fn(),
    })).resolves.toBe("top-secret");

    expect(secret.calls).toEqual([{ question: "Secret: ", options: { secret: true } }]);
    expect(pastePreview).not.toHaveBeenCalled();
    expect(output.writes.join("")).not.toContain("top-secret");
  });

  it("passes input and row callbacks to the raw prompt path", async () => {
    const input = new FakeInput();
    const output = fakeOutput();
    const seenInput: string[] = [];
    const seenRows: number[] = [];
    const prompt = createPapyrusPrompt({ input, output });

    const pending = prompt("> ", {
      onInputChange: (line) => seenInput.push(line),
      onRowsChange: (rows) => seenRows.push(rows),
    });
    input.send("a");
    input.send("b");
    input.send("\r");

    await expect(pending).resolves.toBe("ab");
    expect(seenInput).toEqual(["a", "ab"]);
    expect(seenRows.length).toBeGreaterThan(0);
    expect(seenRows.at(-1)).toBe(1);
  });

  it("runs raw prompt cleanup on cancel", async () => {
    const input = new FakeInput();
    const output = fakeOutput();
    const lifecycle = fakeLifecycle();
    const prompt = createPapyrusPrompt({
      input,
      output,
      createRaw: (options) => createRawPrompt({ ...options, lifecycle: lifecycle.lifecycle }),
    });

    const pending = prompt("> ");
    input.send("\x03");

    await expect(pending).resolves.toBe("/exit");
    expect(lifecycle.calls).toEqual(["start", "stop"]);
  });

  it("runs raw prompt cleanup when startup errors", async () => {
    const input = new FakeInput();
    const output = fakeOutput();
    const error = new Error("raw start failed");
    const lifecycle = fakeLifecycle({
      start: vi.fn(() => {
        lifecycle.calls.push("start");
        throw error;
      }),
    });
    const prompt = createPapyrusPrompt({
      input,
      output,
      createRaw: (options) => createRawPrompt({ ...options, lifecycle: lifecycle.lifecycle }),
    });

    await expect(prompt("> ")).rejects.toThrow("raw start failed");
    expect(lifecycle.calls).toEqual(["start", "stop"]);
  });

  it("exposes prompt UI context and closes both raw and secret prompt delegates", () => {
    const rawClose = vi.fn();
    const secret = fakeSecretPrompt();
    const uiContext = promptUiContextForLocale("ar");
    const prompt = createPapyrusPrompt({
      uiContext,
      createRaw: () => Object.assign(vi.fn(async () => "raw"), { close: rawClose }),
      createSecretPrompt: () => secret.prompt,
    });

    expect(prompt.uiContext).toEqual(uiContext);
    expect(prompt.select).toBe(secret.prompt.select);
    expect(prompt.onboardingCard).toBe(secret.prompt.onboardingCard);

    prompt.close?.();
    expect(rawClose).toHaveBeenCalledOnce();
    expect(secret.prompt.close).toHaveBeenCalledOnce();
  });
});
