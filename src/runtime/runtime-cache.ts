import type { Runtime } from "./create-runtime.js";
import type { RuntimeFingerprint } from "./runtime-fingerprint.js";
import type { SecurityPolicy } from "../contracts/security.js";

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
  }) => Promise<Runtime>;
  /** Optional logger. */
  logWarning?: (message: string) => void;
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

export async function safeDispose(
  runtime: Runtime,
  logWarning?: (msg: string) => void
): Promise<void> {
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
  } catch (err) {
    logWarning?.(
      `Runtime dispose failed or timed out: ${err instanceof Error ? err.message : String(err)}`
    );
    // NOTE: The timeout does NOT cancel the underlying runtime.dispose() promise.
    // The runtime may continue disposing in the background. This is acceptable
    // for Stage 5B because the entry is already removed from the cache and
    // the runtime will be garbage-collected once its background dispose finishes.
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
  return new Proxy(runtime, {
    get(target, prop, receiver) {
      if (prop === "dispose") {
        return async () => {
          await cache.releaseLease(lease.sessionId, lease.entryId);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as Runtime;
}

export class RuntimeCache {
  #maxEntries: number;
  #idleTtlMs: number;
  #createRuntime: RuntimeCacheOptions["createRuntime"];
  #logWarning?: (message: string) => void;

  #activeEntries: Map<string, CachedRuntimeEntry> = new Map();
  #pendingEntries: Map<string, CachedRuntimeEntry> = new Map();
  #recentSuspensions: SuspendedSummaryEntry[] = [];
  #nextEntryId = 0;

  #totalCreated = 0;
  #totalReused = 0;
  #totalDisposed = 0;
  #totalInvalidated = 0;

  constructor(options: RuntimeCacheOptions) {
    this.#maxEntries = options.maxEntries ?? 50;
    this.#idleTtlMs = options.idleTtlMs ?? 1_800_000;
    this.#createRuntime = options.createRuntime;
    this.#logWarning = options.logWarning;
  }

  async get(
    sessionId: string,
    fingerprint: RuntimeFingerprint,
    securityPolicy: SecurityPolicy,
    metadata?: Record<string, unknown>
  ): Promise<Runtime> {
    const existing = this.#activeEntries.get(sessionId);
    const entryId = `${sessionId}#${++this.#nextEntryId}`;

    // Case 1: No entry -> create
    if (existing === undefined) {
      const runtime = await this.#createRuntime({ sessionId, securityPolicy, metadata });
      const entry: CachedRuntimeEntry = {
        entryId,
        sessionId,
        fingerprint: this.#cloneFingerprint(fingerprint),
        runtime,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        borrowCount: 1,
        suspended: false,
        disposePending: false,
      };
      this.#activeEntries.set(sessionId, entry);
      this.#totalCreated++;
      return createCachedRuntimeProxy(runtime, this, { sessionId, entryId });
    }

    // Case 2: Entry exists but suspended or disposePending -> create new
    if (existing.suspended || existing.disposePending) {
      const runtime = await this.#createRuntime({ sessionId, securityPolicy, metadata });
      const entry: CachedRuntimeEntry = {
        entryId,
        sessionId,
        fingerprint: this.#cloneFingerprint(fingerprint),
        runtime,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        borrowCount: 1,
        suspended: false,
        disposePending: false,
      };
      if (!existing.disposePending) {
        existing.disposePending = true;
        this.#activeEntries.delete(sessionId);
        this.#pendingEntries.set(existing.entryId, existing);
        if (existing.borrowCount === 0) {
          await safeDispose(existing.runtime, this.#logWarning);
          this.#totalDisposed++;
          this.#pendingEntries.delete(existing.entryId);
        }
      } else {
        this.#activeEntries.delete(sessionId);
        // Already in #pendingEntries from prior suspend
      }
      this.#activeEntries.set(sessionId, entry);
      this.#totalCreated++;
      return createCachedRuntimeProxy(runtime, this, { sessionId, entryId });
    }

    // Case 3: Fingerprint mismatch -> create new, retire old
    if (!this.#fingerprintsEqual(existing.fingerprint, fingerprint)) {
      const runtime = await this.#createRuntime({ sessionId, securityPolicy, metadata });
      const entry: CachedRuntimeEntry = {
        entryId,
        sessionId,
        fingerprint: this.#cloneFingerprint(fingerprint),
        runtime,
        createdAt: Date.now(),
        lastUsedAt: Date.now(),
        borrowCount: 1,
        suspended: false,
        disposePending: false,
      };
      existing.disposePending = true;
      this.#activeEntries.delete(sessionId);
      this.#pendingEntries.set(existing.entryId, existing);
      if (existing.borrowCount === 0) {
        await safeDispose(existing.runtime, this.#logWarning);
        this.#totalDisposed++;
        this.#pendingEntries.delete(existing.entryId);
      }
      this.#activeEntries.set(sessionId, entry);
      this.#totalCreated++;
      return createCachedRuntimeProxy(runtime, this, { sessionId, entryId });
    }

    // Case 4: Cache hit -> reuse
    this.#activeEntries.delete(sessionId);
    existing.lastUsedAt = Date.now();
    existing.borrowCount++;
    this.#activeEntries.set(sessionId, existing);
    this.#totalReused++;
    return createCachedRuntimeProxy(existing.runtime, this, { sessionId, entryId: existing.entryId });
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
        await safeDispose(active.runtime, this.#logWarning);
        this.#totalDisposed++;
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
        await safeDispose(pending.runtime, this.#logWarning);
        this.#totalDisposed++;
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
    const entry = this.#activeEntries.get(sessionId);
    if (entry === undefined) return;

    entry.suspended = true;
    entry.suspendedReason = reason;
    entry.suspendedAt = Date.now();
    entry.disposePending = true;

    this.#recordSuspension(sessionId, reason, entry.suspendedAt);

    this.#activeEntries.delete(sessionId);
    this.#pendingEntries.set(entry.entryId, entry);

    if (entry.borrowCount === 0) {
      await safeDispose(entry.runtime, this.#logWarning);
      this.#totalDisposed++;
      this.#pendingEntries.delete(entry.entryId);
    }
  }

  async invalidate(sessionId: string): Promise<void> {
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
        await safeDispose(entry.runtime, this.#logWarning);
        this.#totalDisposed++;
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
        await safeDispose(entry.runtime, this.#logWarning);
        this.#totalDisposed++;
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
      if (entry.borrowCount === 0) {
        promises.push(
          safeDispose(entry.runtime, this.#logWarning)
            .then(() => {
              this.#totalDisposed++;
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
      promises.push(
        safeDispose(entry.runtime, this.#logWarning)
          .then(() => {
            this.#totalDisposed++;
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
    return JSON.stringify(a) === JSON.stringify(b);
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
}
