import { describe, expect, it, vi } from "vitest";
import type {
  SecureInputDestination,
  SecureInputRequest,
  SecureInputScope
} from "../contracts/secure-input.js";
import {
  EphemeralSecretBroker,
  SecureInputBrokerError
} from "./ephemeral-secret-broker.js";

const scope: SecureInputScope = {
  profileId: "profile-a",
  sessionId: "session-a",
  userId: "user-a"
};

const destination: SecureInputDestination = {
  type: "browser-field",
  sessionId: "browser-session-a",
  ref: "@password",
  expectedOrigin: "https://developers.mtn.com",
  tabRef: "@tab-1",
  frameId: "main",
  label: "Password"
};

function request(overrides: Partial<SecureInputRequest> = {}): SecureInputRequest {
  return {
    kind: "password",
    purpose: "Log in to the MTN developer portal",
    destination: { ...destination },
    retention: "use-once",
    ...overrides
  };
}

function expectBrokerError(error: unknown, code: SecureInputBrokerError["code"]): void {
  expect(error).toBeInstanceOf(SecureInputBrokerError);
  expect((error as SecureInputBrokerError).code).toBe(code);
}

describe("EphemeralSecretBroker", () => {
  it("creates bounded metadata-only requests and clones caller-owned input", () => {
    const mutableRequest = request();
    const broker = new EphemeralSecretBroker({
      idFactory: () => "secure_input_1",
      now: () => new Date("2026-08-13T10:00:00.000Z")
    });

    const created = broker.createRequest({ scope, request: mutableRequest });
    mutableRequest.purpose = "Changed after creation";
    (mutableRequest.destination as { label?: string }).label = "Changed field";

    expect(created).toEqual({
      id: "secure_input_1",
      scope,
      request: request(),
      status: "awaiting_input",
      requestedAt: "2026-08-13T10:00:00.000Z",
      expiresAt: "2026-08-13T10:02:00.000Z"
    });
    expect(broker.getRequest(created.id, scope)?.request).toEqual(request());
    expect(JSON.stringify(created)).not.toContain("secret://");
    expect(JSON.stringify(broker)).toBe("{}");
  });

  it("delivers a value once and overwrites the consumer view after use", async () => {
    const sentinel = "sentinel-password-123";
    const broker = new EphemeralSecretBroker({ idFactory: () => "secure_input_1" });
    const created = broker.createRequest({ scope, request: request() });
    const ready = broker.provideSecret({ requestId: created.id, scope, value: sentinel });
    let observedValue = "";
    let retainedView: Uint8Array | undefined;

    const consumed = await broker.consume({
      requestId: created.id,
      scope,
      destination
    }, (value, context) => {
      retainedView = value;
      observedValue = new TextDecoder().decode(value);
      expect(context.requestId).toBe(created.id);
      expect(context.scope).toEqual(scope);
      expect(context.request.destination).toEqual(destination);
      expect(context.signal.aborted).toBe(false);
    });

    expect(ready.status).toBe("ready");
    expect(observedValue).toBe(sentinel);
    expect(consumed.status).toBe("consumed");
    expect(retainedView).toBeDefined();
    expect([...retainedView!]).toEqual(new Array(retainedView!.byteLength).fill(0));
    expect(JSON.stringify(consumed)).not.toContain(sentinel);
    await expect(broker.consume({ requestId: created.id, scope, destination }, () => {}))
      .rejects.toSatisfy((error: unknown) => {
        expectBrokerError(error, "invalid_state");
        return true;
      });
  });

  it("atomically rejects a concurrent second consumer", async () => {
    const broker = new EphemeralSecretBroker({ idFactory: () => "secure_input_1" });
    const created = broker.createRequest({ scope, request: request() });
    broker.provideSecret({ requestId: created.id, scope, value: "single-consumer-secret" });
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const firstDidStart = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });

    const first = broker.consume({ requestId: created.id, scope, destination }, async () => {
      firstStarted();
      await firstMayFinish;
    });
    await firstDidStart;

    await expect(broker.consume({ requestId: created.id, scope, destination }, () => {}))
      .rejects.toSatisfy((error: unknown) => {
        expectBrokerError(error, "invalid_state");
        return true;
      });
    releaseFirst();
    await expect(first).resolves.toMatchObject({ status: "consumed" });
  });

  it("binds requests to the exact profile, session, and user without leaking existence", () => {
    const broker = new EphemeralSecretBroker({ idFactory: () => "secure_input_1" });
    const created = broker.createRequest({ scope, request: request() });
    const wrongScopes: SecureInputScope[] = [
      { ...scope, profileId: "profile-b" },
      { ...scope, sessionId: "session-b" },
      { ...scope, userId: "user-b" },
      { profileId: scope.profileId, sessionId: scope.sessionId }
    ];

    for (const wrongScope of wrongScopes) {
      expect(broker.getRequest(created.id, wrongScope)).toBeUndefined();
      expect(() => broker.provideSecret({ requestId: created.id, scope: wrongScope, value: "wrong" }))
        .toThrowError(expect.objectContaining({ code: "not_found" }));
    }

    expect(broker.getRequest(created.id, scope)?.status).toBe("awaiting_input");
  });

  it("invalidates and clears a ready value when the destination changes", async () => {
    const broker = new EphemeralSecretBroker({ idFactory: () => "secure_input_1" });
    const created = broker.createRequest({ scope, request: request() });
    broker.provideSecret({ requestId: created.id, scope, value: "destination-bound-secret" });
    const redirected: SecureInputDestination = { ...destination, ref: "@different-field" };

    await expect(broker.consume({ requestId: created.id, scope, destination: redirected }, () => {}))
      .rejects.toSatisfy((error: unknown) => {
        expectBrokerError(error, "destination_mismatch");
        return true;
      });
    expect(broker.getRequest(created.id, scope)?.status).toBe("cancelled");
    await expect(broker.consume({ requestId: created.id, scope, destination }, () => {}))
      .rejects.toSatisfy((error: unknown) => {
        expectBrokerError(error, "cancelled");
        return true;
      });
  });

  it("expires ready values, clears their buffer, and never calls the consumer", async () => {
    let nowMs = Date.parse("2026-08-13T10:00:00.000Z");
    const broker = new EphemeralSecretBroker({
      idFactory: () => "secure_input_1",
      now: () => new Date(nowMs),
      defaultTtlMs: 1_000
    });
    const created = broker.createRequest({ scope, request: request() });
    broker.provideSecret({ requestId: created.id, scope, value: "expiring-secret" });
    nowMs += 1_000;
    let called = false;

    expect(broker.expireStaleRequests()).toBe(1);
    expect(broker.getRequest(created.id, scope)?.status).toBe("expired");
    await expect(broker.consume({ requestId: created.id, scope, destination }, () => {
      called = true;
    })).rejects.toSatisfy((error: unknown) => {
      expectBrokerError(error, "expired");
      return true;
    });
    expect(called).toBe(false);
  });

  it("expires idle values on schedule without requiring another broker operation", () => {
    vi.useFakeTimers();
    try {
      let id = 0;
      const fixedNow = new Date("2026-08-13T10:00:00.000Z");
      const broker = new EphemeralSecretBroker({
        idFactory: () => `secure_input_${++id}`,
        now: () => fixedNow,
        defaultTtlMs: 1_000,
        maxPendingRequests: 1
      });
      const created = broker.createRequest({ scope, request: request() });
      broker.provideSecret({ requestId: created.id, scope, value: "timer-cleared-secret" });

      vi.advanceTimersByTime(1_000);

      expect(broker.getRequest(created.id, scope)?.status).toBe("expired");
      expect(() => broker.createRequest({
        scope: { ...scope, sessionId: "session-b" },
        request: request()
      })).not.toThrow();
      broker.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires and clears a value even while a consumer is still running", async () => {
    vi.useFakeTimers();
    try {
      const broker = new EphemeralSecretBroker({
        idFactory: () => "secure_input_1",
        now: () => new Date("2026-08-13T10:00:00.000Z"),
        defaultTtlMs: 1_000
      });
      const created = broker.createRequest({ scope, request: request() });
      broker.provideSecret({ requestId: created.id, scope, value: "in-flight-expiring-secret" });

      await expect(broker.consume({ requestId: created.id, scope, destination }, async (value, context) => {
        vi.advanceTimersByTime(1_000);
        await Promise.resolve();
        expect(context.signal.aborted).toBe(true);
        expect([...value]).toEqual(new Array(value.byteLength).fill(0));
      })).rejects.toSatisfy((error: unknown) => {
        expectBrokerError(error, "expired");
        return true;
      });
      expect(broker.getRequest(created.id, scope)?.status).toBe("expired");
      broker.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels and clears a request when its owning signal aborts", async () => {
    const controller = new AbortController();
    const broker = new EphemeralSecretBroker({ idFactory: () => "secure_input_1" });
    const created = broker.createRequest({ scope, request: request(), signal: controller.signal });
    broker.provideSecret({ requestId: created.id, scope, value: "cancelled-secret" });

    controller.abort();

    expect(broker.getRequest(created.id, scope)?.status).toBe("cancelled");
    await expect(broker.consume({ requestId: created.id, scope, destination }, () => {}))
      .rejects.toSatisfy((error: unknown) => {
        expectBrokerError(error, "cancelled");
        return true;
      });
  });

  it("clears a value immediately when consumption is cancelled", async () => {
    const consumeController = new AbortController();
    const broker = new EphemeralSecretBroker({ idFactory: () => "secure_input_1" });
    const created = broker.createRequest({ scope, request: request() });
    broker.provideSecret({ requestId: created.id, scope, value: "in-flight-secret" });
    let retainedView: Uint8Array | undefined;

    await expect(broker.consume({
      requestId: created.id,
      scope,
      destination,
      signal: consumeController.signal
    }, async (value) => {
      retainedView = value;
      consumeController.abort();
      await Promise.resolve();
      expect([...value]).toEqual(new Array(value.byteLength).fill(0));
    })).rejects.toSatisfy((error: unknown) => {
      expectBrokerError(error, "cancelled");
      return true;
    });

    expect(retainedView).toBeDefined();
    expect(broker.getRequest(created.id, scope)?.status).toBe("cancelled");
  });

  it("makes consumer failures generic, single-use, and secret-free", async () => {
    const sentinel = "consumer-error-secret";
    const broker = new EphemeralSecretBroker({ idFactory: () => "secure_input_1" });
    const created = broker.createRequest({ scope, request: request() });
    broker.provideSecret({ requestId: created.id, scope, value: sentinel });
    let retainedView: Uint8Array | undefined;

    let observedError: unknown;
    try {
      await broker.consume({ requestId: created.id, scope, destination }, (value) => {
        retainedView = value;
        throw new Error(`Destination echoed ${sentinel}`);
      });
    } catch (error) {
      observedError = error;
    }

    expectBrokerError(observedError, "consumer_failed");
    expect(String(observedError)).not.toContain(sentinel);
    expect(broker.getRequest(created.id, scope)?.status).toBe("consumed");
    expect([...retainedView!]).toEqual(new Array(retainedView!.byteLength).fill(0));
  });

  it("enforces pending-request and value-size bounds", () => {
    let id = 0;
    const broker = new EphemeralSecretBroker({
      idFactory: () => `secure_input_${++id}`,
      maxPendingRequests: 1,
      maxSecretBytes: 4
    });
    const created = broker.createRequest({ scope, request: request() });

    expect(() => broker.createRequest({
      scope: { ...scope, sessionId: "session-b" },
      request: request()
    })).toThrowError(expect.objectContaining({ code: "capacity_exceeded" }));
    expect(() => broker.provideSecret({ requestId: created.id, scope, value: "12345" }))
      .toThrowError(expect.objectContaining({ code: "secret_too_large" }));
    expect(broker.getRequest(created.id, scope)?.status).toBe("awaiting_input");

    broker.cancelRequest(created.id, scope);
    expect(() => broker.createRequest({
      scope: { ...scope, sessionId: "session-b" },
      request: request()
    })).not.toThrow();
  });

  it("rejects unsafe or malformed request metadata", () => {
    const makeBroker = () => new EphemeralSecretBroker({ idFactory: () => "secure_input_1" });
    const invalidRequests: SecureInputRequest[] = [
      request({ purpose: "" }),
      request({ expiresInMs: 0 }),
      request({ expiresInMs: 10 * 60 * 1_000 + 1 }),
      request({
        destination: { ...destination, expectedOrigin: "http://developers.mtn.com" }
      }),
      request({
        destination: {
          type: "process-environment",
          processId: "process-a",
          variableName: "INVALID-NAME"
        }
      }),
      {
        ...request(),
        credential: "must-not-enter-safe-metadata"
      } as SecureInputRequest,
      request({
        destination: {
          ...destination,
          password: "must-not-enter-destination-metadata"
        } as SecureInputDestination
      })
    ];

    for (const invalid of invalidRequests) {
      expect(() => makeBroker().createRequest({ scope, request: invalid }))
        .toThrowError(expect.objectContaining({ code: "invalid_request" }));
    }
  });

  it("bounds retained terminal metadata and clears all state on disposal", () => {
    let id = 0;
    const broker = new EphemeralSecretBroker({
      idFactory: () => `secure_input_${++id}`,
      maxRetainedTerminalRequests: 1
    });
    const first = broker.createRequest({ scope, request: request() });
    broker.cancelRequest(first.id, scope);
    const secondScope = { ...scope, sessionId: "session-b" };
    const second = broker.createRequest({ scope: secondScope, request: request() });
    broker.cancelRequest(second.id, secondScope);

    expect(broker.getRequest(first.id, scope)).toBeUndefined();
    expect(broker.getRequest(second.id, secondScope)?.status).toBe("cancelled");

    broker.dispose();
    expect(broker.stats()).toEqual({
      awaiting_input: 0,
      ready: 0,
      consuming: 0,
      consumed: 0,
      cancelled: 0,
      expired: 0
    });
  });
});
