// v0.95 ViewModel Contract
// Pure structured data types for all CLI output surfaces.
// No ANSI, formatting, terminal-width, or rendering logic.

export type ViewModelSeverity = "ok" | "warn" | "error" | "info";

// ─────────────────────────────────────────────────────────────
// Status
// ─────────────────────────────────────────────────────────────

export interface StatusViewModel {
  readonly kind: "status";
  readonly agentName: string;
  readonly model: {
    readonly provider: string;
    readonly id: string;
  };
  readonly profileId?: string;
  readonly securityMode: string;
  readonly skillCount: number;
  readonly skillAutonomy?: string;
  readonly toolCount: number;
  readonly mcp: {
    readonly active: number;
    readonly total: number;
  };
  readonly taskflowActive: boolean;
  readonly warnings: readonly WarningErrorViewModel[];
  readonly sections?: readonly ViewModel[];
}

// ─────────────────────────────────────────────────────────────
// Table
// ─────────────────────────────────────────────────────────────

export type TableAlignment = "left" | "right" | "center";

export interface TableColumn {
  readonly key: string;
  readonly header: string;
  readonly alignment?: TableAlignment;
}

export interface TableViewModel {
  readonly kind: "table";
  readonly title?: string;
  readonly columns: readonly TableColumn[];
  readonly rows: readonly Record<string, string | number | boolean | undefined>[];
  readonly emptyMessage?: string;
}

// ─────────────────────────────────────────────────────────────
// Key-Value Block
// ─────────────────────────────────────────────────────────────

export interface KeyValueEntry {
  readonly key: string;
  readonly value: string | number | boolean;
  readonly severity?: ViewModelSeverity;
}

export interface KeyValueBlockViewModel {
  readonly kind: "kv";
  readonly title?: string;
  readonly entries: readonly KeyValueEntry[];
}

// ─────────────────────────────────────────────────────────────
// List
// ─────────────────────────────────────────────────────────────

export interface ListItem {
  readonly label: string;
  readonly value?: string;
  readonly severity?: ViewModelSeverity;
}

export interface ListViewModel {
  readonly kind: "list";
  readonly title?: string;
  readonly items: readonly ListItem[];
  readonly ordered?: boolean;
  readonly emptyMessage?: string;
}

// ─────────────────────────────────────────────────────────────
// Warning / Error
// ─────────────────────────────────────────────────────────────

export interface WarningErrorViewModel {
  readonly kind: "warning";
  readonly severity: "warn" | "error" | "info";
  readonly title: string;
  readonly message: string;
  readonly details?: readonly string[];
}

// ─────────────────────────────────────────────────────────────
// Approval / Security
// ─────────────────────────────────────────────────────────────

export interface ApprovalAction {
  readonly id: string;
  readonly label: string;
  readonly severity?: ViewModelSeverity;
}

export interface ApprovalSecurityViewModel {
  readonly kind: "approval";
  readonly toolName: string;
  readonly riskClass?: string;
  readonly targetSummary: string;
  readonly severity: "warn" | "error" | "info";
  readonly actions: readonly ApprovalAction[];
  readonly details?: readonly string[];
}

// ─────────────────────────────────────────────────────────────
// Activity Timeline
// ─────────────────────────────────────────────────────────────

export type TimelineEventStatus = "pending" | "running" | "done" | "failed" | "gated";

export interface TimelineEvent {
  readonly tool: string;
  readonly status: TimelineEventStatus;
  readonly elapsedMs?: number;
  readonly chars?: number;
  readonly sentChars?: number;
  readonly decision?: "allow" | "block" | "ask";
  readonly riskClass?: string;
  readonly truncated?: boolean;
}

export interface ActivityTimelineViewModel {
  readonly kind: "timeline";
  readonly events: readonly TimelineEvent[];
}

// ─────────────────────────────────────────────────────────────
// Progress / Context Rail
// ─────────────────────────────────────────────────────────────

export type ProgressStepStatus = "pending" | "active" | "done" | "failed";

export interface ProgressStep {
  readonly label: string;
  readonly status: ProgressStepStatus;
}

