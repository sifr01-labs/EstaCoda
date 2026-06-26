import type { Writable } from "node:stream";
import { promptUiContextForLocale, type PromptUiContext } from "../contracts/ui.js";
import { commandRegistry } from "./command-registry.js";
import { parseKeypress, type ParsedKeypress } from "../ui/input/parseKeypress.js";
import { applyKeypress, createLineEditorState, type LineEditorState } from "../ui/input/lineEditor.js";
import { createTerminalLifecycle, type TerminalLifecycle } from "../ui/input/terminalLifecycle.js";
import { createSlashCommandSuggestionProvider, type SlashCommandSuggestionMetadata } from "../ui/papyrus/input/providers/slashCommandProvider.js";
import {
  applyTypeaheadResult,
  createTypeaheadControllerState,
  dismissTypeahead,
  focusNextSuggestion,
  focusPreviousSuggestion,
  requestTypeaheadSuggestions,
  selectFocusedSuggestion,
  type TypeaheadState,
} from "../ui/papyrus/input/typeaheadController.js";
import {
  createTypeaheadProviderRouter,
  type TypeaheadProviderRouter,
} from "../ui/papyrus/input/typeaheadProviderRouter.js";
import { RawPromptOverlayHost, RawPromptRenderLoop } from "./rawPromptRenderLoop.js";
import { buildRawPromptSlashAutocompleteRows } from "./rawPromptSlashAutocomplete.js";
import type { Prompt, PromptOptions } from "./prompt-contract.js";
import { type GhostTextState, isGhostTextVisible } from "../ui/papyrus/input/ghostTextController.js";
import {
  applyPapyrusVimKeymap,
  createPapyrusVimKeymapState,
  type PapyrusVimKeymapState,
} from "../ui/papyrus/input/vim/vimKeymap.js";

type RawPromptDataListener = (chunk: string | Buffer | Uint8Array) => void;

export type RawPromptInput = {
  on(event: "data", listener: RawPromptDataListener): unknown;
  off?: (event: "data", listener: RawPromptDataListener) => unknown;
  removeListener?: (event: "data", listener: RawPromptDataListener) => unknown;
  resume?: () => unknown;
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => unknown;
};

export type RawPromptOutput = Pick<Writable, "write"> & {
  isTTY?: boolean;
};

export type RawPromptResult =
  | {
      type: "submit";
      text: string;
    }
  | {
      type: "cancel";
    }
  | {
      type: "eof";
    };

export type RawPromptControllerOptions = {
  input: RawPromptInput;
  output: RawPromptOutput;
  lifecycle?: TerminalLifecycle;
  overlayHost?: RawPromptOverlayHost;
  typeahead?: RawPromptTypeaheadOptions;
  ghostText?: RawPromptGhostTextOptions;
  keymap?: RawPromptKeymapOptions;
};

export type RawPromptTypeaheadOptions = {
  readonly router: TypeaheadProviderRouter<SlashCommandSuggestionMetadata>;
  readonly onStateChange?: (state: TypeaheadState<SlashCommandSuggestionMetadata>) => void;
};

export type RawPromptGhostTextOptions = {
  readonly enabled: boolean;
  readonly getState?: (state: LineEditorState) => GhostTextState | undefined;
};

export type RawPromptKeymapOptions = {
  readonly mode: "vim";
};

export class RawPromptController {
  readonly #input: RawPromptInput;
  readonly #output: RawPromptOutput;
  readonly #lifecycle: TerminalLifecycle;
  readonly #overlayHost: RawPromptOverlayHost;
  readonly #typeahead: RawPromptTypeaheadOptions | undefined;
  readonly #ghostText: RawPromptGhostTextOptions | undefined;
  readonly #keymap: RawPromptKeymapOptions | undefined;

