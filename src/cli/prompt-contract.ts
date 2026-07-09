import type { PasteReferenceStore } from "./paste-interceptor.js";
import type { SelectPromptInput } from "./interactive-select.js";
import type { BuildOnboardingPromptCardInput } from "../ui/view-models/builders.js";
import { promptUiContextForLocale, type PromptUiContext } from "../contracts/ui.js";

export type PromptOptions = {
  secret?: boolean;
  title?: string;
  description?: string;
  onRowsChange?: (rows: number) => void;
  onPastePreview?: (original: string, displayed: string) => void;
  onInputChange?: (line: string) => void;
  specialKeyController?: PromptSpecialKeyController;
  placeholder?: string;
  pasteReferenceStore?: PasteReferenceStore;
  pasteReferenceThresholdChars?: number;
};

export type PromptSubmission = {
  text: string;
  displayText?: string;
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
  submit?: (question: string, options?: PromptOptions) => Promise<PromptSubmission>;
  select?: <T>(input: SelectPromptInput<T>) => Promise<T>;
  onboardingCard?: (input: BuildOnboardingPromptCardInput) => Promise<void> | void;
  close?: () => void;
};

export function withPromptUiContext(prompt: Prompt, uiContext: PromptUiContext): Prompt {
  return Object.assign(
    async (question: string, options?: PromptOptions) => prompt(question, options),
    {
      uiContext,
      submit: prompt.submit === undefined
        ? undefined
        : async (question: string, options?: PromptOptions) => prompt.submit!(question, options),
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

export function applyPromptUiContext<T extends { readonly locale?: PromptUiContext["locale"]; readonly direction?: PromptUiContext["direction"] }>(
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
