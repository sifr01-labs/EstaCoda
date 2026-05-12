import { createInterface as createCallbackInterface } from "node:readline";
import { createInterface as createPromptInterface } from "node:readline/promises";
import { stdin as defaultInput, stdout as defaultOutput } from "node:process";
import type { Readable, Writable } from "node:stream";
import { buildOnboardingPromptCardViewModel, type BuildOnboardingPromptCardInput } from "../ui/view-models/builders.js";
import { selectOption, type SelectPromptInput } from "./interactive-select.js";
import { createSessionRenderer } from "./session-renderer.js";

export type Prompt = ((question: string, options?: { secret?: boolean }) => Promise<string>) & {
  select?: <T>(input: SelectPromptInput<T>) => Promise<T>;
  onboardingCard?: (input: BuildOnboardingPromptCardInput) => Promise<void> | void;
  close?: () => void;
};

export function createReadlinePrompt(input: Readable = defaultInput, output: Writable = defaultOutput): Prompt {
  return Object.assign(
    async (question: string, options?: { secret?: boolean }) => {
      if (options?.secret === true) {
        return hiddenQuestion(input, output, question);
      }
      return plainQuestion(input, output, question);
    },
    {
      select: async <T>(selection: SelectPromptInput<T>) => selectOption(input, output, selection),
      onboardingCard: (card: BuildOnboardingPromptCardInput) => {
        const renderer = createSessionRenderer({
          output: output as NodeJS.WritableStream,
          locale: card.locale,
        });
        output.write(`${renderer.render(buildOnboardingPromptCardViewModel(card))}\n`);
      },
      close: () => undefined
    }
  );
}

export function canRunInteractive(input: NodeJS.ReadStream = defaultInput): boolean {
  return input.isTTY === true;
}

async function plainQuestion(input: Readable, output: Writable, question: string): Promise<string> {
  const readline = createPromptInterface({ input, output });
  try {
    return await readline.question(question);
  } finally {
    readline.close();
  }
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
