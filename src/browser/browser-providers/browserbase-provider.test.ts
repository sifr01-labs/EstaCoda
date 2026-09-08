import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BrowserBackend,
  BrowserNavigateInput,
  BrowserNavigateResult,
  BrowserSnapshot
} from "../../contracts/browser.js";
import { createBrowserBackendFromConfig } from "../browser-backend.js";
import { browserbaseProvider, createBrowserbaseBrowserBackend, getBrowserbaseAvailability, type BrowserbaseClientLike } from "./browserbase-provider.js";
import { browserCapabilities } from "../browser-capabilities.js";

type FakeBackend = BrowserBackend & {
  close: ReturnType<typeof vi.fn<() => Promise<void>>>;
  closeSession: ReturnType<typeof vi.fn<(sessionId: string) => Promise<void>>>;
};

function createSnapshot(input: { sessionId: string; url?: string; backend?: "local-cdp" | "browserbase" }): BrowserSnapshot {
  return {
    sessionId: input.sessionId,
    url: input.url ?? "https://example.com",
    identity: { documentEpoch: 1, actionRevision: 1, observationId: 1 },
    observedAt: "2026-08-13T00:00:00.000Z",
    title: "Fake page",
    text: "Fake snapshot.",
    elements: [{ ref: "@e1", role: "button", name: "Fake Button" }]
  };
}

function createFakeBackend(input: {
  kind?: BrowserBackend["kind"];
  failNavigate?: Error;
  navigations?: BrowserNavigateInput[];
} = {}): FakeBackend {
  const navigations = input.navigations ?? [];
  const backend: FakeBackend = {
    kind: input.kind ?? "local-cdp",
    capabilities: browserCapabilities(),
    isAvailable: () => true,
    status: () => ({ backend: input.kind ?? "local-cdp", available: true }),
    async navigate(request): Promise<BrowserNavigateResult> {
      navigations.push(request);
      if (input.failNavigate !== undefined) {
        throw input.failNavigate;
      }
      const sessionId = request.sessionId ?? "fake-session";
      return {
        session: {
          id: sessionId,
          backend: input.kind ?? "local-cdp",
          currentUrl: request.url,
          createdAt: "2026-06-07T00:00:00.000Z"
        },
        snapshot: createSnapshot({ sessionId, url: request.url })
      };
    },
    snapshot: async (request = {}) => createSnapshot({ sessionId: request.sessionId ?? "fake-session" }),
    click: async (request) => createSnapshot({ sessionId: request.sessionId ?? "fake-session" }),
    type: async (request) => createSnapshot({ sessionId: request.sessionId ?? "fake-session" }),
    scroll: async (request) => createSnapshot({ sessionId: request.sessionId ?? "fake-session" }),
    press: async (request) => createSnapshot({ sessionId: request.sessionId ?? "fake-session" }),
    back: async (request = {}) => createSnapshot({ sessionId: request.sessionId ?? "fake-session" }),
    console: async () => [{ level: "log", text: "hello" }],
    getImages: async () => [{ src: "https://example.com/image.png" }],
    cdp: async (request) => ({ method: request.method }),
    screenshot: async () => ({ mimeType: "image/png", base64: "iVBORw0KGgo=" }),
    dialog: async (request = {}) => createSnapshot({ sessionId: request.sessionId ?? "fake-session" }),
    close: vi.fn(async () => undefined),
    closeSession: vi.fn(async () => undefined)
  };
  return backend;
}

function createClient(input: {
  createError?: Error;
  cdpUrl?: string;
  sessionId?: string;
  calls?: string[];
} = {}): BrowserbaseClientLike {
  const calls = input.calls ?? [];
  return {
    async createSession() {
      calls.push("createSession");
      if (input.createError !== undefined) {
        throw input.createError;
      }
      return {
        id: input.sessionId ?? "bb-session-1",
        cdpUrl: input.cdpUrl ?? "wss://connect.browserbase.test/devtools",
        raw: { id: input.sessionId ?? "bb-session-1", connectUrl: input.cdpUrl ?? "wss://connect.browserbase.test/devtools" }
      };
    },
    async closeSession(sessionId) {
      calls.push(`closeSession:${sessionId}`);
    }
  };
}

