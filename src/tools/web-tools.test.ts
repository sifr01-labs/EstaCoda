import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserActionInput, BrowserActionPreflight, BrowserBackend, BrowserNavigateInput } from "../contracts/browser.js";
import type { GroupedSecureInputRequestHandler } from "../contracts/secure-input.js";
import type { ResolvedAuxiliaryRoute, ResolvedModelRoute } from "../contracts/provider.js";
import type { ManagedPythonCapabilityInstallStatus } from "../python-env/capability-manager.js";
import { DDGS_CAPABILITY_ID } from "../python-env/capability-registry.js";
import type { ProviderExecutor, ProviderExecutionResult } from "../providers/provider-executor.js";
import { ArtifactStore } from "../artifacts/artifact-store.js";
import { createMockBrowserBackend, createUnconfiguredBrowserBackend } from "../browser/browser-backend.js";
import { BrowserTargetError } from "../browser/browser-locator.js";
import { BrowserSessionStateError } from "../browser/session-state.js";
import { ephemeralVisionImages } from "../vision/ephemeral-vision-content.js";
import { createGovernedVisionArtifactDispatcher, createVisionTools } from "./vision-tools.js";
import { createWebTools, webToolProvider, type FetchLike, type WebToolOptions } from "./web-tools.js";
import { registerWebResearchProvider, resetWebResearchProvidersForTest } from "./web-research-registry.js";
import type { WebResearchProvider, WebResearchSubprocess, WebResearchSubprocessSpawn } from "./web-research-provider.js";

const expectedToolNames = [
  "web.search",
  "web.extract",
  "web.crawl",
  "browser.status",
  "browser.snapshot",
  "browser.find",
  "browser.click",
  "browser.type",
  "browser.fill_protected_form",
  "browser.select",
  "browser.extract",
  "browser.scroll",
  "browser.press",
  "browser.back",
  "browser.get_images",
  "browser.console",
  "browser.tabs",
  "browser.switch_tab",
  "browser.cdp",
  "browser.screenshot",
  "browser.vision",
  "browser.dialog",
  "browser.navigate"
];

class FakeWebResearchSubprocess extends EventEmitter implements WebResearchSubprocess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => true);

  override on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  override on(event: "error", listener: (error: Error) => void): this;
  override on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }
}

function tool(name: string, tools = createWebTools()) {
  const found = tools.find((candidate) => candidate.name === name);
  if (found === undefined) {
    throw new Error(`Missing tool ${name}`);
  }
  return found;
}

function createTestWebTools(options: WebToolOptions = {}) {
  return createWebTools({
    currentSessionId: () => "test-runtime-session",
    ...options
  });
}

function createFetchResponse(input: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  contentType?: string | null;
  location?: string | null;
  body: string;
  onText?: () => void;
}): Awaited<ReturnType<FetchLike>> {
  return {
    ok: input.ok ?? true,
    status: input.status ?? 200,
    statusText: input.statusText ?? "OK",
    headers: {
      get: (name) => {
        const normalized = name.toLowerCase();
        if (normalized === "content-type") return input.contentType ?? "text/html";
        if (normalized === "location") return input.location ?? null;
        return null;
      }
    },
    text: async () => {
      input.onText?.();
      return input.body;
    }
  };
}

function createDdgsSpawn(response: { results: unknown[] }): WebResearchSubprocessSpawn {
  return vi.fn<WebResearchSubprocessSpawn>(() => {
    const child = new FakeWebResearchSubprocess();
    queueMicrotask(() => {
      child.stdout.write(JSON.stringify(response));
      child.emit("close", 0, null);
    });
    return child;
  });
}

function installedDdgsStatus(status: "installed" | "verified"): ManagedPythonCapabilityInstallStatus {
  return {
    ok: true,
    status,
    capabilityId: DDGS_CAPABILITY_ID,
    version: "9.14.4",
    specHash: "hash",
    installedGroups: [],
    installedPackages: ["ddgs==9.14.4"],
    pythonPath: "/managed/python",
    envPath: "/managed/env",
    manifest: {
      id: DDGS_CAPABILITY_ID,
      version: "9.14.4",
      specHash: "hash",
      installedPackages: ["ddgs==9.14.4"],
      installedGroups: [],
      pythonPath: "/managed/python",
      envPath: "/managed/env",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      status
    }
  };
}

const publicResolver = async (hostname: string) => hostname === "localhost"
  ? ["127.0.0.1"]
  : ["93.184.216.34"];

const VALID_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64"
);

const summaryModelProfile = {
  id: "summary-model",
  provider: "openai" as const,
  contextWindowTokens: 128_000,
  supportsTools: false,
  supportsVision: false,
  supportsStructuredOutput: true
};

const summaryRoute: ResolvedModelRoute = {
  provider: "openai",
  id: "summary-model",
  profile: summaryModelProfile
};

const snapshotAuxiliaryRoute: ResolvedAuxiliaryRoute = {
  task: "compression",
  route: summaryRoute,
  source: "explicit",
  fallbackToMain: false,
  diagnostics: []
};

const visionRoute: ResolvedModelRoute = {
  provider: "openai",
  id: "vision-model",
  baseUrl: "https://api.openai.com/v1",
  profile: {
    ...summaryModelProfile,
    id: "vision-model",
    supportsVision: true
  }
};

function visionAuxiliaryRoute(
  source: ResolvedAuxiliaryRoute["source"] = "explicit"
): ResolvedAuxiliaryRoute {
  return {
    task: "vision",
    route: visionRoute,
    source,
    fallbackToMain: false,
    diagnostics: []
  };
}

function createVisionScreenshotBackend(screenshot = vi.fn(async () => ({
  mimeType: "image/png" as const,
  base64: VALID_PNG.toString("base64")
}))): BrowserBackend {
  return { ...createMockBrowserBackend(), screenshot };
}

function okProviderResult(content: string): ProviderExecutionResult {
  return {
    ok: true,
    response: {
      ok: true,
      content,
      provider: "openai",
      model: "summary-model"
    },
    fallbackUsed: false,
    attempts: [{ provider: "openai", model: "summary-model", state: "dispatched", dispatchedAt: "2030-01-01T00:00:00.000Z", ok: true, content }],
    toolCalls: []
  };
}

function createSummaryExecutor(content: string): Pick<ProviderExecutor, "complete"> {
  return {
    complete: vi.fn(async () => okProviderResult(content))
  };
}

function browserIdentity(actionRevision: number, documentEpoch = 1, observationId = actionRevision) {
  return { documentEpoch, actionRevision, observationId };
}

function createLargeSnapshotBackend(text = "Snapshot text. ".repeat(800)): BrowserBackend {
  return {
    ...createMockBrowserBackend(),
    snapshot: async () => ({
      sessionId: "session-1",
      url: "https://example.com/",
      identity: browserIdentity(1),
      observedAt: "2026-08-13T00:00:00.000Z",
      title: "Large Snapshot",
      text,
      elements: [
        { ref: "@e1", role: "button", name: "Save" },
        { ref: "@e2", role: "textbox", name: "Email", value: "ada@example.com" }
      ]
    })
  };
}

function createInvalidRefBackend(): BrowserBackend {
  const backend = createMockBrowserBackend();
  return {
    ...backend,
    click: async (input) => {
      throw new Error(`Invalid browser element ref: ${input.ref ?? ""}`);
    }
  };
}

function createRecordingCdpBackend(calls: BrowserActionInput[] = []): BrowserBackend {
  return {
    ...createMockBrowserBackend(),
    cdp: async (input) => {
      calls.push(input);
      return {
        method: input.method,
        params: input.params ?? {}
      };
    }
  };
}

function createSessionRecordingBrowserBackend(calls: Array<{ method: string; input: BrowserActionInput | BrowserNavigateInput }> = []): BrowserBackend {
  const snapshotFor = (input: BrowserActionInput | BrowserNavigateInput = {}): ReturnType<NonNullable<BrowserBackend["snapshot"]>> extends Promise<infer T> ? T : never => ({
    sessionId: input.sessionId ?? "missing-session",
    url: "https://example.com/",
    identity: browserIdentity(1),
    observedAt: "2026-08-13T00:00:00.000Z",
    title: "Recorded Browser Page",
    text: `Recorded browser snapshot for ${input.sessionId ?? "missing-session"}.`,
    tab: { ref: "@t1", url: "https://example.com/", title: "Recorded Browser Page", controlled: true },
    elements: [{ ref: "@e1", role: "button", name: "Recorded Button" }]
  });

  return {
    kind: "mock",
    isAvailable: () => true,
    status: () => ({ backend: "mock", available: true }),
    navigate: async (input) => {
      calls.push({ method: "navigate", input });
      return {
        session: {
          id: input.sessionId ?? "missing-session",
          backend: "mock",
          currentUrl: input.url,
          createdAt: "2026-04-18T00:00:00.000Z"
        },
        snapshot: {
          ...snapshotFor(input),
          url: input.url
        }
      };
    },
    snapshot: async (input = {}) => {
      calls.push({ method: "snapshot", input });
      return snapshotFor(input);
    },
    find: async (input) => {
      calls.push({ method: "find", input });
      return {
        sessionId: input.sessionId ?? "missing-session",
        identity: browserIdentity(1),
        tabRef: "@t1",
        status: "found",
        candidates: [{ ref: "@e1", identity: browserIdentity(1), tabRef: "@t1", role: "button", name: "Recorded Button" }]
      };
    },
    click: async (input) => {
      calls.push({ method: "click", input });
      return snapshotFor(input);
    },
    type: async (input) => {
      calls.push({ method: "type", input });
      return snapshotFor(input);
    },
    select: async (input) => {
      calls.push({ method: "select", input });
      return snapshotFor(input);
    },
    extract: async (input) => {
      calls.push({ method: "extract", input });
      return {
        sessionId: input.sessionId ?? "missing-session",
        identity: browserIdentity(1),
        tabRef: "@t1",
        target: { ref: "@e1", identity: browserIdentity(1), tabRef: "@t1", role: "button", name: "Recorded Button" },
        text: "Recorded Button"
      };
    },
    scroll: async (input) => {
      calls.push({ method: "scroll", input });
      return snapshotFor(input);
    },
    press: async (input) => {
      calls.push({ method: "press", input });
      return snapshotFor(input);
    },
    back: async (input = {}) => {
      calls.push({ method: "back", input });
      return snapshotFor(input);
    },
    getImages: async (input = {}) => {
      calls.push({ method: "getImages", input });
      return [{ src: "https://example.com/recorded.png", alt: "Recorded image" }];
    },
    console: async (input = {}) => {
      calls.push({ method: "console", input });
      return [{ level: "log", text: `Recorded console for ${input.sessionId ?? "missing-session"}` }];
    },
    tabs: async (input = {}) => {
      calls.push({ method: "tabs", input });
      return {
        sessionId: input.sessionId ?? "missing-session",
        tabs: [
          { ref: "@t1", url: "https://example.com/", title: "Main", controlled: true },
          { ref: "@t2", url: "https://example.com/details", title: "Details", controlled: false }
        ],
        blockedCount: 1
      };
    },
    switchTab: async (input) => {
      calls.push({ method: "switchTab", input });
      const tab = { ref: input.tabRef, url: "https://example.com/details", title: "Details", controlled: true };
      return {
        tab,
        snapshot: {
          ...snapshotFor(input),
          url: tab.url,
          title: tab.title,
          tab
        }
      };
    },
    cdp: async (input) => {
      calls.push({ method: "cdp", input });
      return { method: input.method ?? "Browser.getVersion" };
    },
    screenshot: async (input = {}) => {
      calls.push({ method: "screenshot", input });
      return {
        mimeType: "image/png",
        base64: "iVBORw0KGgo="
      };
    },
    dialog: async (input = {}) => {
      calls.push({ method: "dialog", input });
      return snapshotFor(input);
    }
  };
}

