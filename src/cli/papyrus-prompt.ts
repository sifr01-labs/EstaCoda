import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import type { Readable, Writable } from "node:stream";
import type { PromptUiContext } from "../contracts/ui.js";
import { promptUiContextForLocale } from "../contracts/ui.js";
import {
  createRawPrompt,
  type RawPromptControllerOptions,
  type RawPromptInput,
  type RawPromptOutput,
} from "./rawPromptController.js";
import { createReadlinePrompt, type CreateReadlinePromptOptions } from "./readline-prompt.js";
import type { Prompt, PromptOptions } from "./prompt-contract.js";

export type CreatePapyrusPromptOptions = {
  readonly input?: Readable | RawPromptInput;
  readonly output?: Writable | RawPromptOutput;
  readonly env?: Record<string, string | undefined>;
  readonly uiContext?: PromptUiContext;
  readonly createRaw?: (options: RawPromptControllerOptions & { uiContext?: PromptUiContext }) => Prompt;
  readonly createSecretPrompt?: (options: CreateReadlinePromptOptions) => Prompt;
};

export function createPapyrusPrompt(options: CreatePapyrusPromptOptions = {}): Prompt {
  const input = options.input ?? defaultInput;
  const output = options.output ?? defaultOutput;
  const uiContext = options.uiContext ?? promptUiContextForLocale("en");
  const rawPrompt = (options.createRaw ?? createRawPrompt)({
    input: input as RawPromptInput,
    output: output as RawPromptOutput,
    uiContext,
  });
  const secretPrompt = (options.createSecretPrompt ?? createReadlinePrompt)({
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
      select: secretPrompt.select,
      onboardingCard: secretPrompt.onboardingCard,
      close: () => {
        rawPrompt.close?.();
        secretPrompt.close?.();
      },
    }
  );
}
