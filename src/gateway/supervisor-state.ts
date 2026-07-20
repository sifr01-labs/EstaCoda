import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readGatewayPid, removeGatewayPid, isStalePid } from "./pid-file.js";
import { releaseGatewayLock, isStaleLock } from "./gateway-lock.js";

export type SupervisorState = {
  lifecycle: "stopped" | "starting" | "running" | "draining" | "crashed";
  startedAt: string;
  pid: number;
  version: string;
  profileId?: string;
  backgroundServices?: {
    tasks: "starting" | "running";
    cron: "starting" | "running";
  };
};

type GatewayStateHome = string | { gatewayStatePath: string };

function gatewayDir(stateHome: GatewayStateHome): string {
  return typeof stateHome === "string" ? join(stateHome, ".estacoda", "gateway") : stateHome.gatewayStatePath;
}

function statePath(stateHome: GatewayStateHome): string {
  return join(gatewayDir(stateHome), "gateway-state.json");
}

export async function readGatewayState(stateHome: GatewayStateHome): Promise<SupervisorState | undefined> {
  try {
    const raw = await readFile(statePath(stateHome), "utf8");
    const parsed = JSON.parse(raw) as Partial<SupervisorState>;
    if (
      typeof parsed.lifecycle === "string" &&
      typeof parsed.startedAt === "string" &&
      typeof parsed.pid === "number" &&
      typeof parsed.version === "string"
    ) {
      return {
        lifecycle: parsed.lifecycle as SupervisorState["lifecycle"],
        startedAt: parsed.startedAt,
        pid: parsed.pid,
        version: parsed.version,
        profileId: parsed.profileId,
        backgroundServices: isBackgroundServices(parsed.backgroundServices)
          ? parsed.backgroundServices
          : undefined,
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function isBackgroundServices(value: unknown): value is NonNullable<SupervisorState["backgroundServices"]> {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { tasks?: unknown; cron?: unknown };
  return (candidate.tasks === "starting" || candidate.tasks === "running") &&
    (candidate.cron === "starting" || candidate.cron === "running");
}

export async function writeGatewayState(stateHome: GatewayStateHome, state: SupervisorState): Promise<void> {
  await mkdir(gatewayDir(stateHome), { recursive: true });
  const path = statePath(stateHome);
  await writeFile(path, JSON.stringify(state, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

export async function removeGatewayState(stateHome: GatewayStateHome): Promise<void> {
  await rm(statePath(stateHome), { force: true });
}

export async function cleanupStaleGatewayState(stateHome: GatewayStateHome): Promise<{ cleaned: boolean; reason?: string }> {
  const stalePid = await isStalePid(stateHome);
  const staleLock = await isStaleLock(stateHome);

  if (!stalePid && !staleLock) {
    return { cleaned: false };
  }

  const reasons: string[] = [];
  if (stalePid) reasons.push("stale PID");
  if (staleLock) reasons.push("stale lock");

  await removeGatewayPid(stateHome);
  await removeGatewayState(stateHome);
  if (staleLock) {
    await releaseGatewayLock(stateHome);
  }

  return { cleaned: true, reason: reasons.join(", ") };
}
