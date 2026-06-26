import type { PasteReferenceStore } from "./paste-interceptor.js";
import type { SelectPromptInput } from "./interactive-select.js";
import type { BuildOnboardingPromptCardInput } from "../ui/view-models/builders.js";
import type { PromptUiContext } from "../contracts/ui.js";

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
