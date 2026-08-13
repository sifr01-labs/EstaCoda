import { describe, expect, it, vi } from "vitest";
import type { CdpFetchLike, CdpWebSocketEvent, CdpWebSocketLike } from "./cdp-client.js";
import { createBrowserBackendFromConfig } from "./browser-backend.js";
import { createSupervisedLocalCdpBrowserBackend } from "./supervised-local-cdp-backend.js";
import { BrowserSessionLifecycle } from "./session-lifecycle.js";

class FakeCdpSocket implements CdpWebSocketLike {
  readonly readyState = 1;
  readonly sent: Array<{ id: number; method: string; params?: Record<string, unknown> }> = [];
  readonly #listeners = new Map<string, Array<(event: CdpWebSocketEvent) => void>>();
  readonly failMethods = new Map<string, string>();
  readonly missingElementIndexes = new Set<number>();
  #contextCounter = 0;
  #targetCounter = 0;
  closed = false;
  snapshot = {
    url: "https://example.com/final",
    title: "Supervised Page",
    text: "Supervised text",
    elements: [{ ref: "@e1", role: "button", name: "Open" }] as Array<{
      ref: string;
      role: string;
      name: string;
      withinText?: string;
      label?: string;
      value?: string;
    }>
  };
  axTree: unknown;
  protectedFieldInspection = {
    connected: true,
    current: true,
    visible: true,
    disabled: false,
    editable: true,
    semanticsMatch: true,
    conflictCount: 1
  };
  onRuntimeEvaluate?: (expression: string) => void;

  send(data: string): void {
    const message = JSON.parse(data) as {
      id: number;
      method: string;
      params?: Record<string, unknown>;
    };
    this.sent.push(message);
    if (message.method === "Runtime.evaluate" && typeof message.params?.expression === "string") {
      this.onRuntimeEvaluate?.(message.params.expression);
    }
    if (message.method === "Runtime.evaluate" && typeof message.params?.expression === "string") {
      const index = /__estacodaElements\?\.\[(\d+)\]/u.exec(message.params.expression)?.[1];
      if (index !== undefined && this.missingElementIndexes.has(Number(index))) {
        this.#emit("message", {
          data: JSON.stringify({
            id: message.id,
            error: { message: `Browser element ref not found at index ${index}` }
          })
        });
        return;
      }
    }
    const failure = this.failMethods.get(message.method);
    if (failure !== undefined) {
      this.#emit("message", {
        data: JSON.stringify({
          id: message.id,
          error: { message: failure }
        })
      });
      return;
    }
    const result = this.#resultFor(message);
    this.#emit("message", {
      data: JSON.stringify({
        id: message.id,
        result
      })
    });
    if (message.method === "Page.navigate"
      || (message.method === "Runtime.evaluate" && typeof message.params?.expression === "string" && message.params.expression.includes("history.back"))) {
      setTimeout(() => this.#emit("message", {
        data: JSON.stringify({ method: "Page.loadEventFired", params: {} })
      }), 0);
    }
  }

  close(): void {
    this.closed = true;
    this.#emit("close", {});
  }

  addEventListener(type: "open" | "message" | "error" | "close", listener: (event: CdpWebSocketEvent) => void): void {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener);
    this.#listeners.set(type, listeners);
  }

  #resultFor(message: { method: string; params?: Record<string, unknown> }): unknown {
    const method = message.method;
    if (method === "Target.createBrowserContext") {
      return { browserContextId: `context-${++this.#contextCounter}` };
    }
    if (method === "Target.createTarget") {
      return { targetId: `target-${++this.#targetCounter}` };
    }
    if (method === "Target.getTargets") {
      return {
        targetInfos: Array.from({ length: 20 }, (_, index) => ({
          targetId: `target-${index + 1}`,
          type: "page",
          title: `target-${index + 1}`,
          url: index === 0 ? "https://example.com/final" : `https://example.com/target-${index + 1}`,
          browserContextId: `context-${index + 1}`
        }))
      };
    }
    if (method === "Runtime.evaluate") {
      if (typeof message.params?.expression === "string" && /^window\.__estacodaElements\?\.\[\d+\]$/u.test(message.params.expression)) {
        return { result: { objectId: "protected-field-object" } };
      }
      return { result: { value: JSON.stringify(this.snapshot) } };
    }
    if (method === "Accessibility.getFullAXTree") {
      return this.axTree ?? { nodes: [] };
    }
    if (method === "DOM.resolveNode") {
      return { object: { objectId: `object-${this.sent.at(-1)?.params?.backendNodeId ?? "unknown"}` } };
    }
    if (method === "Runtime.callFunctionOn") {
      if (typeof message.params?.functionDeclaration === "string" && message.params.functionDeclaration.includes("conflictCount")) {
        return { result: { value: this.protectedFieldInspection } };
      }
      return { result: { value: true } };
    }
    if (method === "Page.getFrameTree") {
      return { frameTree: { frame: { id: "main-frame", url: this.snapshot.url } } };
    }
    if (method === "Page.captureScreenshot") {
      return { data: "png-data" };
    }
    return { ok: true, method };
  }

  emitMessage(message: unknown): void {
    this.#emit("message", { data: JSON.stringify(message) });
  }

  #emit(type: string, event: CdpWebSocketEvent): void {
    for (const listener of this.#listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function createSocketFactory() {
  const sockets: FakeCdpSocket[] = [];
  const webSocketFactory = vi.fn(() => {
    const socket = new FakeCdpSocket();
    sockets.push(socket);
    return socket;
  });
  return {
    webSocketFactory,
    sockets,
    browserSocket: () => sockets[0],
    pageSocket: (index = 0) => sockets[index + 1]
  };
}

