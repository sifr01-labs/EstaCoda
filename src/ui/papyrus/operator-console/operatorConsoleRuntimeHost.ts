import { createOperatorConsoleLayout, type OperatorConsoleLayout } from "./operatorConsoleLayout.js";
import { renderOperatorConsoleTextLines } from "./operatorConsoleRenderer.js";
import type { FocusState, FocusTarget } from "./focusModel.js";
import type { OperatorConsoleStyle } from "./operatorConsoleStyle.js";
import {
  createDefaultPromptSurfaceState,
  createDefaultStatusRailState,
  createDefaultTerminalMetrics,
  createDefaultToolActivityState,
  createInitialOperatorConsoleState,
  type ActiveWorkItem,
  type ApprovalCardState,
  type AttachmentCardState,
  type CreateInitialOperatorConsoleStateInput,
  type InlineToolTrailEntry,
  type OperatorConsoleMode,
  type OperatorConsoleState,
  type PromptSurfaceState,
  type SetupSurfaceState,
  type SlashMenuState,
  type StartupDashboardState,
  type StatusRailState,
  type SteerState,
  type StreamingSegment,
  type StreamingState,
  type TerminalMetrics,
  type ToolActivityState,
  type TurnActivityState,
  type TranscriptBlock,
} from "./operatorConsoleState.js";

export type OperatorConsoleRuntimePromptInput = Partial<PromptSurfaceState> & {
  readonly text?: string;
};

export type OperatorConsoleRuntimeFrame = {
  readonly state: OperatorConsoleState;
  readonly layout: OperatorConsoleLayout;
  readonly lines: readonly string[];
};

export class OperatorConsoleRuntimeHost {
  #state: OperatorConsoleState;
  #disposed = false;

  constructor(input: CreateInitialOperatorConsoleStateInput = {}) {
    this.#state = cloneOperatorConsoleState(createInitialOperatorConsoleState(input));
  }

  getState(): OperatorConsoleState {
    return this.#state;
  }

  setMode(mode: OperatorConsoleMode): void {
    if (this.#disposed) return;
    this.#state = {
      ...this.#state,
      mode,
    };
  }

  setPrompt(input: OperatorConsoleRuntimePromptInput): void {
    if (this.#disposed) return;
    const current = this.#state.prompt;
    const value = input.text ?? input.value ?? current.value;
    this.#state = {
      ...this.#state,
      prompt: {
        value,
        cursorOffset: normalizeCursorOffset(input.cursorOffset ?? current.cursorOffset, value),
        multiline: input.multiline ?? value.includes("\n"),
        scrollOffset: normalizeNonNegativeInteger(input.scrollOffset ?? current.scrollOffset),
        mode: input.mode ?? current.mode,
        ...(input.placeholder ?? current.placeholder === undefined
          ? input.placeholder === undefined && current.placeholder === undefined
            ? {}
            : { placeholder: input.placeholder }
          : { placeholder: current.placeholder }),
      },
    };
  }

  setStatus(status: StatusRailState): void {
    if (this.#disposed) return;
    this.#state = {
      ...this.#state,
      status: cloneStatusRailState(status),
    };
  }

  setTurnActivity(turnActivity: TurnActivityState | undefined): void {
    if (this.#disposed) return;
    this.#state = {
      ...this.#state,
      ...(turnActivity === undefined ? { turnActivity: undefined } : { turnActivity: cloneTurnActivityState(turnActivity) }),
    };
  }

  setTerminal(terminal: Partial<TerminalMetrics>): void {
    if (this.#disposed) return;
    const current = this.#state.terminal;
    this.#state = {
      ...this.#state,
      terminal: normalizeTerminalMetrics({ ...current, ...terminal }),
    };
  }

  setStyle(style: OperatorConsoleStyle | undefined): void {
    if (this.#disposed) return;
    this.#state = {
      ...this.#state,
      ...(style === undefined ? { style: undefined } : { style }),
    };
  }

  setTranscript(transcript: readonly TranscriptBlock[]): void {
    if (this.#disposed) return;
    this.#state = {
      ...this.#state,
      transcript: transcript.map(cloneTranscriptBlock),
    };
  }

  setAttachments(attachments: readonly AttachmentCardState[]): void {
    if (this.#disposed) return;
    this.#state = {
      ...this.#state,
      attachments: attachments.map(cloneAttachmentCardState),
    };
  }

  setFocus(focus: FocusState): void {
    if (this.#disposed) return;
    this.#state = {
      ...this.#state,
      focus: cloneFocusState(focus),
    };
  }

  setActiveWork(activeWork: ToolActivityState): void {
    if (this.#disposed) return;
    this.#state = {
      ...this.#state,
      activeWork: cloneToolActivityState(activeWork),
    };
  }

