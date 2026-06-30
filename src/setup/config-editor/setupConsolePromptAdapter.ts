import type { Readable, Writable } from "node:stream";
import type { SelectPromptInput } from "../../cli/interactive-select.js";
import type { Prompt, PromptOptions, PromptSubmission } from "../../cli/prompt-contract.js";
import type { BuildOnboardingPromptCardInput } from "../../ui/view-models/builders.js";
import { createKeypressStreamDispatcher } from "../../ui/input/keyPressStreamDispatcher.js";
import { applyKeypress, createLineEditorState, type LineEditorState } from "../../ui/input/lineEditor.js";
import type { ParsedKeypress } from "../../ui/input/parseKeypress.js";
import { SecretPromptController } from "../../ui/papyrus/input/secretPromptController.js";
import type { OperatorConsoleStyle, SetupPanelState } from "../../ui/papyrus/operator-console/index.js";
import { mapSetupSelectToSetupPanelState } from "../../ui/papyrus/operator-console/setupSelectRuntimeMapper.js";
import {
  applySelectKey,
  type SelectKeyEvent,
} from "../../ui/papyrus/widgets/selectKeymap.js";
import {
  createSelectNavigationState,
  getFocusedOption,
  type SelectNavigationState,
} from "../../ui/papyrus/widgets/selectModel.js";
import {
  createSetupOperatorConsoleController,
  type SetupOperatorConsoleController,
  type SetupOperatorConsoleOutput,
} from "./setupOperatorConsoleController.js";

export type SetupConsolePromptAdapterOptions = {
  readonly input: Readable;
  readonly output: SetupOperatorConsoleOutput & Writable;
  readonly controller?: SetupOperatorConsoleController;
  readonly style?: OperatorConsoleStyle;
  readonly createController?: (options: {
    readonly output: SetupOperatorConsoleOutput;
  }) => SetupOperatorConsoleController;
};

type TtyReadable = Readable & {
  readonly isTTY?: boolean;
  readonly isRaw?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  resume?: () => unknown;
};

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const SETUP_CONSOLE_CONTROLLER = Symbol("setupConsoleController");
const SETUP_CONSOLE_PRESERVE_ON_CLOSE = Symbol("setupConsolePreserveOnClose");

export class SetupConsoleExitError extends Error {
  constructor() {
    super("Setup console exit requested.");
    this.name = "SetupConsoleExitError";
  }
}

export function isSetupConsoleExit(error: unknown): error is SetupConsoleExitError {
  return error instanceof SetupConsoleExitError;
}

type PromptWithSetupConsoleController = Prompt & {
  readonly [SETUP_CONSOLE_CONTROLLER]?: () => SetupOperatorConsoleController | undefined;
  readonly [SETUP_CONSOLE_PRESERVE_ON_CLOSE]?: () => void;
};

export function withSetupConsolePrompt(
  prompt: Prompt,
  options: SetupConsolePromptAdapterOptions
): Prompt {
  let ownedController: SetupOperatorConsoleController | undefined;
  let preserveOnClose = false;
  const getController = () => {
    if (options.controller !== undefined) return options.controller;
    ownedController ??= options.createController?.({ output: options.output }) ??
      createSetupOperatorConsoleController({ output: options.output, style: options.style });
    return ownedController;
  };
  const select = prompt.select === undefined
    ? undefined
    : async <T>(selection: SelectPromptInput<T>): Promise<T> => {
      if (!shouldUseSetupConsole(selection, options.input, options.output)) {
        return prompt.select!(selection);
      }
      return selectWithSetupConsole(selection, options, getController());
    };

  return Object.assign(
    async (question: string, promptOptions?: PromptOptions) => {
      if (hasLiveSetupConsole(options.input, options.output)) {
        if (promptOptions?.secret === true) {
          return readSecretWithSetupConsole(question, options, getController(), prompt.uiContext?.locale);
        }
        return readTextWithSetupConsole(question, promptOptions, options, getController(), prompt.uiContext?.locale);
      }
      return prompt(question, promptOptions);
    },
    {
      uiContext: prompt.uiContext,
      submit: prompt.submit === undefined
        ? undefined
        : async (question: string, promptOptions?: PromptOptions): Promise<PromptSubmission> => {
          if (hasLiveSetupConsole(options.input, options.output)) {
            if (promptOptions?.secret === true) {
              return { text: await readSecretWithSetupConsole(question, options, getController(), prompt.uiContext?.locale) };
            }
            return { text: await readTextWithSetupConsole(question, promptOptions, options, getController(), prompt.uiContext?.locale) };
          }
          return prompt.submit!(question, promptOptions);
        },
      select,
      onboardingCard: prompt.onboardingCard === undefined
        ? undefined
        : async (card: BuildOnboardingPromptCardInput): Promise<void> => {
          if (!hasLiveSetupConsole(options.input, options.output)) {
            await prompt.onboardingCard!(card);
            return;
          }
          renderOnboardingCardWithSetupConsole(card, getController());
        },
      close: () => {
        if (!preserveOnClose) {
          options.controller?.clear();
          ownedController?.clear();
        }
        prompt.close?.();
      },
      [SETUP_CONSOLE_CONTROLLER]: () =>
        hasLiveSetupConsole(options.input, options.output) ? getController() : undefined,
      [SETUP_CONSOLE_PRESERVE_ON_CLOSE]: () => {
        preserveOnClose = true;
      },
    }
  );
}

