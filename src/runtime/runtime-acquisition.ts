import { DockerContainer } from "../execution/docker-container.js";
import { DockerWorkspaceFiles } from "../execution/docker-workspace-files.js";
import { DockerProcessScope } from "../execution/docker-processes.js";
import { selectedExecutionPolicy } from "../execution/docker-policy.js";
import { RuntimeSessionOwner } from "./session-execution-owner.js";
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
  options: Pick<RuntimeOptions, "profileId" | "workspaceRoot" | "homeDir" | "sourceWorkspace" | "allowLegacyLocalBinding" | "sessionMetadata" | "budgets" | "requestedExecutionPolicy">;
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
  const executionOwner = await RuntimeSessionOwner.acquire(sessionDb, sessionId, profileId, { workspaceRoot, homeDir: options.homeDir });
  rollback.afterRelease(() => executionOwner.release());
  const policy = await selectedExecutionPolicy({ profileId, homeDir: options.homeDir }, options.requestedExecutionPolicy);
  const container = policy.backend === "docker" ? await DockerContainer.prepare({ profileId, workspaceRoot, homeDir: options.homeDir, policy }) : undefined;
  if (container) rollback.defer(() => container.release());
  const hostEnvironment = container ? HostEnvironment.prepared(profileId, container.facts, {
    files: (active) => new DockerWorkspaceFiles(container, active), processes: () => new DockerProcessScope(container, options.homeDir), dispose: () => container.release()
  }) : await HostEnvironment.create({ profileId, workspaceRoot, policy });
  rollback.defer(() => hostEnvironment.destroy());
  const executionLease = hostEnvironment.acquire({ profileId, sessionId,
    surface: String(options.sessionMetadata?.originSurface ?? "local") });
  rollback.defer(() => executionLease.release());
  return { executionOwner, profileId, workspaceRoot, hostEnvironment, executionLease, executionFacts: hostEnvironment.facts };
}
