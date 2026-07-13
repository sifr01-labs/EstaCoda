import {
  createInitialFocusState,
  type ApprovalFocusControl,
  type FocusState,
} from "./focusModel.js";
import type { OperatorConsoleLocale } from "./activeWorkCopy.js";
import type { OperatorConsoleStyle } from "./operatorConsoleStyle.js";

export type OperatorConsoleMode = "session" | "setup";

export type TranscriptBlock = {
  readonly id: string;
  readonly role: "startup" | "user" | "assistant" | "system" | "tool" | "approval" | "summary";
  readonly text: string;
  readonly createdAtMs?: number;
  readonly attachmentIds?: readonly string[];
  readonly toolTrail?: readonly InlineToolTrailEntry[];
};

export type PromptSurfaceState = {
  readonly value: string;
  readonly cursorOffset: number;
  readonly multiline: boolean;
  readonly scrollOffset: number;
  readonly mode: "prompt" | "steer";
  readonly placeholder?: string;
};

export type StatusRailState = {
  readonly model: {
    readonly label: string;
    readonly state: "idle" | "working" | "degraded";
    readonly route?: "primary" | "fallback" | "failed";
  };
  readonly context: {
    readonly usedTokens: number;
    readonly totalTokens?: number;
    readonly percent?: number;
  };
  readonly sessionTimer: {
    readonly elapsedMs: number;
    readonly startedAtMs?: number;
  };
  readonly security?: {
    readonly yolo: boolean;
  };
};

export type TurnActivityPhase =
  | "thinking"
  | "routing"
  | "provider"
  | "finalizing"
  | "background";

export type BackgroundActivityKind =
  | "indexingSkills"
  | "indexingFiles"
  | "loadingWorkspaceMap"
  | "refreshingModelCatalog"
  | "syncingSessionState"
  | "compactingTranscript"
  | "rebuildingSearchIndex"
  | "scanningAttachments";

export type TurnActivityState = {
  readonly phase: TurnActivityPhase;
  readonly backgroundKind?: BackgroundActivityKind;
  readonly label?: string;
  readonly frameIndex?: number;
};

export type StartupDashboardState = {
  readonly productName: string;
  readonly orgName: string;
  readonly tagline: string;
  readonly version: string;
  readonly sessionId: string;
  readonly session: {
    readonly model: string;
    readonly modelRoute?: "primary" | "fallback" | "failed";
    readonly context: string;
    readonly workspace: string;
    readonly security: string;
    readonly autonomy: string;
  };
  readonly updateStatus?: string;
  readonly commands: readonly StartupCommandState[];
  readonly tips: readonly string[];
};

export type StartupCommandState = {
  readonly command: string;
  readonly description: string;
};

export type AttachmentCardState = {
  readonly id: string;
  readonly kind: "pastedText" | "fileExcerpt";
  readonly title: string;
  readonly preview: string;
  readonly content: string;
  readonly metadata: {
    readonly chars?: number;
    readonly lines?: number;
    readonly path?: string;
  };
};

export type ActiveWorkItemStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "awaitingApproval";

export type ActiveWorkItem = {
  readonly id: string;
  readonly toolName: string;
  readonly displayLabel?: string;
  readonly status: ActiveWorkItemStatus;
  readonly summary: string;
  readonly target?: string;
  readonly startedAtMs?: number;
  readonly endedAtMs?: number;
  readonly durationMs?: number;
  readonly detailsRef?: string;
  readonly riskLevel?: "low" | "medium" | "high";
  readonly approvalRef?: string;
  readonly fileChangeInspected?: boolean;
};

export type ToolActivityState = {
  readonly items: readonly ActiveWorkItem[];
  readonly scrollOffset: number;
  readonly expanded: boolean;
  readonly startedAtMs?: number;
  readonly updatedAtMs?: number;
  readonly completedAtMs?: number;
  readonly frameIndex?: number;
};

export type StreamingSegment = {
  readonly id: string;
  readonly role: "assistant" | "system";
  readonly text: string;
  readonly createdAtMs?: number;
};

