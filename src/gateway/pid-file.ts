import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type GatewayPidContent = {
  pid: number;
  startedAt: string;
  version: string;
  profileId?: string;
};

type GatewayStateHome = string | { gatewayStatePath: string };

function gatewayDir(stateHome: GatewayStateHome): string {
  return typeof stateHome === "string" ? join(stateHome, ".estacoda", "gateway") : stateHome.gatewayStatePath;
}

function pidPath(stateHome: GatewayStateHome): string {
  return join(gatewayDir(stateHome), "gateway.pid");
}

export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    if (err.code === "EPERM") return true;
    return false;
  }
}

export async function readGatewayPid(stateHome: GatewayStateHome): Promise<GatewayPidContent | undefined> {
  try {
    const raw = await readFile(pidPath(stateHome), "utf8");
    const parsed = JSON.parse(raw) as Partial<GatewayPidContent>;
    if (
      typeof parsed.pid === "number" &&
      typeof parsed.startedAt === "string" &&
      typeof parsed.version === "string"
    ) {
      return { pid: parsed.pid, startedAt: parsed.startedAt, version: parsed.version, profileId: parsed.profileId };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export async function writeGatewayPid(stateHome: GatewayStateHome, content: GatewayPidContent): Promise<void> {
  await mkdir(gatewayDir(stateHome), { recursive: true });
  const path = pidPath(stateHome);
  await writeFile(path, JSON.stringify(content, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

export async function removeGatewayPid(stateHome: GatewayStateHome): Promise<void> {
  await rm(pidPath(stateHome), { force: true });
}

export async function isStalePid(stateHome: GatewayStateHome): Promise<boolean> {
  const pidContent = await readGatewayPid(stateHome);
  if (pidContent === undefined) return false;
  return !isPidAlive(pidContent.pid);
}