export function setupConsoleControllerForPrompt(prompt: Prompt): SetupOperatorConsoleController | undefined {
  return (prompt as PromptWithSetupConsoleController)[SETUP_CONSOLE_CONTROLLER]?.();
}

export function preserveSetupConsoleOnPromptClose(prompt: Prompt): void {
  (prompt as PromptWithSetupConsoleController)[SETUP_CONSOLE_PRESERVE_ON_CLOSE]?.();
}

async function selectWithSetupConsole<T>(
  selection: SelectPromptInput<T>,
  options: SetupConsolePromptAdapterOptions,
  controller: SetupOperatorConsoleController
): Promise<T> {
  const ttyInput = options.input as TtyReadable;
  let state = createSetupSelectState(selection);
  let settled = false;
  let restored = false;
  let cursorHidden = false;
  const wasRaw = ttyInput.isRaw === true;

  const render = () => {
    const selectedIndex = focusedSelectionIndex(state);
    const panel = mapSetupSelectToSetupPanelState({
      title: selection.title,
      body: selection.body,
      hint: selection.hint ?? selection.instruction,
      statusLines: selection.statusLines,
      locale: selection.locale === "ar" ? "ar" : "en",
      columns: selection.columns,
      options: selection.options.map((option) => ({
        id: option.id,
        label: option.label,
        description: option.description,
        group: option.group,
        cells: option.cells,
        badges: option.badges,
        current: option.current,
      })),
      selectedIndex,
    });
    if (panel === undefined) return;
    controller.render(panel);
  };

  const restoreTerminal = () => {
    if (restored) return;
    restored = true;
    keypressDispatcher.dispose();
    ttyInput.off("data", onData);
    if (!wasRaw) {
      ttyInput.setRawMode?.(false);
    }
    if (cursorHidden) {
      options.output.write(SHOW_CURSOR);
      cursorHidden = false;
    }
  };

  const finish = (selectedIndex: number, resolve: (value: T) => void) => {
    if (settled) return;
    settled = true;
    restoreTerminal();
    controller.clear();
    resolve(selection.options[selectedIndex]?.value ?? selection.options[0]!.value);
  };

  const interrupt = (reject: (error: Error) => void) => {
    if (settled) return;
    settled = true;
    restoreTerminal();
    controller.clear();
    options.output.write("\n");
    reject(new SetupConsoleExitError());
  };

  const onData = (chunk: string | Buffer | Uint8Array) => {
    keypressDispatcher.handle(chunk);
  };

  const pendingKeypresses: ParsedKeypress[] = [];
  let resolveSelection: ((value: T) => void) | undefined;
  let rejectSelection: ((error: Error) => void) | undefined;

  const drainKeypresses = () => {
    if (resolveSelection === undefined || settled) return;
    for (const keypress of pendingKeypresses.splice(0)) {
      if (keypress.type === "key" && keypress.ctrl === true && keypress.key === "c") {
        if (rejectSelection !== undefined) {
          interrupt(rejectSelection);
        }
        return;
      }
      const event = selectKeyEventFromParsedKeypress(keypress);
      if (event === undefined) continue;
      const result = applySelectKey(state, event);
      state = result.state;
      if (result.intent?.type === "selected") {
        finish(focusedSelectionIndex(state), resolveSelection);
        return;
      }
      if (result.intent?.type === "focus-changed" || result.intent === undefined) {
        render();
      }
    }
  };

  const keypressDispatcher = createKeypressStreamDispatcher({
    onEvents: (events) => {
      pendingKeypresses.push(...events);
      drainKeypresses();
    },
  });

  return await new Promise<T>((resolve, reject) => {
    resolveSelection = resolve;
    rejectSelection = reject;
    ttyInput.on("data", onData);
    ttyInput.setRawMode?.(true);
    ttyInput.resume?.();
    options.output.write(HIDE_CURSOR);
    cursorHidden = true;
    render();
    drainKeypresses();
  }).finally(() => {
    if (!settled) {
      restoreTerminal();
      controller.clear();
    }
  });
}

