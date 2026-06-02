import { createInterface as createCallbackInterface } from "node:readline";
import { createInterface as createPromptInterface } from "node:readline/promises";
import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import type { Readable, Writable } from "node:stream";
import { PasteInterceptor, disableBracketedPaste, enableBracketedPaste, type PasteReferenceStore } from "./paste-interceptor.js";
import { buildOnboardingPromptCardViewModel, type BuildOnboardingPromptCardInput } from "../ui/view-models/builders.js";
import { selectOption, type SelectPromptInput } from "./interactive-select.js";
import { createSessionRenderer } from "./session-renderer.js";
import { measureVisibleWidth } from "../ui/renderers/layout.js";
import {
  promptUiContextForLocale,
  type PromptUiContext,
} from "../contracts/ui.js";

export type PromptOptions = {
  secret?: boolean;
  onRowsChange?: (rows: number) => void;
  onPastePreview?: (original: string, displayed: string) => void;
  onInputChange?: (line: string) => void;
  specialKeyController?: PromptSpecialKeyController;
  placeholder?: string;
  pasteReferenceStore?: PasteReferenceStore;
  pasteReferenceThresholdChars?: number;
};

export type PromptSpecialKey = "up" | "down" | "tab" | "escape";

export type PromptSpecialKeyControl = {
  getInputLine(): string;
  setInputLine(nextLine: string): void;
};

export type PromptSpecialKeyController = {
  shouldHandleSpecialKey(): boolean;
  onSpecialKey(
    key: PromptSpecialKey,
    control: PromptSpecialKeyControl
  ): "handled" | undefined;
};

export type Prompt = ((question: string, options?: PromptOptions) => Promise<string>) & {
  uiContext?: PromptUiContext;
  select?: <T>(input: SelectPromptInput<T>) => Promise<T>;
  onboardingCard?: (input: BuildOnboardingPromptCardInput) => Promise<void> | void;
  close?: () => void;
};

export type CreateReadlinePromptOptions = {
  readonly input?: Readable;
  readonly output?: Writable;
  readonly uiContext?: PromptUiContext;
};

export function createReadlinePrompt(options?: CreateReadlinePromptOptions): Prompt;
export function createReadlinePrompt(input?: Readable, output?: Writable): Prompt;
export function createReadlinePrompt(
  inputOrOptions: Readable | CreateReadlinePromptOptions = defaultInput,
  outputArg: Writable = defaultOutput
): Prompt {
  const options = isCreateReadlinePromptOptions(inputOrOptions)
    ? inputOrOptions
    : { input: inputOrOptions, output: outputArg };
  const input = options.input ?? defaultInput;
  const output = options.output ?? defaultOutput;
  const uiContext = options.uiContext ?? promptUiContextForLocale("en");

  return Object.assign(
    async (question: string, options?: PromptOptions) => {
      if (options?.secret === true) {
        return hiddenQuestion(input, output, question);
      }
      return plainQuestion(input, output, question, options);
    },
    {
      uiContext,
      select: async <T>(selection: SelectPromptInput<T>) => selectOption(input, output, applyPromptUiContext(selection, uiContext)),
      onboardingCard: (card: BuildOnboardingPromptCardInput) => {
        const contextualCard = applyPromptUiContext(card, uiContext);
        const renderer = createSessionRenderer({
          output: output as NodeJS.WritableStream,
          locale: contextualCard.locale,
        });
        output.write(`${renderer.render(buildOnboardingPromptCardViewModel(contextualCard))}\n`);
      },
      close: () => undefined
    }
  );
}

export function withPromptUiContext(prompt: Prompt, uiContext: PromptUiContext): Prompt {
  return Object.assign(
    async (question: string, options?: PromptOptions) => prompt(question, options),
    {
      uiContext,
      select: prompt.select === undefined
        ? undefined
        : async <T>(selection: SelectPromptInput<T>) => prompt.select!(applyPromptUiContext(selection, uiContext)),
      onboardingCard: prompt.onboardingCard === undefined
        ? undefined
        : (card: BuildOnboardingPromptCardInput) => prompt.onboardingCard!(applyPromptUiContext(card, uiContext)),
      close: () => prompt.close?.(),
    }
  );
}

function applyPromptUiContext<T extends { readonly locale?: PromptUiContext["locale"]; readonly direction?: PromptUiContext["direction"] }>(
  input: T,
  uiContext: PromptUiContext
): T & PromptUiContext {
  const locale = input.locale ?? uiContext.locale;
  return {
    ...input,
    locale,
    direction: input.direction ?? (input.locale === undefined ? uiContext.direction : promptUiContextForLocale(locale).direction),
  };
}

function isCreateReadlinePromptOptions(value: Readable | CreateReadlinePromptOptions): value is CreateReadlinePromptOptions {
  return typeof value === "object" && value !== null && ("input" in value || "output" in value || "uiContext" in value);
}

