import { SessionCompressionLock } from "../session/session-compression-lock.js";
import type { LoadedRuntimeConfig } from "../config/runtime-config.js";
import type { Runtime } from "./create-runtime.js";
import { classifyRuntimeChange, type RuntimeFingerprint } from "./runtime-fingerprint.js";
import type { SecurityPolicy } from "../contracts/security.js";
import { HookRegistry } from "../gateway/hook-registry.js";
import { createHash } from "node:crypto";

export type RuntimeCacheOptions = {
  /** Max cached runtimes. Default 50. */
  maxEntries?: number;
  /** Dispose runtime after idle ms. Default 30 min (1_800_000). */
  idleTtlMs?: number;
  /** Factory to create a new runtime when cache misses. */
  createRuntime: (input: {
    sessionId: string;
    securityPolicy: SecurityPolicy;
    metadata?: Record<string, unknown>;
    configuration?: LoadedRuntimeConfig;
  }) => Promise<Runtime>;
  prepare?: (sessionId: string, metadata?: Record<string, unknown>) => Promise<{ fingerprint: RuntimeFingerprint; configuration: LoadedRuntimeConfig }>;
  /** Optional logger. */
  logWarning?: (message: string) => void;
  /** Optional hook registry for lifecycle events. */
  hookRegistry?: HookRegistry;
};

export type CachedRuntimeEntry = {
  entryId: string;
  sessionId: string;
  fingerprint: RuntimeFingerprint;
  runtime: Runtime;
  createdAt: number;
  lastUsedAt: number;
  borrowCount: number;
  suspended: boolean;
  suspendedReason?: string;
  suspendedAt?: number;
  disposePending: boolean;
};

export type RuntimeCacheStats = {
  totalEntries: number;
  activeBorrows: number;
  suspendedEntries: number;
  totalCreated: number;
  totalReused: number;
  totalDisposed: number;
  totalInvalidated: number;
};

export type SuspendedSummaryEntry = {
  sessionId: string;
  reason: string;
  suspendedAt: string; // ISO 8601
};

type LeaseRef = { sessionId: string; entryId: string };

const DISPOSE_TIMEOUT_MS = 10_000;

function sessionKeyHash(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
}