export interface ProgressContextRailViewModel {
  readonly kind: "progress";
  readonly title?: string;
  readonly steps: readonly ProgressStep[];
  readonly sessionElapsedMs?: number;
  readonly taskElapsedMs?: number | "idle";
}

// ─────────────────────────────────────────────────────────────
// Picker
// ─────────────────────────────────────────────────────────────

export interface PickerOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly selected?: boolean;
}

export interface PickerViewModel {
  readonly kind: "picker";
  readonly title: string;
  readonly options: readonly PickerOption[];
}

// ─────────────────────────────────────────────────────────────
// Onboarding Prompt Card
// ─────────────────────────────────────────────────────────────

export interface OnboardingPromptOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly technical?: boolean;
}

export interface OnboardingPromptCardViewModel {
  readonly kind: "onboardingPromptCard";
  readonly title: string;
  readonly bodyLines: readonly string[];
  readonly technicalLines?: readonly string[];
  readonly options: readonly OnboardingPromptOption[];
  readonly selectedOptionIndex: number;
  readonly hint?: string;
  readonly locale?: "en" | "ar";
  readonly direction?: "ltr" | "rtl";
}

// ─────────────────────────────────────────────────────────────
// Startup
// ─────────────────────────────────────────────────────────────

export interface StartupViewModel {
  readonly kind: "startup";
  readonly agentName: string;
  readonly taglines: readonly string[];
  readonly model: {
    readonly provider: string;
    readonly id: string;
  };
  readonly readiness: "ready" | "degraded" | "missing-config";
  readonly warnings: readonly WarningErrorViewModel[];
}

// ─────────────────────────────────────────────────────────────
// Command Result
// ─────────────────────────────────────────────────────────────

export interface CommandResultViewModel {
  readonly kind: "commandResult";
  readonly ok: boolean;
  readonly title: string;
  readonly blocks: readonly ViewModel[];
}

// ─────────────────────────────────────────────────────────────
// Plain Fallback
// ─────────────────────────────────────────────────────────────

export interface PlainFallbackViewModel {
  readonly kind: "plainFallback";
  readonly lines: readonly string[];
}

// ─────────────────────────────────────────────────────────────
// Assistant Response (legacy — kept temporarily)
// ─────────────────────────────────────────────────────────────

export interface AssistantResponseViewModel {
  readonly kind: "assistantResponse";
  readonly label: string;
  readonly text: string;
  readonly matchedSkills?: readonly string[];
  readonly progress?: readonly string[];
}

// ─────────────────────────────────────────────────────────────
// Startup Dashboard
// ─────────────────────────────────────────────────────────────

export interface StartupDashboardViewModel {
  readonly kind: "startupDashboard";
  readonly agentName: string;
  readonly taglines: readonly string[];
  readonly version: string;
  readonly sessionId?: string;
  readonly model: {
    readonly provider: string;
    readonly id: string;
  };
  readonly workspaceTrust: "trusted" | "untrusted" | "unknown";
  readonly workspaceVerification: "verified" | "unverified" | "unknown";
  readonly workspaceDirectory?: string;
  readonly securityMode: string;
  readonly skillAutonomy?: string;
  readonly providerReadiness: "ready" | "degraded" | "missing-config" | "unknown";
  readonly versionStatus?: "up-to-date" | "update-available" | "unknown";
  readonly availableCommands: readonly { readonly name: string; readonly description: string }[];
  readonly warnings: readonly WarningErrorViewModel[];
}

// ─────────────────────────────────────────────────────────────
// Startup Runtime
// ─────────────────────────────────────────────────────────────

export interface StartupRuntimeViewModel {
  readonly kind: "startupRuntime";
  readonly workspaceTrust: "trusted" | "untrusted" | "unknown";
  readonly workspaceVerification: "verified" | "unverified" | "unknown";
  readonly providerReadiness: "ready" | "degraded" | "missing-config" | "unknown";
  readonly versionStatus?: "up-to-date" | "update-available" | "unknown";
  readonly warnings: readonly WarningErrorViewModel[];
}

// ─────────────────────────────────────────────────────────────
// Conversation Message
// ─────────────────────────────────────────────────────────────

