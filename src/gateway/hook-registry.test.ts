import { describe, it, expect } from "vitest";
import {
  HookRegistry,
  sanitizeHookError,
  type GatewayHookPayloadByName,
  type HookEvent,
} from "./hook-registry.js";

describe("HookRegistry", () => {
  it("handler receives emitted event", async () => {
    const registry = new HookRegistry();
    const events: HookEvent<"supervisor:start">[] = [];

    registry.on("supervisor:start", (ev) => {
      events.push(ev);
    });

    const payload: GatewayHookPayloadByName["supervisor:start"] = {
      pid: 42,
      startedAt: new Date().toISOString(),
      version: "1.0.0",
      adapterKinds: ["telegram"],
      mode: "daemon",
    };

    await registry.emit("supervisor:start", payload);

    expect(events).toHaveLength(1);
    expect(events[0].name).toBe("supervisor:start");
    expect(events[0].payload).toEqual(payload);
    expect(typeof events[0].emittedAt).toBe("string");
  });

  it("unsubscribe prevents future calls", async () => {
    const registry = new HookRegistry();
    const events: HookEvent<"session:turn:start">[] = [];

    const unsubscribe = registry.on("session:turn:start", (ev) => {
      events.push(ev);
    });

    const payload: GatewayHookPayloadByName["session:turn:start"] = {
      turnId: "turn-1",
      sessionKeyHash: "abc123",
      channel: "telegram",
      origin: "message",
      queueSize: 0,
    };

    await registry.emit("session:turn:start", payload);
    expect(events).toHaveLength(1);

    unsubscribe();
    await registry.emit("session:turn:start", payload);
    expect(events).toHaveLength(1);
  });

  it("handlers run in registration order", async () => {
    const registry = new HookRegistry();
    const order: number[] = [];

    registry.on("session:cache:hit", () => {
      order.push(1);
    });
    registry.on("session:cache:hit", () => {
      order.push(2);
    });
    registry.on("session:cache:hit", () => {
      order.push(3);
    });

    const payload: GatewayHookPayloadByName["session:cache:hit"] = {
      sessionId: "s1",
      entryId: "e1",
      borrowCount: 1,
    };

    await registry.emit("session:cache:hit", payload);
    expect(order).toEqual([1, 2, 3]);
  });

  it("sync handler throw is caught and logged", async () => {
    const logs: string[] = [];
    const registry = new HookRegistry({
      logWarning: (msg) => logs.push(msg),
    });
    const events: number[] = [];

    registry.on("adapter:start", () => {
      events.push(1);
      throw new Error("boom");
    });
    registry.on("adapter:start", () => {
      events.push(2);
    });

    const payload: GatewayHookPayloadByName["adapter:start"] = {
      kind: "telegram",
      state: "starting",
    };

    await registry.emit("adapter:start", payload);

    expect(events).toEqual([1, 2]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("boom");
    expect(logs[0]).toContain("adapter:start");
  });

  it("async handler rejection is caught and logged", async () => {
    const logs: string[] = [];
    const registry = new HookRegistry({
      logWarning: (msg) => logs.push(msg),
    });
    const events: number[] = [];

    registry.on("adapter:error", async () => {
      events.push(1);
      throw new Error("async-boom");
    });
    registry.on("adapter:error", () => {
      events.push(2);
    });

    const payload: GatewayHookPayloadByName["adapter:error"] = {
      kind: "telegram",
      operation: "start",
      state: "failed",
      retryCount: 0,
      errorClass: "Error",
      errorMessage: "fail",
    };

    await registry.emit("adapter:error", payload);

    expect(events).toEqual([1, 2]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("async-boom");
  });

  it("failing handler does not stop later handler", async () => {
    const registry = new HookRegistry();
    const events: number[] = [];

    registry.on("session:turn:complete", () => {
      events.push(1);
      throw new Error("first-fail");
    });
    registry.on("session:turn:complete", () => {
      events.push(2);
      throw new Error("second-fail");
    });
    registry.on("session:turn:complete", () => {
      events.push(3);
    });

    const payload: GatewayHookPayloadByName["session:turn:complete"] = {
      turnId: "turn-1",
      sessionKeyHash: "abc",
      channel: "telegram",
      durationMs: 100,
    };

    await registry.emit("session:turn:complete", payload);
    expect(events).toEqual([1, 2, 3]);
  });

  it("emit never throws", async () => {
    const registry = new HookRegistry();

    registry.on("supervisor:crash", () => {
      throw new Error("sync-crash");
    });
    registry.on("supervisor:crash", async () => {
      throw new Error("async-crash");
    });

    const payload: GatewayHookPayloadByName["supervisor:crash"] = {
      pid: 1,
      phase: "startup",
      errorClass: "Error",
      errorMessage: "fail",
    };

    let threw = false;
    try {
      await registry.emit("supervisor:crash", payload);
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
  });

  it("emittedAt is an ISO-like string", async () => {
    const registry = new HookRegistry();
    let emittedAt = "";

    registry.on("cron:tick:start", (ev) => {
      emittedAt = ev.emittedAt;
    });

    const payload: GatewayHookPayloadByName["cron:tick:start"] = {
      dueCount: 3,
    };

    await registry.emit("cron:tick:start", payload);

    expect(emittedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("payload is passed through unchanged", async () => {
    const registry = new HookRegistry();
    const received: unknown[] = [];

    registry.on("delivery:success", (ev) => {
      received.push(ev.payload);
    });

    const payload: GatewayHookPayloadByName["delivery:success"] = {
      kind: "text",
      target: "origin",
      platform: "telegram",
      truncated: true,
      overflowSaved: true,
      chunkCount: 3,
    };

    await registry.emit("delivery:success", payload);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(payload);
    expect(received[0]).not.toHaveProperty("overflowPath");
    expect(received[0]).not.toHaveProperty("fullPath");
  });

  it("typed payload compile coverage for representative event names", async () => {
    const registry = new HookRegistry();
    const allEvents: unknown[] = [];

    // session:turn:abort with union reason
    registry.on("session:turn:abort", (ev) => {
      allEvents.push({ type: "abort", reason: ev.payload.reason });
    });

    // session:cache:miss with union reason
    registry.on("session:cache:miss", (ev) => {
      allEvents.push({ type: "cache-miss", reason: ev.payload.reason });
    });

    // adapter:error with union operation
    registry.on("adapter:error", (ev) => {
      allEvents.push({ type: "adapter-error", op: ev.payload.operation });
    });

    // delivery:error with union kind
    registry.on("delivery:error", (ev) => {
      allEvents.push({ type: "delivery-error", kind: ev.payload.kind });
    });

    // session:cache:evict with union reason
    registry.on("session:cache:evict", (ev) => {
      allEvents.push({ type: "cache-evict", reason: ev.payload.reason });
    });

    await registry.emit("session:turn:abort", {
      turnId: "t1",
      sessionKeyHash: "h1",
      channel: "telegram",
      reason: "interrupt",
    });

    await registry.emit("session:cache:miss", {
      sessionId: "s1",
      entryId: "e1",
      reason: "fingerprint-mismatch",
    });

    await registry.emit("adapter:error", {
      kind: "telegram",
      operation: "poll",
      state: "degraded",
      retryCount: 2,
      errorClass: "Error",
      errorMessage: "poll failed",
    });

    await registry.emit("delivery:error", {
      kind: "artifact",
      target: "origin",
      platform: "telegram",
      errorClass: "Error",
      errorMessage: "send failed",
    });

    await registry.emit("session:cache:evict", {
      sessionId: "s1",
      entryId: "e1",
      reason: "fingerprint-mismatch",
    });

    expect(allEvents).toEqual([
      { type: "abort", reason: "interrupt" },
      { type: "cache-miss", reason: "fingerprint-mismatch" },
      { type: "adapter-error", op: "poll" },
      { type: "delivery-error", kind: "artifact" },
      { type: "cache-evict", reason: "fingerprint-mismatch" },
    ]);
  });

  it("emit with no handlers is a no-op", async () => {
    const registry = new HookRegistry();

    const payload: GatewayHookPayloadByName["supervisor:stop"] = {
      pid: 1,
      clean: true,
      reason: "SIGTERM",
    };

    let threw = false;
    try {
      await registry.emit("supervisor:stop", payload);
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
  });

  it("handler for a different event name is not called", async () => {
    const registry = new HookRegistry();
    const events: string[] = [];

    registry.on("supervisor:start", () => {
      events.push("supervisor:start");
    });

    const payload: GatewayHookPayloadByName["supervisor:stop"] = {
      pid: 1,
      clean: true,
      reason: "SIGTERM",
    };

    await registry.emit("supervisor:stop", payload);
    expect(events).toHaveLength(0);
  });

  it("unsubscribe is safe when called twice", async () => {
    const registry = new HookRegistry();
    const events: HookEvent<"session:turn:start">[] = [];

    const unsubscribe = registry.on("session:turn:start", (ev) => {
      events.push(ev);
    });

    unsubscribe();
    unsubscribe();

    const payload: GatewayHookPayloadByName["session:turn:start"] = {
      turnId: "turn-1",
      sessionKeyHash: "abc",
      channel: "telegram",
      origin: "message",
      queueSize: 0,
    };

    await registry.emit("session:turn:start", payload);
    expect(events).toHaveLength(0);
  });

  it("logWarning is optional and missing it does not crash", async () => {
    const registry = new HookRegistry();

    registry.on("adapter:error", () => {
      throw new Error("no-logger-boom");
    });

    const payload: GatewayHookPayloadByName["adapter:error"] = {
      kind: "telegram",
      operation: "start",
      state: "failed",
      retryCount: 0,
      errorClass: "Error",
      errorMessage: "fail",
    };

    let threw = false;
    try {
      await registry.emit("adapter:error", payload);
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
  });

  it("multiple event names can coexist independently", async () => {
    const registry = new HookRegistry();
    const startEvents: number[] = [];
    const stopEvents: number[] = [];

    registry.on("supervisor:start", () => {
      startEvents.push(1);
    });
    registry.on("supervisor:stop", () => {
      stopEvents.push(1);
    });

    await registry.emit("supervisor:start", {
      pid: 1,
      startedAt: new Date().toISOString(),
      version: "1.0.0",
      adapterKinds: [],
      mode: "once",
    });

    await registry.emit("supervisor:stop", {
      pid: 1,
      clean: true,
      reason: "done",
    });

    expect(startEvents).toHaveLength(1);
    expect(stopEvents).toHaveLength(1);
  });

  describe("sanitizeHookError", () => {
    it("extracts class and message from Error", () => {
      const result = sanitizeHookError(new Error("boom"));
      expect(result.errorClass).toBe("Error");
      expect(result.errorMessage).toBe("boom");
    });

    it("handles named error subclasses", () => {
      class CustomError extends Error {
        constructor(message: string) {
          super(message);
          this.name = "CustomError";
        }
      }
      const result = sanitizeHookError(new CustomError("custom"));
      expect(result.errorClass).toBe("CustomError");
      expect(result.errorMessage).toBe("custom");
    });

    it("handles non-Error values", () => {
      const result = sanitizeHookError("string error");
      expect(result.errorClass).toBe("UnknownError");
      expect(result.errorMessage).toBe("string error");
    });

    it("handles null/undefined", () => {
      expect(sanitizeHookError(null)).toEqual({ errorClass: "UnknownError", errorMessage: "null" });
      expect(sanitizeHookError(undefined)).toEqual({ errorClass: "UnknownError", errorMessage: "undefined" });
    });

    it("redacts OpenAI-style project token", () => {
      const result = sanitizeHookError(new Error("Request failed with token sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz"));
      expect(result.errorMessage).toContain("[REDACTED]");
      expect(result.errorMessage).not.toContain("sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz");
    });

    it("redacts generic sk token", () => {
      const result = sanitizeHookError(new Error("Invalid key sk-1234567890abcdef1234567890abcdef"));
      expect(result.errorMessage).toContain("[REDACTED]");
      expect(result.errorMessage).not.toContain("sk-1234567890abcdef1234567890abcdef");
    });

    it("redacts Anthropic-style token", () => {
      const result = sanitizeHookError(new Error("Auth failed with ant-1234567890abcdef1234567890abcdef"));
      expect(result.errorMessage).toContain("[REDACTED]");
      expect(result.errorMessage).not.toContain("ant-1234567890abcdef1234567890abcdef");
    });

    it("redacts Bearer token", () => {
      const result = sanitizeHookError(new Error("Header: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"));
      expect(result.errorMessage).toContain("Bearer [REDACTED]");
      expect(result.errorMessage).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    });

    it("caps long messages", () => {
      const longMessage = "a".repeat(300);
      const result = sanitizeHookError(new Error(longMessage));
      expect(result.errorMessage.length).toBeLessThanOrEqual(212); // 200 + " [truncated]"
      expect(result.errorMessage).toContain(" [truncated]");
    });
  });
});
