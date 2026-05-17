import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChannelKind } from "../contracts/channel.js";

export type AdapterRuntimeState = {
  kind: ChannelKind;
  state:
    | "starting"
    | "healthy"
    | "degraded"
    | "retry_scheduled"
    | "failed"
    | "stopped";
  pendingOperation?: "start" | "poll";
  lastError?: {
    message: string;
    timestamp: string;
    count: number;
  };
  retry?: {
    attempt: number;
    maxAttempts: number;
    nextRetryAt: string;
  };
  startedAt?: string;
  stoppedAt?: string;
  pollsTotal: number;
  pollsFailed: number;
  pollMessagesProcessed: number;
};

export type PersistedRuntimeState = {
  supervisorPid: number;
  supervisorStartedAt: string;
  updatedAt: string;
  adapters: AdapterRuntimeState[];
};

export const RUNTIME_STATE_FILE = "adapter-runtime-state.json";
export const RUNTIME_STATE_STALE_MS = 5 * 60 * 1000;
export const RUNTIME_STATE_HEARTBEAT_MS = 60 * 1000;

type GatewayStateHome = string | { gatewayStatePath: string };

function statePath(stateHome: GatewayStateHome): string {
  const gatewayStatePath = typeof stateHome === "string" ? join(stateHome, ".estacoda", "gateway") : stateHome.gatewayStatePath;
  return join(gatewayStatePath, RUNTIME_STATE_FILE);
}

export async function writeAdapterRuntimeState(
  stateHome: GatewayStateHome,
  state: PersistedRuntimeState
): Promise<void> {
  const path = statePath(stateHome);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

export async function readAdapterRuntimeState(
  stateHome: GatewayStateHome
): Promise<PersistedRuntimeState | undefined> {
  try {
    const path = statePath(stateHome);
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as PersistedRuntimeState;
    if (
      typeof parsed.supervisorPid !== "number" ||
      typeof parsed.supervisorStartedAt !== "string" ||
      typeof parsed.updatedAt !== "string" ||
      !Array.isArray(parsed.adapters)
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export function isRuntimeStateFresh(
  state: PersistedRuntimeState,
  nowMs = Date.now()
): boolean {
  const updatedAt = new Date(state.updatedAt).getTime();
  return !Number.isNaN(updatedAt) && nowMs - updatedAt < RUNTIME_STATE_STALE_MS;
}

export function isRuntimeStatePidMatch(
  state: PersistedRuntimeState,
  expectedPid: number
): boolean {
  return state.supervisorPid === expectedPid;
}
