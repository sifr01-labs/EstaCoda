import type { RuntimeEvent } from "../../../contracts/runtime-event.js";
import { toolDisplayLabel, type ToolDisplayLocale } from "../../tool-display.js";
import type {
  ActiveWorkItem,
  ActiveWorkItemStatus,
  ToolActivityState,
} from "./operatorConsoleState.js";
import { createDefaultToolActivityState } from "./operatorConsoleState.js";

const MAX_REMEMBERED_DELEGATION_SETTLEMENTS = 512;

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
  readonly status: ActiveWorkRuntimeEventStatus;
  readonly summary?: string;
  readonly target?: string;
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
    const status = delegationRuntimeStatus(event.childEvent);
    this.#delegationStatuses.set(id, status);

    const mapped: ActiveWorkRuntimeEvent = {
      id,
      toolName: "delegate_task",
      displayLabel: delegationChildLabel(event.role, event.taskIndex, this.#locale),
      source: "subagent",
      groupId: event.batchId ?? event.subagentId,
      status,
      summary: activityLabel,
      target: activityLabel,
      ...(terminal ? { durationMs: Math.max(0, now - startedAt) } : {}),
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
    items: input.items?.map((item) => ({ ...item })) ?? [],
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
    status: mapRuntimeStatus(event.status),
    summary: normalizeText(event.summary, event.status),
    ...(event.target === undefined && existing?.target === undefined ? {} : { target: event.target ?? existing?.target }),
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
  role: Extract<RuntimeEvent, { kind: "delegation-progress" }>["role"],
  taskIndex: number | undefined,
  locale: ToolDisplayLocale
): string {
  const roleLabel = locale === "ar"
    ? role === "orchestrator" ? "منسق" : "وكيل فرعي"
    : role === "orchestrator" ? "Orchestrator" : "Leaf";
  return taskIndex === undefined ? roleLabel : `${roleLabel} ${taskIndex + 1}`;
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
      : `subagent ${childLabel}: started`;
  }
  if (event.childEvent.kind === "delegation-result") {
    return locale === "ar"
      ? `${childLabel}: ${delegationResultLabel(event.childEvent.status, locale)}`
      : `subagent ${childLabel}: ${delegationResultLabel(event.childEvent.status, locale)}`;
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
