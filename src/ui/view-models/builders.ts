// v0.95 ViewModel Builders
// Pure factory functions. No formatting, ANSI, terminal-width, or rendering logic.

import type {
  ActiveTurnSpinnerViewModel,
  ActivityTimelineViewModel,
  ApprovalAction,
  ApprovalSecurityViewModel,
  AssistantResponseViewModel,
  CommandResultViewModel,
  ConversationMessageViewModel,
  FileChangeHunk,
  FileChangePreviewViewModel,
  KeyValueBlockViewModel,
  KeyValueEntry,
  ListItem,
  ListViewModel,
  OnboardingPromptCardViewModel,
  OnboardingPromptOption,
  PlainFallbackViewModel,
  PickerOption,
  PickerViewModel,
  ProgressContextRailViewModel,
  ProgressStep,
  ProgressStepStatus,
  SessionStatusRailViewModel,
  ShortcutHint,
  ShortcutHintRailViewModel,
  SlashMenuOption,
  SlashMenuViewModel,
  StartupDashboardViewModel,
  StartupRuntimeViewModel,
  StartupViewModel,
  StatusViewModel,
  TableColumn,
  TableViewModel,
  TimelineEvent,
  ToolActivityRailEvent,
  ToolActivityRailViewModel,
  UserPromptRailViewModel,
  WarningErrorViewModel,
  ViewModel,
  ViewModelSeverity,
} from "../../contracts/view-model.js";

// ─────────────────────────────────────────────────────────────
// Status
// ─────────────────────────────────────────────────────────────

export interface BuildStatusInput {
  readonly agentName: string;
  readonly model: { readonly provider: string; readonly id: string };
  readonly profileId?: string;
  readonly securityMode: string;
  readonly skillCount: number;
  readonly skillAutonomy?: string;
  readonly toolCount: number;
  readonly mcpActive: number;
  readonly mcpTotal: number;
  readonly taskflowActive: boolean;
  readonly warnings?: readonly WarningErrorViewModel[];
  readonly sections?: readonly ViewModel[];
}

export function buildStatusViewModel(input: BuildStatusInput): StatusViewModel {
  return {
    kind: "status",
    agentName: input.agentName,
    model: input.model,
    profileId: input.profileId,
    securityMode: input.securityMode,
    skillCount: input.skillCount,
    skillAutonomy: input.skillAutonomy,
    toolCount: input.toolCount,
    mcp: { active: input.mcpActive, total: input.mcpTotal },
    taskflowActive: input.taskflowActive,
    warnings: input.warnings ?? [],
    sections: input.sections,
  };
}

// ─────────────────────────────────────────────────────────────
// Table
// ─────────────────────────────────────────────────────────────

export interface BuildTableInput {
  readonly title?: string;
  readonly columns: readonly TableColumn[];
  readonly rows: readonly Record<string, string | number | boolean | undefined>[];
  readonly emptyMessage?: string;
}

export function buildTableViewModel(input: BuildTableInput): TableViewModel {
  return {
    kind: "table",
    title: input.title,
    columns: input.columns,
    rows: input.rows,
    emptyMessage: input.emptyMessage,
  };
}

// ─────────────────────────────────────────────────────────────
// Key-Value Block
// ─────────────────────────────────────────────────────────────

export interface BuildKeyValueBlockInput {
  readonly title?: string;
  readonly entries: readonly KeyValueEntry[];
}

export function buildKeyValueBlockViewModel(
  input: BuildKeyValueBlockInput
): KeyValueBlockViewModel {
  return {
    kind: "kv",
    title: input.title,
    entries: input.entries,
  };
}

// ─────────────────────────────────────────────────────────────
// List
// ─────────────────────────────────────────────────────────────

export interface BuildListInput {
  readonly title?: string;
  readonly items: readonly ListItem[];
  readonly ordered?: boolean;
  readonly emptyMessage?: string;
}