async function readSecretWithSetupConsole(
  question: string,
  options: SetupConsolePromptAdapterOptions,
  controller: SetupOperatorConsoleController,
  locale: string | undefined
): Promise<string> {
  const ttyInput = options.input as TtyReadable;
  const secret = new SecretPromptController({
    label: question,
    maskCharacter: "•",
  });
  let settled = false;
  let restored = false;
  let cursorHidden = false;
  const wasRaw = ttyInput.isRaw === true;
  const normalizedLocale = locale === "ar" ? "ar" : "en";

  const render = () => {
    const renderState = secret.renderState;
    const copy = secretPanelCopy(normalizedLocale);
    controller.render({
      kind: "secret",
      title: secretPanelTitle(question, normalizedLocale),
      description: secretPanelDescription(question, copy),
      maskedValue: renderState.maskedText,
      envVar: secretPanelEnvVar(question),
      optional: true,
      emptyLabel: copy.emptyLabel,
      locale: normalizedLocale,
      footer: copy.footer,
    });
  };

  const restoreTerminal = () => {
    if (restored) return;
    restored = true;
    keypressDispatcher.dispose();
    ttyInput.off("data", onData);
    if (!wasRaw) {
      ttyInput.setRawMode?.(false);
    }
    if (cursorHidden) {
      options.output.write(SHOW_CURSOR);
      cursorHidden = false;
    }
  };

  const finish = (value: string, resolve: (value: string) => void) => {
    if (settled) return;
    settled = true;
    restoreTerminal();
    controller.clear();
    resolve(value);
  };

  const onData = (chunk: string | Buffer | Uint8Array) => {
    keypressDispatcher.handle(chunk);
  };

  const pendingKeypresses: ParsedKeypress[] = [];
  let resolveSecret: ((value: string) => void) | undefined;

  const drainKeypresses = () => {
    if (resolveSecret === undefined || settled) return;
    for (const keypress of pendingKeypresses.splice(0)) {
      const result = secret.apply(keypress);
      render();
      if (result.intent?.type === "submit") {
        finish(result.intent.value, resolveSecret);
        return;
      }
      if (result.intent?.type === "cancel" || result.intent?.type === "eof") {
        finish("", resolveSecret);
        return;
      }
    }
  };

  const keypressDispatcher = createKeypressStreamDispatcher({
    onEvents: (events) => {
      pendingKeypresses.push(...events);
      drainKeypresses();
    },
  });

  return await new Promise<string>((resolve) => {
    resolveSecret = resolve;
    ttyInput.on("data", onData);
    ttyInput.setRawMode?.(true);
    ttyInput.resume?.();
    options.output.write(HIDE_CURSOR);
    cursorHidden = true;
    render();
    drainKeypresses();
  }).finally(() => {
    if (!settled) {
      restoreTerminal();
      controller.clear();
    }
  });
}

