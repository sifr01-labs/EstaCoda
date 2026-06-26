import { emitKeypressEvents } from "node:readline";
import { createInterface as createPromptInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import { buildOnboardingPromptCardViewModel, buildPickerViewModel } from "../ui/view-models/builders.js";
import type { OnboardingPromptOption, PickerOption, PromptCardBodyLineStyle, PromptCardStatusLine, ViewModel } from "../contracts/view-model.js";
import type { Locale, TextDirection } from "../contracts/ui.js";
import { createSessionRenderer } from "./session-renderer.js";
import { isolateLtr, isolateRtl } from "../ui/bidi.js";
import {
  createSelectNavigationState,
  getFocusedOption,
  type SelectNavigationState,
} from "../ui/papyrus/widgets/selectModel.js";
import {
  applySelectKey,
  type SelectKeyEvent,
} from "../ui/papyrus/widgets/selectKeymap.js";
import type { PapyrusOption } from "../ui/papyrus/widgets/optionMap.js";

export type SelectPromptInput<T> = {
  title: string;
  body?: string;
  bodyLineStyles?: readonly PromptCardBodyLineStyle[];
  instruction?: string;
  hint?: string;
  selectedLabel?: string;
  columns?: readonly {
    key: string;
    header: string;
    align?: "left" | "right";
  }[];
  options: Array<{
    id?: string;
    value: T;
    label: string;
    description?: string;
    technical?: boolean;
    group?: "main" | "navigation";
    cells?: Readonly<Record<string, string>>;
    badges?: readonly string[];
    current?: boolean;
  }>;
  defaultIndex?: number;
  fallbackPrompt: string;
  surface?: "promptCard";
  locale?: Locale;
  direction?: TextDirection;
  technicalLines?: readonly string[];
  statusLines?: readonly PromptCardStatusLine[];
  showCurrentBadge?: boolean;
  showColumnHeaders?: boolean;
  tableDirection?: "ltr" | "rtl";
  tableWidth?: "full" | "content";
  tableMaxWidth?: number;
  tableAlign?: "left" | "center" | "right";
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
    let selectState = createPapyrusSelectState(selection);
    let settled = false;
    const wasRaw = ttyInput.isRaw === true;
    const saveCursor = "\x1B7";
    const restoreCursor = "\x1B8";
    const clearDown = "\x1B[J";

    const renderer = createSessionRenderer({ output: output as NodeJS.WriteStream, locale: selection.locale });

    const render = () => {
      const selectedIndex = focusedSelectionIndex(selectState);
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

    const finish = (value: T, selectedIndex: number) => {
      if (settled) {
        return;
      }
      settled = true;
      restoreTerminal();
      output.write(`\n${selectedOutputLine(selection, selectedIndex, renderer.capabilities.supportsColor && renderer.tokens.contract.behavior.allowAnsiColor)}\n\n`);
      resolve(value);
    };

    const onKeypress = (_chunk: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl === true && key.name === "c") {
        restoreTerminal();
        output.write("\n");
        process.emit("SIGINT");
        return;
      }
      const event = selectKeyEventFromKeypress(_chunk, key);
      if (event === undefined) {
        return;
      }
      const result = applySelectKey(selectState, event);
      selectState = result.state;
      if (result.intent?.type === "selected") {
        const selectedIndex = focusedSelectionIndex(selectState);
        finish(selection.options[selectedIndex]?.value ?? selection.options[0]!.value, selectedIndex);
        return;
      }
      if (result.intent?.type === "focus-changed" || result.intent === undefined) {
        render();
      }
    };

    emitKeypressEvents(ttyInput);
    ttyInput.on("keypress", onKeypress);
    ttyInput.setRawMode(true);
    ttyInput.resume();

    const vm = buildSelectionViewModel(selection, focusedSelectionIndex(selectState));
    const initialText = renderer.render(vm);
    const reserveLines = Math.max(1, initialText.split("\n").length - 1);
    output.write("\n".repeat(reserveLines));
    output.write(`\x1B[${reserveLines}A`);
    output.write(`\x1B[?25l${saveCursor}`);
    render();
  });
}

type SelectMetadata = {
  readonly index: number;
};

