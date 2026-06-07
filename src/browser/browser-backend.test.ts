import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserProvider } from "./browser-provider.js";
import {
  createBrowserBackendFromConfig,
  createHybridBrowserBackend,
  createLocalCdpBrowserBackend,
  createMockBrowserBackend,
  createUnconfiguredBrowserBackend,
  type CdpFetchLike
} from "./browser-backend.js";
import { registerBrowserProvider, resetBrowserProvidersForTest } from "./browser-registry.js";
import type { BrowserActionInput, BrowserBackend, BrowserNavigateInput, BrowserNavigateResult, BrowserSnapshot } from "../contracts/browser.js";

function createCdpFetch(input: {
  ok: boolean;
  status: number;
  statusText: string;
  payload?: unknown;
}): CdpFetchLike {
  return vi.fn(async () => ({
    ok: input.ok,
    status: input.status,
    statusText: input.statusText,
    json: async () => input.payload ?? {},
    text: async () => JSON.stringify(input.payload ?? {})
  }));
}

type FakeHybridBackend = BrowserBackend & {
  navigations: BrowserNavigateInput[];
  snapshots: BrowserActionInput[];
  clicks: BrowserActionInput[];
  closeSessionCalls: string[];
  closeCalls: number;
};

function createHybridSnapshot(sessionId: string, url = "https://example.com"): BrowserSnapshot {
  return {
    sessionId,
    url,
    title: "Hybrid test page",
    text: `Snapshot for ${url}.`,
    elements: [{ ref: "@e1", role: "button", name: "Hybrid Button" }]
  };
}

function createFakeHybridBackend(input: {
  kind: BrowserBackend["kind"];
  failNavigate?: Error;
  finalUrl?: string;
  available?: boolean;
}): FakeHybridBackend {
  const backend: FakeHybridBackend = {
    kind: input.kind,
    navigations: [],
    snapshots: [],
    clicks: [],
    closeSessionCalls: [],
    closeCalls: 0,
    isAvailable: () => input.available ?? true,
    status: () => ({ backend: input.kind, available: input.available ?? true }),
    async navigate(request): Promise<BrowserNavigateResult> {
      backend.navigations.push(request);
      if (input.failNavigate !== undefined) {
        throw input.failNavigate;
      }
      const sessionId = request.sessionId ?? `${input.kind}-session`;
      const url = input.finalUrl ?? request.url;
      return {
        session: {
          id: sessionId,
          backend: input.kind,
          currentUrl: url,
          createdAt: "2026-06-07T00:00:00.000Z"
        },
        snapshot: createHybridSnapshot(sessionId, url)
      };
    },
    snapshot: async (request = {}) => {
      backend.snapshots.push(request);
      return createHybridSnapshot(request.sessionId ?? `${input.kind}-session`);
    },
    click: async (request) => {
      backend.clicks.push(request);
      return createHybridSnapshot(request.sessionId ?? `${input.kind}-session`);
    },
    closeSession: async (sessionId) => {
      backend.closeSessionCalls.push(sessionId);
    },
    close: async () => {
      backend.closeCalls += 1;
    }
  };
  return backend;
}

const hybridResolve = async (hostname: string): Promise<string[]> => {
  if (hostname === "example.com") return ["93.184.216.34"];
  if (hostname === "private.test") return ["192.168.1.1"];
  if (hostname === "metadata.test") return ["169.254.169.254"];
  return ["93.184.216.34"];
};

const allowPrivateSecurityConfig = {
  allowPrivateUrls: true,
  websiteBlocklist: {}
};