export function canRunInteractive(input: NodeJS.ReadStream = defaultInput): boolean {
  return input.isTTY === true;
}

async function plainQuestion(input: Readable, output: Writable, question: string, options?: PromptOptions): Promise<string> {
  const isTty = Boolean((input as NodeJS.ReadStream).isTTY && (output as NodeJS.WriteStream).isTTY);
  if (isTty && options?.onRowsChange !== undefined) {
    return trackedQuestion(input, output, question, options.onRowsChange, options);
  }

  const pasteSession = createPastePromptSession(input, output, isTty, options);
  const readline = createPromptInterface({ input: pasteSession.input, output, terminal: isTty });
  const inputTracking = startInputChangeTracking(readline, isTty, options);
  const specialKeyInterceptor = installSpecialKeyInterceptor(
    readline,
    options,
    createReadlineSpecialKeyControl(readline, {
      reportInputChange: inputTracking.report,
    })
  );
  try {
    return pasteSession.restore(await readline.question(question));
  } finally {
    specialKeyInterceptor.restore();
    inputTracking.stop();
    readline.close();
    pasteSession.close();
  }
}

async function trackedQuestion(
  input: Readable,
  output: Writable,
  question: string,
  onRowsChange: (rows: number) => void,
  options?: PromptOptions
): Promise<string> {
  return await new Promise<string>((resolve) => {
    const pasteSession = createPastePromptSession(input, output, true, options);
    const readline = createCallbackInterface({ input: pasteSession.input, output, terminal: true });
    const inputTracking = startInputChangeTracking(readline, true, options);
    const mutable = readline as unknown as {
      _writeToOutput?: (value: string) => void;
      getCursorPos?: () => { rows: number; cols: number };
      line?: string;
    };
    let placeholderVisible = false;
    const renderPlaceholder = () => {
      const placeholder = options?.placeholder;
      if (placeholder === undefined || placeholder.length === 0 || (mutable.line ?? "").length > 0) {
        if (placeholderVisible) {
          output.write("\x1b[0K");
          placeholderVisible = false;
        }
        return;
      }
      if (placeholderVisible) {
        return;
      }
      const width = measureVisibleWidth(placeholder);
      if (width === 0) {
        return;
      }
      output.write(`${placeholder}\x1b[${width}D`);
      placeholderVisible = true;
    };
    const reportRows = () => {
      const cursor = mutable.getCursorPos?.();
      onRowsChange(Math.max(1, Math.floor(cursor?.rows ?? 0) + 1));
    };
    const specialKeyInterceptor = installSpecialKeyInterceptor(
      readline,
      options,
      createReadlineSpecialKeyControl(readline, {
        reportInputChange: inputTracking.report,
        reportRows,
        renderPlaceholder,
      })
    );
    const originalWrite = mutable._writeToOutput?.bind(readline);
    if (originalWrite !== undefined) {
      mutable._writeToOutput = (value: string) => {
        originalWrite(value);
        renderPlaceholder();
        reportRows();
        inputTracking.report();
      };
    }
    let cleanedUp = false;
    const cleanup = (input: { readonly closeReadline: boolean }) => {
      if (cleanedUp) return;
      cleanedUp = true;
      onRowsChange(1);
      specialKeyInterceptor.restore();
      inputTracking.stop();
      if (input.closeReadline) {
        readline.close();
      }
      pasteSession.close();
    };
    const onClose = () => cleanup({ closeReadline: false });
    readline.once("close", onClose);
    readline.question(question, (answer) => {
      readline.off("close", onClose);
      const restored = pasteSession.restore(answer);
      cleanup({ closeReadline: true });
      resolve(restored);
    });
    renderPlaceholder();
    reportRows();
  });
}

function startInputChangeTracking(
  readline: unknown,
  enabled: boolean,
  options?: PromptOptions
): { report: () => void; stop: () => void } {
  if (!enabled || options?.onInputChange === undefined) {
    return { report: () => undefined, stop: () => undefined };
  }
  let lastLine: string | undefined;
  const readableLine = readline as { line?: string };
  const report = () => {
    const line = readableLine.line ?? "";
    if (line === lastLine) return;
    lastLine = line;
    options.onInputChange?.(line);
  };
  const interval = setInterval(report, 100);
  interval.unref?.();
  return { report, stop: () => clearInterval(interval) };
}

type MutableReadlineInput = {
  line?: string;
  cursor?: number;
  _refreshLine?: () => void;
  _ttyWrite?: (value: string, key: unknown) => void;
  prompt?: (preserveCursor?: boolean) => void;
};