export function buildListViewModel(input: BuildListInput): ListViewModel {
  return {
    kind: "list",
    title: input.title,
    items: input.items,
    ordered: input.ordered,
    emptyMessage: input.emptyMessage,
  };
}

// ─────────────────────────────────────────────────────────────
// Warning / Error
// ─────────────────────────────────────────────────────────────

export interface BuildWarningErrorInput {
  readonly severity: "warn" | "error" | "info";
  readonly title: string;
  readonly message: string;
  readonly details?: readonly string[];
}

export function buildWarningErrorViewModel(
  input: BuildWarningErrorInput
): WarningErrorViewModel {
  return {
    kind: "warning",
    severity: input.severity,
    title: input.title,
    message: input.message,
    details: input.details,
  };
}

// ─────────────────────────────────────────────────────────────
// Approval / Security
// ─────────────────────────────────────────────────────────────

export interface BuildApprovalSecurityInput {
  readonly toolName: string;
  readonly riskClass?: string;
  readonly targetSummary: string;
  readonly severity: "warn" | "error" | "info";
  readonly actions: readonly ApprovalAction[];
  readonly details?: readonly string[];
}

export function buildApprovalSecurityViewModel(
  input: BuildApprovalSecurityInput
): ApprovalSecurityViewModel {
  return {
    kind: "approval",
    toolName: input.toolName,
    riskClass: input.riskClass,
    targetSummary: input.targetSummary,
    severity: input.severity,
    actions: input.actions,
    details: input.details,
  };
}

// ─────────────────────────────────────────────────────────────
// Activity Timeline
// ─────────────────────────────────────────────────────────────

export interface BuildActivityTimelineInput {
  readonly events: readonly TimelineEvent[];
}

export function buildActivityTimelineViewModel(
  input: BuildActivityTimelineInput
): ActivityTimelineViewModel {
  return {
    kind: "timeline",
    events: input.events,
  };
}

// ─────────────────────────────────────────────────────────────
// Progress / Context Rail
// ─────────────────────────────────────────────────────────────

export interface BuildProgressRailInput {
  readonly title?: string;
  readonly steps: readonly ProgressStep[];
  readonly sessionElapsedMs?: number;
  readonly taskElapsedMs?: number | "idle";
}

export function buildProgressContextRailViewModel(
  input: BuildProgressRailInput
): ProgressContextRailViewModel {
  return {
    kind: "progress",
    title: input.title,
    steps: input.steps,
    sessionElapsedMs: input.sessionElapsedMs,
    taskElapsedMs: input.taskElapsedMs,
  };
}

// ─────────────────────────────────────────────────────────────
// Picker
// ─────────────────────────────────────────────────────────────

export interface BuildPickerInput {
  readonly title: string;
  readonly options: readonly PickerOption[];
}

export function buildPickerViewModel(input: BuildPickerInput): PickerViewModel {
  return {
    kind: "picker",
    title: input.title,
    options: input.options,
  };
}

// ─────────────────────────────────────────────────────────────
// Onboarding Prompt Card
// ─────────────────────────────────────────────────────────────

export interface BuildOnboardingPromptCardInput {
  readonly title: string;
  readonly bodyLines: readonly string[];
  readonly technicalLines?: readonly string[];
  readonly options: readonly OnboardingPromptOption[];
  readonly selectedOptionIndex: number;
  readonly hint?: string;
  readonly locale?: "en" | "ar";
  readonly direction?: "ltr" | "rtl";
}

export function buildOnboardingPromptCardViewModel(
  input: BuildOnboardingPromptCardInput
): OnboardingPromptCardViewModel {
  return {
    kind: "onboardingPromptCard",
    title: input.title,
    bodyLines: input.bodyLines,
    technicalLines: input.technicalLines,
    options: input.options,
    selectedOptionIndex: input.selectedOptionIndex,
    hint: input.hint,
    locale: input.locale,
    direction: input.direction,
  };
}

