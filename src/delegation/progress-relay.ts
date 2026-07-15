import { MAX_DELEGATION_BATCH_TASKS, type DelegateRole } from "../contracts/delegation.js";
import type { RuntimeEvent, RuntimeEventSink } from "../contracts/runtime-event.js";
import { redactToolDisplayPreview } from "../tools/tool-target-summary.js";

export type DelegationProgressMetadata = {
  subagentId: string;
  childSessionId: string;
  parentSessionId: string;
  role: DelegateRole;
  depth: number;
  taskIndex?: number;
  batchId?: string;
  taskLabel?: string;
  batchTaskCount?: number;
};

export type ProgressRelayOptions = {
  metadata: DelegationProgressMetadata;
  parentOnEvent?: RuntimeEventSink;
  throttleMs?: number;
  now?: () => number;
  onActivity?: (event: RuntimeEvent, summary: DelegationProgressSummary) => void;
};

export type DelegationProgressSummary = {
  kind: Extract<RuntimeEvent, { kind: "delegation-progress" }>["childEvent"]["kind"];
  summary: string;
  inToolExecution: boolean;
};

const DEFAULT_THROTTLE_MS = 1_000;
const MAX_PROGRESS_ACTIVITY_ID_CHARS = 160;
const ANSI_PATTERN = /(?:\x1b\][^\x07]*(?:\x07|\x1b\\))|(?:\x1b\[[0-?]*[ -/]*[@-~])|(?:\x1b[ -/]*[@-~])/gu;
const UNSAFE_DISPLAY_CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/gu;
const RELAYED_EVENT_KINDS = new Set<RuntimeEvent["kind"]>([
  "agent-start",
  "tool-start",
  "tool-result",
  "provider-attempt",
  "provider-result",
  "provider-budget-exhausted",
  "agent-final",
  "agent-cancelled"
]);

export function createDelegationProgressRelay(options: ProgressRelayOptions): RuntimeEventSink {
  const throttleMs = Math.max(0, options.throttleMs ?? DEFAULT_THROTTLE_MS);
  const now = options.now ?? Date.now;
  const lastEmittedAt = new Map<string, number>();
  const metadata = normalizeDelegationProgressMetadata(options.metadata);

  return async (event) => {
    const childEvent = toChildEvent(event);
    if (childEvent === undefined) {
      return;
    }
    const summary = summarizeChildEvent(childEvent);
    options.onActivity?.(event, summary);

    const key = throttleKey(childEvent);
    const emittedAt = lastEmittedAt.get(key);
    const currentTime = now();
    if (emittedAt !== undefined && currentTime - emittedAt < throttleMs) {
      return;
    }
    lastEmittedAt.set(key, currentTime);

    await options.parentOnEvent?.({
      kind: "delegation-progress",
      ...metadata,
      childEvent
    });
  };
}

function toChildEvent(event: RuntimeEvent): Extract<RuntimeEvent, { kind: "delegation-progress" }>["childEvent"] | undefined {
  if (!RELAYED_EVENT_KINDS.has(event.kind)) {
    return undefined;
  }

  switch (event.kind) {
    case "agent-start":
      return {
        kind: "agent-start",
        sessionId: event.sessionId
      };
    case "tool-start":
      return {
        kind: "tool-start",
        tool: event.tool,
        ...childToolDisplayMetadata(event)
      };
    case "tool-result":
      return {
        kind: "tool-result",
        tool: event.tool,
        ...childToolDisplayMetadata(event),
        decision: event.decision,
        riskClass: event.riskClass,
        ok: event.ok,
        chars: event.chars,
        sentChars: event.sentChars,
        truncated: event.truncated
      };
    case "provider-attempt":
      return {
        kind: "provider-attempt",
        provider: event.provider,
        model: event.model,
        fallback: event.fallback
      };
    case "provider-result":
      return {
        kind: "provider-result",
        provider: event.provider,
        model: event.model,
        ok: event.ok,
        fallback: event.fallback,
        willFallback: event.willFallback,
        errorClass: event.errorClass,
        finishReason: event.finishReason,
        incompleteReason: event.incompleteReason
      };
    case "provider-budget-exhausted":
      return {
        kind: "provider-budget-exhausted",
        budget: event.budget,
        limit: event.limit,
        observed: event.observed,
        reason: event.reason
      };
    case "agent-final":
      return {
        kind: "agent-final",
        ok: true
      };
    case "agent-cancelled":
      return {
        kind: "agent-cancelled",
        reason: event.reason
      };
    default:
      return undefined;
  }
}

function summarizeChildEvent(event: Extract<RuntimeEvent, { kind: "delegation-progress" }>["childEvent"]): DelegationProgressSummary {
  switch (event.kind) {
    case "tool-start":
      return {
        kind: event.kind,
        summary: `tool-start:${event.tool ?? "unknown"}`,
        inToolExecution: true
      };
    case "tool-result":
      return {
        kind: event.kind,
        summary: `tool-result:${event.tool ?? "unknown"}:${event.ok === false ? "failed" : "ok"}`,
        inToolExecution: false
      };
    case "provider-attempt":
      return {
        kind: event.kind,
        summary: `provider-attempt:${event.provider ?? "unknown"}:${event.model ?? "unknown"}`,
        inToolExecution: false
      };
    case "provider-result":
      return {
        kind: event.kind,
        summary: `provider-result:${event.provider ?? "unknown"}:${event.ok ? "ok" : "failed"}`,
        inToolExecution: false
      };
    default:
      return {
        kind: event.kind,
        summary: event.kind,
        inToolExecution: false
      };
  }
}

function throttleKey(event: Extract<RuntimeEvent, { kind: "delegation-progress" }>["childEvent"]): string {
  return [
    event.kind,
    event.activityId,
    event.tool,
    event.provider,
    event.model,
    event.budget,
    event.reason
  ].filter((value) => value !== undefined).join(":");
}

export function delegationTaskDisplayLabel(task: string): string {
  const sanitized = sanitizeDelegationDisplayText(task);
  return sanitizeDelegationDisplayText(redactToolDisplayPreview(sanitized)) ?? "delegated task";
}

export function normalizeDelegationProgressMetadata(
  metadata: DelegationProgressMetadata
): DelegationProgressMetadata {
  const batchTaskCount = normalizeBatchTaskCount(metadata.batchTaskCount);
  const taskIndex = normalizeTaskIndex(metadata.taskIndex, batchTaskCount);
  return {
    subagentId: metadata.subagentId,
    childSessionId: metadata.childSessionId,
    parentSessionId: metadata.parentSessionId,
    role: metadata.role,
    depth: metadata.depth,
    ...(taskIndex === undefined ? {} : { taskIndex }),
    ...(metadata.batchId === undefined ? {} : { batchId: metadata.batchId }),
    ...(metadata.taskLabel === undefined ? {} : { taskLabel: delegationTaskDisplayLabel(metadata.taskLabel) }),
    ...(batchTaskCount === undefined ? {} : { batchTaskCount })
  };
}

function normalizeBatchTaskCount(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.max(1, Math.min(Math.floor(value), MAX_DELEGATION_BATCH_TASKS));
}

function normalizeTaskIndex(value: number | undefined, batchTaskCount: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const normalized = Math.max(0, Math.floor(value));
  return batchTaskCount === undefined ? normalized : Math.min(normalized, batchTaskCount - 1);
}

function childToolDisplayMetadata(
  event: Extract<RuntimeEvent, { kind: "tool-start" | "tool-result" }>
): { activityId?: string; displayPreview?: string } {
  const activityId = sanitizeActivityId(event.activityId);
  const sanitizedPreview = sanitizeDelegationDisplayText(event.displayPreview);
  const displayPreview = sanitizeDelegationDisplayText(redactToolDisplayPreview(sanitizedPreview));
  return {
    ...(activityId === undefined ? {} : { activityId }),
    ...(displayPreview === undefined ? {} : { displayPreview })
  };
}

function sanitizeActivityId(value: string | undefined): string | undefined {
  const sanitized = sanitizeDelegationDisplayText(value);
  if (sanitized === undefined) return undefined;
  return sanitized.slice(0, MAX_PROGRESS_ACTIVITY_ID_CHARS);
}

function sanitizeDelegationDisplayText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const sanitized = value
    .replace(ANSI_PATTERN, "")
    .replace(UNSAFE_DISPLAY_CONTROL_PATTERN, "")
    .trim()
    .replace(/\s+/gu, " ");
  return sanitized.length === 0 ? undefined : sanitized;
}