function createPapyrusSelectState<T>(
  selection: SelectPromptInput<T>
): SelectNavigationState<string, SelectMetadata> {
  return createSelectNavigationState<string, SelectMetadata>(
    selection.options.map((option, index): PapyrusOption<string, SelectMetadata> => ({
      value: optionValueForIndex(index),
      label: option.label,
      description: option.description,
      metadata: { index },
    })),
    {
      focusedValue: optionValueForIndex(clampIndex(selection.defaultIndex ?? 0, selection.options.length)),
      viewportSize: Math.max(1, selection.options.length),
      wrap: true,
    }
  );
}

function focusedSelectionIndex(state: SelectNavigationState<string, SelectMetadata>): number {
  return getFocusedOption(state)?.metadata?.index ?? 0;
}

function optionValueForIndex(index: number): string {
  return String(index);
}

function selectKeyEventFromKeypress(
  chunk: string,
  key: { name?: string; shift?: boolean }
): SelectKeyEvent | undefined {
  if (key.name === "up" || key.name === "k") return { key: "arrowUp" };
  if (key.name === "down" || key.name === "j") return { key: "arrowDown" };
  if (key.name === "return" || key.name === "enter") return { key: "enter" };
  if (key.name === "pageup") return { key: "pageUp" };
  if (key.name === "pagedown") return { key: "pageDown" };
  if (key.name === "home") return { key: "home" };
  if (key.name === "end") return { key: "end" };
  if (key.name === "tab") return { key: key.shift === true ? "backtab" : "tab" };
  const digit = digitFromKeypress(chunk, key.name);
  return digit === undefined ? undefined : { key: "digit", digit };
}

function digitFromKeypress(chunk: string, keyName: string | undefined): number | undefined {
  const value = keyName ?? chunk;
  if (!/^[1-9]$/u.test(value)) return undefined;
  return Number.parseInt(value, 10);
}

function buildSelectionViewModel<T>(selection: SelectPromptInput<T>, selectedIndex: number): ViewModel {
  if (selection.surface === "promptCard") {
    const options: OnboardingPromptOption[] = selection.options.map((opt, i) => ({
      id: String(i),
      label: opt.label,
      description: opt.description,
      technical: opt.technical ?? false,
      group: opt.group,
      cells: opt.cells,
      badges: opt.badges,
      current: opt.current,
    }));
    return buildOnboardingPromptCardViewModel({
      title: selection.title,
      bodyLines: splitBodyLines(selection.body),
      bodyLineStyles: selection.bodyLineStyles,
      technicalLines: selection.technicalLines,
      statusLines: selection.statusLines,
      columns: selection.columns,
      options,
      selectedOptionIndex: selectedIndex,
      hint: selection.hint ?? selection.instruction,
      showCurrentBadge: selection.showCurrentBadge,
      showColumnHeaders: selection.showColumnHeaders,
      tableDirection: selection.tableDirection,
      tableWidth: selection.tableWidth,
      tableMaxWidth: selection.tableMaxWidth,
      tableAlign: selection.tableAlign,
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

function selectedOutputLine<T>(
  selection: SelectPromptInput<T>,
  selectedIndex: number,
  useAnsi: boolean
): string {
  const locale = selection.locale ?? "en";
  const label = selection.selectedLabel ?? (locale === "ar" ? "تم تحديد" : "Selected");
  const selectedOption = selection.options[selectedIndex];
  const selectedValue = selectedOption === undefined
    ? locale === "ar" ? "خيار" : "option"
    : selectedOptionLabel(selectedOption.label, locale, selectedOption.technical === true);
  const line = `${useAnsi ? bold(label) : label}: ${selectedValue}`;
  return locale === "ar" ? isolateRtl(line) : line;
}

function selectedOptionLabel(value: string, locale: Locale, explicitTechnical: boolean): string {
  if (locale !== "ar") {
    return value;
  }
  return explicitTechnical || looksTechnical(value) ? isolateLtr(value) : isolateRtl(value);
}

function looksTechnical(value: string): boolean {
  return /^[/~.]|^[A-Z0-9_]+$/u.test(value) || /[A-Za-z0-9][._/-][A-Za-z0-9]/u.test(value);
}

function bold(value: string): string {
  return `\x1b[1m${value}\x1b[22m`;
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
