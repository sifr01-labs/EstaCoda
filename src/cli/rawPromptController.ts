import type { Readable, Writable } from "node:stream";
import { promptUiContextForLocale, type PromptUiContext } from "../contracts/ui.js";
import { parseKeypress } from "../ui/input/parseKeypress.js";
import { applyKeypress, createLineEditorState, type LineEditorState } from "../ui/input/lineEditor.js";
import { createTerminalLifecycle, type TerminalLifecycle } from "../ui/input/terminalLifecycle.js";
import type { UiInputMode } from "../ui/input-mode.js";
import { createReadlinePrompt, type CreateReadlinePromptOptions, type Prompt, type PromptOptions } from "./readline-prompt.js";

type RawPromptDataListener = (chunk: string | Buffer | Uint8Array) => void;

export type RawPromptInput = {
  on(event: "data", listener: RawPromptDataListener): unknown;
  off?: (event: "data", listener: RawPromptDataListener) => unknown;
  removeListener?: (event: "data", listener: RawPromptDataListener) => unknown;
  resume?: () => unknown;
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => unknown;
};

export type RawPromptOutput = Pick<Writable, "write"> & {
  isTTY?: boolean;
};

export type RawPromptResult =
  | {
      type: "submit";
      text: string;
    }
  | {
      type: "cancel";
    }
  | {
      type: "eof";
    };

export type RawPromptControllerOptions = {
  input: RawPromptInput;
  output: RawPromptOutput;
  lifecycle?: TerminalLifecycle;
};

export type CreatePromptForInputModeOptions = Omit<CreateReadlinePromptOptions, "input" | "output"> & {
  mode: UiInputMode;
  input?: Readable | RawPromptInput;
  output?: Writable | RawPromptOutput;
  createReadline?: (options: CreateReadlinePromptOptions) => Prompt;
  createRaw?: (options: RawPromptControllerOptions & { uiContext?: PromptUiContext }) => Prompt;
};

export class RawPromptController {
  readonly #input: RawPromptInput;
  readonly #output: RawPromptOutput;
  readonly #lifecycle: TerminalLifecycle;

  constructor(options: RawPromptControllerOptions) {
    this.#input = options.input;
    this.#output = options.output;
    this.#lifecycle = options.lifecycle ?? createTerminalLifecycle({
      stdin: options.input,
      stdout: options.output,
    });
  }

  async read(question: string, options?: PromptOptions): Promise<RawPromptResult> {
    this.#output.write(question);
    options?.onRowsChange?.(1);

    try {
      this.#lifecycle.start();
    } catch (error) {
      this.#lifecycle.stop();
      throw error;
    }

    return await new Promise<RawPromptResult>((resolve, reject) => {
      let state = createLineEditorState();
      let settled = false;

      const cleanup = () => {
        detachDataListener(this.#input, onData);
        const stopResult = this.#lifecycle.stop();
        if (stopResult.errors.length > 0) {
          reject(stopResult.errors[0]);
          return false;
        }
        return true;
      };

      const finish = (result: RawPromptResult) => {
        if (settled) return;
        settled = true;
        this.#output.write("\n");
        if (cleanup()) resolve(result);
      };

      const updateState = (nextState: LineEditorState) => {
        if (nextState.text !== state.text) {
          options?.onInputChange?.(nextState.text);
        }
        state = nextState;
        options?.onRowsChange?.(1);
      };

      const onData = (chunk: string | Buffer | Uint8Array) => {
        if (settled) return;
        const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        for (const event of parseKeypress(text)) {
          const result = applyKeypress(state, event);
          updateState(result.state);
          if (result.intent?.type === "submit") {
            finish({ type: "submit", text: result.intent.text });
            return;
          }
          if (result.intent?.type === "cancel") {
            finish({ type: "cancel" });
            return;
          }
          if (result.intent?.type === "eof") {
            finish({ type: "eof" });
            return;
          }
        }
      };

      this.#input.on("data", onData);
      this.#input.resume?.();
    });
  }
}

export function createRawPrompt(options: RawPromptControllerOptions & { uiContext?: PromptUiContext }): Prompt {
  const controller = new RawPromptController(options);
  const uiContext = options.uiContext ?? promptUiContextForLocale("en");

  return Object.assign(
    async (question: string, promptOptions?: PromptOptions) => {
      const result = await controller.read(question, promptOptions);
      if (result.type === "submit") return result.text;
      return "/exit";
    },
    {
      uiContext,
      close: () => undefined,
    }
  );
}

export function createPromptForInputMode(options: CreatePromptForInputModeOptions): Prompt {
  const { mode, createReadline = createReadlinePrompt, createRaw = createRawPrompt, ...promptOptions } = options;
  if (mode !== "raw") {
    return createReadline({
      ...promptOptions,
      input: promptOptions.input as Readable | undefined,
      output: promptOptions.output as Writable | undefined,
    });
  }

  const input = promptOptions.input;
  const output = promptOptions.output;
  if (input === undefined || output === undefined) {
    return createReadline({
      ...promptOptions,
      input: input as Readable | undefined,
      output: output as Writable | undefined,
    });
  }

  return createRaw({
    input: input as RawPromptInput,
    output: output as RawPromptOutput,
    uiContext: promptOptions.uiContext,
  });
}

function detachDataListener(input: RawPromptInput, listener: RawPromptDataListener): void {
  if (typeof input.off === "function") {
    input.off("data", listener);
    return;
  }
  input.removeListener?.("data", listener);
}
