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
import {
  ProtectedBrowserValueSourceError,
  type ProtectedBrowserValueSource
} from "../security/protected-browser-value-source.js";
import { ProtectedBrowserFieldError } from "../browser/protected-browser-field.js";
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
  destination: { type: "tool-argument", toolName: "trusted.updateRecords", argumentPath: "/values/0/value" },
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

  it("returns a bounded incompatibility reason without exposing the rejected value", async () => {
    const broker = brokerWithStableIds();
    const registry = new SecureInputTransportRegistry();
    const collected = new TextEncoder().encode("731942");
    registry.register(browserTransport({
      deliver: async () => {
        throw new ProtectedBrowserFieldError(
          "protected-field-value-incompatible",
          "Protected value is incompatible with the verified browser destination."
        );
      },
    }));
    const coordinator = new SecureInputCoordinator({
      broker,
      transports: registry,
      collect: async () => ({ status: "provided", value: collected }),
    });

    const result = await coordinator.createRequestHandler(scope).requestGroup({
      purpose: "Sign in",
      items: [{
        id: "account",
        request: { ...request, kind: "account-identifier" },
        consume: vi.fn(),
      }],
    });

    expect(result).toMatchObject({
      status: "failed",
      reason: "Protected input delivery failed: destination-value-incompatible.",
    });
    expect(JSON.stringify(result)).not.toContain("731942");
    expect([...collected]).toEqual(new Array(collected.length).fill(0));
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
      destinationLabel: "/values/0/value for trusted.updateRecords",
      persisted: false,
    });
    expect(collect).not.toHaveBeenCalled();
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({
      destinationLabel: "/values/0/value for trusted.updateRecords",
      transfer: {
        sourceLabel: "Browser value at https://portal.example.com",
        credentialLabel: "client secret",
        persistence: "none",
        sharing: "unknown",
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

  it("returns a bounded source reason when a single protected transfer cannot start", async () => {
    const broker = brokerWithStableIds();
    const registry = new SecureInputTransportRegistry();
    const deliver = vi.fn();
    registry.register(browserTransport({
      destinationTypes: ["tool-argument"],
      verificationStrength: "declared-target",
      deliver,
    }));
    const source = browserValueSource({
      prepare: vi.fn(async () => {
        throw new ProtectedBrowserValueSourceError("source-empty", "before-authorization");
      }),
    });
    const authorize = vi.fn(async () => "approved" as const);
    const consume = vi.fn();
    const coordinator = new SecureInputCoordinator({
      broker,
      transports: registry,
      collect: vi.fn(),
      browserSource: source,
      authorize,
    });

    const result = await coordinator.createRequestHandler(scope).transfer({
      source: browserSource,
      request: toolRequest,
    }, consume);

    expect(result).toEqual({
      status: "failed",
      destinationLabel: "/values/0/value for trusted.updateRecords",
      persisted: false,
      reason: "Protected transfer could not start:\n- source: source-empty",
      failure: {
        code: "protected-source-validation",
        phase: "before-authorization",
        sources: [{ id: "source", reason: "source-empty" }],
      },
    });
    expect(authorize).not.toHaveBeenCalled();
    expect(source.reverify).not.toHaveBeenCalled();
    expect(source.read).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("portal.example.com");
    broker.dispose();
  });

  it("authorizes once and exposes every grouped browser value only during one atomic consumer", async () => {
    const broker = brokerWithStableIds();
    const registry = new SecureInputTransportRegistry();
    const events: string[] = [];
    registry.register(browserTransport({
      destinationTypes: ["tool-argument"],
      verificationStrength: "declared-target",
      verify: vi.fn(({ request: candidate, phase }) => {
        events.push(`verify:${phase}:${candidate.destination.type === "tool-argument" ? candidate.destination.argumentPath : "unknown"}`);
        return { status: "verified" as const, destination: candidate.destination };
      }),
      deliver: async ({ value, context, consume }) => {
        events.push(`deliver:${context.request.kind}`);
        await consume(value, context);
      },
    }));
    const sourceBytes = [
      new TextEncoder().encode("group-source-key"),
      new TextEncoder().encode("group-source-secret"),
    ];
    let readIndex = 0;
    const source = browserValueSource({
      prepare: vi.fn(async ({ source: candidate }) => ({
        source: structuredClone(candidate),
        label: `Browser value ${candidate.ref} at ${candidate.expectedOrigin}`,
      })),
      read: vi.fn(async ({ verified }) => {
        events.push(`read:${verified.source.ref}`);
        return sourceBytes[readIndex++]!;
      }),
    });
    const authorize = vi.fn(async () => "approved" as const);
    const consume = vi.fn(async (values: readonly { id: string; value: Uint8Array }[]) => {
      events.push("dispatch");
      expect(values.map((entry) => new TextDecoder().decode(entry.value))).toEqual([
        "group-source-key",
        "group-source-secret",
      ]);
    });
    const coordinator = new SecureInputCoordinator({
      broker,
      transports: registry,
      collect: vi.fn(),
      browserSource: source,
      authorize,
    });
    const secondSource = { ...browserSource, ref: "@e3" };
    const secondRequest: SecureInputRequest = {
      ...toolRequest,
      kind: "api-key",
      destination: { type: "tool-argument", toolName: "trusted.updateRecords", argumentPath: "/values/1/value" },
    };

    const result = await coordinator.createRequestHandler(scope).transferGroup({
      purpose: "Configure two protected destination values",
      items: [
        {
          id: "client-key",
          source: browserSource,
          request: toolRequest,
          handling: { persistence: "destination-managed", sharing: "workspace" },
        },
        {
          id: "client-secret",
          source: secondSource,
          request: secondRequest,
          handling: { persistence: "destination-managed", sharing: "workspace" },
        },
      ],
    }, consume);

    expect(result.status).toBe("delivered");
    expect(result.items).toHaveLength(2);
    expect(result.items.every((item) => item.receipt.persisted)).toBe(true);
    expect(authorize).toHaveBeenCalledOnce();
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({
      transferGroup: expect.objectContaining({
        purpose: "Configure two protected destination values",
        items: expect.arrayContaining([
          expect.objectContaining({ persistence: "destination-managed", sharing: "workspace" }),
        ]),
      }),
    }));
    expect(events.filter((event) => event.startsWith("read:"))).toHaveLength(2);
    expect(events.indexOf("dispatch")).toBeGreaterThan(events.lastIndexOf("read:@e3"));
    expect(consume).toHaveBeenCalledOnce();
    expect(sourceBytes.every((value) => value.every((byte) => byte === 0))).toBe(true);
    expect(source.release).toHaveBeenCalledTimes(2);
    expect(broker.stats().consumed).toBe(2);
    broker.dispose();
  });

  it("reports every grouped source rejection before authorization, reading, or dispatch", async () => {
    const broker = brokerWithStableIds();
    const registry = new SecureInputTransportRegistry();
    const deliver = vi.fn();
    registry.register(browserTransport({
      destinationTypes: ["tool-argument"],
      verificationStrength: "declared-target",
      deliver,
    }));
    const source = browserValueSource({
      prepare: vi.fn(async ({ source: candidate }) => {
        throw new ProtectedBrowserValueSourceError(
          candidate.ref === "@e2" ? "source-empty" : "source-replaced",
          "before-authorization"
        );
      })
    });
    const authorize = vi.fn(async () => "approved" as const);
    const consume = vi.fn();
    const coordinator = new SecureInputCoordinator({
      broker,
      transports: registry,
      collect: vi.fn(),
      browserSource: source,
      authorize,
    });

    const result = await coordinator.createRequestHandler(scope).transferGroup({
      purpose: "Validate both protected values",
      items: [
        { id: "argument-1", source: browserSource, request: toolRequest },
        {
          id: "argument-2",
          source: { ...browserSource, ref: "@e3" },
          request: {
            ...toolRequest,
            destination: { type: "tool-argument", toolName: "trusted.updateRecords", argumentPath: "/values/1/value" },
          },
        },
      ],
    }, consume);

    expect(result).toEqual({
      status: "failed",
      items: [
        expect.objectContaining({ id: "argument-1", receipt: expect.objectContaining({ status: "failed" }) }),
        expect.objectContaining({ id: "argument-2", receipt: expect.objectContaining({ status: "failed" }) }),
      ],
      reason: "Protected transfer could not start:\n- argument-1: source-empty\n- argument-2: source-replaced",
      failure: {
        code: "protected-source-validation",
        phase: "before-authorization",
        sources: [
          { id: "argument-1", reason: "source-empty" },
          { id: "argument-2", reason: "source-replaced" },
        ],
      },
    });
    expect(source.prepare).toHaveBeenCalledTimes(2);
    expect(authorize).not.toHaveBeenCalled();
    expect(source.reverify).not.toHaveBeenCalled();
    expect(source.read).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("portal.example.com");
    broker.dispose();
  });

  it("releases an acquired binding when another grouped source fails initial validation", async () => {
    const broker = brokerWithStableIds();
    const registry = new SecureInputTransportRegistry();
    const deliver = vi.fn();
    registry.register(browserTransport({
      destinationTypes: ["tool-argument"],
      verificationStrength: "declared-target",
      deliver,
    }));
    const source = browserValueSource({
      prepare: vi.fn(async ({ source: candidate }) => {
        if (candidate.ref === "@e3") {
          throw new ProtectedBrowserValueSourceError("source-empty", "before-authorization");
        }
        return { source: structuredClone(candidate), label: "Bound browser value" };
      }),
    });
    const authorize = vi.fn(async () => "approved" as const);
    const coordinator = new SecureInputCoordinator({
      broker,
      transports: registry,
      collect: vi.fn(),
      browserSource: source,
      authorize,
    });

    const result = await coordinator.createRequestHandler(scope).transferGroup({
      purpose: "Validate two protected values",
      items: [
        { id: "argument-1", source: browserSource, request: toolRequest },
        {
          id: "argument-2",
          source: { ...browserSource, ref: "@e3" },
          request: {
            ...toolRequest,
            destination: { type: "tool-argument", toolName: "trusted.updateRecords", argumentPath: "/values/1/value" },
          },
        },
      ],
    }, vi.fn());

    expect(result).toMatchObject({
      status: "failed",
      failure: {
        code: "protected-source-validation",
        phase: "before-authorization",
        sources: [{ id: "argument-2", reason: "source-empty" }],
      },
    });
    expect(authorize).not.toHaveBeenCalled();
    expect(source.read).not.toHaveBeenCalled();
    expect(source.release).toHaveBeenCalledOnce();
    expect(source.release).toHaveBeenCalledWith(browserSource);
    expect(deliver).not.toHaveBeenCalled();
    broker.dispose();
  });

  it("re-verifies every grouped source before reading any value and releases acquired bindings", async () => {
    const broker = brokerWithStableIds();
    const registry = new SecureInputTransportRegistry();
    const deliver = vi.fn();
    registry.register(browserTransport({
      destinationTypes: ["tool-argument"],
      verificationStrength: "declared-target",
      deliver,
    }));
    const source = browserValueSource({
      reverify: vi.fn(async ({ verified }) => {
        throw new ProtectedBrowserValueSourceError(
          verified.source.ref === "@e2" ? "tab-mismatch" : "source-replaced",
          "before-delivery"
        );
      })
    });
    const authorize = vi.fn(async () => "approved" as const);
    const consume = vi.fn();
    const coordinator = new SecureInputCoordinator({
      broker,
      transports: registry,
      collect: vi.fn(),
      browserSource: source,
      authorize,
    });

    const result = await coordinator.createRequestHandler(scope).transferGroup({
      purpose: "Reverify both protected values",
      items: [
        { id: "argument-1", source: browserSource, request: toolRequest },
        {
          id: "argument-2",
          source: { ...browserSource, ref: "@e3" },
          request: {
            ...toolRequest,
            destination: { type: "tool-argument", toolName: "trusted.updateRecords", argumentPath: "/values/1/value" },
          },
        },
      ],
    }, consume);

    expect(result).toMatchObject({
      status: "failed",
      reason: "Protected transfer could not continue:\n- argument-1: tab-mismatch\n- argument-2: source-replaced",
      failure: {
        code: "protected-source-validation",
        phase: "before-delivery",
        sources: [
          { id: "argument-1", reason: "tab-mismatch" },
          { id: "argument-2", reason: "source-replaced" },
        ],
      },
    });
    expect(authorize).toHaveBeenCalledOnce();
    expect(source.reverify).toHaveBeenCalledTimes(2);
    expect(source.read).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(source.release).toHaveBeenCalledTimes(2);
    expect(broker.stats().ready).toBe(0);
    broker.dispose();
  });

  it("clears earlier temporary bytes when a final grouped source read check is rejected", async () => {
    const broker = brokerWithStableIds();
    const registry = new SecureInputTransportRegistry();
    const deliver = vi.fn();
    registry.register(browserTransport({
      destinationTypes: ["tool-argument"],
      verificationStrength: "declared-target",
      deliver,
    }));
    const firstBytes = new TextEncoder().encode("temporary-source-sentinel");
    const source = browserValueSource({
      read: vi.fn(async ({ verified }) => {
        if (verified.source.ref === "@e2") return firstBytes;
        throw new ProtectedBrowserValueSourceError("source-replaced", "before-delivery");
      })
    });
    const consume = vi.fn();
    const coordinator = new SecureInputCoordinator({
      broker,
      transports: registry,
      collect: vi.fn(),
      browserSource: source,
      authorize: async () => "approved",
    });

    const result = await coordinator.createRequestHandler(scope).transferGroup({
      purpose: "Read two protected values atomically",
      items: [
        { id: "argument-1", source: browserSource, request: toolRequest },
        {
          id: "argument-2",
          source: { ...browserSource, ref: "@e3" },
          request: {
            ...toolRequest,
            destination: { type: "tool-argument", toolName: "trusted.updateRecords", argumentPath: "/values/1/value" },
          },
        },
      ],
    }, consume);

    expect(result).toMatchObject({
      status: "failed",
      reason: "Protected transfer could not continue:\n- argument-2: source-replaced",
      failure: {
        code: "protected-source-validation",
        phase: "before-delivery",
        sources: [{ id: "argument-2", reason: "source-replaced" }],
      },
    });
    expect(firstBytes.every((byte) => byte === 0)).toBe(true);
    expect(broker.stats().cancelled).toBe(1);
    expect(consume).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(source.release).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain("temporary-source-sentinel");
    broker.dispose();
  });

  it("does not dispatch a grouped transfer when one destination drifts after source reads", async () => {
    const broker = brokerWithStableIds();
    const registry = new SecureInputTransportRegistry();
    let verifications = 0;
    const deliver = vi.fn();
    registry.register(browserTransport({
      destinationTypes: ["tool-argument"],
      verificationStrength: "declared-target",
      verify: vi.fn(({ request: candidate }) => ({
        status: "verified" as const,
        destination: ++verifications === 6
          ? { ...candidate.destination, argumentPath: "/attacker" }
          : candidate.destination,
      })),
      deliver,
    }));
    const bytes = [new TextEncoder().encode("first-group-value"), new TextEncoder().encode("second-group-value")];
    let readIndex = 0;
    const source = browserValueSource({ read: vi.fn(async () => bytes[readIndex++]!) });
    const coordinator = new SecureInputCoordinator({
      broker,
      transports: registry,
      collect: vi.fn(),
      browserSource: source,
      authorize: async () => "approved",
    });
    const consume = vi.fn();
    const result = await coordinator.createRequestHandler(scope).transferGroup({
      purpose: "Atomic protected update",
      items: [
        { id: "first", source: browserSource, request: toolRequest },
        {
          id: "second",
          source: { ...browserSource, ref: "@e3" },
          request: {
            ...toolRequest,
            destination: { type: "tool-argument", toolName: "trusted.updateRecords", argumentPath: "/values/1/value" },
          },
        },
      ],
    }, consume);

    expect(result.status).toBe("failed");
    expect(consume).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(bytes.every((value) => value.every((byte) => byte === 0))).toBe(true);
    broker.dispose();
  });

  it("reads no grouped source and performs no delivery when the single approval is denied", async () => {
    const broker = brokerWithStableIds();
    const registry = new SecureInputTransportRegistry();
    const deliver = vi.fn();
    registry.register(browserTransport({
      destinationTypes: ["tool-argument"],
      verificationStrength: "declared-target",
      deliver,
    }));
    const source = browserValueSource();
    const authorize = vi.fn(async () => "denied" as const);
    const coordinator = new SecureInputCoordinator({
      broker,
      transports: registry,
      collect: vi.fn(),
      browserSource: source,
      authorize,
    });
    const result = await coordinator.createRequestHandler(scope).transferGroup({
      purpose: "Denied atomic update",
      items: [
        { id: "first", source: browserSource, request: toolRequest },
        {
          id: "second",
          source: { ...browserSource, ref: "@e3" },
          request: {
            ...toolRequest,
            destination: { type: "tool-argument", toolName: "trusted.updateRecords", argumentPath: "/values/1/value" },
          },
        },
      ],
    }, vi.fn());

    expect(result.status).toBe("failed");
    expect(authorize).toHaveBeenCalledOnce();
    expect(source.read).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
    expect(source.release).toHaveBeenCalledTimes(2);
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

describe("atomic grouped user credential collection", () => {
  it.each(["approved", "denied"] as const)("honors one coordinated %s policy decision before collecting", async (decision) => {
    const broker = brokerWithStableIds();
    const registry = new SecureInputTransportRegistry();
    registry.register(browserTransport({ destinationTypes: ["tool-argument"],
      verificationStrength: "declared-target", requiresApproval: true }));
    const authorize = vi.fn<NonNullable<ConstructorParameters<typeof SecureInputCoordinator>[0]["authorize"]>>(async () => decision);
    const collect = vi.fn(async () => ({ status: "provided" as const, value: new TextEncoder().encode("fixture-secret") }));
    const consume = vi.fn();
    const coordinator = new SecureInputCoordinator({ broker, transports: registry, authorize, collect });
    const result = await coordinator.createRequestHandler(scope).collectGroup({
      purpose: "Configure credentials",
      items: [0, 1].map((index) => ({ id: `argument-${index}`, request: { ...toolRequest,
        destination: { type: "tool-argument", toolName: "trusted.updateRecords", argumentPath: `/values/${index}/value` }
      } }))
    }, consume);
    expect(authorize).toHaveBeenCalledOnce();
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ assessment: { decision: "ask", reason: "transport-requires-approval" },
      transferGroup: expect.objectContaining({ items: expect.any(Array) }) }));
    expect(authorize.mock.calls[0]?.[0].transferGroup?.items).toHaveLength(2);
    expect(collect).toHaveBeenCalledTimes(decision === "approved" ? 2 : 0);
    expect(consume).toHaveBeenCalledTimes(decision === "approved" ? 1 : 0);
    expect(result.status).toBe(decision === "approved" ? "delivered" : "failed");
    broker.dispose();
  });

  it.each(["success", "cancel", "dispatch-failure", "abort"])("handles %s without early destination writes or retained secrets", async (outcome) => {
    const broker = brokerWithStableIds();
    const registry = new SecureInputTransportRegistry();
    registry.register(browserTransport({ destinationTypes: ["tool-argument"], verificationStrength: "declared-target" }));
    const values = [new TextEncoder().encode("fixture-key"), new TextEncoder().encode("fixture-secret")];
    const controller = new AbortController();
    const delivered: Uint8Array[] = [];
    let collected = 0;
    const consume = vi.fn(async (group: readonly { value: Uint8Array }[]) => {
      expect(collected).toBe(2);
      delivered.push(...group.map((entry) => entry.value));
      expect(group.map((entry) => new TextDecoder().decode(entry.value))).toEqual(["fixture-key", "fixture-secret"]);
      if (outcome === "dispatch-failure") throw new Error("fixture-key must never escape");
    });
    const coordinator = new SecureInputCoordinator({ broker, transports: registry,
      authorize: async () => "approved",
      collect: async (_request, _signal, context) => {
        expect(consume).not.toHaveBeenCalled();
        expect(context.group).toMatchObject({ index: collected + 1, total: 2 });
        const value = values[collected++]!;
        if (collected === 2 && outcome === "cancel") return { status: "cancelled" };
        if (collected === 2 && outcome === "abort") controller.abort();
        return { status: "provided", value };
      }
    });
    const result = await coordinator.createRequestHandler(scope, controller.signal).collectGroup({
      purpose: "Configure related credentials",
      items: [0, 1].map((index) => ({ id: `argument-${index}`, request: { ...toolRequest,
        destination: { type: "tool-argument", toolName: "trusted.updateRecords", argumentPath: `/values/${index}/value` }
      } }))
    }, consume);
    expect(result.status).toBe(outcome === "success" ? "delivered" : outcome === "dispatch-failure" ? "failed" : "cancelled");
    expect(consume).toHaveBeenCalledTimes(outcome === "success" || outcome === "dispatch-failure" ? 1 : 0);
    expect(values[0]!.every((byte) => byte === 0)).toBe(true);
    expect(delivered.every((value) => value.every((byte) => byte === 0))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/fixture-key|fixture-secret/);
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
    reverify: vi.fn(async () => undefined),
    read: vi.fn(async () => new TextEncoder().encode("source-value")),
    release: vi.fn(async () => undefined),
    ...overrides,
  };
}