async function readTextWithSetupConsole(
  question: string,
  promptOptions: PromptOptions | undefined,
  options: SetupConsolePromptAdapterOptions,
  controller: SetupOperatorConsoleController,
  locale: string | undefined
): Promise<string> {
  const ttyInput = options.input as TtyReadable;
  let state: LineEditorState = createLineEditorState();
  let settled = false;
  let restored = false;
  let cursorHidden = false;
  const wasRaw = ttyInput.isRaw === true;
  const normalizedLocale = locale === "ar" ? "ar" : "en";
  const copy = textPanelCopy(normalizedLocale);

  const render = () => {
    controller.render({
      kind: "textInput",
      title: textPanelTitle(question, normalizedLocale),
      description: textPanelDescription(question, copy),
      value: state.text,
      placeholder: promptOptions?.placeholder ?? copy.emptyLabel,
      locale: normalizedLocale,
      footer: copy.footer,
    });
  };

  const restoreTerminal = () => {
    if (restored) return;
    restored = true;
    keypressDispatcher.dispose();
    ttyInput.off("data", onData);
    if (!wasRaw) {
      ttyInput.setRawMode?.(false);
    }
    if (cursorHidden) {
      options.output.write(SHOW_CURSOR);
      cursorHidden = false;
    }
  };

  const finish = (value: string, resolve: (value: string) => void) => {
    if (settled) return;
    settled = true;
    restoreTerminal();
    controller.clear();
    resolve(value);
  };

  const onData = (chunk: string | Buffer | Uint8Array) => {
    keypressDispatcher.handle(chunk);
  };

  const pendingKeypresses: ParsedKeypress[] = [];
  let resolveText: ((value: string) => void) | undefined;

  const drainKeypresses = () => {
    if (resolveText === undefined || settled) return;
    for (const keypress of pendingKeypresses.splice(0)) {
      const previousText = state.text;
      const result = applyKeypress(state, keypress);
      state = result.state;
      if (state.text !== previousText) {
        promptOptions?.onInputChange?.(state.text);
      }
      render();
      if (result.intent?.type === "submit") {
        finish(result.intent.text, resolveText);
        return;
      }
      if (result.intent?.type === "cancel" || result.intent?.type === "eof") {
        finish("", resolveText);
        return;
      }
    }
  };

  const keypressDispatcher = createKeypressStreamDispatcher({
    onEvents: (events) => {
      pendingKeypresses.push(...events);
      drainKeypresses();
    },
  });

  return await new Promise<string>((resolve) => {
    resolveText = resolve;
    ttyInput.on("data", onData);
    ttyInput.setRawMode?.(true);
    ttyInput.resume?.();
    controller.clear();
    options.output.write(HIDE_CURSOR);
    cursorHidden = true;
    render();
    drainKeypresses();
  }).finally(() => {
    if (!settled) {
      restoreTerminal();
      controller.clear();
    }
  });
}

function shouldUseSetupConsole<T>(
  selection: SelectPromptInput<T>,
  input: Readable,
  output: SetupOperatorConsoleOutput
): boolean {
  return selection.surface === "promptCard" &&
    selection.options.length > 0 &&
    hasLiveSetupConsole(input, output);
}

function hasLiveSetupConsole(
  input: Readable,
  output: SetupOperatorConsoleOutput
): boolean {
  return Boolean((input as TtyReadable).isTTY && output.isTTY);
}

function renderOnboardingCardWithSetupConsole(
  card: BuildOnboardingPromptCardInput,
  controller: SetupOperatorConsoleController
): void {
  controller.render(onboardingCardToSetupPanel(card));
}

function onboardingCardToSetupPanel(card: BuildOnboardingPromptCardInput): SetupPanelState {
  const locale = card.locale === "ar" ? "ar" : "en";
  const bodyLines = card.bodyLines
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const description = bodyLines.join("\n");
  const technicalStatusLines = (card.technicalLines ?? [])
    .filter((line) => line.trim().length > 0)
    .map((line) => ({ text: line, tone: "muted" as const, direction: "ltr" as const }));
  const selectedIndex = normalizeIndex(card.selectedOptionIndex, card.options.length);
  const selected = card.options[selectedIndex];
  const descriptionFields = description.length > 0 ? { description } : {};
  const selectedRowFields = selected === undefined ? {} : { selectedRowId: onboardingCardOptionId(selected, selectedIndex) };
  return {
    kind: "table",
    layout: "choiceMenu",
    title: card.title,
    ...descriptionFields,
    locale,
    statusLines: [
      ...(card.statusLines ?? []),
      ...technicalStatusLines,
    ],
    rows: card.options.map((option, index) => {
      const details = option.description ?? option.cells?.details ?? option.badges?.join(" · ") ?? "";
      const badges = option.description === undefined && option.cells?.details === undefined
        ? ""
        : option.badges?.join(" · ") ?? "";
      return {
        id: onboardingCardOptionId(option, index),
        provider: option.label,
        model: "",
        status: details,
        notes: badges,
        ...(option.group === undefined ? {} : { group: option.group }),
      };
    }),
    ...selectedRowFields,
    footer: card.hint ?? "",
  };
}

function onboardingCardOptionId(
  option: BuildOnboardingPromptCardInput["options"][number],
  index: number
): string {
  return option.id || `option-${index}`;
}

function secretPanelTitle(question: string, locale: "en" | "ar"): string {
  const normalized = normalizePromptQuestion(question);
  if (/api key|مفتاح\s*api/iu.test(normalized)) {
    return locale === "ar" ? "مفتاح API" : "API key";
  }
  return locale === "ar" ? "إدخال سرّي" : "Secret entry";
}

