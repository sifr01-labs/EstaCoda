import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserActionInput, BrowserBackend } from "../contracts/browser.js";
import { createMockBrowserBackend, createUnconfiguredBrowserBackend } from "../browser/browser-backend.js";
import { createWebTools, type FetchLike } from "./web-tools.js";

const expectedToolNames = [
  "web.extract",
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

describe("web and browser tools baselines", () => {
  let tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
    tempRoots = [];
  });

  it("exposes the expected browser and web tool names", () => {
    expect(createWebTools().map((candidate) => candidate.name)).toEqual(expectedToolNames);
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
      source: "fetch"
    });
    expect(fetch).toHaveBeenCalledWith("https://example.com/article", expect.objectContaining({ method: "GET", redirect: "manual" }));
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

  it("navigates with the mock browser backend and includes backend metadata", async () => {
    const navigate = tool("browser.navigate", createWebTools({
      browserBackend: createMockBrowserBackend({ sessionId: "nav-session", title: "Nav Title", text: "Nav text." }),
      resolveHostname: publicResolver
    }));

    const result = await navigate.run({ url: "https://example.com/app" });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Browser: mock");
    expect(result.content).toContain("Session: nav-session");
    expect(result.content).toContain("URL: https://example.com/app");
    expect(result.metadata).toMatchObject({
      url: "https://example.com/app",
      backend: "mock",
      session: {
        id: "nav-session",
        backend: "mock",
        currentUrl: "https://example.com/app"
      }
    });
  });

  it("reports unconfigured browser.navigate without calling a backend", async () => {
    const navigate = tool("browser.navigate", createWebTools({
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
    const navigate = tool("browser.navigate", createWebTools({ browserBackend: backend }));

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

  it("blocks secret-bearing browser.navigate URLs without leaking raw values", async () => {
    const navigate = tool("browser.navigate", createWebTools({
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
    const navigate = tool("browser.navigate", createWebTools({
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
    const navigate = tool("browser.navigate", createWebTools({
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
    const navigate = tool("browser.navigate", createWebTools({
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
    const navigate = tool("browser.navigate", createWebTools({
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
    expect(cdp.toolsets).toContain("browser");
  });

  it("blocks browser.cdp Page.navigate to metadata and private URLs before the backend call", async () => {
    const calls: BrowserActionInput[] = [];
    const cdp = tool("browser.cdp", createWebTools({
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
    const cdp = tool("browser.cdp", createWebTools({
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
    const cdp = tool("browser.cdp", createWebTools({
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
    const cdp = tool("browser.cdp", createWebTools({
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
    const cdp = tool("browser.cdp", createWebTools({
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
    const cdp = tool("browser.cdp", createWebTools({
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

  it("blocks browser.cdp Runtime.evaluate secret-bearing navigation URLs without leaking raw values", async () => {
    const calls: BrowserActionInput[] = [];
    const cdp = tool("browser.cdp", createWebTools({
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
    const cdp = tool("browser.cdp", createWebTools({
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
    const cdp = tool("browser.cdp", createWebTools({
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
    const cdp = tool("browser.cdp", createWebTools({
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
    const cdp = tool("browser.cdp", createWebTools({
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
    const cdp = tool("browser.cdp", createWebTools({
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

  it("renders browser snapshot text and interactive elements", async () => {
    const snapshot = tool("browser.snapshot", createWebTools({
      browserBackend: createMockBrowserBackend({ title: "Snapshot Title", text: "Snapshot text." })
    }));

    const result = await snapshot.run({});

    expect(result.ok).toBe(true);
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

  it("returns ok false for browser.click with an invalid ref", async () => {
    const click = tool("browser.click", createWebTools({
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
    const screenshot = tool("browser.screenshot", createWebTools({
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
    const vision = tool("browser.vision", createWebTools({
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