describe("browser backend baselines", () => {
  afterEach(() => {
    resetBrowserProvidersForTest();
    vi.unstubAllEnvs();
  });

  it("returns stable shapes from every mock backend method", async () => {
    const backend = createMockBrowserBackend({
      sessionId: "session-1",
      title: "Mock Title",
      text: "Readable mock text."
    });

    expect(await Promise.resolve(backend.isAvailable())).toBe(true);
    expect(await backend.status()).toMatchObject({
      backend: "mock",
      available: true,
      browser: "Mock Title"
    });

    await expect(backend.navigate({ url: "https://example.com" })).resolves.toMatchObject({
      session: {
        id: "session-1",
        backend: "mock",
        currentUrl: "https://example.com",
        createdAt: "2026-04-18T00:00:00.000Z"
      },
      snapshot: {
        sessionId: "session-1",
        url: "https://example.com",
        title: "Mock Title",
        text: "Readable mock text.",
        elements: [{ ref: "@e1", role: "button", name: "Mock Button" }]
      }
    });

    await expect(backend.snapshot?.()).resolves.toMatchObject({
      sessionId: "session-1",
      url: "mock://browser",
      elements: [{ ref: "@e1", role: "button", name: "Mock Button" }]
    });
    await expect(backend.click?.({ ref: "@e1" })).resolves.toHaveProperty("sessionId", "session-1");
    await expect(backend.type?.({ ref: "@e1", text: "hello" })).resolves.toHaveProperty("sessionId", "session-1");
    await expect(backend.scroll?.({ direction: "down" })).resolves.toHaveProperty("sessionId", "session-1");
    await expect(backend.press?.({ key: "Enter" })).resolves.toHaveProperty("sessionId", "session-1");
    await expect(backend.back?.()).resolves.toHaveProperty("sessionId", "session-1");
    await expect(backend.getImages?.()).resolves.toEqual([{ src: "https://example.com/mock.png", alt: "Mock image" }]);
    await expect(backend.console?.()).resolves.toEqual([
      { level: "log", text: "Mock console entry", timestamp: "2026-04-18T00:00:00.000Z" }
    ]);
    await expect(backend.cdp?.({ method: "Runtime.evaluate", params: { expression: "1 + 1" } })).resolves.toEqual({
      method: "Runtime.evaluate",
      params: { expression: "1 + 1" }
    });
    await expect(backend.screenshot?.()).resolves.toEqual({
      mimeType: "image/png",
      base64: "iVBORw0KGgo="
    });
    await expect(backend.dialog?.({ action: "accept" })).resolves.toHaveProperty("sessionId", "session-1");
  });

  it("documents mock backend invalid-ref behavior as permissive", async () => {
    const backend = createMockBrowserBackend();

    await expect(backend.click?.({ ref: "not-a-ref" })).resolves.toMatchObject({
      sessionId: "mock-browser-session",
      url: "mock://browser"
    });
  });

  it("reports unconfigured backend unavailable and fails navigation", async () => {
    const backend = createUnconfiguredBrowserBackend({ reason: "No backend in this test." });

    expect(backend.isAvailable()).toBe(false);
    expect(await backend.status()).toEqual({
      backend: "unconfigured",
      available: false,
      reason: "No backend in this test."
    });
    await expect(backend.navigate({ url: "https://example.com" })).rejects.toThrow("No backend in this test.");
  });

  it("keeps legacy cloud backend values recognized but unavailable", async () => {
    for (const backendKind of ["browserbase", "firecrawl", "camofox"] as const) {
      const backend = createBrowserBackendFromConfig({ backend: backendKind });

      expect(backend.kind).toBe(backendKind);
      await expect(backend.isAvailable()).resolves.toBe(false);
      expect(await backend.status()).toMatchObject({
        backend: backendKind,
        available: false,
      });
      await expect(backend.navigate({ url: "https://example.com" })).rejects.toThrow();
    }
  });

  it("surfaces cloud provider missing env and cloud approval reasons", async () => {
    const missing = createBrowserBackendFromConfig({
      backend: "unconfigured",
      cloudProvider: "browserbase"
    });

    await expect(missing.status()).resolves.toMatchObject({
      backend: "browserbase",
      available: false,
      reason: "BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID are missing."
    });

    vi.stubEnv("BROWSERBASE_API_KEY", "test-key");
    vi.stubEnv("BROWSERBASE_PROJECT_ID", "test-project");
    const configured = createBrowserBackendFromConfig({
      backend: "unconfigured",
      cloudProvider: "browserbase"
    });

    await expect(configured.status()).resolves.toMatchObject({
      backend: "browserbase",
      available: false,
      reason: expect.stringContaining("may incur charges")
    });
  });

  it("surfaces unknown cloud provider status", async () => {
    const backend = createBrowserBackendFromConfig({
      backend: "unconfigured",
      cloudProvider: "unknown-cloud"
    });

    await expect(backend.status()).resolves.toEqual({
      backend: "unconfigured",
      available: false,
      reason: "Unknown browser provider: unknown-cloud."
    });
  });

  it("does not call createSession for unavailable cloud providers", async () => {
    const createSession = vi.fn<BrowserProvider["createSession"]>(async () => ({
      sessionName: "should-not-run",
      providerSessionId: "provider-session",
      cdpUrl: "wss://example.test/cdp",
      features: {}
    }));
    registerBrowserProvider({
      name: "offline-provider",
      displayName: "Offline Provider",
      getAvailability: () => ({ available: false, reason: "offline provider" }),
      createSession,
      closeSession: () => false,
      emergencyCleanup: () => undefined
    });
    const backend = createBrowserBackendFromConfig({
      backend: "unconfigured",
      cloudProvider: "offline-provider"
    });

    await expect(backend.status()).resolves.toMatchObject({
      available: false,
      reason: "offline provider"
    });
    await expect(backend.navigate({ url: "https://example.com" })).rejects.toThrow("offline provider");
    expect(createSession).not.toHaveBeenCalled();
  });

  it("checks local CDP availability with a successful mocked fetch", async () => {
    const fetch = createCdpFetch({
      ok: true,
      status: 200,
      statusText: "OK",
      payload: {
        Browser: "Chrome/125.0.0.0",
        "Protocol-Version": "1.3"
      }
    });
    const backend = createLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222/",
      fetch
    });

    await expect(backend.isAvailable()).resolves.toBe(true);
    await expect(backend.status()).resolves.toEqual({
      backend: "local-cdp",
      available: true,
      endpoint: "http://127.0.0.1:9222",
      browser: "Chrome/125.0.0.0",
      version: "1.3"
    });
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:9222/json/version", expect.objectContaining({ method: "GET" }));
  });

  it("checks local CDP availability with a failing mocked fetch", async () => {
    const backend = createLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      fetch: createCdpFetch({
        ok: false,
        status: 503,
        statusText: "Service Unavailable"
      })
    });

    await expect(backend.isAvailable()).resolves.toBe(false);
    await expect(backend.status()).resolves.toEqual({
      backend: "local-cdp",
      available: false,
      endpoint: "http://127.0.0.1:9222",
      reason: "CDP endpoint returned 503 Service Unavailable"
    });
  });

  it("keeps unsupervised local CDP explicit-url only even when autoLaunch is set", async () => {
    const backend = createLocalCdpBrowserBackend({
      autoLaunch: true,
      launchExecutable: "/usr/bin/chromium",
      launchArgs: ["--headless=new"],
      chromeFlags: ["--disable-gpu"],
      fetch: createCdpFetch({
        ok: true,
        status: 200,
        statusText: "OK"
      })
    });

    await expect(backend.isAvailable()).resolves.toBe(false);
    await expect(backend.status()).resolves.toEqual({
      backend: "local-cdp",
      available: false,
      reason: "CDP URL is not configured."
    });
    await expect(backend.navigate({ url: "https://example.com" })).rejects.toThrow("CDP URL is not configured.");
  });

  it("routes public URLs to Browserbase when hybrid routing is configured", async () => {
    const cloud = createFakeHybridBackend({ kind: "browserbase" });
    const local = createFakeHybridBackend({ kind: "local-cdp" });
    const backend = createHybridBrowserBackend({
      cloudBackend: cloud,
      localBackend: local,
      allowPrivateUrls: true,
      hybridRouting: true,
      resolveHostname: hybridResolve
    });

    const result = await backend.navigate({ url: "https://example.com", sessionId: "browser-key" });

    expect(result.session.backend).toBe("browserbase");
    expect(result.session.id).toBe("browser-key");
    expect(result.metadata).toMatchObject({
      route: "cloud",
      routedSessionId: "browser-key",
      servedBackend: "browserbase"
    });
    expect(cloud.navigations).toEqual([{ url: "https://example.com", sessionId: "browser-key" }]);
    expect(local.navigations).toEqual([]);
  });

  it("blocks private URLs when allowPrivateUrls is false", async () => {
    const cloud = createFakeHybridBackend({ kind: "browserbase" });
    const local = createFakeHybridBackend({ kind: "local-cdp" });
    const backend = createHybridBrowserBackend({
      cloudBackend: cloud,
      localBackend: local,
      allowPrivateUrls: false,
      hybridRouting: true,
      resolveHostname: hybridResolve
    });

    await expect(backend.navigate({ url: "http://192.168.1.1", sessionId: "browser-key" })).rejects.toThrow(
      "Blocked browser URL"
    );
    expect(cloud.navigations).toEqual([]);
    expect(local.navigations).toEqual([]);
  });

  it("routes private URLs to a local sub-session when private URLs and hybrid routing are enabled", async () => {
    const cloud = createFakeHybridBackend({ kind: "browserbase" });
    const local = createFakeHybridBackend({ kind: "local-cdp" });
    const backend = createHybridBrowserBackend({
      cloudBackend: cloud,
      localBackend: local,
      allowPrivateUrls: true,
      hybridRouting: true,
      resolveHostname: hybridResolve
    });

    const result = await backend.navigate({ url: "http://192.168.1.1", sessionId: "browser-key" });

    expect(result.session.backend).toBe("local-cdp");
    expect(result.session.id).toBe("browser-key");
    expect(result.metadata).toMatchObject({
      route: "local",
      routedSessionId: "browser-key::local",
      servedBackend: "local-cdp"
    });
    expect(local.navigations).toEqual([{ url: "http://192.168.1.1", sessionId: "browser-key::local" }]);
  });

  it("blocks metadata endpoints even when private URLs are allowed", async () => {
    const backend = createHybridBrowserBackend({
      cloudBackend: createFakeHybridBackend({ kind: "browserbase" }),
      localBackend: createFakeHybridBackend({ kind: "local-cdp" }),
      allowPrivateUrls: true,
      hybridRouting: true,
      resolveHostname: hybridResolve
    });

    await expect(backend.navigate({ url: "http://169.254.169.254", sessionId: "browser-key" })).rejects.toThrow(
      "Blocked browser URL"
    );
  });

  it("keeps approval failures on public cloud routes from falling back to local", async () => {
    const cloud = createFakeHybridBackend({
      kind: "browserbase",
      failNavigate: new Error("Browserbase cloud browser sessions may incur charges")
    });
    const local = createFakeHybridBackend({ kind: "local-cdp" });
    const backend = createHybridBrowserBackend({
      cloudBackend: cloud,
      localBackend: local,
      allowPrivateUrls: true,
      hybridRouting: true,
      resolveHostname: hybridResolve
    });

    await expect(backend.navigate({ url: "https://example.com", sessionId: "browser-key" })).rejects.toThrow(
      "may incur charges"
    );
    await expect(backend.snapshot!({ sessionId: "browser-key" })).rejects.toThrow("Browser session not found");
    expect(local.navigations).toEqual([]);
    expect(local.snapshots).toEqual([]);
  });

  it("allows Browserbase public-route fallback behavior to remain owned by the cloud backend", async () => {
    const cloud = createFakeHybridBackend({ kind: "local-cdp" });
    const local = createFakeHybridBackend({ kind: "local-cdp" });
    const backend = createHybridBrowserBackend({
      cloudBackend: cloud,
      localBackend: local,
      allowPrivateUrls: true,
      hybridRouting: true,
      resolveHostname: hybridResolve
    });

    const result = await backend.navigate({ url: "https://example.com", sessionId: "browser-key" });

    expect(result.metadata).toMatchObject({
      route: "cloud",
      servedBackend: "local-cdp"
    });
    expect(local.navigations).toEqual([]);
  });

  it("uses the owning route for follow-up actions after public and private navigation", async () => {
    const cloud = createFakeHybridBackend({ kind: "browserbase" });
    const local = createFakeHybridBackend({ kind: "local-cdp" });
    const backend = createHybridBrowserBackend({
      cloudBackend: cloud,
      localBackend: local,
      allowPrivateUrls: true,
      hybridRouting: true,
      resolveHostname: hybridResolve
    });

    await backend.navigate({ url: "https://example.com", sessionId: "browser-key" });
    await backend.snapshot?.({ sessionId: "browser-key" });
    await backend.navigate({ url: "http://192.168.1.1", sessionId: "browser-key" });
    await backend.click?.({ sessionId: "browser-key", ref: "@e1" });

    expect(cloud.snapshots).toEqual([{ sessionId: "browser-key" }]);
    expect(local.clicks).toEqual([{ sessionId: "browser-key::local", ref: "@e1" }]);
  });

  it("keeps public and local sub-sessions for the same browser key able to coexist and cleans up both", async () => {
    const cloud = createFakeHybridBackend({ kind: "browserbase" });
    const local = createFakeHybridBackend({ kind: "local-cdp" });
    const backend = createHybridBrowserBackend({
      cloudBackend: cloud,
      localBackend: local,
      allowPrivateUrls: true,
      hybridRouting: true,
      resolveHostname: hybridResolve
    });

    await backend.navigate({ url: "https://example.com", sessionId: "browser-key" });
    await backend.navigate({ url: "http://192.168.1.1", sessionId: "browser-key" });
    await backend.closeSession?.("browser-key");
    await backend.close?.();
    await backend.close?.();

    expect(cloud.closeSessionCalls).toEqual(["browser-key"]);
    expect(local.closeSessionCalls).toEqual(["browser-key::local"]);
    expect(cloud.closeCalls).toBe(1);
    expect(local.closeCalls).toBe(1);
  });

  it("blocks public cloud redirects to private URLs and closes the unsafe session", async () => {
    const cloud = createFakeHybridBackend({ kind: "browserbase", finalUrl: "http://192.168.1.1" });
    const local = createFakeHybridBackend({ kind: "local-cdp" });
    const backend = createHybridBrowserBackend({
      cloudBackend: cloud,
      localBackend: local,
      allowPrivateUrls: true,
      hybridRouting: true,
      resolveHostname: hybridResolve
    });

    await expect(backend.navigate({ url: "https://example.com", sessionId: "browser-key" })).rejects.toThrow(
      "Browser redirect safety violation"
    );
    expect(cloud.closeSessionCalls).toEqual(["browser-key"]);
  });

  it("blocks private local redirects to metadata URLs and closes the unsafe session", async () => {
    const cloud = createFakeHybridBackend({ kind: "browserbase" });
    const local = createFakeHybridBackend({ kind: "local-cdp", finalUrl: "http://169.254.169.254" });
    const backend = createHybridBrowserBackend({
      cloudBackend: cloud,
      localBackend: local,
      allowPrivateUrls: true,
      hybridRouting: true,
      resolveHostname: hybridResolve
    });

    await expect(backend.navigate({ url: "http://192.168.1.1", sessionId: "browser-key" })).rejects.toThrow(
      "Browser redirect safety violation"
    );
    expect(local.closeSessionCalls).toEqual(["browser-key::local"]);
  });

  it("reports the last served backend in hybrid status", async () => {
    const backend = createHybridBrowserBackend({
      cloudBackend: createFakeHybridBackend({ kind: "browserbase" }),
      localBackend: createFakeHybridBackend({ kind: "local-cdp" }),
      allowPrivateUrls: true,
      hybridRouting: true,
      resolveHostname: hybridResolve
    });

    await backend.navigate({ url: "https://example.com", sessionId: "browser-key" });

    await expect(backend.status()).resolves.toMatchObject({
      backend: "browserbase",
      hybridRouting: true,
      lastNavigationBackend: "browserbase",
      lastRouteReason: "Public browser URL routes to the configured cloud browser."
    });
  });

  it("factory hybrid public routes still enforce cloud spend approval before Browserbase API calls", async () => {
    const calls: string[] = [];
    const backend = createBrowserBackendFromConfig({
      backend: "browserbase",
      cloudProvider: "browserbase",
      hybridRouting: true,
      cloudSpendApproved: "pending",
      securityConfig: allowPrivateSecurityConfig,
      resolveHostname: hybridResolve,
      browserbase: {
        apiKey: "bb_test_key",
        projectId: "project_123",
        client: {
          createSession: async () => {
            calls.push("createSession");
            throw new Error("should not create cloud session");
          },
          closeSession: async () => undefined
        },
        createSupervisedBackend: () => createFakeHybridBackend({ kind: "local-cdp" })
      }
    });

    await expect(backend.navigate({ url: "https://example.com", sessionId: "browser-key" })).rejects.toThrow(
      "may incur charges"
    );
    expect(calls).toEqual([]);
  });

  it("factory hybrid private routes do not require Browserbase spend approval", async () => {
    const calls: string[] = [];
    const local = createFakeHybridBackend({ kind: "local-cdp" });
    const backend = createBrowserBackendFromConfig({
      backend: "browserbase",
      cloudProvider: "browserbase",
      hybridRouting: true,
      cloudSpendApproved: "pending",
      securityConfig: allowPrivateSecurityConfig,
      resolveHostname: hybridResolve,
      browserbase: {
        apiKey: "bb_test_key",
        projectId: "project_123",
        client: {
          createSession: async () => {
            calls.push("createSession");
            throw new Error("should not create cloud session");
          },
          closeSession: async () => undefined
        },
        createSupervisedBackend: () => local
      }
    });

    await expect(backend.navigate({ url: "http://192.168.1.1", sessionId: "browser-key" })).resolves.toHaveProperty(
      "session.backend",
      "local-cdp"
    );
    expect(calls).toEqual([]);
    expect(local.navigations).toEqual([{ url: "http://192.168.1.1", sessionId: "browser-key::local" }]);
  });

  it("factory hybrid routing keeps private URL allowance scoped to the local sidecar", async () => {
    const securityConfigs: Array<unknown> = [];
    const backend = createBrowserBackendFromConfig({
      backend: "browserbase",
      cloudProvider: "browserbase",
      hybridRouting: true,
      cloudSpendApproved: true,
      securityConfig: allowPrivateSecurityConfig,
      resolveHostname: hybridResolve,
      browserbase: {
        apiKey: "bb_test_key",
        projectId: "project_123",
        client: {
          createSession: async () => ({
            id: "bb-session",
            cdpUrl: "wss://connect.browserbase.test/session",
            raw: {}
          }),
          closeSession: async () => undefined
        },
        createSupervisedBackend: (options) => {
          securityConfigs.push(options.securityConfig);
          return createFakeHybridBackend({ kind: "local-cdp" });
        }
      }
    });

    await backend.navigate({ url: "https://example.com", sessionId: "browser-key" });

    expect(securityConfigs).toEqual([
      allowPrivateSecurityConfig,
      {
        allowPrivateUrls: false,
        websiteBlocklist: {}
      }
    ]);
  });

  it("factory hybrid public routes preserve Browserbase cloud fallback when enabled", async () => {
    const calls: string[] = [];
    const fallback = createFakeHybridBackend({ kind: "local-cdp" });
    let createSupervisedBackendCalls = 0;
    const backend = createBrowserBackendFromConfig({
      backend: "browserbase",
      cloudProvider: "browserbase",
      hybridRouting: true,
      cloudFallback: true,
      cloudSpendApproved: true,
      securityConfig: allowPrivateSecurityConfig,
      resolveHostname: hybridResolve,
      browserbase: {
        apiKey: "bb_test_key",
        projectId: "project_123",
        client: {
          createSession: async () => {
            calls.push("createSession");
            throw new Error("Browserbase POST /v1/sessions network error.");
          },
          closeSession: async () => undefined
        },
        createSupervisedBackend: () => {
          createSupervisedBackendCalls += 1;
          return fallback;
        }
      }
    });

    const result = await backend.navigate({ url: "https://example.com", sessionId: "browser-key" });

    expect(result.session.backend).toBe("local-cdp");
    expect(result.metadata).toMatchObject({
      route: "cloud",
      fallbackFromCloud: true,
      fallbackProvider: "browserbase",
      servedBackend: "local-cdp"
    });
    expect(calls).toEqual(["createSession"]);
    expect(createSupervisedBackendCalls).toBeGreaterThanOrEqual(2);
  });

  it("factory hybrid public routes preserve Browserbase no-fallback behavior when disabled", async () => {
    const backend = createBrowserBackendFromConfig({
      backend: "browserbase",
      cloudProvider: "browserbase",
      hybridRouting: true,
      cloudFallback: false,
      cloudSpendApproved: true,
      securityConfig: allowPrivateSecurityConfig,
      resolveHostname: hybridResolve,
      browserbase: {
        apiKey: "bb_test_key",
        projectId: "project_123",
        client: {
          createSession: async () => {
            throw new Error("Browserbase POST /v1/sessions network error.");
          },
          closeSession: async () => undefined
        },
        createSupervisedBackend: () => createFakeHybridBackend({ kind: "local-cdp" })
      }
    });

    await expect(backend.navigate({ url: "https://example.com", sessionId: "browser-key" })).rejects.toThrow(
      "Browserbase POST /v1/sessions network error."
    );
  });
});