function createFetch(overrides?: {
  versionOk?: boolean;
  targetOk?: boolean;
}): CdpFetchLike {
  return vi.fn(async (url: string) => {
    if (url.endsWith("/json/version")) {
      return response({
        ok: overrides?.versionOk ?? true,
        status: overrides?.versionOk === false ? 503 : 200,
        statusText: overrides?.versionOk === false ? "Service Unavailable" : "OK",
        payload: {
          Browser: "Chrome/125.0.0.0",
          "Protocol-Version": "1.3",
          webSocketDebuggerUrl: "ws://cdp/browser"
        }
      });
    }
    if (url.endsWith("/json/list")) {
      return response({
        ok: overrides?.targetOk ?? true,
        status: overrides?.targetOk === false ? 500 : 200,
        statusText: overrides?.targetOk === false ? "No Target" : "OK",
        payload: Array.from({ length: 20 }, (_, index) => {
          const id = `target-${index + 1}`;
          return {
            id,
            type: "page",
            title: id,
            url: index === 0 ? "https://example.com/final" : `https://example.com/${id}`,
            browserContextId: `context-${index + 1}`,
            webSocketDebuggerUrl: `ws://cdp/${id}`
          };
        })
      });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  });
}

function createFetchWithFailingEndpoint(failingEndpoint: string): CdpFetchLike {
  const fallback = createFetch();
  return vi.fn(async (url: string, init) => {
    if (url.startsWith(failingEndpoint)) {
      throw new Error("Configured CDP endpoint is unavailable.");
    }
    return fallback(url, init);
  });
}

function createSwitchableCdpHarness(input: {
  configuredEndpoint?: string;
  launchedEndpoint?: string;
} = {}) {
  const configuredEndpoint = input.configuredEndpoint ?? "http://127.0.0.1:9222";
  const launchedEndpoint = input.launchedEndpoint ?? "http://127.0.0.1:7788";
  const socketsByUrl = new Map<string, FakeCdpSocket[]>();
  let configuredContextFailure: string | undefined;

  const fetch = vi.fn(async (url: string) => {
    const endpoint = url.startsWith(configuredEndpoint) ? "configured"
      : url.startsWith(launchedEndpoint) ? "launched"
        : undefined;
    if (endpoint === undefined) {
      throw new Error(`Unexpected fetch URL: ${url}`);
    }
    if (url.endsWith("/json/version")) {
      return response({
        ok: true,
        status: 200,
        statusText: "OK",
        payload: {
          Browser: "Chrome/125.0.0.0",
          "Protocol-Version": "1.3",
          webSocketDebuggerUrl: `ws://${endpoint}/browser`
        }
      });
    }
    if (url.endsWith("/json/list")) {
      return response({
        ok: true,
        status: 200,
        statusText: "OK",
        payload: Array.from({ length: 20 }, (_, index) => {
          const id = `target-${index + 1}`;
          return {
            id,
            type: "page",
            title: id,
            url: `https://${endpoint}.example/${id}`,
            browserContextId: `context-${index + 1}`,
            webSocketDebuggerUrl: `ws://${endpoint}/${id}`
          };
        })
      });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  });

  const webSocketFactory = vi.fn((url: string) => {
    const socket = new FakeCdpSocket();
    socket.snapshot = {
      url: `https://${url.replace(/^ws:\/\//u, "").replace(/\//gu, "-")}.test/final`,
      title: url,
      text: url,
      elements: [{ ref: "@e1", role: "button", name: "Open" }]
    };
    if (url === "ws://configured/browser" && configuredContextFailure !== undefined) {
      socket.failMethods.set("Target.createBrowserContext", configuredContextFailure);
    }
    const sockets = socketsByUrl.get(url) ?? [];
    sockets.push(socket);
    socketsByUrl.set(url, sockets);
    return socket;
  });

  return {
    configuredEndpoint,
    launchedEndpoint,
    fetch,
    webSocketFactory,
    failConfiguredContext(message: string) {
      configuredContextFailure = message;
      for (const socket of socketsByUrl.get("ws://configured/browser") ?? []) {
        socket.failMethods.set("Target.createBrowserContext", message);
      }
    },
    recoverConfiguredContext() {
      configuredContextFailure = undefined;
      for (const socket of socketsByUrl.get("ws://configured/browser") ?? []) {
        socket.failMethods.delete("Target.createBrowserContext");
      }
    },
    socket(url: string, index = 0): FakeCdpSocket | undefined {
      return socketsByUrl.get(url)?.[index];
    }
  };
}

function response(input: {
  ok: boolean;
  status: number;
  statusText: string;
  payload: unknown;
}): Awaited<ReturnType<CdpFetchLike>> {
  return {
    ok: input.ok,
    status: input.status,
    statusText: input.statusText,
    json: async () => input.payload,
    text: async () => JSON.stringify(input.payload)
  };
}

function createLaunchedChrome(endpoint = "http://127.0.0.1:4567") {
  return {
    endpoint,
    port: 4567,
    processId: 123,
    userDataDir: "/tmp/estacoda-chrome-test",
    kill: vi.fn(async () => undefined)
  };
}

describe("supervised local CDP backend", () => {
  it("returns a local-cdp BrowserBackend and preserves opt-in factory wiring", () => {
    const direct = createSupervisedLocalCdpBrowserBackend();
    const configured = createBrowserBackendFromConfig({
      backend: "local-cdp",
      cdpUrl: "http://127.0.0.1:9222",
      supervised: true
    });
    const raw = createBrowserBackendFromConfig({
      backend: "local-cdp",
      cdpUrl: "http://127.0.0.1:9222"
    });

    expect(direct.kind).toBe("local-cdp");
    expect(configured.kind).toBe("local-cdp");
    expect(raw.kind).toBe("local-cdp");
    expect(configured).not.toBe(raw);
  });

  it("isAvailable() follows local CDP availability", async () => {
    const available = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222/",
      fetch: createFetch()
    });
    const unavailable = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      fetch: createFetch({ versionOk: false })
    });

    await expect(available.isAvailable()).resolves.toBe(true);
    await expect(available.status()).resolves.toMatchObject({
      backend: "local-cdp",
      available: true,
      sessionState: "backend_available",
      endpoint: "http://127.0.0.1:9222",
      browser: "Chrome/125.0.0.0",
      version: "1.3"
    });
    await expect(unavailable.isAvailable()).resolves.toBe(false);
  });

  it("reports lazy auto-launch as available without launching Chrome during readiness checks", async () => {
    const findChromiumExecutable = vi.fn(async () => ({
      executablePath: "/usr/bin/chromium",
      source: "launchExecutable" as const
    }));
    const launchChrome = vi.fn(async () => createLaunchedChrome());
    const backend = createSupervisedLocalCdpBrowserBackend({
      autoLaunch: true,
      launchExecutable: "/usr/bin/chromium",
      findChromiumExecutable,
      launchChrome
    });

    await expect(backend.isAvailable()).resolves.toBe(true);
    await expect(backend.status()).resolves.toEqual({
      backend: "local-cdp",
      available: true,
      sessionState: "backend_available",
      reason: "Chrome/Chromium auto-launch is ready and will start on the first browser action."
    });
    expect(findChromiumExecutable).toHaveBeenCalledWith({
      launchExecutable: "/usr/bin/chromium",
      launchCommand: undefined
    });
    expect(launchChrome).not.toHaveBeenCalled();
  });

  it("reports lazy auto-launch as unavailable when Chrome cannot be discovered", async () => {
    const launchChrome = vi.fn(async () => createLaunchedChrome());
    const backend = createSupervisedLocalCdpBrowserBackend({
      autoLaunch: true,
      findChromiumExecutable: vi.fn(async () => ({ executablePath: undefined })),
      launchChrome
    });

    await expect(backend.isAvailable()).resolves.toBe(false);
    await expect(backend.status()).resolves.toEqual({
      backend: "local-cdp",
      available: false,
      sessionState: "browser_process_missing",
      reason: "CDP URL is not configured and Chrome/Chromium auto-launch is unavailable because no executable was found."
    });
    expect(launchChrome).not.toHaveBeenCalled();
  });

  it("navigate() creates a session and returns the supervisor snapshot", async () => {
    const socket = new FakeCdpSocket();
    const fetch = createFetch();
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222/",
      fetch,
      webSocketFactory: vi.fn(() => socket)
    });

    await expect(backend.navigate({ url: "https://example.com/start", sessionId: "session-1" })).resolves.toMatchObject({
      session: {
        id: "session-1",
        backend: "local-cdp",
        currentUrl: "https://example.com/final"
      },
      snapshot: {
        sessionId: "session-1",
        url: "https://example.com/final",
        title: "Supervised Page",
        text: "Supervised text",
        elements: [{ ref: "@e1", role: "button", name: "Open" }]
      }
    });
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:9222/json/version");
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:9222/json/list");
    expect(socket.sent.map((message) => message.method)).toEqual(expect.arrayContaining([
      "Target.createBrowserContext",
      "Target.createTarget",
      "Page.navigate"
    ]));
  });

  it("reuses the same managed session and browser context for the same session key", async () => {
    const socket = new FakeCdpSocket();
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      fetch: createFetch(),
      webSocketFactory: () => socket,
      resolveHostname: () => ["93.184.216.34"]
    });

    await backend.navigate({ url: "https://example.com/one", sessionId: "session-1" });
    await backend.navigate({ url: "https://example.com/two", sessionId: "session-1" });

    expect(socket.sent.filter((message) => message.method === "Target.createBrowserContext")).toHaveLength(1);
    expect(socket.sent.filter((message) => message.method === "Target.createTarget")).toHaveLength(1);
    expect(socket.sent.filter((message) => message.method === "Page.navigate")).toHaveLength(2);
  });

  it("creates different managed sessions and browser contexts for different session keys", async () => {
    const socket = new FakeCdpSocket();
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      fetch: createFetch(),
      webSocketFactory: () => socket
    });

    await backend.navigate({ url: "https://example.com/one", sessionId: "session-1" });
    await backend.navigate({ url: "https://example.com/two", sessionId: "session-2" });

    expect(socket.sent.filter((message) => message.method === "Target.createBrowserContext")).toHaveLength(2);
    expect(socket.sent.filter((message) => message.method === "Target.createTarget")).toHaveLength(2);
  });

  it("auto-launches supervised local CDP when no cdpUrl is configured", async () => {
    const socket = new FakeCdpSocket();
    const fetch = createFetch();
    const findChromiumExecutable = vi.fn(async () => ({
      executablePath: "/usr/bin/chromium",
      source: "launchExecutable" as const
    }));
    const launchedChrome = createLaunchedChrome();
    const launchChrome = vi.fn(async () => launchedChrome);
    const backend = createSupervisedLocalCdpBrowserBackend({
      autoLaunch: true,
      launchExecutable: "/usr/bin/chromium",
      launchCommand: "google-chrome",
      launchArgs: ["--app=https://example.test"],
      chromeFlags: ["--disable-gpu"],
      headless: false,
      fetch,
      webSocketFactory: () => socket,
      findChromiumExecutable,
      launchChrome
    });

    await expect(backend.navigate({ url: "https://example.com/start", sessionId: "session-1" })).resolves.toMatchObject({
      session: {
        id: "session-1",
        backend: "local-cdp",
        currentUrl: "https://example.com/final"
      }
    });

    expect(findChromiumExecutable).toHaveBeenCalledWith({
      launchExecutable: "/usr/bin/chromium",
      launchCommand: "google-chrome"
    });
    expect(launchChrome).toHaveBeenCalledWith(expect.objectContaining({
      launchExecutable: "/usr/bin/chromium",
      launchArgs: ["--app=https://example.test"],
      chromeFlags: ["--disable-gpu"],
      headless: false
    }));
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:4567/json/version");
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:4567/json/list");
  });

  it("reuses a working explicit cdpUrl when autoLaunch is enabled", async () => {
    const findChromiumExecutable = vi.fn(async () => ({ executablePath: "/usr/bin/chromium", source: "platformDefault" as const }));
    const launchChrome = vi.fn(async () => createLaunchedChrome());
    const fetch = createFetch();
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222/",
      autoLaunch: true,
      fetch,
      webSocketFactory: () => new FakeCdpSocket(),
      findChromiumExecutable,
      launchChrome
    });

    const navigation = await backend.navigate({ url: "https://example.com/start", sessionId: "session-1" });

    expect(findChromiumExecutable).not.toHaveBeenCalled();
    expect(launchChrome).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:9222/json/version");
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:9222/json/list");
  });

  it("falls back to auto-launch when an explicit cdpUrl fails", async () => {
    const findChromiumExecutable = vi.fn(async () => ({ executablePath: "/usr/bin/chromium", source: "platformDefault" as const }));
    const launchedChrome = createLaunchedChrome("http://127.0.0.1:7788");
    const launchChrome = vi.fn(async () => launchedChrome);
    const fetch = createFetchWithFailingEndpoint("http://127.0.0.1:9222");
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      autoLaunch: true,
      fetch,
      webSocketFactory: () => new FakeCdpSocket(),
      findChromiumExecutable,
      launchChrome
    });

    await expect(backend.navigate({ url: "https://example.com/start", sessionId: "session-1" })).resolves.toMatchObject({
      session: {
        id: "session-1",
        currentUrl: "https://example.com/final"
      }
    });

    expect(launchChrome).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:9222/json/version");
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:7788/json/version");
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:7788/json/list");
  });

  it("keeps session ownership per stack across configured fallback and recovery", async () => {
    const harness = createSwitchableCdpHarness();
    const launchedChrome = createLaunchedChrome(harness.launchedEndpoint);
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: harness.configuredEndpoint,
      autoLaunch: true,
      fetch: harness.fetch,
      webSocketFactory: harness.webSocketFactory,
      resolveHostname: () => ["93.184.216.34"],
      findChromiumExecutable: vi.fn(async () => ({ executablePath: "/usr/bin/chromium", source: "platformDefault" as const })),
      launchChrome: vi.fn(async () => launchedChrome)
    }) as ReturnType<typeof createSupervisedLocalCdpBrowserBackend> & {
      closeSession(sessionId: string): Promise<void>;
    };

    await backend.navigate({ url: "https://example.com/configured", sessionId: "configured-session" });
    const firstConfiguredPage = harness.socket("ws://configured/target-1");
    expect(firstConfiguredPage).toBeDefined();

    harness.failConfiguredContext("configured browser context failed");
    const launchedNavigation = await backend.navigate({ url: "https://example.com/launched", sessionId: "launched-session" });
    const launchedPage = harness.socket("ws://launched/target-1");
    expect(launchedPage).toBeDefined();
    expect(firstConfiguredPage?.closed).toBe(true);
    await expect(backend.snapshot?.({ sessionId: "configured-session" })).rejects.toThrow("Browser session not found: configured-session");
    expect(launchedChrome.kill).not.toHaveBeenCalled();

    harness.recoverConfiguredContext();
    await backend.navigate({ url: "https://example.com/configured-again", sessionId: "configured-session-2" });
    const secondConfiguredPage = harness.socket("ws://configured/target-1", 1);
    expect(secondConfiguredPage).toBeDefined();

    const launchedEvalCount = launchedPage?.sent.filter((message) => message.method === "Runtime.evaluate").length ?? 0;
    const configuredEvalCount = secondConfiguredPage?.sent.filter((message) => message.method === "Runtime.evaluate").length ?? 0;
    await backend.click?.({
      sessionId: "launched-session",
      ref: "@e1",
      revision: launchedNavigation.snapshot.revision,
      tabRef: launchedNavigation.snapshot.tab!.ref
    });
    expect(launchedPage?.sent.filter((message) => message.method === "Runtime.evaluate").length).toBeGreaterThan(launchedEvalCount + 1);
    expect(secondConfiguredPage?.sent.filter((message) => message.method === "Runtime.evaluate")).toHaveLength(configuredEvalCount);

    await backend.closeSession("launched-session");

    expect(launchedPage?.closed).toBe(true);
    expect(secondConfiguredPage?.closed).toBe(false);
    expect(launchedChrome.kill).toHaveBeenCalledTimes(1);
    await expect(backend.snapshot?.({ sessionId: "configured-session-2" })).resolves.toMatchObject({
      sessionId: "configured-session-2"
    });

    await backend.closeSession("configured-session-2");
    await backend.closeSession("configured-session-2");

    expect(secondConfiguredPage?.closed).toBe(true);
    expect(launchedChrome.kill).toHaveBeenCalledTimes(1);
  });

  it("fails clearly when auto-launch cannot find Chromium", async () => {
    const findChromiumExecutable = vi.fn(async () => ({ executablePath: undefined }));
    const launchChrome = vi.fn(async () => createLaunchedChrome());
    const backend = createSupervisedLocalCdpBrowserBackend({
      autoLaunch: true,
      fetch: createFetch(),
      webSocketFactory: () => new FakeCdpSocket(),
      findChromiumExecutable,
      launchChrome
    });

    await expect(backend.navigate({ url: "https://example.com/start", sessionId: "session-1" })).rejects.toThrow(
      "Chromium executable was not found using browser.launchExecutable, deprecated browser.launchCommand, CHROME_PATH, CHROMIUM_PATH, node_modules/.bin/chromium, platform defaults, Homebrew paths, or Docker paths. Set browser.launchExecutable or pass --launch-executable."
    );
    expect(launchChrome).not.toHaveBeenCalled();
  });

  it("surfaces Chrome launch failures directly", async () => {
    const launchFailure = new Error("Chrome DevToolsActivePort contained an invalid port: nope");
    const backend = createSupervisedLocalCdpBrowserBackend({
      autoLaunch: true,
      fetch: createFetch(),
      webSocketFactory: () => new FakeCdpSocket(),
      findChromiumExecutable: vi.fn(async () => ({ executablePath: "/usr/bin/chromium", source: "platformDefault" as const })),
      launchChrome: vi.fn(async () => {
        throw launchFailure;
      })
    });

    await expect(backend.navigate({ url: "https://example.com/start", sessionId: "session-1" })).rejects.toThrow(launchFailure.message);
  });

  it("explains the fallback sequence when explicit cdpUrl and auto-launch both fail", async () => {
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      autoLaunch: true,
      fetch: createFetchWithFailingEndpoint("http://127.0.0.1:9222"),
      webSocketFactory: () => new FakeCdpSocket(),
      findChromiumExecutable: vi.fn(async () => ({ executablePath: "/usr/bin/chromium", source: "platformDefault" as const })),
      launchChrome: vi.fn(async () => {
        throw new Error("Chrome DevToolsActivePort contained an invalid port: nope");
      })
    });

    let thrown: unknown;
    try {
      await backend.navigate({ url: "https://example.com/start", sessionId: "session-1" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(
      "Configured CDP endpoint http://127.0.0.1:9222 failed (Failed to create browser session for key"
    );
    expect((thrown as Error).message).toContain(
      "auto-launch fallback also failed: Chrome DevToolsActivePort contained an invalid port: nope"
    );
  });

  it("snapshot() returns the existing session supervisor snapshot", async () => {
    const socket = new FakeCdpSocket();
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      fetch: createFetch(),
      webSocketFactory: () => socket
    });

    await backend.navigate({ url: "https://example.com/start", sessionId: "session-1" });
    socket.snapshot = {
      url: "https://example.com/after",
      title: "After",
      text: "Updated",
      elements: []
    };

    await expect(backend.snapshot?.({ sessionId: "session-1" })).resolves.toMatchObject({
      sessionId: "session-1",
      url: "https://example.com/after",
      title: "After",
      text: "Updated"
    });
  });

  it("snapshot() passes full snapshot mode to the supervisor path", async () => {
    const socket = new FakeCdpSocket();
    socket.axTree = {
      nodes: [
        { nodeId: "heading-1", role: { value: "heading" }, name: { value: "Overview" } },
        { nodeId: "button-1", backendDOMNodeId: 101, role: { value: "button" }, name: { value: "Open" } }
      ]
    };
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      fetch: createFetch(),
      webSocketFactory: () => socket,
      resolveHostname: () => ["93.184.216.34"]
    });

    await backend.navigate({ url: "https://example.com/start", sessionId: "session-1" });
    const compact = await backend.snapshot?.({ sessionId: "session-1" });
    const full = await backend.snapshot?.({ sessionId: "session-1", full: true });

    expect(compact?.elements).toEqual([{ ref: "@e1", role: "button", name: "Open" }]);
    expect(full?.elements).toEqual([
      { ref: "@e1", role: "heading", name: "Overview" },
      { ref: "@e2", role: "button", name: "Open" }
    ]);
    await backend.click?.({
      sessionId: "session-1",
      ref: "@e2",
      revision: full!.revision,
      tabRef: full!.tab!.ref
    });
    expect(socket.sent).toContainEqual(expect.objectContaining({
      method: "Runtime.evaluate",
      params: expect.objectContaining({ expression: expect.stringContaining("__estacodaElements?.[1]") })
    }));
  });

  it("click() can use AX-derived button refs bound to DOM nodes", async () => {
    const socket = new FakeCdpSocket();
    socket.axTree = {
      nodes: [
        { nodeId: "button-1", backendDOMNodeId: 101, role: { value: "button" }, name: { value: "Open" } }
      ]
    };
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      fetch: createFetch(),
      webSocketFactory: () => socket,
      resolveHostname: () => ["93.184.216.34"]
    });

    const navigation = await backend.navigate({ url: "https://example.com/start", sessionId: "session-1" });
    await expect(backend.click?.({
      sessionId: "session-1",
      ref: "@e1",
      revision: navigation.snapshot.revision,
      tabRef: navigation.snapshot.tab!.ref
    })).resolves.toMatchObject({
      sessionId: "session-1"
    });

    expect(socket.sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "DOM.resolveNode", params: { backendNodeId: 101 } }),
      expect.objectContaining({ method: "Runtime.callFunctionOn" }),
      expect.objectContaining({
        method: "Runtime.evaluate",
        params: expect.objectContaining({
          expression: expect.stringContaining("window.__estacodaElements?.[0]")
        })
      })
    ]));
  });

  it("resolves card-scoped semantic locators against the current revision", async () => {
    const socket = new FakeCdpSocket();
    socket.snapshot = {
      ...socket.snapshot,
      text: "Loans V2 Security MTN OAuth V1",
      elements: [
        { ref: "@e1", role: "button", name: "View product", withinText: "Loans V2" },
        { ref: "@e2", role: "button", name: "View product", withinText: "Security MTN OAuth V1" }
      ]
    };
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      fetch: createFetch(),
      webSocketFactory: () => socket,
      resolveHostname: () => ["93.184.216.34"]
    });

    await backend.navigate({ url: "https://example.com/start", sessionId: "session-1" });
    const found = await backend.find?.({
      sessionId: "session-1",
      locator: { role: "button", name: "View product", withinText: "OAuth V1" }
    });
    await backend.click?.({
      sessionId: "session-1",
      locator: { role: "button", name: "View product", withinText: "OAuth V1" }
    });

    expect(found).toMatchObject({ status: "found", candidates: [{ ref: "@e2" }] });
    expect(socket.sent).toContainEqual(expect.objectContaining({
      method: "Runtime.evaluate",
      params: expect.objectContaining({ expression: expect.stringContaining("__estacodaElements?.[1]") })
    }));
  });

  it("rejects stale and cross-tab refs before dispatching an action", async () => {
    const socket = new FakeCdpSocket();
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      fetch: createFetch(),
      webSocketFactory: () => socket,
      resolveHostname: () => ["93.184.216.34"]
    });
    const navigation = await backend.navigate({ url: "https://example.com/start", sessionId: "session-1" });
    socket.snapshot = { ...socket.snapshot, text: "Externally changed" };

    await expect(backend.click?.({
      sessionId: "session-1",
      ref: "@e1",
      revision: navigation.snapshot.revision,
      tabRef: navigation.snapshot.tab!.ref
    })).rejects.toMatchObject({ reason: "stale-browser-ref", currentRevision: navigation.snapshot.revision + 1 });
    await expect(backend.click?.({
      sessionId: "session-1",
      ref: "@e1",
      revision: navigation.snapshot.revision + 1,
      tabRef: "@t99"
    })).rejects.toMatchObject({ reason: "browser-ref-wrong-tab", currentTabRef: navigation.snapshot.tab!.ref });
  });

  it("selects by label and extracts the resolved current element", async () => {
    const socket = new FakeCdpSocket();
    socket.snapshot = {
      ...socket.snapshot,
      elements: [{ ref: "@e1", role: "select", name: "Environment", label: "Environment", value: "Sandbox" }]
    };
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      fetch: createFetch(),
      webSocketFactory: () => socket,
      resolveHostname: () => ["93.184.216.34"]
    });
    await backend.navigate({ url: "https://example.com/start", sessionId: "session-1" });

    await backend.select?.({
      sessionId: "session-1",
      locator: { role: "select", label: "Environment" },
      value: "Production"
    });
    const extracted = await backend.extract?.({
      sessionId: "session-1",
      locator: { role: "select", label: "Environment" }
    });

    expect(socket.sent).toContainEqual(expect.objectContaining({
      method: "Runtime.evaluate",
      params: expect.objectContaining({ expression: expect.stringContaining("HTMLSelectElement") })
    }));
    expect(extracted).toMatchObject({ target: { ref: "@e1", label: "Environment" }, value: "Sandbox" });
  });

  it("redacts secret-looking extracted values", async () => {
    const socket = new FakeCdpSocket();
    socket.snapshot = {
      ...socket.snapshot,
      elements: [{ ref: "@e1", role: "textbox", name: "API key", label: "API key", value: "api_key=do-not-render" }]
    };
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      fetch: createFetch(),
      webSocketFactory: () => socket,
      resolveHostname: () => ["93.184.216.34"]
    });
    await backend.navigate({ url: "https://example.com/start", sessionId: "session-1" });

    const extracted = await backend.extract?.({
      sessionId: "session-1",
      locator: { role: "textbox", label: "API key" }
    });

    expect(JSON.stringify(extracted)).not.toContain("do-not-render");
    expect(extracted?.value).toContain("[REDACTED]");
  });

  it("verifies and delivers protected input without embedding the value in evaluated source", async () => {
    const socket = new FakeCdpSocket();
    socket.snapshot = {
      url: "https://accounts.example.com/login",
      title: "Sign in",
      text: "Sign in",
      elements: [{ ref: "@e1", role: "textbox", name: "Password" }]
    };
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      fetch: createFetch(),
      webSocketFactory: () => socket,
      resolveHostname: () => ["93.184.216.34"]
    });
    const navigation = await backend.navigate({
      url: "https://accounts.example.com/login",
      sessionId: "session-1"
    });
    const destination = await backend.prepareProtectedField?.({
      sessionId: "session-1",
      ref: "@e1",
      revision: navigation.snapshot.revision,
      tabRef: navigation.snapshot.tab!.ref
    });

    expect(destination).toEqual({
      type: "browser-field",
      sessionId: "session-1",
      ref: "@e1",
      expectedOrigin: "https://accounts.example.com",
      tabRef: navigation.snapshot.tab!.ref,
      frameId: "main-frame"
    });
    await expect(backend.verifyProtectedField?.({
      destination: destination!,
      kind: "password",
      phase: "before-collection"
    })).resolves.toEqual({ status: "verified" });

    const guardedSnapshot = await backend.snapshot?.({ sessionId: "session-1" });
    expect(guardedSnapshot).toMatchObject({ sensitiveInputActive: true });
    expect(guardedSnapshot).not.toHaveProperty("text");
    expect(guardedSnapshot?.elements?.[0]).not.toHaveProperty("name");
    await expect(backend.screenshot?.({ sessionId: "session-1" })).rejects.toMatchObject({
      code: "sensitive-input-active"
    });
    await expect(backend.cdp?.({ sessionId: "session-1", method: "Page.captureScreenshot" })).rejects.toThrow(
      "Raw browser CDP access is blocked"
    );

    const secret = "browser-sentinel-secret";
    await expect(backend.verifyProtectedField?.({
      destination: destination!,
      kind: "password",
      phase: "before-delivery"
    })).resolves.toEqual({ status: "verified" });
    await backend.deliverProtectedField?.({
      destination: destination!,
      kind: "password",
      value: new TextEncoder().encode(secret)
    });
    await backend.releaseProtectedField?.(destination!);
    socket.snapshot.elements[0]!.value = secret;

    const sent = socket.sent.filter((message) =>
      message.method === "Runtime.evaluate" || message.method === "Runtime.callFunctionOn"
    );
    expect(sent.some((message) => (JSON.stringify(message.params?.arguments) ?? "").includes(secret))).toBe(true);
    expect(sent.some((message) => String(message.params?.expression ?? "").includes(secret))).toBe(false);
    expect(sent.some((message) => String(message.params?.functionDeclaration ?? "").includes(secret))).toBe(false);
    const afterDeliverySnapshot = await backend.snapshot?.({ sessionId: "session-1" });
    expect(JSON.stringify(afterDeliverySnapshot)).not.toContain(secret);
    expect(JSON.stringify(await backend.extract?.({
      sessionId: "session-1",
      ref: "@e1",
      revision: afterDeliverySnapshot!.revision,
      tabRef: afterDeliverySnapshot!.tab!.ref
    }))).not.toContain(secret);
    await expect(backend.getImages?.({ sessionId: "session-1" })).resolves.toEqual([]);
    const protectedTabs = await backend.tabs?.({ sessionId: "session-1" });
    expect(protectedTabs?.tabs.every((tab) => tab.title === undefined && new URL(tab.url).pathname === "/")).toBe(true);
    await expect(backend.screenshot?.({ sessionId: "session-1" })).rejects.toMatchObject({
      code: "sensitive-input-active"
    });

    socket.snapshot.url = "https://accounts.example.com/complete";
    await backend.press?.({ sessionId: "session-1", key: "Enter" });
    await expect(backend.screenshot?.({ sessionId: "session-1" })).resolves.toMatchObject({ base64: "png-data" });
  });

  it("rejects changed origins, frames, fields, and ambiguous credential targets", async () => {
    const socket = new FakeCdpSocket();
    socket.snapshot = {
      url: "https://accounts.example.com/login",
      title: "Sign in",
      text: "Sign in",
      elements: [{ ref: "@e1", role: "textbox", name: "Password" }]
    };
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      fetch: createFetch(),
      webSocketFactory: () => socket,
      resolveHostname: () => ["93.184.216.34"]
    });
    const navigation = await backend.navigate({ url: socket.snapshot.url, sessionId: "session-1" });
    const base = {
      type: "browser-field" as const,
      sessionId: "session-1",
      ref: "@e1",
      expectedOrigin: "https://accounts.example.com",
      tabRef: navigation.snapshot.tab!.ref,
      frameId: "main-frame"
    };

    await expect(backend.verifyProtectedField?.({
      destination: { ...base, expectedOrigin: "https://attacker.example" },
      kind: "password",
      phase: "before-collection"
    })).resolves.toEqual({ status: "rejected", reason: "origin-mismatch" });
    await expect(backend.verifyProtectedField?.({
      destination: { ...base, frameId: "attacker-frame" },
      kind: "password",
      phase: "before-collection"
    })).resolves.toEqual({ status: "rejected", reason: "frame-mismatch" });

    socket.protectedFieldInspection.conflictCount = 2;
    await expect(backend.verifyProtectedField?.({
      destination: base,
      kind: "password",
      phase: "before-collection"
    })).resolves.toEqual({ status: "rejected", reason: "field-ambiguous" });
    socket.protectedFieldInspection.conflictCount = 1;
    await expect(backend.verifyProtectedField?.({
      destination: base,
      kind: "password",
      phase: "before-collection"
    })).resolves.toEqual({ status: "verified" });
    socket.protectedFieldInspection.current = false;
    await expect(backend.verifyProtectedField?.({
      destination: base,
      kind: "password",
      phase: "before-delivery"
    })).resolves.toEqual({ status: "rejected", reason: "field-replaced" });
    await backend.releaseProtectedField?.(base);
  });

  it("click() waits for an asynchronous React-style update and returns its delta", async () => {
    const sockets = createSocketFactory();
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      fetch: createFetch(),
      webSocketFactory: sockets.webSocketFactory,
      resolveHostname: () => ["93.184.216.34"],
      settling: {
        pollIntervalMs: 5,
        stableWindowMs: 10,
        minimumObservationMs: 20
      }
    });

    const navigation = await backend.navigate({
      url: "https://example.com/start",
      sessionId: "session-1"
    });
    const page = sockets.pageSocket();
    expect(page).toBeDefined();
    page!.onRuntimeEvaluate = (expression) => {
      if (!expression.includes(".click()")) return;
      setTimeout(() => {
        page!.snapshot = {
          url: "https://example.com/final",
          title: "Supervised Page",
          text: "React update complete",
          elements: [{ ref: "@e1", role: "button", name: "View product" }]
        };
      }, 10);
    };

    const result = await backend.click?.({
      sessionId: "session-1",
      ref: "@e1",
      revision: navigation.snapshot.revision,
      tabRef: navigation.snapshot.tab!.ref,
      waitFor: { kind: "text", value: "React update complete" },
      waitTimeoutMs: 200
    });

    expect(result).toMatchObject({
      text: "React update complete",
      actionDelta: {
        outcome: "changed",
        beforeRevision: navigation.snapshot.revision,
        conditionMet: true,
        addedElements: [{ role: "button", name: "View product" }]
      }
    });
    expect(result!.revision).toBeGreaterThan(navigation.snapshot.revision);
  });

  it("click() follows one newly opened safe tab and focuses its snapshot", async () => {
    const mainSnapshot = {
      sessionId: "session-1",
      url: "https://example.com/apps",
      title: "Apps",
      text: "Apps",
      elements: [{ ref: "@e1", role: "link", name: "Loans" }]
    };
    const detailSnapshot = {
      sessionId: "session-1",
      url: "https://example.com/products/loans",
      title: "Loans",
      text: "Loan API",
      elements: []
    };
    const mainSupervisor = {
      send: vi.fn(async () => ({})),
      waitFor: vi.fn(async () => undefined),
      getSnapshot: vi.fn(async () => mainSnapshot),
      consoleHistory: vi.fn(() => []),
      respondToDialog: vi.fn(async () => undefined),
      close: vi.fn()
    };
    const detailSupervisor = {
      ...mainSupervisor,
      send: vi.fn(async () => ({})),
      getSnapshot: vi.fn(async () => detailSnapshot),
      close: vi.fn()
    };
    const session = {
      key: "session-1",
      browserContextId: "context-1",
      targetId: "target-1",
      tabRef: "@t1",
      pageWebSocketDebuggerUrl: "ws://target-1",
      supervisor: mainSupervisor,
      lastActiveAt: 1,
      touch: vi.fn(),
      close: vi.fn(async () => undefined)
    };
    let tabListCalls = 0;
    const sessionManager = {
      acquire: vi.fn(async () => session),
      close: vi.fn(async () => undefined),
      closeAll: vi.fn(async () => undefined),
      has: vi.fn(() => true),
      listTabs: vi.fn(async () => {
        tabListCalls += 1;
        return [
          { browserContextId: "context-1", targetId: "target-1", pageWebSocketDebuggerUrl: "ws://target-1", url: mainSnapshot.url, title: mainSnapshot.title, ref: "@t1", controlled: session.targetId === "target-1" },
          ...(tabListCalls === 1 ? [] : [{ browserContextId: "context-1", targetId: "target-2", pageWebSocketDebuggerUrl: "ws://target-2", url: detailSnapshot.url, title: detailSnapshot.title, ref: "@t2", controlled: session.targetId === "target-2" }])
        ];
      }),
      switchTab: vi.fn(async () => {
        session.targetId = "target-2";
        session.tabRef = "@t2";
        session.pageWebSocketDebuggerUrl = "ws://target-2";
        session.supervisor = detailSupervisor;
        return session;
      })
    };
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      fetch: createFetch(),
      resolveHostname: () => ["93.184.216.34"],
      createTargetManager: () => ({
        createTarget: vi.fn(async () => { throw new Error("unused"); }),
        close: vi.fn(async () => undefined)
      }),
      createSessionManager: () => sessionManager
    });

    const navigation = await backend.navigate({ url: mainSnapshot.url, sessionId: "session-1" });
    const result = await backend.click?.({
      sessionId: "session-1",
      ref: "@e1",
      revision: navigation.snapshot.revision,
      tabRef: navigation.snapshot.tab!.ref
    });

    expect(sessionManager.switchTab).toHaveBeenCalledWith("session-1", "@t2");
    expect(result).toMatchObject({
      url: detailSnapshot.url,
      title: "Loans",
      tab: { ref: "@t2", controlled: true },
      openedTabs: [{ ref: "@t2", controlled: true }],
      actionDelta: {
        outcome: "changed",
        openedTabs: [{ ref: "@t2" }]
      }
    });
  });

  it("lists and switches only same-session tabs allowed by browser URL policy", async () => {
    const snapshot = {
      sessionId: "session-1",
      url: "https://example.com/apps",
      title: "Apps",
      text: "Apps",
      elements: []
    };
    const supervisor = {
      send: vi.fn(async () => ({})),
      waitFor: vi.fn(async () => undefined),
      getSnapshot: vi.fn(async () => snapshot),
      consoleHistory: vi.fn(() => []),
      respondToDialog: vi.fn(async () => undefined),
      close: vi.fn()
    };
    const unsafeSupervisor = {
      ...supervisor,
      getSnapshot: vi.fn(async () => ({
        ...snapshot,
        url: "http://169.254.169.254/latest",
        title: "Metadata"
      }))
    };
    const session = {
      key: "session-1",
      browserContextId: "context-1",
      targetId: "target-1",
      tabRef: "@t1",
      pageWebSocketDebuggerUrl: "ws://target-1",
      supervisor,
      lastActiveAt: 1,
      touch: vi.fn(),
      close: vi.fn(async () => undefined)
    };
    const switchTab = vi.fn(async (_sessionId: string, tabRef: string) => {
      if (tabRef === "@t4") {
        session.targetId = "target-4";
        session.tabRef = "@t4";
        session.supervisor = unsafeSupervisor;
      } else if (tabRef === "@t1") {
        session.targetId = "target-1";
        session.tabRef = "@t1";
        session.supervisor = supervisor;
      }
      return session;
    });
    const sessionManager = {
      acquire: vi.fn(async () => session),
      close: vi.fn(async () => undefined),
      closeAll: vi.fn(async () => undefined),
      has: vi.fn(() => true),
      listTabs: vi.fn(async () => [
        { browserContextId: "context-1", targetId: "target-1", pageWebSocketDebuggerUrl: "ws://target-1", url: snapshot.url, title: snapshot.title, ref: "@t1", controlled: true },
        { browserContextId: "context-1", targetId: "target-2", pageWebSocketDebuggerUrl: "ws://target-2", url: "http://169.254.169.254/latest", title: "Metadata", ref: "@t2", controlled: false },
        { browserContextId: "context-1", targetId: "target-3", pageWebSocketDebuggerUrl: "ws://target-3", url: "https://example.com/?token=do-not-render", title: "Secret", ref: "@t3", controlled: false },
        { browserContextId: "context-1", targetId: "target-4", pageWebSocketDebuggerUrl: "ws://target-4", url: "https://example.com/racy", title: "Racy", ref: "@t4", controlled: false },
        { browserContextId: "context-1", targetId: "target-5", pageWebSocketDebuggerUrl: "ws://target-5", url: "https://tab-user:do-not-render@example.com/private", title: "Credentials", ref: "@t5", controlled: false }
      ]),
      switchTab
    };
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      fetch: createFetch(),
      resolveHostname: () => ["93.184.216.34"],
      createTargetManager: () => ({
        createTarget: vi.fn(async () => { throw new Error("unused"); }),
        close: vi.fn(async () => undefined)
      }),
      createSessionManager: () => sessionManager
    });

    await backend.navigate({ url: snapshot.url, sessionId: "session-1" });
    const tabs = await backend.tabs?.({ sessionId: "session-1" });

    expect(tabs).toEqual({
      sessionId: "session-1",
      tabs: [
        { ref: "@t1", url: snapshot.url, title: snapshot.title, controlled: true },
        { ref: "@t4", url: "https://example.com/racy", title: "Racy", controlled: false }
      ],
      blockedCount: 3
    });
    expect(JSON.stringify(tabs)).not.toContain("do-not-render");
    expect(JSON.stringify(tabs)).not.toContain("tab-user");
    await expect(backend.switchTab?.({ sessionId: "session-1", tabRef: "@t2" })).rejects.toThrow(
      "Browser tab is unavailable under the current session or URL policy: @t2"
    );
    expect(switchTab).not.toHaveBeenCalled();
    await expect(backend.switchTab?.({ sessionId: "session-1", tabRef: "@t4" })).rejects.toThrow(
      "Browser tab changed to a URL blocked by browser policy before it could be controlled."
    );
    expect(switchTab).toHaveBeenNthCalledWith(1, "session-1", "@t4");
    expect(switchTab).toHaveBeenNthCalledWith(2, "session-1", "@t1");
    expect(session).toMatchObject({ targetId: "target-1", tabRef: "@t1", supervisor });
  });

  it("follows a manually focused safe tab before projecting current browser state", async () => {
    const mainSnapshot = {
      sessionId: "session-1",
      url: "https://example.com/apps",
      title: "Apps",
      text: "Apps",
      elements: []
    };
    const detailSnapshot = {
      ...mainSnapshot,
      url: "https://example.com/oauth",
      title: "OAuth V1",
      text: "OAuth"
    };
    const mainSupervisor = {
      send: vi.fn(async () => ({})),
      waitFor: vi.fn(async () => undefined),
      getSnapshot: vi.fn(async () => mainSnapshot),
      consoleHistory: vi.fn(() => []),
      respondToDialog: vi.fn(async () => undefined),
      close: vi.fn()
    };
    const detailSupervisor = {
      ...mainSupervisor,
      getSnapshot: vi.fn(async () => detailSnapshot)
    };
    const session = {
      key: "session-1",
      browserContextId: "context-1",
      targetId: "target-1",
      tabRef: "@t1",
      pageWebSocketDebuggerUrl: "ws://target-1",
      supervisor: mainSupervisor,
      lastActiveAt: 1,
      touch: vi.fn(),
      close: vi.fn(async () => undefined)
    };
    const tabs = () => [
      { browserContextId: "context-1", targetId: "target-1", pageWebSocketDebuggerUrl: "ws://target-1", url: mainSnapshot.url, title: mainSnapshot.title, ref: "@t1", controlled: session.targetId === "target-1" },
      { browserContextId: "context-1", targetId: "target-2", pageWebSocketDebuggerUrl: "ws://target-2", url: detailSnapshot.url, title: detailSnapshot.title, ref: "@t2", controlled: session.targetId === "target-2" }
    ];
    const sessionManager = {
      acquire: vi.fn(async () => session),
      close: vi.fn(async () => undefined),
      closeAll: vi.fn(async () => undefined),
      has: vi.fn(() => true),
      listTabs: vi.fn(async () => tabs()),
      visibleTab: vi.fn(async () => tabs()[1]),
      switchTab: vi.fn(async () => {
        session.targetId = "target-2";
        session.tabRef = "@t2";
        session.pageWebSocketDebuggerUrl = "ws://target-2";
        session.supervisor = detailSupervisor;
        return session;
      })
    };
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      fetch: createFetch(),
      resolveHostname: () => ["93.184.216.34"],
      createTargetManager: () => ({
        createTarget: vi.fn(async () => { throw new Error("unused"); }),
        close: vi.fn(async () => undefined)
      }),
      createSessionManager: () => sessionManager
    });

    await backend.navigate({ url: mainSnapshot.url, sessionId: "session-1" });
    await expect(backend.tabs?.({ sessionId: "session-1" })).resolves.toMatchObject({
      tabs: [
        { ref: "@t1", controlled: false },
        { ref: "@t2", controlled: true }
      ]
    });
    expect(sessionManager.switchTab).toHaveBeenCalledWith("session-1", "@t2");
    await expect(backend.snapshot?.({ sessionId: "session-1" })).resolves.toMatchObject({
      url: detailSnapshot.url,
      tab: { ref: "@t2", controlled: true }
    });
  });

  it("type() can use AX-derived textbox refs bound to DOM nodes", async () => {
    const socket = new FakeCdpSocket();
    socket.axTree = {
      nodes: [
        { nodeId: "textbox-1", backendDOMNodeId: 201, role: { value: "textbox" }, name: { value: "Email" } }
      ]
    };
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      fetch: createFetch(),
      webSocketFactory: () => socket,
      resolveHostname: () => ["93.184.216.34"]
    });

    const navigation = await backend.navigate({ url: "https://example.com/start", sessionId: "session-1" });
    await expect(backend.type?.({
      sessionId: "session-1",
      ref: "@e1",
      revision: navigation.snapshot.revision,
      tabRef: navigation.snapshot.tab!.ref,
      text: "ada@example.com"
    })).resolves.toMatchObject({
      sessionId: "session-1"
    });

    expect(socket.sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "DOM.resolveNode", params: { backendNodeId: 201 } }),
      expect.objectContaining({
        method: "Runtime.evaluate",
        params: expect.objectContaining({
          expression: expect.stringContaining("ada@example.com")
        })
      })
    ]));
  });

  it("stale AX-derived refs fail deterministically", async () => {
    const socket = new FakeCdpSocket();
    socket.axTree = {
      nodes: [
        { nodeId: "button-1", backendDOMNodeId: 101, role: { value: "button" }, name: { value: "Open" } }
      ]
    };
    socket.missingElementIndexes.add(98);
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      fetch: createFetch(),
      webSocketFactory: () => socket,
      resolveHostname: () => ["93.184.216.34"]
    });

    const navigation = await backend.navigate({ url: "https://example.com/start", sessionId: "session-1" });
    await expect(backend.click?.({
      sessionId: "session-1",
      ref: "@e99",
      revision: navigation.snapshot.revision,
      tabRef: navigation.snapshot.tab!.ref
    })).rejects.toThrow(
      "Browser element ref not found"
    );
  });

  it("snapshot() includes pending dialogs, frame tree, and console history from the supervisor", async () => {
    const socket = new FakeCdpSocket();
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      fetch: createFetch(),
      webSocketFactory: () => socket
    });

    await backend.navigate({ url: "https://example.com/start", sessionId: "session-1" });
    socket.emitMessage({
      method: "Page.javascriptDialogOpening",
      params: { type: "alert", message: "Careful" }
    });
    socket.emitMessage({
      method: "Runtime.consoleAPICalled",
      params: { type: "warn", timestamp: 0, args: [{ value: "Heads up" }] }
    });
    socket.emitMessage({
      method: "Page.frameNavigated",
      params: { frame: { id: "frame-1", url: "https://frame.test/app" } }
    });

    await expect(backend.snapshot?.({ sessionId: "session-1" })).resolves.toMatchObject({
      pendingDialogs: [{ id: "dialog-1", type: "alert", message: "Careful" }],
      consoleHistory: [{ level: "warn", text: "Heads up", timestamp: "1970-01-01T00:00:00.000Z" }],
      frameTree: [{ frameId: "frame-1", url: "https://frame.test/app", origin: "https://frame.test", isOopif: false }]
    });
  });

  it("pins invalid and missing session behavior", async () => {
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      fetch: createFetch(),
      webSocketFactory: () => new FakeCdpSocket()
    });

    await expect(backend.navigate({ url: "https://example.com/start" })).rejects.toThrow(
      "Browser sessionId is required for supervised local CDP operations."
    );
    await expect(backend.snapshot?.()).rejects.toThrow("Browser sessionId is required for supervised local CDP operations.");
    await expect(backend.snapshot?.({ sessionId: "   " })).rejects.toThrow("Browser sessionId is required for supervised local CDP operations.");
    await backend.navigate({ url: "https://example.com/start", sessionId: "session-1" });
    await expect(backend.snapshot?.({ sessionId: "missing" })).rejects.toThrow("Browser session not found: missing");
    await expect(backend.snapshot?.({ sessionId: "missing" })).rejects.toMatchObject({
      reason: "session_missing"
    });
  });

  it("marks replacement sessions as unauthenticated after session loss", async () => {
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      fetch: createFetch(),
      webSocketFactory: () => new FakeCdpSocket()
    }) as ReturnType<typeof createSupervisedLocalCdpBrowserBackend> & {
      closeSession(sessionId: string): Promise<void>;
    };

    await backend.navigate({ url: "https://example.com/start", sessionId: "session-1" });
    await backend.closeSession("session-1");
    const replacement = await backend.navigate({
      url: "https://example.com/start-again",
      sessionId: "session-1"
    });

    expect(replacement.metadata).toEqual({
      sessionRecovery: {
        reason: "session_missing",
        authenticationPreserved: false
      }
    });
  });

  it("uses the persistent supervisor for raw CDP instead of reconnecting per action", async () => {
    const socket = new FakeCdpSocket();
    const webSocketFactory = vi.fn(() => socket);
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      fetch: createFetch(),
      webSocketFactory
    });

    await backend.navigate({ url: "https://example.com/start", sessionId: "session-1" });
    await expect(backend.cdp?.({ sessionId: "session-1", method: "Runtime.getProperties", params: { objectId: "obj-1" } })).resolves.toEqual({
      ok: true,
      method: "Runtime.getProperties"
    });

    expect(webSocketFactory).toHaveBeenCalledTimes(2);
    expect(socket.sent.at(-1)).toMatchObject({
      method: "Runtime.getProperties",
      params: { objectId: "obj-1" }
    });
  });

  it("dialog() delegates to the persistent supervisor", async () => {
    const socket = new FakeCdpSocket();
    const webSocketFactory = vi.fn(() => socket);
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      fetch: createFetch(),
      webSocketFactory
    });

    await backend.navigate({ url: "https://example.com/start", sessionId: "session-1" });
    await expect(backend.dialog?.({ sessionId: "session-1", action: "dismiss" })).resolves.toMatchObject({
      sessionId: "session-1",
      url: "https://example.com/final"
    });

    expect(webSocketFactory).toHaveBeenCalledTimes(2);
    expect(socket.sent).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: "Page.handleJavaScriptDialog",
        params: { accept: false, promptText: "" }
      })
    ]));
  });

  it("registers lifecycle metadata after successful navigate", async () => {
    const lifecycle = new BrowserSessionLifecycle({ onCleanup: vi.fn() });
    const register = vi.spyOn(lifecycle, "register");
    const touch = vi.spyOn(lifecycle, "touch");
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      fetch: createFetch(),
      webSocketFactory: () => new FakeCdpSocket(),
      resolveHostname: () => ["93.184.216.34"],
      lifecycle
    });

    await backend.navigate({ url: "https://example.com/start", sessionId: "session-1" });

    expect(register).toHaveBeenCalledWith("session-1", {
      backend: "local-cdp",
      browserContextId: "context-1",
      targetId: "target-1",
      pageWebSocketDebuggerUrl: "ws://cdp/target-1"
    });
    expect(touch).toHaveBeenCalledWith("session-1");
    lifecycle.stop();
  });

  it("touches lifecycle state on every supervised session action", async () => {
    const lifecycle = new BrowserSessionLifecycle({ onCleanup: vi.fn() });
    const touch = vi.spyOn(lifecycle, "touch");
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      fetch: createFetch(),
      webSocketFactory: () => new FakeCdpSocket(),
      resolveHostname: () => ["93.184.216.34"],
      lifecycle
    });

    await backend.navigate({ url: "https://example.com/start", sessionId: "session-1" });
    touch.mockClear();

    await backend.snapshot?.({ sessionId: "session-1" });
    await backend.click?.({ sessionId: "session-1", locator: { role: "button", name: "Open" } });
    await backend.type?.({ sessionId: "session-1", locator: { role: "button", name: "Open" }, text: "hello" });
    await backend.scroll?.({ sessionId: "session-1", direction: "down" });
    await backend.press?.({ sessionId: "session-1", key: "Enter" });
    await backend.back?.({ sessionId: "session-1" });
    await backend.dialog?.({ sessionId: "session-1", action: "dismiss" });
    await backend.console?.({ sessionId: "session-1" });
    await backend.getImages?.({ sessionId: "session-1" });
    await backend.screenshot?.({ sessionId: "session-1" });
    await backend.cdp?.({ sessionId: "session-1", method: "Runtime.getProperties" });

    expect(touch.mock.calls.length).toBeGreaterThanOrEqual(11);
    expect(touch).toHaveBeenCalledWith("session-1");
    lifecycle.stop();
  });

  it("lifecycle cleanup closes the matching supervisor session", async () => {
    const socket = new FakeCdpSocket();
    let backend: ReturnType<typeof createSupervisedLocalCdpBrowserBackend> & {
      closeSession(sessionId: string): Promise<void>;
    };
    const lifecycle = new BrowserSessionLifecycle({
      onCleanup: (sessionId) => backend.closeSession(sessionId)
    });
    const unregister = vi.spyOn(lifecycle, "unregister");
    backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      fetch: createFetch(),
      webSocketFactory: () => socket,
      lifecycle
    }) as typeof backend;

    await backend.navigate({ url: "https://example.com/start", sessionId: "session-1" });
    await lifecycle.cleanupAll();

    expect(socket.closed).toBe(true);
    expect(unregister).toHaveBeenCalledWith("session-1");
    await expect(backend.snapshot?.({ sessionId: "session-1" })).rejects.toThrow("Browser session not found: session-1");
    lifecycle.stop();
  });

  it("lifecycle inactivity cleanup closes stale managed sessions", async () => {
    vi.useFakeTimers();
    const socket = new FakeCdpSocket();
    let backend: ReturnType<typeof createSupervisedLocalCdpBrowserBackend> & {
      closeSession(sessionId: string): Promise<void>;
    };
    const lifecycle = new BrowserSessionLifecycle({
      inactivityTimeoutMs: 1_000,
      onCleanup: (sessionId) => backend.closeSession(sessionId)
    });
    backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      fetch: createFetch(),
      webSocketFactory: () => socket,
      lifecycle
    }) as typeof backend;

    try {
      const navigate = backend.navigate({ url: "https://example.com/start", sessionId: "session-1" });
      await vi.advanceTimersByTimeAsync(1_000);
      await navigate;
      await vi.advanceTimersByTimeAsync(60_000);

      expect(socket.closed).toBe(true);
      await expect(backend.snapshot?.({ sessionId: "session-1" })).rejects.toThrow("Browser session not found: session-1");
    } finally {
      lifecycle.stop();
      vi.useRealTimers();
    }
  });

  it("lifecycle cleanup kills only auto-launched Chrome and is idempotent", async () => {
    const launchedChrome = createLaunchedChrome();
    let backend: ReturnType<typeof createSupervisedLocalCdpBrowserBackend> & {
      closeSession(sessionId: string): Promise<void>;
    };
    const lifecycle = new BrowserSessionLifecycle({
      onCleanup: (sessionId) => backend.closeSession(sessionId)
    });
    backend = createSupervisedLocalCdpBrowserBackend({
      autoLaunch: true,
      fetch: createFetch(),
      webSocketFactory: () => new FakeCdpSocket(),
      lifecycle,
      findChromiumExecutable: vi.fn(async () => ({ executablePath: "/usr/bin/chromium", source: "platformDefault" as const })),
      launchChrome: vi.fn(async () => launchedChrome)
    }) as typeof backend;

    await backend.navigate({ url: "https://example.com/start", sessionId: "session-1" });
    await lifecycle.cleanupAll();
    await lifecycle.cleanupAll();
    await backend.closeSession("session-1");

    expect(launchedChrome.kill).toHaveBeenCalledTimes(1);
    await expect(backend.snapshot?.({ sessionId: "session-1" })).rejects.toThrow("Browser session not found: session-1");
    lifecycle.stop();
  });

  it("does not kill external Chrome when reusing an explicit cdpUrl", async () => {
    const launchedChrome = createLaunchedChrome();
    let backend: ReturnType<typeof createSupervisedLocalCdpBrowserBackend> & {
      closeSession(sessionId: string): Promise<void>;
    };
    const lifecycle = new BrowserSessionLifecycle({
      onCleanup: (sessionId) => backend.closeSession(sessionId)
    });
    backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      autoLaunch: true,
      fetch: createFetch(),
      webSocketFactory: () => new FakeCdpSocket(),
      lifecycle,
      findChromiumExecutable: vi.fn(async () => ({ executablePath: "/usr/bin/chromium", source: "platformDefault" as const })),
      launchChrome: vi.fn(async () => launchedChrome)
    }) as typeof backend;

    await backend.navigate({ url: "https://example.com/start", sessionId: "session-1" });
    await lifecycle.cleanupAll();

    expect(launchedChrome.kill).not.toHaveBeenCalled();
    lifecycle.stop();
  });

  it("backend close closes managed sessions, target manager, and auto-launched Chrome idempotently", async () => {
    const launchedChrome = createLaunchedChrome();
    const sockets = createSocketFactory();
    const backend = createSupervisedLocalCdpBrowserBackend({
      autoLaunch: true,
      fetch: createFetch(),
      webSocketFactory: sockets.webSocketFactory,
      findChromiumExecutable: vi.fn(async () => ({ executablePath: "/usr/bin/chromium", source: "platformDefault" as const })),
      launchChrome: vi.fn(async () => launchedChrome)
    }) as ReturnType<typeof createSupervisedLocalCdpBrowserBackend> & {
      close(): Promise<void>;
    };

    await backend.navigate({ url: "https://example.com/one", sessionId: "session-1" });
    await backend.navigate({ url: "https://example.com/two", sessionId: "session-2" });
    await backend.close();
    await backend.close();

    expect(sockets.browserSocket()?.closed).toBe(true);
    expect(sockets.pageSocket(0)?.closed).toBe(true);
    expect(sockets.pageSocket(1)?.closed).toBe(true);
    expect(launchedChrome.kill).toHaveBeenCalledTimes(1);
  });

  it("backend close does not kill external Chrome when explicit cdpUrl is reused", async () => {
    const launchedChrome = createLaunchedChrome();
    const launchChrome = vi.fn(async () => launchedChrome);
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      autoLaunch: true,
      fetch: createFetch(),
      webSocketFactory: () => new FakeCdpSocket(),
      findChromiumExecutable: vi.fn(async () => ({ executablePath: "/usr/bin/chromium", source: "platformDefault" as const })),
      launchChrome
    }) as ReturnType<typeof createSupervisedLocalCdpBrowserBackend> & {
      close(): Promise<void>;
    };

    await backend.navigate({ url: "https://example.com/start", sessionId: "session-1" });
    await backend.close();

    expect(launchChrome).not.toHaveBeenCalled();
    expect(launchedChrome.kill).not.toHaveBeenCalled();
  });

  it("backend close cleans both configured and launched stacks after fallback", async () => {
    const harness = createSwitchableCdpHarness();
    const launchedChrome = createLaunchedChrome(harness.launchedEndpoint);
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: harness.configuredEndpoint,
      autoLaunch: true,
      fetch: harness.fetch,
      webSocketFactory: harness.webSocketFactory,
      findChromiumExecutable: vi.fn(async () => ({ executablePath: "/usr/bin/chromium", source: "platformDefault" as const })),
      launchChrome: vi.fn(async () => launchedChrome)
    }) as ReturnType<typeof createSupervisedLocalCdpBrowserBackend> & {
      close(): Promise<void>;
    };

    await backend.navigate({ url: "https://example.com/configured", sessionId: "configured-session" });
    harness.failConfiguredContext("configured browser context failed");
    await backend.navigate({ url: "https://example.com/launched", sessionId: "launched-session" });
    harness.recoverConfiguredContext();
    await backend.navigate({ url: "https://example.com/configured-again", sessionId: "configured-session-2" });

    const firstConfiguredPage = harness.socket("ws://configured/target-1");
    const launchedPage = harness.socket("ws://launched/target-1");
    const secondConfiguredPage = harness.socket("ws://configured/target-1", 1);

    await backend.close();
    await backend.close();

    expect(firstConfiguredPage?.closed).toBe(true);
    expect(launchedPage?.closed).toBe(true);
    expect(secondConfiguredPage?.closed).toBe(true);
    expect(launchedChrome.kill).toHaveBeenCalledTimes(1);
  });

  it("kills auto-launched Chrome when backend initialization fails after launch", async () => {
    const launchedChrome = createLaunchedChrome();
    const backend = createSupervisedLocalCdpBrowserBackend({
      autoLaunch: true,
      fetch: createFetch(),
      webSocketFactory: () => {
        throw new Error("CDP WebSocket connection failed.");
      },
      findChromiumExecutable: vi.fn(async () => ({ executablePath: "/usr/bin/chromium", source: "platformDefault" as const })),
      launchChrome: vi.fn(async () => launchedChrome)
    });

    await expect(backend.navigate({ url: "https://example.com/start", sessionId: "session-1" })).rejects.toThrow("CDP WebSocket connection failed.");
    expect(launchedChrome.kill).toHaveBeenCalledTimes(1);
  });

  it("kills auto-launched Chrome when target manager creation fails after launch", async () => {
    const launchedChrome = createLaunchedChrome();
    const backend = createSupervisedLocalCdpBrowserBackend({
      autoLaunch: true,
      fetch: createFetch(),
      webSocketFactory: () => new FakeCdpSocket(),
      findChromiumExecutable: vi.fn(async () => ({ executablePath: "/usr/bin/chromium", source: "platformDefault" as const })),
      launchChrome: vi.fn(async () => launchedChrome),
      createTargetManager: () => {
        throw new Error("target manager failed");
      }
    });

    await expect(backend.navigate({ url: "https://example.com/start", sessionId: "session-1" })).rejects.toThrow("target manager failed");
    expect(launchedChrome.kill).toHaveBeenCalledTimes(1);
  });

  it("kills auto-launched Chrome when session manager creation fails after launch", async () => {
    const launchedChrome = createLaunchedChrome();
    const backend = createSupervisedLocalCdpBrowserBackend({
      autoLaunch: true,
      fetch: createFetch(),
      webSocketFactory: () => new FakeCdpSocket(),
      findChromiumExecutable: vi.fn(async () => ({ executablePath: "/usr/bin/chromium", source: "platformDefault" as const })),
      launchChrome: vi.fn(async () => launchedChrome),
      createSessionManager: () => {
        throw new Error("session manager failed");
      }
    });

    await expect(backend.navigate({ url: "https://example.com/start", sessionId: "session-1" })).rejects.toThrow("session manager failed");
    expect(launchedChrome.kill).toHaveBeenCalledTimes(1);
  });
});
