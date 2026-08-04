// v0.95 Session ViewModel Builders
// Pure factory functions. No formatting, ANSI, terminal-width, or rendering logic.

import type { SessionRecord } from "../contracts/session.js";
import type { ViewModel } from "../contracts/view-model.js";
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
          listItem("estacoda sessions current                   Show current session"),
          listItem("estacoda sessions attach <surface> <id> <session-id>  Attach surface to session"),
          listItem("estacoda sessions detach <surface> <id>     Detach surface from session"),
        ],
      }),
    ],
  });
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
