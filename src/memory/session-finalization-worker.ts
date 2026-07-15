import type { MemoryCurationCheckpointResult } from "./memory-curation-service.js";
import { MemoryCurationCutoffError } from "./memory-curation-service.js";
import {
  MemoryCurationBusyError,
  MemoryCurationLeaseLostError,
} from "./memory-curation-coordinator.js";
import {
  SessionFinalizationQueue,
  type SessionFinalizationJob,
} from "../session/session-finalization-queue.js";

const DEFAULT_JOB_LEASE_MS = 300_000;
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;

export type SessionFinalizationWorkerResult =
  | { status: "idle" }
  | { status: "completed"; job: SessionFinalizationJob; outcomeCode: string }
  | { status: "retried"; job: SessionFinalizationJob; errorCode: string }
  | { status: "failed"; job: SessionFinalizationJob; errorCode: string }
  | { status: "lease-lost"; job: SessionFinalizationJob };

export class SessionFinalizationWorker {
  readonly #queue: SessionFinalizationQueue;
  readonly #profileId: string;
  readonly #ownerId: string;
  readonly #finalize: (job: SessionFinalizationJob, signal: AbortSignal) => Promise<MemoryCurationCheckpointResult>;
  readonly #leaseMs: number;
  readonly #heartbeatMs: number;
  readonly #maxAttempts: number;
  readonly #retryDelayMs: (attempt: number) => number;

  constructor(options: {
    queue: SessionFinalizationQueue;
    profileId: string;
    ownerId?: string;
    finalize: (job: SessionFinalizationJob, signal: AbortSignal) => Promise<MemoryCurationCheckpointResult>;
    leaseMs?: number;
    heartbeatMs?: number;
    maxAttempts?: number;
    retryDelayMs?: (attempt: number) => number;
  }) {
    this.#queue = options.queue;
    this.#profileId = requireScopeValue(options.profileId, "profileId");
    this.#ownerId = requireScopeValue(options.ownerId ?? crypto.randomUUID(), "ownerId");
    this.#finalize = options.finalize;
    this.#leaseMs = requirePositiveInteger(options.leaseMs ?? DEFAULT_JOB_LEASE_MS, "leaseMs");
    this.#heartbeatMs = requirePositiveInteger(options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS, "heartbeatMs");
    this.#maxAttempts = requireBoundedPositiveInteger(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, "maxAttempts", 10);
    this.#retryDelayMs = options.retryDelayMs ?? defaultRetryDelayMs;
    if (this.#heartbeatMs >= this.#leaseMs) {
      throw new Error("heartbeatMs must be shorter than leaseMs.");
    }
  }

  async runOnce(input: { signal?: AbortSignal } = {}): Promise<SessionFinalizationWorkerResult> {
    input.signal?.throwIfAborted();
    const job = this.#queue.claimNext({
      profileId: this.#profileId,
      ownerId: this.#ownerId,
      leaseMs: this.#leaseMs,
    });
    if (job === undefined) {
      return { status: "idle" };
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
        const renewed = this.#queue.renewLease({
          id: job.id,
          profileId: this.#profileId,
          ownerId: this.#ownerId,
          leaseMs: this.#leaseMs,
        });
        if (!renewed) {
          leaseLost = true;
          controller.abort(new Error("session-finalization-job-lease-lost"));
        }
      } catch {
        leaseLost = true;
        controller.abort(new Error("session-finalization-job-lease-lost"));
      }
    }, this.#heartbeatMs);
    heartbeat.unref?.();

    try {
      const result = await this.#finalize(job, controller.signal);
      if (leaseLost) {
        return { status: "lease-lost", job };
      }
      const outcomeCode = `curation-${result.status}`;
      const completed = this.#queue.complete({
        id: job.id,
        profileId: this.#profileId,
        ownerId: this.#ownerId,
        outcomeCode,
      });
      if (completed) {
        this.#pruneTerminalBestEffort();
      }
      return completed
        ? { status: "completed", job, outcomeCode }
        : { status: "lease-lost", job };
    } catch (error) {
      if (leaseLost) {
        return { status: "lease-lost", job };
      }
      const classified = classifyFinalizationError(error, input.signal?.aborted === true);
      if (classified.retryable && job.attempts < this.#maxAttempts) {
        const retried = this.#queue.retry({
          id: job.id,
          profileId: this.#profileId,
          ownerId: this.#ownerId,
          errorCode: classified.code,
          delayMs: boundedRetryDelay(this.#retryDelayMs(job.attempts)),
        });
        return retried
          ? { status: "retried", job, errorCode: classified.code }
          : { status: "lease-lost", job };
      }

      const failed = this.#queue.fail({
        id: job.id,
        profileId: this.#profileId,
        ownerId: this.#ownerId,
        errorCode: classified.code,
      });
      if (failed) {
        this.#pruneTerminalBestEffort();
      }
      return failed
        ? { status: "failed", job, errorCode: classified.code }
        : { status: "lease-lost", job };
    } finally {
      clearInterval(heartbeat);
      input.signal?.removeEventListener("abort", forwardAbort);
    }
  }

  #pruneTerminalBestEffort(): void {
    try {
      this.#queue.pruneTerminal({ profileId: this.#profileId });
    } catch {
      // Retention cleanup must not change an already-persisted terminal outcome.
    }
  }
}

function classifyFinalizationError(error: unknown, workerStopped: boolean): {
  code: string;
  retryable: boolean;
} {
  if (workerStopped) {
    return { code: "worker-stopped", retryable: true };
  }
  if (error instanceof MemoryCurationCutoffError) {
    return { code: error.code, retryable: false };
  }
  if (error instanceof MemoryCurationBusyError) {
    return { code: error.code, retryable: true };
  }
  if (error instanceof MemoryCurationLeaseLostError) {
    return { code: error.code, retryable: true };
  }
  return { code: "curation-failed", retryable: true };
}

function defaultRetryDelayMs(attempt: number): number {
  return Math.min(300_000, 5_000 * (2 ** Math.max(0, attempt - 1)));
}

function boundedRetryDelay(value: number): number {
  if (!Number.isFinite(value)) {
    return 300_000;
  }
  return Math.max(0, Math.min(3_600_000, Math.trunc(value)));
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

function requireBoundedPositiveInteger(value: number, label: string, maximum: number): number {
  const normalized = requirePositiveInteger(value, label);
  if (normalized > maximum) {
    throw new Error(`${label} must not exceed ${maximum}.`);
  }
  return normalized;
}
