import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type GatewayPidContent = {
  pid: number;
  startedAt: string;
  version: string;
};

function gatewayDir(homeDir: string): string {
  return join(homeDir, ".estacoda", "gateway");
}

function pidPath(homeDir: string): string {
  return join(gatewayDir(homeDir), "gateway.pid");
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

export async function readGatewayPid(homeDir: string): Promise<GatewayPidContent | undefined> {
  try {
    const raw = await readFile(pidPath(homeDir), "utf8");
    const parsed = JSON.parse(raw) as Partial<GatewayPidContent>;
    if (
      typeof parsed.pid === "number" &&
      typeof parsed.startedAt === "string" &&
      typeof parsed.version === "string"
    ) {
      return { pid: parsed.pid, startedAt: parsed.startedAt, version: parsed.version };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export async function writeGatewayPid(homeDir: string, content: GatewayPidContent): Promise<void> {
  await mkdir(gatewayDir(homeDir), { recursive: true });
  const path = pidPath(homeDir);
  await writeFile(path, JSON.stringify(content, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

export async function removeGatewayPid(homeDir: string): Promise<void> {
  await rm(pidPath(homeDir), { force: true });
}

export async function isStalePid(homeDir: string): Promise<boolean> {
  const pidContent = await readGatewayPid(homeDir);
  if (pidContent === undefined) return false;
  return !isPidAlive(pidContent.pid);
}