export type InlineToolTrailEntry = {
  readonly id: string;
  readonly sequence: number;
  readonly toolName: string;
  readonly displayLabel?: string;
  readonly status: ActiveWorkItemStatus;
  readonly summary: string;
  readonly target?: string;
  readonly startedAtMs?: number;
  readonly endedAtMs?: number;
  readonly durationMs?: number;
  readonly detailsRef?: string;
  readonly riskLevel?: ActiveWorkItem["riskLevel"];
  readonly approvalRef?: string;
  readonly fileChangeInspected?: boolean;
  readonly afterSegmentId?: string;
};

export type StreamingState = {
  readonly segments: readonly StreamingSegment[];
  readonly tail: string;
  readonly isStreaming: boolean;
  readonly toolTrail?: readonly InlineToolTrailEntry[];
  readonly showCursor?: boolean;
};

export type ApprovalControl = ApprovalFocusControl;

export type ApprovalCardState = {
  readonly id: string;
  readonly status: "pending" | "approved" | "rejected" | "expired" | "superseded";
  readonly action: string;
  readonly target: string;
  readonly risk?: string;
  readonly summary?: string;
  readonly diffStats?: {
    readonly added?: number;
    readonly removed?: number;
  };
  readonly focusedControl?: ApprovalControl;
};

export type SlashMenuItemState = {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
};

export type SlashMenuState = {
  readonly query: string;
  readonly items: readonly SlashMenuItemState[];
  readonly activeItemId?: string;
};

export type SteerState = {
  readonly draft: string;
  readonly cursorOffset: number;
  readonly mode: "idle" | "drafting" | "queued";
  readonly queued?: QueuedSteerState;
};

export type QueuedSteerState = {
  readonly id: string;
  readonly text: string;
  readonly status: "queued" | "applied" | "cancelled";
  readonly submittedAtMs?: number;
};

export type SetupSurfaceState = SetupPanelState | SecretEntryPanelState | TextEntryPanelState;

export type SetupPanelState = {
  readonly kind: "table";
  readonly layout?: "routeTable" | "choiceMenu";
  readonly title: string;
  readonly description?: string;
  readonly statusLines?: readonly SetupPanelStatusLine[];
  readonly locale?: OperatorConsoleLocale;
  readonly rows: readonly SetupTableRow[];
  readonly selectedRowId?: string;
  readonly footer?: string;
};

export type SetupPanelStatusLine = {
  readonly text: string;
  readonly tone?: "active" | "default" | "muted" | "warning";
  readonly direction?: "auto" | "ltr" | "rtl";
};

export type SetupTableRow = {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly status: string;
  readonly notes: string;
  readonly group?: "main" | "navigation";
};

export type SecretEntryPanelState = {
  readonly kind: "secret";
  readonly title: string;
  readonly description: string;
  readonly locale?: OperatorConsoleLocale;
  readonly maskedValue?: string;
  readonly rawValue?: string;
  readonly envVar?: string;
  readonly optional?: boolean;
  readonly emptyLabel?: string;
  readonly footer: string;
};

export type TextEntryPanelState = {
  readonly kind: "textInput";
  readonly title: string;
  readonly description: string;
  readonly locale?: OperatorConsoleLocale;
  readonly value: string;
  readonly placeholder?: string;
  readonly footer: string;
};

export type TerminalMetrics = {
  readonly width: number;
  readonly height: number;
  readonly isTty: boolean;
};

export type OperatorConsoleState = {
  readonly mode: OperatorConsoleMode;
  readonly locale: OperatorConsoleLocale;
  readonly startup?: StartupDashboardState;
  readonly setupPanel?: SetupSurfaceState;
  readonly transcript: readonly TranscriptBlock[];
  readonly prompt: PromptSurfaceState;
  readonly status: StatusRailState;
  readonly turnActivity?: TurnActivityState;
  readonly attachments: readonly AttachmentCardState[];
  readonly activeWork: ToolActivityState;
  readonly streaming?: StreamingState;
  readonly approvals: readonly ApprovalCardState[];
  readonly slash?: SlashMenuState;
  readonly steer?: SteerState;
  readonly focus: FocusState;
  readonly terminal: TerminalMetrics;
  readonly style?: OperatorConsoleStyle;
};

