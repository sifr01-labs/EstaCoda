import { chmod, mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export type RuntimeCacheState = {
  version: 1;
  writtenAt: string;
  supervisorPid: number;
  supervisorStartedAt: string;
  cacheStats: {
    totalEntries: number;
    activeBorrows: number;
    suspendedEntries: number;
    totalCreated: number;
    totalReused: number;
    totalDisposed: number;
    totalInvalidated: number;
  };
  suspendedSummary: Array<{
    sessionId: string;
    reason: string;
    suspendedAt: string;
  }>;
  registryStats: {
    activeTurnCount: number;
    totalStarted: number;
    totalEnded: number;
    totalAborted: number;
    stuckTurnCount: number;
    repeatStuckCount: number;
  };
  stuckTurnHistory: Array<{
    turnId: string;
    keyHash: string;
    startedAt: string;
    endedAt: string;
    durationMs: number;
    wasAborted: boolean;
  }>;
  fingerprintHash: string;
};

type GatewayStateHome = string | { gatewayStatePath: string };

export function runtimeCacheStatePath(stateHome: GatewayStateHome): string {
  const gatewayStatePath = typeof stateHome === "string" ? join(stateHome, ".estacoda", "gateway") : stateHome.gatewayStatePath;
  return join(gatewayStatePath, "runtime-cache-state.json");
}

export async function writeRuntimeCacheState(
  path: string,
  state: RuntimeCacheState
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

export async function readRuntimeCacheState(
  path: string
): Promise<RuntimeCacheState | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as Record<string, unknown>).version === 1 &&
      typeof (parsed as Record<string, unknown>).writtenAt === "string" &&
      typeof (parsed as Record<string, unknown>).supervisorPid === "number"
    ) {
      return parsed as RuntimeCacheState;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

const RUNTIME_CACHE_STATE_STALE_MS = 120_000;

export function isRuntimeCacheStateFresh(
  state: RuntimeCacheState,
  nowMs = Date.now()
): boolean {
  const writtenAt = Date.parse(state.writtenAt);
  if (Number.isNaN(writtenAt)) return false;
  return nowMs - writtenAt < RUNTIME_CACHE_STATE_STALE_MS;
}

export function isRuntimeCacheStatePidMatch(
  state: RuntimeCacheState,
  expectedPid: number
): boolean {
  return state.supervisorPid === expectedPid;
}
