import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import type { Readable, Writable } from "node:stream";
import type { PromptUiContext } from "../contracts/ui.js";
import { promptUiContextForLocale } from "../contracts/ui.js";
import { createLineEditorState } from "../ui/input/lineEditor.js";
import { parseKeypress } from "../ui/input/parseKeypress.js";
import { createTerminalLifecycle, type TerminalLifecycle } from "../ui/input/terminalLifecycle.js";
import { SecretPromptController } from "../ui/papyrus/input/secretPromptController.js";
import { buildOnboardingPromptCardViewModel, type BuildOnboardingPromptCardInput } from "../ui/view-models/builders.js";
import { applyPromptUiContext, type Prompt, type PromptOptions } from "./prompt-contract.js";
import { resolveGhostTextMode } from "./ghost-text-mode.js";
import { resolveInputKeymapMode } from "./input-keymap-mode.js";
import { selectOption, type SelectPromptInput } from "./interactive-select.js";
import {
  createDefaultRawPromptTypeahead,
  createRawPrompt,
  type RawPromptControllerOptions,
  type RawPromptInput,
  type RawPromptOutput,
} from "./rawPromptController.js";
import { RawPromptRenderLoop } from "./rawPromptRenderLoop.js";
import { createSessionRenderer } from "./session-renderer.js";

type SecretPromptDataListener = (chunk: string | Buffer | Uint8Array) => void;

export type CreatePapyrusSecretPromptOptions = {
  readonly input?: Readable | RawPromptInput;
  readonly output?: Writable | RawPromptOutput;
  readonly uiContext?: PromptUiContext;
  readonly lifecycle?: TerminalLifecycle;
};

export type CreatePapyrusPromptOptions = {
  readonly input?: Readable | RawPromptInput;
  readonly output?: Writable | RawPromptOutput;
  readonly env?: Record<string, string | undefined>;
  readonly uiContext?: PromptUiContext;
  readonly createRaw?: (options: RawPromptControllerOptions & { uiContext?: PromptUiContext }) => Prompt;
  readonly createSecretPrompt?: (options: CreatePapyrusSecretPromptOptions) => Prompt;
};

export function createPapyrusPrompt(options: CreatePapyrusPromptOptions = {}): Prompt {
  const input = options.input ?? defaultInput;
  const output = options.output ?? defaultOutput;
  const uiContext = options.uiContext ?? promptUiContextForLocale("en");
  const rawPrompt = (options.createRaw ?? createRawPrompt)({
    input: input as RawPromptInput,
    output: output as RawPromptOutput,
    uiContext,
    typeahead: createDefaultRawPromptTypeahead(),
    ghostText: resolveGhostTextMode({ env: options.env }) === "on" ? { enabled: true } : undefined,
    keymap: resolveInputKeymapMode({ env: options.env }) === "vim" ? { mode: "vim" } : undefined,
  });
  const secretPrompt = (options.createSecretPrompt ?? createPapyrusSecretPrompt)({
    input: input as Readable,
    output: output as Writable,
    uiContext,
  });

  return Object.assign(
    async (question: string, promptOptions?: PromptOptions) => {
      if (promptOptions?.secret === true) {
        return secretPrompt(question, { secret: true });
      }
      return rawPrompt(question, promptOptions);
    },
    {
      uiContext,
      select: async <T>(selection: SelectPromptInput<T>) =>
        selectOption(input as Readable, output as Writable, applyPromptUiContext(selection, uiContext)),
      onboardingCard: (card: BuildOnboardingPromptCardInput) => {
        const contextualCard = applyPromptUiContext(card, uiContext);
        const renderer = createSessionRenderer({
          output: output as NodeJS.WritableStream,
          locale: contextualCard.locale,
        });
        output.write(`${renderer.render(buildOnboardingPromptCardViewModel(contextualCard))}\n`);
      },
      close: () => {
        rawPrompt.close?.();
        secretPrompt.close?.();
      },
    }
  );
}

export function createPapyrusSecretPrompt(options: CreatePapyrusSecretPromptOptions = {}): Prompt {
  const input = (options.input ?? defaultInput) as RawPromptInput;
  const output = (options.output ?? defaultOutput) as RawPromptOutput;
  const uiContext = options.uiContext ?? promptUiContextForLocale("en");

  return Object.assign(
    async (question: string) => {
      return await readPapyrusSecret({
        question,
        input,
        output,
        lifecycle: options.lifecycle ?? createTerminalLifecycle({ stdin: input, stdout: output }),
      });
    },
    {
      uiContext,
      close: () => undefined,
    }
  );
}

async function readPapyrusSecret(options: {
  readonly question: string;
  readonly input: RawPromptInput;
  readonly output: RawPromptOutput;
  readonly lifecycle: TerminalLifecycle;
}): Promise<string> {
  const controller = new SecretPromptController({ label: options.question });
  const renderLoop = new RawPromptRenderLoop(options.output);
  const render = () => {
    const renderState = controller.renderState;
    renderLoop.render({
      prompt: renderState.label,
      state: createLineEditorState(renderState.maskedText),
    });
  };

  render();

  try {
    options.lifecycle.start();
  } catch (error) {
    controller.clear();
    renderLoop.clear();
    options.lifecycle.stop();
    throw error;
  }

  return await new Promise<string>((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      detachSecretDataListener(options.input, onData);
      controller.clear();
      renderLoop.clear();
      const stopResult = options.lifecycle.stop();
      if (stopResult.errors.length > 0) {
        reject(stopResult.errors[0]);
        return false;
      }
      return true;
    };

    const finish = (value: string) => {
      if (settled) return;
      settled = true;
      if (cleanup()) {
        options.output.write("\n");
        resolve(value);
      }
    };

    const cancel = () => {
      if (settled) return;
      settled = true;
      if (cleanup()) {
        options.output.write("\n");
        resolve("/exit");
      }
    };

    const onData = (chunk: string | Buffer | Uint8Array) => {
      if (settled) return;
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      for (const event of parseKeypress(text)) {
        const result = controller.apply(event);
        render();
        if (result.intent?.type === "submit") {
          finish(result.intent.value);
          return;
        }
        if (result.intent?.type === "cancel" || result.intent?.type === "eof") {
          cancel();
          return;
        }
      }
    };

    options.input.on("data", onData);
    options.input.resume?.();
  });
}

function detachSecretDataListener(input: RawPromptInput, listener: SecretPromptDataListener): void {
  if (typeof input.off === "function") {
    input.off("data", listener);
    return;
  }
  input.removeListener?.("data", listener);
}
