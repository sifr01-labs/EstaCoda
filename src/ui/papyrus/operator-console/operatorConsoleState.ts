import {
  createInitialFocusState,
  type ApprovalFocusControl,
  type FocusState,
} from "./focusModel.js";
import type { OperatorConsoleLocale } from "./activeWorkCopy.js";
import type { OperatorConsoleStyle } from "./operatorConsoleStyle.js";
import type { SessionCostSummary, SpendingBudgetSummary } from "../../../contracts/usage-cost.js";

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
    /** Omitted until the active session has a provider-reported measurement. */
    readonly usedTokens?: number;
    readonly totalTokens?: number;
    readonly percent?: number;
  };
  readonly sessionTimer: {
    readonly elapsedMs: number;
    readonly startedAtMs?: number;
  };
  readonly sessionCost?: Pick<SessionCostSummary, "estimatedCostUsd" | "costComplete" | "budget">;
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

export type TaskCardStepState = {
  readonly stepId: string;
  readonly title: string;
  readonly status: "pending" | "ready" | "running" | "waiting_for_input" | "waiting_for_approval" | "completed" | "failed" | "skipped" | "cancelled";
  readonly dependsOn: readonly string[];
  readonly childTaskPolicy: "forbid" | "fire_and_forget";
  readonly usage: TaskCardUsageState;
  readonly attempts: readonly TaskCardAttemptState[];
  readonly activeAttempt?: {
    readonly attemptId: string;
    readonly taskId: string;
    readonly attemptNumber: number;
    readonly status: "queued" | "leased" | "running" | "waiting_for_input" | "waiting_for_approval" | "completed" | "failed" | "cancelled" | "interrupted" | "expired";
    readonly elapsedMs: number;
    readonly currentActivity?: string;
    readonly currentToolCategory?: string;
    readonly usage: TaskCardUsageState;
  };
};

export type TaskCardUsageState = {
  readonly providerCalls: number;
  readonly totalTokens: number;
  readonly estimatedCostUsd?: number;
  readonly usageComplete: boolean;
  readonly pricingComplete: boolean;
};

export type TaskCardAttemptState = {
  readonly attemptId: string;
  readonly taskId: string;
  readonly attemptNumber: number;
  readonly status: "queued" | "leased" | "running" | "waiting_for_input" | "waiting_for_approval" | "completed" | "failed" | "cancelled" | "interrupted" | "expired";
  readonly elapsedMs: number;
  readonly currentActivity?: string;
  readonly currentToolCategory?: string;
  readonly usage: TaskCardUsageState;
};

export type TaskCardActivityState = {
  readonly kind: string;
  readonly label: string;
  readonly timestamp: string;
  readonly stepId?: string;
};

export type TaskCardState = {
  readonly taskId: string;
  readonly objective: string;
  readonly status: "planning" | "queued" | "running" | "waiting_for_host" | "waiting_for_input" | "waiting_for_approval" | "paused" | "completed" | "partial" | "failed" | "cancelled";
  readonly executionPreference: "auto" | "background";
  readonly execution: "foreground" | "background" | "waiting";
  readonly foregroundOwnerActive: boolean;
  readonly backgroundContinuation: "available" | "unavailable" | "unknown";
  readonly executionWaitingReason?: string;
  readonly progress: {
    readonly completed: number;
    readonly skipped: number;
    readonly total: number;
  };
  readonly planRevision?: { readonly revision: number; readonly status: string };
  readonly steps: readonly TaskCardStepState[];
  readonly childTasks: readonly {
    readonly taskId: string;
    readonly status: TaskCardState["status"];
    readonly parentAttemptId?: string;
  }[];
  readonly recentActivity: readonly TaskCardActivityState[];
  readonly currentToolCategory?: string;
  readonly elapsedMs: number;
  readonly usage: TaskCardUsageState;
  readonly spending?: SpendingBudgetSummary;
  readonly results: readonly {
    readonly handle: string;
    readonly kind: string;
    readonly disposition: "accepted" | "diagnostic";
    readonly status: string;
    readonly byteLength: number;
    readonly primary: boolean;
    readonly summary?: string;
  }[];
  readonly waitReason?: string;
  readonly failure?: {
    readonly class: string;
    readonly retryable: boolean;
    readonly uncertainSideEffects: boolean;
  };
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type TaskSurfaceState = {
  readonly cards: readonly TaskCardState[];
  readonly selectedTaskId?: string;
  readonly inspectedTaskId?: string;
  readonly scrollOffset: number;
};

export type ActiveWorkItemStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "awaitingApproval";

export type ActiveWorkActivityStatus = "running" | "succeeded" | "failed";

export type ActiveWorkDelegationOutcome =
  | "completed"
  | "blocked"
  | "failed"
  | "timeout"
  | "cancelled";

export type ActiveWorkActivity = {
  readonly id: string;
  readonly label: string;
  readonly detail?: string;
  readonly status: ActiveWorkActivityStatus;
};

export type ActiveWorkItem = {
  readonly id: string;
  readonly toolName: string;
  readonly displayLabel?: string;
  readonly source?: "tool" | "subagent";
  readonly groupId?: string;
  readonly taskIndex?: number;
  readonly taskLabel?: string;
  readonly batchTaskCount?: number;
  readonly activityLog?: readonly ActiveWorkActivity[];
  readonly delegationOutcome?: ActiveWorkDelegationOutcome;
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
  /** One elapsed-time clock shared by every animated surface. */
  readonly motionElapsedMs: number;
  readonly turnActivity?: TurnActivityState;
  readonly attachments: readonly AttachmentCardState[];
  readonly tasks: TaskSurfaceState;
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
  | "taskCards"
  | "taskInspection"
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
  "taskCards",
  "taskInspection",
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
  readonly motionElapsedMs?: number;
  readonly turnActivity?: TurnActivityState;
  readonly attachments?: readonly AttachmentCardState[];
  readonly tasks?: TaskSurfaceState;
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
    motionElapsedMs: normalizeMotionElapsedMs(input.motionElapsedMs),
    ...(input.turnActivity === undefined ? {} : { turnActivity: input.turnActivity }),
    attachments: input.attachments ?? [],
    tasks: input.tasks ?? createDefaultTaskSurfaceState(),
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

function normalizeMotionElapsedMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, value);
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
    context: {},
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

export function createDefaultTaskSurfaceState(): TaskSurfaceState {
  return {
    cards: [],
    scrollOffset: 0,
  };
}

export function createDefaultTerminalMetrics(): TerminalMetrics {
  return {
    width: 80,
    height: 24,
    isTty: false,
  };
}
