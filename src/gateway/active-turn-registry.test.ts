import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  ActiveTurnRegistry,
  type ActiveTurnRegistryOptions,
} from "./active-turn-registry.js";

describe("ActiveTurnRegistry", () => {
  let registry: ActiveTurnRegistry;
  let warnings: string[];

  beforeEach(() => {
    warnings = [];
    const opts: ActiveTurnRegistryOptions = {
      stuckThresholdMs: 300_000,
      maxStuckChecks: 3,
      busyAckCooldownMs: 30_000,
      historySize: 50,
      logWarning: (msg: string) => warnings.push(msg),
    };
    registry = new ActiveTurnRegistry(opts);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // 1
  it("startTurn succeeds for first turn on key", () => {
    const result = registry.startTurn("k1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.turnId).toBeTruthy();
    }
    expect(registry.isBusy("k1")).toBe(true);
  });

  // 2
  it("startTurn rejects second turn on same key", () => {
    const first = registry.startTurn("k1");
    expect(first.ok).toBe(true);

    const second = registry.startTurn("k1");
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.reason).toBe("busy");
      expect(second.currentTurnId).toBe(
        first.ok ? first.turnId : undefined
      );
    }
  });

  // 3
  it("startTurn succeeds for different key while first is active", () => {
    registry.startTurn("k1");
    const result = registry.startTurn("k2");
    expect(result.ok).toBe(true);
    expect(registry.stats().activeTurnCount).toBe(2);
  });

  // 4
  it("endTurn removes active turn", () => {
    const result = registry.startTurn("k1");
    expect(result.ok).toBe(true);
    const turnId = result.ok ? result.turnId : "";

    registry.endTurn("k1", turnId);
    expect(registry.isBusy("k1")).toBe(false);
    expect(registry.stats().totalEnded).toBe(1);
  });

  // 5
  it("endTurn with wrong turnId logs warning and is no-op", () => {
    const result = registry.startTurn("k1");
    expect(result.ok).toBe(true);
    const turnId = result.ok ? result.turnId : "";

    registry.endTurn("k1", "wrong-id");
    expect(registry.isBusy("k1")).toBe(true);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("turnId mismatch");
    expect(warnings[0]).toContain("wrong-id");
    expect(warnings[0]).toContain(turnId);
  });

  // 6
  it("endTurn is idempotent", () => {
    const result = registry.startTurn("k1");
    expect(result.ok).toBe(true);
    const turnId = result.ok ? result.turnId : "";

    registry.endTurn("k1", turnId);
    expect(registry.isBusy("k1")).toBe(false);

    // second endTurn is harmless
    registry.endTurn("k1", turnId);
    expect(registry.isBusy("k1")).toBe(false);
    expect(warnings).toHaveLength(0);
  });

  // 7
  it("isBusy returns false for unknown key", () => {
    expect(registry.isBusy("unknown")).toBe(false);
  });

  // 8
  it("getTurn returns active turn metadata", () => {
    const result = registry.startTurn("k1");
    expect(result.ok).toBe(true);
    const turnId = result.ok ? result.turnId : "";

    const turn = registry.getTurn("k1");
    expect(turn).toBeDefined();
    expect(turn!.turnId).toBe(turnId);
    expect(turn!.key).toBe("k1");
    expect(turn!.stuckCheckCount).toBe(0);
  });

  // 9
  it("getTurn returns undefined for unknown key", () => {
    expect(registry.getTurn("unknown")).toBeUndefined();
  });

  // 10
  it("abortTurn calls abort on provided controller", () => {
    const controller = new AbortController();
    const spy = vi.spyOn(controller, "abort");

    const result = registry.startTurn("k1", controller);
    expect(result.ok).toBe(true);

    const abortResult = registry.abortTurn("k1", "user-stop");
    expect(abortResult.ok).toBe(true);
    expect(spy).toHaveBeenCalledWith("user-stop");
    spy.mockRestore();
  });

  // 11
  it("abortTurn returns not_found for unknown key", () => {
    const result = registry.abortTurn("unknown", "reason");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not_found");
    }
  });

  // 12
  it("abortTurn does not remove turn from registry", () => {
    registry.startTurn("k1", new AbortController());
    registry.abortTurn("k1", "reason");
    expect(registry.isBusy("k1")).toBe(true);
  });

  // 13
  it("abortTurn increments totalAborted", () => {
    registry.startTurn("k1", new AbortController());
    expect(registry.stats().totalAborted).toBe(0);

    registry.abortTurn("k1", "reason");
    expect(registry.stats().totalAborted).toBe(1);
  });

  // 14
  it("abortTurn without controller is harmless", () => {
    registry.startTurn("k1"); // no abortController
    const result = registry.abortTurn("k1", "reason");
    expect(result.ok).toBe(true);
    expect(registry.isBusy("k1")).toBe(true);
    expect(registry.stats().totalAborted).toBe(1);
  });

  // 15
  it("abortTurn twice is harmless", () => {
    const controller = new AbortController();
    registry.startTurn("k1", controller);

    const first = registry.abortTurn("k1", "reason");
    expect(first.ok).toBe(true);

    const second = registry.abortTurn("k1", "reason");
    expect(second.ok).toBe(true);
    expect(registry.stats().totalAborted).toBe(2);
  });

  // 16
  it("endTurn after abort allows new startTurn", () => {
    const result = registry.startTurn("k1", new AbortController());
    expect(result.ok).toBe(true);
    const turnId = result.ok ? result.turnId : "";

    registry.abortTurn("k1", "reason");
    registry.endTurn("k1", turnId);
    expect(registry.isBusy("k1")).toBe(false);

    const next = registry.startTurn("k1");
    expect(next.ok).toBe(true);
  });

  // 17
  it("listStuckTurns returns empty when no turns exceed threshold", () => {
    registry.startTurn("k1");
    vi.advanceTimersByTime(1000);
    expect(registry.listStuckTurns()).toHaveLength(0);
  });

  // 18
  it("listStuckTurns returns stuck turns", () => {
    registry.startTurn("k1");
    vi.advanceTimersByTime(300_001);
    const stuck = registry.listStuckTurns();
    expect(stuck).toHaveLength(1);
    expect(stuck[0].stuckForMs).toBeGreaterThan(300_000);
  });

  // 19
  it("listStuckTurns increments stuckCheckCount", () => {
    registry.startTurn("k1");
    vi.advanceTimersByTime(300_001);
    registry.listStuckTurns();
    expect(registry.getTurn("k1")!.stuckCheckCount).toBe(1);
  });

  // 20
  it("listStuckTurns increments count on repeated scans", () => {
    registry.startTurn("k1");
    vi.advanceTimersByTime(300_001);
    registry.listStuckTurns();
    vi.advanceTimersByTime(300_001);
    registry.listStuckTurns();
    vi.advanceTimersByTime(300_001);
    registry.listStuckTurns();
    expect(registry.getTurn("k1")!.stuckCheckCount).toBe(3);
  });

  // 21
  it("getRepeatStuckTurns returns empty below threshold", () => {
    registry.startTurn("k1");
    vi.advanceTimersByTime(300_001);
    registry.listStuckTurns(); // count = 1
    vi.advanceTimersByTime(300_001);
    registry.listStuckTurns(); // count = 2
    expect(registry.getRepeatStuckTurns()).toHaveLength(0);
  });

  // 22
  it("getRepeatStuckTurns returns turns at threshold", () => {
    registry.startTurn("k1");
    vi.advanceTimersByTime(300_001);
    registry.listStuckTurns(); // 1
    vi.advanceTimersByTime(300_001);
    registry.listStuckTurns(); // 2
    vi.advanceTimersByTime(300_001);
    registry.listStuckTurns(); // 3

    const repeat = registry.getRepeatStuckTurns();
    expect(repeat).toHaveLength(1);
    expect(repeat[0].stuckCheckCount).toBe(3);
  });

  // 23
  it("shouldSendBusyAck returns true on first call", () => {
    registry.startTurn("k1");
    expect(registry.shouldSendBusyAck("k1")).toBe(true);
  });

  // 24
  it("shouldSendBusyAck returns false within cooldown", () => {
    registry.startTurn("k1");
    registry.recordBusyAck("k1");
    vi.advanceTimersByTime(1000);
    expect(registry.shouldSendBusyAck("k1")).toBe(false);
  });

  // 25
  it("shouldSendBusyAck returns true after cooldown", () => {
    registry.startTurn("k1");
    registry.recordBusyAck("k1");
    vi.advanceTimersByTime(30_001);
    expect(registry.shouldSendBusyAck("k1")).toBe(true);
  });

  // 26
  it("recordBusyAck updates timestamp", () => {
    registry.startTurn("k1");
    expect(registry.getTurn("k1")!.busyAckSentAt).toBeUndefined();
    registry.recordBusyAck("k1");
    expect(registry.getTurn("k1")!.busyAckSentAt).toBeTypeOf("number");
  });

  // 27
  it("stats tracks started/ended/aborted", () => {
    registry.startTurn("k1");
    registry.startTurn("k2");
    expect(registry.stats().totalStarted).toBe(2);

    registry.endTurn("k1", registry.getTurn("k1")!.turnId);
    expect(registry.stats().totalEnded).toBe(1);

    registry.abortTurn("k2", "reason");
    expect(registry.stats().totalAborted).toBe(1);
  });

  // 28
  it("stats counts stuck and repeatStuck dynamically", () => {
    registry.startTurn("k1");
    expect(registry.stats().stuckTurnCount).toBe(0);
    expect(registry.stats().repeatStuckCount).toBe(0);

    vi.advanceTimersByTime(300_001);
    expect(registry.stats().stuckTurnCount).toBe(1);
    expect(registry.stats().repeatStuckCount).toBe(0);

    registry.listStuckTurns();
    registry.listStuckTurns();
    registry.listStuckTurns();
    expect(registry.stats().repeatStuckCount).toBe(1);
  });

  // 29
  it("stuckTurnHistory records ended stuck turns", () => {
    registry.startTurn("k1");
    vi.advanceTimersByTime(300_001);
    registry.listStuckTurns();
    registry.endTurn("k1", registry.getTurn("k1")!.turnId);

    const history = registry.stuckTurnHistory();
    expect(history).toHaveLength(1);
    expect(history[0].key).toBe("k1");
    expect(history[0].wasAborted).toBe(false);
  });

  // 30
  it("stuckTurnHistory does not record non-stuck turns", () => {
    registry.startTurn("k1");
    registry.endTurn("k1", registry.getTurn("k1")!.turnId);
    expect(registry.stuckTurnHistory()).toHaveLength(0);
  });

  // 31
  it("stuckTurnHistory is bounded", () => {
    const smallRegistry = new ActiveTurnRegistry({
      stuckThresholdMs: 1,
      historySize: 3,
    });

    for (let i = 0; i < 5; i++) {
      const key = `k${i}`;
      smallRegistry.startTurn(key);
      vi.advanceTimersByTime(2);
      smallRegistry.listStuckTurns();
      smallRegistry.endTurn(key, smallRegistry.getTurn(key)!.turnId);
    }

    const history = smallRegistry.stuckTurnHistory();
    expect(history.length).toBeLessThanOrEqual(3);
  });

  // 32
  it("clear removes all turns and resets counters", () => {
    registry.startTurn("k1");
    registry.startTurn("k2");
    registry.abortTurn("k1", "reason");
    registry.endTurn("k1", registry.getTurn("k1")!.turnId);

    registry.clear();
    expect(registry.isBusy("k1")).toBe(false);
    expect(registry.isBusy("k2")).toBe(false);
    const stats = registry.stats();
    expect(stats.activeTurnCount).toBe(0);
    expect(stats.totalStarted).toBe(0);
    expect(stats.totalEnded).toBe(0);
    expect(stats.totalAborted).toBe(0);
    expect(registry.stuckTurnHistory()).toHaveLength(0);
  });

  // 33
  it("turnId is unique across multiple starts", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const key = `k${i}`;
      const result = registry.startTurn(key);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(ids.has(result.turnId)).toBe(false);
        ids.add(result.turnId);
      }
    }
    expect(ids.size).toBe(100);
  });

  // 34
  it("startTurn after endTurn on same key succeeds", () => {
    const first = registry.startTurn("k1");
    expect(first.ok).toBe(true);
    const turnId = first.ok ? first.turnId : "";

    registry.endTurn("k1", turnId);

    const second = registry.startTurn("k1");
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.turnId).not.toBe(turnId);
    }
  });

  // Bonus: getRepeatStuckTurns does not increment stuckCheckCount
  it("getRepeatStuckTurns does not increment stuckCheckCount", () => {
    registry.startTurn("k1");
    vi.advanceTimersByTime(300_001);
    registry.listStuckTurns(); // 1
    registry.listStuckTurns(); // 2
    registry.listStuckTurns(); // 3

    expect(registry.getTurn("k1")!.stuckCheckCount).toBe(3);
    registry.getRepeatStuckTurns();
    expect(registry.getTurn("k1")!.stuckCheckCount).toBe(3);
  });

  // Bonus: shouldSendBusyAck returns false when no active turn
  it("shouldSendBusyAck returns false when key is not busy", () => {
    expect(registry.shouldSendBusyAck("unknown")).toBe(false);
  });

  // Bonus: new turn resets busy ack debounce
  it("new turn resets busy ack debounce", () => {
    registry.startTurn("k1");
    registry.recordBusyAck("k1");
    vi.advanceTimersByTime(30_001);
    registry.endTurn("k1", registry.getTurn("k1")!.turnId);

    registry.startTurn("k1");
    expect(registry.shouldSendBusyAck("k1")).toBe(true);
  });

  // Bonus: abort then end records wasAborted in history
  it("stuckTurnHistory records wasAborted for aborted turns", () => {
    registry.startTurn("k1");
    vi.advanceTimersByTime(300_001);
    registry.listStuckTurns();
    registry.abortTurn("k1", "reason");
    registry.endTurn("k1", registry.getTurn("k1")!.turnId);

    const history = registry.stuckTurnHistory();
    expect(history).toHaveLength(1);
    expect(history[0].wasAborted).toBe(true);
  });

  // Bonus: stats stuckTurnCount and repeatStuckCount are zero when empty
  it("stats stuck counts are zero with no active turns", () => {
    const stats = registry.stats();
    expect(stats.stuckTurnCount).toBe(0);
    expect(stats.repeatStuckCount).toBe(0);
  });

  // Bonus: endTurn on never-started key is harmless
  it("endTurn on never-started key is harmless", () => {
    registry.endTurn("never", "turn-1");
    expect(warnings).toHaveLength(0);
    expect(registry.stats().totalEnded).toBe(0);
  });

  // Bonus: listStuckTurns respects custom threshold parameter
  it("listStuckTurns respects custom threshold parameter", () => {
    registry.startTurn("k1");
    vi.advanceTimersByTime(100);
    expect(registry.listStuckTurns(50)).toHaveLength(1);
    expect(registry.listStuckTurns(200)).toHaveLength(0);
  });

  // Bonus: multiple keys with mixed stuck state
  it("listStuckTurns handles multiple keys with mixed stuck state", () => {
    registry.startTurn("fast");
    registry.startTurn("slow");
    vi.advanceTimersByTime(300_001);
    const stuck = registry.listStuckTurns();
    expect(stuck.length).toBe(2);
  });

  // Bonus: getRepeatStuckTurns returns empty when registry is empty
  it("getRepeatStuckTurns returns empty when registry is empty", () => {
    expect(registry.getRepeatStuckTurns()).toHaveLength(0);
  });

  // Stage 5D extension tests
  it("startTurn accepts optional metadata", () => {
    const result = registry.startTurn("k1", new AbortController(), { sessionId: "sess-1" });
    expect(result.ok).toBe(true);
    const turn = registry.getTurn("k1");
    expect(turn?.metadata).toEqual({ sessionId: "sess-1" });
  });

  it("updateTurn merges metadata for existing turn", () => {
    registry.startTurn("k1", new AbortController(), { sessionId: "sess-1" });
    const turnId = registry.getTurn("k1")!.turnId;
    registry.updateTurn("k1", turnId, { extra: "value" });
    expect(registry.getTurn("k1")?.metadata).toEqual({ sessionId: "sess-1", extra: "value" });
  });

  it("updateTurn no-op for missing turn", () => {
    registry.updateTurn("missing", "turn-1", { sessionId: "sess-1" });
    expect(registry.getTurn("missing")).toBeUndefined();
    expect(warnings).toHaveLength(0);
  });

  it("updateTurn warns on turnId mismatch", () => {
    registry.startTurn("k1", new AbortController(), { sessionId: "sess-1" });
    registry.updateTurn("k1", "wrong-id", { extra: "value" });
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("updateTurn turnId mismatch");
    expect(registry.getTurn("k1")?.metadata).toEqual({ sessionId: "sess-1" });
  });

  it("metadata preserved in listStuckTurns result", () => {
    registry.startTurn("k1", new AbortController(), { sessionId: "sess-1" });
    vi.advanceTimersByTime(300_001);
    const stuck = registry.listStuckTurns();
    expect(stuck).toHaveLength(1);
    expect(stuck[0].metadata).toEqual({ sessionId: "sess-1" });
  });

  // consumeBusyAck atomic tests
  it("consumeBusyAck first call returns true", () => {
    registry.startTurn("k1", new AbortController());
    expect(registry.consumeBusyAck("k1")).toBe(true);
  });

  it("consumeBusyAck second call within cooldown returns false", () => {
    registry.startTurn("k1", new AbortController());
    expect(registry.consumeBusyAck("k1")).toBe(true);
    expect(registry.consumeBusyAck("k1")).toBe(false);
  });

  it("consumeBusyAck after cooldown returns true", () => {
    registry.startTurn("k1", new AbortController());
    expect(registry.consumeBusyAck("k1")).toBe(true);
    vi.advanceTimersByTime(30_001);
    expect(registry.consumeBusyAck("k1")).toBe(true);
  });

  it("consumeBusyAck returns false when key is not busy", () => {
    expect(registry.consumeBusyAck("unknown")).toBe(false);
  });

  it("consumeBusyAck resets after endTurn", () => {
    const result = registry.startTurn("k1", new AbortController());
    expect(registry.consumeBusyAck("k1")).toBe(true);
    registry.endTurn("k1", result.ok ? result.turnId : "");
    expect(registry.consumeBusyAck("k1")).toBe(false);
  });
});
