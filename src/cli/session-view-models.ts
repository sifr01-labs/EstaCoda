// v0.95 Session ViewModel Builders
// Pure factory functions. No formatting, ANSI, terminal-width, or rendering logic.

import type { SessionRecord } from "../contracts/session.js";
import type { ViewModel } from "../contracts/view-model.js";
import type { SessionExecutionDiagnosis } from "../session/session-execution-diagnostics.js";
import { formatUsageCost } from "../ui/usage-cost-format.js";
import {
  buildCommandResultViewModel,
  buildKeyValueBlockViewModel,
  buildListViewModel,
  buildWarningErrorViewModel,
  buildPlainFallbackViewModel,
  kv,
  listItem,
} from "../ui/view-models/builders.js";

// ─────────────────────────────────────────────────────────────
// Sessions Help
// ─────────────────────────────────────────────────────────────

export function buildSessionsHelpViewModel(): ViewModel {
  return buildCommandResultViewModel({
    ok: true,
    title: "EstaCoda sessions",
    blocks: [
      buildListViewModel({
        items: [
          listItem("estacoda sessions                           Choose and resume a recent session"),
          listItem("estacoda sessions open <session-id>         Resume a session by id"),
          listItem("estacoda sessions list                      List recent sessions"),
          listItem("estacoda sessions recall <query>            Summarize historical session matches"),
          listItem("estacoda sessions compact <session-id> [--topic <topic>]  Compact a session manually"),
          listItem("estacoda sessions show <session-id>         Show session details"),
          listItem("estacoda sessions diagnose <session-id>     Diagnose session execution"),
          listItem("estacoda sessions current                   Show current session"),
          listItem("estacoda sessions attach <surface> <id> <session-id>  Attach surface to session"),
          listItem("estacoda sessions detach <surface> <id>     Detach surface from session"),
        ],
      }),
    ],
  });
}

// ─────────────────────────────────────────────────────────────
// Session Execution Diagnosis
// ─────────────────────────────────────────────────────────────

