import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveGlobalStateHome, resolveProfileStateHome } from "../config/profile-home.js";
import { resolveOsHomeDir } from "../config/home-dir.js";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import { validateSessionWorkspaceOwnership } from "../session/session-workspace-ownership.js";
import { WorkspaceTrustStore } from "../security/workspace-trust-store.js";
import { buildSafeChildEnv } from "../security/process-env.js";
import { inspectGatewayLockState } from "./gateway-lock.js";
import { resolveGatewayExec } from "./service-exec-resolver.js";
import { probeServiceState, startService } from "./service-manager.js";

/** Reuse installed service ownership where present. Otherwise launch the same
 * supervisor command from this installation; never install/enable a service,
 * change the active profile, or execute an entry point supplied by a workspace. */
export async function startSharedHostOnDemand(input: { homeDir: string; profileId: string; sessionId: string; targetId: string }): Promise<void> {
  const paths = resolveProfileStateHome(input);
  const lock = await inspectGatewayLockState(paths);
  if (lock.state === "active") return;
  if (lock.state === "malformed" || lock.state === "inaccessible") throw new Error("Supervisor ownership is ambiguous; repair it before starting shared execution.");
  const db = new SQLiteSessionDB({ path: resolveGlobalStateHome(input).sessionsSqlitePath });
  let workspaceRoot: string;
  try {
    const session = await db.getSessionForProfile(input.sessionId, input.profileId);
    if (!session || session.executionTarget?.targetId !== input.targetId) throw new Error("Shared startup requires an established Session target.");
    workspaceRoot = session.executionTarget.workspace.canonicalPath;
    await validateSessionWorkspaceOwnership({ ...input, session, workspaceRoot });
    if (!await new WorkspaceTrustStore({ homeDir: input.homeDir }).isTrusted(workspaceRoot)) throw new Error("Shared startup requires current workspace trust.");
  } finally { db.close(); }
  const serviceOptions = { serviceUserHomeDir: resolveOsHomeDir(), profileId: input.profileId };
  const services = await Promise.all([probeServiceState(serviceOptions), probeServiceState({ ...serviceOptions, system: true })]);
  const installed = services.filter((service, index) => service.installed && (index === 0 || service.kind === "systemd-system"));
  if (installed.length > 1) throw new Error("Multiple service scopes exist; select the supervisor service explicitly.");
  if (installed.length === 1) {
    const result = await startService({ ...serviceOptions, system: installed[0].scope === "system" });
    if (!result.ok) throw new Error("Existing supervisor service could not start. Inspect its configuration and logs.");
    return;
  }
  const execution = resolveGatewayExec({ workspaceRoot: fileURLToPath(new URL("../../", import.meta.url)) });
  if (!execution.ok) throw new Error(execution.error);
  const child = spawn(execution.resolved.command, [...execution.resolved.args, "gateway", "run", "--profile", input.profileId], {
    cwd: workspaceRoot, detached: true, stdio: "ignore",
    env: buildSafeChildEnv({ homeDir: resolveOsHomeDir(), extra: { ESTACODA_HOME: input.homeDir } })
  });
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  child.unref();
}