export interface ConversationMessageViewModel {
  readonly kind: "conversationMessage";
  readonly role: "assistant" | "user";
  readonly text: string;
  readonly label?: string;
  readonly turnId?: string;
  readonly matchedSkills?: readonly string[];
  readonly progress?: readonly string[];
}

// ─────────────────────────────────────────────────────────────
// Active Turn Spinner
// ─────────────────────────────────────────────────────────────

export interface ActiveTurnSpinnerViewModel {
  readonly kind: "activeTurnSpinner";
  readonly label?: string;
  readonly phase?: string;
  readonly elapsedMs?: number;
}

// ─────────────────────────────────────────────────────────────
// Tool Activity Rail
// ─────────────────────────────────────────────────────────────

export interface ToolActivityRailEvent {
  readonly tool: string;
  readonly status: TimelineEventStatus;
  readonly elapsedMs?: number;
  readonly glyph?: string;
  readonly label?: string;
  readonly target?: string;
  readonly riskClass?: string;
}

export interface ToolActivityRailViewModel {
  readonly kind: "toolActivityRail";
  readonly events: readonly ToolActivityRailEvent[];
}

// ─────────────────────────────────────────────────────────────
// File Change Preview
// ─────────────────────────────────────────────────────────────

export interface FileChangeHunk {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
  readonly lines: readonly string[];
}

export interface FileChangePreviewViewModel {
  readonly kind: "fileChangePreview";
  readonly path: string;
  readonly changeType: "added" | "modified" | "deleted";
  readonly summary?: readonly string[];
  readonly diff?: string;
  readonly hunks?: readonly FileChangeHunk[];
  readonly omittedLineCount?: number;
  readonly expansionCommand?: string;
}

// ─────────────────────────────────────────────────────────────
// Session Status Rail
// ─────────────────────────────────────────────────────────────

export interface SessionStatusRailViewModel {
  readonly kind: "sessionStatusRail";
  readonly modelLabel: string;
  readonly turnState: "idle" | "running" | "blocked" | "error" | "unknown";
  readonly sessionElapsedMs?: number;
  readonly currentTurnSeconds?: number;
  readonly contextUsage?: {
    readonly filled: number;
    readonly total: number;
  };
}

// ─────────────────────────────────────────────────────────────
// Shortcut Hint Rail
// ─────────────────────────────────────────────────────────────

export interface ShortcutHint {
  readonly key: string;
  readonly description: string;
}

export interface ShortcutHintRailViewModel {
  readonly kind: "shortcutHintRail";
  readonly hints: readonly ShortcutHint[];
}

// ─────────────────────────────────────────────────────────────
// Slash Menu
// ─────────────────────────────────────────────────────────────

export interface SlashMenuOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

export interface SlashMenuViewModel {
  readonly kind: "slashMenu";
  readonly query: string;
  readonly options: readonly SlashMenuOption[];
  readonly selectedIndex: number;
}

// ─────────────────────────────────────────────────────────────
// User Prompt Rail
// ─────────────────────────────────────────────────────────────

export interface UserPromptRailViewModel {
  readonly kind: "userPromptRail";
  readonly text: string;
}

// ─────────────────────────────────────────────────────────────
// Discriminated Union
// ─────────────────────────────────────────────────────────────

export type ViewModel =
  | StatusViewModel
  | TableViewModel
  | KeyValueBlockViewModel
  | ListViewModel
  | WarningErrorViewModel
  | ApprovalSecurityViewModel
  | ActivityTimelineViewModel
  | ProgressContextRailViewModel
  | PickerViewModel
  | OnboardingPromptCardViewModel
  | StartupViewModel
  | CommandResultViewModel
  | PlainFallbackViewModel
  | AssistantResponseViewModel
  | StartupDashboardViewModel
  | StartupRuntimeViewModel
  | ConversationMessageViewModel
  | ActiveTurnSpinnerViewModel
  | ToolActivityRailViewModel
  | FileChangePreviewViewModel
  | SessionStatusRailViewModel
  | ShortcutHintRailViewModel
  | SlashMenuViewModel
  | UserPromptRailViewModel;
