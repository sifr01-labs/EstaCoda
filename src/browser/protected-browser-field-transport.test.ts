import { describe, expect, it, vi } from "vitest";
import type { BrowserBackend, BrowserProtectedFieldVerification } from "../contracts/browser.js";
import type { BrowserFieldSecureInputDestination, SecureInputRequest } from "../contracts/secure-input.js";
import { SecureInputCoordinator } from "../runtime/secure-input-coordinator.js";
import { EphemeralSecretBroker } from "../security/ephemeral-secret-broker.js";
import { SecureInputTransportRegistry } from "../security/secure-input-transport-registry.js";
import { createProtectedBrowserFieldTransport } from "./protected-browser-field-transport.js";

const destination: BrowserFieldSecureInputDestination = {
  type: "browser-field",
  sessionId: "browser-session",
  ref: "@e1",
  identity: { documentEpoch: 1, actionRevision: 1, observationId: 1 },
  expectedOrigin: "https://example.com",
  tabRef: "@t1",
  frameId: "main-frame",
};

const request: SecureInputRequest = {
  kind: "password",
  purpose: "Sign in",
  destination,
  retention: "use-once",
};

describe("protected browser field transport", () => {
  it("coordinates two-phase verification, local delivery, and guard release without returning the value", async () => {
    const phases: string[] = [];
    const delivered: string[] = [];
    const releaseProtectedField = vi.fn(async () => undefined);
    const backend = localBackend({
      verifyProtectedField: async (input) => {
        phases.push(input.phase);
        return { status: "verified" };
      },
      deliverProtectedField: async (input) => {
        delivered.push(new TextDecoder().decode(input.value));
      },
      releaseProtectedField,
    });
    const registry = new SecureInputTransportRegistry();
    registry.register(createProtectedBrowserFieldTransport(backend));
    const broker = new EphemeralSecretBroker({ idFactory: () => "browser-request" });
    const collected = new TextEncoder().encode("transport-sentinel-secret");
    const consumer = vi.fn(async () => undefined);
    const coordinator = new SecureInputCoordinator({
      broker,
      transports: registry,
      collect: async () => ({ status: "provided", value: collected }),
    });

    const result = await coordinator.request({
      scope: { profileId: "profile", sessionId: "runtime-session" },
      request,
      consume: consumer,
    });

    expect(result).toEqual({
      status: "delivered",
      destinationLabel: "Browser field at https://example.com",
      persisted: false,
    });
    expect(phases).toEqual(["before-collection", "before-delivery"]);
    expect(delivered).toEqual(["transport-sentinel-secret"]);
    expect(consumer).toHaveBeenCalledOnce();
    expect(releaseProtectedField).toHaveBeenCalledWith(destination);
    expect([...collected]).toEqual(new Array(collected.length).fill(0));
    expect(JSON.stringify(result)).not.toContain("transport-sentinel-secret");
    broker.dispose();
  });

  it("is unavailable for cloud browser backends", async () => {
    const verifyProtectedField = vi.fn(async (): Promise<BrowserProtectedFieldVerification> => ({ status: "verified" }));
    const backend = {
      ...localBackend({ verifyProtectedField }),
      kind: "browserbase" as const,
    };
    const transport = createProtectedBrowserFieldTransport(backend);

    await expect(transport.isAvailable(request)).resolves.toBe(false);
    expect(verifyProtectedField).not.toHaveBeenCalled();
  });

  it("maps changed field identity to a destination-changed rejection", async () => {
    const transport = createProtectedBrowserFieldTransport(localBackend({
      verifyProtectedField: async () => ({ status: "rejected", reason: "field-replaced" }),
    }));

    await expect(transport.verify({
      request,
      phase: "before-delivery",
      signal: new AbortController().signal,
    })).resolves.toEqual({ status: "rejected", code: "destination-changed" });
  });
});

function localBackend(overrides: Partial<BrowserBackend> = {}): BrowserBackend {
  return {
    kind: "local-cdp",
    isAvailable: () => true,
    status: () => ({ backend: "local-cdp", available: true }),
    navigate: async (input) => ({
      session: {
        id: input.sessionId ?? "browser-session",
        backend: "local-cdp",
        currentUrl: input.url,
        createdAt: "2026-08-13T00:00:00.000Z",
      },
      snapshot: {
        sessionId: input.sessionId ?? "browser-session",
        url: input.url,
        identity: { documentEpoch: 1, actionRevision: 1, observationId: 1 },
        observedAt: "2026-08-13T00:00:00.000Z",
      },
    }),
    verifyProtectedField: async () => ({ status: "verified" }),
    deliverProtectedField: async () => undefined,
    abortProtectedFieldGroup: async () => undefined,
    releaseProtectedField: async () => undefined,
    ...overrides,
    capabilities: overrides.capabilities ?? {
      snapshots: false,
      semanticActions: false,
      visibleRegionActions: false,
      nativePointer: false,
      tabs: false,
      controlledNewTabs: false,
      popupObservation: false,
      downloads: false,
      protectedInput: true,
      protectedSourceRelay: false,
      screenshots: false,
      rawCdp: false
    },
  };
}
