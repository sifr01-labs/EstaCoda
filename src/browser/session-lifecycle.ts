import { rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export type SessionLifecycleOptions = {
  inactivityTimeoutMs?: number;
  tmpDir?: string;
  onCleanup: (sessionId: string) => void | Promise<void>;
};

export interface BrowserSessionLease {
  acquire(sessionId: string, owner: string): void;
  renew(sessionId: string, owner: string): void;
  release(sessionId: string, owner: string): void;
}

type SessionRecord = {
  metadata: unknown;
  lastActiveAt: number;
};

type EmergencyRegistration = {
  unregister: () => void;
};

export const DEFAULT_BROWSER_INACTIVITY_TIMEOUT_MS = 300_000;
const CLEANUP_INTERVAL_MS = 60_000;
const EMERGENCY_CLEANUP_TIMEOUT_MS = 5_000;
const emergencyRegistrations = new WeakMap<BrowserSessionLifecycle, EmergencyRegistration>();

export class BrowserSessionLifecycle implements BrowserSessionLease {
  readonly #inactivityTimeoutMs: number;
  readonly #tmpDir: string;
  readonly #onCleanup: (sessionId: string) => void | Promise<void>;
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #leaseOwners = new Map<string, Set<string>>();
  #interval: ReturnType<typeof setInterval> | undefined;
  #cleanupRunning = false;

  constructor(options: SessionLifecycleOptions) {
    this.#inactivityTimeoutMs = options.inactivityTimeoutMs ?? DEFAULT_BROWSER_INACTIVITY_TIMEOUT_MS;
    this.#tmpDir = options.tmpDir ?? tmpdir();
    this.#onCleanup = options.onCleanup;
  }

  register(sessionId: string, metadata: unknown): void {
    this.#sessions.set(sessionId, {
      metadata,
      lastActiveAt: Date.now()
    });
  }

  touch(sessionId: string): void {
    const record = this.#sessions.get(sessionId);
    if (record === undefined) {
      return;
    }
    this.#sessions.set(sessionId, {
      ...record,
      lastActiveAt: Date.now()
    });
  }

  unregister(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }

  acquire(sessionId: string, owner: string): void {
    const normalizedSessionId = requireLeaseValue(sessionId, "session ID");
    const normalizedOwner = requireLeaseValue(owner, "owner");
    const owners = this.#leaseOwners.get(normalizedSessionId) ?? new Set<string>();
    owners.add(normalizedOwner);
    this.#leaseOwners.set(normalizedSessionId, owners);
    this.touch(normalizedSessionId);
  }

  renew(sessionId: string, owner: string): void {
    const normalizedSessionId = requireLeaseValue(sessionId, "session ID");
    const normalizedOwner = requireLeaseValue(owner, "owner");
    if (!this.#leaseOwners.get(normalizedSessionId)?.has(normalizedOwner)) {
      return;
    }
    this.touch(normalizedSessionId);
  }

  release(sessionId: string, owner: string): void {
    const normalizedSessionId = requireLeaseValue(sessionId, "session ID");
    const normalizedOwner = requireLeaseValue(owner, "owner");
    const owners = this.#leaseOwners.get(normalizedSessionId);
    if (owners === undefined || !owners.delete(normalizedOwner)) {
      return;
    }
    if (owners.size === 0) {
      this.#leaseOwners.delete(normalizedSessionId);
    }
    this.touch(normalizedSessionId);
  }

  start(): void {
    if (this.#interval !== undefined) {
      return;
    }
    this.#interval = setInterval(() => {
      void this.#cleanupInactiveSessions();
    }, CLEANUP_INTERVAL_MS);
  }

  stop(): void {
    if (this.#interval === undefined) {
      return;
    }
    clearInterval(this.#interval);
    this.#interval = undefined;
  }

  async cleanupAll(): Promise<void> {
    const sessionIds = [...this.#sessions.keys()];
    this.#sessions.clear();
    this.#leaseOwners.clear();
    for (const sessionId of sessionIds) {
      await this.#cleanupSession(sessionId);
    }
  }

  async reapOrphans(): Promise<void> {
    const entries = await readdir(this.#tmpDir, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries.map(async (entry) => {
      if (!entry.isDirectory() || !entry.name.startsWith("estacoda-browser-")) {
        return;
      }
      const socketDir = join(this.#tmpDir, entry.name);
      const sessionId = entry.name.slice("estacoda-browser-".length) || basename(socketDir);
      const ownerStatus = await readOwnerStatus(socketDir, sessionId);
      if (ownerStatus === "dead") {
        await rm(socketDir, { recursive: true, force: true });
      }
    }));
  }

  async #cleanupInactiveSessions(): Promise<void> {
    if (this.#cleanupRunning) {
      return;
    }
    this.#cleanupRunning = true;
    try {
      const now = Date.now();
      const expired = [...this.#sessions.entries()]
        .filter(([sessionId, record]) =>
          !this.#hasLease(sessionId) && now - record.lastActiveAt >= this.#inactivityTimeoutMs)
        .map(([sessionId]) => sessionId);
      for (const sessionId of expired) {
        this.#sessions.delete(sessionId);
        await this.#cleanupSession(sessionId);
      }
    } finally {
      this.#cleanupRunning = false;
    }
  }

  async #cleanupSession(sessionId: string): Promise<void> {
    try {
      await this.#onCleanup(sessionId);
    } catch {
      // Best-effort cleanup: one failed session must not block other cleanup.
    }
  }

  #hasLease(sessionId: string): boolean {
    return (this.#leaseOwners.get(sessionId)?.size ?? 0) > 0;
  }
}

function requireLeaseValue(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`Browser session lease ${label} must be a non-empty string.`);
  }
  return normalized;
}

export function registerEmergencyCleanup(lifecycle: BrowserSessionLifecycle): () => void {
  const existing = emergencyRegistrations.get(lifecycle);
  if (existing !== undefined) {
    return existing.unregister;
  }

  let signalCleanup: Promise<void> | undefined;
  const cleanupOnExit = (): void => {
    // Node's exit event cannot await async cleanup; the reliable path is runtime.dispose()
    // or the bounded signal handlers below.
    lifecycle.stop();
  };
  const cleanupOnSignal = (): void => {
    signalCleanup ??= cleanupAllWithTimeout(lifecycle).finally(() => {
      signalCleanup = undefined;
    });
  };
  process.on("exit", cleanupOnExit);
  process.on("SIGINT", cleanupOnSignal);
  process.on("SIGTERM", cleanupOnSignal);

  const unregister = (): void => {
    process.off("exit", cleanupOnExit);
    process.off("SIGINT", cleanupOnSignal);
    process.off("SIGTERM", cleanupOnSignal);
    emergencyRegistrations.delete(lifecycle);
  };
  emergencyRegistrations.set(lifecycle, { unregister });
  return unregister;
}

async function cleanupAllWithTimeout(lifecycle: BrowserSessionLifecycle): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      lifecycle.cleanupAll(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, EMERGENCY_CLEANUP_TIMEOUT_MS);
        timeout.unref?.();
      })
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

async function readOwnerStatus(socketDir: string, sessionId: string): Promise<"live" | "dead" | "unknown"> {
  const ownerPath = join(socketDir, `${sessionId}.owner_pid`);
  const content = await readFile(ownerPath, "utf8").catch(() => undefined);
  if (content === undefined) {
    return "unknown";
  }
  const pid = Number(content.trim());
  if (!Number.isInteger(pid) || pid <= 0) {
    return "unknown";
  }
  try {
    process.kill(pid, 0);
    return "live";
  } catch {
    return "dead";
  }
}
