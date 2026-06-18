import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserActionInput, BrowserBackend, BrowserNavigateInput } from "../contracts/browser.js";
import type { ResolvedAuxiliaryRoute, ResolvedModelRoute } from "../contracts/provider.js";
import type { ProviderExecutor, ProviderExecutionResult } from "../providers/provider-executor.js";
import { createMockBrowserBackend, createUnconfiguredBrowserBackend } from "../browser/browser-backend.js";
import { createWebTools, webToolProvider, type FetchLike, type WebToolOptions } from "./web-tools.js";
import { registerWebResearchProvider, resetWebResearchProvidersForTest } from "./web-research-registry.js";
import type { WebResearchProvider } from "./web-research-provider.js";

const expectedToolNames = [
  "web.search",
  "web.extract",
  "web.crawl",
  "browser.status",
  "browser.snapshot",
  "browser.click",
  "browser.type",
  "browser.scroll",
  "browser.press",
  "browser.back",
  "browser.get_images",
  "browser.console",
  "browser.cdp",
  "browser.screenshot",
  "browser.vision",
  "browser.dialog",
  "browser.navigate"
];

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

const publicResolver = async (hostname: string) => hostname === "localhost"
  ? ["127.0.0.1"]
  : ["93.184.216.34"];

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
    attempts: [{ provider: "openai", model: "summary-model", ok: true, content }],
    toolCalls: []
  };
}

function createSummaryExecutor(content: string): Pick<ProviderExecutor, "complete"> {
  return {
    complete: vi.fn(async () => okProviderResult(content))
  };
}

function createLargeSnapshotBackend(text = "Snapshot text. ".repeat(800)): BrowserBackend {
  return {
    ...createMockBrowserBackend(),
    snapshot: async () => ({
      sessionId: "session-1",
      url: "https://example.com/",
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
    title: "Recorded Browser Page",
    text: `Recorded browser snapshot for ${input.sessionId ?? "missing-session"}.`,
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
    click: async (input) => {
      calls.push({ method: "click", input });
      return snapshotFor(input);
    },
    type: async (input) => {
      calls.push({ method: "type", input });
      return snapshotFor(input);
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

    expect(configure).toHaveBeenCalledWith({
      config: {
        searchBackend: "brave",
        brave: {
          apiKeyEnv: "CUSTOM_BRAVE_KEY"
        }
      }
    });
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
    expect(result.content).toContain("[Compact viewport snapshot]");
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
      { toolName: "browser.click", backendMethod: "click", input: { ref: "@e1" } },
      { toolName: "browser.type", backendMethod: "type", input: { ref: "@e1", text: "hello" } },
      { toolName: "browser.scroll", backendMethod: "scroll", input: { direction: "down", amount: 300 } },
      { toolName: "browser.back", backendMethod: "back", input: {} },
      { toolName: "browser.press", backendMethod: "press", input: { key: "Enter" } },
      { toolName: "browser.console", backendMethod: "console", input: {} },
      { toolName: "browser.get_images", backendMethod: "getImages", input: {} },
      { toolName: "browser.screenshot", backendMethod: "screenshot", input: {}, options: { workspaceRoot } },
      {
        toolName: "browser.vision",
        backendMethod: "screenshot",
        input: { prompt: "describe" },
        options: {
          workspaceRoot,
          visionAnalyzer: async () => ({ ok: true, content: "vision ok" })
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

  it("does not require a browser session key for browser.status", async () => {
    const status = tool("browser.status", createWebTools({
      browserBackend: createSessionRecordingBrowserBackend()
    }));

    const result = await status.run({});

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Browser backend: mock");
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
    expect(result.content).toContain("[Compact viewport snapshot]");
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

  it("renders full browser snapshot headers and concise element state", async () => {
    const snapshot = tool("browser.snapshot", createTestWebTools({
      browserBackend: {
        ...createMockBrowserBackend(),
        snapshot: async () => ({
          sessionId: "session-1",
          url: "https://example.com",
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

  it("truncates rendered browser snapshots with a clear suffix", async () => {
    const snapshot = tool("browser.snapshot", createTestWebTools({
      browserBackend: {
        ...createMockBrowserBackend(),
        snapshot: async () => ({
          sessionId: "session-1",
          url: "https://example.com",
          text: "x".repeat(9_000),
          elements: []
        })
      }
    }));

    const result = await snapshot.run({});

    expect(result.ok).toBe(true);
    expect(result.content.length).toBeLessThanOrEqual(8_000);
    expect(result.content).toMatch(/\n\.\.\. \[truncated\]$/u);
  });

  it("browser.snapshot summarizeSnapshots=false skips LLM summarization and truncates", async () => {
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
    expect(result.content).toMatch(/\n\.\.\. \[truncated\]$/u);
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
    expect(skipped.content).toMatch(/\n\.\.\. \[truncated\]$/u);
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
    expect(result.content).toContain("Console:");
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