describe("web and browser tools baselines", () => {
  let tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
    tempRoots = [];
    resetWebResearchProvidersForTest();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("exposes the expected browser and web tool names", () => {
    expect(createWebTools().map((candidate) => candidate.name)).toEqual(expectedToolNames);
  });

  it("reports unavailable web.search when no backend is configured", async () => {
    const search = tool("web.search", createWebTools());

    await expect(search.isAvailable()).resolves.toBe(false);
    const result = await search.run({ query: "estacoda" });

    expect(result).toMatchObject({
      ok: false,
      metadata: {
        capability: "search",
        reason: "No available web search provider configured.",
        explicit: false,
        fallback: false
      }
    });
  });

  it("returns explicit web.search provider unavailable reasons without calling the provider", async () => {
    const searchImpl = vi.fn();
    registerWebResearchProvider({
      name: "offline-search",
      displayName: "Offline Search",
      capabilities: { search: true },
      getAvailability: () => ({ available: false, reason: "offline search" }),
      search: searchImpl
    });
    const search = tool("web.search", createWebTools({ webConfig: { searchBackend: "offline-search" } }));

    await expect(search.isAvailable()).resolves.toBe(false);
    const result = await search.run({ query: "estacoda" });

    expect(result).toMatchObject({
      ok: false,
      metadata: {
        provider: "offline-search",
        capability: "search",
        reason: "offline search",
        explicit: true
      }
    });
    expect(searchImpl).not.toHaveBeenCalled();
  });

  it("formats web.search results from an available provider", async () => {
    registerWebResearchProvider({
      name: "mock-search",
      displayName: "Mock Search",
      capabilities: { search: true },
      getAvailability: () => ({ available: true }),
      search: async () => [{
        title: "Example Result",
        url: "https://example.com/result",
        snippet: "Example snippet"
      }]
    });
    const search = tool("web.search", createWebTools({ webConfig: { searchBackend: "mock-search" } }));

    await expect(search.isAvailable()).resolves.toBe(true);
    const result = await search.run({ query: "estacoda" });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("1. Example Result");
    expect(result.content).toContain("https://example.com/result");
    expect(result.content).toContain("Example snippet");
    expect(result.metadata).toMatchObject({
      provider: "mock-search",
      _estacoda_context_summary: "Web search returned 1 result(s). Top sources: Example Result (example.com).",
      results: [{
        title: "Example Result",
        url: "https://example.com/result",
        snippet: "Example snippet"
      }]
    });
  });

  it("passes Brave credential env config through provider wiring for explicit search selection", async () => {
    const configure = vi.fn((context: { config: { searchBackend?: string; brave?: { apiKeyEnv?: string } } }): WebResearchProvider => ({
      name: "brave",
      displayName: "Brave Search",
      capabilities: { search: true },
      getAvailability: () => ({
        available: context.config.brave?.apiKeyEnv === "CUSTOM_BRAVE_KEY",
        reason: context.config.brave?.apiKeyEnv
      }),
      search: async () => [{
        title: "Configured Brave",
        url: "https://example.com/brave",
        snippet: context.config.brave?.apiKeyEnv
      }]
    }));
    const tools = createWebTools({
      webConfig: {
        searchBackend: "brave",
        brave: {
          apiKeyEnv: "CUSTOM_BRAVE_KEY"
        }
      }
    });
    registerWebResearchProvider({
      name: "brave",
      displayName: "Brave Search",
      capabilities: { search: true },
      configure,
      getAvailability: () => ({ available: false, reason: "not configured" })
    });
    const search = tool("web.search", tools);

    await expect(search.isAvailable()).resolves.toBe(true);
    const result = await search.run({ query: "estacoda" });

    expect(configure).toHaveBeenCalledWith(expect.objectContaining({
      config: {
        searchBackend: "brave",
        brave: {
          apiKeyEnv: "CUSTOM_BRAVE_KEY"
        }
      }
    }));
    expect(result).toMatchObject({
      ok: true,
      metadata: {
        provider: "brave",
        results: [{
          title: "Configured Brave",
          url: "https://example.com/brave",
          snippet: "CUSTOM_BRAVE_KEY"
        }]
      }
    });
  });

  it("uses mocked Brave web.search and formats snippets and metadata", async () => {
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "brave-token");
    const fetch = vi.fn(async (_url: string, _init?: Parameters<FetchLike>[1]) => createFetchResponse({
      contentType: "application/json",
      body: JSON.stringify({
        web: {
          results: [{
            title: "Brave Result",
            url: "https://example.com/brave-result",
            description: "Brave snippet from API"
          }]
        }
      })
    }));
    const search = tool("web.search", createWebTools({
      fetch,
      webConfig: {
        searchBackend: "brave"
      }
    }));

    await expect(search.isAvailable()).resolves.toBe(true);
    const result = await search.run({ query: "estacoda", maxResults: 3 });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect((fetch.mock.calls[0] as [string, Parameters<FetchLike>[1]])[0]).toBe("https://api.search.brave.com/res/v1/web/search?q=estacoda&count=3");
    expect(result.ok).toBe(true);
    expect(result.content).toContain("1. Brave Result");
    expect(result.content).toContain("https://example.com/brave-result");
    expect(result.content).toContain("Brave snippet from API");
    expect(result.metadata).toMatchObject({
      provider: "brave",
      _estacoda_context_summary: "Web search returned 1 result(s). Top sources: Brave Result (example.com).",
      results: [{
        title: "Brave Result",
        url: "https://example.com/brave-result",
        snippet: "Brave snippet from API"
      }]
    });
  });

  it("uses mocked DDGS web.search and formats snippets and metadata", async () => {
    const spawnProcess = createDdgsSpawn({
      results: [{
        title: "DDGS Result",
        href: "https://example.com/ddgs-result",
        body: "DDGS snippet from Python"
      }]
    });
    const search = tool("web.search", createWebTools({
      webConfig: {
        searchBackend: "ddgs"
      },
      pythonStateRoot: "/state",
      pythonCapabilityStatusChecker: vi.fn(async () => installedDdgsStatus("verified")),
      pythonCapabilityPathResolver: vi.fn(() => ({
        envPath: "/managed/env",
        pythonPath: "/managed/python",
        pipCacheDir: "/managed/pip-cache",
        manifestPath: "/managed/env/env.json"
      })),
      subprocessSpawn: spawnProcess
    }));

    await expect(search.isAvailable()).resolves.toBe(true);
    const result = await search.run({ query: "estacoda", maxResults: 3 });

    expect(spawnProcess).toHaveBeenCalledWith("/managed/python", expect.any(Array), {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"]
    });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("1. DDGS Result");
    expect(result.content).toContain("https://example.com/ddgs-result");
    expect(result.content).toContain("DDGS snippet from Python");
    expect(result.metadata).toMatchObject({
      provider: "ddgs",
      _estacoda_context_summary: "Web search returned 1 result(s). Top sources: DDGS Result (example.com).",
      results: [{
        title: "DDGS Result",
        url: "https://example.com/ddgs-result",
        snippet: "DDGS snippet from Python"
      }]
    });
  });

  it("reports unavailable web.crawl when no backend is configured", async () => {
    const crawl = tool("web.crawl", createWebTools({ resolveHostname: publicResolver }));

    await expect(crawl.isAvailable()).resolves.toBe(false);
    const result = await crawl.run({ url: "https://example.com" });

    expect(result).toMatchObject({
      ok: false,
      metadata: {
        capability: "crawl",
        reason: "No available web crawl provider configured.",
        explicit: false,
        fallback: false
      }
    });
  });

  it("formats web.crawl pages from an available provider", async () => {
    registerWebResearchProvider({
      name: "mock-crawl",
      displayName: "Mock Crawl",
      capabilities: { crawl: true },
      getAvailability: () => ({ available: true }),
      crawl: async () => ({
        url: "https://example.com",
        pages: [{
          url: "https://example.com",
          title: "Home",
          content: "Crawled content"
        }]
      })
    });
    const crawl = tool("web.crawl", createWebTools({
      webConfig: { crawlBackend: "mock-crawl" },
      resolveHostname: publicResolver
    }));

    await expect(crawl.isAvailable()).resolves.toBe(true);
    const result = await crawl.run({ url: "https://example.com" });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("1. Home");
    expect(result.content).toContain("Crawled content");
    expect(result.metadata).toMatchObject({
      provider: "mock-crawl",
      url: "https://example.com/",
      pages: [{
        url: "https://example.com",
        title: "Home",
        content: "Crawled content"
      }]
    });
  });

  it("extracts readable content with the fetch fallback", async () => {
    const fetch = vi.fn(async () => createFetchResponse({
      body: "<html><head><title>Example Title</title></head><body><main>Hello world.</main></body></html>"
    }));
    const extract = tool("web.extract", createWebTools({ fetch, enableNetwork: true, resolveHostname: publicResolver }));

    const result = await extract.run({ url: "https://example.com/article" });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("URL: https://example.com/article");
    expect(result.content).toContain("Title: Example Title");
    expect(result.content).toContain("Status: 200 OK");
    expect(result.content).toContain("Hello world.");
    expect(result.metadata).toEqual({
      url: "https://example.com/article",
      title: "Example Title",
      content: "Example Title Hello world.",
      contentType: "text/html",
      status: 200,
      source: "fetch",
      _estacoda_context_summary: "Extracted 26 chars from https://example.com/article using fetch. Title: Example Title. Status: 200."
    });
    expect(fetch).toHaveBeenCalledWith("https://example.com/article", expect.objectContaining({ method: "GET", redirect: "manual" }));
  });

  it("emits bounded web.search context summary metadata", async () => {
    registerWebResearchProvider({
      name: "mock-search",
      displayName: "Mock Search",
      capabilities: { search: true },
      getAvailability: () => ({ available: true }),
      search: async () => Array.from({ length: 8 }, (_, index) => ({
        title: `Very long result title ${index + 1} `.repeat(10),
        url: `https://example${index + 1}.com/result`,
        snippet: `Snippet ${index + 1}`
      }))
    });
    const search = tool("web.search", createWebTools({ webConfig: { searchBackend: "mock-search" } }));

    const result = await search.run({ query: "estacoda", maxResults: 8 });
    const summary = result.metadata?._estacoda_context_summary;

    expect(result.ok).toBe(true);
    expect(typeof summary).toBe("string");
    expect(summary).toContain("Web search returned 8 result(s).");
    expect(summary).toContain("example1.com");
    expect(String(summary).length).toBeLessThanOrEqual(500);
    expect(summary).not.toContain("Snippet");
  });

  it("emits bounded web.extract context summary metadata", async () => {
    const fetch = vi.fn(async () => createFetchResponse({
      body: "<html><head><title>Long Extract</title></head><body><main>Readable content.</main></body></html>"
    }));
    const extract = tool("web.extract", createWebTools({ fetch, enableNetwork: true, resolveHostname: publicResolver }));

    const result = await extract.run({ url: "https://example.com/long" });
    const summary = result.metadata?._estacoda_context_summary;

    expect(result.ok).toBe(true);
    expect(typeof summary).toBe("string");
    expect(summary).toContain("Extracted");
    expect(summary).toContain("https://example.com/long");
    expect(summary).toContain("Long Extract");
    expect(String(summary).length).toBeLessThanOrEqual(500);
    expect(summary).not.toContain("Readable content.");
  });

  it("omits debug payloads when browser debug is disabled", async () => {
    const fetch = vi.fn(async () => createFetchResponse({ body: "public page" }));
    const extract = tool("web.extract", createWebTools({
      fetch,
      enableNetwork: true,
      resolveHostname: publicResolver
    }));

    const result = await extract.run({ url: "https://example.com/article" });

    expect(result.ok).toBe(true);
    expect(result.metadata).not.toHaveProperty("debug");
  });

  it("includes bounded web.extract debug metadata when enabled", async () => {
    vi.stubEnv("ESTACODA_WEB_TOOLS_DEBUG", "true");
    const fetch = vi.fn(async (url: string) => url === "https://example.com/start?token=debug-secret"
      ? createFetchResponse({
        status: 302,
        statusText: "Found",
        location: "https://example.com/final",
        body: ""
      })
      : createFetchResponse({ body: "<html><body>debug content</body></html>" }));
    const extract = tool("web.extract", createWebTools({
      fetch,
      enableNetwork: true,
      resolveHostname: publicResolver
    }));

    const result = await extract.run({ url: "https://example.com/start?token=debug-secret" });

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("debug-secret");
    expect(result.metadata).toMatchObject({
      url: "[REDACTED_URL_WITH_SECRET]",
      reason: "secret-in-url",
      debug: expect.arrayContaining([
        expect.objectContaining({
          event: "web.extract.start",
          data: { url: "[REDACTED_URL_WITH_SECRET]" }
        }),
        expect.objectContaining({
          event: "web.extract.blocked",
          data: expect.objectContaining({ reason: "secret-in-url" })
        })
      ])
    });
  });

  it("web.extract debug records fetch status, redirect count, and content length", async () => {
    vi.stubEnv("ESTACODA_BROWSER_DEBUG", "true");
    const fetch = vi.fn(async (url: string) => url === "https://example.com/start"
      ? createFetchResponse({
        status: 302,
        statusText: "Found",
        location: "https://example.com/final",
        body: ""
      })
      : createFetchResponse({ body: "<html><body>debug content</body></html>" }));
    const extract = tool("web.extract", createWebTools({
      fetch,
      enableNetwork: true,
      resolveHostname: publicResolver
    }));

    const result = await extract.run({ url: "https://example.com/start" });

    expect(result.ok).toBe(true);
    expect(result.metadata).toMatchObject({
      status: 200,
      debug: expect.arrayContaining([
        expect.objectContaining({
          event: "web.extract.complete",
          data: expect.objectContaining({
            provider: "fetch",
            url: "https://example.com/final",
            status: 200,
            redirectCount: 1,
            contentLength: expect.any(Number)
          })
        })
      ])
    });
  });

  it("does not silently fall back when explicit web.extract provider is unavailable", async () => {
    const fetch = vi.fn(async () => createFetchResponse({ body: "should not fetch" }));
    const extractImpl = vi.fn();
    registerWebResearchProvider({
      name: "offline-extract",
      displayName: "Offline Extract",
      capabilities: { extract: true },
      getAvailability: () => ({ available: false, reason: "offline extract" }),
      extract: extractImpl
    } satisfies WebResearchProvider);
    const extract = tool("web.extract", createWebTools({
      fetch,
      enableNetwork: true,
      resolveHostname: publicResolver,
      webConfig: { extractBackend: "offline-extract" }
    }));

    const result = await extract.run({ url: "https://example.com/article" });

    expect(result).toMatchObject({
      ok: false,
      metadata: {
        provider: "offline-extract",
        capability: "extract",
        reason: "offline extract",
        explicit: true,
        fallback: false
      }
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(extractImpl).not.toHaveBeenCalled();
  });

  it("uses the guarded fetch fallback when web.extract explicitly selects fetch", async () => {
    const fetch = vi.fn(async () => createFetchResponse({
      body: "<html><body>explicit fetch</body></html>"
    }));
    const extract = tool("web.extract", createWebTools({
      fetch,
      enableNetwork: true,
      resolveHostname: publicResolver,
      webConfig: { extractBackend: "fetch" }
    }));

    const result = await extract.run({ url: "https://example.com/article" });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("explicit fetch");
    expect(result.metadata).toMatchObject({
      url: "https://example.com/article",
      source: "fetch"
    });
  });

  it("allows ordinary public URLs with mocked fetch", async () => {
    const fetch = vi.fn(async () => createFetchResponse({ body: "public page" }));
    const extract = tool("web.extract", createWebTools({
      fetch,
      enableNetwork: true,
      resolveHostname: publicResolver
    }));

    const result = await extract.run({ url: "https://example.com/public" });

    expect(result.ok).toBe(true);
    expect(result.metadata).toMatchObject({
      url: "https://example.com/public",
      status: 200,
      source: "fetch"
    });
  });

  it("blocks unsafe web.extract URLs before fetch", async () => {
    const fetch = vi.fn(async () => createFetchResponse({ body: "should not fetch" }));
    const extract = tool("web.extract", createWebTools({ fetch, enableNetwork: true }));

    await expect(extract.run({ url: "http://169.254.169.254" })).resolves.toMatchObject({
      ok: false,
      metadata: {
        url: "http://169.254.169.254/",
        reason: "unsafe-url"
      }
    });
    await expect(extract.run({ url: "http://localhost:8080" })).resolves.toMatchObject({
      ok: false,
      metadata: {
        url: "http://localhost:8080/",
        reason: "unsafe-url"
      }
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("blocks secret-bearing web.extract URLs without leaking raw values", async () => {
    const fetch = vi.fn(async () => createFetchResponse({ body: "should not fetch" }));
    const extract = tool("web.extract", createWebTools({ fetch, enableNetwork: true }));

    const result = await extract.run({ url: "https://example.com/?token=super-secret" });

    expect(result.ok).toBe(false);
    expect(result.metadata).toEqual({
      url: "[REDACTED_URL_WITH_SECRET]",
      reason: "secret-in-url"
    });
    expect(JSON.stringify(result)).not.toContain("super-secret");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("blocks website-policy web.extract URLs before fetch", async () => {
    const fetch = vi.fn(async () => createFetchResponse({ body: "should not fetch" }));
    const extract = tool("web.extract", createWebTools({
      fetch,
      enableNetwork: true,
      resolveHostname: publicResolver,
      securityConfig: {
        allowPrivateUrls: false,
        websiteBlocklist: { domains: ["blocked.test"] }
      }
    }));

    const result = await extract.run({ url: "https://blocked.test/page" });

    expect(result.ok).toBe(false);
    expect(result.metadata).toMatchObject({
      url: "https://blocked.test/page",
      reason: "website-policy",
      host: "blocked.test",
      matchedRule: "blocked.test"
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("allows ordinary private web.extract URLs only when configured", async () => {
    const fetch = vi.fn(async () => createFetchResponse({ body: "private page" }));
    const extract = tool("web.extract", createWebTools({
      fetch,
      enableNetwork: true,
      securityConfig: {
        allowPrivateUrls: true,
        websiteBlocklist: {}
      }
    }));

    const result = await extract.run({ url: "http://192.168.1.12/status" });

    expect(result.ok).toBe(true);
    expect(result.metadata).toMatchObject({
      url: "http://192.168.1.12/status",
      status: 200
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("still blocks metadata web.extract URLs when private URLs are allowed", async () => {
    const fetch = vi.fn(async () => createFetchResponse({ body: "metadata" }));
    const extract = tool("web.extract", createWebTools({
      fetch,
      enableNetwork: true,
      securityConfig: {
        allowPrivateUrls: true,
        websiteBlocklist: {}
      }
    }));

    const result = await extract.run({ url: "http://169.254.169.254/latest/meta-data" });

    expect(result.ok).toBe(false);
    expect(result.metadata).toMatchObject({
      url: "http://169.254.169.254/latest/meta-data",
      reason: "unsafe-url"
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("blocks unsafe web.extract redirects before reading the redirected body", async () => {
    const redirectedText = vi.fn();
    const fetch = vi.fn(async (url: string) => url === "https://example.com/start"
      ? createFetchResponse({ status: 302, statusText: "Found", location: "http://169.254.169.254/latest", body: "" })
      : createFetchResponse({ body: "metadata body", onText: redirectedText }));
    const extract = tool("web.extract", createWebTools({
      fetch,
      enableNetwork: true,
      resolveHostname: publicResolver
    }));

    const result = await extract.run({ url: "https://example.com/start" });

    expect(result.ok).toBe(false);
    expect(result.metadata).toMatchObject({
      url: "http://169.254.169.254/latest",
      reason: "redirect-unsafe-url"
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(redirectedText).not.toHaveBeenCalled();
  });

  it("blocks private web.extract redirects before reading the redirected body", async () => {
    const redirectedText = vi.fn();
    const fetch = vi.fn(async (url: string) => url === "https://example.com/start"
      ? createFetchResponse({ status: 302, statusText: "Found", location: "http://localhost:8080/private", body: "" })
      : createFetchResponse({ body: "private body", onText: redirectedText }));
    const extract = tool("web.extract", createWebTools({
      fetch,
      enableNetwork: true,
      resolveHostname: publicResolver
    }));

    const result = await extract.run({ url: "https://example.com/start" });

    expect(result.ok).toBe(false);
    expect(result.metadata).toMatchObject({
      url: "http://localhost:8080/private",
      reason: "redirect-unsafe-url"
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(redirectedText).not.toHaveBeenCalled();
  });

  it("blocks secret-bearing web.extract redirects without leaking raw redirect values", async () => {
    const fetch = vi.fn(async () => createFetchResponse({
      status: 302,
      statusText: "Found",
      location: "https://example.com/next?token=super-secret",
      body: ""
    }));
    const extract = tool("web.extract", createWebTools({
      fetch,
      enableNetwork: true,
      resolveHostname: publicResolver
    }));

    const result = await extract.run({ url: "https://example.com/start" });

    expect(result.ok).toBe(false);
    expect(result.metadata).toEqual({
      url: "[REDACTED_URL_WITH_SECRET]",
      reason: "redirect-secret-in-url"
    });
    expect(JSON.stringify(result)).not.toContain("super-secret");
  });

  it("returns deterministic metadata for web.extract redirect loops over the cap", async () => {
    const fetch = vi.fn(async () => createFetchResponse({
      status: 302,
      statusText: "Found",
      location: "/loop",
      body: ""
    }));
    const extract = tool("web.extract", createWebTools({
      fetch,
      enableNetwork: true,
      resolveHostname: publicResolver
    }));

    const result = await extract.run({ url: "https://example.com/loop" });

    expect(result.ok).toBe(false);
    expect(result.metadata).toEqual({
      url: "https://example.com/loop",
      reason: "too-many-redirects"
    });
    expect(fetch).toHaveBeenCalledTimes(11);
  });

  it("returns deterministic metadata when web.extract network is disabled", async () => {
    const extract = tool("web.extract", createWebTools({ enableNetwork: false }));

    const result = await extract.run({ url: "https://example.com/private" });

    expect(result.ok).toBe(false);
    expect(result.metadata).toEqual({
      url: "https://example.com/private",
      reason: "network-disabled"
    });
  });

  it("returns deterministic metadata when web.extract has no URL", async () => {
    const extract = tool("web.extract", createWebTools({ enableNetwork: true }));

    const result = await extract.run({ text: "there is nothing to fetch here" });

    expect(result.ok).toBe(false);
    expect(result.metadata).toEqual({ reason: "missing-url" });
  });

  it("keeps web.extract timeout failures in the existing fetch-failed shape", async () => {
    vi.useFakeTimers();
    const fetch: FetchLike = async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
    const extract = tool("web.extract", createWebTools({ fetch, enableNetwork: true, resolveHostname: publicResolver }));

    const resultPromise = extract.run({ url: "https://example.com" });
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await resultPromise;

    expect(result.ok).toBe(false);
    expect(result.content).toContain("Timed out after 30000ms");
    expect(result.metadata).toEqual(expect.objectContaining({
      url: "https://example.com/",
      reason: "fetch-failed"
    }));
  });

  it("navigates with the mock browser backend and includes backend metadata", async () => {
    const navigate = tool("browser.navigate", createTestWebTools({
      browserBackend: createMockBrowserBackend({ sessionId: "nav-session", title: "Nav Title", text: "Nav text." }),
      resolveHostname: publicResolver
    }));

    const result = await navigate.run({ url: "https://example.com/app" });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Browser: mock");
    expect(result.content).toContain("Session: test-runtime-session:main");
    expect(result.content).toContain("URL: https://example.com/app");
    expect(result.content).toContain("Identity: documentEpoch=1 actionRevision=1 observationId=1");
    expect(result.metadata).toMatchObject({
      url: "https://example.com/app",
      backend: "mock",
      session: {
        id: "test-runtime-session:main",
        backend: "mock",
        currentUrl: "https://example.com/app"
      }
    });
  });

  it("propagates browser.navigate backend metadata such as cloud fallback details", async () => {
    const browserBackend: BrowserBackend = {
      ...createMockBrowserBackend({ sessionId: "nav-session", title: "Nav Title", text: "Nav text." }),
      kind: "browserbase",
      async navigate(input) {
        return {
          session: {
            id: input.sessionId ?? "nav-session",
            backend: "local-cdp",
            currentUrl: input.url,
            createdAt: "2026-06-07T00:00:00.000Z"
          },
          snapshot: {
            sessionId: input.sessionId ?? "nav-session",
            url: input.url,
            identity: browserIdentity(1),
            observedAt: "2026-08-13T00:00:00.000Z",
            text: "Fallback snapshot."
          },
          metadata: {
            fallbackFromCloud: true,
            fallbackProvider: "browserbase",
            fallbackReason: "Browserbase network error."
          }
        };
      }
    };
    const navigate = tool("browser.navigate", createTestWebTools({
      browserBackend,
      resolveHostname: publicResolver
    }));

    const result = await navigate.run({ url: "https://example.com/app" });

    expect(result.ok).toBe(true);
    expect(result.metadata).toMatchObject({
      backend: "local-cdp",
      fallbackFromCloud: true,
      fallbackProvider: "browserbase",
      fallbackReason: "Browserbase network error."
    });
  });

  it.each([
    "Cloudflare",
    "Just a moment",
    "Access Denied",
    "CAPTCHA required"
  ])("warns when browser.navigate reaches a likely bot-detection page: %s", async (title) => {
    const navigate = tool("browser.navigate", createTestWebTools({
      browserBackend: createMockBrowserBackend({ title, text: "Challenge page." }),
      resolveHostname: publicResolver
    }));

    const result = await navigate.run({ url: "https://example.com/app" });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Warning: The page may be showing a bot-detection, CAPTCHA, or access-denied interstitial.");
  });

  it("does not warn for normal browser.navigate page titles", async () => {
    const navigate = tool("browser.navigate", createTestWebTools({
      browserBackend: createMockBrowserBackend({ title: "Example Domain", text: "Normal page." }),
      resolveHostname: publicResolver
    }));

    const result = await navigate.run({ url: "https://example.com/app" });

    expect(result.ok).toBe(true);
    expect(result.content).not.toContain("Warning:");
  });

  it("reports unconfigured browser.navigate without calling a backend", async () => {
    const navigate = tool("browser.navigate", createTestWebTools({
      browserBackend: createUnconfiguredBrowserBackend(),
      resolveHostname: publicResolver
    }));

    const result = await navigate.run({ url: "https://example.com/app" });

    expect(result.ok).toBe(false);
    expect(result.metadata).toEqual({
      url: "https://example.com/app",
      backend: "unconfigured"
    });
  });

  it("blocks unsafe browser.navigate URLs before backend availability checks", async () => {
    const backend = createUnconfiguredBrowserBackend();
    const navigate = tool("browser.navigate", createTestWebTools({ browserBackend: backend }));

    await expect(navigate.run({ url: "http://169.254.169.254" })).resolves.toMatchObject({
      ok: false,
      metadata: {
        url: "http://169.254.169.254/",
        backend: "unconfigured",
        reason: "unsafe-url"
      }
    });
    await expect(navigate.run({ url: "http://localhost:8080" })).resolves.toMatchObject({
      ok: false,
      metadata: {
        url: "http://localhost:8080/",
        backend: "unconfigured",
        reason: "unsafe-url"
      }
    });
  });

  it("browser.navigate debug enabled includes redacted URL and blocked reason", async () => {
    vi.stubEnv("ESTACODA_BROWSER_DEBUG", "true");
    const navigate = tool("browser.navigate", createTestWebTools({
      browserBackend: createMockBrowserBackend()
    }));

    const result = await navigate.run({ url: "https://example.com/?api_key=nav-debug-secret" });

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("nav-debug-secret");
    expect(result.metadata).toMatchObject({
      url: "[REDACTED_URL_WITH_SECRET]",
      backend: "mock",
      reason: "secret-in-url",
      debug: expect.arrayContaining([
        expect.objectContaining({
          event: "browser.navigate.start",
          data: { backend: "mock", requestedUrl: "[REDACTED_URL_WITH_SECRET]" }
        }),
        expect.objectContaining({
          event: "browser.navigate.blocked",
          data: expect.objectContaining({ backend: "mock", reason: "secret-in-url" })
        })
      ])
    });
  });

  it("blocks secret-bearing browser.navigate URLs without leaking raw values", async () => {
    const navigate = tool("browser.navigate", createTestWebTools({
      browserBackend: createMockBrowserBackend()
    }));

    const result = await navigate.run({ url: "https://example.com/?api_key=nav-secret" });

    expect(result.ok).toBe(false);
    expect(result.metadata).toEqual({
      url: "[REDACTED_URL_WITH_SECRET]",
      backend: "mock",
      reason: "secret-in-url"
    });
    expect(JSON.stringify(result)).not.toContain("nav-secret");
  });

  it("blocks website-policy browser.navigate URLs before backend availability checks", async () => {
    const navigate = tool("browser.navigate", createTestWebTools({
      browserBackend: createMockBrowserBackend(),
      resolveHostname: publicResolver,
      securityConfig: {
        allowPrivateUrls: false,
        websiteBlocklist: { domains: ["blocked.test"] }
      }
    }));

    const result = await navigate.run({ url: "https://blocked.test/page" });

    expect(result.ok).toBe(false);
    expect(result.metadata).toMatchObject({
      url: "https://blocked.test/page",
      backend: "mock",
      reason: "website-policy",
      host: "blocked.test",
      matchedRule: "blocked.test"
    });
  });

  it("blocks browser.navigate post-navigation redirects and blanks the browser session", async () => {
    const calls: string[] = [];
    const backend: BrowserBackend = {
      ...createMockBrowserBackend({ sessionId: "redirect-session" }),
      async navigate(input) {
        calls.push(input.url);
        return {
          session: {
            id: input.sessionId ?? "redirect-session",
            backend: "mock",
            currentUrl: input.url,
            createdAt: "2026-04-18T00:00:00.000Z"
          },
          snapshot: {
            sessionId: input.sessionId ?? "redirect-session",
            url: input.url === "about:blank" ? "about:blank" : "http://169.254.169.254/latest",
            identity: browserIdentity(1),
            observedAt: "2026-08-13T00:00:00.000Z",
            text: "redirected"
          }
        };
      }
    };
    const navigate = tool("browser.navigate", createTestWebTools({
      browserBackend: backend,
      resolveHostname: publicResolver
    }));

    const result = await navigate.run({ url: "https://example.com/start" });

    expect(result.ok).toBe(false);
    expect(result.metadata).toMatchObject({
      url: "https://example.com/start",
      finalUrl: "http://169.254.169.254/latest",
      backend: "mock",
      reason: "post-redirect-always-blocked"
    });
    expect(calls).toEqual(["https://example.com/start", "about:blank"]);
  });

  it("blocks browser.navigate post-navigation private redirects and blanks the browser session", async () => {
    const calls: string[] = [];
    const backend: BrowserBackend = {
      ...createMockBrowserBackend({ sessionId: "private-redirect-session" }),
      async navigate(input) {
        calls.push(input.url);
        return {
          session: {
            id: input.sessionId ?? "private-redirect-session",
            backend: "mock",
            currentUrl: input.url,
            createdAt: "2026-04-18T00:00:00.000Z"
          },
          snapshot: {
            sessionId: input.sessionId ?? "private-redirect-session",
            url: input.url === "about:blank" ? "about:blank" : "http://192.168.1.1/admin",
            identity: browserIdentity(1),
            observedAt: "2026-08-13T00:00:00.000Z",
            text: "redirected"
          }
        };
      }
    };
    const navigate = tool("browser.navigate", createTestWebTools({
      browserBackend: backend,
      resolveHostname: publicResolver
    }));

    const result = await navigate.run({ url: "https://example.com/start" });

    expect(result.ok).toBe(false);
    expect(result.metadata).toMatchObject({
      url: "https://example.com/start",
      finalUrl: "http://192.168.1.1/admin",
      backend: "mock",
      reason: "post-redirect-unsafe"
    });
    expect(calls).toEqual(["https://example.com/start", "about:blank"]);
  });

  it("blocks browser.navigate post-navigation website-policy redirects and blanks the browser session", async () => {
    const calls: string[] = [];
    const backend: BrowserBackend = {
      ...createMockBrowserBackend({ sessionId: "policy-redirect-session" }),
      async navigate(input) {
        calls.push(input.url);
        return {
          session: {
            id: input.sessionId ?? "policy-redirect-session",
            backend: "mock",
            currentUrl: input.url,
            createdAt: "2026-04-18T00:00:00.000Z"
          },
          snapshot: {
            sessionId: input.sessionId ?? "policy-redirect-session",
            url: input.url === "about:blank" ? "about:blank" : "https://blocked.test/final",
            identity: browserIdentity(1),
            observedAt: "2026-08-13T00:00:00.000Z",
            text: "redirected"
          }
        };
      }
    };
    const navigate = tool("browser.navigate", createTestWebTools({
      browserBackend: backend,
      resolveHostname: publicResolver,
      securityConfig: {
        allowPrivateUrls: false,
        websiteBlocklist: { domains: ["blocked.test"] }
      }
    }));

    const result = await navigate.run({ url: "https://example.com/start" });

    expect(result.ok).toBe(false);
    expect(result.metadata).toMatchObject({
      url: "https://example.com/start",
      finalUrl: "https://blocked.test/final",
      backend: "mock",
      reason: "post-redirect-website-policy",
      host: "blocked.test",
      matchedRule: "blocked.test"
    });
    expect(calls).toEqual(["https://example.com/start", "about:blank"]);
  });

  it("classifies browser.cdp as an external side-effect tool", () => {
    const cdp = tool("browser.cdp");

    expect(cdp.riskClass).toBe("external-side-effect");
    expect(cdp.toolsets).toEqual(["dangerous"]);
  });

  it("raises consequential click targets while preserving structurally safe links", async () => {
    const current = browserIdentity(4);
    const labels = new Map([
      ["@e2", "DELETE password=hunter2"],
      ["@e3", "Renew credential"],
      ["@e4", "Submit"],
      ["@e5", "Confirm"],
      ["@e6", "Purchase"],
      ["@e7", "Continue"],
      ["@e8", "Unknown scripted control"]
    ]);
    const preflightAction = vi.fn(async (_action: "click" | "press" | "dialog", input: BrowserActionInput): Promise<BrowserActionPreflight> => ({
      action: "click",
      sessionId: input.sessionId!,
      identity: current,
      tabRef: "@t1",
      url: "https://developers.mtn.com/apps?token=must-redact",
      target: {
        ref: input.ref,
        kind: input.ref === "@e1" ? "link" : input.ref === "@e8" ? "scripted-control" : "button",
        tag: input.ref === "@e1" ? "a" : input.ref === "@e8" ? "div" : "button",
        role: input.ref === "@e1" ? "link" : "button",
        label: input.ref === "@e1" ? "API docs" : labels.get(input.ref!)!,
        ...(input.ref === "@e1" ? { href: "https://developers.mtn.com/docs" } : {}),
        formAssociated: input.ref !== "@e1",
        submit: input.ref !== "@e1"
      }
    }));
    const browserBackend = { ...createSessionRecordingBrowserBackend(), preflightAction };
    const click = tool("browser.click", createTestWebTools({ browserBackend }));
    const base = { sessionId: "runtime:main", identity: current, tabRef: "@t1" };

    const link = await click.resolveSecurity?.({ ...base, ref: "@e1" }, { trustedWorkspace: true, sessionId: "runtime" });
    expect(link).toMatchObject({ riskClass: "read-only-network", targetSummary: "Click link “API docs” on developers.mtn.com" });

    for (const [ref, label] of labels) {
      const resolution = await click.resolveSecurity?.({ ...base, ref }, { trustedWorkspace: true, sessionId: "runtime" });
      expect(resolution).toMatchObject({
        riskClass: "external-side-effect",
        targetKey: expect.stringMatching(/^browser-action:[a-f0-9]{64}$/u),
        targetSummary: expect.stringContaining(label.startsWith("DELETE") ? "DELETE password=[redacted]" : label)
      });
      expect(JSON.stringify(resolution)).not.toContain("hunter2");
      expect(JSON.stringify(resolution)).not.toContain("must-redact");
    }
  });

  it("fails closed when a reviewed bound target becomes stale before dispatch", async () => {
    const reviewedIdentity = browserIdentity(9);
    const currentIdentity = browserIdentity(10);
    const clickMethod = vi.fn(async (input: BrowserActionInput) => {
      expect(input).toMatchObject({
        sessionId: "runtime:main",
        ref: "@e2",
        identity: reviewedIdentity,
        tabRef: "@t1"
      });
      expect(input.locator).toBeUndefined();
      throw new BrowserTargetError({
        reason: "stale-browser-ref",
        message: "The reviewed browser document changed before dispatch.",
        currentSessionId: "runtime:main",
        currentIdentity,
        currentTabRef: "@t1"
      });
    });
    const preflightAction = vi.fn(async (_action: "click" | "press" | "dialog", input: BrowserActionInput): Promise<BrowserActionPreflight> => ({
      action: "click",
      sessionId: input.sessionId!,
      identity: reviewedIdentity,
      tabRef: "@t1",
      url: "https://developers.mtn.com/apps",
      target: { ref: "@e2", kind: "button", tag: "button", role: "button", label: "DELETE", formAssociated: true, submit: true }
    }));
    const browserBackend = { ...createSessionRecordingBrowserBackend(), click: clickMethod, preflightAction };
    const click = tool("browser.click", createTestWebTools({ browserBackend }));
    const context = { trustedWorkspace: true, sessionId: "runtime" };
    const input = {
      sessionId: "runtime:main",
      locator: { role: "button", name: "DELETE" },
      waitFor: { kind: "dom-stable" as const }
    };
    const approved = await click.resolveSecurity?.(input, context);

    await expect(click.run(input, { securityResolution: approved })).resolves.toMatchObject({
      ok: false,
      metadata: {
        reason: "stale-browser-ref",
        currentIdentity
      }
    });
    expect(preflightAction).toHaveBeenCalledOnce();
    expect(clickMethod).toHaveBeenCalledOnce();
  });

  it("resolves a semantic locator once and dispatches the exact reviewed target", async () => {
    const clickMethod = vi.fn(async (input: BrowserActionInput) => {
      expect(input).toMatchObject({
        sessionId: "runtime:main",
        ref: "@e5",
        identity: browserIdentity(9),
        tabRef: "@t1"
      });
      expect(input.locator).toBeUndefined();
      return createSessionRecordingBrowserBackend().snapshot!({ sessionId: "runtime:main" });
    });
    const current = browserIdentity(9);
    const preflightAction = vi.fn(async (_action: "click" | "press" | "dialog", input: BrowserActionInput): Promise<BrowserActionPreflight> => {
      return {
        action: "click",
        sessionId: input.sessionId!,
        identity: current,
        tabRef: "@t1",
        url: "https://developers.mtn.com/login",
        target: { ref: "@e5", kind: "link", tag: "a", role: "link", label: "Login", href: "https://developers.mtn.com/login", formAssociated: false, submit: false }
      };
    });
    const click = tool("browser.click", createTestWebTools({
      browserBackend: { ...createSessionRecordingBrowserBackend(), click: clickMethod, preflightAction }
    }));
    const input = { sessionId: "runtime:main", locator: { role: "link", name: "Login" } };
    const approved = await click.resolveSecurity?.(input, { trustedWorkspace: true, sessionId: "runtime" });

    expect(approved).toMatchObject({
      riskClass: "read-only-network",
      targetSummary: "Click link “Login” on developers.mtn.com"
    });
    await expect(click.run(input, { securityResolution: approved })).resolves.toMatchObject({ ok: true });
    expect(preflightAction).toHaveBeenCalledOnce();
    expect(clickMethod).toHaveBeenCalledOnce();
  });

  it("returns current candidates when a reviewed semantic locator is ambiguous", async () => {
    const current = browserIdentity(9);
    const candidates = ["@e2", "@e3"].map((ref) => ({
      ref,
      identity: current,
      tabRef: "@t1",
      role: "button",
      name: "Open"
    }));
    const preflightAction = vi.fn(async () => {
      throw new BrowserTargetError({
        reason: "browser-target-ambiguous",
        message: "Browser locator matched 2 current elements; refine the locator instead of guessing.",
        candidates,
        currentSessionId: "runtime:main",
        currentIdentity: current,
        currentTabRef: "@t1"
      });
    });
    const clickMethod = vi.fn();
    const click = tool("browser.click", createTestWebTools({
      browserBackend: { ...createSessionRecordingBrowserBackend(), click: clickMethod, preflightAction }
    }));
    const input = { sessionId: "runtime:main", locator: { role: "button", name: "Open" } };
    const reviewed = await click.resolveSecurity?.(input, { trustedWorkspace: true, sessionId: "runtime" });
    expect(reviewed).toMatchObject({ riskClass: "read-only-network" });

    await expect(click.run(input, { securityResolution: reviewed })).resolves.toMatchObject({
      ok: false,
      content: expect.stringContaining("matched 2 current elements"),
      metadata: {
        reason: "browser-target-ambiguous",
        candidates
      }
    });
    expect(preflightAction).toHaveBeenCalledOnce();
    expect(clickMethod).not.toHaveBeenCalled();
  });

  it("keeps navigation keys read-only and raises Enter on a focused form control", async () => {
    const pressMethod = vi.fn(async () => createSessionRecordingBrowserBackend().snapshot!({ sessionId: "runtime:main" }));
    const preflightAction = vi.fn(async (_action: "click" | "press" | "dialog", input: BrowserActionInput): Promise<BrowserActionPreflight> => ({
      action: "press",
      sessionId: input.sessionId!,
      identity: browserIdentity(5),
      tabRef: "@t1",
      url: "https://developers.mtn.com/login",
      target: { ref: "@e4", kind: "form-control", tag: "input", role: "textbox", label: "Email", formAssociated: true, submit: false }
    }));
    const press = tool("browser.press", createTestWebTools({
      browserBackend: { ...createSessionRecordingBrowserBackend(), press: pressMethod, preflightAction }
    }));
    const context = { trustedWorkspace: true, sessionId: "runtime" };

    await expect(press.resolveSecurity?.({ key: "Escape" }, context)).resolves.toMatchObject({ riskClass: "read-only-network" });
    expect(preflightAction).not.toHaveBeenCalled();
    const reviewed = await press.resolveSecurity?.({ key: "Enter" }, context);
    expect(reviewed).toMatchObject({
      riskClass: "external-side-effect",
      targetSummary: "Press enter on “Email” on developers.mtn.com"
    });
    await expect(press.run({ key: "Enter" }, { securityResolution: reviewed })).resolves.toMatchObject({ ok: true });
    expect(pressMethod).toHaveBeenCalledWith(expect.objectContaining({
      ref: "@e4",
      identity: browserIdentity(5),
      tabRef: "@t1",
      key: "Enter"
    }));
  });

  it("raises dialog acceptance while leaving dismissal read-only", async () => {
    const dialogMethod = vi.fn(async () => createSessionRecordingBrowserBackend().snapshot!({ sessionId: "runtime:main" }));
    const preflightAction = vi.fn(async (_action: "click" | "press" | "dialog", input: BrowserActionInput): Promise<BrowserActionPreflight> => ({
      action: "dialog",
      sessionId: input.sessionId!,
      identity: browserIdentity(6),
      tabRef: "@t1",
      url: "https://developers.mtn.com/apps",
      target: { ref: "dialog-7", kind: "dialog", role: "confirm", label: "Delete this app?", formAssociated: false, submit: false }
    }));
    const dialog = tool("browser.dialog", createTestWebTools({
      browserBackend: { ...createSessionRecordingBrowserBackend(), dialog: dialogMethod, preflightAction }
    }));
    const context = { trustedWorkspace: true, sessionId: "runtime" };

    const reviewed = await dialog.resolveSecurity?.({ action: "accept" }, context);
    expect(reviewed).toMatchObject({
      riskClass: "external-side-effect",
      targetSummary: "Accept browser dialog “Delete this app?” on developers.mtn.com"
    });
    await expect(dialog.run({ action: "accept" }, { securityResolution: reviewed })).resolves.toMatchObject({ ok: true });
    expect(dialogMethod).toHaveBeenCalledWith(expect.objectContaining({
      ref: "dialog-7",
      identity: browserIdentity(6),
      tabRef: "@t1",
      action: "accept"
    }));
    await expect(dialog.resolveSecurity?.({ action: "dismiss" }, context)).resolves.toMatchObject({
      riskClass: "read-only-network"
    });
  });

  it("exposes safe tab discovery and explicit switching as concise browser tools", async () => {
    const calls: Array<{ method: string; input: BrowserActionInput | BrowserNavigateInput }> = [];
    const tools = createTestWebTools({
      browserBackend: createSessionRecordingBrowserBackend(calls),
      currentSessionId: () => "runtime-session"
    });
    const tabs = tool("browser.tabs", tools);
    const switchTab = tool("browser.switch_tab", tools);

    expect(tabs.riskClass).toBe("read-only-network");
    expect(switchTab.riskClass).toBe("read-only-network");
    await expect(tabs.run({})).resolves.toMatchObject({
      ok: true,
      content: expect.stringContaining("@t1 [controlled] Main — https://example.com/")
    });
    const switched = await switchTab.run({ tabRef: "@t2" });

    expect(switched.ok).toBe(true);
    expect(switched.content).toContain("Controlled tab: @t2 [controlled] Details — https://example.com/details");
    expect(switched.content).toContain("Recorded browser snapshot for runtime-session:main.");
    expect(calls).toEqual([
      { method: "tabs", input: { sessionId: "runtime-session:main" } },
      { method: "switchTab", input: { sessionId: "runtime-session:main", tabRef: "@t2", signal: undefined } }
    ]);
  });

  it("guides target discovery away from local browser profiles", () => {
    const navigate = tool("browser.navigate");

    expect(navigate.description).toContain("a URL supplied by the user");
    expect(navigate.description).toContain("existing controlled tabs");
    expect(navigate.description).toContain("normal permitted web lookup");
    expect(navigate.description).toContain("one focused clarification");
    expect(navigate.description).toContain("local browser profile data requires explicit authorization");
  });

  it("blocks browser.cdp Page.navigate to metadata and private URLs before the backend call", async () => {
    const calls: BrowserActionInput[] = [];
    const cdp = tool("browser.cdp", createTestWebTools({
      browserBackend: createRecordingCdpBackend(calls)
    }));

    await expect(cdp.run({ method: "Page.navigate", params: { url: "http://169.254.169.254" } })).resolves.toMatchObject({
      ok: false,
      metadata: {
        url: "http://169.254.169.254/",
        backend: "mock",
        method: "Page.navigate",
        reason: "unsafe-url"
      }
    });
    await expect(cdp.run({ method: "Page.navigate", params: { url: "http://localhost:8080" } })).resolves.toMatchObject({
      ok: false,
      metadata: {
        url: "http://localhost:8080/",
        backend: "mock",
        method: "Page.navigate",
        reason: "unsafe-url"
      }
    });
    expect(calls).toEqual([]);
  });

  it("blocks browser.cdp Target.createTarget with private URLs", async () => {
    const calls: BrowserActionInput[] = [];
    const cdp = tool("browser.cdp", createTestWebTools({
      browserBackend: createRecordingCdpBackend(calls)
    }));

    const result = await cdp.run({ method: "Target.createTarget", params: { url: "http://192.168.1.10/admin" } });

    expect(result).toMatchObject({
      ok: false,
      metadata: {
        url: "http://192.168.1.10/admin",
        backend: "mock",
        method: "Target.createTarget",
        reason: "unsafe-url"
      }
    });
    expect(calls).toEqual([]);
  });

  it("blocks browser.cdp Runtime.evaluate with unsafe URL literals", async () => {
    const calls: BrowserActionInput[] = [];
    const cdp = tool("browser.cdp", createTestWebTools({
      browserBackend: createRecordingCdpBackend(calls)
    }));

    await expect(cdp.run({
      method: "Runtime.evaluate",
      params: { expression: "fetch(\"http://169.254.169.254/latest\")" }
    })).resolves.toMatchObject({
      ok: false,
      metadata: {
        url: "http://169.254.169.254/latest",
        backend: "mock",
        method: "Runtime.evaluate",
        reason: "unsafe-url"
      }
    });
    await expect(cdp.run({
      method: "Runtime.evaluate",
      params: { expression: "new XMLHttpRequest().open('GET', 'http://localhost:8080/private')" }
    })).resolves.toMatchObject({
      ok: false,
      metadata: {
        url: "http://localhost:8080/private",
        backend: "mock",
        method: "Runtime.evaluate",
        reason: "unsafe-url"
      }
    });
    expect(calls).toEqual([]);
  });

  it("blocks browser.cdp Runtime.evaluate navigation expressions with unsafe URL literals", async () => {
    const calls: BrowserActionInput[] = [];
    const cdp = tool("browser.cdp", createTestWebTools({
      browserBackend: createRecordingCdpBackend(calls)
    }));

    await expect(cdp.run({
      method: "Runtime.evaluate",
      params: { expression: "location.href = \"http://169.254.169.254/latest\"" }
    })).resolves.toMatchObject({
      ok: false,
      metadata: {
        url: "http://169.254.169.254/latest",
        backend: "mock",
        method: "Runtime.evaluate",
        reason: "unsafe-url"
      }
    });
    await expect(cdp.run({
      method: "Runtime.evaluate",
      params: { expression: "window.open(\"http://localhost:8080\")" }
    })).resolves.toMatchObject({
      ok: false,
      metadata: {
        url: "http://localhost:8080/",
        backend: "mock",
        method: "Runtime.evaluate",
        reason: "unsafe-url"
      }
    });
    await expect(cdp.run({
      method: "Runtime.evaluate",
      params: { expression: "location.assign(\"http://127.0.0.1:3000\")" }
    })).resolves.toMatchObject({
      ok: false,
      metadata: {
        url: "http://127.0.0.1:3000/",
        backend: "mock",
        method: "Runtime.evaluate",
        reason: "unsafe-url"
      }
    });
    expect(calls).toEqual([]);
  });

  it("fails closed for browser.cdp Runtime.evaluate network expressions without checkable URLs", async () => {
    const calls: BrowserActionInput[] = [];
    const cdp = tool("browser.cdp", createTestWebTools({
      browserBackend: createRecordingCdpBackend(calls)
    }));

    const result = await cdp.run({
      method: "Runtime.evaluate",
      params: { expression: "fetch(window.__targetUrl)" }
    });

    expect(result).toMatchObject({
      ok: false,
      metadata: {
        backend: "mock",
        method: "Runtime.evaluate",
        reason: "cdp-network-expression-unchecked"
      }
    });
    expect(calls).toEqual([]);
  });

  it("blocks browser.cdp Runtime.evaluate secret-bearing URLs without leaking raw values", async () => {
    const calls: BrowserActionInput[] = [];
    const cdp = tool("browser.cdp", createTestWebTools({
      browserBackend: createRecordingCdpBackend(calls),
      resolveHostname: publicResolver
    }));

    const result = await cdp.run({
      method: "Runtime.evaluate",
      params: { expression: "fetch(\"https://example.com/?api_key=cdp-secret\")" }
    });

    expect(result).toMatchObject({
      ok: false,
      metadata: {
        url: "[REDACTED_URL_WITH_SECRET]",
        backend: "mock",
        method: "Runtime.evaluate",
        reason: "secret-in-url"
      }
    });
    expect(JSON.stringify(result)).not.toContain("cdp-secret");
    expect(calls).toEqual([]);
  });

  it("browser.cdp debug logs method without leaking raw dangerous Runtime.evaluate expression", async () => {
    vi.stubEnv("ESTACODA_WEB_TOOLS_DEBUG", "true");
    const calls: BrowserActionInput[] = [];
    const cdp = tool("browser.cdp", createTestWebTools({
      browserBackend: createRecordingCdpBackend(calls),
      resolveHostname: publicResolver
    }));

    const result = await cdp.run({
      method: "Runtime.evaluate",
      params: { expression: "fetch(\"https://example.com/?token=cdp-debug-secret\")" }
    });

    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("cdp-debug-secret");
    expect(JSON.stringify(result)).not.toContain("fetch(");
    expect(result.metadata).toMatchObject({
      backend: "mock",
      method: "Runtime.evaluate",
      reason: "secret-in-url",
      debug: expect.arrayContaining([
        expect.objectContaining({
          event: "browser.cdp.start",
          data: {
            backend: "mock",
            method: "Runtime.evaluate",
            params: { expression: "[REDACTED_EXPRESSION]" }
          }
        }),
        expect.objectContaining({
          event: "browser.cdp.blocked",
          data: expect.objectContaining({
            backend: "mock",
            method: "Runtime.evaluate",
            reason: "secret-in-url"
          })
        })
      ])
    });
    expect(calls).toEqual([]);
  });

  it("blocks browser.cdp Runtime.evaluate secret-bearing navigation URLs without leaking raw values", async () => {
    const calls: BrowserActionInput[] = [];
    const cdp = tool("browser.cdp", createTestWebTools({
      browserBackend: createRecordingCdpBackend(calls)
    }));

    const result = await cdp.run({
      method: "Runtime.evaluate",
      params: { expression: "window.location = \"https://example.com/?api_key=cdp-nav-secret\"" }
    });

    expect(result).toMatchObject({
      ok: false,
      metadata: {
        url: "[REDACTED_URL_WITH_SECRET]",
        backend: "mock",
        method: "Runtime.evaluate",
        reason: "secret-in-url"
      }
    });
    expect(JSON.stringify(result)).not.toContain("cdp-nav-secret");
    expect(calls).toEqual([]);
  });

  it("blocks browser.cdp Runtime.callFunctionOn with unsafe literal URL usage", async () => {
    const calls: BrowserActionInput[] = [];
    const cdp = tool("browser.cdp", createTestWebTools({
      browserBackend: createRecordingCdpBackend(calls)
    }));

    const result = await cdp.run({
      method: "Runtime.callFunctionOn",
      params: {
        functionDeclaration: "function(url) { return fetch(url); }",
        arguments: [{ value: "http://169.254.169.254/latest" }]
      }
    });

    expect(result).toMatchObject({
      ok: false,
      metadata: {
        url: "http://169.254.169.254/latest",
        backend: "mock",
        method: "Runtime.callFunctionOn",
        reason: "unsafe-url"
      }
    });
    expect(calls).toEqual([]);
  });

  it("blocks browser.cdp Runtime.callFunctionOn with navigation-capable literal URL usage", async () => {
    const calls: BrowserActionInput[] = [];
    const cdp = tool("browser.cdp", createTestWebTools({
      browserBackend: createRecordingCdpBackend(calls)
    }));

    const result = await cdp.run({
      method: "Runtime.callFunctionOn",
      params: {
        functionDeclaration: "function(url) { location.replace(url); }",
        arguments: [{ value: "http://192.168.1.1/admin" }]
      }
    });

    expect(result).toMatchObject({
      ok: false,
      metadata: {
        url: "http://192.168.1.1/admin",
        backend: "mock",
        method: "Runtime.callFunctionOn",
        reason: "unsafe-url"
      }
    });
    expect(calls).toEqual([]);
  });

  it("applies browser.cdp allowPrivateUrls without bypassing the metadata floor", async () => {
    const calls: BrowserActionInput[] = [];
    const cdp = tool("browser.cdp", createTestWebTools({
      browserBackend: createRecordingCdpBackend(calls),
      securityConfig: {
        allowPrivateUrls: true,
        websiteBlocklist: {}
      }
    }));

    await expect(cdp.run({ method: "Page.navigate", params: { url: "http://192.168.1.10/admin" } })).resolves.toMatchObject({
      ok: true,
      metadata: {
        backend: "mock"
      }
    });
    await expect(cdp.run({ method: "Page.navigate", params: { url: "http://169.254.169.254/latest" } })).resolves.toMatchObject({
      ok: false,
      metadata: {
        url: "http://169.254.169.254/latest",
        backend: "mock",
        method: "Page.navigate",
        reason: "unsafe-url"
      }
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "Page.navigate", params: { url: "http://192.168.1.10/admin" } });
  });

  it("blocks browser.cdp URLs matched by website policy", async () => {
    const calls: BrowserActionInput[] = [];
    const cdp = tool("browser.cdp", createTestWebTools({
      browserBackend: createRecordingCdpBackend(calls),
      resolveHostname: publicResolver,
      securityConfig: {
        allowPrivateUrls: false,
        websiteBlocklist: { domains: ["blocked.test"] }
      }
    }));

    const result = await cdp.run({ method: "Page.navigate", params: { url: "https://blocked.test/page" } });

    expect(result).toMatchObject({
      ok: false,
      metadata: {
        url: "https://blocked.test/page",
        backend: "mock",
        method: "Page.navigate",
        reason: "website-policy",
        host: "blocked.test",
        matchedRule: "blocked.test"
      }
    });
    expect(calls).toEqual([]);
  });

  it("keeps safe read-only browser.cdp commands working", async () => {
    const calls: BrowserActionInput[] = [];
    const cdp = tool("browser.cdp", createTestWebTools({
      browserBackend: createRecordingCdpBackend(calls)
    }));

    const result = await cdp.run({ method: "Runtime.getProperties", params: { objectId: "object-1" } });

    expect(result).toMatchObject({
      ok: true,
      metadata: {
        backend: "mock",
        result: {
          method: "Runtime.getProperties",
          params: { objectId: "object-1" }
        }
      }
    });
    expect(calls).toHaveLength(1);
  });

  it("blocks raw browser.cdp methods that are not clearly read-only", async () => {
    const calls: BrowserActionInput[] = [];
    const cdp = tool("browser.cdp", createTestWebTools({
      browserBackend: createRecordingCdpBackend(calls)
    }));

    const result = await cdp.run({ method: "Input.dispatchKeyEvent", params: { type: "keyDown", key: "Enter" } });

    expect(result).toMatchObject({
      ok: false,
      metadata: {
        backend: "mock",
        method: "Input.dispatchKeyEvent",
        reason: "cdp-method-not-allowlisted"
      }
    });
    expect(calls).toEqual([]);
  });

  it("passes derived browser session keys through the shared browser tool paths", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "estacoda-web-tools-session-test-"));
    tempRoots.push(workspaceRoot);
    const operations: Array<{
      toolName: string;
      backendMethod: string;
      input: Record<string, unknown>;
      options?: Partial<WebToolOptions>;
    }> = [
      { toolName: "browser.navigate", backendMethod: "navigate", input: { url: "https://example.com" } },
      { toolName: "browser.snapshot", backendMethod: "snapshot", input: {} },
      { toolName: "browser.find", backendMethod: "find", input: { locator: { role: "button", name: "Recorded Button" } } },
      { toolName: "browser.click", backendMethod: "click", input: { ref: "@e1" } },
      { toolName: "browser.type", backendMethod: "type", input: { ref: "@e1", text: "hello" } },
      { toolName: "browser.select", backendMethod: "select", input: { locator: { label: "Environment" }, value: "Sandbox" } },
      { toolName: "browser.extract", backendMethod: "extract", input: { locator: { role: "button", name: "Recorded Button" } } },
      { toolName: "browser.scroll", backendMethod: "scroll", input: { direction: "down", amount: 300 } },
      { toolName: "browser.back", backendMethod: "back", input: {} },
      { toolName: "browser.press", backendMethod: "press", input: { key: "Enter" } },
      { toolName: "browser.console", backendMethod: "console", input: {} },
      { toolName: "browser.tabs", backendMethod: "tabs", input: {} },
      { toolName: "browser.switch_tab", backendMethod: "switchTab", input: { tabRef: "@t2" } },
      { toolName: "browser.get_images", backendMethod: "getImages", input: {} },
      { toolName: "browser.screenshot", backendMethod: "screenshot", input: {}, options: { workspaceRoot } },
      {
        toolName: "browser.vision",
        backendMethod: "screenshot",
        input: { prompt: "describe" },
        options: {
          workspaceRoot,
          visionDispatcher: {
            isAvailable: () => true,
            resolveSecurity: async () => undefined,
            dispatch: async () => ({ ok: true, content: "vision ok" })
          }
        }
      },
      { toolName: "browser.dialog", backendMethod: "dialog", input: { action: "accept" } },
      { toolName: "browser.cdp", backendMethod: "cdp", input: { method: "Browser.getVersion" } }
    ];

    for (const operation of operations) {
      const calls: Array<{ method: string; input: BrowserActionInput | BrowserNavigateInput }> = [];
      const browserBackend = createSessionRecordingBrowserBackend(calls);
      const browserTool = tool(operation.toolName, createTestWebTools({
        browserBackend,
        currentSessionId: () => "runtime-session",
        resolveHostname: publicResolver,
        ...(operation.options ?? {})
      }));

      const result = await browserTool.run(operation.input);

      expect(result.ok, operation.toolName).toBe(true);
      expect(calls).toEqual(expect.arrayContaining([
        expect.objectContaining({
          method: operation.backendMethod,
          input: expect.objectContaining({ sessionId: "runtime-session:main" })
        })
      ]));
    }
  });

  it("keeps explicit runtime and implicit browser calls on the same main session", async () => {
    const calls: Array<{ method: string; input: BrowserActionInput | BrowserNavigateInput }> = [];
    const tools = createTestWebTools({
      browserBackend: createSessionRecordingBrowserBackend(calls),
      currentSessionId: () => "runtime-session",
      resolveHostname: publicResolver
    });

    await tool("browser.navigate", tools).run({
      sessionId: "runtime-session",
      url: "https://example.com"
    });
    await tool("browser.snapshot", tools).run({});

    expect(calls.slice(-2)).toEqual([
      expect.objectContaining({ method: "navigate", input: expect.objectContaining({ sessionId: "runtime-session:main" }) }),
      expect.objectContaining({ method: "snapshot", input: expect.objectContaining({ sessionId: "runtime-session:main" }) })
    ]);
  });

  it("requests protected browser input for a runtime-derived verified field without calling plaintext type", async () => {
    const type = vi.fn();
    const prepareProtectedField = vi.fn(async () => ({
      type: "browser-field" as const,
      sessionId: "test-runtime-session:main",
      ref: "@e1",
      expectedOrigin: "https://example.com",
      tabRef: "@t1",
      frameId: "main-frame",
    }));
    const onSecureInputRequest = vi.fn(async () => ({
      status: "delivered" as const,
      destinationLabel: "Browser field at https://example.com",
      persisted: false,
    }));
    const browserType = tool("browser.type", createTestWebTools({
      browserBackend: {
        ...createSessionRecordingBrowserBackend(),
        kind: "local-cdp",
        type,
        prepareProtectedField,
      },
    }));

    const result = await browserType.run({
      ref: "@e1",
      protectedInput: {
        kind: "password",
        purpose: "Sign in",
        retention: "use-once",
      },
    }, { onSecureInputRequest });

    expect(result).toMatchObject({
      ok: true,
      metadata: {
        backend: "local-cdp",
        secureInputReceipt: { status: "delivered", persisted: false },
      },
    });
    expect(result.content).not.toContain("password");
    expect(type).not.toHaveBeenCalled();
    expect(prepareProtectedField).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "test-runtime-session:main",
      ref: "@e1",
    }));
    expect(onSecureInputRequest).toHaveBeenCalledWith(expect.objectContaining({
      kind: "password",
      purpose: "Sign in",
      destination: expect.objectContaining({ ref: "@e1", expectedOrigin: "https://example.com" }),
    }), expect.any(Function));
  });

  it("does not expose secure-input handler failures through browser.type", async () => {
    const browserType = tool("browser.type", createTestWebTools({
      browserBackend: {
        ...createSessionRecordingBrowserBackend(),
        kind: "local-cdp",
        prepareProtectedField: async () => ({
          type: "browser-field",
          sessionId: "test-runtime-session:main",
          ref: "@e1",
          expectedOrigin: "https://example.com",
        }),
      },
    }));

    const result = await browserType.run({
      ref: "@e1",
      protectedInput: { kind: "api-key", purpose: "Authenticate" },
    }, {
      onSecureInputRequest: async () => {
        throw new Error("handler-sentinel-secret");
      },
    });

    expect(result).toMatchObject({ ok: false });
    expect(JSON.stringify(result)).not.toContain("handler-sentinel-secret");
  });

  it("requests atomic local submission for a one-time-code and returns only settled metadata", async () => {
    const prepareProtectedField = vi.fn(async (input: BrowserActionInput) => ({
      type: "browser-field" as const,
      sessionId: input.sessionId!,
      ref: input.ref!,
      expectedOrigin: "https://portal.example.com",
      tabRef: input.tabRef,
      frameId: "main-frame",
      label: "Browser field and submit control at https://portal.example.com",
      submit: { ref: input.submitRef! },
    }));
    const takeProtectedFieldDeliveryResult = vi.fn(() => ({
      delivery: "delivered" as const,
      submission: "clicked" as const,
      documentChanged: true,
      challengeState: "departed" as const,
      conditionMet: true,
      beforeIdentity: browserIdentity(8),
      afterIdentity: browserIdentity(10),
      sensitiveInputActive: false,
      snapshot: {
        sessionId: "test-runtime-session:main",
        url: "https://portal.example.com/home",
        identity: browserIdentity(10),
        observedAt: "2026-08-13T00:00:00.000Z",
        title: "Portal home",
      },
    }));
    const browserType = tool("browser.type", createTestWebTools({
      browserBackend: {
        ...createSessionRecordingBrowserBackend(),
        kind: "local-cdp",
        prepareProtectedField,
        takeProtectedFieldDeliveryResult,
      },
    }));
    const onSecureInputRequest = vi.fn(async () => ({
      status: "delivered" as const,
      destinationLabel: "Browser field and submit control at https://portal.example.com",
      persisted: false,
    }));

    const result = await browserType.run({
      ref: "@e19",
      submitRef: "@e20",
      identity: browserIdentity(8),
      tabRef: "@t1",
      protectedInput: {
        kind: "one-time-code",
        purpose: "Enter and submit the portal authentication code",
      },
    }, { onSecureInputRequest });

    expect(result).toMatchObject({
      ok: true,
      metadata: {
        protectedDelivery: {
          submission: "clicked",
          challengeState: "departed",
          sensitiveInputActive: false,
        },
        snapshot: { identity: browserIdentity(10), title: "Portal home" },
      },
    });
    expect(result.content).toContain("authentication itself still requires post-submit verification");
    expect(prepareProtectedField).toHaveBeenCalledWith(expect.objectContaining({ submitRef: "@e20" }));
    expect(onSecureInputRequest).toHaveBeenCalledTimes(1);
    expect(takeProtectedFieldDeliveryResult).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("123456");
  });

  it("renders only the explicit protected-transaction notice for an unsettled delivery", async () => {
    const takeProtectedFieldDeliveryResult = vi.fn(() => ({
      delivery: "delivered" as const,
      submission: "clicked" as const,
      documentChanged: false,
      challengeState: "unknown" as const,
      conditionMet: false,
      beforeIdentity: browserIdentity(8),
      afterIdentity: browserIdentity(9),
      sensitiveInputActive: true,
      snapshot: {
        sessionId: "test-runtime-session:main",
        url: "https://portal.example.com/challenge",
        identity: browserIdentity(9),
        observedAt: "2026-08-14T00:00:00.000Z",
        sensitiveInputActive: true as const,
      },
    }));
    const browserType = tool("browser.type", createTestWebTools({
      browserBackend: {
        ...createSessionRecordingBrowserBackend(),
        kind: "local-cdp",
        prepareProtectedField: async (input) => ({
          type: "browser-field",
          sessionId: input.sessionId!,
          ref: input.ref!,
          expectedOrigin: "https://portal.example.com",
          submit: { ref: input.submitRef! },
        }),
        takeProtectedFieldDeliveryResult,
      },
    }));

    const result = await browserType.run({
      ref: "@e1",
      submitRef: "@e2",
      protectedInput: { kind: "one-time-code", purpose: "Authenticate" },
    }, {
      onSecureInputRequest: async () => ({
        status: "delivered",
        destinationLabel: "Protected browser field",
        persisted: false,
      }),
    });

    expect(result.content).toBe([
      "Protected authentication transaction active.",
      "Page content is intentionally suppressed.",
      "State: settling.",
    ].join("\n"));
    expect(result.content).not.toContain("authenticated");
  });

  it("rejects atomic protected submission for non-OTP secrets", async () => {
    const prepareProtectedField = vi.fn();
    const browserType = tool("browser.type", createTestWebTools({
      browserBackend: {
        ...createSessionRecordingBrowserBackend(),
        kind: "local-cdp",
        prepareProtectedField,
      },
    }));

    const result = await browserType.run({
      ref: "@e1",
      submitRef: "@e2",
      protectedInput: { kind: "password", purpose: "Sign in" },
    }, { onSecureInputRequest: vi.fn() });

    expect(result.ok).toBe(false);
    expect(result.content).toContain("limited to one-time-code");
    expect(prepareProtectedField).not.toHaveBeenCalled();
  });

  it("requests every related browser credential in one grouped protected form flow", async () => {
    const prepareProtectedField = vi.fn(async (input: BrowserActionInput) => ({
      type: "browser-field" as const,
      sessionId: input.sessionId!,
      ref: input.ref!,
      expectedOrigin: "https://portal.example.com",
      tabRef: input.tabRef,
      frameId: "main-frame",
    }));
    const onSecureInputRequest = vi.fn(async () => ({
      status: "failed" as const,
      destinationLabel: "unused",
      persisted: false,
    })) as unknown as GroupedSecureInputRequestHandler;
    onSecureInputRequest.requestGroup = vi.fn(async () => ({
      status: "delivered" as const,
      items: [
        { id: "email", receipt: { status: "delivered" as const, destinationLabel: "Email", persisted: false } },
        { id: "password", receipt: { status: "delivered" as const, destinationLabel: "Password", persisted: false } },
      ],
    }));
    const protectedForm = tool("browser.fill_protected_form", createTestWebTools({
      browserBackend: {
        ...createSessionRecordingBrowserBackend(),
        kind: "local-cdp",
        prepareProtectedField,
      },
    }));

    const result = await protectedForm.run({
      purpose: "Sign in to the portal",
      identity: browserIdentity(7),
      tabRef: "@t1",
      fields: [
        { id: "email", ref: "@e3", kind: "account-identifier" },
        { id: "password", ref: "@e4", kind: "password" },
      ],
    }, { onSecureInputRequest });

    expect(result).toMatchObject({
      ok: true,
      metadata: {
        backend: "local-cdp",
        secureInputGroupReceipt: { status: "delivered" },
      },
    });
    expect(result.content).toContain("form was not submitted");
    expect(prepareProtectedField).toHaveBeenCalledTimes(2);
    expect(onSecureInputRequest).not.toHaveBeenCalled();
    expect(onSecureInputRequest.requestGroup).toHaveBeenCalledWith(expect.objectContaining({
      purpose: "Sign in to the portal",
      items: [
        expect.objectContaining({ id: "email", request: expect.objectContaining({ kind: "account-identifier", retention: "use-once" }) }),
        expect.objectContaining({ id: "password", request: expect.objectContaining({ kind: "password", retention: "use-once" }) }),
      ],
    }));
    const serializedCall = JSON.stringify(vi.mocked(onSecureInputRequest.requestGroup).mock.calls);
    expect(serializedCall).not.toContain("text");
    expect(serializedCall).not.toContain("value");

    const rejectedPlaintext = await protectedForm.run({
      purpose: "Sign in to the portal",
      identity: browserIdentity(7),
      tabRef: "@t1",
      fields: [
        { id: "email", ref: "@e3", kind: "account-identifier", value: "must-not-enter-tool-input" },
        { id: "password", ref: "@e4", kind: "password" },
      ],
    }, { onSecureInputRequest });
    expect(rejectedPlaintext.ok).toBe(false);
    expect(onSecureInputRequest.requestGroup).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(rejectedPlaintext)).not.toContain("must-not-enter-tool-input");
  });

  it("binds grouped protected fields to one local authentication submission", async () => {
    const prepareProtectedField = vi.fn(async (input: BrowserActionInput) => ({
      type: "browser-field" as const,
      sessionId: input.sessionId!,
      ref: input.ref!,
      expectedOrigin: "https://portal.example.com",
      tabRef: input.tabRef,
      frameId: "main-frame",
      label: "Browser field with verified submit control at https://portal.example.com",
      submit: { ref: input.submitRef! },
    }));
    const onSecureInputRequest = vi.fn() as unknown as GroupedSecureInputRequestHandler;
    onSecureInputRequest.requestGroup = vi.fn(async () => ({
      status: "delivered" as const,
      items: [
        { id: "email", receipt: { status: "delivered" as const, destinationLabel: "Email", persisted: false } },
        { id: "password", receipt: { status: "delivered" as const, destinationLabel: "Password", persisted: false } },
      ],
    }));
    const takeProtectedFieldDeliveryResult = vi.fn(() => ({
      delivery: "delivered" as const,
      submission: "clicked" as const,
      documentChanged: false,
      challengeState: "departed" as const,
      conditionMet: true,
      beforeIdentity: browserIdentity(7),
      afterIdentity: browserIdentity(9),
      sensitiveInputActive: false,
      snapshot: {
        sessionId: "test-runtime-session:main",
        url: "https://portal.example.com/challenge",
        identity: browserIdentity(9),
        observedAt: "2026-08-14T00:00:00.000Z",
        title: "Verify account",
      },
    }));
    const protectedForm = tool("browser.fill_protected_form", createTestWebTools({
      browserBackend: {
        ...createSessionRecordingBrowserBackend(),
        kind: "local-cdp",
        prepareProtectedField,
        takeProtectedFieldDeliveryResult,
      },
    }));

    const result = await protectedForm.run({
      purpose: "model-authored-purpose-must-not-be-approval-metadata",
      identity: browserIdentity(7),
      tabRef: "@t1",
      submitRef: "@e5",
      fields: [
        { id: "email", ref: "@e3", kind: "account-identifier" },
        { id: "password", ref: "@e4", kind: "password" },
      ],
    }, { onSecureInputRequest });

    expect(result).toMatchObject({
      ok: true,
      metadata: {
        protectedDelivery: { submission: "clicked", challengeState: "departed" },
        snapshot: { identity: browserIdentity(9), title: "Verify account" },
      },
    });
    expect(prepareProtectedField).toHaveBeenCalledTimes(2);
    expect(prepareProtectedField).toHaveBeenNthCalledWith(1, expect.objectContaining({ ref: "@e3", submitRef: "@e5" }));
    expect(prepareProtectedField).toHaveBeenNthCalledWith(2, expect.objectContaining({ ref: "@e4", submitRef: "@e5" }));
    expect(takeProtectedFieldDeliveryResult).toHaveBeenCalledWith(expect.objectContaining({ ref: "@e4" }));
  });

  it("raises only bound protected submissions to external side effect with safe stable metadata", async () => {
    const tools = createTestWebTools({ currentSessionId: () => "runtime-security-session" });
    const browserType = tool("browser.type", tools);
    const protectedForm = tool("browser.fill_protected_form", tools);
    const context = { trustedWorkspace: true, sessionId: "runtime-security-session" };

    expect(await browserType.resolveSecurity?.({ ref: "@e1", protectedInput: { kind: "one-time-code", purpose: "secret purpose" } }, context))
      .toBeUndefined();
    expect(await protectedForm.resolveSecurity?.({ identity: browserIdentity(1), tabRef: "@t1", fields: [], purpose: "secret purpose" }, context))
      .toBeUndefined();
    const typeResolution = await browserType.resolveSecurity?.({
      ref: "@e1",
      tabRef: "@t1",
      submitRef: "@e2",
      protectedInput: { kind: "one-time-code", purpose: "account@example.com" },
    }, context);
    const formResolution = await protectedForm.resolveSecurity?.({
      identity: browserIdentity(1),
      tabRef: "@t1",
      submitRef: "@e2",
      fields: [{ id: "password", ref: "@e1", kind: "password" }],
      purpose: "account@example.com",
    }, context);

    expect(typeResolution).toEqual(formResolution);
    expect(typeResolution).toMatchObject({
      riskClass: "external-side-effect",
      targetKey: expect.stringMatching(/^browser-protected-submit:[a-f0-9]{64}$/u),
      targetSummary: "Submit a verified protected browser authentication control",
    });
    expect(JSON.stringify(typeResolution)).not.toContain("account@example.com");
  });

  it("publishes exact protected-input enums instead of inviting invented kinds", () => {
    const tools = createTestWebTools();
    const browserType = tool("browser.type", tools);
    const protectedForm = tool("browser.fill_protected_form", tools);
    const schemas = JSON.stringify([browserType.inputSchema, protectedForm.inputSchema]);

    expect(schemas).toContain("account-identifier");
    expect(schemas).toContain("one-time-code");
    expect(schemas).not.toContain("account-email");
  });

  it("does not require a browser session key for browser.status", async () => {
    const status = tool("browser.status", createWebTools({
      browserBackend: createSessionRecordingBrowserBackend()
    }));

    const result = await status.run({});

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Browser backend: mock");
  });

  it("surfaces structured browser session-loss reasons to the model", async () => {
    const browserBackend = {
      ...createSessionRecordingBrowserBackend(),
      snapshot: async () => {
        throw new BrowserSessionStateError("session_missing", "Browser session not found: runtime-session:main");
      }
    };
    const snapshot = tool("browser.snapshot", createTestWebTools({
      browserBackend,
      currentSessionId: () => "runtime-session"
    }));

    const result = await snapshot.run({});

    expect(result).toMatchObject({
      ok: false,
      metadata: { backend: "mock", reason: "session_missing" }
    });
  });

  it("warns that authentication was not preserved when navigation replaces a lost session", async () => {
    const browserBackend = {
      ...createSessionRecordingBrowserBackend(),
      navigate: async (input: BrowserNavigateInput) => ({
        session: {
          id: input.sessionId ?? "missing",
          backend: "mock" as const,
          currentUrl: input.url,
          createdAt: "2026-08-13T00:00:00.000Z"
        },
        snapshot: {
          sessionId: input.sessionId ?? "missing",
          url: input.url,
          identity: browserIdentity(1),
          observedAt: "2026-08-13T00:00:00.000Z"
        },
        metadata: {
          sessionRecovery: {
            reason: "session_missing",
            authenticationPreserved: false
          }
        }
      })
    };
    const navigate = tool("browser.navigate", createTestWebTools({
      browserBackend,
      currentSessionId: () => "runtime-session",
      resolveHostname: publicResolver
    }));

    const result = await navigate.run({ url: "https://example.com/recovered" });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Authentication was not preserved");
  });

  it("preserves explicit browser session IDs and treats blank explicit IDs as absent", async () => {
    const calls: Array<{ method: string; input: BrowserActionInput | BrowserNavigateInput }> = [];
    const snapshot = tool("browser.snapshot", createTestWebTools({
      browserBackend: createSessionRecordingBrowserBackend(calls),
      currentSessionId: () => "runtime-session"
    }));

    await expect(snapshot.run({ sessionId: "shared-browser" })).resolves.toMatchObject({ ok: true });
    await expect(snapshot.run({ sessionId: "   " })).resolves.toMatchObject({ ok: true });

    expect(calls.map((call) => call.input.sessionId)).toEqual([
      "shared-browser",
      "runtime-session:main"
    ]);
  });

  it("browser.snapshot accepts full options and forwards them to the backend", async () => {
    const calls: Array<{ method: string; input: BrowserActionInput | BrowserNavigateInput }> = [];
    const snapshot = tool("browser.snapshot", createTestWebTools({
      browserBackend: createSessionRecordingBrowserBackend(calls),
      currentSessionId: () => "runtime-session"
    }));

    expect(snapshot.inputSchema).toMatchObject({
      properties: {
        full: { type: "boolean" }
      }
    });
    await expect(snapshot.run({ full: false })).resolves.toMatchObject({ ok: true });
    await expect(snapshot.run({ full: true })).resolves.toMatchObject({ ok: true });

    expect(calls.map((call) => call.input)).toEqual([
      expect.objectContaining({ sessionId: "runtime-session:main", full: false }),
      expect.objectContaining({ sessionId: "runtime-session:main", full: true })
    ]);
  });

  it("isolates parent and child runtime sessions while allowing explicit sharing", async () => {
    const calls: Array<{ method: string; input: BrowserActionInput | BrowserNavigateInput }> = [];
    const browserBackend = createSessionRecordingBrowserBackend(calls);
    const parentNavigate = tool("browser.navigate", createTestWebTools({
      browserBackend,
      currentSessionId: () => "parent-session",
      resolveHostname: publicResolver
    }));
    const childNavigate = tool("browser.navigate", createTestWebTools({
      browserBackend,
      currentSessionId: () => "child-session",
      resolveHostname: publicResolver
    }));

    await expect(parentNavigate.run({ url: "https://example.com/parent" })).resolves.toMatchObject({ ok: true });
    await expect(childNavigate.run({ url: "https://example.com/child" })).resolves.toMatchObject({ ok: true });
    await expect(parentNavigate.run({ url: "https://example.com/shared", sessionId: "shared-browser" })).resolves.toMatchObject({ ok: true });
    await expect(childNavigate.run({ url: "https://example.com/shared", sessionId: "shared-browser" })).resolves.toMatchObject({ ok: true });

    expect(calls.map((call) => call.input.sessionId)).toEqual([
      "parent-session:main",
      "child-session:main",
      "shared-browser",
      "shared-browser"
    ]);
  });

  it("fails with the session-key error when no runtime browser session can be derived", async () => {
    const snapshot = tool("browser.snapshot", createTestWebTools({
      browserBackend: createSessionRecordingBrowserBackend(),
      currentSessionId: () => "   "
    }));

    await expect(snapshot.run({})).rejects.toThrow(
      "Browser session key requires a current runtime session ID when no explicit browser sessionId is provided."
    );
  });

  it("renders browser snapshot text and interactive elements", async () => {
    const snapshot = tool("browser.snapshot", createTestWebTools({
      browserBackend: createMockBrowserBackend({ title: "Snapshot Title", text: "Snapshot text." })
    }));

    const result = await snapshot.run({});

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Identity: documentEpoch=1 actionRevision=1 observationId=1");
    expect(result.content).toContain("Snapshot text.");
    expect(result.content).toContain("Interactive elements:");
    expect(result.content).toContain("@e1 button Mock Button");
    expect(result.metadata).toMatchObject({
      backend: "mock",
      snapshot: {
        title: "Snapshot Title",
        text: "Snapshot text.",
        elements: [{ ref: "@e1", role: "button", name: "Mock Button" }]
      }
    });
  });

  it("keeps page text while omitting non-interactable controls from model-visible snapshots", async () => {
    const snapshot = tool("browser.snapshot", createTestWebTools({
      browserBackend: {
        ...createMockBrowserBackend(),
        snapshot: async () => ({
          sessionId: "session-modal",
          url: "https://example.com",
          identity: browserIdentity(1),
          observedAt: "2026-08-18T00:00:00.000Z",
          text: "Background diagnostics remain visible.",
          elements: [
            { ref: "@e1", role: "button", name: "Background action", interactable: false, interactabilityReason: "modal-blocked" },
            { ref: "@e2", role: "button", name: "Confirm" }
          ]
        })
      }
    }));

    const result = await snapshot.run({});

    expect(result.content).toContain("Background diagnostics remain visible.");
    expect(result.content).toContain("@e2 button Confirm");
    expect(result.content).not.toContain("Background action");
  });

  it("renders only the explicit protected-transaction notice while page observation is suppressed", async () => {
    const snapshot = tool("browser.snapshot", createTestWebTools({
      browserBackend: {
        ...createMockBrowserBackend(),
        snapshot: async () => ({
          sessionId: "session-protected",
          url: "https://portal.example.com",
          identity: browserIdentity(4),
          observedAt: "2026-08-14T00:00:00.000Z",
          sensitiveInputActive: true,
          tab: { ref: "@t1", url: "https://portal.example.com", controlled: true },
          elements: [{ ref: "@e1", role: "textbox" }],
        }),
      },
    }));

    const result = await snapshot.run({});

    expect(result.content).toBe([
      "Protected authentication transaction active.",
      "Page content is intentionally suppressed.",
      "State: settling.",
    ].join("\n"));
  });

  it("turns an unambiguous email and password snapshot into one grouped-flow instruction", async () => {
    const snapshot = tool("browser.snapshot", createTestWebTools({
      browserBackend: {
        ...createMockBrowserBackend(),
        snapshot: async () => ({
          sessionId: "session-1",
          url: "https://portal.example.com/login",
          identity: browserIdentity(9),
          observedAt: "2026-08-13T00:00:00.000Z",
          tab: { ref: "@t1", url: "https://portal.example.com/login", controlled: true },
          elements: [
            { ref: "@e3", role: "textbox", name: "Email" },
            { ref: "@e4", role: "textbox", name: "Password" },
            { ref: "@e5", role: "button", name: "Sign in" },
          ]
        })
      }
    }));

    const result = await snapshot.run({});

    expect(result.content).toContain("request all related values in one browser.fill_protected_form call");
    expect(result.content).toContain(`identity=${JSON.stringify(browserIdentity(9))}, tabRef=@t1, fields=[@e3:account-identifier, @e4:password]`);
  });

  it("renders full browser snapshot headers and concise element state", async () => {
    const snapshot = tool("browser.snapshot", createTestWebTools({
      browserBackend: {
        ...createMockBrowserBackend(),
        snapshot: async () => ({
          sessionId: "session-1",
          url: "https://example.com",
          identity: browserIdentity(1),
          observedAt: "2026-08-13T00:00:00.000Z",
          title: "Snapshot Title",
          text: "Snapshot text.",
          elements: [
            { ref: "@e1", role: "textbox", name: "Email", value: "ada@example.com", disabled: false },
            { ref: "@e2", role: "checkbox", name: "Subscribe", checked: "mixed" }
          ]
        })
      }
    }));

    const result = await snapshot.run({ full: true });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("[Full page snapshot]");
    expect(result.content).toContain("@e1 textbox Email value=\"ada@example.com\" disabled=false");
    expect(result.content).toContain("@e2 checkbox Subscribe checked=mixed");
    expect(result.metadata).toMatchObject({
      compaction: { mode: "full", compacted: false, truncated: false }
    });
  });

  it("keeps explicit full diagnostic snapshots on the existing un-compacted path", async () => {
    const executor = createSummaryExecutor("provider summary should not be used");
    const snapshot = tool("browser.snapshot", createTestWebTools({
      browserBackend: createLargeSnapshotBackend("Diagnostic line. ".repeat(800)),
      browserConfig: {
        summarizeSnapshots: false,
        snapshotSummarizeThreshold: 20
      },
      snapshotAuxiliaryRoute,
      mainRoute: summaryRoute,
      providerExecutor: executor
    }));

    const result = await snapshot.run({ full: true });

    expect(executor.complete).not.toHaveBeenCalled();
    expect(result.content).toContain("[Full page snapshot]");
    expect(result.content).toMatch(/\n\.\.\. \[truncated\]$/u);
    expect(result.metadata).toMatchObject({
      compaction: { mode: "full", compacted: false, truncated: true }
    });
  });

  it("browser.snapshot defaults to compact rendering when full is omitted or false", async () => {
    const snapshot = tool("browser.snapshot", createTestWebTools({
      browserBackend: createMockBrowserBackend({ text: "Compact text." })
    }));

    const omitted = await snapshot.run({});
    const explicitFalse = await snapshot.run({ full: false });

    expect(omitted.content).toContain("[Compact viewport snapshot]");
    expect(explicitFalse.content).toContain("[Compact viewport snapshot]");
    expect(omitted.content).not.toContain("[Full page snapshot]");
  });

  it("deterministically compacts oversized browser snapshots with a clear suffix", async () => {
    const snapshot = tool("browser.snapshot", createTestWebTools({
      browserBackend: {
        ...createMockBrowserBackend(),
        snapshot: async () => ({
          sessionId: "session-1",
          url: "https://example.com",
          identity: browserIdentity(1),
          observedAt: "2026-08-13T00:00:00.000Z",
          text: "x".repeat(9_000),
          elements: []
        })
      }
    }));

    const result = await snapshot.run({});

    expect(result.ok).toBe(true);
    expect(result.content.length).toBeLessThanOrEqual(8_000);
    expect(result.content).toMatch(/\n\.\.\. \[deterministically compacted\]$/u);
    expect(result.metadata).toMatchObject({
      compaction: { mode: "deterministic", compacted: true, truncated: true }
    });
  });

  it("browser.snapshot summarizeSnapshots=false skips LLM summarization after deterministic compaction", async () => {
    const executor = createSummaryExecutor("summary");
    const snapshot = tool("browser.snapshot", createTestWebTools({
      browserBackend: createLargeSnapshotBackend("x".repeat(9_000)),
      browserConfig: {
        summarizeSnapshots: false,
        snapshotSummarizeThreshold: 20
      },
      snapshotAuxiliaryRoute,
      mainRoute: summaryRoute,
      providerExecutor: executor
    }));

    const result = await snapshot.run({});

    expect(result.ok).toBe(true);
    expect(executor.complete).not.toHaveBeenCalled();
    expect(result.content.length).toBeLessThanOrEqual(8_000);
    expect(result.content).toMatch(/\n\.\.\. \[deterministically compacted\]$/u);
    expect(result.metadata?.summarized).toBeUndefined();
  });

  it("browser.snapshot auto mode avoids a provider call when deterministic compaction fits", async () => {
    const executor = createSummaryExecutor("provider summary should not be used");
    const snapshot = tool("browser.snapshot", createTestWebTools({
      browserBackend: createLargeSnapshotBackend(),
      browserConfig: {
        summarizeSnapshots: "auto",
        snapshotSummarizeThreshold: 8_000
      },
      snapshotAuxiliaryRoute,
      mainRoute: summaryRoute,
      providerExecutor: executor
    }));

    const result = await snapshot.run({});

    expect(result.ok).toBe(true);
    expect(executor.complete).not.toHaveBeenCalled();
    expect(result.content).toContain("@e1 button Save");
    expect(result.content).toContain("@e2 textbox Email");
    expect(result.metadata).toMatchObject({
      compaction: { mode: "deterministic", compacted: true }
    });
    expect(result.metadata?.summarized).toBeUndefined();
  });

  it("browser.snapshot summarizeSnapshots=true summarizes oversized output and marks metadata", async () => {
    const executor = createSummaryExecutor("Condensed snapshot with @e1 Save and @e2 Email.");
    const snapshot = tool("browser.snapshot", createTestWebTools({
      browserBackend: createLargeSnapshotBackend(),
      browserConfig: {
        summarizeSnapshots: true,
        snapshotSummarizeThreshold: 20
      },
      snapshotAuxiliaryRoute,
      mainRoute: summaryRoute,
      providerExecutor: executor
    }));

    const result = await snapshot.run({});

    expect(result.ok).toBe(true);
    expect(executor.complete).toHaveBeenCalledTimes(1);
    expect(result.content).toBe("Condensed snapshot with @e1 Save and @e2 Email.");
    expect(result.metadata).toMatchObject({ summarized: true });
  });

  it("browser.snapshot summarizeSnapshots=true does not call the provider below threshold", async () => {
    const executor = createSummaryExecutor("summary");
    const snapshot = tool("browser.snapshot", createTestWebTools({
      browserBackend: createMockBrowserBackend({ text: "Small snapshot." }),
      browserConfig: {
        summarizeSnapshots: true,
        snapshotSummarizeThreshold: 50_000
      },
      snapshotAuxiliaryRoute,
      mainRoute: summaryRoute,
      providerExecutor: executor
    }));

    const result = await snapshot.run({});

    expect(result.ok).toBe(true);
    expect(executor.complete).not.toHaveBeenCalled();
    expect(result.content).toContain("[Compact viewport snapshot]");
    expect(result.metadata?.summarized).toBeUndefined();
  });

  it("browser.snapshot auto summarization requires an auxiliary route", async () => {
    const executor = createSummaryExecutor("auto summary");
    const withoutRoute = tool("browser.snapshot", createTestWebTools({
      browserBackend: createLargeSnapshotBackend("x".repeat(9_000)),
      browserConfig: {
        summarizeSnapshots: "auto",
        snapshotSummarizeThreshold: 20
      },
      mainRoute: summaryRoute,
      providerExecutor: executor
    }));
    const withRoute = tool("browser.snapshot", createTestWebTools({
      browserBackend: createLargeSnapshotBackend(),
      browserConfig: {
        summarizeSnapshots: "auto",
        snapshotSummarizeThreshold: 20
      },
      snapshotAuxiliaryRoute,
      mainRoute: summaryRoute,
      providerExecutor: executor
    }));

    const skipped = await withoutRoute.run({});
    const summarized = await withRoute.run({});

    expect(skipped.ok).toBe(true);
    expect(skipped.content).toMatch(/\n\.\.\. \[deterministically compacted\]$/u);
    expect(summarized.ok).toBe(true);
    expect(summarized.metadata).toMatchObject({ summarized: true });
    expect(executor.complete).toHaveBeenCalledTimes(1);
  });

  it("browser.snapshot consumes summarization config from the session tool context", async () => {
    const executor = createSummaryExecutor("Context summary with @e1.");
    const snapshot = tool("browser.snapshot", webToolProvider.createTools({
      workspaceRoot: "/tmp/workspace",
      profileId: "default",
      sessionId: "runtime-session",
      currentSessionId: () => "runtime-session",
      channelMediaRoot: "/tmp/channel-media",
      browserBackend: createLargeSnapshotBackend(),
      browserConfig: {
        summarizeSnapshots: true,
        snapshotSummarizeThreshold: 20
      },
      mainRoute: summaryRoute,
      compressionRoute: snapshotAuxiliaryRoute,
      providerExecutor: executor as ProviderExecutor,
      providerRegistry: {} as never
    }));

    const result = await snapshot.run({});

    expect(result.ok).toBe(true);
    expect(result.content).toBe("Context summary with @e1.");
    expect(result.metadata).toMatchObject({ summarized: true });
    expect(executor.complete).toHaveBeenCalledTimes(1);
  });

  it("renders browser snapshot observability sections when present", async () => {
    const browserBackend: BrowserBackend = {
      kind: "mock",
      isAvailable: () => true,
      status: () => ({ backend: "mock", available: true }),
      navigate: async () => {
        throw new Error("not used");
      },
      snapshot: async () => ({
        sessionId: "session-1",
        url: "https://example.com",
        identity: browserIdentity(1),
        observedAt: "2026-08-13T00:00:00.000Z",
        text: "Page text.",
        pendingDialogs: [{ id: "dialog-1", type: "alert", message: "Careful" }],
        frameTree: [{ frameId: "frame-1", url: "https://frame.test/app", origin: "https://frame.test", isOopif: false }],
        consoleHistory: [{ level: "warn", text: "Heads up", timestamp: "1970-01-01T00:00:00.000Z" }],
        elements: [{ ref: "@e1", role: "button", name: "Continue" }]
      })
    };
    const snapshot = tool("browser.snapshot", createTestWebTools({ browserBackend }));

    const result = await snapshot.run({});

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Pending dialogs:");
    expect(result.content).toContain("dialog-1 alert: Careful");
    expect(result.content).toContain("Frames:");
    expect(result.content).toContain("frame-1 https://frame.test/app origin=https://frame.test");
    expect(result.content).toContain("Console errors:");
    expect(result.content).toContain("[warn] 1970-01-01T00:00:00.000Z Heads up");
    expect(result.content).toContain("Interactive elements:");
  });

  it("returns ok false for browser.click with an invalid ref", async () => {
    const click = tool("browser.click", createTestWebTools({
      browserBackend: createInvalidRefBackend()
    }));

    const result = await click.run({ ref: "invalid-ref" });

    expect(result.ok).toBe(false);
    expect(result.content).toBe("Invalid browser element ref: invalid-ref");
    expect(result.metadata).toEqual({ backend: "mock" });
  });

  it("renders semantic candidates and forwards locators to browser actions", async () => {
    const calls: Array<{ method: string; input: BrowserActionInput | BrowserNavigateInput }> = [];
    const browserBackend = createSessionRecordingBrowserBackend(calls);
    const tools = createTestWebTools({ browserBackend, currentSessionId: () => "runtime-session" });

    const found = await tool("browser.find", tools).run({
      locator: { role: "button", name: "Recorded Button", withinText: "OAuth V1" }
    });
    const selected = await tool("browser.select", tools).run({
      locator: { label: "Environment" },
      value: "Sandbox"
    });
    const extracted = await tool("browser.extract", tools).run({
      locator: { role: "button", name: "Recorded Button" }
    });

    expect(found.content).toContain(`@e1 identity=${JSON.stringify(browserIdentity(1))} tab=@t1 button \"Recorded Button\"`);
    expect(selected.ok).toBe(true);
    expect(extracted.content).toContain("Text: Recorded Button");
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "find", input: expect.objectContaining({ sessionId: "runtime-session:main" }) }),
      expect.objectContaining({ method: "select", input: expect.objectContaining({ locator: { label: "Environment" }, value: "Sandbox" }) }),
      expect.objectContaining({ method: "extract", input: expect.objectContaining({ locator: { role: "button", name: "Recorded Button" } }) })
    ]));
  });

  it("renders grounded nearby browser.find candidates as non-exact current-document refs", async () => {
    const backend: BrowserBackend = {
      ...createMockBrowserBackend(),
      find: async () => ({
        sessionId: "runtime-session:main",
        identity: browserIdentity(4),
        tabRef: "@t2",
        status: "not-found",
        candidates: [],
        nearbyCandidates: [{
          ref: "@e7",
          identity: browserIdentity(4),
          tabRef: "@t2",
          role: "button",
          name: "TikTok notifications"
        }]
      })
    };

    const result = await tool("browser.find", createTestWebTools({
      browserBackend: backend,
      currentSessionId: () => "runtime-session"
    })).run({ locator: { role: "button", name: "TikTok Connect", exact: true } });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("No visible, enabled browser element matched exactly");
    expect(result.content).toContain("Nearby current-document candidates (not exact matches");
    expect(result.content).toContain(`@e7 identity=${JSON.stringify(browserIdentity(4))} tab=@t2`);
    expect(result.metadata).toMatchObject({
      nearbyCandidates: [{ ref: "@e7", identity: browserIdentity(4), tabRef: "@t2" }]
    });
  });

  it("surfaces stale and ambiguous browser targets as structured failures", async () => {
    const backend: BrowserBackend = {
      ...createMockBrowserBackend(),
      click: async () => {
        throw new BrowserTargetError({
          reason: "browser-target-ambiguous",
          message: "Browser locator matched 2 current elements; refine the locator instead of guessing.",
          currentIdentity: browserIdentity(9),
          currentTabRef: "@t2",
          candidates: [
            { ref: "@e1", identity: browserIdentity(9), tabRef: "@t2", role: "button", name: "Open" },
            { ref: "@e2", identity: browserIdentity(9), tabRef: "@t2", role: "button", name: "Open" }
          ]
        });
      }
    };

    const result = await tool("browser.click", createTestWebTools({ browserBackend: backend })).run({
      locator: { role: "button", name: "Open" }
    });

    expect(result).toMatchObject({
      ok: false,
      metadata: {
        backend: "mock",
        reason: "browser-target-ambiguous",
        currentIdentity: browserIdentity(9),
        currentTabRef: "@t2",
        candidates: [{ ref: "@e1" }, { ref: "@e2" }]
      }
    });
  });

  it("forwards browser wait conditions and prioritizes compact action deltas", async () => {
    const calls: BrowserActionInput[] = [];
    const browserBackend: BrowserBackend = {
      ...createMockBrowserBackend(),
      click: async (input) => {
        calls.push(input);
        return {
          sessionId: input.sessionId ?? "session-1",
          url: "https://example.com/products/loans",
          identity: browserIdentity(7),
          observedAt: "2026-08-13T00:00:00.000Z",
          readiness: "complete",
          text: "This full snapshot text should not be repeated after an action.",
          elements: [{ ref: "@e2", role: "button", name: "View product" }],
          actionDelta: {
            outcome: "changed",
            beforeIdentity: browserIdentity(6),
            afterIdentity: browserIdentity(7),
            waitCondition: "text",
            conditionMet: true,
            url: {
              changed: true,
              before: "https://example.com/products",
              after: "https://example.com/products/loans"
            },
            addedElements: [{ role: "button", name: "View product" }]
          }
        };
      }
    };
    const click = tool("browser.click", createTestWebTools({
      browserBackend,
      currentSessionId: () => "runtime-session"
    }));

    const result = await click.run({
      ref: "@e1",
      waitFor: { kind: "text", value: "Loan API" },
      waitTimeoutMs: 3_000
    });

    expect(calls[0]).toMatchObject({
      sessionId: "runtime-session:main",
      waitFor: { kind: "text", value: "Loan API" },
      waitTimeoutMs: 3_000
    });
    expect(result.content).toContain("Action completed with an observable page change.");
    expect(result.content).toContain("Identity: documentEpoch=1 actionRevision=6 observationId=6 → documentEpoch=1 actionRevision=7 observationId=7");
    expect(result.content).toContain("Added: button \"View product\"");
    expect(result.content).not.toContain("full snapshot text");
  });

  it("renders action wait timeouts without claiming completion", async () => {
    const browserBackend: BrowserBackend = {
      ...createMockBrowserBackend(),
      press: async (input) => ({
        sessionId: input.sessionId ?? "session-1",
        url: "https://example.com",
        identity: browserIdentity(2),
        observedAt: "2026-08-13T00:00:00.000Z",
        actionDelta: {
          outcome: "timeout",
          beforeIdentity: browserIdentity(2),
          afterIdentity: browserIdentity(2),
          waitCondition: "dialog",
          conditionMet: false,
          url: { changed: false, after: "https://example.com" }
        }
      })
    };
    const press = tool("browser.press", createTestWebTools({ browserBackend }));

    const result = await press.run({ key: "Enter" });

    expect(result.content).toContain("Action wait timed out");
    expect(result.content).not.toContain("Action completed");
    expect(result.content).toContain("Current state:");
    expect(result.content).toContain("Identity: documentEpoch=1 actionRevision=2 observationId=2");
    expect(result.content).toContain("Actionable refs: none");
  });

  it("renders dispatched settlement failures as non-retryable action outcomes", async () => {
    const browserBackend: BrowserBackend = {
      ...createMockBrowserBackend(),
      click: async (input) => ({
        sessionId: input.sessionId ?? "session-1",
        url: "https://example.com/apps/example/edit",
        identity: { documentEpoch: 2, actionRevision: 3, observationId: 4 },
        observedAt: "2026-08-13T00:00:00.000Z",
        actionDelta: {
          outcome: "dispatched-unverified",
          beforeIdentity: browserIdentity(2),
          afterIdentity: { documentEpoch: 2, actionRevision: 3, observationId: 4 },
          waitCondition: "url",
          conditionMet: false,
          actionDispatched: true,
          settlementFailed: true,
          documentChangeObserved: true,
          stateObservation: "post-dispatch",
          url: {
            changed: true,
            before: "https://example.com/apps",
            after: "https://example.com/apps/example/edit"
          }
        }
      })
    };
    const click = tool("browser.click", createTestWebTools({ browserBackend }));

    const result = await click.run({ ref: "@e1" });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Action was dispatched, but settlement verification failed.");
    expect(result.content).toContain("Do not retry automatically");
    expect(result.content).toContain("Document change observed: yes");
    expect(result.metadata).toMatchObject({
      snapshot: {
        actionDelta: {
          actionDispatched: true,
          settlementFailed: true
        }
      }
    });
  });

  it("writes browser.screenshot under a temp workspace root", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "estacoda-web-tools-test-"));
    tempRoots.push(workspaceRoot);
    const screenshot = tool("browser.screenshot", createTestWebTools({
      browserBackend: createMockBrowserBackend(),
      workspaceRoot
    }));

    const result = await screenshot.run({});

    expect(result.ok).toBe(true);
    expect(result.metadata).toMatchObject({
      backend: "mock",
      mimeType: "image/png",
      bytes: 8
    });
    const path = result.metadata?.path;
    expect(typeof path).toBe("string");
    expect((path as string).startsWith(join(workspaceRoot, ".estacoda", "browser", "screenshots"))).toBe(true);
    expect(relative(process.cwd(), path as string).startsWith("..")).toBe(true);
    await expect(readFile(path as string)).resolves.toEqual(Buffer.from("iVBORw0KGgo=", "base64"));
  });

  it("preserves browser provenance when browser.screenshot is followed by vision.analyze", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "estacoda-browser-artifact-vision-"));
    tempRoots.push(workspaceRoot);
    const artifactStore = new ArtifactStore({ id: () => "browser-screenshot" });
    const screenshot = tool("browser.screenshot", createTestWebTools({
      browserBackend: createVisionScreenshotBackend(),
      workspaceRoot,
      artifactStore
    }));
    const screenshotResult = await screenshot.run({}, { visibleTurnId: "turn-browser-artifact" });
    const screenshotPath = screenshotResult.metadata?.path;
    expect(typeof screenshotPath).toBe("string");

    const [vision] = createVisionTools({
      workspaceRoot,
      artifactStore,
      mainRoute: visionRoute,
      visionAuxiliaryRoute: visionAuxiliaryRoute("auto-main")
    });
    const resolution = await vision.resolveSecurity?.({ path: screenshotPath as string }, {
      trustedWorkspace: true,
      sessionId: "session-browser-artifact",
      visibleTurnId: "turn-browser-artifact"
    });
    const analysis = await vision.run({ path: screenshotPath as string });

    expect(artifactStore.list()).toContainEqual(expect.objectContaining({
      id: "browser-screenshot",
      metadata: { visionProvenance: "browser-artifact", visionTurnId: "turn-browser-artifact" }
    }));
    expect(resolution).toMatchObject({
      dataEgress: { sourceProvenance: "browser-artifact" }
    });
    expect(analysis).toMatchObject({ ok: true, metadata: { dispatch: "native" } });
    expect(ephemeralVisionImages(analysis)).toHaveLength(1);
  });

  it("dispatches a browser screenshot natively without an auxiliary provider call", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "estacoda-browser-native-vision-"));
    tempRoots.push(workspaceRoot);
    const screenshot = vi.fn(async () => ({
      mimeType: "image/png" as const,
      base64: VALID_PNG.toString("base64")
    }));
    const executor = createSummaryExecutor("unexpected auxiliary call");
    const dispatcher = createGovernedVisionArtifactDispatcher({
      workspaceRoot,
      mainRoute: visionRoute,
      visionAuxiliaryRoute: visionAuxiliaryRoute("auto-main"),
      providerExecutor: executor as ProviderExecutor,
      currentSessionId: () => "session-native"
    });
    const browserVision = tool("browser.vision", createTestWebTools({
      browserBackend: createVisionScreenshotBackend(screenshot),
      workspaceRoot,
      visionDispatcher: dispatcher
    }));

    const result = await browserVision.run({ prompt: "Inspect the page" }, {
      visibleTurnId: "turn-native",
      providerUsageLineage: { executionSessionId: "session-native", visibleTurnId: "turn-native" }
    });

    expect(result.ok).toBe(true);
    expect(result.metadata).toEqual(expect.objectContaining({ dispatch: "native", backend: "mock" }));
    expect(ephemeralVisionImages(result)).toHaveLength(1);
    expect(screenshot).toHaveBeenCalledTimes(1);
    expect(executor.complete).not.toHaveBeenCalled();
  });

  it("blocks browser.vision only while protected screenshot observation remains active", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "estacoda-browser-protected-vision-"));
    tempRoots.push(workspaceRoot);
    let sensitiveInputActive = true;
    const screenshot = vi.fn(async () => {
      if (sensitiveInputActive) {
        throw Object.assign(
          new Error("Browser screenshot is blocked while protected input is active."),
          { code: "sensitive-input-active" },
        );
      }
      return {
        mimeType: "image/png" as const,
        base64: VALID_PNG.toString("base64"),
      };
    });
    const dispatcher = createGovernedVisionArtifactDispatcher({
      workspaceRoot,
      mainRoute: visionRoute,
      visionAuxiliaryRoute: visionAuxiliaryRoute("auto-main"),
      currentSessionId: () => "session-protected-vision",
    });
    const dispatch = vi.spyOn(dispatcher, "dispatch");
    const browserVision = tool("browser.vision", createTestWebTools({
      browserBackend: createVisionScreenshotBackend(screenshot),
      workspaceRoot,
      visionDispatcher: dispatcher,
    }));

    const blocked = await browserVision.run({ prompt: "Inspect the page" });
    expect(blocked).toMatchObject({
      ok: false,
      metadata: { backend: "mock" },
    });
    expect(blocked.content).toBe("Browser screenshot is blocked while protected input is active.");
    expect(dispatch).not.toHaveBeenCalled();

    sensitiveInputActive = false;
    const resumed = await browserVision.run({ prompt: "Inspect the page" });
    expect(resumed.ok).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("uses exactly one auxiliary analysis call for a browser screenshot with a text-only main route", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "estacoda-browser-aux-vision-"));
    tempRoots.push(workspaceRoot);
    const screenshot = vi.fn(async () => ({
      mimeType: "image/png" as const,
      base64: VALID_PNG.toString("base64")
    }));
    const executor = createSummaryExecutor("browser vision result");
    const dispatcher = createGovernedVisionArtifactDispatcher({
      workspaceRoot,
      mainRoute: summaryRoute,
      visionAuxiliaryRoute: visionAuxiliaryRoute(),
      providerExecutor: executor as ProviderExecutor,
      currentSessionId: () => "session-aux"
    });
    const browserVision = tool("browser.vision", createTestWebTools({
      browserBackend: createVisionScreenshotBackend(screenshot),
      workspaceRoot,
      visionDispatcher: dispatcher
    }));

    const result = await browserVision.run({ prompt: "Inspect the page" }, {
      visibleTurnId: "turn-aux",
      providerUsageLineage: { executionSessionId: "session-aux", visibleTurnId: "turn-aux" }
    });

    expect(result.ok).toBe(true);
    expect(result.metadata).toEqual(expect.objectContaining({ dispatch: "auxiliary", backend: "mock" }));
    expect(ephemeralVisionImages(result)).toHaveLength(0);
    expect(screenshot).toHaveBeenCalledTimes(1);
    expect(executor.complete).toHaveBeenCalledTimes(1);
    expect(executor.complete).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ requireVision: true }),
      expect.objectContaining({
        usage: expect.objectContaining({
          executionSessionId: "session-aux",
          visibleTurnId: "turn-aux"
        })
      })
    );
  });

  it("binds browser artifact egress to every hosted native destination", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "estacoda-browser-vision-security-"));
    tempRoots.push(workspaceRoot);
    const anthropicRoute: ResolvedModelRoute = {
      ...visionRoute,
      provider: "anthropic",
      id: "claude-vision",
      baseUrl: "https://api.anthropic.com/v1",
      profile: { ...visionRoute.profile, provider: "anthropic", id: "claude-vision" }
    };
    const dispatcher = createGovernedVisionArtifactDispatcher({
      workspaceRoot,
      mainRoute: visionRoute,
      mainFallbackRoutes: [anthropicRoute],
      visionAuxiliaryRoute: visionAuxiliaryRoute("auto-main")
    });
    const browserVision = tool("browser.vision", createTestWebTools({
      browserBackend: createVisionScreenshotBackend(),
      workspaceRoot,
      visionDispatcher: dispatcher
    }));

    const resolution = await browserVision.resolveSecurity?.({}, {
      trustedWorkspace: true,
      sessionId: "session-security"
    });

    expect(resolution).toMatchObject({
      riskClass: "external-side-effect",
      dataEgress: {
        sourceProvenance: "browser-artifact",
        sensitivePath: false,
        destinations: [
          "anthropic@https://api.anthropic.com/v1",
          "openai@https://api.openai.com/v1"
        ]
      }
    });
  });

  it("returns unavailable for browser.vision without an analyzer", async () => {
    const vision = tool("browser.vision", createTestWebTools({
      browserBackend: createMockBrowserBackend()
    }));

    const result = await vision.run({});

    expect(result.ok).toBe(false);
    expect(result.metadata).toEqual({
      backend: "mock",
      reason: "vision-unavailable"
    });
  });
});
