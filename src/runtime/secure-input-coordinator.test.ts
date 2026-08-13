import { describe, expect, it, vi } from "vitest";
import type {
  SecureInputRequest,
  SecureInputScope
} from "../contracts/secure-input.js";
import { EphemeralSecretBroker } from "../security/ephemeral-secret-broker.js";
import {
  SecureInputTransportRegistry,
  type SecureInputTransport
} from "../security/secure-input-transport-registry.js";
import { SecureInputCoordinator } from "./secure-input-coordinator.js";

const scope: SecureInputScope = {
  profileId: "profile-a",
  sessionId: "session-a",
  userId: "user-a"
};

const request: SecureInputRequest = {
  kind: "password",
  purpose: "Sign in",
  destination: {
    type: "browser-field",
    sessionId: "browser-1",
    tabRef: "tab-1",
    frameId: "main",
    ref: "password-field",
    expectedOrigin: "https://example.com",
    label: "Verified password field"
  },
  retention: "use-once"
};

describe("SecureInputCoordinator", () => {
  it("announces waiting_for_input, re-verifies, delivers once, and returns only a receipt", async () => {
    const broker = brokerWithStableIds();
    const registry = new SecureInputTransportRegistry();
    const transport = browserTransport();
    registry.register(transport);
    const collectedBytes = new TextEncoder().encode("sentinel-secret-value");
    const waitEvents: unknown[] = [];
    const consumer = vi.fn(async (value: Uint8Array) => {
      expect(new TextDecoder().decode(value)).toBe("sentinel-secret-value");
    });
    const coordinator = new SecureInputCoordinator({
      broker,
      transports: registry,
      collect: vi.fn(async () => ({ status: "provided" as const, value: collectedBytes })),
      onWaitStateChange: async (event) => { waitEvents.push(event); }
    });

    const result = await coordinator.createRequestHandler(scope)(request, consumer);

    expect(result).toEqual({
      status: "delivered",
      destinationLabel: "Verified password field",
      persisted: false
    });
    expect(transport.verify).toHaveBeenCalledTimes(2);
    expect(consumer).toHaveBeenCalledOnce();
    expect([...collectedBytes]).toEqual(new Array(collectedBytes.length).fill(0));
    expect(broker.stats().consumed).toBe(1);
    expect(waitEvents).toMatchObject([
      { state: "waiting_for_input", request: { status: "awaiting_input" } },
      { state: "input_resolved", request: { status: "consumed" } }
    ]);
    expect(JSON.stringify({ result, waitEvents })).not.toContain("sentinel-secret-value");
    broker.dispose();
  });

  it("blocks destination redirection after collection and clears the collected bytes", async () => {
    const broker = brokerWithStableIds();
    const registry = new SecureInputTransportRegistry();
    const verify = vi.fn(({ request: candidate, phase }) => ({
      status: "verified" as const,
      destination: phase === "before-collection"
        ? candidate.destination
        : { ...candidate.destination, ref: "attacker-field" }
    }));
    registry.register(browserTransport({ verify }));
    const collectedBytes = new TextEncoder().encode("redirect-sentinel");
    const consumer = vi.fn();
    const coordinator = new SecureInputCoordinator({
      broker,
      transports: registry,
      collect: async () => ({ status: "provided", value: collectedBytes })
    });

    const result = await coordinator.request({ scope, request, consume: consumer });

    expect(result).toMatchObject({ status: "failed", persisted: false });
    expect(consumer).not.toHaveBeenCalled();
    expect([...collectedBytes]).toEqual(new Array(collectedBytes.length).fill(0));
    expect(broker.stats().cancelled).toBe(1);
    expect(JSON.stringify(result)).not.toContain("redirect-sentinel");
    broker.dispose();
  });

  it("blocks a transport replay and invalidates the broker request", async () => {
    const broker = brokerWithStableIds();
    const registry = new SecureInputTransportRegistry();
    registry.register(browserTransport({
      deliver: async ({ value, context, consume }) => {
        await consume(value, context);
        await consume(value, context);
      }
    }));
    const consumer = vi.fn(async () => undefined);
    const coordinator = new SecureInputCoordinator({
      broker,
      transports: registry,
      collect: async () => ({
        status: "provided",
        value: new TextEncoder().encode("replay-sentinel")
      })
    });

    const result = await coordinator.request({ scope, request, consume: consumer });

    expect(result.status).toBe("failed");
    expect(consumer).toHaveBeenCalledOnce();
    expect(broker.stats().consumed).toBe(1);
    broker.dispose();
  });

  it("blocks a transport from substituting another value", async () => {
    const broker = brokerWithStableIds();
    const registry = new SecureInputTransportRegistry();
    registry.register(browserTransport({
      deliver: async ({ context, consume }) => {
        await consume(new TextEncoder().encode("substituted-value"), context);
      }
    }));
    const consumer = vi.fn(async () => undefined);
    const coordinator = new SecureInputCoordinator({
      broker,
      transports: registry,
      collect: async () => ({
        status: "provided",
        value: new TextEncoder().encode("original-value")
      })
    });

    const result = await coordinator.request({ scope, request, consume: consumer });

    expect(result.status).toBe("failed");
    expect(consumer).not.toHaveBeenCalled();
    expect(broker.stats().consumed).toBe(1);
    broker.dispose();
  });

  it("does not collect when policy approval is unavailable", async () => {
    const broker = brokerWithStableIds();
    const registry = new SecureInputTransportRegistry();
    registry.register(browserTransport({ requiresApproval: true }));
    const collect = vi.fn();
    const coordinator = new SecureInputCoordinator({ broker, transports: registry, collect });

    const result = await coordinator.request({ scope, request, consume: vi.fn() });

    expect(result).toMatchObject({ status: "failed", persisted: false });
    expect(collect).not.toHaveBeenCalled();
    expect(broker.stats().awaiting_input).toBe(0);
    broker.dispose();
  });

  it("cancels the bound request without invoking delivery", async () => {
    const broker = brokerWithStableIds();
    const registry = new SecureInputTransportRegistry();
    registry.register(browserTransport());
    const consumer = vi.fn();
    const coordinator = new SecureInputCoordinator({
      broker,
      transports: registry,
      collect: async () => ({ status: "cancelled" })
    });

    const result = await coordinator.request({ scope, request, consume: consumer });

    expect(result.status).toBe("cancelled");
    expect(consumer).not.toHaveBeenCalled();
    expect(broker.stats().cancelled).toBe(1);
    broker.dispose();
  });
});

function brokerWithStableIds(): EphemeralSecretBroker {
  let next = 0;
  return new EphemeralSecretBroker({ idFactory: () => `request-${++next}` });
}

function browserTransport(overrides: Partial<SecureInputTransport> = {}): SecureInputTransport {
  return {
    id: "local-browser-field",
    destinationTypes: ["browser-field"],
    priority: 100,
    verificationStrength: "field-bound",
    persistence: "none",
    disclosureBoundary: "destination",
    requiresApproval: false,
    isAvailable: () => true,
    verify: vi.fn(({ request: candidate }) => ({
      status: "verified" as const,
      destination: candidate.destination
    })),
    deliver: async ({ value, context, consume }) => await consume(value, context),
    ...overrides
  };
}