function secretPanelDescription(
  question: string,
  copy: ReturnType<typeof secretPanelCopy>
): string {
  return normalizePromptQuestion(question) || copy.description;
}

function secretPanelEnvVar(question: string): string | undefined {
  const normalized = normalizePromptQuestion(question);
  const candidates = normalized.match(/\b[A-Z][A-Z0-9_]{2,}\b/gu) ?? [];
  return candidates.find((candidate) => candidate.includes("_") && /(?:API|KEY|TOKEN|SECRET|PROJECT)/u.test(candidate)) ??
    candidates.find((candidate) => /(?:KEY|TOKEN|SECRET|PROJECT)/u.test(candidate));
}

function textPanelTitle(question: string, locale: "en" | "ar"): string {
  const normalized = normalizePromptQuestion(question);
  if (/workspace|مساحة\s*العمل|مجلد\s*العمل/iu.test(normalized)) {
    return locale === "ar" ? "مساحة العمل" : "Workspace";
  }
  if (/\b(?:base url|endpoint|url)\b|الرابط|نقطة\s*النهاية/iu.test(normalized)) {
    return locale === "ar" ? "الرابط" : "Endpoint";
  }
  if (/\bmodel\b|النموذج/iu.test(normalized)) {
    return locale === "ar" ? "النموذج" : "Model";
  }
  if (/\benv(?:ironment)?\b|متغير/iu.test(normalized)) {
    return locale === "ar" ? "متغير بيئة" : "Environment variable";
  }
  return locale === "ar" ? "إدخال نص" : "Text input";
}

function textPanelDescription(
  question: string,
  copy: ReturnType<typeof textPanelCopy>
): string {
  return normalizePromptQuestion(question) || copy.description;
}

function normalizePromptQuestion(question: string): string {
  return question
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, "")
    .replace(/[\u2066\u2067\u2069]/gu, "")
    .replace(/\s+/gu, " ")
    .replace(/\s*[:：]\s*$/u, "")
    .trim();
}

function textPanelCopy(locale: "en" | "ar"): {
  readonly description: string;
  readonly emptyLabel: string;
  readonly footer: string;
} {
  return locale === "ar"
    ? {
        description: "أدخل القيمة المطلوبة.",
        emptyLabel: "[اتركه فارغًا]",
        footer: "Enter حفظ · Ctrl+C إلغاء",
      }
    : {
        description: "Enter the requested value.",
        emptyLabel: "[leave empty]",
        footer: "Enter save · Ctrl+C cancel",
      };
}

function secretPanelCopy(locale: "en" | "ar"): {
  readonly description: string;
  readonly emptyLabel: string;
  readonly footer: string;
} {
  return locale === "ar"
    ? {
        description: "أدخل القيمة السرّية دون عرضها.",
        emptyLabel: "[اتركه فارغًا]",
        footer: "Enter حفظ · Esc إلغاء · Ctrl+C إلغاء",
      }
    : {
        description: "Enter the secret value without showing it.",
        emptyLabel: "[leave empty]",
        footer: "Enter save · Esc cancel · Ctrl+C cancel",
      };
}

function createSetupSelectState<T>(selection: SelectPromptInput<T>): SelectNavigationState<string, number> {
  const defaultIndex = normalizeIndex(selection.defaultIndex, selection.options.length);
  return createSelectNavigationState(
    selection.options.map((option, index) => ({
      kind: "option",
      value: String(index),
      label: option.label,
      metadata: index,
    })),
    {
      focusedValue: String(defaultIndex),
      selectedValue: String(defaultIndex),
    }
  );
}

function focusedSelectionIndex(state: SelectNavigationState<string, number>): number {
  return getFocusedOption(state)?.metadata ?? 0;
}

function selectKeyEventFromParsedKeypress(keypress: ParsedKeypress): SelectKeyEvent | undefined {
  if (keypress.type !== "key") return undefined;
  switch (keypress.key) {
    case "down":
      return { key: "arrowDown" };
    case "up":
      return { key: "arrowUp" };
    case "pagedown":
      return { key: "pageDown" };
    case "pageup":
      return { key: "pageUp" };
    case "home":
      return { key: "home" };
    case "end":
      return { key: "end" };
    case "enter":
      return { key: "enter" };
    case "tab":
      return keypress.shift === true ? { key: "backtab" } : { key: "tab" };
    case "escape":
      return { key: "escape" };
    default:
      return undefined;
  }
}

function normalizeIndex(value: number | undefined, optionCount: number): number {
  if (optionCount <= 0 || value === undefined || !Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.floor(value), 0), optionCount - 1);
}
