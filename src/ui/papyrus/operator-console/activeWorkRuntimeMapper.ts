import type { RuntimeEvent } from "../../../contracts/runtime-event.js";
import { toolDisplayLabel, type ToolDisplayLocale } from "../../tool-display.js";
import type {
  ActiveWorkItem,
  ActiveWorkItemStatus,
  ToolActivityState,
} from "./operatorConsoleState.js";
import { createDefaultToolActivityState } from "./operatorConsoleState.js";

export type ActiveWorkRuntimeEventStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "gated"
  | "cancelled";

export type ActiveWorkRuntimeEvent = {
  readonly id?: string;
  readonly toolName: string;
  readonly displayLabel?: string;
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
      return {
        id: event.activityId,
        toolName: event.tool,
        displayLabel: toolDisplayLabel(event.tool, this.#locale),
        status: "running",
        summary: "preparing",
        target: event.displayPreview ?? event.targetSummary ?? toolDisplayLabel(event.tool),
        detailsRef: event.activityId,
      };
    }

    const elapsedMs = this.#popElapsed(this.#eventKey(event));
    const gated = event.decision !== undefined && event.decision !== "allow";
    const failed = event.ok === false;
    const status: ActiveWorkRuntimeEventStatus = gated ? "gated" : failed ? "failed" : "done";

    return {
      id: event.activityId,
      toolName: event.tool,
      displayLabel: toolDisplayLabel(event.tool, this.#locale),
      status,
      summary: gated ? "gated" : failed ? "failed" : activeWorkSummaryKeyForTool(event.tool),
      target: event.displayPreview ?? event.targetSummary ?? toolDisplayLabel(event.tool),
      ...(elapsedMs === undefined ? {} : { durationMs: elapsedMs }),
      detailsRef: event.activityId,
      ...(gated ? { riskClass: event.riskClass } : {}),
      ...(event.fileChangePreview === undefined ? {} : { fileChangeInspected: true }),
    };
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
