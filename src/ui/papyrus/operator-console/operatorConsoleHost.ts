import type { LineEditorState } from "../../input/lineEditor.js";
import type { FocusState } from "./focusModel.js";
import {
  createInitialOperatorConsoleState,
  type AttachmentCardState,
  type OperatorConsoleMode,
  type OperatorConsoleState,
  type PromptSurfaceState,
  type SetupSurfaceState,
  type SlashMenuState,
  type StatusRailState,
  type SteerState,
  type StreamingState,
  type TerminalMetrics,
  type TaskSurfaceState,
  type ToolActivityState,
  type TranscriptBlock,
  type TurnActivityState,
} from "./operatorConsoleState.js";
import { createOperatorConsoleLayout, type OperatorConsoleLayout } from "./operatorConsoleLayout.js";
import { getPromptSurfaceMetrics } from "./promptSurface.js";
import { getSteerInputSurfaceMetrics, isSteerInputActive } from "./steerSurface.js";
import { renderOperatorConsoleTextLines } from "./operatorConsoleRenderer.js";
import {
  type OperatorConsoleRuntimeFrame,
  type OperatorConsoleRuntimeHost,
} from "./operatorConsoleRuntimeHost.js";
import type { OperatorConsoleStyle } from "./operatorConsoleStyle.js";

export type OperatorConsoleRawPromptSnapshot = {
  readonly mode?: OperatorConsoleMode;
  readonly locale?: import("./activeWorkCopy.js").OperatorConsoleLocale;
  readonly prompt: string;
  readonly state: LineEditorState;
  readonly status?: StatusRailState;
  readonly motionElapsedMs?: number;
  readonly setupPanel?: SetupSurfaceState;
  readonly terminal?: Partial<TerminalMetrics>;
  readonly transcript?: readonly TranscriptBlock[];
  readonly attachments?: readonly AttachmentCardState[];
  readonly tasks?: TaskSurfaceState;
  readonly turnActivity?: TurnActivityState;
  readonly slash?: SlashMenuState;
  readonly activeWork?: ToolActivityState;
  readonly streaming?: StreamingState;
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
  readonly layout: OperatorConsoleLayout;
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
    mode: snapshot.mode,
    locale: snapshot.locale,
    terminal,
    setupPanel: snapshot.setupPanel,
    prompt: {
      value: snapshot.state.text,
      cursorOffset: snapshot.state.cursor,
      multiline: snapshot.state.text.includes("\n"),
      scrollOffset: 0,
      mode: snapshot.promptMode ?? "prompt",
      ...(snapshot.placeholder === undefined ? {} : { placeholder: snapshot.placeholder }),
    },
    status: snapshot.status ?? createDefaultOperatorConsoleRawPromptStatus(),
    motionElapsedMs: snapshot.motionElapsedMs,
    transcript: snapshot.transcript ?? [],
    turnActivity: snapshot.turnActivity,
    attachments: snapshot.attachments ?? [],
    tasks: snapshot.tasks,
    activeWork: snapshot.activeWork,
    streaming: snapshot.streaming,
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
    layout,
  };
}

export function buildOperatorConsoleRawPromptFrameWithRuntimeHost(
  host: OperatorConsoleRuntimeHost,
  snapshot: OperatorConsoleRawPromptSnapshot
): OperatorConsoleRawPromptFrame {
  const terminal = normalizeTerminal(snapshot.terminal);
  host.clear();
  host.setMode(snapshot.mode ?? "session");
  host.setLocale(snapshot.locale ?? host.getState().locale);
  host.setTerminal(terminal);
  host.setStatus(snapshot.status ?? createDefaultOperatorConsoleRawPromptStatus());
  host.setMotionElapsedMs(snapshot.motionElapsedMs ?? 0);
  host.setSetupPanel(snapshot.setupPanel);
  host.setTranscript(snapshot.transcript ?? []);
  host.setTurnActivity(snapshot.turnActivity);
  host.setAttachments(snapshot.attachments ?? []);
  host.setTasks(snapshot.tasks ?? createInitialOperatorConsoleState().tasks);
  host.setSlash(snapshot.slash);
  host.setActiveWork(snapshot.activeWork ?? createInitialOperatorConsoleState().activeWork);
  host.setStreaming(snapshot.streaming);
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
    context: {},
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
    layout: frame.layout,
  };
}

function getPromptCursorPosition(
  state: OperatorConsoleState,
  promptRegionY: number,
  promptRegionHeight: number
): { readonly row: number; readonly column: number } {
  if (promptRegionHeight < 3) return { row: promptRegionY, column: 0 };
  if (isSteerInputActive(state.steer) && state.steer !== undefined) {
    const metrics = getSteerInputSurfaceMetrics(state.steer, {
      width: state.terminal.width,
      height: promptRegionHeight,
    });
    return {
      row: promptRegionY + 1 + metrics.cursorRow,
      column: metrics.cursorColumn,
    };
  }
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
