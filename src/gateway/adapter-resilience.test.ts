import { describe, it, expect, vi } from "vitest";
import { AdapterResilienceSupervisor, DEFAULT_ADAPTER_BACKOFF, computeBackoffDelay } from "./adapter-resilience.js";
import type { ChannelAdapter } from "../contracts/channel.js";
import { HookRegistry } from "./hook-registry.js";
import { WhatsAppBridgeRuntimeError } from "../channels/whatsapp-bridge-errors.js";

function fakeAdapter(overrides?: Partial<ChannelAdapter> & { pollThrows?: boolean; startThrows?: boolean }): ChannelAdapter {
  return {
    id: "test",
    kind: "telegram",
    delivery: {
      sendText: async () => {},
    },
    start: overrides?.startThrows
      ? async () => { throw new Error("start fail"); }
      : async () => {},
    stop: async () => {},
    pollOnce: overrides?.pollThrows
      ? async () => { throw new Error("poll fail"); }
      : async () => 0,
    ...overrides,
  };
}

function fakeRandomSequence(values: number[]) {
  let i = 0;
  return () => {
    const v = values[i % values.length];
    i += 1;
    return v;
  };
}

describe("AdapterResilienceSupervisor", () => {
  it("start succeeds -> state healthy, pendingOperation cleared", async () => {
    const wrapper = new AdapterResilienceSupervisor(fakeAdapter());
    await wrapper.start(async () => {});
    const state = wrapper.getState();
    expect(state.state).toBe("healthy");
    expect(state.pendingOperation).toBeUndefined();
    expect(state.lastError).toBeUndefined();
  });

  it("start fails once -> state degraded, pendingOperation = start", async () => {
    const wrapper = new AdapterResilienceSupervisor(fakeAdapter({ startThrows: true }));
    await wrapper.start(async () => {});
    const state = wrapper.getState();
    expect(state.state).toBe("degraded");
    expect(state.pendingOperation).toBe("start");
    expect(state.lastError?.message).toBe("start fail");
    expect(state.lastError?.count).toBe(1);
  });

  it("start fails twice -> state retry_scheduled with backoff", async () => {
    const wrapper = new AdapterResilienceSupervisor(fakeAdapter({ startThrows: true }));
    await wrapper.start(async () => {});
    await wrapper.tick();
    const state = wrapper.getState();
    expect(state.state).toBe("retry_scheduled");
    expect(state.pendingOperation).toBe("start");
    expect(state.retry).toBeDefined();
    expect(state.retry!.attempt).toBe(2);
  });

  it("start fails max times -> state failed", async () => {
    const wrapper = new AdapterResilienceSupervisor(
      fakeAdapter({ startThrows: true }),
      { maxAttempts: 2 }
    );
    await wrapper.start(async () => {});
    await wrapper.tick(); // attempt 2 -> fails -> retry_scheduled
    // Force past backoff
    const s1 = wrapper.getState();
    if (s1.retry) {
      const next = new Date(s1.retry.nextRetryAt);
      const original = Date.now;
      globalThis.Date.now = () => next.getTime() + 1;
      await wrapper.tick();
      globalThis.Date.now = original;
    }
    const state = wrapper.getState();
    expect(state.state).toBe("failed");
    expect(state.retry).toBeUndefined();
  });

  it("start fails then tick retries start and succeeds -> state healthy", async () => {
    let throws = true;
    const adapter = fakeAdapter({
      start: async () => {
        if (throws) {
          throws = false;
          throw new Error("start fail");
        }
      },
    });
    const wrapper = new AdapterResilienceSupervisor(adapter);
    await wrapper.start(async () => {});
    expect(wrapper.getState().state).toBe("degraded");
    await wrapper.tick();
    expect(wrapper.getState().state).toBe("healthy");
    expect(wrapper.getState().pendingOperation).toBeUndefined();
  });

  it("websocket adapter start fails, tick retries, succeeds -> state healthy", async () => {
    let throws = true;
    const adapter = fakeAdapter({
      kind: "discord",
      pollOnce: undefined,
      start: async () => {
        if (throws) {
          throws = false;
          throw new Error("ws fail");
        }
      },
    });
    const wrapper = new AdapterResilienceSupervisor(adapter);
    await wrapper.start(async () => {});
    expect(wrapper.getState().state).toBe("degraded");
    await wrapper.tick();
    expect(wrapper.getState().state).toBe("healthy");
  });

  it("websocket adapter start fails repeatedly -> reaches failed", async () => {
    const adapter = fakeAdapter({
      kind: "discord",
      pollOnce: undefined,
      startThrows: true,
    });
    const wrapper = new AdapterResilienceSupervisor(adapter, { maxAttempts: 2 });
    await wrapper.start(async () => {});
    await wrapper.tick(); // degraded -> retry
    const s = wrapper.getState();
    if (s.retry) {
      const next = new Date(s.retry.nextRetryAt);
      const original = Date.now;
      globalThis.Date.now = () => next.getTime() + 1;
      await wrapper.tick();
      globalThis.Date.now = original;
    }
    expect(wrapper.getState().state).toBe("failed");
  });

  it("WhatsApp non-retryable bridge errors fail without scheduling retries", async () => {
    const adapter = fakeAdapter({
      kind: "whatsapp",
      start: async () => {
        throw new WhatsAppBridgeRuntimeError({
          code: "whatsapp_logged_out",
          message: "WhatsApp logged out",
        });
      },
    });
    const wrapper = new AdapterResilienceSupervisor(adapter);

    await wrapper.start(async () => {});

    const state = wrapper.getState();
    expect(state.state).toBe("failed");
    expect(state.retry).toBeUndefined();
    expect(state.pendingOperation).toBe("start");
  });

  it("WhatsApp restart-required schedules a fast reconnect", async () => {
    const adapter = fakeAdapter({
      kind: "whatsapp",
      start: async () => {
        throw new WhatsAppBridgeRuntimeError({
          code: "whatsapp_restart_required",
          message: "WhatsApp restart required",
        });
      },
    });
    const wrapper = new AdapterResilienceSupervisor(adapter, { randomFn: () => 0 });
    const before = Date.now();

    await wrapper.start(async () => {});

    const state = wrapper.getState();
    expect(state.state).toBe("retry_scheduled");
    expect(state.retry?.attempt).toBe(1);
    expect(new Date(state.retry!.nextRetryAt).getTime() - before).toBeLessThanOrEqual(1500);
  });

  it("non-WhatsApp adapters with code-shaped errors keep generic retry behavior", async () => {
    const error = new Error("discord transport fail") as Error & { code: string; retryable: boolean };
    error.code = "whatsapp_logged_out";
    error.retryable = false;
    const adapter = fakeAdapter({
      kind: "discord",
      start: async () => { throw error; },
    });
    const wrapper = new AdapterResilienceSupervisor(adapter);

    await wrapper.start(async () => {});

    expect(wrapper.getState().state).toBe("degraded");
    expect(wrapper.getState().retry).toBeUndefined();
  });

  it("poll succeeds -> increments pollsTotal and pollMessagesProcessed", async () => {
    const wrapper = new AdapterResilienceSupervisor(fakeAdapter({ pollOnce: async () => 3 }));
    await wrapper.start(async () => {});
    const count = await wrapper.poll();
    const state = wrapper.getState();
    expect(count).toBe(3);
    expect(state.pollsTotal).toBe(1);
    expect(state.pollMessagesProcessed).toBe(3);
  });

  it("poll fails once -> state degraded, pendingOperation = poll", async () => {
    const wrapper = new AdapterResilienceSupervisor(fakeAdapter({ pollThrows: true }));
    await wrapper.start(async () => {});
    const count = await wrapper.poll();
    const state = wrapper.getState();
    expect(count).toBe(0);
    expect(state.state).toBe("degraded");
    expect(state.pendingOperation).toBe("poll");
    expect(state.pollsFailed).toBe(1);
  });

  it("poll fails twice -> state retry_scheduled with backoff", async () => {
    const wrapper = new AdapterResilienceSupervisor(fakeAdapter({ pollThrows: true }));
    await wrapper.start(async () => {});
    await wrapper.poll(); // degraded
    await wrapper.poll(); // retry_scheduled
    const state = wrapper.getState();
    expect(state.state).toBe("retry_scheduled");
    expect(state.pendingOperation).toBe("poll");
    expect(state.retry).toBeDefined();
  });

  it("poll retry via tick succeeds -> state healthy, resets retry", async () => {
    let throws = true;
    const adapter = fakeAdapter({
      pollOnce: async () => {
        if (throws) {
          throws = false;
          throw new Error("poll fail");
        }
        return 5;
      },
    });
    const wrapper = new AdapterResilienceSupervisor(adapter);
    await wrapper.start(async () => {});
    await wrapper.poll(); // degraded
    // tick() for poll is NOT triggered by tick() because degraded + pendingOperation === "poll"
    // is handled by poll() directly on the next loop iteration, not tick()
    // Wait, the plan says:
    // tick() handles: degraded + pendingOperation === "start" → attempt start()
    // poll() handles: degraded + pendingOperation === "poll" → calls pollOnce directly
    const count = await wrapper.poll();
    expect(count).toBe(5);
    expect(wrapper.getState().state).toBe("healthy");
    expect(wrapper.getState().retry).toBeUndefined();
  });

  it("poll retry exhausts -> state failed", async () => {
    const wrapper = new AdapterResilienceSupervisor(
      fakeAdapter({ pollThrows: true }),
      { maxAttempts: 2 }
    );
    await wrapper.start(async () => {});
    await wrapper.poll(); // degraded
    await wrapper.poll(); // retry_scheduled with attempt=2
    // Force past backoff
    const s = wrapper.getState();
    if (s.retry) {
      const next = new Date(s.retry.nextRetryAt);
      const original = Date.now;
      globalThis.Date.now = () => next.getTime() + 1;
      await wrapper.tick(); // tick retries poll
      globalThis.Date.now = original;
    }
    expect(wrapper.getState().state).toBe("failed");
  });

  it("stop -> state stopped, clears retry", async () => {
    const wrapper = new AdapterResilienceSupervisor(fakeAdapter());
    await wrapper.start(async () => {});
    await wrapper.stop();
    const state = wrapper.getState();
    expect(state.state).toBe("stopped");
    expect(state.retry).toBeUndefined();
    expect(state.pendingOperation).toBeUndefined();
  });

  it("backoff delay increases exponentially", () => {
    const random = () => 0;
    const options = {
      baseDelayMs: 1000,
      maxDelayMs: 60000,
      maxAttempts: 5,
      jitter: 0.2,
      randomFn: random,
    };
    expect(computeBackoffDelay(1, options)).toBe(1000);
    expect(computeBackoffDelay(2, options)).toBe(2000);
    expect(computeBackoffDelay(3, options)).toBe(4000);
    expect(computeBackoffDelay(4, options)).toBe(8000);
  });

  it("backoff delay capped at maxDelayMs", () => {
    const random = () => 0;
    const options = {
      baseDelayMs: 1000,
      maxDelayMs: 5000,
      maxAttempts: 10,
      jitter: 0.2,
      randomFn: random,
    };
    expect(computeBackoffDelay(1, options)).toBe(1000);
    expect(computeBackoffDelay(2, options)).toBe(2000);
    expect(computeBackoffDelay(3, options)).toBe(4000);
    expect(computeBackoffDelay(4, options)).toBe(5000);
    expect(computeBackoffDelay(5, options)).toBe(5000);
    expect(computeBackoffDelay(10, options)).toBe(5000);
  });

  it("jitter uses injected randomFn", () => {
    const options = {
      baseDelayMs: 1000,
      maxDelayMs: 60000,
      maxAttempts: 5,
      jitter: 0.2,
      randomFn: () => 0.5,
    };
    // base = 1000 * 2^(2-1) = 2000, jitter = 1 + 0.5*0.2 = 1.1, delay = 2200
    expect(computeBackoffDelay(2, options)).toBe(2200);
  });

  it("one adapter failed does not affect another adapter's polling", async () => {
    const bad = new AdapterResilienceSupervisor(fakeAdapter({ pollThrows: true }));
    const good = new AdapterResilienceSupervisor(fakeAdapter({ pollOnce: async () => 3 }));
    await bad.start(async () => {});
    await good.start(async () => {});
    await bad.poll();
    const goodCount = await good.poll();
    expect(goodCount).toBe(3);
    expect(good.getState().state).toBe("healthy");
  });

  it("lastError count increments on consecutive same-operation failures", async () => {
    const wrapper = new AdapterResilienceSupervisor(fakeAdapter({ startThrows: true }));
    await wrapper.start(async () => {});
    expect(wrapper.getState().lastError!.count).toBe(1);
    await wrapper.tick();
    expect(wrapper.getState().lastError!.count).toBe(2);
  });

  it("websocket adapter (no pollOnce) poll() returns 0 and does not throw", async () => {
    const adapter = fakeAdapter({ kind: "discord", pollOnce: undefined });
    const wrapper = new AdapterResilienceSupervisor(adapter);
    await wrapper.start(async () => {});
    const count = await wrapper.poll();
    expect(count).toBe(0);
    expect(wrapper.getState().state).toBe("healthy");
  });

  it("start never throws, even when raw adapter start throws", async () => {
    const wrapper = new AdapterResilienceSupervisor(fakeAdapter({ startThrows: true }));
    await expect(wrapper.start(async () => {})).resolves.toBeUndefined();
    expect(wrapper.getState().state).toBe("degraded");
  });

  it("wrapper proxies id, kind, delivery from raw adapter", () => {
    const adapter = fakeAdapter({ id: "my-id", kind: "email" });
    const wrapper = new AdapterResilienceSupervisor(adapter);
    expect(wrapper.id).toBe("my-id");
    expect(wrapper.kind).toBe("email");
    expect(wrapper.delivery).toBe(adapter.delivery);
  });

  it("wrapper preserves the inbound processing indicator with raw-adapter binding", async () => {
    const calls: boolean[] = [];
    const adapter = fakeAdapter({
      setInboundProcessingIndicator: async function (_message, active) {
        expect(this).toBe(adapter);
        calls.push(active);
        return true;
      }
    });
    const wrapper = new AdapterResilienceSupervisor(adapter);
    const message = {
      id: "message-1",
      channel: "telegram" as const,
      sessionKey: { platform: "telegram" as const, chatId: "123" },
      text: "hello",
      sender: { id: "user-1" },
      receivedAt: new Date().toISOString()
    };

    await expect(wrapper.setInboundProcessingIndicator?.(message, true)).resolves.toBe(true);
    await expect(wrapper.setInboundProcessingIndicator?.(message, false)).resolves.toBe(true);
    expect(calls).toEqual([true, false]);
  });

  it("wrapper preserves getCapabilities if raw adapter has it", () => {
    const cap = () => ({
      kind: "telegram" as const,
      enabled: true,
      configured: true,
      inboundMode: "polling" as const,
      outboundMode: "push" as const,
      supportsAttachments: true,
      supportsThreads: true,
      supportsApprovals: true,
      supportsProgressStreaming: true,
      experimental: false,
      implementationStatus: "live_proven" as const,
    });
    const adapter = fakeAdapter({ getCapabilities: cap });
    const wrapper = new AdapterResilienceSupervisor(adapter);
    expect(wrapper.getCapabilities).toBe(cap);
  });

  it("pollOnce proxy exists when raw adapter has pollOnce", () => {
    const wrapper = new AdapterResilienceSupervisor(fakeAdapter({ pollOnce: async () => 5 }));
    expect(wrapper.pollOnce).toBeDefined();
    expect(typeof wrapper.pollOnce).toBe("function");
  });

  it("pollOnce proxy returns undefined when raw adapter has no pollOnce", () => {
    const wrapper = new AdapterResilienceSupervisor(fakeAdapter({ pollOnce: undefined }));
    expect(wrapper.pollOnce).toBeUndefined();
  });

  it("pollOnce proxy calls wrapper poll path and updates state on failure", async () => {
    const wrapper = new AdapterResilienceSupervisor(fakeAdapter({ pollThrows: true }));
    await wrapper.start(async () => {});
    expect(wrapper.pollOnce).toBeDefined();
    const count = await wrapper.pollOnce!();
    expect(count).toBe(0);
    const state = wrapper.getState();
    expect(state.state).toBe("degraded");
    expect(state.pendingOperation).toBe("poll");
    expect(state.pollsFailed).toBe(1);
  });

  it("pollOnce proxy counts messages on success", async () => {
    const wrapper = new AdapterResilienceSupervisor(fakeAdapter({ pollOnce: async () => 7 }));
    await wrapper.start(async () => {});
    const count = await wrapper.pollOnce!();
    expect(count).toBe(7);
    const state = wrapper.getState();
    expect(state.pollsTotal).toBe(1);
    expect(state.pollMessagesProcessed).toBe(7);
  });
});

