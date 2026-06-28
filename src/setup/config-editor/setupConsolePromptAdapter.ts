import type { Readable, Writable } from "node:stream";
import type { SelectPromptInput } from "../../cli/interactive-select.js";
import type { Prompt, PromptOptions, PromptSubmission } from "../../cli/prompt-contract.js";
import { parseKeypress, type ParsedKeypress } from "../../ui/input/parseKeypress.js";
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

export function withSetupConsolePrompt(
  prompt: Prompt,
  options: SetupConsolePromptAdapterOptions
): Prompt {
  let ownedController: SetupOperatorConsoleController | undefined;
  const getController = () => {
    if (options.controller !== undefined) return options.controller;
    ownedController ??= options.createController?.({ output: options.output }) ??
      createSetupOperatorConsoleController({ output: options.output });
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
    async (question: string, promptOptions?: PromptOptions) => prompt(question, promptOptions),
    {
      uiContext: prompt.uiContext,
      submit: prompt.submit === undefined
        ? undefined
        : async (question: string, promptOptions?: PromptOptions): Promise<PromptSubmission> =>
          prompt.submit!(question, promptOptions),
      select,
      onboardingCard: prompt.onboardingCard === undefined
        ? undefined
        : prompt.onboardingCard,
      close: () => {
        options.controller?.clear();
        ownedController?.clear();
        prompt.close?.();
      },
    }
  );
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
    process.emit("SIGINT");
    reject(new Error("Setup console selection interrupted."));
  };

  const onData = (chunk: string | Buffer | Uint8Array) => {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    pendingKeypresses.push(...parseKeypress(text));
    drainKeypresses();
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

function shouldUseSetupConsole<T>(
  selection: SelectPromptInput<T>,
  input: Readable,
  output: SetupOperatorConsoleOutput
): boolean {
  return selection.surface === "promptCard" &&
    selection.columns !== undefined &&
    selection.options.length > 0 &&
    Boolean((input as TtyReadable).isTTY && output.isTTY);
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