  setStreaming(streaming: StreamingState | undefined): void {
    if (this.#disposed) return;
    this.#state = {
      ...this.#state,
      ...(streaming === undefined ? { streaming: undefined } : { streaming: cloneStreamingState(streaming) }),
    };
  }

  setApprovals(approvals: readonly ApprovalCardState[]): void {
    if (this.#disposed) return;
    this.#state = {
      ...this.#state,
      approvals: approvals.map(cloneApprovalCardState),
    };
  }

  setSteer(steer: SteerState | undefined): void {
    if (this.#disposed) return;
    this.#state = {
      ...this.#state,
      ...(steer === undefined ? { steer: undefined } : { steer: cloneSteerState(steer) }),
    };
  }

  setSlash(slash: SlashMenuState | undefined): void {
    if (this.#disposed) return;
    this.#state = {
      ...this.#state,
      ...(slash === undefined ? { slash: undefined } : { slash: cloneSlashMenuState(slash) }),
    };
  }

  setStartupDashboard(startup: StartupDashboardState | undefined): void {
    if (this.#disposed) return;
    this.#state = {
      ...this.#state,
      ...(startup === undefined ? { startup: undefined } : { startup: cloneStartupDashboardState(startup) }),
    };
  }

  setSetupPanel(setupPanel: SetupSurfaceState | undefined): void {
    if (this.#disposed) return;
    this.#state = {
      ...this.#state,
      ...(setupPanel === undefined ? { setupPanel: undefined } : { setupPanel: cloneSetupSurfaceState(setupPanel) }),
    };
  }

