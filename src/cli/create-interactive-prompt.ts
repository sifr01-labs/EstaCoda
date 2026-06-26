import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import type { Readable, Writable } from "node:stream";
import type { PromptUiContext } from "../contracts/ui.js";
import type { Prompt } from "./prompt-contract.js";
import { createPapyrusPrompt, type CreatePapyrusPromptOptions } from "./papyrus-prompt.js";

export type CreateInteractivePromptOptions = {
  readonly input?: Readable;
  readonly output?: Writable;
  readonly env?: Record<string, string | undefined>;
  readonly uiContext?: PromptUiContext;
  readonly createPapyrus?: (options: CreatePapyrusPromptOptions) => Prompt;
};

export function createInteractivePrompt(options: CreateInteractivePromptOptions = {}): Prompt {
  const input = options.input ?? defaultInput;
  const output = options.output ?? defaultOutput;
  return (options.createPapyrus ?? createPapyrusPrompt)({
    input,
    output,
    env: options.env,
    uiContext: options.uiContext,
  });
}
