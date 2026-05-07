export type ActiveTurnRegistryOptions = {
  /** Stuck threshold in ms. Default 5 min (300_000). */
  stuckThresholdMs?: number;
  /** Max stuck scans before a turn is flagged repeat-stuck. Default 3. */
  maxStuckChecks?: number;
  /** Busy ack cooldown in ms. Default 30s (30_000). */
  busyAckCooldownMs?: number;
  /** Recent stuck-turn history size. Default 50. */
  historySize?: number;
  /** Optional logger. */
  logWarning?: (message: string) => void;
};

export type ActiveTurn = {
  turnId: string;
  key: string;
  startedAt: number;
  abortController?: AbortController;
  stuckCheckCount: number;
  busyAckSentAt?: number;
};

export type StartTurnResult =
  | { ok: true; turnId: string }
  | { ok: false; reason: "busy"; currentTurnId: string };

export type AbortTurnResult =
  | { ok: true; turnId: string }
  | { ok: false; reason: "not_found" };

export type ActiveTurnRegistryStats = {
  activeTurnCount: number;
  totalStarted: number;
  totalEnded: number;
  totalAborted: number;
  stuckTurnCount: number;
  repeatStuckCount: number;
};

export type StuckTurnHistoryEntry = {
  turnId: string;
  key: string;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  wasAborted: boolean;
};

export class ActiveTurnRegistry {
  #activeTurns: Map<string, ActiveTurn>;
  #history: StuckTurnHistoryEntry[];
  #abortedTurnIds: Set<string>;

  #stuckThresholdMs: number;
  #maxStuckChecks: number;
  #busyAckCooldownMs: number;
  #historySize: number;
  #logWarning?: (message: string) => void;

  #nextTurnId = 0;
  #totalStarted = 0;
  #totalEnded = 0;
  #totalAborted = 0;

  constructor(options?: ActiveTurnRegistryOptions) {
    this.#activeTurns = new Map();
    this.#history = [];
    this.#abortedTurnIds = new Set();

    this.#stuckThresholdMs = options?.stuckThresholdMs ?? 300_000;
    this.#maxStuckChecks = options?.maxStuckChecks ?? 3;
    this.#busyAckCooldownMs = options?.busyAckCooldownMs ?? 30_000;
    this.#historySize = options?.historySize ?? 50;
    this.#logWarning = options?.logWarning;
  }

