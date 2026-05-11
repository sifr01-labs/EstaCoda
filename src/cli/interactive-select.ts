import { emitKeypressEvents } from "node:readline";
import { createInterface as createPromptInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { buildOnboardingPromptCardViewModel, buildPickerViewModel } from "../ui/view-models/builders.js";
import type { OnboardingPromptOption, PickerOption, ViewModel } from "../contracts/view-model.js";
import type { UiLocale } from "../contracts/ui.js";
import { createSessionRenderer } from "./session-renderer.js";

export type SelectPromptInput<T> = {
  title: string;
  body?: string;
  instruction?: string;
  selectedLabel?: string;
  options: Array<{
    value: T;
    label: string;
    description?: string;
  }>;
  defaultIndex?: number;
  fallbackPrompt: string;
  surface?: "onboarding";
  locale?: UiLocale;
  direction?: "ltr" | "rtl";
  technicalLines?: readonly string[];
};

export async function selectOption<T>(input: Readable, output: Writable, selection: SelectPromptInput<T>): Promise<T> {
  const isTty = Boolean((input as NodeJS.ReadStream).isTTY && (output as NodeJS.WriteStream).isTTY);

  if (!isTty || selection.options.length === 0) {
    return await plainFallback(input, output, selection);
  }

  return await ttySelect(input, output, selection);
}

async function plainFallback<T>(input: Readable, output: Writable, selection: SelectPromptInput<T>): Promise<T> {
  const renderer = createSessionRenderer({
    output: output as NodeJS.WritableStream,
    mode: "plain",
    locale: selection.locale,
  });
  const vm = buildSelectionViewModel(selection, selection.defaultIndex ?? 0);
  output.write(renderer.render(vm) + "\n");
  const raw = await plainQuestion(input, output, selection.fallbackPrompt);
  const selectedIndex = parseChoiceIndex(raw, selection.options.length, selection.defaultIndex ?? 0);
  return selection.options[selectedIndex]?.value ?? selection.options[0]!.value;
}

async function ttySelect<T>(input: Readable, output: Writable, selection: SelectPromptInput<T>): Promise<T> {
  return await new Promise<T>((resolve) => {
    const ttyInput = input as NodeJS.ReadStream;
    let selectedIndex = clampIndex(selection.defaultIndex ?? 0, selection.options.length);
    let settled = false;
    const wasRaw = ttyInput.isRaw === true;
    const saveCursor = "\x1B7";
    const restoreCursor = "\x1B8";
    const clearDown = "\x1B[J";

    const renderer = createSessionRenderer({ output: output as NodeJS.WriteStream, locale: selection.locale });

    const render = () => {
      const vm = buildSelectionViewModel(selection, selectedIndex);
      const text = renderer.render(vm);

      output.write(`${restoreCursor}${clearDown}`);
      output.write(text);
    };

    const restoreTerminal = () => {
      ttyInput.off("keypress", onKeypress);
      if (!wasRaw) {
        ttyInput.setRawMode(false);
      }
      output.write("\x1B[?25h");
    };

    const finish = (value: T) => {
      if (settled) {
        return;
      }
      settled = true;
      restoreTerminal();
      output.write(`\n${selection.selectedLabel ?? "Selected"}: ${selection.options[selectedIndex]?.label ?? "option"}\n\n`);
      resolve(value);
    };

    const onKeypress = (_chunk: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl === true && key.name === "c") {
        restoreTerminal();
        output.write("\n");
        process.emit("SIGINT");
        return;
      }
      if (key.name === "up" || key.name === "k") {
        selectedIndex = selectedIndex <= 0 ? selection.options.length - 1 : selectedIndex - 1;
        render();
        return;
      }
      if (key.name === "down" || key.name === "j") {
        selectedIndex = selectedIndex >= selection.options.length - 1 ? 0 : selectedIndex + 1;
        render();
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        finish(selection.options[selectedIndex]?.value ?? selection.options[0]!.value);
      }
    };

    emitKeypressEvents(ttyInput);
    ttyInput.on("keypress", onKeypress);
    ttyInput.setRawMode(true);
    ttyInput.resume();

    const vm = buildSelectionViewModel(selection, selectedIndex);
    const initialText = renderer.render(vm);
    const reserveLines = Math.max(1, initialText.split("\n").length - 1);
    output.write("\n".repeat(reserveLines));
    output.write(`\x1B[${reserveLines}A`);
    output.write(`\x1B[?25l${saveCursor}`);
    render();
  });
}

function buildSelectionViewModel<T>(selection: SelectPromptInput<T>, selectedIndex: number): ViewModel {
  if (selection.surface === "onboarding") {
    const options: OnboardingPromptOption[] = selection.options.map((opt, i) => ({
      id: String(i),
      label: opt.label,
      description: opt.description,
      technical: false,
    }));
    return buildOnboardingPromptCardViewModel({
      title: selection.title,
      bodyLines: splitBodyLines(selection.body),
      technicalLines: selection.technicalLines,
      options,
      selectedOptionIndex: selectedIndex,
      hint: selection.instruction,
      locale: selection.locale,
      direction: selection.direction,
    });
  }

  const options: PickerOption[] = selection.options.map((opt, i) => ({
    id: String(i),
    label: opt.label,
    description: opt.description,
    selected: i === selectedIndex,
  }));
  return buildPickerViewModel({ title: selection.title, options });
}

function splitBodyLines(body: string | undefined): string[] {
  if (body === undefined || body.length === 0) {
    return [];
  }
  return body.split("\n");
}

export function parseChoiceIndex(value: string, optionCount: number, defaultIndex: number): number {
  const parsed = Number.parseInt(value, 10) - 1;
  return Number.isFinite(parsed) ? clampIndex(parsed, optionCount) : clampIndex(defaultIndex, optionCount);
}

function clampIndex(index: number, optionCount: number): number {
  if (optionCount <= 0) {
    return 0;
  }
  return Math.min(Math.max(index, 0), optionCount - 1);
}

async function plainQuestion(input: Readable, output: Writable, question: string): Promise<string> {
  const readline = createPromptInterface({ input, output });
  try {
    return await readline.question(question);
  } finally {
    readline.close();
  }
}
