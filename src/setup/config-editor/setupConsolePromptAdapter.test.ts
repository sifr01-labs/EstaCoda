import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SelectPromptInput } from "../../cli/interactive-select.js";
import type { Prompt } from "../../cli/prompt-contract.js";
import {
  SetupConsoleExitError,
  preserveSetupConsoleOnPromptClose,
  setupConsoleControllerForPrompt,
  withSetupConsolePrompt,
} from "./setupConsolePromptAdapter.js";
import { createSetupOperatorConsoleController } from "./setupOperatorConsoleController.js";

const forbiddenManagedRegionOutput = /\x1b\[3J|\x1b\[2J|\x1b\[H|\x1b\[\d+;\d+H/u;

describe("withSetupConsolePrompt", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("intercepts setup prompt-card selects on TTY and returns the selected value", async () => {
    const input = createInput();
    const output = createOutput();
    const { select: baseSelect, calls: baseSelectCalls } = createSelect("base");
    const prompt = createPrompt({ select: baseSelect });
    const wrapped = withSetupConsolePrompt(prompt, { input, output });

    const pending = wrapped.select!(setupSelection());
    await Promise.resolve();
    input.write("\x1b[B\r");
    const result = await pending;
    const text = stripAnsi(output.text());

    expect(result).toBe("browser");
    expect(baseSelectCalls).not.toHaveBeenCalled();
    expect(text).toContain("Setup Editor");
    expect(text).toContain("Browser");
    expect(text).not.toContain("Selected:");
    expect(output.text()).toContain("\x1b[?25l");
    expect(output.text()).toContain("\x1b[?25h");
    expect(input.rawModes).toEqual([true, false]);
    expect(output.text()).not.toMatch(forbiddenManagedRegionOutput);
  });

  it("clears the active setup panel between consecutive setup selects", async () => {
    const input = createInput();
    const output = createOutput();
    const controller = createSetupOperatorConsoleController({ output });
    const clear = vi.spyOn(controller, "clear");
    const { select: baseSelect, calls: baseSelectCalls } = createSelect("base");
    const prompt = createPrompt({ select: baseSelect });
    const wrapped = withSetupConsolePrompt(prompt, { input, output, controller });

    const provider = wrapped.select!(setupSelection());
    await Promise.resolve();
    input.write("\r");
    await expect(provider).resolves.toBe("primary");

    const model = wrapped.select!({
      ...setupSelection(),
      title: "Select Model",
      options: [
        { id: "kimi", label: "kimi-k2.6", description: "tools · vision", value: "kimi" },
        { id: "cancel", label: "Cancel", description: "Keep current model", value: "cancel", group: "navigation" },
      ],
    });
    await Promise.resolve();
    input.write("\r");
    await expect(model).resolves.toBe("kimi");

    expect(baseSelectCalls).not.toHaveBeenCalled();
    expect(clear).toHaveBeenCalledTimes(2);
    expect(stripAnsi(output.text())).not.toContain("Selected:");
    expect(output.text()).not.toMatch(forbiddenManagedRegionOutput);
  });

  it("leaves non-setup prompt selects on the base prompt", async () => {
    const input = createInput();
    const output = createOutput();
    const { select: baseSelect, calls: baseSelectCalls } = createSelect("plain");
    const prompt = createPrompt({ select: baseSelect });
    const wrapped = withSetupConsolePrompt(prompt, { input, output });
    const selection = {
      ...setupSelection(),
      surface: undefined,
    };

    await expect(wrapped.select!(selection)).resolves.toBe("plain");

    expect(baseSelectCalls).toHaveBeenCalledWith(selection);
    expect(output.text()).toBe("");
  });

  it("intercepts setup prompt-card choice menus without columns", async () => {
    const input = createInput();
    const output = createOutput();
    const { select: baseSelect, calls: baseSelectCalls } = createSelect("base");
    const prompt = createPrompt({ select: baseSelect });
    const wrapped = withSetupConsolePrompt(prompt, { input, output });

    const pending = wrapped.select!(choiceMenuSelection());
    await Promise.resolve();
    input.write("\x1b[B\r");
    const result = await pending;
    const text = stripAnsi(output.text());

    expect(result).toBe("cancel");
    expect(baseSelectCalls).not.toHaveBeenCalled();
    expect(text).toContain("Finalize Configuration");
    expect(text).toContain("Pending changes: Security");
    expect(text).toContain("Cancel");
    expect(text).not.toContain("Selected:");
  });

  it("routes setup secret input through a masked setup console panel", async () => {
    const input = createInput();
    const output = createOutput();
    const prompt = createPrompt({ select: createSelect("base").select });
    const wrapped = withSetupConsolePrompt(prompt, { input, output });

    const pending = wrapped("Enter API key for OpenAI as OPENAI_API_KEY: ", { secret: true });
    await Promise.resolve();
    input.write("sk-live-setup-console-secret\r");
    const result = await pending;
    const text = stripAnsi(output.text());

    expect(result).toBe("sk-live-setup-console-secret");
    expect(text).toContain("API Key");
    expect(text).toContain("Enter API key for OpenAI as OPENAI_API_KEY");
    expect(text).toContain("Stored as: OPENAI_API_KEY");
    expect(text).toContain("••••••••");
    expect(text).not.toContain("sk-live-setup-console-secret");
    expect(output.text()).toContain("\x1b[?25l");
    expect(output.text()).toContain("\x1b[?25h");
    expect(input.rawModes).toEqual([true, false]);
    expect(output.text()).not.toMatch(forbiddenManagedRegionOutput);
  });

  it("renders Arabic setup secret panel copy while keeping env vars stable", async () => {
    const input = createInput();
    const output = createOutput();
    const prompt = createPrompt({
      select: createSelect("base").select,
      uiContext: { locale: "ar", direction: "rtl" },
    });
    const wrapped = withSetupConsolePrompt(prompt, { input, output });

    const pending = wrapped("أدخل مفتاح API لـ Brave Search as BRAVE_SEARCH_API_KEY: ", { secret: true });
    await Promise.resolve();
    input.write("brave-arabic-secret\r");
    const result = await pending;
    const text = stripAnsi(output.text());

    expect(result).toBe("brave-arabic-secret");
    expect(text).toContain("مفتاح API");
    expect(text).toContain("BRAVE_SEARCH_API_KEY");
    expect(text).toContain("Enter حفظ");
    expect(text).not.toContain("brave-arabic-secret");
  });

  it("returns empty setup secret cancellation without rendering typed secret text", async () => {
    const input = createInput();
    const output = createOutput();
    const prompt = createPrompt({ select: createSelect("base").select });
    const wrapped = withSetupConsolePrompt(prompt, { input, output });

    const pending = wrapped("Enter API key: ", { secret: true });
    await Promise.resolve();
    input.write("cancel-secret\x1b");

    await expect(pending).resolves.toBe("");
    expect(stripAnsi(output.text())).not.toContain("cancel-secret");
    expect(input.rawModes).toEqual([true, false]);
  });

  it("keeps non-TTY setup selects on the existing prompt behavior", async () => {
    const input = createInput({ isTTY: false });
    const output = createOutput();
    const { select: baseSelect, calls: baseSelectCalls } = createSelect("fallback");
    const createController = vi.fn();
    const prompt = createPrompt({ select: baseSelect });
    const wrapped = withSetupConsolePrompt(prompt, { input, output, createController });
    const selection = setupSelection();

    await expect(wrapped.select!(selection)).resolves.toBe("fallback");

    expect(baseSelectCalls).toHaveBeenCalledWith(selection);
    expect(createController).not.toHaveBeenCalled();
    expect(output.text()).toBe("");
  });

  it("keeps non-TTY setup secrets on the existing prompt behavior", async () => {
    const input = createInput({ isTTY: false });
    const output = createOutput();
    const createController = vi.fn();
    const prompt = createPrompt({
      select: createSelect("base").select,
      answer: "base-secret",
    });
    const wrapped = withSetupConsolePrompt(prompt, { input, output, createController });

    await expect(wrapped("Secret: ", { secret: true })).resolves.toBe("base-secret");

    expect(createController).not.toHaveBeenCalled();
    expect(output.text()).toBe("");
  });

  it("routes setup secret submit through a masked setup console panel", async () => {
    const input = createInput();
    const output = createOutput();
    const prompt = createPrompt({
      select: createSelect("base").select,
      submit: vi.fn(async () => ({ text: "base-submit" })),
    });
    const wrapped = withSetupConsolePrompt(prompt, { input, output });

    const pending = wrapped.submit!("Enter API key for OpenAI as OPENAI_API_KEY: ", { secret: true });
    await Promise.resolve();
    input.write("sk-submit-secret\r");

    await expect(pending).resolves.toEqual({ text: "sk-submit-secret" });
    expect(stripAnsi(output.text())).not.toContain("sk-submit-secret");
    expect(stripAnsi(output.text())).toContain("Stored as: OPENAI_API_KEY");
  });

  it("settles Ctrl+C setup-console exit after restoring the terminal", async () => {
    const input = createInput();
    const output = createOutput();
    const controller = createSetupOperatorConsoleController({ output });
    const clear = vi.spyOn(controller, "clear");
    const prompt = createPrompt({ select: createSelect("base").select });
    const wrapped = withSetupConsolePrompt(prompt, { input, output, controller });

    const pending = wrapped.select!(setupSelection());
    await Promise.resolve();
    input.write("\x03");

    await expect(pending).rejects.toBeInstanceOf(SetupConsoleExitError);
    expect(output.text()).toContain("\x1b[?25h");
    expect(clear).toHaveBeenCalled();
    expect(input.rawModes).toEqual([true, false]);
  });

  it("preserves prompt methods and clears setup frames on close", async () => {
    const input = createInput();
    const output = createOutput();
    const controller = createSetupOperatorConsoleController({ output });
    const clear = vi.spyOn(controller, "clear");
    const submit = vi.fn(async () => ({ text: "submitted" }));
    const onboardingCard = vi.fn();
    const close = vi.fn();
    const prompt = createPrompt({
      select: createSelect("base").select,
      submit,
      onboardingCard,
      close,
    });
    const wrapped = withSetupConsolePrompt(prompt, { input, output, controller });

    await expect(wrapped("Question?")).resolves.toBe("answer");
    await expect(wrapped.submit!("Submit?")).resolves.toEqual({ text: "submitted" });
    const onboardingInput = {
      title: "Welcome",
      bodyLines: ["Body"],
      options: [],
      selectedOptionIndex: 0,
    };
    wrapped.onboardingCard?.(onboardingInput);
    const pending = wrapped.select!(setupSelection());
    await Promise.resolve();
    input.write("\r");
    await pending;

    wrapped.close?.();

    expect(submit).toHaveBeenCalledWith("Submit?", undefined);
    expect(onboardingCard).toHaveBeenCalledWith(onboardingInput);
    expect(clear).toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("preserves a final setup console panel on close when marked as terminal output", () => {
    const input = createInput();
    const output = createOutput();
    const controller = createSetupOperatorConsoleController({ output });
    const clear = vi.spyOn(controller, "clear");
    const close = vi.fn();
    const prompt = createPrompt({ select: createSelect("base").select, close });
    const wrapped = withSetupConsolePrompt(prompt, { input, output, controller });
    const exposedController = setupConsoleControllerForPrompt(wrapped);

    exposedController?.render({
      kind: "table",
      layout: "choiceMenu",
      title: "Setup diagnostics",
      description: "Review setup output without applying changes.",
      rows: [
        {
          id: "state",
          provider: "State",
          model: "",
          status: "configured-ready",
          notes: "",
        },
      ],
      footer: "Read-only output",
    });
    preserveSetupConsoleOnPromptClose(wrapped);
    wrapped.close?.();

    expect(exposedController).toBe(controller);
    expect(clear).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(stripAnsi(output.text())).toContain("Setup Diagnostics");
  });
});

function setupSelection(): SelectPromptInput<string> {
  return {
    title: "Setup Editor",
    body: "Choose what to configure:",
    fallbackPrompt: "Choose: ",
    surface: "promptCard",
    columns: [
      { key: "name", header: "Name" },
      { key: "description", header: "Description" },
    ],
    options: [
      {
        id: "primary",
        label: "Primary model",
        description: "Default model used by the agent.",
        value: "primary",
      },
      {
        id: "browser",
        label: "Browser",
        description: "Configure browser control.",
        value: "browser",
      },
    ],
    defaultIndex: 0,
    hint: "↑↓ navigate   ENTER select",
    locale: "en",
    direction: "ltr",
  };
}

function choiceMenuSelection(): SelectPromptInput<string> {
  return {
    title: "Finalize configuration",
    body: "Review the changes before applying.\n",
    fallbackPrompt: "Choose: ",
    surface: "promptCard",
    statusLines: [{ text: "Pending changes: Security", tone: "warning", direction: "ltr" }],
    options: [
      {
        id: "approve",
        label: "Apply changes",
        description: "Write reviewed setup changes.",
        value: "approve",
      },
      {
        id: "cancel",
        label: "Cancel",
        description: "Leave setup unchanged.",
        group: "navigation",
        value: "cancel",
      },
    ],
    defaultIndex: 0,
    hint: "↑↓ navigate   ENTER select",
    locale: "en",
    direction: "ltr",
  };
}

function createPrompt(input: {
  readonly select?: Prompt["select"];
  readonly submit?: Prompt["submit"];
  readonly onboardingCard?: Prompt["onboardingCard"];
  readonly close?: Prompt["close"];
  readonly answer?: string;
  readonly uiContext?: Prompt["uiContext"];
} = {}): Prompt {
  return Object.assign(
    async () => input.answer ?? "answer",
    {
      uiContext: input.uiContext ?? { locale: "en" as const, direction: "ltr" as const },
      ...input,
    }
  );
}

function createSelect(value: string): {
  readonly select: NonNullable<Prompt["select"]>;
  readonly calls: ReturnType<typeof vi.fn>;
} {
  const calls = vi.fn();
  return {
    calls,
    select: async <T>(selection: SelectPromptInput<T>): Promise<T> => {
      calls(selection);
      return value as T;
    },
  };
}

function createInput(options: { readonly isTTY?: boolean } = {}): PassThrough & {
  isTTY: boolean;
  isRaw: boolean;
  rawModes: boolean[];
  setRawMode(mode: boolean): void;
} {
  const input = new PassThrough() as PassThrough & {
    isTTY: boolean;
    isRaw: boolean;
    rawModes: boolean[];
    setRawMode(mode: boolean): void;
  };
  input.isTTY = options.isTTY ?? true;
  input.isRaw = false;
  input.rawModes = [];
  input.setRawMode = (mode: boolean) => {
    input.isRaw = mode;
    input.rawModes.push(mode);
  };
  return input;
}

function createOutput(): Writable & {
  readonly columns: number;
  readonly rows: number;
  readonly isTTY: boolean;
  text(): string;
  clear(): void;
} {
  const writes: string[] = [];
  return new class extends Writable {
    readonly columns = 72;
    readonly rows = 16;
    readonly isTTY = true;

    _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
      writes.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      callback();
    }

    text(): string {
      return writes.join("");
    }

    clear(): void {
      writes.length = 0;
    }
  }();
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/gu, "");
}