function createReadlineSpecialKeyControl(
  readline: unknown,
  callbacks: {
    readonly reportInputChange: () => void;
    readonly reportRows?: () => void;
    readonly renderPlaceholder?: () => void;
  }
): PromptSpecialKeyControl {
  const mutableReadline = readline as MutableReadlineInput;
  return {
    getInputLine: () => mutableReadline.line ?? "",
    setInputLine: (nextLine) => {
      mutableReadline.line = nextLine;
      mutableReadline.cursor = nextLine.length;
      if (typeof mutableReadline._refreshLine === "function") {
        mutableReadline._refreshLine();
      } else {
        mutableReadline.prompt?.(true);
      }
      callbacks.reportInputChange();
      callbacks.reportRows?.();
      callbacks.renderPlaceholder?.();
    },
  };
}

function installSpecialKeyInterceptor(
  readline: unknown,
  options: PromptOptions | undefined,
  control: PromptSpecialKeyControl
): { restore: () => void } {
  const controller = options?.specialKeyController;
  if (controller === undefined) {
    return { restore: () => undefined };
  }
  const mutableReadline = readline as MutableReadlineInput;
  const originalTtyWrite = mutableReadline._ttyWrite;
  if (typeof originalTtyWrite !== "function") {
    return { restore: () => undefined };
  }
  const boundOriginalTtyWrite = originalTtyWrite.bind(readline);
  mutableReadline._ttyWrite = (value: string, key: unknown) => {
    const specialKey = promptSpecialKeyName(key);
    if (specialKey === undefined) {
      return boundOriginalTtyWrite(value, key);
    }
    if (!controller.shouldHandleSpecialKey()) {
      return boundOriginalTtyWrite(value, key);
    }
    if (controller.onSpecialKey(specialKey, control) === "handled") {
      return;
    }
    return boundOriginalTtyWrite(value, key);
  };

  let restored = false;
  return {
    restore: () => {
      if (restored) return;
      restored = true;
      mutableReadline._ttyWrite = originalTtyWrite;
    },
  };
}

function promptSpecialKeyName(key: unknown): PromptSpecialKey | undefined {
  const name = typeof key === "object" && key !== null && "name" in key
    ? (key as { readonly name?: unknown }).name
    : undefined;
  switch (name) {
    case "up":
    case "down":
    case "tab":
    case "escape":
      return name;
    default:
      return undefined;
  }
}

type PastePromptSession = {
  readonly input: Readable;
  restore(answer: string): string;
  close(): void;
};

function createPastePromptSession(
  input: Readable,
  output: Writable,
  enabled: boolean,
  options?: PromptOptions
): PastePromptSession {
  if (!enabled) {
    return {
      input,
      restore: (answer) => answer,
      close: () => undefined,
    };
  }

  const interceptor = new PasteInterceptor({
    onPaste: options?.onPastePreview,
    referenceStore: options?.pasteReferenceStore,
    referenceThresholdChars: options?.pasteReferenceThresholdChars,
  });
  const readlineInput = makeReadlineInput(interceptor, input);
  input.pipe(interceptor);
  enableBracketedPaste(output as NodeJS.WritableStream);

  let closed = false;
  return {
    input: readlineInput,
    restore: (answer) => interceptor.restore(answer),
    close: () => {
      if (closed) return;
      closed = true;
      input.unpipe(interceptor);
      disableBracketedPaste(output as NodeJS.WritableStream);
      interceptor.destroy();
    },
  };
}

function makeReadlineInput(interceptor: PasteInterceptor, source: Readable): Readable {
  const readlineInput = interceptor as Readable & {
    isTTY?: boolean;
    isRaw?: boolean;
    setRawMode?: (mode: boolean) => unknown;
  };
  const sourceTty = source as NodeJS.ReadStream;
  readlineInput.isTTY = sourceTty.isTTY;
  readlineInput.isRaw = sourceTty.isRaw;
  if (typeof sourceTty.setRawMode === "function") {
    readlineInput.setRawMode = (mode: boolean) => sourceTty.setRawMode(mode);
  }
  return readlineInput;
}

async function hiddenQuestion(input: Readable, output: Writable, question: string): Promise<string> {
  const isTty = Boolean((input as NodeJS.ReadStream).isTTY && (output as NodeJS.WriteStream).isTTY);
  if (!isTty) {
    const readline = createPromptInterface({ input, output });
    try {
      return await readline.question(question);
    } finally {
      readline.close();
    }
  }

  return await new Promise<string>((resolve) => {
    const readline = createCallbackInterface({ input, output, terminal: true });
    const mutable = readline as unknown as { _writeToOutput?: (value: string) => void; stdoutMuted?: boolean };
    const originalWrite = mutable._writeToOutput?.bind(readline);
    output.write(`${question}\n`);
    mutable.stdoutMuted = true;
    mutable._writeToOutput = (value: string) => {
      if (mutable.stdoutMuted === true) {
        output.write(value.replace(/[^\r\n]/gu, "*"));
      } else {
        originalWrite?.(value);
      }
    };
    readline.question("", (answer) => {
      mutable.stdoutMuted = false;
      output.write("\n");
      readline.close();
      resolve(answer);
    });
  });
}