// ─────────────────────────────────────────────────────────────
// Startup
// ─────────────────────────────────────────────────────────────

export interface BuildStartupInput {
  readonly agentName: string;
  readonly taglines: readonly string[];
  readonly model: { readonly provider: string; readonly id: string };
  readonly readiness: "ready" | "degraded" | "missing-config";
  readonly warnings?: readonly WarningErrorViewModel[];
}

export function buildStartupViewModel(input: BuildStartupInput): StartupViewModel {
  return {
    kind: "startup",
    agentName: input.agentName,
    taglines: input.taglines,
    model: input.model,
    readiness: input.readiness,
    warnings: input.warnings ?? [],
  };
}

// ─────────────────────────────────────────────────────────────
// Command Result
// ─────────────────────────────────────────────────────────────

export interface BuildCommandResultInput {
  readonly ok: boolean;
  readonly title: string;
  readonly blocks: readonly ViewModel[];
}

export function buildCommandResultViewModel(
  input: BuildCommandResultInput
): CommandResultViewModel {
  return {
    kind: "commandResult",
    ok: input.ok,
    title: input.title,
    blocks: input.blocks,
  };
}

// ─────────────────────────────────────────────────────────────
// Plain Fallback
// ─────────────────────────────────────────────────────────────

export interface BuildPlainFallbackInput {
  readonly lines: readonly string[];
}

export function buildPlainFallbackViewModel(
  input: BuildPlainFallbackInput
): PlainFallbackViewModel {
  return {
    kind: "plainFallback",
    lines: input.lines,
  };
}

// ──────────────────────────────────────
// Assistant Response
// ──────────────────────────────────────

export interface BuildAssistantResponseInput {
  readonly label: string;
  readonly text: string;
  readonly matchedSkills?: readonly string[];
  readonly progress?: readonly string[];
}

export function buildAssistantResponseViewModel(
  input: BuildAssistantResponseInput
): AssistantResponseViewModel {
  return {
    kind: "assistantResponse",
    label: input.label,
    text: input.text,
    matchedSkills: input.matchedSkills,
    progress: input.progress,
  };
}

// ─────────────────────────────────────────────────────────────
// Startup Dashboard
// ─────────────────────────────────────────────────────────────

export interface BuildStartupDashboardInput {
  readonly agentName: string;
  readonly taglines: readonly string[];
  readonly version: string;
  readonly sessionId?: string;
  readonly model: { readonly provider: string; readonly id: string };
  readonly workspaceTrust: "trusted" | "untrusted" | "unknown";
  readonly workspaceVerification: "verified" | "unverified" | "unknown";
  readonly workspaceDirectory?: string;
  readonly securityMode: string;
  readonly skillAutonomy?: string;
  readonly providerReadiness: "ready" | "degraded" | "missing-config" | "unknown";
  readonly versionStatus?: "up-to-date" | "update-available" | "unknown";
  readonly availableCommands: readonly { readonly name: string; readonly description: string }[];
  readonly warnings?: readonly WarningErrorViewModel[];
}

export function buildStartupDashboardViewModel(
  input: BuildStartupDashboardInput
): StartupDashboardViewModel {
  return {
    kind: "startupDashboard",
    agentName: input.agentName,
    taglines: input.taglines,
    version: input.version,
    sessionId: input.sessionId,
    model: input.model,
    workspaceTrust: input.workspaceTrust,
    workspaceVerification: input.workspaceVerification,
    workspaceDirectory: input.workspaceDirectory,
    securityMode: input.securityMode,
    skillAutonomy: input.skillAutonomy,
    providerReadiness: input.providerReadiness,
    versionStatus: input.versionStatus,
    availableCommands: input.availableCommands,
    warnings: input.warnings ?? [],
  };
}

// ─────────────────────────────────────────────────────────────
// Startup Runtime
// ─────────────────────────────────────────────────────────────

