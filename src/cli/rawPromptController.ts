import type { Writable } from "node:stream";
import { promptUiContextForLocale, type PromptUiContext } from "../contracts/ui.js";
import { commandRegistry } from "./command-registry.js";
import type { ParsedKeypress } from "../ui/input/parseKeypress.js";
import { createKeypressStreamDispatcher, type KeypressStreamDispatcher } from "../ui/input/keyPressStreamDispatcher.js";
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
import { RawPromptOverlayHost, RawPromptRenderLoop, type RawPromptOperatorConsoleOptions } from "./rawPromptRenderLoop.js";
import { buildRawPromptSlashAutocompleteRows } from "./rawPromptSlashAutocomplete.js";
import type { Prompt, PromptOptions } from "./prompt-contract.js";
import { type GhostTextState, isGhostTextVisible } from "../ui/papyrus/input/ghostTextController.js";
import {
  applyPapyrusVimKeymap,
  createPapyrusVimKeymapState,
  type PapyrusVimKeymapState,
} from "../ui/papyrus/input/vim/vimKeymap.js";
import {
  createInitialFocusState,
  createInitialOperatorConsoleState,
  createPastedTextAttachment,
  formatSubmittedPromptWithAttachmentContent,
  formatSubmittedPromptWithAttachmentPreview,
  removeAttachmentAndRepairFocus,
  routeAttachmentKey,
  resolveOperatorConsoleInputSurface,
  routeTaskSurfaceKey,
  type AttachmentCardState,
  type FocusState,
  type SlashMenuState,
  type TaskSurfaceState,
} from "../ui/papyrus/operator-console/index.js";

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
  columns?: number;
  rows?: number;
};

