import type { SessionDB, SessionRecord } from "../contracts/session.js";
import type { SourceWorkspaceBinding } from "../contracts/workspace.js";
import { ExecutionTargetStore, targetBinding, targetSessionMetadata } from "../workspaces/execution-target.js";
import { resolveWorkspaceDirectory } from "../workspaces/workspace-registry.js";
import { resolveSessionOriginSurface, resolveSessionWorkspaceRoot } from "./session-presentation.js";

export async function validateSessionWorkspaceOwnership(input: {
  session: SessionRecord;
  profileId: string;
  workspaceRoot: string;
  homeDir?: string;
  allowLegacyLocalBinding?: boolean;
}): Promise<void> {
  const { session } = input;
  if (session.profileId !== input.profileId) throw new Error("Session belongs to a different profile.");
  if (session.endedAt !== undefined) throw new Error("Session has ended and cannot resume execution.");
  const actual = await resolveWorkspaceDirectory(input.workspaceRoot);
  const storedRoot = resolveSessionWorkspaceRoot(session);
  for (const key of ["workspaceRoot", "workspaceDirectory", "projectRoot"]) {
    const path = session.metadata?.[key];
    if (path !== undefined && (typeof path !== "string" || path.trim().length === 0 || (await resolveWorkspaceDirectory(path)).identityHash !== actual.identityHash)) {
      throw new Error("Session belongs to a different workspace.");
    }
  }
  if (storedRoot === undefined && session.executionTarget === undefined && !(input.allowLegacyLocalBinding === true &&
    resolveSessionOriginSurface(session) === "cli" && session.parentSessionId === undefined)) {
    throw new Error("Legacy Session workspace ownership is ambiguous. Select an established local session or start new work.");
  }
  if (session.executionTarget !== undefined) {
    const targets = new ExecutionTargetStore({ homeDir: input.homeDir, profileId: input.profileId });
    try { await targets.validate(session.executionTarget, actual.canonicalPath); }
    finally { targets.close(); }
  }
}

/** Called before tools/providers are constructed. Registry acquisition and Session
 * creation are recoverable references, not a claimed cross-file transaction.
 * Orphan target records after a failed Session insert are safe to reuse. */
export async function ensureRuntimeSession(input: {
  sessionDb: SessionDB;
  sessionId: string;
  profileId: string;
  workspaceRoot: string;
  homeDir?: string;
  durable: boolean;
  sourceWorkspace?: SourceWorkspaceBinding;
  allowLegacyLocalBinding?: boolean;
  metadata?: Record<string, unknown>;
  spendingLimit?: import("../contracts/budget.js").SpendingLimit;
}): Promise<void> {
  input = { ...input, workspaceRoot: (await resolveWorkspaceDirectory(input.workspaceRoot)).canonicalPath };
  let session = await input.sessionDb.getSession(input.sessionId);
  if (session !== undefined) await validateSessionWorkspaceOwnership({ ...input, session });
  const targets = input.durable ? new ExecutionTargetStore({ homeDir: input.homeDir, profileId: input.profileId }) : undefined;
  try {
    const binding = session?.executionTarget ?? (targets === undefined ? undefined : targetBinding(await targets.acquireLocal(input.workspaceRoot, input.sourceWorkspace)));
    if (session === undefined) {
      try {
        await input.sessionDb.createSession({ id: input.sessionId, profileId: input.profileId, title: "EstaCoda session",
          spendingLimit: input.spendingLimit, executionTarget: binding,
          metadata: targetSessionMetadata({ ...input.metadata, workspaceRoot: input.workspaceRoot }, binding) });
        return;
      } catch (error) {
        session = await input.sessionDb.getSession(input.sessionId);
        if (session === undefined) throw error;
        await validateSessionWorkspaceOwnership({ ...input, session });
        if (binding !== undefined && JSON.stringify(session.executionTarget) !== JSON.stringify(binding)) throw new Error("Concurrent Session creation selected another execution target.");
      }
    }
    if (binding !== undefined && session.executionTarget === undefined) {
      if (input.sessionDb.bindSessionExecutionTarget === undefined) throw new Error("Session store cannot persist an execution target safely.");
      await input.sessionDb.bindSessionExecutionTarget({ sessionId: session.id, profileId: input.profileId, binding, expectedMetadata: session.metadata });
    }
  } finally { targets?.close(); }
}
