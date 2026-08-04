import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SmokeCase } from "../smoke-case.js";
import { PersistentCliSessionStore } from "../../cli/cli-session-store.js";
import { InMemorySessionDB } from "../../session/in-memory-session-db.js";
import { listResumableSessions, resolveSessionForResume } from "../../session/session-resume.js";

export const session_continuation_case: SmokeCase = {
  id: "session-continuation",
  name: "Session continuation stays profile- and workspace-scoped",
  tags: ["sessions", "cli", "security"],
  run: async () => {
    const tempHome = await mkdtemp(join(tmpdir(), "estacoda-smoke-session-continuation-"));
    const workspaceRoot = join(tempHome, "workspace");
    const otherWorkspaceRoot = join(tempHome, "other-workspace");

    try {
      const sessionDb = new InMemorySessionDB();
      await sessionDb.createSession({
        id: "telegram-session",
        profileId: "default",
        title: "Review the gateway deployment",
        metadata: { workspaceRoot },
      });
      await sessionDb.appendMessage({
        id: "telegram-message",
        sessionId: "telegram-session",
        role: "user",
        content: "Review the gateway deployment",
        channel: "telegram",
      });
      await sessionDb.appendMessage({
        id: "cli-message",
        sessionId: "telegram-session",
        role: "user",
        content: "Continue from the CLI",
        channel: "cli",
      });

      const sessions = await listResumableSessions({
        sessionDb,
        profileId: "default",
        workspaceRoot,
        limit: 20,
      });
      if (sessions.length !== 1 || sessions[0]?.id !== "telegram-session") {
        throw new Error("Expected the user-facing session in the current profile and workspace.");
      }
      if (sessions[0].originSurface !== "telegram") {
        throw new Error("Expected the immutable Telegram origin to survive CLI activity.");
      }

      const sameWorkspace = await resolveSessionForResume({
        sessionDb,
        profileId: "default",
        workspaceRoot,
        sessionId: "telegram-session",
      });
      if (!sameWorkspace.ok) {
        throw new Error("Expected the session to be resumable in its owning scope.");
      }
      const otherWorkspace = await resolveSessionForResume({
        sessionDb,
        profileId: "default",
        workspaceRoot: otherWorkspaceRoot,
        sessionId: "telegram-session",
      });
      if (otherWorkspace.ok) {
        throw new Error("A session must not resume across workspace boundaries.");
      }

      const cliSessions = new PersistentCliSessionStore({ homeDir: tempHome });
      await cliSessions.setSessionId({
        profileId: "default",
        workspaceRoot,
        sessionId: "telegram-session",
      });
      const stored = await cliSessions.getSessionId({ profileId: "default", workspaceRoot });
      if (stored !== "telegram-session") {
        throw new Error("Expected the scoped CLI continuation pointer to round-trip.");
      }
      if (await cliSessions.getSessionId({ profileId: "work", workspaceRoot }) !== undefined) {
        throw new Error("A CLI continuation pointer must not cross profile boundaries.");
      }
      if (await cliSessions.getSessionId({ profileId: "default", workspaceRoot: otherWorkspaceRoot }) !== undefined) {
        throw new Error("A CLI continuation pointer must not cross workspace boundaries.");
      }
    } finally {
      await rm(tempHome, { recursive: true, force: true });
    }
  },
};