export type RawPromptResult =
  | {
      type: "submit";
      text: string;
      displayText?: string;
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
  operatorConsole?: RawPromptOperatorConsoleOptions;
  escapeCancels?: boolean;
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
  readonly #operatorConsole: RawPromptOperatorConsoleOptions | undefined;
  readonly #escapeCancels: boolean;

  constructor(options: RawPromptControllerOptions) {
    this.#input = options.input;
    this.#output = options.output;
    this.#overlayHost = options.overlayHost ?? new RawPromptOverlayHost();
    this.#typeahead = options.typeahead;
    this.#ghostText = options.ghostText;
    this.#keymap = options.keymap;
    this.#operatorConsole = options.operatorConsole;
    this.#escapeCancels = options.escapeCancels ?? true;
    this.#lifecycle = options.lifecycle ?? createTerminalLifecycle({
      stdin: options.input,
      stdout: options.output,
    });
  }

  async read(question: string, options?: PromptOptions): Promise<RawPromptResult> {
    const renderLoop = new RawPromptRenderLoop(this.#output);
    let state = createLineEditorState();
    let attachmentSequence = 0;
    let attachments: readonly AttachmentCardState[] = [];
    let attachmentFocus: FocusState = createInitialFocusState();
    let taskSurface: TaskSurfaceState = { cards: [], scrollOffset: 0 };
    let vimKeymapState: PapyrusVimKeymapState | undefined =
      this.#keymap?.mode === "vim" ? createPapyrusVimKeymapState() : undefined;
    let typeaheadState: TypeaheadState<SlashCommandSuggestionMetadata> = createTypeaheadControllerState();
    let statusTicker: ReturnType<typeof setInterval> | undefined;
    const stopStatusTicker = () => {
      if (statusTicker === undefined) return;
      clearInterval(statusTicker);
      statusTicker = undefined;
    };
    const render = () => {
      const cards = this.#operatorConsole?.getTasks?.() ?? this.#operatorConsole?.tasks?.cards ?? taskSurface.cards;
      const selectedTaskId = cards.some((card) => card.taskId === taskSurface.selectedTaskId)
        ? taskSurface.selectedTaskId
        : cards[0]?.taskId;
      const inspectedTaskId = cards.some((card) => card.taskId === taskSurface.inspectedTaskId)
        ? taskSurface.inspectedTaskId
        : undefined;
      taskSurface = {
        cards,
        ...(selectedTaskId === undefined ? {} : { selectedTaskId }),
        ...(inspectedTaskId === undefined ? {} : { inspectedTaskId }),
        scrollOffset: inspectedTaskId === undefined ? 0 : taskSurface.scrollOffset,
      };
      const slashMenu = this.#operatorConsole?.enabled === true
        ? typeaheadStateToSlashMenu(typeaheadState)
        : undefined;
      const fallbackRows = this.#operatorConsole?.enabled === true ? [] : this.#overlayHost.getRows();
      const rows = renderLoop.render({
        prompt: question,
        state,
        ghostText: fallbackRows.length === 0 && slashMenu === undefined ? ghostTextForRender(this.#ghostText, state) : undefined,
        fallbackRows,
        operatorConsole: this.#operatorConsole?.enabled === true
          ? {
            ...this.#operatorConsole,
            terminal: {
              width: this.#operatorConsole.terminal?.width ?? this.#output.columns ?? 80,
              height: this.#operatorConsole.terminal?.height ?? this.#output.rows ?? 24,
              isTty: this.#operatorConsole.terminal?.isTty ?? this.#output.isTTY ?? true,
            },
            attachments,
            tasks: taskSurface,
            slash: slashMenu,
            placeholder: options?.placeholder,
            focus: attachmentFocus,
          }
          : undefined,
      });
      options?.onRowsChange?.(rows);
    };

    render();

    try {
      this.#lifecycle.start();
    } catch (error) {
      stopStatusTicker();
      renderLoop.clear();
      this.#lifecycle.stop();
      throw error;
    }
    if (this.#operatorConsole?.enabled === true &&
        (this.#operatorConsole.getStatus !== undefined || this.#operatorConsole.getTasks !== undefined)) {
      statusTicker = setInterval(render, 1000);
    }

    return await new Promise<RawPromptResult>((resolve, reject) => {
      let settled = false;

      const notifyTypeahead = () => {
        if (this.#operatorConsole?.enabled === true) {
          this.#overlayHost.clear();
        } else {
          this.#overlayHost.setRows(buildRawPromptSlashAutocompleteRows(typeaheadState));
        }
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

        if ((event.key === "enter" && event.alt !== true) || event.key === "tab") {
          return acceptFocusedTypeaheadSuggestion();
        }

        return false;
      };

      let keypressDispatcher: KeypressStreamDispatcher | undefined;

      const cleanup = () => {
        keypressDispatcher?.dispose();
        stopStatusTicker();
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

      const addPasteAttachment = (text: string) => {
        attachmentSequence += 1;
        attachments = [
          ...attachments,
          createPastedTextAttachment({
            id: `paste-${attachmentSequence}`,
            content: text,
          }),
        ];
        this.#operatorConsole?.onAttachmentsChange?.(attachments);
        render();
      };

      const removeAttachment = (attachmentId: string) => {
        const nextState = removeAttachmentAndRepairFocus(createInitialOperatorConsoleState({
          attachments,
          focus: attachmentFocus,
        }), attachmentId);
        attachments = nextState.attachments;
        attachmentFocus = nextState.focus;
        this.#operatorConsole?.onAttachmentsChange?.(attachments);
        render();
      };

      const handleEmptyPromptAttachmentClear = (event: ParsedKeypress) => {
        if (
          this.#operatorConsole?.enabled !== true
          || attachments.length === 0
          || state.text.length > 0
          || event.type !== "key"
          || event.ctrl !== true
          || event.key !== "u"
        ) {
          return false;
        }

        const attachmentId = attachmentFocus.target.kind === "attachment"
          ? attachmentFocus.target.attachmentId
          : attachments.at(-1)?.id;
        if (attachmentId === undefined) return false;
        removeAttachment(attachmentId);
        return true;
      };

      const handleAttachmentKeypress = (event: ParsedKeypress) => {
        if (this.#operatorConsole?.enabled !== true || attachments.length === 0 || event.type !== "key") return false;
        if (attachmentFocus.target.kind === "prompt" && event.key !== "tab") return false;
        if (attachmentFocus.target.kind === "prompt" && event.key === "tab" && isTypeaheadActive()) return false;

        const routed = routeAttachmentKey(createInitialOperatorConsoleState({
          attachments,
          focus: attachmentFocus,
        }), event);
        attachmentFocus = routed.state.focus;
        const intent = routed.intent;

        if (intent.type === "none") {
          render();
          return true;
        }

        if (intent.type === "openPreview") {
          const attachment = attachments.find((candidate) => candidate.id === intent.attachmentId);
          if (attachment !== undefined) this.#operatorConsole.onAttachmentPreview?.(attachment);
          render();
          return true;
        }

        if (intent.type === "remove") {
          removeAttachment(intent.attachmentId);
          return true;
        }

        finish(formatSubmittedText(state.text));
        return true;
      };

      const handleTaskKeypress = (event: ParsedKeypress, modalOnly = false) => {
        if (this.#operatorConsole?.enabled !== true || taskSurface.cards.length === 0) return false;
        const inspectionOpen = taskSurface.inspectedTaskId !== undefined;
        if (modalOnly && !inspectionOpen) return false;
        if (inspectionOpen && event.type !== "key") return true;
        const routed = routeTaskSurfaceKey(createInitialOperatorConsoleState({
          locale: this.#operatorConsole.locale,
          terminal: {
            width: this.#operatorConsole.terminal?.width ?? this.#output.columns ?? 80,
            height: this.#operatorConsole.terminal?.height ?? this.#output.rows ?? 24,
            isTty: this.#operatorConsole.terminal?.isTty ?? this.#output.isTTY ?? true,
          },
          attachments,
          tasks: taskSurface,
          focus: attachmentFocus,
        }), event);
        if (!routed.handled) return false;
        taskSurface = routed.state.tasks;
        attachmentFocus = routed.state.focus;
        render();
        return true;
      };

      const formatSubmittedText = (text: string): RawPromptResult => {
        if (this.#operatorConsole?.enabled !== true || attachments.length === 0) {
          return { type: "submit", text };
        }
        return {
          type: "submit",
          text: formatSubmittedPromptWithAttachmentContent(text, attachments),
          displayText: formatSubmittedPromptWithAttachmentPreview(text, attachments),
        };
      };

      const dispatchParsedEvents = (events: readonly ParsedKeypress[]) => {
        if (settled) return;
        for (const event of events) {
          if (handleTaskKeypress(event, true)) continue;
          if (this.#operatorConsole?.enabled === true && event.type === "paste") {
            addPasteAttachment(event.text);
            continue;
          }
          if (handleEmptyPromptAttachmentClear(event)) continue;
          const inputSurface = resolveOperatorConsoleInputSurface({
            taskInspection: false,
            approval: false,
            typeahead: isTypeaheadActive(),
            attachment: attachmentFocus.target.kind === "attachment" ||
              (attachments.length > 0 && event.type === "key" && event.key === "tab"),
          });
          if (inputSurface === "typeahead" && handleTypeaheadKeypress(event)) continue;
          if (inputSurface === "attachment" && handleAttachmentKeypress(event)) continue;
          if (handleTaskKeypress(event)) continue;
          if (vimKeymapState !== undefined) {
            const vimResult = applyPapyrusVimKeymap(vimKeymapState, state, event);
            vimKeymapState = vimResult.state;
            if (vimResult.handled) {
              updateState(vimResult.line);
              continue;
            }
          }
          if (this.#escapeCancels && event.type === "key" && event.key === "escape") {
            finish({ type: "cancel" });
            return;
          }
          const result = applyKeypress(state, event);
          if (result.intent?.type === "submit") {
            finish(formatSubmittedText(result.intent.text));
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
          updateState(result.state);
        }
      };

      keypressDispatcher = createKeypressStreamDispatcher({ onEvents: dispatchParsedEvents });

      const onData = (chunk: string | Buffer | Uint8Array) => {
        if (settled) return;
        keypressDispatcher?.handle(chunk);
      };

      this.#input.on("data", onData);
      this.#input.resume?.();
    });
  }
}

export function createRawPrompt(options: RawPromptControllerOptions & { uiContext?: PromptUiContext }): Prompt {
  const controller = new RawPromptController(options);
  const uiContext = options.uiContext ?? promptUiContextForLocale("en");
  const submit = async (question: string, promptOptions?: PromptOptions) => {
    const result = await controller.read(question, promptOptions);
    if (result.type === "submit") {
      return {
        text: result.text,
        ...(result.displayText === undefined ? {} : { displayText: result.displayText }),
      };
    }
    return { text: "/exit" };
  };

  return Object.assign(
    async (question: string, promptOptions?: PromptOptions) => {
      return (await submit(question, promptOptions)).text;
    },
    {
      uiContext,
      submit,
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

function typeaheadStateToSlashMenu(
  state: TypeaheadState<SlashCommandSuggestionMetadata>
): SlashMenuState | undefined {
  switch (state.status) {
    case "loading":
      return {
        query: state.context?.token ?? "",
        items: [{ id: "slash.loading", label: "Loading slash commands..." }],
        activeItemId: "slash.loading",
      };
    case "empty":
      return {
        query: state.context?.token ?? "",
        items: [{ id: "slash.empty", label: "No slash commands found" }],
        activeItemId: "slash.empty",
      };
    case "error":
      return {
        query: state.context?.token ?? "",
        items: [{ id: "slash.error", label: `Slash suggestions unavailable: ${state.error?.message ?? "unknown error"}` }],
        activeItemId: "slash.error",
      };
    case "open": {
      const activeItemId = state.focusedIndex === undefined ? undefined : state.items[state.focusedIndex]?.id;
      return {
        query: state.context?.token ?? "",
        items: state.items.map((item) => ({
          id: item.id,
          label: item.label,
          ...(item.description === undefined && item.detail === undefined
            ? {}
            : { detail: item.description ?? item.detail }),
        })),
        ...(activeItemId === undefined ? {} : { activeItemId }),
      };
    }
    case "closed":
    case "canceled":
    case "dismissed":
      return undefined;
  }
}