  constructor(options: RawPromptControllerOptions) {
    this.#input = options.input;
    this.#output = options.output;
    this.#overlayHost = options.overlayHost ?? new RawPromptOverlayHost();
    this.#typeahead = options.typeahead;
    this.#ghostText = options.ghostText;
    this.#keymap = options.keymap;
    this.#lifecycle = options.lifecycle ?? createTerminalLifecycle({
      stdin: options.input,
      stdout: options.output,
    });
  }

  async read(question: string, options?: PromptOptions): Promise<RawPromptResult> {
    const renderLoop = new RawPromptRenderLoop(this.#output);
    let state = createLineEditorState();
    let vimKeymapState: PapyrusVimKeymapState | undefined =
      this.#keymap?.mode === "vim" ? createPapyrusVimKeymapState() : undefined;
    let typeaheadState: TypeaheadState<SlashCommandSuggestionMetadata> = createTypeaheadControllerState();
    const render = () => {
      const overlayRows = this.#overlayHost.getRows();
      const rows = renderLoop.render({
        prompt: question,
        state,
        ghostText: overlayRows.length === 0 ? ghostTextForRender(this.#ghostText, state) : undefined,
        overlayRows,
      });
      options?.onRowsChange?.(rows);
    };

    render();

    try {
      this.#lifecycle.start();
    } catch (error) {
      renderLoop.clear();
      this.#lifecycle.stop();
      throw error;
    }

    return await new Promise<RawPromptResult>((resolve, reject) => {
      let settled = false;

      const notifyTypeahead = () => {
        this.#overlayHost.setRows(buildRawPromptSlashAutocompleteRows(typeaheadState));
        this.#typeahead?.onStateChange?.(typeaheadState);
      };

      const closeTypeahead = () => {
        if (this.#typeahead === undefined) return;
        typeaheadState = {
          ...createTypeaheadControllerState({
            generation: typeaheadState.generation + 1,
          }),
          status: "closed",
        };
        notifyTypeahead();
      };

      const dismissCurrentTypeahead = () => {
        if (this.#typeahead === undefined) return;
        typeaheadState = dismissTypeahead({
          ...typeaheadState,
          generation: typeaheadState.generation + 1,
        }).state;
        notifyTypeahead();
      };

      const updateTypeahead = (nextState: LineEditorState) => {
        if (this.#typeahead === undefined) return;
        const selection = this.#typeahead.router.route({
          input: nextState.text,
          cursorOffset: nextState.cursor,
        });
        if (selection === undefined) {
          closeTypeahead();
          return;
        }

        const request = requestTypeaheadSuggestions(
          typeaheadState,
          selection.context,
          [selection.provider] as const
        );
        typeaheadState = request.state;
        notifyTypeahead();

        void request.result.then((result) => {
          if (settled) return;
          typeaheadState = applyTypeaheadResult(typeaheadState, request.generation, result);
          notifyTypeahead();
          render();
        });
      };

      const isTypeaheadActive = () => {
        return this.#typeahead !== undefined
          && typeaheadState.status !== "closed"
          && typeaheadState.status !== "dismissed"
          && typeaheadState.status !== "canceled";
      };

      const acceptFocusedTypeaheadSuggestion = () => {
        const selected = selectFocusedSuggestion(typeaheadState);
        if (selected.intent?.type !== "replace") return false;
        const nextState = createLineEditorState(
          selected.intent.nextInput,
          selected.intent.replacementRange.start + selected.intent.replacementText.length
        );
        if (nextState.text !== state.text) {
          options?.onInputChange?.(nextState.text);
        }
        state = nextState;
        closeTypeahead();
        render();
        return true;
      };

      const handleTypeaheadKeypress = (event: ParsedKeypress) => {
        if (this.#typeahead === undefined || event.type !== "key" || !isTypeaheadActive()) return false;

        if (event.key === "escape") {
          dismissCurrentTypeahead();
          render();
          return true;
        }

        if (event.key === "up" || (event.ctrl === true && event.key === "p")) {
          typeaheadState = focusPreviousSuggestion(typeaheadState);
          notifyTypeahead();
          render();
          return true;
        }

        if (event.key === "down" || (event.ctrl === true && event.key === "n")) {
          typeaheadState = focusNextSuggestion(typeaheadState);
          notifyTypeahead();
          render();
          return true;
        }

        if (event.key === "enter" || event.key === "tab") {
          return acceptFocusedTypeaheadSuggestion();
        }

        return false;
      };

      const cleanup = () => {
        detachDataListener(this.#input, onData);
        dismissCurrentTypeahead();
        this.#overlayHost.clear();
        renderLoop.clear();
        options?.onRowsChange?.(1);
        const stopResult = this.#lifecycle.stop();
        if (stopResult.errors.length > 0) {
          reject(stopResult.errors[0]);
          return false;
        }
        return true;
      };

      const finish = (result: RawPromptResult) => {
        if (settled) return;
        settled = true;
        if (cleanup()) {
          this.#output.write("\n");
          resolve(result);
        }
      };

      const updateState = (nextState: LineEditorState) => {
        if (nextState.text !== state.text) {
          options?.onInputChange?.(nextState.text);
        }
        state = nextState;
        updateTypeahead(nextState);
        render();
      };

      const onData = (chunk: string | Buffer | Uint8Array) => {
        if (settled) return;
        const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        for (const event of parseKeypress(text)) {
          if (handleTypeaheadKeypress(event)) continue;
          if (vimKeymapState !== undefined) {
            const vimResult = applyPapyrusVimKeymap(vimKeymapState, state, event);
            vimKeymapState = vimResult.state;
            if (vimResult.handled) {
              updateState(vimResult.line);
              continue;
            }
          }
          const result = applyKeypress(state, event);
          updateState(result.state);
          if (result.intent?.type === "submit") {
            finish({ type: "submit", text: result.intent.text });
            return;
          }
          if (result.intent?.type === "cancel") {
            finish({ type: "cancel" });
            return;
          }
          if (result.intent?.type === "eof") {
            finish({ type: "eof" });
            return;
          }
        }
      };

      this.#input.on("data", onData);
      this.#input.resume?.();
    });
  }
}

export function createRawPrompt(options: RawPromptControllerOptions & { uiContext?: PromptUiContext }): Prompt {
  const controller = new RawPromptController(options);
  const uiContext = options.uiContext ?? promptUiContextForLocale("en");

  return Object.assign(
    async (question: string, promptOptions?: PromptOptions) => {
      const result = await controller.read(question, promptOptions);
      if (result.type === "submit") return result.text;
      return "/exit";
    },
    {
      uiContext,
      close: () => undefined,
    }
  );
}

export function createDefaultRawPromptTypeahead(): RawPromptTypeaheadOptions {
  return {
    router: createTypeaheadProviderRouter({
      providers: [
        createSlashCommandSuggestionProvider({
          registry: commandRegistry,
        }),
      ],
    }),
  };
}

function detachDataListener(input: RawPromptInput, listener: RawPromptDataListener): void {
  if (typeof input.off === "function") {
    input.off("data", listener);
    return;
  }
  input.removeListener?.("data", listener);
}

function ghostTextForRender(
  options: RawPromptGhostTextOptions | undefined,
  state: LineEditorState
): { readonly text: string } | undefined {
  if (options?.enabled !== true || options.getState === undefined) return undefined;
  const ghost = options.getState(state);
  if (ghost === undefined || !isGhostTextVisible(ghost)) return undefined;
  if (ghost.input !== state.text || ghost.cursorOffset !== state.cursor) return undefined;
  if (ghost.suggestionText === undefined || ghost.replacementRange === undefined) return undefined;
  const currentText = state.text.slice(ghost.replacementRange.start, ghost.replacementRange.end);
  const text = ghost.suggestionText.startsWith(currentText)
    ? ghost.suggestionText.slice(currentText.length)
    : ghost.suggestionText;
  return text.length === 0 ? undefined : { text };
}
