import type { SQLiteDatabase } from "../storage/sqlite.js";

const DEFAULT_LEASE_MS = 300_000;
const DEFAULT_HEARTBEAT_MS = 30_000;

export class MemoryCurationBusyError extends Error {
  readonly name = "MemoryCurationBusyError";
  readonly code = "memory-curation-busy";

  constructor() {
    super("Memory curation is already running for this profile.");
  }
}

export class MemoryCurationLeaseLostError extends Error {
  readonly name = "MemoryCurationLeaseLostError";
  readonly code = "memory-curation-lease-lost";

  constructor() {
    super("Memory curation stopped because its profile lease was lost.");
  }
}

export type MemoryCurationCheckpointCoordinator = {
  runExclusive<T>(input: {
    signal?: AbortSignal;
    task: (signal: AbortSignal) => Promise<T>;
  }): Promise<T>;
};

export class SQLiteMemoryCurationCoordinator implements MemoryCurationCheckpointCoordinator {
  readonly #db: SQLiteDatabase;
  readonly #profileId: string;
  readonly #ownerId: string;
  readonly #now: () => Date;
  readonly #leaseMs: number;
  readonly #heartbeatMs: number;

  constructor(options: {
    db: SQLiteDatabase;
    profileId: string;
    ownerId?: string;
    now?: () => Date;
    leaseMs?: number;
    heartbeatMs?: number;
  }) {
    this.#db = options.db;
    this.#profileId = requireScopeValue(options.profileId, "profileId");
    this.#ownerId = requireScopeValue(options.ownerId ?? crypto.randomUUID(), "ownerId");
    this.#now = options.now ?? (() => new Date());
    this.#leaseMs = requirePositiveInteger(options.leaseMs ?? DEFAULT_LEASE_MS, "leaseMs");
    this.#heartbeatMs = requirePositiveInteger(options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS, "heartbeatMs");
    if (this.#heartbeatMs >= this.#leaseMs) {
      throw new Error("heartbeatMs must be shorter than leaseMs.");
    }
  }

  async runExclusive<T>(input: {
    signal?: AbortSignal;
    task: (signal: AbortSignal) => Promise<T>;
  }): Promise<T> {
    input.signal?.throwIfAborted();
    if (!this.#acquire()) {
      throw new MemoryCurationBusyError();
    }

    const controller = new AbortController();
    let leaseLost = false;
    const forwardAbort = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", forwardAbort, { once: true });
    if (input.signal?.aborted === true) {
      forwardAbort();
    }
    const heartbeat = setInterval(() => {
      try {
        if (!this.#renew()) {
          leaseLost = true;
          controller.abort(new MemoryCurationLeaseLostError());
        }
      } catch {
        leaseLost = true;
        controller.abort(new MemoryCurationLeaseLostError());
      }
    }, this.#heartbeatMs);
    heartbeat.unref?.();

    try {
      const result = await input.task(controller.signal);
      if (leaseLost) {
        throw new MemoryCurationLeaseLostError();
      }
      return result;
    } finally {
      clearInterval(heartbeat);
      input.signal?.removeEventListener("abort", forwardAbort);
      this.#release();
    }
  }

  #acquire(): boolean {
    const nowDate = this.#now();
    const now = nowDate.toISOString();
    const leaseExpiresAt = new Date(nowDate.getTime() + this.#leaseMs).toISOString();
    let acquired = false;
    this.#withWriteTransaction(() => {
      this.#db
        .query("delete from memory_curation_leases where profile_id = ? and lease_expires_at <= ?")
        .run(this.#profileId, now);
      const result = this.#db
        .query(
          `insert into memory_curation_leases (
            profile_id, owner_id, acquired_at, lease_expires_at, updated_at
          ) values (?, ?, ?, ?, ?)
          on conflict(profile_id) do nothing`
        )
        .run(this.#profileId, this.#ownerId, now, leaseExpiresAt, now);
      acquired = result.changes === 1;
    });
    return acquired;
  }

  #renew(): boolean {
    const nowDate = this.#now();
    const now = nowDate.toISOString();
    const result = this.#db
      .query(
        `update memory_curation_leases
        set lease_expires_at = ?, updated_at = ?
        where profile_id = ? and owner_id = ? and lease_expires_at > ?`
      )
      .run(
        new Date(nowDate.getTime() + this.#leaseMs).toISOString(),
        now,
        this.#profileId,
        this.#ownerId,
        now
      );
    return result.changes === 1;
  }

  #release(): void {
    this.#db
      .query("delete from memory_curation_leases where profile_id = ? and owner_id = ?")
      .run(this.#profileId, this.#ownerId);
  }

  #withWriteTransaction(write: () => void): void {
    this.#db.exec("begin immediate");
    try {
      write();
      this.#db.exec("commit");
    } catch (error) {
      try {
        this.#db.exec("rollback");
      } catch {
        // Preserve the original transaction failure.
      }
      throw error;
    }
  }
}

function requireScopeValue(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized !== value) {
    throw new Error(`${label} must be a non-empty value without surrounding whitespace.`);
  }
  return normalized;
}

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}