  render(): OperatorConsoleRuntimeFrame {
    const layout = createOperatorConsoleLayout(this.#state, this.#state.terminal);
    return {
      state: this.#state,
      layout,
      lines: renderOperatorConsoleTextLines(this.#state, layout),
    };
  }

  clear(): void {
    if (this.#disposed) return;
    this.#state = createInitialOperatorConsoleState({
      mode: this.#state.mode,
      locale: this.#state.locale,
      terminal: this.#state.terminal,
      status: this.#state.status,
      style: this.#state.style,
    });
  }

  dispose(): void {
    this.#disposed = true;
  }
}

export function createOperatorConsoleRuntimeHost(
  input: CreateInitialOperatorConsoleStateInput = {}
): OperatorConsoleRuntimeHost {
  return new OperatorConsoleRuntimeHost(input);
}

function cloneOperatorConsoleState(state: OperatorConsoleState): OperatorConsoleState {
  return createInitialOperatorConsoleState({
    mode: state.mode,
    locale: state.locale,
    startup: state.startup === undefined ? undefined : cloneStartupDashboardState(state.startup),
    setupPanel: state.setupPanel === undefined ? undefined : cloneSetupSurfaceState(state.setupPanel),
    transcript: state.transcript.map(cloneTranscriptBlock),
    prompt: clonePromptSurfaceState(state.prompt),
    status: cloneStatusRailState(state.status),
    turnActivity: state.turnActivity === undefined ? undefined : cloneTurnActivityState(state.turnActivity),
    attachments: state.attachments.map(cloneAttachmentCardState),
    activeWork: cloneToolActivityState(state.activeWork),
    streaming: state.streaming === undefined ? undefined : cloneStreamingState(state.streaming),
    approvals: state.approvals.map(cloneApprovalCardState),
    slash: state.slash === undefined ? undefined : cloneSlashMenuState(state.slash),
    steer: state.steer === undefined ? undefined : cloneSteerState(state.steer),
    focus: cloneFocusState(state.focus),
    terminal: cloneTerminalMetrics(state.terminal),
    style: state.style,
  });
}

function cloneTurnActivityState(turnActivity: TurnActivityState): TurnActivityState {
  return { ...turnActivity };
}

function cloneFocusState(focus: FocusState): FocusState {
  return {
    target: cloneFocusTarget(focus.target),
    ...(focus.previous === undefined ? {} : { previous: cloneFocusTarget(focus.previous) }),
  };
}

function cloneFocusTarget(target: FocusTarget): FocusTarget {
  return { ...target };
}

function clonePromptSurfaceState(prompt: PromptSurfaceState): PromptSurfaceState {
  return {
    ...createDefaultPromptSurfaceState(),
    ...prompt,
  };
}

function cloneStatusRailState(status: StatusRailState): StatusRailState {
  const fallback = createDefaultStatusRailState();
  return {
    model: {
      label: status.model?.label ?? fallback.model.label,
      state: isStatusModelState(status.model?.state) ? status.model.state : fallback.model.state,
      ...(isStatusModelRoute(status.model?.route) ? { route: status.model.route } : {}),
    },
    context: {
      ...(status.context?.usedTokens === undefined
        ? {}
        : { usedTokens: normalizeNonNegativeNumber(status.context.usedTokens) }),
      ...(status.context?.totalTokens === undefined
        ? {}
        : { totalTokens: normalizeNonNegativeNumber(status.context.totalTokens) }),
      ...(status.context?.percent === undefined
        ? {}
        : { percent: normalizeNonNegativeNumber(status.context.percent) }),
    },
    sessionTimer: {
      elapsedMs: normalizeNonNegativeNumber(status.sessionTimer?.elapsedMs ?? fallback.sessionTimer.elapsedMs),
      ...(status.sessionTimer?.startedAtMs === undefined
        ? {}
        : { startedAtMs: normalizeNonNegativeNumber(status.sessionTimer.startedAtMs) }),
    },
    ...(status.security?.yolo === true ? { security: { yolo: true } } : {}),
  };
}

function cloneTerminalMetrics(terminal: TerminalMetrics): TerminalMetrics {
  return normalizeTerminalMetrics(terminal);
}

function normalizeTerminalMetrics(terminal: Partial<TerminalMetrics>): TerminalMetrics {
  const fallback = createDefaultTerminalMetrics();
  return {
    width: normalizeNonNegativeInteger(terminal.width ?? fallback.width),
    height: normalizeNonNegativeInteger(terminal.height ?? fallback.height),
    isTty: terminal.isTty ?? fallback.isTty,
  };
}

function cloneTranscriptBlock(block: TranscriptBlock): TranscriptBlock {
  return {
    ...block,
    ...(block.attachmentIds === undefined ? {} : { attachmentIds: [...block.attachmentIds] }),
    ...(block.toolTrail === undefined ? {} : { toolTrail: block.toolTrail.map(cloneInlineToolTrailEntry) }),
  };
}

function cloneAttachmentCardState(attachment: AttachmentCardState): AttachmentCardState {
  return {
    ...attachment,
    metadata: { ...attachment.metadata },
  };
}

function cloneToolActivityState(activeWork: ToolActivityState): ToolActivityState {
  return {
    ...createDefaultToolActivityState(),
    ...activeWork,
    items: activeWork.items.map(cloneActiveWorkItem),
  };
}

function cloneActiveWorkItem(item: ActiveWorkItem): ActiveWorkItem {
  return { ...item };
}

function cloneStreamingState(streaming: StreamingState): StreamingState {
  return {
    ...streaming,
    segments: streaming.segments.map(cloneStreamingSegment),
    ...(streaming.toolTrail === undefined ? {} : { toolTrail: streaming.toolTrail.map(cloneInlineToolTrailEntry) }),
  };
}

function cloneStreamingSegment(segment: StreamingSegment): StreamingSegment {
  return { ...segment };
}

function cloneInlineToolTrailEntry(entry: InlineToolTrailEntry): InlineToolTrailEntry {
  return { ...entry };
}

function cloneApprovalCardState(approval: ApprovalCardState): ApprovalCardState {
  return {
    ...approval,
    ...(approval.diffStats === undefined ? {} : { diffStats: { ...approval.diffStats } }),
  };
}

function cloneSteerState(steer: SteerState): SteerState {
  return {
    ...steer,
    ...(steer.queued === undefined ? {} : { queued: { ...steer.queued } }),
  };
}

function cloneSlashMenuState(slash: SlashMenuState): SlashMenuState {
  return {
    ...slash,
    items: slash.items.map((item) => ({ ...item })),
  };
}

function cloneStartupDashboardState(startup: StartupDashboardState): StartupDashboardState {
  return {
    ...startup,
    session: { ...startup.session },
    commands: startup.commands.map((command) => ({ ...command })),
    tips: [...startup.tips],
  };
}

function cloneSetupSurfaceState(setup: SetupSurfaceState): SetupSurfaceState {
  if (setup.kind !== "table") return { ...setup };
  return {
    ...setup,
    rows: setup.rows.map((row) => ({ ...row })),
  };
}

function isStatusModelState(value: string | undefined): value is StatusRailState["model"]["state"] {
  return value === "idle" || value === "working" || value === "degraded";
}

function isStatusModelRoute(value: string | undefined): value is NonNullable<StatusRailState["model"]["route"]> {
  return value === "primary" || value === "fallback" || value === "failed";
}

function normalizeCursorOffset(value: number, text: string): number {
  return Math.min(text.length, normalizeNonNegativeInteger(value));
}

function normalizeNonNegativeInteger(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function normalizeNonNegativeNumber(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, value);
}
