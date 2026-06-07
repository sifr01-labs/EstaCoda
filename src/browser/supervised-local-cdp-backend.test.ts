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
  #contextCounter = 0;
  #targetCounter = 0;
  closed = false;
  snapshot = {
    url: "https://example.com/final",
    title: "Supervised Page",
    text: "Supervised text",
    elements: [{ ref: "@e1", role: "button", name: "Open" }]
  };
  axTree: unknown;

  send(data: string): void {
    const message = JSON.parse(data) as {
      id: number;
      method: string;
      params?: Record<string, unknown>;
    };
    this.sent.push(message);
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
    const result = this.#resultFor(message.method);
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

  #resultFor(method: string): unknown {
    if (method === "Target.createBrowserContext") {
      return { browserContextId: `context-${++this.#contextCounter}` };
    }
    if (method === "Target.createTarget") {
      return { targetId: `target-${++this.#targetCounter}` };
    }
    if (method === "Runtime.evaluate") {
      return { result: { value: JSON.stringify(this.snapshot) } };
    }
    if (method === "Accessibility.getFullAXTree") {
      return this.axTree ?? { nodes: [] };
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
          return { id, type: "page", webSocketDebuggerUrl: `ws://cdp/${id}` };
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
          return { id, type: "page", webSocketDebuggerUrl: `ws://${endpoint}/${id}` };
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
      endpoint: "http://127.0.0.1:9222",
      browser: "Chrome/125.0.0.0",
      version: "1.3"
    });
    await expect(unavailable.isAvailable()).resolves.toBe(false);
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
      webSocketFactory: () => socket
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
      chromeFlags: ["--disable-gpu"]
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

    await backend.navigate({ url: "https://example.com/start", sessionId: "session-1" });

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
      findChromiumExecutable: vi.fn(async () => ({ executablePath: "/usr/bin/chromium", source: "platformDefault" as const })),
      launchChrome: vi.fn(async () => launchedChrome)
    }) as ReturnType<typeof createSupervisedLocalCdpBrowserBackend> & {
      closeSession(sessionId: string): Promise<void>;
    };

    await backend.navigate({ url: "https://example.com/configured", sessionId: "configured-session" });
    const firstConfiguredPage = harness.socket("ws://configured/target-1");
    expect(firstConfiguredPage).toBeDefined();

    harness.failConfiguredContext("configured browser context failed");
    await backend.navigate({ url: "https://example.com/launched", sessionId: "launched-session" });
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
    await backend.click?.({ sessionId: "launched-session", ref: "@e1" });
    expect(launchedPage?.sent.filter((message) => message.method === "Runtime.evaluate")).toHaveLength(launchedEvalCount + 2);
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

    await expect(backend.navigate({ url: "https://example.com/start" })).rejects.toThrow(
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

    await expect(backend.navigate({ url: "https://example.com/start" })).rejects.toThrow(launchFailure.message);
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
      await backend.navigate({ url: "https://example.com/start" });
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
        { nodeId: "button-1", role: { value: "button" }, name: { value: "Open" } }
      ]
    };
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      fetch: createFetch(),
      webSocketFactory: () => socket
    });

    await backend.navigate({ url: "https://example.com/start", sessionId: "session-1" });
    const compact = await backend.snapshot?.({ sessionId: "session-1" });
    const full = await backend.snapshot?.({ sessionId: "session-1", full: true });

    expect(compact?.elements).toEqual([{ ref: "@e1", role: "button", name: "Open" }]);
    expect(full?.elements).toEqual([
      { ref: "@e1", role: "heading", name: "Overview" },
      { ref: "@e2", role: "button", name: "Open" }
    ]);
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

    await expect(backend.snapshot?.()).rejects.toThrow("No active browser session. Call browser.navigate first.");
    await backend.navigate({ url: "https://example.com/start", sessionId: "session-1" });
    await expect(backend.snapshot?.({ sessionId: "missing" })).rejects.toThrow("Browser session not found: missing");
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
      lifecycle
    });

    await backend.navigate({ url: "https://example.com/start", sessionId: "session-1" });
    touch.mockClear();

    await backend.snapshot?.({ sessionId: "session-1" });
    await backend.click?.({ sessionId: "session-1", ref: "@e1" });
    await backend.type?.({ sessionId: "session-1", ref: "@e1", text: "hello" });
    await backend.scroll?.({ sessionId: "session-1", direction: "down" });
    await backend.press?.({ sessionId: "session-1", key: "Enter" });
    await backend.back?.({ sessionId: "session-1" });
    await backend.dialog?.({ sessionId: "session-1", action: "dismiss" });
    await backend.console?.({ sessionId: "session-1" });
    await backend.getImages?.({ sessionId: "session-1" });
    await backend.screenshot?.({ sessionId: "session-1" });
    await backend.cdp?.({ sessionId: "session-1", method: "Runtime.getProperties" });

    expect(touch).toHaveBeenCalledTimes(11);
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
      await vi.advanceTimersByTimeAsync(0);
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
