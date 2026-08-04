import type { SessionDB } from "../contracts/session.js";
import {
  buildSessionPresentation,
  isUserFacingRootSession,
  resolveSessionWorkspaceRoot,
  type SessionPresentation,
} from "./session-presentation.js";

export type SessionResumeFailure = "not-found" | "not-resumable";

export async function listResumableSessions(input: {
  sessionDb: SessionDB;
  profileId: string;
  workspaceRoot: string;
  limit: number;
  excludeSessionId?: string;
}): Promise<SessionPresentation[]> {
  const summaries = await input.sessionDb.listSessionSummaries(input.profileId, {
    workspaceRoot: input.workspaceRoot,
    limit: input.limit,
    rootSessionsOnly: true,
    activeSessionsOnly: true,
    userActivityOnly: true,
    userFacingOnly: true,
  });
  return summaries
    .map(buildSessionPresentation)
    .filter((session) => session.resumable && session.id !== input.excludeSessionId);
}

export async function resolveSessionForResume(input: {
  sessionDb: SessionDB;
  profileId: string;
  workspaceRoot: string;
  sessionId: string;
}): Promise<{ ok: true; sessionId: string } | { ok: false; reason: SessionResumeFailure }> {
  const session = await input.sessionDb.getSession(input.sessionId);
  if (session === undefined || session.profileId !== input.profileId) {
    return { ok: false, reason: "not-found" };
  }
  if (
    session.endedAt !== undefined ||
    !isUserFacingRootSession(session) ||
    resolveSessionWorkspaceRoot(session) !== input.workspaceRoot
  ) {
    return { ok: false, reason: "not-resumable" };
  }
  return { ok: true, sessionId: session.id };
}
