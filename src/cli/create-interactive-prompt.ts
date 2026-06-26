import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import type { Readable, Writable } from "node:stream";
import type { PromptUiContext } from "../contracts/ui.js";
import { resolveUiInputMode } from "../ui/input-mode.js";
import { resolveUiRendererMode } from "../ui/renderer-mode.js";
import { canRunInteractive } from "../ui/terminal-capabilities.js";
import type { Prompt } from "./prompt-contract.js";
import { createPapyrusPrompt, type CreatePapyrusPromptOptions } from "./papyrus-prompt.js";
import { createReadlinePrompt, type CreateReadlinePromptOptions } from "./readline-prompt.js";

export type CreateInteractivePromptOptions = {
  readonly input?: Readable;
  readonly output?: Writable;
  readonly env?: Record<string, string | undefined>;
  readonly uiContext?: PromptUiContext;
  readonly createPapyrus?: (options: CreatePapyrusPromptOptions) => Prompt;
  readonly createReadline?: (options: CreateReadlinePromptOptions) => Prompt;
  readonly canRunInteractive?: (input: NodeJS.ReadStream) => boolean;
};

export function createInteractivePrompt(options: CreateInteractivePromptOptions = {}): Prompt {
  const input = options.input ?? defaultInput;
  const output = options.output ?? defaultOutput;
  const env = options.env;
  const rendererMode = resolveUiRendererMode({ env });
  const inputMode = resolveUiInputMode({ env, defaultMode: "raw" });
  const interactive = (options.canRunInteractive ?? canRunInteractive)(input as NodeJS.ReadStream);

  if (interactive && rendererMode === "papyrus" && inputMode === "raw") {
    return (options.createPapyrus ?? createPapyrusPrompt)({
      input,
      output,
      env,
      uiContext: options.uiContext,
    });
  }

  return (options.createReadline ?? createReadlinePrompt)({
    input,
    output,
    uiContext: options.uiContext,
  });
}
