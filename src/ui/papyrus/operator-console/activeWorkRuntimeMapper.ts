import type { RuntimeEvent } from "../../../contracts/runtime-event.js";
import { toolDisplayLabel, type ToolDisplayLocale } from "../../tool-display.js";
import type {
  ActiveWorkItem,
  ActiveWorkActivity,
  ActiveWorkDelegationOutcome,
  ActiveWorkItemStatus,
  ToolActivityState,
} from "./operatorConsoleState.js";
import { createDefaultToolActivityState } from "./operatorConsoleState.js";

const MAX_REMEMBERED_DELEGATION_SETTLEMENTS = 512;
export const MAX_DELEGATION_WORKER_ACTIVITY_ROWS = 6;
const MAX_WORKER_ACTIVITY_TEXT_CHARS = 160;

export type ActiveWorkRuntimeEventStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "gated"
  | "cancelled"
  | "blocked"
  | "timeout";

export type ActiveWorkRuntimeEvent = {
  readonly id?: string;
  readonly toolName: string;
  readonly displayLabel?: string;
  readonly source?: "tool" | "subagent";
  readonly groupId?: string;
  readonly taskId?: string;
  readonly taskIndex?: number;
  readonly taskLabel?: string;
  readonly batchTaskCount?: number;
  readonly activity?: ActiveWorkActivity;
  readonly delegationOutcome?: ActiveWorkDelegationOutcome;
  readonly status: ActiveWorkRuntimeEventStatus;
  readonly summary?: string;
  readonly target?: string;
  readonly startedAtMs?: number;
  readonly endedAtMs?: number;
  readonly durationMs?: number;
  readonly detailsRef?: string;
  readonly riskClass?: string;
  readonly approvalRef?: string;
  readonly fileChangeInspected?: boolean;
};

export type ActiveWorkRuntimeEventMapperOptions = {
  readonly locale?: ToolDisplayLocale;
  readonly now?: () => number;
};

export class ActiveWorkRuntimeEventMapper {
  readonly #starts = new Map<string, number[]>();
  readonly #delegationStarts = new Map<string, number>();
  readonly #delegationStatuses = new Map<string, ActiveWorkRuntimeEventStatus>();
  readonly #delegationSettlements = new Map<string, ActiveWorkRuntimeEvent>();
  readonly #locale: ToolDisplayLocale;
  readonly #now: () => number;

  constructor(options: ActiveWorkRuntimeEventMapperOptions = {}) {
    this.#locale = options.locale ?? "en";
    this.#now = options.now ?? (() => Date.now());
  }