describe("AdapterResilienceSupervisor hook emissions", () => {
  function createCapturingHookRegistry() {
    const registry = new HookRegistry();
    const events: Array<{ name: string; payload: unknown }> = [];
    vi.spyOn(registry, "emit").mockImplementation(async (name: any, payload: any) => {
      events.push({ name, payload });
    });
    return { registry, events };
  }

  it("emits adapter:start on successful initial start", async () => {
    const { registry, events } = createCapturingHookRegistry();
    const wrapper = new AdapterResilienceSupervisor(fakeAdapter(), undefined, undefined, registry);
    await wrapper.start(async () => {});
    const startEvent = events.find((e) => e.name === "adapter:start");
    expect(startEvent).toBeDefined();
    expect(startEvent!.payload).toEqual({ kind: "telegram", state: "healthy" });
  });

  it("does not emit adapter:recovered on initial start success", async () => {
    const { registry, events } = createCapturingHookRegistry();
    const wrapper = new AdapterResilienceSupervisor(fakeAdapter(), undefined, undefined, registry);
    await wrapper.start(async () => {});
    const recoveredEvent = events.find((e) => e.name === "adapter:recovered");
    expect(recoveredEvent).toBeUndefined();
  });

  it("emits adapter:stop on stop", async () => {
    const { registry, events } = createCapturingHookRegistry();
    const wrapper = new AdapterResilienceSupervisor(fakeAdapter(), undefined, undefined, registry);
    await wrapper.start(async () => {});
    await wrapper.stop();
    const stopEvent = events.find((e) => e.name === "adapter:stop");
    expect(stopEvent).toBeDefined();
    expect(stopEvent!.payload).toEqual({ kind: "telegram", state: "stopped" });
  });

  it("emits adapter:error with operation stop when raw stop throws", async () => {
    const { registry, events } = createCapturingHookRegistry();
    const adapter = fakeAdapter({ stop: async () => { throw new Error("stop fail"); } });
    const wrapper = new AdapterResilienceSupervisor(adapter, undefined, undefined, registry);
    await wrapper.start(async () => {});
    await wrapper.stop();
    const errorEvent = events.find((e) => e.name === "adapter:error");
    expect(errorEvent).toBeDefined();
    expect((errorEvent!.payload as any).operation).toBe("stop");
    expect((errorEvent!.payload as any).state).toBe("stopped");
    expect((errorEvent!.payload as any).retryCount).toBe(0);
  });

  it("raw stop failure does not throw to caller", async () => {
    const adapter = fakeAdapter({ stop: async () => { throw new Error("stop fail"); } });
    const wrapper = new AdapterResilienceSupervisor(adapter);
    await wrapper.start(async () => {});
    await expect(wrapper.stop()).resolves.toBeUndefined();
  });

  it("emits adapter:error then adapter:degraded on first start failure in order", async () => {
    const { registry, events } = createCapturingHookRegistry();
    const wrapper = new AdapterResilienceSupervisor(fakeAdapter({ startThrows: true }), undefined, undefined, registry);
    await wrapper.start(async () => {});
    const names = events.map((e) => e.name);
    expect(names).toEqual(["adapter:error", "adapter:degraded"]);
    expect((events[0].payload as any).state).toBe("degraded");
    expect((events[1].payload as any).state).toBe("degraded");
  });

  it("emits adapter:error then adapter:retry on retry-scheduled failure in order", async () => {
    const { registry, events } = createCapturingHookRegistry();
    const wrapper = new AdapterResilienceSupervisor(fakeAdapter({ startThrows: true }), undefined, undefined, registry);
    await wrapper.start(async () => {});
    events.length = 0;
    await wrapper.tick();
    const names = events.map((e) => e.name);
    expect(names).toEqual(["adapter:error", "adapter:retry"]);
    const retryPayload = events[1].payload as any;
    expect(retryPayload.retryCount).toBe(2);
    expect(retryPayload.nextRetryAt).toBeDefined();
  });

  it("max-attempt failure emits adapter:error and no adapter:retry", async () => {
    const { registry, events } = createCapturingHookRegistry();
    const wrapper = new AdapterResilienceSupervisor(
      fakeAdapter({ startThrows: true }),
      { maxAttempts: 2 },
      undefined,
      registry,
    );
    await wrapper.start(async () => {});
    await wrapper.tick();
    // Clear and force past backoff
    events.length = 0;
    const s = wrapper.getState();
    if (s.retry) {
      const next = new Date(s.retry.nextRetryAt);
      const original = Date.now;
      globalThis.Date.now = () => next.getTime() + 1;
      await wrapper.tick();
      globalThis.Date.now = original;
    }
    const names = events.map((e) => e.name);
    expect(names).toEqual(["adapter:error"]);
    expect(wrapper.getState().state).toBe("failed");
  });

  it("emits adapter:recovered on retry start success via tick", async () => {
    let throws = true;
    const adapter = fakeAdapter({
      start: async () => {
        if (throws) {
          throws = false;
          throw new Error("start fail");
        }
      },
    });
    const { registry, events } = createCapturingHookRegistry();
    const wrapper = new AdapterResilienceSupervisor(adapter, undefined, undefined, registry);
    await wrapper.start(async () => {});
    expect(wrapper.getState().state).toBe("degraded");
    await wrapper.tick();
    const recoveredEvent = events.find((e) => e.name === "adapter:recovered");
    expect(recoveredEvent).toBeDefined();
    expect((recoveredEvent!.payload as any).operation).toBe("start");
  });

  it("does not emit adapter:start on retry success", async () => {
    let throws = true;
    const adapter = fakeAdapter({
      start: async () => {
        if (throws) {
          throws = false;
          throw new Error("start fail");
        }
      },
    });
    const { registry, events } = createCapturingHookRegistry();
    const wrapper = new AdapterResilienceSupervisor(adapter, undefined, undefined, registry);
    await wrapper.start(async () => {});
    await wrapper.tick();
    const startEvent = events.find((e) => e.name === "adapter:start");
    expect(startEvent).toBeUndefined();
    const recoveredEvent = events.find((e) => e.name === "adapter:recovered");
    expect(recoveredEvent).toBeDefined();
  });

  it("emits adapter:recovered on degraded direct poll success", async () => {
    let throws = true;
    const adapter = fakeAdapter({
      pollOnce: async () => {
        if (throws) {
          throws = false;
          throw new Error("poll fail");
        }
        return 5;
      },
    });
    const { registry, events } = createCapturingHookRegistry();
    const wrapper = new AdapterResilienceSupervisor(adapter, undefined, undefined, registry);
    await wrapper.start(async () => {});
    await wrapper.poll();
    events.length = 0;
    const count = await wrapper.poll();
    expect(count).toBe(5);
    const recoveredEvent = events.find((e) => e.name === "adapter:recovered");
    expect(recoveredEvent).toBeDefined();
    expect((recoveredEvent!.payload as any).operation).toBe("poll");
  });

  it("emits adapter:recovered on retry-scheduled poll success via tick", async () => {
    let failCount = 2;
    const adapter = fakeAdapter({
      pollOnce: async () => {
        if (failCount > 0) {
          failCount -= 1;
          throw new Error("poll fail");
        }
        return 3;
      },
    });
    const { registry, events } = createCapturingHookRegistry();
    const wrapper = new AdapterResilienceSupervisor(adapter, undefined, undefined, registry);
    await wrapper.start(async () => {});
    await wrapper.poll(); // healthy -> degraded
    await wrapper.poll(); // degraded -> retry_scheduled
    events.length = 0;
    const s = wrapper.getState();
    if (s.retry) {
      const next = new Date(s.retry.nextRetryAt);
      const original = Date.now;
      globalThis.Date.now = () => next.getTime() + 1;
      await wrapper.tick(); // tick retries poll -> healthy
      globalThis.Date.now = original;
    }
    expect(wrapper.getState().state).toBe("healthy");
    const recoveredEvent = events.find((e) => e.name === "adapter:recovered");
    expect(recoveredEvent).toBeDefined();
    expect((recoveredEvent!.payload as any).operation).toBe("poll");
  });

  it("does not emit adapter:recovered on healthy poll success", async () => {
    const { registry, events } = createCapturingHookRegistry();
    const wrapper = new AdapterResilienceSupervisor(fakeAdapter({ pollOnce: async () => 3 }), undefined, undefined, registry);
    await wrapper.start(async () => {});
    events.length = 0;
    await wrapper.poll();
    const recoveredEvent = events.find((e) => e.name === "adapter:recovered");
    expect(recoveredEvent).toBeUndefined();
  });

  it("emits adapter:error on every consecutive failure", async () => {
    const { registry, events } = createCapturingHookRegistry();
    const wrapper = new AdapterResilienceSupervisor(fakeAdapter({ startThrows: true }), undefined, undefined, registry);
    await wrapper.start(async () => {});
    await wrapper.tick();
    const errorEvents = events.filter((e) => e.name === "adapter:error");
    expect(errorEvents.length).toBe(2);
    expect((errorEvents[0].payload as any).retryCount).toBe(1);
    expect((errorEvents[1].payload as any).retryCount).toBe(2);
  });

  it("hook failures do not affect state transitions", async () => {
    const registry = new HookRegistry();
    vi.spyOn(registry, "emit").mockImplementation(() => {
      throw new Error("hook boom");
    });
    const wrapper = new AdapterResilienceSupervisor(fakeAdapter({ startThrows: true }), undefined, undefined, registry);
    await wrapper.start(async () => {});
    expect(wrapper.getState().state).toBe("degraded");
  });

  it("hook failures during stop do not throw", async () => {
    const registry = new HookRegistry();
    vi.spyOn(registry, "emit").mockImplementation(() => {
      throw new Error("hook boom");
    });
    const wrapper = new AdapterResilienceSupervisor(fakeAdapter(), undefined, undefined, registry);
    await wrapper.start(async () => {});
    await expect(wrapper.stop()).resolves.toBeUndefined();
  });
});
