import type { LineEditorState } from "../../input/lineEditor.js";
import type { FocusState } from "./focusModel.js";
import {
  createInitialOperatorConsoleState,
  type AttachmentCardState,
  type OperatorConsoleState,
  type PromptSurfaceState,
  type SlashMenuState,
  type StatusRailState,
  type SteerState,
  type TerminalMetrics,
  type ToolActivityState,
  type TurnActivityState,
} from "./operatorConsoleState.js";
import { createOperatorConsoleLayout } from "./operatorConsoleLayout.js";
import { getPromptSurfaceMetrics } from "./promptSurface.js";
import { renderOperatorConsoleTextLines } from "./operatorConsoleRenderer.js";
import {
  type OperatorConsoleRuntimeFrame,
  type OperatorConsoleRuntimeHost,
} from "./operatorConsoleRuntimeHost.js";
import type { OperatorConsoleStyle } from "./operatorConsoleStyle.js";

export type OperatorConsoleRawPromptSnapshot = {
  readonly prompt: string;
  readonly state: LineEditorState;
  readonly status?: StatusRailState;
  readonly terminal?: Partial<TerminalMetrics>;
  readonly attachments?: readonly AttachmentCardState[];
  readonly turnActivity?: TurnActivityState;
  readonly slash?: SlashMenuState;
  readonly activeWork?: ToolActivityState;
  readonly steer?: SteerState;
  readonly promptMode?: PromptSurfaceState["mode"];
  readonly placeholder?: string;
  readonly style?: OperatorConsoleStyle;
  readonly focus?: FocusState;
};

export type OperatorConsoleRawPromptFrame = {
  readonly rows: readonly string[];
  readonly cursorRow: number;
  readonly cursorColumn: number;
  readonly state: OperatorConsoleState;
};

const DEFAULT_TERMINAL: TerminalMetrics = {
  width: 80,
  height: 24,
  isTty: true,
};

export function buildOperatorConsoleStateFromRawPrompt(
  snapshot: OperatorConsoleRawPromptSnapshot
): OperatorConsoleState {
  const terminal = normalizeTerminal(snapshot.terminal);
  return createInitialOperatorConsoleState({
    terminal,
    prompt: {
      value: snapshot.state.text,
      cursorOffset: snapshot.state.cursor,
      multiline: snapshot.state.text.includes("\n"),
      scrollOffset: 0,
      mode: snapshot.promptMode ?? "prompt",
      ...(snapshot.placeholder === undefined ? {} : { placeholder: snapshot.placeholder }),
    },
    status: snapshot.status ?? createDefaultOperatorConsoleRawPromptStatus(),
    turnActivity: snapshot.turnActivity,
    attachments: snapshot.attachments ?? [],
    activeWork: snapshot.activeWork,
    steer: snapshot.steer,
    focus: snapshot.focus,
    style: snapshot.style,
    ...(snapshot.slash === undefined ? {} : { slash: snapshot.slash }),
  });
}

export function buildOperatorConsoleRawPromptFrame(
  snapshot: OperatorConsoleRawPromptSnapshot
): OperatorConsoleRawPromptFrame {
  const state = buildOperatorConsoleStateFromRawPrompt(snapshot);
  const layout = createOperatorConsoleLayout(state, state.terminal);
  const renderedRows = renderOperatorConsoleTextLines(state, layout);
  const promptRegion = layout.regions.find((region) => region.kind === "prompt");
  const cursor = promptRegion === undefined
    ? { row: 0, column: 0 }
    : getPromptCursorPosition(state, promptRegion.y, promptRegion.height);

  return {
    rows: renderedRows,
    cursorRow: cursor.row,
    cursorColumn: cursor.column,
    state,
  };
}

export function buildOperatorConsoleRawPromptFrameWithRuntimeHost(
  host: OperatorConsoleRuntimeHost,
  snapshot: OperatorConsoleRawPromptSnapshot
): OperatorConsoleRawPromptFrame {
  const terminal = normalizeTerminal(snapshot.terminal);
  host.clear();
  host.setTerminal(terminal);
  host.setStatus(snapshot.status ?? createDefaultOperatorConsoleRawPromptStatus());
  host.setTurnActivity(snapshot.turnActivity);
  host.setAttachments(snapshot.attachments ?? []);
  host.setSlash(snapshot.slash);
  host.setActiveWork(snapshot.activeWork ?? createInitialOperatorConsoleState().activeWork);
  host.setSteer(snapshot.steer);
  host.setFocus(snapshot.focus ?? createInitialOperatorConsoleState().focus);
  if (snapshot.style !== undefined) {
    host.setStyle(snapshot.style);
  }
  host.setPrompt({
    text: snapshot.state.text,
    cursorOffset: snapshot.state.cursor,
    multiline: snapshot.state.text.includes("\n"),
    scrollOffset: 0,
    mode: snapshot.promptMode ?? "prompt",
    placeholder: snapshot.placeholder,
  });
  return rawPromptFrameFromRuntimeFrame(host.render());
}

export function createDefaultOperatorConsoleRawPromptStatus(): StatusRailState {
  return {
    model: {
      label: "",
      state: "idle",
      route: "primary",
    },
    context: {
      usedTokens: 0,
    },
    sessionTimer: {
      elapsedMs: 0,
    },
  };
}

function rawPromptFrameFromRuntimeFrame(frame: OperatorConsoleRuntimeFrame): OperatorConsoleRawPromptFrame {
  const promptRegion = frame.layout.regions.find((region) => region.kind === "prompt");
  const cursor = promptRegion === undefined
    ? { row: 0, column: 0 }
    : getPromptCursorPosition(frame.state, promptRegion.y, promptRegion.height);

  return {
    rows: frame.lines,
    cursorRow: cursor.row,
    cursorColumn: cursor.column,
    state: frame.state,
  };
}

function getPromptCursorPosition(
  state: OperatorConsoleState,
  promptRegionY: number,
  promptRegionHeight: number
): { readonly row: number; readonly column: number } {
  if (promptRegionHeight < 3) return { row: promptRegionY, column: 0 };
  const metrics = getPromptSurfaceMetrics(state.prompt, {
    width: state.terminal.width,
    height: promptRegionHeight,
    terminalHeight: state.terminal.height,
  });
  const visibleCursorRow = Math.max(0, metrics.cursorRow - metrics.scrollOffset);
  return {
    row: promptRegionY + 1 + visibleCursorRow,
    column: metrics.cursorColumn,
  };
}

function normalizeTerminal(input: Partial<TerminalMetrics> | undefined): TerminalMetrics {
  return {
    width: normalizeDimension(input?.width, DEFAULT_TERMINAL.width),
    height: normalizeDimension(input?.height, DEFAULT_TERMINAL.height),
    isTty: input?.isTty ?? DEFAULT_TERMINAL.isTty,
  };
}

function normalizeDimension(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