export function buildSessionExecutionDiagnosisViewModel(data: SessionExecutionDiagnosis): ViewModel {
  const itemCounts = data.mission.items;
  const slowProviderCalls = data.provider.timedCalls === 0
    ? "unknown (no timing receipts)"
    : `${data.provider.slowCalls} of ${data.provider.timedCalls} timed` + (
        data.provider.slowestCallMs === undefined
          ? ""
          : `; slowest ${formatDuration(data.provider.slowestCallMs)}`
      );
  const repeatedItems = data.observations.repeatedGroups.map((group) =>
    listItem(`${group.tool}: ${group.calls} calls`)
  );

  return buildCommandResultViewModel({
    ok: true,
    title: "Session execution diagnosis",
    blocks: [
      buildKeyValueBlockViewModel({
        entries: [
          kv("Session", data.sessionId),
          kv("Provider calls", data.provider.calls),
          kv(
            "Tokens",
            `${data.provider.usageComplete ? "" : "at least "}${data.provider.totalTokens.toLocaleString("en-US")}`
          ),
          kv("Estimated cost", formatUsageCost({
            estimatedCostUsd: data.provider.estimatedCostUsd,
            costComplete: data.provider.costComplete,
          })),
          kv("Slow provider calls", slowProviderCalls),
          kv("Tool calls", data.tools.calls),
          kv("Tool results", `${data.tools.results} (${data.tools.failedResults} failed)`),
          kv("Repeated observation calls", data.observations.repeatedCalls),
          kv("Blocked observations", data.observations.blocked),
        ],
      }),
      buildKeyValueBlockViewModel({
        title: "Plan",
        entries: [
          kv("Activation observed", data.mission.activationObserved ? "yes" : "no"),
          kv("Progress transitions", data.mission.progressTransitions),
          kv("Status", data.mission.status),
          kv(
            "Items",
            `completed ${itemCounts.completed}; in progress ${itemCounts.in_progress}; pending ${itemCounts.pending}; blocked ${itemCounts.blocked}; cancelled ${itemCounts.cancelled}`
          ),
          kv("Final cause", data.finalCause),
        ],
      }),
      buildKeyValueBlockViewModel({
        title: "Execution evidence",
        entries: [
          kv("Mutation evidence", `${data.evidence.mutations} verified`),
          kv("Verification evidence", `${data.evidence.verifications} verified`),
        ],
      }),
      buildKeyValueBlockViewModel({
        title: "Protected authentication",
        entries: [
          kv("Submission observed", data.authentication.submissionObserved),
          kv("Challenge", data.authentication.challenge),
          kv("Document transition occurred", data.authentication.documentTransitionOccurred),
          kv("Causal evidence", data.authentication.causalEvidence),
          kv("Sensitive state", data.authentication.sensitiveState),
          kv("Provider seam", data.authentication.providerSeam),
        ],
      }),
      buildListViewModel({
        title: "Repeated observations (bounded)",
        items: repeatedItems.length > 0 ? repeatedItems : [listItem("none")],
      }),
    ],
  });
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1_000).toFixed(1)}s`;
}

// ─────────────────────────────────────────────────────────────
// Sessions List
// ─────────────────────────────────────────────────────────────

export interface SessionListEntry {
  readonly id: string;
  readonly title?: string;
  readonly updatedAt?: string;
  readonly attachments: readonly string[];
}

export interface SessionsListData {
  readonly sessions: readonly SessionListEntry[];
}

export function buildSessionsListViewModel(data: SessionsListData): ViewModel {
  const items = data.sessions.map((s) => {
    const updated = s.updatedAt ? `updated ${s.updatedAt}` : "no activity";
    const attachment = s.attachments.length > 0 ? ` [${s.attachments.join(", ")}]` : "";
    return listItem(`${s.id} — ${s.title ?? "(no title)"} — ${updated}${attachment}`);
  });

  return buildCommandResultViewModel({
    ok: true,
    title: `Sessions: ${data.sessions.length}`,
    blocks: [buildListViewModel({ items })],
  });
}

// ─────────────────────────────────────────────────────────────
// Session Show
// ─────────────────────────────────────────────────────────────

export interface SessionPointer {
  readonly surfaceType: string;
  readonly surfaceId: string;
  readonly attachedAt: string;
  readonly homeDelivery?: string;
}

export interface SessionShowData {
  readonly session: SessionRecord;
  readonly messageCount: number;
  readonly originSurface?: string;
  readonly workspaceRoot?: string;
  readonly pointers: readonly SessionPointer[];
}

export function buildSessionShowViewModel(data: SessionShowData): ViewModel {
  const session = data.session;
  const pointerItems = data.pointers.map((p) =>
    listItem(`  ${p.surfaceType}:${p.surfaceId} (since ${p.attachedAt})${p.homeDelivery !== undefined ? ` home=${p.homeDelivery}` : ""}`)
  );

  return buildCommandResultViewModel({
    ok: true,
    title: "Session detail",
    blocks: [
      buildKeyValueBlockViewModel({
        entries: [
          kv("Session", session.id),
          kv("Title", session.title ?? "(no title)"),
          kv("Profile", session.profileId),
          kv("Workspace", data.workspaceRoot ?? "unknown"),
          kv("Origin", data.originSurface ?? "unknown"),
          kv("Created", session.createdAt),
          kv("Updated", session.updatedAt ?? "no activity"),
          kv("Messages", data.messageCount),
        ],
      }),
      buildListViewModel({
        title: "Surface pointers",
        items: pointerItems.length > 0 ? pointerItems : [listItem("  none")],
      }),
    ],
  });
}

// ─────────────────────────────────────────────────────────────
// Session Current
// ─────────────────────────────────────────────────────────────

export interface SessionCurrentData {
  readonly sessionId: string;
  readonly pointers: readonly SessionPointer[];
}

export function buildSessionCurrentViewModel(data: SessionCurrentData): ViewModel {
  const pointerItems = data.pointers.map((p) =>
    listItem(`  ${p.surfaceType}:${p.surfaceId} (since ${p.attachedAt})`)
  );

  return buildCommandResultViewModel({
    ok: true,
    title: "Current session",
    blocks: [
      buildPlainFallbackViewModel({
        lines: [`Current session: ${data.sessionId}`],
      }),
      buildListViewModel({
        title: "Surface pointers",
        items: pointerItems.length > 0 ? pointerItems : [listItem("  none")],
      }),
    ],
  });
}

// ─────────────────────────────────────────────────────────────
// Session Attach / Detach
// ─────────────────────────────────────────────────────────────

export interface SessionAttachData {
  readonly surface: string;
  readonly surfaceId: string;
  readonly sessionId: string;
}

export function buildSessionAttachViewModel(data: SessionAttachData): ViewModel {
  return buildCommandResultViewModel({
    ok: true,
    title: "Surface attached",
    blocks: [
      buildPlainFallbackViewModel({
        lines: [`Attached ${data.surface}:${data.surfaceId} to session ${data.sessionId}.`],
      }),
    ],
  });
}

export interface SessionDetachData {
  readonly surface: string;
  readonly surfaceId: string;
}

export function buildSessionDetachViewModel(data: SessionDetachData): ViewModel {
  return buildCommandResultViewModel({
    ok: true,
    title: "Surface detached",
    blocks: [
      buildPlainFallbackViewModel({
        lines: [`Detached ${data.surface}:${data.surfaceId}.`],
      }),
    ],
  });
}

// ─────────────────────────────────────────────────────────────
// Errors
// ─────────────────────────────────────────────────────────────

export interface SessionNotFoundData {
  readonly sessionId: string;
}

export function buildSessionNotFoundViewModel(data: SessionNotFoundData): ViewModel {
  return buildCommandResultViewModel({
    ok: false,
    title: "Session not found",
    blocks: [
      buildWarningErrorViewModel({
        severity: "error",
        title: "Not found",
        message: `Session not found: ${data.sessionId}`,
      }),
    ],
  });
}

export interface NoActiveSessionData {
  readonly message: string;
}

export function buildNoActiveSessionViewModel(data: NoActiveSessionData): ViewModel {
  return buildCommandResultViewModel({
    ok: false,
    title: "No active session",
    blocks: [
      buildWarningErrorViewModel({
        severity: "warn",
        title: "No session",
        message: data.message,
      }),
    ],
  });
}

export interface InvalidSurfaceData {
  readonly surface: string;
  readonly validSurfaces: readonly string[];
}

export function buildInvalidSurfaceViewModel(data: InvalidSurfaceData): ViewModel {
  return buildCommandResultViewModel({
    ok: false,
    title: "Invalid surface",
    blocks: [
      buildWarningErrorViewModel({
        severity: "error",
        title: "Invalid surface",
        message: `Invalid surface: ${data.surface}. Valid: ${data.validSurfaces.join(", ")}`,
      }),
    ],
  });
}

export interface SessionUsageErrorData {
  readonly message: string;
}

export function buildSessionUsageErrorViewModel(data: SessionUsageErrorData): ViewModel {
  return buildCommandResultViewModel({
    ok: false,
    title: "Usage error",
    blocks: [
      buildWarningErrorViewModel({
        severity: "warn",
        title: "Usage",
        message: data.message,
      }),
    ],
  });
}
