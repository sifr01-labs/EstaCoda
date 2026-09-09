import { HostEnvironment } from "../execution/host-environment.js";
import { ensureRuntimeSession } from "../session/session-workspace-ownership.js";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import { resolveWorkspaceDirectory } from "../workspaces/workspace-registry.js";
import type { SessionDB } from "../contracts/session.js";
import type { RuntimeOptions } from "./create-runtime.js";
import type { ResourceCleanup } from "../execution/resource-cleanup.js";

/** Selected-profile configuration is supplied by the surface. Workspace resolution
 * never loads project config. Acquire identity before constructing tool resources;
 * rollback owns every acquired resource until the runtime is published. */
export async function acquireRuntimeContext(input: {
  options: RuntimeOptions;
  sessionDb: SessionDB;
  sessionId: string;
  rollback: ResourceCleanup;
}) {
  const { options, sessionDb, sessionId, rollback } = input;
  const profileId = options.profileId ?? "default";
  const workspaceRoot = (await resolveWorkspaceDirectory(options.workspaceRoot ?? process.cwd())).canonicalPath;
  await ensureRuntimeSession({ sessionDb, sessionId, profileId, workspaceRoot, homeDir: options.homeDir,
    durable: sessionDb instanceof SQLiteSessionDB, sourceWorkspace: options.sourceWorkspace,
    allowLegacyLocalBinding: options.allowLegacyLocalBinding, metadata: options.sessionMetadata,
    spendingLimit: options.budgets?.session });
  const hostEnvironment = await HostEnvironment.create({ profileId, workspaceRoot, policy: options.requestedExecutionPolicy });
  rollback.defer(() => hostEnvironment.destroy());
  const executionLease = hostEnvironment.acquire({ profileId, sessionId,
    surface: String(options.sessionMetadata?.originSurface ?? "local") });
  rollback.defer(() => executionLease.release());
  return { profileId, workspaceRoot, hostEnvironment, executionLease, executionFacts: hostEnvironment.facts };
}
