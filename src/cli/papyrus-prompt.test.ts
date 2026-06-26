import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { GHOST_TEXT_ENV_VAR } from "./ghost-text-mode.js";
import { INPUT_KEYMAP_MODE_ENV_VAR } from "./input-keymap-mode.js";
import { createPapyrusPrompt, createPapyrusSecretPrompt } from "./papyrus-prompt.js";
import {
  createRawPrompt,
  type RawPromptControllerOptions,
  type RawPromptInput,
  type RawPromptOutput,
} from "./rawPromptController.js";
import type { Prompt, PromptOptions } from "./prompt-contract.js";
import type { TerminalLifecycle } from "../ui/input/terminalLifecycle.js";
import { promptUiContextForLocale } from "../contracts/ui.js";
import { SLASH_COMMAND_SUGGESTION_PROVIDER_ID } from "../ui/papyrus/input/providers/slashCommandProvider.js";

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

  it("preserves Alt+Enter multiline input through the raw prompt path", async () => {
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
    input.send("hello\x1b\rworld\r");

    await expect(pending).resolves.toBe("hello\nworld");
    expect(lifecycle.calls).toEqual(["start", "stop"]);
  });

  it("routes secret input through the Papyrus-native no-echo path without paste previews", async () => {
    const input = new FakeInput();
    const output = fakeOutput();
    const pastePreview = vi.fn();
    const onInputChange = vi.fn();
    const prompt = createPapyrusPrompt({
      input,
      output,
      createRaw: () => Object.assign(vi.fn(async () => "raw"), { close: vi.fn() }),
    });

    const pending = prompt("Secret: ", {
      secret: true,
      onPastePreview: pastePreview,
      onInputChange,
      onRowsChange: vi.fn(),
    });
    input.send("\x1b[200~top-secret\x1b[201~");
    input.send("\r");

    await expect(pending).resolves.toBe("top-secret");
    expect(pastePreview).not.toHaveBeenCalled();
    expect(onInputChange).not.toHaveBeenCalled();
    expect(output.writes.join("")).not.toContain("top-secret");
    expect(output.writes.join("")).toContain("**********");
  });

  it("clears Papyrus-native secret input on cancel", async () => {
    const input = new FakeInput();
    const output = fakeOutput();
    const prompt = createPapyrusPrompt({
      input,
      output,
      createRaw: () => Object.assign(vi.fn(async () => "raw"), { close: vi.fn() }),
    });

    const canceled = prompt("Secret: ", { secret: true });
    input.send("cancel-secret");
    input.send("\x1b");

    await expect(canceled).resolves.toBe("/exit");
    expect(output.writes.join("")).not.toContain("cancel-secret");

    const submitted = prompt("Secret: ", { secret: true });
    input.send("\r");
    await expect(submitted).resolves.toBe("");
  });

  it("runs Papyrus-native secret cleanup when startup errors", async () => {
    const input = new FakeInput();
    const output = fakeOutput();
    const error = new Error("secret start failed");
    const lifecycle = fakeLifecycle({
      start: vi.fn(() => {
        lifecycle.calls.push("start");
        throw error;
      }),
    });
    const prompt = createPapyrusPrompt({
      input,
      output,
      createRaw: () => Object.assign(vi.fn(async () => "raw"), { close: vi.fn() }),
      createSecretPrompt: (options) => createPapyrusSecretPrompt({ ...options, lifecycle: lifecycle.lifecycle }),
    });

    await expect(prompt("Secret: ", { secret: true })).rejects.toThrow("secret start failed");
    expect(lifecycle.calls).toEqual(["start", "stop"]);
    expect(output.writes.join("")).not.toContain("secret");
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

  it("provides Papyrus slash autocomplete to the raw prompt path by default", async () => {
    let rawOptions: RawPromptControllerOptions | undefined;
    const prompt = createPapyrusPrompt({
      input: new FakeInput(),
      output: fakeOutput(),
      createRaw: (options) => {
        rawOptions = options;
        return Object.assign(vi.fn(async () => "raw"), { close: vi.fn() });
      },
      createSecretPrompt: () => fakeSecretPrompt().prompt,
    });

    await prompt("> ");
    const routed = rawOptions?.typeahead?.router.route({
      input: "/",
      cursorOffset: 1,
    });

    expect(routed?.provider.id).toBe(SLASH_COMMAND_SUGGESTION_PROVIDER_ID);
    expect(rawOptions?.ghostText).toBeUndefined();
    expect(rawOptions?.keymap).toBeUndefined();
  });

  it("keeps optional providers out of the default raw slash autocomplete path", async () => {
    let rawOptions: RawPromptControllerOptions | undefined;
    const prompt = createPapyrusPrompt({
      input: new FakeInput(),
      output: fakeOutput(),
      env: {
        ESTACODA_SHELL_HISTORY: "1",
        ESTACODA_MCP_SUGGESTIONS: "1",
        ESTACODA_SKILL_SUGGESTIONS: "1",
      },
      createRaw: (options) => {
        rawOptions = options;
        return Object.assign(vi.fn(async () => "raw"), { close: vi.fn() });
      },
      createSecretPrompt: () => fakeSecretPrompt().prompt,
    });

    await prompt("> ");
    const routed = rawOptions?.typeahead?.router.route({
      input: "/",
      cursorOffset: 1,
    });

    expect(routed?.provider.id).toBe(SLASH_COMMAND_SUGGESTION_PROVIDER_ID);
  });

  it("passes ghost text options to the raw prompt only when the flag is on", async () => {
    const rawOptions: RawPromptControllerOptions[] = [];
    const createRaw = vi.fn((options: RawPromptControllerOptions) => {
      rawOptions.push(options);
      return Object.assign(vi.fn(async () => "raw"), { close: vi.fn() });
    });

    await createPapyrusPrompt({
      input: new FakeInput(),
      output: fakeOutput(),
      env: {},
      createRaw,
      createSecretPrompt: () => fakeSecretPrompt().prompt,
    })("> ");
    await createPapyrusPrompt({
      input: new FakeInput(),
      output: fakeOutput(),
      env: { [GHOST_TEXT_ENV_VAR]: "true" },
      createRaw,
      createSecretPrompt: () => fakeSecretPrompt().prompt,
    })("> ");

    expect(rawOptions[0]?.ghostText).toBeUndefined();
    expect(rawOptions[1]?.ghostText).toEqual({ enabled: true });
  });

  it("passes Vim keymap options to raw prompt only when explicitly selected", async () => {
    const rawOptions: RawPromptControllerOptions[] = [];
    const createRaw = vi.fn((options: RawPromptControllerOptions) => {
      rawOptions.push(options);
      return Object.assign(vi.fn(async () => "raw"), { close: vi.fn() });
    });

    await createPapyrusPrompt({
      input: new FakeInput(),
      output: fakeOutput(),
      env: {},
      createRaw,
      createSecretPrompt: () => fakeSecretPrompt().prompt,
    })("> ");
    await createPapyrusPrompt({
      input: new FakeInput(),
      output: fakeOutput(),
      env: { [INPUT_KEYMAP_MODE_ENV_VAR]: "invalid" },
      createRaw,
      createSecretPrompt: () => fakeSecretPrompt().prompt,
    })("> ");
    await createPapyrusPrompt({
      input: new FakeInput(),
      output: fakeOutput(),
      env: { [INPUT_KEYMAP_MODE_ENV_VAR]: "vim" },
      createRaw,
      createSecretPrompt: () => fakeSecretPrompt().prompt,
    })("> ");

    expect(rawOptions[0]?.keymap).toBeUndefined();
    expect(rawOptions[1]?.keymap).toBeUndefined();
    expect(rawOptions[2]?.keymap).toEqual({ mode: "vim" });
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
    expect(prompt.select).toEqual(expect.any(Function));
    expect(prompt.onboardingCard).toEqual(expect.any(Function));

    prompt.close?.();
    expect(rawClose).toHaveBeenCalledOnce();
    expect(secret.prompt.close).toHaveBeenCalledOnce();
  });
});