export type OperatorConsoleSurface =
  | "startupDashboard"
  | "setupPanel"
  | "transcript"
  | "streaming"
  | "approvals"
  | "turnActivity"
  | "activeWork"
  | "queuedSteer"
  | "attachments"
  | "prompt"
  | "slashMenu"
  | "statusRail";

export const OPERATOR_CONSOLE_SURFACE_ORDER: readonly OperatorConsoleSurface[] = [
  "startupDashboard",
  "setupPanel",
  "transcript",
  "streaming",
  "approvals",
  "turnActivity",
  "activeWork",
  "queuedSteer",
  "attachments",
  "prompt",
  "slashMenu",
  "statusRail",
] as const;

export type CreateInitialOperatorConsoleStateInput = {
  readonly mode?: OperatorConsoleMode;
  readonly locale?: OperatorConsoleLocale;
  readonly startup?: StartupDashboardState;
  readonly setupPanel?: SetupSurfaceState;
  readonly transcript?: readonly TranscriptBlock[];
  readonly prompt?: PromptSurfaceState;
  readonly status?: StatusRailState;
  readonly turnActivity?: TurnActivityState;
  readonly attachments?: readonly AttachmentCardState[];
  readonly activeWork?: ToolActivityState;
  readonly streaming?: StreamingState;
  readonly approvals?: readonly ApprovalCardState[];
  readonly slash?: SlashMenuState;
  readonly steer?: SteerState;
  readonly focus?: FocusState;
  readonly terminal?: TerminalMetrics;
  readonly style?: OperatorConsoleStyle;
};

export function getOperatorConsoleSurfaceOrder(): readonly OperatorConsoleSurface[] {
  return [...OPERATOR_CONSOLE_SURFACE_ORDER];
}

export function createInitialOperatorConsoleState(
  input: CreateInitialOperatorConsoleStateInput = {}
): OperatorConsoleState {
  return {
    mode: input.mode ?? "session",
    locale: input.locale ?? "en",
    ...(input.startup === undefined ? {} : { startup: input.startup }),
    ...(input.setupPanel === undefined ? {} : { setupPanel: input.setupPanel }),
    transcript: input.transcript ?? [],
    prompt: input.prompt ?? createDefaultPromptSurfaceState(),
    status: input.status ?? createDefaultStatusRailState(),
    ...(input.turnActivity === undefined ? {} : { turnActivity: input.turnActivity }),
    attachments: input.attachments ?? [],
    activeWork: input.activeWork ?? createDefaultToolActivityState(),
    ...(input.streaming === undefined ? {} : { streaming: input.streaming }),
    approvals: input.approvals ?? [],
    ...(input.slash === undefined ? {} : { slash: input.slash }),
    ...(input.steer === undefined ? {} : { steer: input.steer }),
    focus: input.focus ?? createInitialFocusState(),
    terminal: input.terminal ?? createDefaultTerminalMetrics(),
    ...(input.style === undefined ? {} : { style: input.style }),
  };
}

export function createDefaultPromptSurfaceState(): PromptSurfaceState {
  return {
    value: "",
    cursorOffset: 0,
    multiline: false,
    scrollOffset: 0,
    mode: "prompt",
  };
}

export function createDefaultStatusRailState(): StatusRailState {
  return {
    model: {
      label: "",
      state: "idle",
    },
    context: {
      usedTokens: 0,
    },
    sessionTimer: {
      elapsedMs: 0,
    },
  };
}

export function createDefaultToolActivityState(): ToolActivityState {
  return {
    items: [],
    scrollOffset: 0,
    expanded: false,
  };
}

export function createDefaultTerminalMetrics(): TerminalMetrics {
  return {
    width: 80,
    height: 24,
    isTty: false,
  };
}
