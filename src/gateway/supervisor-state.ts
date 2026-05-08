import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readGatewayPid, removeGatewayPid, isStalePid } from "./pid-file.js";
import { releaseGatewayLock, isStaleLock } from "./gateway-lock.js";

export type SupervisorState = {
  lifecycle: "stopped" | "starting" | "running" | "draining" | "crashed";
  startedAt: string;
  pid: number;
  version: string;
};

function gatewayDir(homeDir: string): string {
  return join(homeDir, ".estacoda", "gateway");
}

function statePath(homeDir: string): string {
  return join(gatewayDir(homeDir), "gateway-state.json");
}

export async function readGatewayState(homeDir: string): Promise<SupervisorState | undefined> {
  try {
    const raw = await readFile(statePath(homeDir), "utf8");
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
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export async function writeGatewayState(homeDir: string, state: SupervisorState): Promise<void> {
  await mkdir(gatewayDir(homeDir), { recursive: true });
  const path = statePath(homeDir);
  await writeFile(path, JSON.stringify(state, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

export async function removeGatewayState(homeDir: string): Promise<void> {
  await rm(statePath(homeDir), { force: true });
}

export async function cleanupStaleGatewayState(homeDir: string): Promise<{ cleaned: boolean; reason?: string }> {
  const stalePid = await isStalePid(homeDir);
  const staleLock = await isStaleLock(homeDir);

  if (!stalePid && !staleLock) {
    return { cleaned: false };
  }

  const reasons: string[] = [];
  if (stalePid) reasons.push("stale PID");
  if (staleLock) reasons.push("stale lock");

  await removeGatewayPid(homeDir);
  await removeGatewayState(homeDir);
  if (staleLock) {
    await releaseGatewayLock(homeDir);
  }

  return { cleaned: true, reason: reasons.join(", ") };
}