export async function safeDispose(
  runtime: Runtime,
  logWarning?: (msg: string) => void
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      runtime.dispose(),
      new Promise<void>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Runtime dispose timed out after 10s")),
          DISPOSE_TIMEOUT_MS
        );
      }),
    ]);
    return true;
  } catch (err) {
    logWarning?.(
      `Runtime dispose failed or timed out: ${err instanceof Error ? err.message : String(err)}`
    );
    return false;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export function createCachedRuntimeProxy(
  runtime: Runtime,
  cache: RuntimeCache,
  lease: LeaseRef
): Runtime {
  let released = false;
  return new Proxy(runtime, {
    get(target, prop, receiver) {
      if (prop === "dispose") {
        return async () => {
          if (released) return;
          released = true;
          await cache.releaseLease(lease.sessionId, lease.entryId);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (released) throw new Error("Cached runtime lease has been released.");
        return value.apply(target, args);
      };
    },
  }) as Runtime;
}

export class RuntimeCache {
  readonly #acquisition = new SessionCompressionLock();
  readonly #epochs = new Map<string, number>();
  readonly #acquiring = new Set<Promise<Runtime>>();
  #closed = false;
  #configurationEpoch = 0;
  #prepare?: RuntimeCacheOptions["prepare"];
  #maxEntries: number;
  #idleTtlMs: number;
  #createRuntime: RuntimeCacheOptions["createRuntime"];
  #logWarning?: (message: string) => void;
  #hookRegistry?: HookRegistry;
  #pendingEvictReason = new Map<string, string>();

  #activeEntries: Map<string, CachedRuntimeEntry> = new Map();
  #pendingEntries: Map<string, CachedRuntimeEntry> = new Map();
  #recentSuspensions: SuspendedSummaryEntry[] = [];
  #nextEntryId = 0;

  #totalCreated = 0;
  #totalReused = 0;
  #totalDisposed = 0;
  #totalInvalidated = 0;

  constructor(options: RuntimeCacheOptions) {
    this.#prepare = options.prepare;
    this.#maxEntries = options.maxEntries ?? 50;
    this.#idleTtlMs = options.idleTtlMs ?? 1_800_000;
    this.#createRuntime = options.createRuntime;
    this.#logWarning = options.logWarning;
    this.#hookRegistry = options.hookRegistry;
  }

  async browserControl(sessionId:string,command:import('../contracts/desktop-control/browser-human.js').HumanBrowserCommand){
    const entry=this.#activeEntries.get(sessionId);
    if(this.#closed||!entry||entry.suspended||entry.disposePending||entry.runtime.sessionId!==sessionId||!entry.runtime.browserControl)throw new Error('Existing browser runtime unavailable.');
    entry.borrowCount++;entry.lastUsedAt=Date.now();
    try{await entry.runtime.validateExecutionHealth?.();return await entry.runtime.browserControl(command);}
    finally{await this.releaseLease(sessionId,entry.entryId);}
  }

  inspectMcpServers(sessionId: string) {
    const entry = this.#activeEntries.get(sessionId);
    if (this.#closed || !entry || entry.suspended || entry.disposePending) return undefined;
    return entry.runtime.inspectMcpServers();
  }

  async currentExecutionFacts(sessionId: string) {
    const entry = this.#activeEntries.get(sessionId);
    if (!entry || entry.suspended || entry.disposePending) return undefined;
    await entry.runtime.validateExecutionHealth?.();
    return entry.runtime.executionFacts?.();
  }

  async get(
    sessionId: string,
    fingerprint: RuntimeFingerprint,
    securityPolicy: SecurityPolicy,
    metadata?: Record<string, unknown>
  ): Promise<Runtime> {
    const operation = this.#acquisition.runExclusive(sessionId, async () => {
      if (this.#closed) throw new Error("Runtime cache is closed.");
      const epoch = this.#epochs.get(sessionId) ?? 0;
      const configurationEpoch = this.#configurationEpoch;
      const prepared = await this.#prepare?.(sessionId, metadata);
      if (prepared) fingerprint = prepared.fingerprint;
      const ensureCurrent = () => {
        if (this.#closed || configurationEpoch !== this.#configurationEpoch || epoch !== (this.#epochs.get(sessionId) ?? 0)) throw new Error("Runtime acquisition was invalidated.");
      };
      ensureCurrent();
      // Retired runtimes may still own execution. Never construct a competing one.
      if ([...this.#pendingEntries.values()].some((entry) => entry.sessionId === sessionId)) {
        throw new Error("Session runtime is busy settling its previous owner.");
      }
      const existing = this.#activeEntries.get(sessionId);
      let reason: "first-create" | "fingerprint-mismatch" | "suspended" = "first-create";
      if (existing) {
        let healthy = true;
        try { await existing.runtime.validateExecutionHealth?.(); } catch { healthy = false; }
        ensureCurrent();
        if (healthy && !existing.suspended && !existing.disposePending && this.#fingerprintsEqual(existing.fingerprint, fingerprint)) {
          existing.lastUsedAt = Date.now(); existing.borrowCount++;
          this.#activeEntries.delete(sessionId); this.#activeEntries.set(sessionId, existing);
          this.#totalReused++;
          void this.#hookRegistry?.emit("session:cache:hit", { sessionId, entryId: existing.entryId, borrowCount: existing.borrowCount });
          return createCachedRuntimeProxy(existing.runtime, this, { sessionId, entryId: existing.entryId });
        }
        if (existing.borrowCount > 0) throw new Error("Session runtime is busy; apply changed configuration at a settled boundary.");
        reason = healthy ? "fingerprint-mismatch" : "suspended";
        // A failed/uncertain dispose retains this entry and the persisted claim.
        if (!await safeDispose(existing.runtime, this.#logWarning)) throw new Error("Previous runtime cleanup is uncertain.");
        ensureCurrent();
        this.#pendingEvictReason.set(existing.entryId, "fingerprint-mismatch");
        this.#activeEntries.delete(sessionId); this.#totalDisposed++; this.#emitEvict(existing);
      }
      const runtime = await this.#createRuntime({ sessionId, securityPolicy, metadata, configuration: prepared?.configuration });
      try { ensureCurrent(); await runtime.validateExecutionHealth?.(); ensureCurrent(); }
      catch (error) { await runtime.dispose(); throw error; }
      const entryId = `${sessionId}#${++this.#nextEntryId}`;
      const entry: CachedRuntimeEntry = { entryId, sessionId, fingerprint: this.#cloneFingerprint(fingerprint), runtime,
        createdAt: Date.now(), lastUsedAt: Date.now(), borrowCount: 1, suspended: false, disposePending: false };
      this.#activeEntries.set(sessionId, entry); this.#totalCreated++;
      void this.#hookRegistry?.emit("session:cache:miss", { sessionId, entryId, reason });
      return createCachedRuntimeProxy(runtime, this, { sessionId, entryId });
    });
    this.#acquiring.add(operation);
    try { return await operation; } finally { this.#acquiring.delete(operation); }
  }

  async releaseLease(sessionId: string, entryId: string): Promise<void> {
    // Try active entry first
    const active = this.#activeEntries.get(sessionId);
    if (active !== undefined && active.entryId === entryId) {
      if (active.borrowCount <= 0) {
        this.#logWarning?.(
          `RuntimeCache double-release for session ${sessionId} entry ${entryId}; borrowCount already ${active.borrowCount}`
        );
        return;
      }
      active.borrowCount--;
      if (active.disposePending && active.borrowCount === 0) {
        if (!await safeDispose(active.runtime, this.#logWarning)) return;
        this.#totalDisposed++;
        this.#emitEvict(active);
        this.#activeEntries.delete(sessionId);
      }
      return;
    }

    // Try pending (retired) entry
    const pending = this.#pendingEntries.get(entryId);
    if (pending !== undefined) {
      if (pending.sessionId !== sessionId) {
        this.#logWarning?.(
          `RuntimeCache releaseLease session mismatch: requested ${sessionId} but entry ${entryId} belongs to ${pending.sessionId}`
        );
        return;
      }
      if (pending.borrowCount <= 0) {
        this.#logWarning?.(
          `RuntimeCache double-release for pending session ${sessionId} entry ${entryId}`
        );
        return;
      }
      pending.borrowCount--;
      if (pending.disposePending && pending.borrowCount === 0) {
        if (!await safeDispose(pending.runtime, this.#logWarning)) return;
        this.#totalDisposed++;
        this.#emitEvict(pending);
        this.#pendingEntries.delete(entryId);
      }
      return;
    }

    // Entry not found at all
    this.#logWarning?.(
      `RuntimeCache releaseLease called for unknown session ${sessionId} entry ${entryId}`
    );
  }

  async suspend(sessionId: string, reason: string): Promise<void> {
    this.#epochs.set(sessionId, (this.#epochs.get(sessionId) ?? 0) + 1);
    const entry = this.#activeEntries.get(sessionId);
    if (entry === undefined) return;

    entry.suspended = true;
    entry.suspendedReason = reason;
    entry.suspendedAt = Date.now();
    entry.disposePending = true;

    this.#recordSuspension(sessionId, reason, entry.suspendedAt);

    this.#activeEntries.delete(sessionId);
    this.#pendingEntries.set(entry.entryId, entry);
    if (!this.#pendingEvictReason.has(entry.entryId)) {
      this.#pendingEvictReason.set(entry.entryId, "suspend");
    }

    if (entry.borrowCount === 0) {
      if (!await safeDispose(entry.runtime, this.#logWarning)) return;
      this.#totalDisposed++;
      this.#emitEvict(entry);
      this.#pendingEntries.delete(entry.entryId);
    }
  }

  /** Retire cached routes without disposing borrowed runtimes or creating a competing owner. */
  async configurationChanged(): Promise<void> {
    this.#configurationEpoch++;
    await Promise.all([...this.#activeEntries.keys()].map(sessionId => this.invalidate(sessionId)));
  }

  async invalidate(sessionId: string): Promise<void> {
    const entry = this.#activeEntries.get(sessionId);
    if (entry !== undefined) {
      this.#pendingEvictReason.set(entry.entryId, "invalidate");
    }
    await this.suspend(sessionId, "invalidated");
    this.#totalInvalidated++;
  }

  async prune(options?: { isEvictionBlocked?: (sessionId: string) => boolean }): Promise<void> {
    // Phase 1: TTL disposal
    const now = Date.now();
    for (const [key, entry] of this.#activeEntries) {
      if (entry.borrowCount > 0) continue;
      if (entry.disposePending) continue;
      if (now - entry.lastUsedAt > this.#idleTtlMs) {
        entry.disposePending = true;
        this.#activeEntries.delete(key);
        this.#pendingEntries.set(entry.entryId, entry);
        this.#pendingEvictReason.set(entry.entryId, "ttl");
        if (!await safeDispose(entry.runtime, this.#logWarning)) return;
        this.#totalDisposed++;
        this.#emitEvict(entry);
        this.#pendingEntries.delete(entry.entryId);
      }
    }

    // Phase 2: LRU cap disposal
    if (this.#activeEntries.size > this.#maxEntries) {
      const evictPlan: string[] = [];
      for (const [key, entry] of this.#activeEntries) {
        if (entry.borrowCount > 0) continue;
        if (options?.isEvictionBlocked?.(key)) continue;
        evictPlan.push(key);
        if (this.#activeEntries.size - evictPlan.length <= this.#maxEntries) break;
      }

      for (const key of evictPlan) {
        const entry = this.#activeEntries.get(key)!;
        entry.disposePending = true;
        this.#activeEntries.delete(key);
        this.#pendingEntries.set(entry.entryId, entry);
        this.#pendingEvictReason.set(entry.entryId, "lru");
        if (!await safeDispose(entry.runtime, this.#logWarning)) return;
        this.#totalDisposed++;
        this.#emitEvict(entry);
        this.#pendingEntries.delete(entry.entryId);
      }

      if (this.#activeEntries.size > this.#maxEntries) {
        this.#logWarning?.(
          `Runtime cache over cap (${this.#activeEntries.size} > ${this.#maxEntries}); ` +
            `excess slots held by active borrows — will re-check on next prune.`
        );
      }
    }
  }

  async disposeAll(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled([...this.#acquiring]);
    const promises: Promise<void>[] = [];
    const pendingToDispose: CachedRuntimeEntry[] = [];

    // Identify pre-existing pending entries that are idle
    for (const [, entry] of this.#pendingEntries) {
      if (entry.borrowCount === 0) {
        pendingToDispose.push(entry);
      }
    }

    // Active entries
    for (const [sessionId, entry] of this.#activeEntries) {
      entry.disposePending = true;
      this.#activeEntries.delete(sessionId);
      this.#pendingEntries.set(entry.entryId, entry);
      this.#pendingEvictReason.set(entry.entryId, "disposeAll");
      if (entry.borrowCount === 0) {
        promises.push(
          safeDispose(entry.runtime, this.#logWarning)
            .then((disposed) => {
              if (!disposed) return;
              this.#totalDisposed++;
              this.#emitEvict(entry);
              this.#pendingEntries.delete(entry.entryId);
            })
            .catch(() => {
              this.#pendingEntries.delete(entry.entryId);
            })
        );
      }
    }

    // Pending entries that were already idle before we started
    for (const entry of pendingToDispose) {
      if (!this.#pendingEvictReason.has(entry.entryId)) {
        this.#pendingEvictReason.set(entry.entryId, "disposeAll");
      }
      promises.push(
        safeDispose(entry.runtime, this.#logWarning)
          .then((disposed) => {
            if (!disposed) return;
            this.#totalDisposed++;
            this.#emitEvict(entry);
            this.#pendingEntries.delete(entry.entryId);
          })
          .catch(() => {
            this.#pendingEntries.delete(entry.entryId);
          })
      );
    }

    await Promise.all(promises);
  }

  stats(): RuntimeCacheStats {
    let activeBorrows = 0;
    let suspendedEntries = 0;
    for (const entry of this.#activeEntries.values()) {
      activeBorrows += entry.borrowCount;
      if (entry.suspended) suspendedEntries++;
    }
    // Pending entries that are still borrowed must also count
    for (const entry of this.#pendingEntries.values()) {
      activeBorrows += entry.borrowCount;
      if (entry.suspended) suspendedEntries++;
    }
    return {
      // totalEntries counts both active and pending because pending entries
      // still hold Runtime references that consume memory.
      totalEntries: this.#activeEntries.size + this.#pendingEntries.size,
      activeBorrows,
      suspendedEntries,
      totalCreated: this.#totalCreated,
      totalReused: this.#totalReused,
      totalDisposed: this.#totalDisposed,
      totalInvalidated: this.#totalInvalidated,
    };
  }

  suspendedSummary(): SuspendedSummaryEntry[] {
    const live: SuspendedSummaryEntry[] = [];
    const seenSessionIds = new Set<string>();

    for (const entry of this.#activeEntries.values()) {
      if (entry.suspended && entry.suspendedAt !== undefined && entry.suspendedReason !== undefined) {
        live.push({
          sessionId: entry.sessionId,
          reason: entry.suspendedReason,
          suspendedAt: new Date(entry.suspendedAt).toISOString(),
        });
        seenSessionIds.add(entry.sessionId);
      }
    }

    for (const entry of this.#pendingEntries.values()) {
      if (entry.suspended && entry.suspendedAt !== undefined && entry.suspendedReason !== undefined) {
        if (!seenSessionIds.has(entry.sessionId)) {
          live.push({
            sessionId: entry.sessionId,
            reason: entry.suspendedReason,
            suspendedAt: new Date(entry.suspendedAt).toISOString(),
          });
          seenSessionIds.add(entry.sessionId);
        }
      }
    }

    for (const recent of this.#recentSuspensions) {
      if (!seenSessionIds.has(recent.sessionId)) {
        live.push(recent);
        seenSessionIds.add(recent.sessionId);
      }
    }

    return live;
  }

  #fingerprintsEqual(a: RuntimeFingerprint, b: RuntimeFingerprint): boolean {
    const change = classifyRuntimeChange(a, b);
    return change === "none" || change === "metadata";
  }

  #cloneFingerprint(fingerprint: RuntimeFingerprint): RuntimeFingerprint {
    try {
      return structuredClone(fingerprint);
    } catch {
      // Fallback: JSON.parse(JSON.stringify) drops `undefined` values.
      // This is consistent with #fingerprintsEqual which uses JSON.stringify,
      // so cloned fingerprints remain equal to their originals.
      return JSON.parse(JSON.stringify(fingerprint)) as RuntimeFingerprint;
    }
  }

  #recordSuspension(sessionId: string, reason: string, atMs: number): void {
    this.#recentSuspensions.push({
      sessionId,
      reason,
      suspendedAt: new Date(atMs).toISOString(),
    });
    if (this.#recentSuspensions.length > 20) {
      this.#recentSuspensions.shift();
    }
  }

  #emitEvict(entry: CachedRuntimeEntry): void {
    const reason = this.#pendingEvictReason.get(entry.entryId) ?? "suspend";
    this.#pendingEvictReason.delete(entry.entryId);
    void this.#hookRegistry?.emit("session:cache:evict", {
      sessionId: entry.sessionId,
      entryId: entry.entryId,
      reason: reason as "ttl" | "lru" | "suspend" | "invalidate" | "disposeAll" | "fingerprint-mismatch",
    });
  }
}
