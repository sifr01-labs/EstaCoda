import type { ProviderUsageEntry } from "../contracts/provider-usage.js";
import type {
  ProviderSpendAttempt,
  ProviderSpendRequest,
  ProviderSpendReservationResult,
  ProviderSpendingScope,
} from "../contracts/provider-spend.js";
import { assertProviderSpendRequest } from "../contracts/provider-spend.js";
import type { ProviderSpendController } from "../providers/provider-executor.js";

const SCOPE_OWNER_ID = "vision-live-evaluation";

/** Process-local hard cap for an explicitly consented evaluation run. */
export class BoundedEvaluationSpendController implements ProviderSpendController {
  readonly #profileId: string;
  readonly #maximumCostUsd: number;
  readonly #attempts = new Map<string, ProviderSpendAttempt>();
  #spentCostUsd = 0;
  #reservedCostUsd = 0;

  constructor(input: { readonly profileId: string; readonly maximumCostUsd: number }) {
    if (input.profileId.trim().length === 0) throw new Error("Evaluation spend profile ID is required.");
    if (!Number.isFinite(input.maximumCostUsd) || input.maximumCostUsd <= 0) {
      throw new Error("Evaluation maximum estimated cost must be a positive finite USD amount.");
    }
    this.#profileId = input.profileId;
    this.#maximumCostUsd = input.maximumCostUsd;
  }

  reserve(request: ProviderSpendRequest, reservedAt: string): ProviderSpendReservationResult {
    assertProviderSpendRequest(request);
    if (request.profileId !== this.#profileId) throw new Error("Evaluation spend profile mismatch.");
    const existing = this.#attempts.get(request.requestKey);
    if (existing !== undefined) return { ok: true, attempt: existing };
    const available = Math.max(0, this.#maximumCostUsd - this.#spentCostUsd - this.#reservedCostUsd);
    if (request.maximumEstimatedCostUsd > available) {
      return {
        ok: false,
        reason: "SESSION_LIMIT_EXHAUSTED",
        scope: this.#scope(reservedAt),
        requestedCostUsd: request.maximumEstimatedCostUsd,
        availableCostUsd: available,
      };
    }
    const attempt = this.#attempt(request, reservedAt);
    this.#attempts.set(request.requestKey, attempt);
    this.#reservedCostUsd += attempt.reservedCostUsd;
    return { ok: true, attempt };
  }

  markDispatching(requestKey: string, dispatchingAt: string): ProviderSpendAttempt {
    return this.#transition(requestKey, {
      state: "dispatching",
      dispatchingAt,
      executionHeartbeatAt: dispatchingAt,
    });
  }

  releaseBeforeDispatch(requestKey: string, releasedAt: string): ProviderSpendAttempt {
    const attempt = this.#requireAttempt(requestKey);
    if (attempt.state !== "released") this.#reservedCostUsd -= attempt.reservedCostUsd;
    return this.#transition(requestKey, { state: "released", releasedAt });
  }

  settle(requestKey: string, usage: ProviderUsageEntry, settledAt: string): ProviderSpendAttempt {
    const attempt = this.#requireAttempt(requestKey);
    if (attempt.state !== "settled") {
      this.#reservedCostUsd -= attempt.reservedCostUsd;
      this.#spentCostUsd += usage.estimatedCostUsd;
    }
    return this.#transition(requestKey, {
      state: "settled",
      settledAt,
      actualEstimatedCostUsd: usage.estimatedCostUsd,
      usageEntryId: usage.id,
    });
  }

  markUncertain(requestKey: string, uncertainAt: string, reason: string): ProviderSpendAttempt {
    return this.#transition(requestKey, {
      state: "uncertain",
      uncertainAt,
      uncertaintyReason: reason,
    });
  }

  snapshot(): { readonly maximumCostUsd: number; readonly spentCostUsd: number; readonly reservedCostUsd: number } {
    return {
      maximumCostUsd: this.#maximumCostUsd,
      spentCostUsd: Math.max(0, this.#spentCostUsd),
      reservedCostUsd: Math.max(0, this.#reservedCostUsd),
    };
  }

  #attempt(request: ProviderSpendRequest, reservedAt: string): ProviderSpendAttempt {
    return {
      id: `vision-eval:${request.requestKey}`,
      request,
      state: "reserved",
      executionOwnerId: SCOPE_OWNER_ID,
      executionFencingToken: 1,
      executionHeartbeatAt: reservedAt,
      executionExpiresAt: new Date(Date.parse(reservedAt) + 3_600_000).toISOString(),
      reservedCostUsd: request.maximumEstimatedCostUsd,
      createdAt: reservedAt,
      reservedAt,
      allocations: [{
        profileId: this.#profileId,
        requestKey: request.requestKey,
        scopeKind: "session",
        scopeOwnerId: SCOPE_OWNER_ID,
        reservedCostUsd: request.maximumEstimatedCostUsd,
        createdAt: reservedAt,
      }],
    };
  }

  #scope(createdAt: string): ProviderSpendingScope {
    const committed = this.#spentCostUsd + this.#reservedCostUsd;
    return {
      profileId: this.#profileId,
      kind: "session",
      ownerId: SCOPE_OWNER_ID,
      maxEstimatedCostUsd: this.#maximumCostUsd,
      warningThresholdPercent: 80,
      spentCostUsd: this.#spentCostUsd,
      reservedCostUsd: this.#reservedCostUsd,
      state: committed >= this.#maximumCostUsd ? "exhausted" : "available",
      ownerCreatedAt: createdAt,
      createdAt,
      ...(committed >= this.#maximumCostUsd ? { exhaustedAt: createdAt } : {}),
    };
  }

  #transition(requestKey: string, patch: Partial<ProviderSpendAttempt>): ProviderSpendAttempt {
    const next = { ...this.#requireAttempt(requestKey), ...patch };
    this.#attempts.set(requestKey, next);
    return next;
  }

  #requireAttempt(requestKey: string): ProviderSpendAttempt {
    const attempt = this.#attempts.get(requestKey);
    if (attempt === undefined) throw new Error(`Unknown evaluation spend request: ${requestKey}`);
    return attempt;
  }
}