  build(
    event: Extract<RuntimeEvent, { kind: "tool-start" | "tool-result" }>
  ): ActiveWorkRuntimeEvent {
    if (event.kind === "tool-start") {
      this.#pushStart(this.#eventKey(event));
      if (event.tool === "delegate_task") {
        this.#delegationStatuses.clear();
        this.#delegationStarts.clear();
      }
      return {
        id: event.activityId,
        toolName: event.tool,
        displayLabel: toolDisplayLabel(event.tool, this.#locale),
        status: "running",
        summary: "preparing",
        target: event.tool === "delegate_task"
          ? delegationStartingLabel(this.#locale)
          : event.displayPreview ?? event.targetSummary ?? toolDisplayLabel(event.tool),
        detailsRef: event.activityId,
      };
    }

    const elapsedMs = this.#popElapsed(this.#eventKey(event));
    const gated = event.decision !== undefined && event.decision !== "allow";
    const failed = event.ok === false;
    const status: ActiveWorkRuntimeEventStatus = gated ? "gated" : failed ? "failed" : "done";
    const delegationTarget = event.tool === "delegate_task"
      ? delegationCompletionLabel(this.#delegationStatuses, status, this.#locale)
      : undefined;
    if (event.tool === "delegate_task") {
      this.#delegationStatuses.clear();
      this.#delegationStarts.clear();
    }

    return {
      id: event.activityId,
      toolName: event.tool,
      displayLabel: toolDisplayLabel(event.tool, this.#locale),
      status,
      summary: gated ? "gated" : failed ? "failed" : activeWorkSummaryKeyForTool(event.tool),
      target: delegationTarget ?? event.displayPreview ?? event.targetSummary ?? toolDisplayLabel(event.tool),
      ...(elapsedMs === undefined ? {} : { durationMs: elapsedMs }),
      detailsRef: event.activityId,
      ...(gated ? { riskClass: event.riskClass } : {}),
      ...(event.fileChangePreview === undefined ? {} : { fileChangeInspected: true }),
    };
  }

  buildDelegationProgress(
    event: Extract<RuntimeEvent, { kind: "delegation-progress" }>
  ): ActiveWorkRuntimeEvent {
    const id = `subagent:${event.childSessionId}`;
    const settled = this.#delegationSettlements.get(id);
    if (settled !== undefined) {
      return settled;
    }
    const now = this.#now();
    const startedAt = this.#delegationStarts.get(id) ?? now;
    if (!this.#delegationStarts.has(id)) {
      this.#delegationStarts.set(id, startedAt);
    }

    const terminal = event.childEvent.kind === "delegation-result";
    if (terminal) {
      this.#delegationStarts.delete(id);
    }
    const activityLabel = delegationActivityLabel(event.childEvent, this.#locale);
    const activity = delegationWorkerActivity(event.childEvent, activityLabel, now);
    const status = delegationRuntimeStatus(event.childEvent);
    this.#delegationStatuses.set(id, status);

    const mapped: ActiveWorkRuntimeEvent = {
      id,
      toolName: "delegate_task",
      displayLabel: delegationChildLabel(event.role, event.taskIndex, this.#locale),
      source: "subagent",
      groupId: event.batchId ?? event.subagentId,
      ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
      taskIndex: event.taskIndex,
      taskLabel: event.taskLabel,
      batchTaskCount: event.batchTaskCount,
      ...(activity === undefined ? {} : { activity }),
      ...(terminal ? { delegationOutcome: event.childEvent.status ?? "failed" } : {}),
      status,
      summary: activityLabel,
      target: formatDelegationActivityTarget(activityLabel, event.childEvent.displayPreview),
      startedAtMs: startedAt,
      ...(terminal ? { endedAtMs: now, durationMs: Math.max(0, now - startedAt) } : {}),
      detailsRef: event.childSessionId,
    };
    if (terminal) {
      this.#delegationSettlements.set(id, mapped);
      while (this.#delegationSettlements.size > MAX_REMEMBERED_DELEGATION_SETTLEMENTS) {
        const oldestId = this.#delegationSettlements.keys().next().value;
        if (oldestId === undefined) break;
        this.#delegationSettlements.delete(oldestId);
      }
    }
    return mapped;
  }

  #pushStart(key: string): void {
    const starts = this.#starts.get(key) ?? [];
    starts.push(this.#now());
    this.#starts.set(key, starts);
  }

  #popElapsed(key: string): number | undefined {
    const starts = this.#starts.get(key);
    const startedAt = starts?.shift();

    if (starts !== undefined && starts.length === 0) {
      this.#starts.delete(key);
    }

    if (startedAt === undefined) return undefined;
    return this.#now() - startedAt;
  }

  #eventKey(event: Extract<RuntimeEvent, { kind: "tool-start" | "tool-result" }>): string {
    return event.activityId ?? `${event.tool}\0${event.targetSummary ?? ""}`;
  }
}

function delegationStartingLabel(locale: ToolDisplayLocale): string {
  return locale === "ar" ? "بدء الوكلاء الفرعيين" : "starting subagents";
}

function delegationCompletionLabel(
  statuses: ReadonlyMap<string, ActiveWorkRuntimeEventStatus>,
  parentStatus: ActiveWorkRuntimeEventStatus,
  locale: ToolDisplayLocale
): string {
  if (statuses.size === 0) {
    if (parentStatus === "gated") return locale === "ar" ? "بانتظار الموافقة" : "approval required";
    if (parentStatus === "failed") return locale === "ar" ? "فشل الإسناد" : "delegation failed";
    return locale === "ar" ? "اكتمل الإسناد" : "delegation completed";
  }

  const values = [...statuses.values()];
  const completed = values.filter((status) => status === "done").length;
  const cancelled = values.filter((status) => status === "cancelled").length;
  const timedOut = values.filter((status) => status === "timeout").length;
  const blocked = values.filter((status) => status === "blocked").length;
  const failed = values.filter((status) => status === "failed").length;
  const unresolved = values.length - completed - cancelled - timedOut - blocked - failed;
  const parts = locale === "ar"
    ? [
        completed > 0 ? `${completed} مكتملة` : undefined,
        cancelled > 0 ? `${cancelled} ملغاة` : undefined,
        timedOut > 0 ? `${timedOut} انتهت مهلتها` : undefined,
        blocked > 0 ? `${blocked} محظورة` : undefined,
        failed > 0 ? `${failed} فاشلة` : undefined,
        unresolved > 0 ? `${unresolved} غير محسومة` : undefined,
      ]
    : [
        completed > 0 ? `${completed} completed` : undefined,
        cancelled > 0 ? `${cancelled} cancelled` : undefined,
        timedOut > 0 ? `${timedOut} timed out` : undefined,
        blocked > 0 ? `${blocked} blocked` : undefined,
        failed > 0 ? `${failed} failed` : undefined,
        unresolved > 0 ? `${unresolved} unresolved` : undefined,
      ];
  return parts.filter((part): part is string => part !== undefined).join(" · ");
}

export function createActiveWorkRuntimeState(
  input: Partial<ToolActivityState> = {}
): ToolActivityState {
  return {
    ...createDefaultToolActivityState(),
    ...input,
    items: input.items?.map((item) => ({
      ...item,
      ...(item.activityLog === undefined
        ? {}
        : {
            activityLog: item.activityLog
              .map(normalizeWorkerActivity)
              .slice(-MAX_DELEGATION_WORKER_ACTIVITY_ROWS)
          })
    })) ?? [],
  };
}

export function applyActiveWorkRuntimeEvent(
  state: ToolActivityState,
  event: ActiveWorkRuntimeEvent
): ToolActivityState {
  const id = normalizeActiveWorkRuntimeEventId(event);
  const existingIndex = state.items.findIndex((item) => item.id === id);
  const existing = existingIndex < 0 ? undefined : state.items[existingIndex];
  const item = createActiveWorkItem(event, id, existing);
  const items = existingIndex < 0
    ? [...state.items, item]
    : state.items.map((current, index) => index === existingIndex ? item : current);

  return {
    ...state,
    items,
  };
}

function createActiveWorkItem(
  event: ActiveWorkRuntimeEvent,
  id: string,
  existing: ActiveWorkItem | undefined
): ActiveWorkItem {
  return {
    ...(existing ?? {}),
    id,
    toolName: normalizeText(event.toolName, "tool"),
    ...(event.displayLabel === undefined && existing?.displayLabel === undefined
      ? {}
      : { displayLabel: event.displayLabel ?? existing?.displayLabel }),
    ...(event.source === undefined && existing?.source === undefined
      ? {}
      : { source: event.source ?? existing?.source }),
    ...(event.groupId === undefined && existing?.groupId === undefined
      ? {}
      : { groupId: event.groupId ?? existing?.groupId }),
    ...(event.taskId === undefined && existing?.taskId === undefined
      ? {}
      : { taskId: event.taskId ?? existing?.taskId }),
    ...(event.taskIndex === undefined && existing?.taskIndex === undefined
      ? {}
      : { taskIndex: normalizeTaskIndex(event.taskIndex ?? existing?.taskIndex) }),
    ...(event.taskLabel === undefined && existing?.taskLabel === undefined
      ? {}
      : { taskLabel: normalizeText(event.taskLabel ?? existing?.taskLabel, "delegated task") }),
    ...(event.batchTaskCount === undefined && existing?.batchTaskCount === undefined
      ? {}
      : { batchTaskCount: normalizePositiveInteger(event.batchTaskCount ?? existing?.batchTaskCount) }),
    ...(event.activity === undefined && existing?.activityLog === undefined
      ? {}
      : { activityLog: mergeWorkerActivityLog(existing?.activityLog, event.activity) }),
    ...(event.delegationOutcome === undefined && existing?.delegationOutcome === undefined
      ? {}
      : { delegationOutcome: event.delegationOutcome ?? existing?.delegationOutcome }),
    status: mapRuntimeStatus(event.status),
    summary: normalizeText(event.summary, event.status),
    ...(event.target === undefined && existing?.target === undefined ? {} : { target: event.target ?? existing?.target }),
    ...(event.startedAtMs === undefined && existing?.startedAtMs === undefined
      ? {}
      : { startedAtMs: normalizeTimestamp(event.startedAtMs ?? existing?.startedAtMs ?? 0) }),
    ...(event.endedAtMs === undefined && existing?.endedAtMs === undefined
      ? {}
      : { endedAtMs: normalizeTimestamp(event.endedAtMs ?? existing?.endedAtMs ?? 0) }),
    ...(event.durationMs === undefined && existing?.durationMs === undefined
      ? {}
      : { durationMs: normalizeDuration(event.durationMs ?? existing?.durationMs ?? 0) }),
    ...(event.detailsRef === undefined && existing?.detailsRef === undefined
      ? {}
      : { detailsRef: event.detailsRef ?? existing?.detailsRef }),
    ...(riskLevelForClass(event.riskClass ?? existing?.riskLevel) === undefined
      ? {}
      : { riskLevel: riskLevelForClass(event.riskClass ?? existing?.riskLevel) }),
    ...(event.approvalRef === undefined && existing?.approvalRef === undefined
      ? {}
      : { approvalRef: event.approvalRef ?? existing?.approvalRef }),
    ...(event.fileChangeInspected === true || existing?.fileChangeInspected === true
      ? { fileChangeInspected: true }
      : {}),
  };
}

function delegationChildLabel(
  _role: Extract<RuntimeEvent, { kind: "delegation-progress" }>["role"],
  taskIndex: number | undefined,
  _locale: ToolDisplayLocale
): string {
  return taskIndex === undefined ? "Subagent" : `Subagent ${taskIndex + 1}`;
}

function delegationActivityLabel(
  event: Extract<RuntimeEvent, { kind: "delegation-progress" }>["childEvent"],
  locale: ToolDisplayLocale
): string {
  switch (event.kind) {
    case "agent-start":
      return locale === "ar" ? "بدء العمل" : "starting";
    case "tool-start":
    case "tool-result":
      return toolDisplayLabel(event.tool ?? "tool", locale);
    case "provider-attempt":
    case "provider-result":
      return locale === "ar" ? "يفكر" : "thinking";
    case "provider-budget-exhausted":
      return locale === "ar" ? "انتهت الميزانية" : "budget exhausted";
    case "agent-final":
      return locale === "ar" ? "إنهاء العمل" : "finalizing";
    case "agent-cancelled":
      return locale === "ar" ? "جارٍ الإلغاء" : "cancelling";
    case "assistant-preview":
      return locale === "ar" ? "يكتب الإجابة" : "answering";
    case "delegation-result":
      return delegationResultLabel(event.status, locale);
  }
}

function delegationRuntimeStatus(
  event: Extract<RuntimeEvent, { kind: "delegation-progress" }>["childEvent"]
): ActiveWorkRuntimeEventStatus {
  if (event.kind !== "delegation-result") return "running";
  switch (event.status) {
    case "completed":
      return "done";
    case "cancelled":
      return "cancelled";
    case "blocked":
      return "blocked";
    case "timeout":
      return "timeout";
    case "failed":
    default:
      return "failed";
  }
}

function delegationResultLabel(
  status: Extract<RuntimeEvent, { kind: "delegation-progress" }>["childEvent"]["status"],
  locale: ToolDisplayLocale
): string {
  switch (status) {
    case "completed":
      return locale === "ar" ? "اكتمل" : "completed";
    case "blocked":
      return locale === "ar" ? "محظور" : "blocked";
    case "timeout":
      return locale === "ar" ? "انتهت المهلة" : "timed out";
    case "cancelled":
      return locale === "ar" ? "أُلغي" : "cancelled";
    case "failed":
    default:
      return locale === "ar" ? "فشل" : "failed";
  }
}

export function formatPlainDelegationProgressEvent(
  event: Extract<RuntimeEvent, { kind: "delegation-progress" }>,
  locale: ToolDisplayLocale = "en"
): string | undefined {
  const childLabel = delegationChildLabel(event.role, event.taskIndex, locale);
  if (event.childEvent.kind === "agent-start") {
    return locale === "ar"
      ? `${childLabel}: بدء العمل`
      : `${childLabel}: started`;
  }
  if (event.childEvent.kind === "delegation-result") {
    return locale === "ar"
      ? `${childLabel}: ${delegationResultLabel(event.childEvent.status, locale)}`
      : `${childLabel}: ${delegationResultLabel(event.childEvent.status, locale)}`;
  }
  return undefined;
}

export function normalizeActiveWorkRuntimeEventId(event: ActiveWorkRuntimeEvent): string {
  const explicit = event.id?.trim();
  if (explicit !== undefined && explicit.length > 0) return explicit;
  return `${normalizeText(event.toolName, "tool")}\0${event.target ?? ""}`;
}

function mapRuntimeStatus(status: ActiveWorkRuntimeEventStatus): ActiveWorkItemStatus {
  switch (status) {
    case "pending":
      return "queued";
    case "running":
      return "running";
    case "done":
      return "succeeded";
    case "failed":
      return "failed";
    case "gated":
      return "awaitingApproval";
    case "cancelled":
      return "cancelled";
    case "blocked":
    case "timeout":
      return "failed";
  }
}

function riskLevelForClass(riskClass: string | undefined): ActiveWorkItem["riskLevel"] | undefined {
  switch (riskClass) {
    case "high":
    case "destructive-local":
    case "credential-access":
    case "sandbox-escape":
    case "spend-money":
    case "workspace-write":
      return "high";
    case "medium":
    case "external-side-effect":
      return "medium";
    case "low":
    case "read-only":
      return "low";
    default:
      return undefined;
  }
}

function normalizeText(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? fallback : normalized;
}

function normalizeDuration(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function normalizeTimestamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function normalizeTaskIndex(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.floor(value));
}

function normalizePositiveInteger(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.max(1, Math.floor(value));
}

function mergeWorkerActivityLog(
  existing: readonly ActiveWorkActivity[] | undefined,
  activity: ActiveWorkActivity | undefined
): readonly ActiveWorkActivity[] {
  const current = existing?.map(normalizeWorkerActivity) ?? [];
  if (activity === undefined) return current.slice(-MAX_DELEGATION_WORKER_ACTIVITY_ROWS);
  const normalized = normalizeWorkerActivity(activity);
  const existingIndex = current.findIndex((entry) => entry.id === normalized.id);
  const merged = existingIndex < 0
    ? [...current, normalized]
    : current.map((entry, index) => index === existingIndex ? normalized : entry);
  return merged.slice(-MAX_DELEGATION_WORKER_ACTIVITY_ROWS);
}

function normalizeWorkerActivity(activity: ActiveWorkActivity): ActiveWorkActivity {
  const detail = activity.detail === undefined
    ? undefined
    : normalizeBoundedActivityText(activity.detail, "");
  return {
    id: normalizeBoundedActivityText(activity.id, "activity"),
    label: normalizeBoundedActivityText(activity.label, "working"),
    ...(detail === undefined || detail.length === 0 ? {} : { detail }),
    status: activity.status
  };
}

function normalizeBoundedActivityText(value: string, fallback: string): string {
  const normalized = value.trim().replace(/\s+/gu, " ");
  const resolved = normalized.length === 0 ? fallback : normalized;
  return resolved.slice(0, MAX_WORKER_ACTIVITY_TEXT_CHARS);
}

function delegationWorkerActivity(
  event: Extract<RuntimeEvent, { kind: "delegation-progress" }>["childEvent"],
  label: string,
  now: number
): ActiveWorkActivity | undefined {
  if (event.kind === "delegation-result") return undefined;
  const id = event.kind === "tool-start" || event.kind === "tool-result"
    ? `tool:${event.activityId ?? `${event.tool ?? "tool"}:${event.kind}:${now}`}`
    : delegationLifecycleActivityId(event.kind);
  const status: ActiveWorkActivity["status"] = event.kind === "tool-result"
    ? event.ok === false || (event.decision !== undefined && event.decision !== "allow") ? "failed" : "succeeded"
    : event.kind === "provider-budget-exhausted" ||
        (event.kind === "provider-result" && event.ok === false && event.willFallback !== true)
      ? "failed"
      : "running";
  return {
    id,
    label,
    ...(event.displayPreview === undefined ? {} : { detail: event.displayPreview }),
    status
  };
}

function delegationLifecycleActivityId(
  kind: Exclude<
    Extract<RuntimeEvent, { kind: "delegation-progress" }>["childEvent"]["kind"],
    "tool-start" | "tool-result" | "delegation-result"
  >
): string {
  if (kind === "provider-attempt" || kind === "provider-result") return "provider";
  return `lifecycle:${kind}`;
}

function formatDelegationActivityTarget(label: string, detail: string | undefined): string {
  return detail === undefined ? label : `${label} · ${detail}`;
}

function activeWorkSummaryKeyForTool(tool: string): string {
  if (tool.includes("read") || tool.includes("workspace") || tool.includes("file")) return "read";
  if (tool.includes("write") || tool.includes("artifact") || tool.includes("trajectory")) return "write";
  if (tool.includes("terminal") || tool.includes("process") || tool.includes("execute") || tool.includes("python")) return "run";
  if (tool.includes("web") || tool.includes("browser")) return "fetch";
  if (tool.includes("review")) return "review";
  if (tool.includes("memory")) return "memo";
  if (tool.includes("delegate")) return "delegate";
  if (tool.includes("config") || tool.includes("onboarding")) return "config";
  if (tool.includes("media")) return "media";
  if (tool.includes("skill") || tool.includes("workflow")) return "plan";
  return "run";
}