export interface BuildStartupRuntimeInput {
  readonly workspaceTrust: "trusted" | "untrusted" | "unknown";
  readonly workspaceVerification: "verified" | "unverified" | "unknown";
  readonly providerReadiness: "ready" | "degraded" | "missing-config" | "unknown";
  readonly versionStatus?: "up-to-date" | "update-available" | "unknown";
  readonly warnings?: readonly WarningErrorViewModel[];
}

export function buildStartupRuntimeViewModel(
  input: BuildStartupRuntimeInput
): StartupRuntimeViewModel {
  return {
    kind: "startupRuntime",
    workspaceTrust: input.workspaceTrust,
    workspaceVerification: input.workspaceVerification,
    providerReadiness: input.providerReadiness,
    versionStatus: input.versionStatus,
    warnings: input.warnings ?? [],
  };
}

// ─────────────────────────────────────────────────────────────
// Conversation Message
// ─────────────────────────────────────────────────────────────

export interface BuildConversationMessageInput {
  readonly role: "assistant" | "user";
  readonly text: string;
  readonly label?: string;
  readonly turnId?: string;
  readonly matchedSkills?: readonly string[];
  readonly progress?: readonly string[];
}

export function buildConversationMessageViewModel(
  input: BuildConversationMessageInput
): ConversationMessageViewModel {
  return {
    kind: "conversationMessage",
    role: input.role,
    text: input.text,
    label: input.label,
    turnId: input.turnId,
    matchedSkills: input.matchedSkills,
    progress: input.progress,
  };
}

// ─────────────────────────────────────────────────────────────
// Active Turn Spinner
// ─────────────────────────────────────────────────────────────

export interface BuildActiveTurnSpinnerInput {
  readonly label?: string;
  readonly phase?: string;
  readonly elapsedMs?: number;
}

export function buildActiveTurnSpinnerViewModel(
  input: BuildActiveTurnSpinnerInput
): ActiveTurnSpinnerViewModel {
  return {
    kind: "activeTurnSpinner",
    label: input.label,
    phase: input.phase,
    elapsedMs: input.elapsedMs,
  };
}

// ─────────────────────────────────────────────────────────────
// Tool Activity Rail
// ─────────────────────────────────────────────────────────────

export interface BuildToolActivityRailInput {
  readonly events: readonly ToolActivityRailEvent[];
}

export function buildToolActivityRailViewModel(
  input: BuildToolActivityRailInput
): ToolActivityRailViewModel {
  return {
    kind: "toolActivityRail",
    events: input.events,
  };
}

// ─────────────────────────────────────────────────────────────
// File Change Preview
// ─────────────────────────────────────────────────────────────

export interface BuildFileChangePreviewInput {
  readonly path: string;
  readonly changeType: "added" | "modified" | "deleted";
  readonly summary?: readonly string[];
  readonly diff?: string;
  readonly hunks?: readonly FileChangeHunk[];
  readonly omittedLineCount?: number;
  readonly expansionCommand?: string;
}

export function buildFileChangePreviewViewModel(
  input: BuildFileChangePreviewInput
): FileChangePreviewViewModel {
  return {
    kind: "fileChangePreview",
    path: input.path,
    changeType: input.changeType,
    summary: input.summary,
    diff: input.diff,
    hunks: input.hunks,
    omittedLineCount: input.omittedLineCount,
    expansionCommand: input.expansionCommand,
  };
}

// ─────────────────────────────────────────────────────────────
// Session Status Rail
// ─────────────────────────────────────────────────────────────

export interface BuildSessionStatusRailInput {
  readonly modelLabel: string;
  readonly turnState: "idle" | "running" | "blocked" | "error" | "unknown";
  readonly showTurnState?: boolean;
  readonly sessionElapsedMs?: number;
  readonly currentTurnSeconds?: number;
  readonly contextUsage?: { readonly filled: number; readonly total: number };
}

