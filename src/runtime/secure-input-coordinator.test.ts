import { describe, expect, it, vi } from "vitest";
import type {
  BrowserFieldSecureInputDestination,
  BrowserFieldSecureInputSource,
  SecureInputRequest,
  SecureInputScope
} from "../contracts/secure-input.js";
import { EphemeralSecretBroker } from "../security/ephemeral-secret-broker.js";
import {
  SecureInputTransportRegistry,
  type SecureInputTransport
} from "../security/secure-input-transport-registry.js";
import type { ProtectedBrowserValueSource } from "../security/protected-browser-value-source.js";
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
const browserDestination = request.destination as BrowserFieldSecureInputDestination;
const browserSource: BrowserFieldSecureInputSource = {
  type: "browser-field",
  sessionId: "browser-1",
  ref: "@e2",
  identity: { documentEpoch: 2, actionRevision: 4, observationId: 8 },
  expectedOrigin: "https://portal.example.com",
  tabRef: "@t1",
  frameId: "main",
};
const toolRequest: SecureInputRequest = {
  kind: "client-secret",
  purpose: "Configure the destination",
  destination: { type: "tool-argument", toolName: "postman.updateEnvironment", argumentPath: "value" },
  retention: "use-once",
};

describe("SecureInputCoordinator", () => {
  it("announces waiting_for_input, re-verifies, delivers once, and returns only a receipt", async () => {
    const broker = brokerWithStableIds();
    const registry = new SecureInputTransportRegistry();
    const release = vi.fn(async () => undefined);
    const transport = browserTransport({ release });
    registry.register(transport);
    const collectedBytes = new TextEncoder().encode("sentinel-secret-value");
    const collect = vi.fn(async () => ({ status: "provided" as const, value: collectedBytes }));
    const waitEvents: unknown[] = [];
    const consumer = vi.fn(async (value: Uint8Array) => {
      expect(new TextDecoder().decode(value)).toBe("sentinel-secret-value");
    });
    const coordinator = new SecureInputCoordinator({
      broker,
      transports: registry,
      collect,
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
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(request);
    expect(collect).toHaveBeenCalledWith(
      expect.objectContaining({ status: "awaiting_input" }),
      expect.any(AbortSignal),
      { verifiedDestinationLabel: "Verified password field" }
    );
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

  it("binds and re-verifies every grouped destination before delivering any field", async () => {
    const broker = brokerWithStableIds();
    const registry = new SecureInputTransportRegistry();
    const events: string[] = [];
    const transport = browserTransport({
      verify: vi.fn(({ request: candidate, phase }) => {
        events.push(`${phase}:${candidate.kind}`);
        return { status: "verified" as const, destination: candidate.destination };
      }),
      deliver: async ({ value, context, consume }) => {
        events.push(`deliver:${context.request.kind}`);
        await consume(value, context);
      }
    });
    registry.register(transport);
    const collected = [
      new TextEncoder().encode("person@example.com"),
      new TextEncoder().encode("group-password-sentinel")
    ];
    let collectIndex = 0;
    const collect = vi.fn(async (_snapshot, _signal, context) => {
      events.push(`collect:${context.group?.index}/${context.group?.total}`);
      return { status: "provided" as const, value: collected[collectIndex++]! };
    });
    const accountRequest: SecureInputRequest = {
      ...request,
      kind: "account-identifier",
      purpose: "Enter account email",
      destination: { ...browserDestination, ref: "account-field", label: "Verified account field" }
    };
    const passwordConsumer = vi.fn(async () => undefined);
    const accountConsumer = vi.fn(async () => undefined);
    const coordinator = new SecureInputCoordinator({ broker, transports: registry, collect });
    const handler = coordinator.createRequestHandler(scope);

    const result = await handler.requestGroup({
      purpose: "Sign in",
      items: [
        { id: "account", request: accountRequest, consume: accountConsumer },
        { id: "password", request, consume: passwordConsumer }
      ]
    });

    expect(result.status).toBe("delivered");
    expect(result.items.map((item) => item.id)).toEqual(["account", "password"]);
    expect(events).toEqual([
      "before-collection:account-identifier",
      "before-collection:password",
      "collect:1/2",
      "collect:2/2",
      "before-delivery:account-identifier",
      "before-delivery:password",
      "deliver:account-identifier",
      "deliver:password"
    ]);
    expect(accountConsumer).toHaveBeenCalledOnce();
    expect(passwordConsumer).toHaveBeenCalledOnce();
    expect(collected.every((value) => value.every((byte) => byte === 0))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("group-password-sentinel");
    broker.dispose();
  });

  it("cancels the complete group when one field is cancelled", async () => {
    const broker = brokerWithStableIds();
    const registry = new SecureInputTransportRegistry();
    const deliver = vi.fn();
    registry.register(browserTransport({ deliver }));
    let calls = 0;
    const first = new TextEncoder().encode("first-group-sentinel");
    const coordinator = new SecureInputCoordinator({
      broker,
      transports: registry,
      collect: async () => ++calls === 1
        ? { status: "provided", value: first }
        : { status: "cancelled" }
    });

    const result = await coordinator.createRequestHandler(scope).requestGroup({
      purpose: "Sign in",
      items: [
        { id: "account", request: { ...request, kind: "account-identifier", destination: { ...browserDestination, ref: "account" } }, consume: vi.fn() },
        { id: "password", request, consume: vi.fn() }
      ]
    });

    expect(result.status).toBe("cancelled");
    expect(deliver).not.toHaveBeenCalled();
    expect([...first]).toEqual(new Array(first.length).fill(0));
    expect(broker.stats().cancelled).toBe(2);
    broker.dispose();
  });

  it("aborts the complete transport group after partial delivery and reports unverifiable clearing precisely", async () => {
    const broker = brokerWithStableIds();
    const registry = new SecureInputTransportRegistry();
    let deliveries = 0;
    const abort = vi.fn(async (requests: readonly SecureInputRequest[]) => {
      expect(requests.map((candidate) => candidate.kind)).toEqual(["account-identifier", "password"]);
      throw new Error("clear verification failed");
    });
    registry.register(browserTransport({
      deliver: async ({ value, context, consume }) => {
        if (++deliveries === 2) throw new Error("second field rejected delivery");
        await consume(value, context);
      },
      abort,
    }));
    const values = [new TextEncoder().encode("person@example.com"), new TextEncoder().encode("password-sentinel")];
    let index = 0;
    const coordinator = new SecureInputCoordinator({
      broker,
      transports: registry,
      collect: async () => ({ status: "provided", value: values[index++]! }),
    });

    const result = await coordinator.createRequestHandler(scope).requestGroup({
      purpose: "Sign in",
      items: [
        { id: "account", request: { ...request, kind: "account-identifier", destination: { ...browserDestination, ref: "account" } }, consume: vi.fn() },
        { id: "password", request, consume: vi.fn() },
      ],
    });

    expect(abort).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      status: "failed",
      reason: "Protected input delivery failed and clearing could not be verified. The destination remains protected; review it locally before retrying.",
    });
    expect(values.every((value) => value.every((byte) => byte === 0))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("person@example.com");
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

  it("relays a verified browser value through the broker after one metadata-only approval", async () => {
    const broker = brokerWithStableIds();
    const registry = new SecureInputTransportRegistry();
    const transport = browserTransport({
      destinationTypes: ["tool-argument"],
      verificationStrength: "declared-target",
    });
    registry.register(transport);
    const sourceBytes = new TextEncoder().encode("browser-source-sentinel");
    const source = browserValueSource({ read: vi.fn(async () => sourceBytes) });
    const collect = vi.fn();
    const authorize = vi.fn(async () => "approved" as const);
    const consumer = vi.fn(async (value: Uint8Array) => {
      expect(new TextDecoder().decode(value)).toBe("browser-source-sentinel");
    });
    const coordinator = new SecureInputCoordinator({
      broker,
      transports: registry,
      collect,
      browserSource: source,
      authorize,
    });

    const result = await coordinator.createRequestHandler(scope).transfer({
      source: browserSource,
      request: toolRequest,
    }, consumer);

    expect(result).toEqual({
      status: "delivered",
      destinationLabel: "value for postman.updateEnvironment",
      persisted: false,
    });
    expect(collect).not.toHaveBeenCalled();
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({
      destinationLabel: "value for postman.updateEnvironment",
      transfer: {
        sourceLabel: "Browser value at https://portal.example.com",
        credentialLabel: "client secret",
        persistence: "none",
        disclosureBoundary: "destination",
      },
    }));
    expect(consumer).toHaveBeenCalledOnce();
    expect(source.release).toHaveBeenCalledWith(browserSource);
    expect(sourceBytes.every((byte) => byte === 0)).toBe(true);
    expect(JSON.stringify({ result, authorization: authorize.mock.calls })).not.toContain("browser-source-sentinel");
    broker.dispose();
  });

  it("does not read or dispatch a browser value when transfer approval is denied", async () => {
    const broker = brokerWithStableIds();
    const registry = new SecureInputTransportRegistry();
    const deliver = vi.fn();
    registry.register(browserTransport({
      destinationTypes: ["tool-argument"],
      verificationStrength: "declared-target",
      deliver,
    }));
    const source = browserValueSource();
    const coordinator = new SecureInputCoordinator({
      broker,
      transports: registry,
      collect: vi.fn(),
      browserSource: source,
      authorize: async () => "denied",
    });

    const result = await coordinator.createRequestHandler(scope).transfer({
      source: browserSource,
      request: toolRequest,
    }, vi.fn());

    expect(result).toMatchObject({ status: "failed", reason: "Protected transfer was not authorized." });
    expect(source.read).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(broker.stats().ready).toBe(0);
    expect(source.release).toHaveBeenCalledOnce();
    broker.dispose();
  });

  it("fails closed and clears bytes when the destination changes after browser read", async () => {
    const broker = brokerWithStableIds();
    const registry = new SecureInputTransportRegistry();
    let verifications = 0;
    const deliver = vi.fn();
    registry.register(browserTransport({
      destinationTypes: ["tool-argument"],
      verificationStrength: "declared-target",
      verify: vi.fn(({ request: candidate }) => ({
        status: "verified" as const,
        destination: ++verifications < 3
          ? candidate.destination
          : { ...candidate.destination, argumentPath: "attacker" },
      })),
      deliver,
    }));
    const sourceBytes = new TextEncoder().encode("changed-destination-sentinel");
    const source = browserValueSource({ read: vi.fn(async () => sourceBytes) });
    const coordinator = new SecureInputCoordinator({
      broker,
      transports: registry,
      collect: vi.fn(),
      browserSource: source,
      authorize: async () => "approved",
    });

    const result = await coordinator.createRequestHandler(scope).transfer({
      source: browserSource,
      request: toolRequest,
    }, vi.fn());

    expect(result.status).toBe("failed");
    expect(deliver).not.toHaveBeenCalled();
    expect(sourceBytes.every((byte) => byte === 0)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("changed-destination-sentinel");
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

function browserValueSource(overrides: Partial<ProtectedBrowserValueSource> = {}): ProtectedBrowserValueSource {
  return {
    prepare: vi.fn(async ({ source }) => ({
      source: structuredClone(source),
      label: "Browser value at https://portal.example.com",
    })),
    read: vi.fn(async () => new TextEncoder().encode("source-value")),
    release: vi.fn(async () => undefined),
    ...overrides,
  };
}