describe("Browserbase provider", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports unavailable when BROWSERBASE_API_KEY is missing", () => {
    vi.stubEnv("BROWSERBASE_PROJECT_ID", "project_123");

    expect(browserbaseProvider.getAvailability()).toEqual({
      available: false,
      reason: "BROWSERBASE_API_KEY is missing."
    });
  });

  it("reports unavailable when BROWSERBASE_PROJECT_ID is missing", () => {
    vi.stubEnv("BROWSERBASE_API_KEY", "bb_test_key");

    expect(browserbaseProvider.getAvailability()).toEqual({
      available: false,
      reason: "BROWSERBASE_PROJECT_ID is missing."
    });
  });

  it("reports available when Browserbase env vars are present without making API calls", () => {
    vi.stubEnv("BROWSERBASE_API_KEY", "bb_test_key");
    vi.stubEnv("BROWSERBASE_PROJECT_ID", "project_123");

    expect(getBrowserbaseAvailability()).toEqual({ available: true });
    expect(browserbaseProvider.getAvailability()).toEqual({ available: true });
  });

  it("factory returns a Browserbase-capable backend for backend: browserbase", async () => {
    const calls: string[] = [];
    const cloudDelegate = createFakeBackend();
    const backend = createBrowserBackendFromConfig({
      backend: "browserbase",
      cloudSpendApproved: true,
      browserbase: {
        apiKey: "bb_test_key",
        projectId: "project_123",
        client: createClient({ calls }),
        createSupervisedBackend: () => cloudDelegate
      }
    });

    expect(backend.kind).toBe("browserbase");
    await expect(backend.navigate({ url: "https://example.com", sessionId: "session-1" })).resolves.toMatchObject({
      session: {
        backend: "browserbase",
        id: "session-1"
      }
    });
    expect(calls).toEqual(["createSession"]);
  });

  it("factory keeps backend: unconfigured disabled even with stale cloudProvider: browserbase", async () => {
    const calls: string[] = [];
    const backend = createBrowserBackendFromConfig({
      backend: "unconfigured",
      cloudProvider: "browserbase",
      cloudSpendApproved: true,
      browserbase: {
        apiKey: "bb_test_key",
        projectId: "project_123",
        client: createClient({ calls }),
        createSupervisedBackend: () => createFakeBackend()
      }
    });

    expect(backend.kind).toBe("unconfigured");
    await expect(backend.navigate({ url: "https://example.com" })).rejects.toThrow("No browser backend is configured");
    expect(calls).toEqual([]);
  });

  it("missing cloudSpendApproved blocks session creation and makes no API call", async () => {
    const calls: string[] = [];
    const backend = createBrowserbaseBrowserBackend({
      apiKey: "bb_test_key",
      projectId: "project_123",
      client: createClient({ calls }),
      createSupervisedBackend: () => createFakeBackend()
    });

    await expect(backend.navigate({ url: "https://example.com" })).rejects.toThrow(/may incur charges/);
    expect(calls).toEqual([]);
  });

  it("cloudSpendApproved pending blocks session creation and makes no API call", async () => {
    const calls: string[] = [];
    const backend = createBrowserbaseBrowserBackend({
      apiKey: "bb_test_key",
      projectId: "project_123",
      cloudSpendApproved: "pending",
      client: createClient({ calls }),
      createSupervisedBackend: () => createFakeBackend()
    });

    await expect(backend.navigate({ url: "https://example.com" })).rejects.toThrow(/may incur charges/);
    expect(calls).toEqual([]);
  });

  it("cloudSpendApproved false blocks session creation and makes no API call", async () => {
    const calls: string[] = [];
    const backend = createBrowserbaseBrowserBackend({
      apiKey: "bb_test_key",
      projectId: "project_123",
      cloudSpendApproved: false,
      client: createClient({ calls }),
      createSupervisedBackend: () => createFakeBackend()
    });

    await expect(backend.navigate({ url: "https://example.com" })).rejects.toThrow(/may incur charges/);
    expect(calls).toEqual([]);
  });

  it("cloudSpendApproved true permits Browserbase session creation and uses connectUrl as the CDP endpoint", async () => {
    const calls: string[] = [];
    const supervisedOptions: unknown[] = [];
    const backend = createBrowserbaseBrowserBackend({
      apiKey: "bb_test_key",
      projectId: "project_123",
      cloudSpendApproved: true,
      client: createClient({ calls, cdpUrl: "wss://connect.browserbase.test/session-1" }),
      createSupervisedBackend: (options) => {
        supervisedOptions.push(options);
        return createFakeBackend();
      }
    });

    await backend.navigate({ url: "https://example.com", sessionId: "session-1" });

    expect(calls).toEqual(["createSession"]);
    expect(supervisedOptions).toMatchObject([{ cdpUrl: "wss://connect.browserbase.test/session-1", autoLaunch: false }]);
  });

  it("releases Browserbase session on backend close", async () => {
    const calls: string[] = [];
    const delegate = createFakeBackend();
    const backend = createBrowserbaseBrowserBackend({
      apiKey: "bb_test_key",
      projectId: "project_123",
      cloudSpendApproved: true,
      client: createClient({ calls, sessionId: "bb-session-close" }),
      createSupervisedBackend: () => delegate
    }) as BrowserBackend & { close(): Promise<void> };

    await backend.navigate({ url: "https://example.com" });
    await backend.close();
    await backend.close();

    expect(delegate.close).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["createSession", "closeSession:bb-session-close"]);
  });

  it("falls back to local supervised CDP when session creation fails and cloudFallback is true", async () => {
    const calls: string[] = [];
    const localNavigations: BrowserNavigateInput[] = [];
    const backend = createBrowserbaseBrowserBackend({
      apiKey: "bb_test_key",
      projectId: "project_123",
      cloudSpendApproved: true,
      cloudFallback: true,
      client: createClient({ calls, createError: new Error("Browserbase POST /v1/sessions network error.") }),
      createSupervisedBackend: () => createFakeBackend({ navigations: localNavigations })
    });

    const result = await backend.navigate({ url: "https://example.com", sessionId: "session-1" });

    expect(result.session.backend).toBe("local-cdp");
    expect(result.metadata).toMatchObject({
      fallbackFromCloud: true,
      fallbackProvider: "browserbase",
      fallbackReason: "Browserbase network error."
    });
    expect(localNavigations).toEqual([{ url: "https://example.com", sessionId: "session-1" }]);
  });

  it("does not fall back when cloudFallback is false", async () => {
    const backend = createBrowserbaseBrowserBackend({
      apiKey: "bb_test_key",
      projectId: "project_123",
      cloudSpendApproved: true,
      cloudFallback: false,
      client: createClient({ createError: new Error("Browserbase POST /v1/sessions network error.") }),
      createSupervisedBackend: () => createFakeBackend()
    });

    await expect(backend.navigate({ url: "https://example.com" })).rejects.toThrow("Browserbase POST /v1/sessions network error.");
  });

  it("sanitizes fallback metadata and does not leak API keys or raw response bodies", async () => {
    const backend = createBrowserbaseBrowserBackend({
      apiKey: "bb_visible_key",
      projectId: "project_123",
      cloudSpendApproved: true,
      cloudFallback: true,
      client: createClient({
        createError: new Error("raw response body with bb_visible_key and secret-token")
      }),
      createSupervisedBackend: () => createFakeBackend()
    });

    const result = await backend.navigate({ url: "https://example.com" });

    expect(result.metadata).toMatchObject({
      fallbackFromCloud: true,
      fallbackProvider: "browserbase",
      fallbackReason: "Browserbase session could not be created."
    });
    expect(JSON.stringify(result.metadata)).not.toContain("bb_visible_key");
    expect(JSON.stringify(result.metadata)).not.toContain("secret-token");
    expect(JSON.stringify(result.metadata)).not.toContain("raw response body");
  });

  it("approval failure does not fallback", async () => {
    const calls: string[] = [];
    const backend = createBrowserbaseBrowserBackend({
      apiKey: "bb_test_key",
      projectId: "project_123",
      cloudSpendApproved: "pending",
      cloudFallback: true,
      client: createClient({ calls }),
      createSupervisedBackend: () => {
        throw new Error("fallback should not be created");
      }
    });

    await expect(backend.navigate({ url: "https://example.com" })).rejects.toThrow(/may incur charges/);
    expect(calls).toEqual([]);
  });

  it("releases Browserbase session if later CDP initialization fails", async () => {
    const calls: string[] = [];
    const backend = createBrowserbaseBrowserBackend({
      apiKey: "bb_test_key",
      projectId: "project_123",
      cloudSpendApproved: true,
      cloudFallback: false,
      client: createClient({ calls, sessionId: "bb-session-failed-cdp" }),
      createSupervisedBackend: () => createFakeBackend({ failNavigate: new Error("CDP init failed") })
    });

    await expect(backend.navigate({ url: "https://example.com" })).rejects.toThrow("CDP init failed");
    expect(calls).toEqual(["createSession", "closeSession:bb-session-failed-cdp"]);
  });

  it("status exposes safe fallback metadata after fallback", async () => {
    const backend = createBrowserbaseBrowserBackend({
      apiKey: "bb_test_key",
      projectId: "project_123",
      cloudSpendApproved: true,
      client: createClient({ createError: new Error("Browserbase POST /v1/sessions failed with rate limit error (429).") }),
      createSupervisedBackend: () => createFakeBackend()
    });

    await backend.navigate({ url: "https://example.com" });

    expect(await backend.status()).toMatchObject({
      backend: "browserbase",
      fallbackFromCloud: true,
      fallbackProvider: "browserbase",
      fallbackReason: "Browserbase rate limit error."
    });
  });
});