export function buildSessionStatusRailViewModel(
  input: BuildSessionStatusRailInput
): SessionStatusRailViewModel {
  return {
    kind: "sessionStatusRail",
    modelLabel: input.modelLabel,
    turnState: input.turnState,
    showTurnState: input.showTurnState,
    sessionElapsedMs: input.sessionElapsedMs,
    currentTurnSeconds: input.currentTurnSeconds,
    contextUsage: input.contextUsage,
  };
}

// ─────────────────────────────────────────────────────────────
// Shortcut Hint Rail
// ─────────────────────────────────────────────────────────────

export interface BuildShortcutHintRailInput {
  readonly hints: readonly ShortcutHint[];
}

export function buildShortcutHintRailViewModel(
  input: BuildShortcutHintRailInput
): ShortcutHintRailViewModel {
  return {
    kind: "shortcutHintRail",
    hints: input.hints,
  };
}

// ─────────────────────────────────────────────────────────────
// User Prompt Rail
// ─────────────────────────────────────────────────────────────

export interface BuildUserPromptRailInput {
  readonly text: string;
}

export function buildUserPromptRailViewModel(
  input: BuildUserPromptRailInput
): UserPromptRailViewModel {
  return {
    kind: "userPromptRail",
    text: input.text,
  };
}

// ─────────────────────────────────────────────────────────────
// Slash Menu
// ─────────────────────────────────────────────────────────────

export interface BuildSlashMenuInput {
  readonly query: string;
  readonly options: readonly SlashMenuOption[];
  readonly selectedIndex: number;
  readonly absoluteSelectedIndex?: number;
  readonly visibleStartIndex?: number;
  readonly totalOptions?: number;
}

export function buildSlashMenuViewModel(input: BuildSlashMenuInput): SlashMenuViewModel {
  return {
    kind: "slashMenu",
    query: input.query,
    options: input.options,
    selectedIndex: input.selectedIndex,
    absoluteSelectedIndex: input.absoluteSelectedIndex,
    visibleStartIndex: input.visibleStartIndex,
    totalOptions: input.totalOptions,
  };
}

// ─────────────────────────────────────────────────────────────
// Convenience helpers (still pure, no rendering)
// ─────────────────────────────────────────────────────────────

export function kv(key: string, value: string | number | boolean, severity?: ViewModelSeverity): KeyValueEntry {
  return { key, value, severity };
}

export function listItem(label: string, value?: string, severity?: ViewModelSeverity): ListItem {
  return { label, value, severity };
}

export function timelineEvent(
  tool: string,
  status: TimelineEvent["status"],
  overrides?: Omit<Partial<TimelineEvent>, "tool" | "status">
): TimelineEvent {
  return { tool, status, ...overrides };
}

export function progressStep(label: string, status: ProgressStepStatus): ProgressStep {
  return { label, status };
}

export function pickerOption(
  id: string,
  label: string,
  overrides?: Omit<Partial<PickerOption>, "id" | "label">
): PickerOption {
  return { id, label, ...overrides };
}

export function approvalAction(
  id: string,
  label: string,
  severity?: ViewModelSeverity
): ApprovalAction {
  return { id, label, severity };
}

export function toolActivityRailEvent(
  tool: string,
  status: ToolActivityRailEvent["status"],
  overrides?: Omit<Partial<ToolActivityRailEvent>, "tool" | "status">
): ToolActivityRailEvent {
  return { tool, status, ...overrides };
}

export function fileChangeHunk(
  oldStart: number,
  oldCount: number,
  newStart: number,
  newCount: number,
  lines: readonly string[]
): FileChangeHunk {
  return { oldStart, oldCount, newStart, newCount, lines };
}

export function shortcutHint(key: string, description: string): ShortcutHint {
  return { key, description };
}

export function slashMenuOption(
  id: string,
  label: string,
  overrides?: Omit<Partial<SlashMenuOption>, "id" | "label">
): SlashMenuOption {
  return { id, label, ...overrides };
}
