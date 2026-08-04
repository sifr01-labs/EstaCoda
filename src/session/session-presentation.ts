import type { ChannelKind } from "../contracts/channel.js";
import type {
  SessionMessage,
  SessionRecord,
  SessionSummaryRecord,
} from "../contracts/session.js";
import { redactSensitiveText } from "../utils/redaction.js";

export const DEFAULT_SESSION_TITLE = "EstaCoda session";
export const UNTITLED_SESSION_DESCRIPTION = "Untitled session";
export const SESSION_DESCRIPTION_MAX_GRAPHEMES = 96;

export const INTERNAL_SESSION_KINDS = [
  "delegated-child",
  "task-foreground-host",
  "task-operator-origin",
  "task-step-worker",
] as const;

const INTERNAL_SESSION_KIND_SET = new Set<string>(INTERNAL_SESSION_KINDS);

const DESCRIPTION_CONTROL_PATTERN = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu;
const ANSI_ESCAPE_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/gu;

export type SessionPresentation = {
  id: string;
  profileId: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  originSurface?: ChannelKind;
  workspaceRoot?: string;
  messageCount: number;
  userMessageCount: number;
  hasUserActivity: boolean;
  userFacingRoot: boolean;
  resumable: boolean;
};

export function buildSessionPresentation(summary: SessionSummaryRecord): SessionPresentation {
  const userFacingRoot = isUserFacingRootSession(summary.session);
  const hasUserActivity = summary.userMessageCount > 0;
  return {
    id: summary.session.id,
    profileId: summary.session.profileId,
    description: deriveSessionDescription(summary.session.title, summary.firstUserMessage?.content),
    createdAt: summary.session.createdAt,
    updatedAt: summary.session.updatedAt,
    originSurface: resolveSessionOriginSurface(summary.session, summary.firstUserMessage),
    workspaceRoot: resolveSessionWorkspaceRoot(summary.session),
    messageCount: summary.messageCount,
    userMessageCount: summary.userMessageCount,
    hasUserActivity,
    userFacingRoot,
    resumable: userFacingRoot && hasUserActivity && summary.session.endedAt === undefined,
  };
}

export function deriveSessionDescription(title: string | undefined, firstUserText?: string): string {
  const source = isPlaceholderSessionTitle(title) ? firstUserText : title;
  return sanitizeSessionDescription(source);
}

export function sanitizeSessionDescription(value: string | undefined): string {
  const redacted = redactSensitiveText(value ?? "")
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(DESCRIPTION_CONTROL_PATTERN, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (redacted.length === 0) {
    return UNTITLED_SESSION_DESCRIPTION;
  }
  return truncateGraphemes(redacted, SESSION_DESCRIPTION_MAX_GRAPHEMES);
}

export function isPlaceholderSessionTitle(value: string | undefined): boolean {
  const normalized = value?.trim().toLocaleLowerCase("en") ?? "";
  return normalized.length === 0 ||
    normalized === DEFAULT_SESSION_TITLE.toLocaleLowerCase("en") ||
    normalized === UNTITLED_SESSION_DESCRIPTION.toLocaleLowerCase("en");
}

export function resolveSessionOriginSurface(
  session: SessionRecord,
  firstUserMessage?: Pick<SessionMessage, "channel">
): ChannelKind | undefined {
  const stored = normalizeSurface(session.metadata?.originSurface);
  return stored ?? normalizeSurface(session.metadata?.surfaceType) ?? normalizeSurface(firstUserMessage?.channel);
}

export function withImmutableSessionOrigin(
  metadata: Record<string, unknown> | undefined,
  surface: ChannelKind | undefined
): Record<string, unknown> | undefined {
  if (normalizeSurface(metadata?.originSurface) !== undefined) {
    return metadata;
  }
  const originSurface = normalizeSurface(metadata?.surfaceType) ?? normalizeSurface(surface);
  if (originSurface === undefined) {
    return metadata;
  }
  return {
    ...(metadata ?? {}),
    originSurface,
  };
}

export function resolveSessionWorkspaceRoot(session: SessionRecord): string | undefined {
  return firstNonEmptyString(
    session.metadata?.workspaceRoot,
    session.metadata?.workspaceDirectory,
    session.metadata?.projectRoot
  );
}

export function isUserFacingRootSession(session: SessionRecord): boolean {
  if (session.parentSessionId !== undefined) {
    return false;
  }
  const kind = firstNonEmptyString(session.metadata?.kind);
  return kind === undefined || !INTERNAL_SESSION_KIND_SET.has(kind);
}

function normalizeSurface(value: unknown): ChannelKind | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  const normalized = trimmed.replace(DESCRIPTION_CONTROL_PATTERN, "");
  if (normalized !== trimmed) {
    return undefined;
  }
  return /^[a-z0-9][a-z0-9._-]{0,31}$/iu.test(normalized) ? normalized as ChannelKind : undefined;
}

function firstNonEmptyString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function truncateGraphemes(value: string, maxGraphemes: number): string {
  if (typeof Intl.Segmenter === "function") {
    const segments = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)];
    if (segments.length <= maxGraphemes) {
      return value;
    }
    return `${segments.slice(0, Math.max(0, maxGraphemes - 1)).map((entry) => entry.segment).join("")}…`;
  }
  const codePoints = Array.from(value);
  return codePoints.length <= maxGraphemes
    ? value
    : `${codePoints.slice(0, Math.max(0, maxGraphemes - 1)).join("")}…`;
}
