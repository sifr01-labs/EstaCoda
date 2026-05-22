import { rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export type SessionLifecycleOptions = {
  inactivityTimeoutMs?: number;
  tmpDir?: string;
  onCleanup: (sessionId: string) => void | Promise<void>;
};

type SessionRecord = {
  metadata: unknown;
  lastActiveAt: number;
};

type EmergencyRegistration = {
  unregister: () => void;
};

const DEFAULT_INACTIVITY_TIMEOUT_MS = 300_000;
const CLEANUP_INTERVAL_MS = 60_000;
const emergencyRegistrations = new WeakMap<BrowserSessionLifecycle, EmergencyRegistration>();

export class BrowserSessionLifecycle {
  readonly #inactivityTimeoutMs: number;
  readonly #tmpDir: string;
  readonly #onCleanup: (sessionId: string) => void | Promise<void>;
  readonly #sessions = new Map<string, SessionRecord>();
  #interval: ReturnType<typeof setInterval> | undefined;
  #cleanupRunning = false;

  constructor(options: SessionLifecycleOptions) {
    this.#inactivityTimeoutMs = options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS;
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
        .filter(([, record]) => now - record.lastActiveAt >= this.#inactivityTimeoutMs)
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
}

export function registerEmergencyCleanup(lifecycle: BrowserSessionLifecycle): () => void {
  const existing = emergencyRegistrations.get(lifecycle);
  if (existing !== undefined) {
    return existing.unregister;
  }

  const cleanup = (): void => {
    void lifecycle.cleanupAll();
  };
  const sigint = (): void => {
    void lifecycle.cleanupAll();
  };
  process.on("exit", cleanup);
  process.on("SIGINT", sigint);

  const unregister = (): void => {
    process.off("exit", cleanup);
    process.off("SIGINT", sigint);
    emergencyRegistrations.delete(lifecycle);
  };
  emergencyRegistrations.set(lifecycle, { unregister });
  return unregister;
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
