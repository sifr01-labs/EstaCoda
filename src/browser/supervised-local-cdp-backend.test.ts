import { describe, expect, it, vi } from "vitest";
import type { CdpFetchLike, CdpWebSocketEvent, CdpWebSocketLike } from "./cdp-client.js";
import { createBrowserBackendFromConfig } from "./browser-backend.js";
import { createSupervisedLocalCdpBrowserBackend } from "./supervised-local-cdp-backend.js";
import { BrowserSessionLifecycle } from "./session-lifecycle.js";

class FakeCdpSocket implements CdpWebSocketLike {
  readonly readyState = 1;
  readonly sent: Array<{ id: number; method: string; params?: Record<string, unknown> }> = [];
  readonly #listeners = new Map<string, Array<(event: CdpWebSocketEvent) => void>>();
  closed = false;
  snapshot = {
    url: "https://example.com/final",
    title: "Supervised Page",
    text: "Supervised text",
    elements: [{ ref: "@e1", role: "button", name: "Open" }]
  };

  send(data: string): void {
    const message = JSON.parse(data) as {
      id: number;
      method: string;
      params?: Record<string, unknown>;
    };
    this.sent.push(message);
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
    if (method === "Runtime.evaluate") {
      return { result: { value: JSON.stringify(this.snapshot) } };
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
          "Protocol-Version": "1.3"
        }
      });
    }
    if (url.includes("/json/new?")) {
      return response({
        ok: overrides?.targetOk ?? true,
        status: overrides?.targetOk === false ? 500 : 200,
        statusText: overrides?.targetOk === false ? "No Target" : "OK",
        payload: {
          id: "target-1",
          webSocketDebuggerUrl: "ws://cdp/target-1"
        }
      });
    }
    if (url.endsWith("/json/list")) {
      return response({
        ok: true,
        status: 200,
        statusText: "OK",
        payload: [{ id: "listed-1", type: "page", webSocketDebuggerUrl: "ws://cdp/listed-1" }]
      });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  });
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
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:9222/json/new?https%3A%2F%2Fexample.com%2Fstart", expect.objectContaining({ method: "PUT" }));
    expect(socket.sent.map((message) => message.method)).toContain("Page.navigate");
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

    expect(webSocketFactory).toHaveBeenCalledTimes(1);
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

    expect(webSocketFactory).toHaveBeenCalledTimes(1);
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
      webSocketDebuggerUrl: "ws://cdp/target-1"
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
      closeSession(sessionId: string): void;
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
});