  #generateTurnId(): string {
    return `turn-${++this.#nextTurnId}`;
  }

  /** Attempt to start a turn for key.
   *  Returns busy if key already has an active turn. */
  startTurn(key: string, abortController?: AbortController): StartTurnResult {
    const existing = this.#activeTurns.get(key);
    if (existing !== undefined) {
      return { ok: false, reason: "busy", currentTurnId: existing.turnId };
    }

    const turnId = this.#generateTurnId();
    const turn: ActiveTurn = {
      turnId,
      key,
      startedAt: Date.now(),
      abortController,
      stuckCheckCount: 0,
    };
    this.#activeTurns.set(key, turn);
    this.#totalStarted++;
    return { ok: true, turnId };
  }

  /** End a turn. Must match turnId. Idempotent if already ended. */
  endTurn(key: string, turnId: string): void {
    const turn = this.#activeTurns.get(key);
    if (turn === undefined) {
      // Already ended or never started. Harmless.
      return;
    }

    if (turn.turnId !== turnId) {
      this.#logWarning?.(
        `ActiveTurnRegistry endTurn turnId mismatch: key=${key} expected=${turnId} actual=${turn.turnId}`
      );
      return;
    }

    // Record history if this turn was ever flagged as stuck
    if (turn.stuckCheckCount > 0) {
      const now = Date.now();
      this.#history.push({
        turnId: turn.turnId,
        key: turn.key,
        startedAt: turn.startedAt,
        endedAt: now,
        durationMs: now - turn.startedAt,
        wasAborted: this.#wasAborted(turn.turnId),
      });
      if (this.#history.length > this.#historySize) {
        this.#history.shift();
      }
    }

    this.#activeTurns.delete(key);
    this.#abortedTurnIds.delete(turn.turnId);
    this.#totalEnded++;
  }

  /** Check if a key has an active turn. */
  isBusy(key: string): boolean {
    return this.#activeTurns.has(key);
  }

  /** Get the active turn for a key, or undefined. */
  getTurn(key: string): ActiveTurn | undefined {
    return this.#activeTurns.get(key);
  }

  /** Abort an active turn via its AbortController.
   *  Does NOT remove the turn from registry — caller cleanup calls endTurn. */
  abortTurn(key: string, reason: string): AbortTurnResult {
    const turn = this.#activeTurns.get(key);
    if (turn === undefined) {
      return { ok: false, reason: "not_found" };
    }

    turn.abortController?.abort(reason);
    this.#abortedTurnIds.add(turn.turnId);
    this.#totalAborted++;
    return { ok: true, turnId: turn.turnId };
  }

  /** Scan active turns and return those exceeding stuckThresholdMs.
   *  Increments stuckCheckCount for each stuck turn found. */
  listStuckTurns(thresholdMs?: number): Array<ActiveTurn & { stuckForMs: number }> {
    const threshold = thresholdMs ?? this.#stuckThresholdMs;
    const now = Date.now();
    const stuck: Array<ActiveTurn & { stuckForMs: number }> = [];

    for (const turn of this.#activeTurns.values()) {
      const stuckForMs = now - turn.startedAt;
      if (stuckForMs > threshold) {
        turn.stuckCheckCount++;
        stuck.push({ ...turn, stuckForMs });
      }
    }

    return stuck;
  }

  /** Return turns whose stuckCheckCount >= maxStuckChecks.
   *  Does NOT increment counts. */
  getRepeatStuckTurns(): Array<ActiveTurn & { stuckForMs: number }> {
    const now = Date.now();
    const repeat: Array<ActiveTurn & { stuckForMs: number }> = [];

    for (const turn of this.#activeTurns.values()) {
      if (turn.stuckCheckCount >= this.#maxStuckChecks) {
        repeat.push({ ...turn, stuckForMs: now - turn.startedAt });
      }
    }

    return repeat;
  }

  /** Record that a busy ack was sent for this key. */
  recordBusyAck(key: string): void {
    const turn = this.#activeTurns.get(key);
    if (turn !== undefined) {
      turn.busyAckSentAt = Date.now();
    }
  }

  /** Should a busy ack be sent for this key?
   *  True if no ack was ever sent OR if cooldown has elapsed. */
  shouldSendBusyAck(key: string): boolean {
    const turn = this.#activeTurns.get(key);
    if (turn === undefined) return false;
    if (turn.busyAckSentAt === undefined) return true;
    return Date.now() - turn.busyAckSentAt > this.#busyAckCooldownMs;
  }

  /** Return current stats snapshot. */
  stats(): ActiveTurnRegistryStats {
    let stuckTurnCount = 0;
    let repeatStuckCount = 0;
    const now = Date.now();

    for (const turn of this.#activeTurns.values()) {
      if (now - turn.startedAt > this.#stuckThresholdMs) {
        stuckTurnCount++;
        if (turn.stuckCheckCount >= this.#maxStuckChecks) {
          repeatStuckCount++;
        }
      }
    }

    return {
      activeTurnCount: this.#activeTurns.size,
      totalStarted: this.#totalStarted,
      totalEnded: this.#totalEnded,
      totalAborted: this.#totalAborted,
      stuckTurnCount,
      repeatStuckCount,
    };
  }

  /** Return recent stuck-turn history (ended turns that were flagged stuck).
   *  Ring buffer, oldest dropped when over historySize. */
  stuckTurnHistory(): StuckTurnHistoryEntry[] {
    return this.#history.slice();
  }

  /** Remove all active turns and clear history. For testing / emergency reset. */
  clear(): void {
    this.#activeTurns.clear();
    this.#history.length = 0;
    this.#abortedTurnIds.clear();
    this.#totalStarted = 0;
    this.#totalEnded = 0;
    this.#totalAborted = 0;
    this.#nextTurnId = 0;
  }

  #wasAborted(turnId: string): boolean {
    return this.#abortedTurnIds.has(turnId);
  }
}
