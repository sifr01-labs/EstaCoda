import { describe, expect, it } from "vitest";
import { CDPSupervisor } from "./cdp-supervisor.js";
import type { CdpWebSocketEvent, CdpWebSocketLike } from "./cdp-client.js";

class FakeCdpSocket implements CdpWebSocketLike {
  readonly readyState = 1;
  readonly sent: Array<{ id: number; method: string; params?: Record<string, unknown> }> = [];
  closed = false;
  readonly #listeners = new Map<string, Array<(event: CdpWebSocketEvent) => void>>();

  constructor(
    readonly url: string,
    private readonly options: {
      snapshot?: {
        url: string;
        title: string;
        text: string;
        elements: Array<{ ref: string; role?: string; name?: string }>;
      };
      axTree?: unknown;
      failAxTree?: boolean;
    } = {}
  ) {}

  send(data: string): void {
    const message = JSON.parse(data) as {
      id: number;
      method: string;
      params?: Record<string, unknown>;
    };
    this.sent.push(message);
    if (message.method === "Accessibility.getFullAXTree" && this.options.failAxTree === true) {
      this.#emit("message", {
        data: JSON.stringify({
          id: message.id,
          error: { message: "Accessibility domain unavailable" }
        })
      });
      return;
    }

    const result = message.method === "Runtime.evaluate"
      ? { result: { value: JSON.stringify(this.options.snapshot ?? defaultSnapshot()) } }
      : message.method === "Accessibility.getFullAXTree"
        ? this.options.axTree ?? { nodes: [] }
        : { ok: true, method: message.method };
    this.#emit("message", {
      data: JSON.stringify({
        id: message.id,
        result
      })
    });
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

  emitMessage(message: unknown): void {
    this.#emit("message", { data: JSON.stringify(message) });
  }

  #emit(type: string, event: CdpWebSocketEvent): void {
    for (const listener of this.#listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function defaultSnapshot(): {
  url: string;
  title: string;
  text: string;
  elements: Array<{ ref: string; role?: string; name?: string }>;
} {
  return {
    url: "https://example.com/page",
    title: "Example",
    text: "Readable text",
    elements: [{ ref: "@e1", role: "button", name: "Continue" }]
  };
}

async function flushAsyncEvents(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("CDPSupervisor", () => {
  it("start() connects once and enables Page and Runtime", async () => {
    const sockets: FakeCdpSocket[] = [];
    const supervisor = new CDPSupervisor({
      webSocketUrl: "ws://cdp/page-1",
      webSocketFactory: (url) => {
        const socket = new FakeCdpSocket(url);
        sockets.push(socket);
        return socket;
      }
    });

    await supervisor.start();
    await supervisor.start();

    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.sent.map((message) => message.method)).toEqual([
      "Page.enable",
      "Runtime.enable"
    ]);
  });

  it("send() delegates to the persistent CDP client", async () => {
    const sockets: FakeCdpSocket[] = [];
    const supervisor = new CDPSupervisor({
      webSocketUrl: "ws://cdp/page-1",
      webSocketFactory: (url) => {
        const socket = new FakeCdpSocket(url);
        sockets.push(socket);
        return socket;
      }
    });

    await supervisor.start();
    await expect(supervisor.send("Page.navigate", { url: "https://example.com" })).resolves.toEqual({
      ok: true,
      method: "Page.navigate"
    });

    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.sent.at(-1)).toMatchObject({
      method: "Page.navigate",
      params: { url: "https://example.com" }
    });
  });

  it("getSnapshot() returns page content plus scaffold-only empty event arrays", async () => {
    const supervisor = new CDPSupervisor({
      webSocketUrl: "ws://cdp/page-1",
      webSocketFactory: (url) => new FakeCdpSocket(url)
    });

    await supervisor.start();
    await expect(supervisor.getSnapshot("session-1")).resolves.toEqual({
      sessionId: "session-1",
      url: "https://example.com/page",
      title: "Example",
      text: "Readable text",
      elements: [{ ref: "@e1", role: "button", name: "Continue" }],
      pendingDialogs: [],
      frameTree: [],
      consoleHistory: []
    });
  });

  it("getSnapshot() uses Accessibility.getFullAXTree for compact interactive elements", async () => {
    const socket = new FakeCdpSocket("ws://cdp/page-1", {
      axTree: {
        nodes: [
          { nodeId: "root", role: { value: "RootWebArea" }, name: { value: "Example" } },
          { nodeId: "ignored", ignored: true, role: { value: "button" }, name: { value: "Ignored" } },
          { nodeId: "static", role: { value: "StaticText" }, name: { value: "Decorative" } },
          {
            nodeId: "button-1",
            role: { value: "button" },
            name: { value: "Continue" },
            properties: [{ name: "disabled", value: { type: "boolean", value: true } }]
          },
          {
            nodeId: "input-1",
            role: { value: "textbox" },
            name: { value: "Email" },
            value: { value: "ada@example.com" }
          },
          {
            nodeId: "checkbox-1",
            role: { value: "checkbox" },
            name: { value: "Subscribe" },
            properties: [{ name: "checked", value: { type: "tristate", value: "mixed" } }]
          }
        ]
      }
    });
    const supervisor = new CDPSupervisor({
      webSocketUrl: "ws://cdp/page-1",
      webSocketFactory: () => socket
    });

    await supervisor.start();
    await expect(supervisor.getSnapshot("session-1")).resolves.toMatchObject({
      sessionId: "session-1",
      url: "https://example.com/page",
      title: "Example",
      text: "Readable text",
      elements: [
        { ref: "@e1", role: "button", name: "Continue", disabled: true },
        { ref: "@e2", role: "textbox", name: "Email", value: "ada@example.com" },
        { ref: "@e3", role: "checkbox", name: "Subscribe", checked: "mixed" }
      ],
      pendingDialogs: [],
      frameTree: [],
      consoleHistory: []
    });
    expect(socket.sent.map((message) => message.method)).toContain("Accessibility.getFullAXTree");
  });

  it("getSnapshot() falls back to the DOM snapshot when the AX tree is empty", async () => {
    const socket = new FakeCdpSocket("ws://cdp/page-1", { axTree: { nodes: [] } });
    const supervisor = new CDPSupervisor({
      webSocketUrl: "ws://cdp/page-1",
      webSocketFactory: () => socket
    });

    await supervisor.start();
    await expect(supervisor.getSnapshot("session-1")).resolves.toMatchObject({
      sessionId: "session-1",
      elements: [{ ref: "@e1", role: "button", name: "Continue" }]
    });
    expect(socket.sent.map((message) => message.method)).toEqual([
      "Page.enable",
      "Runtime.enable",
      "Accessibility.getFullAXTree",
      "Runtime.evaluate"
    ]);
  });

  it("getSnapshot() falls back to the DOM snapshot when the AX command fails", async () => {
    const socket = new FakeCdpSocket("ws://cdp/page-1", { failAxTree: true });
    const supervisor = new CDPSupervisor({
      webSocketUrl: "ws://cdp/page-1",
      webSocketFactory: () => socket
    });

    await supervisor.start();
    await expect(supervisor.getSnapshot("session-1")).resolves.toMatchObject({
      sessionId: "session-1",
      elements: [{ ref: "@e1", role: "button", name: "Continue" }]
    });
  });

  it("getSnapshot() ignores malformed AX values without crashing", async () => {
    const supervisor = new CDPSupervisor({
      webSocketUrl: "ws://cdp/page-1",
      webSocketFactory: (url) => new FakeCdpSocket(url, {
        axTree: {
          nodes: [
            null,
            { role: { value: ["not-a-role"] }, name: { value: "Bad" } },
            {
              role: { value: "button" },
              name: { value: { nested: "bad" } },
              value: { value: ["bad"] },
              properties: [{ name: "checked", value: { value: "sometimes" } }]
            }
          ]
        }
      })
    });

    await supervisor.start();
    await expect(supervisor.getSnapshot("session-1")).resolves.toMatchObject({
      elements: [{ ref: "@e1", role: "button" }]
    });
  });

  it("close() closes the socket and is safe to call more than once", async () => {
    const socket = new FakeCdpSocket("ws://cdp/page-1");
    const supervisor = new CDPSupervisor({
      webSocketUrl: "ws://cdp/page-1",
      webSocketFactory: () => socket
    });

    await supervisor.start();
    supervisor.close();
    supervisor.close();

    expect(socket.closed).toBe(true);
  });

  it("multiple supervisors keep independent client state", async () => {
    const first = new FakeCdpSocket("ws://cdp/first", { snapshot: { url: "https://first.test", title: "First", text: "One", elements: [] } });
    const second = new FakeCdpSocket("ws://cdp/second", { snapshot: { url: "https://second.test", title: "Second", text: "Two", elements: [] } });

    const firstSupervisor = new CDPSupervisor({
      webSocketUrl: "ws://cdp/first",
      webSocketFactory: () => first
    });
    const secondSupervisor = new CDPSupervisor({
      webSocketUrl: "ws://cdp/second",
      webSocketFactory: () => second
    });

    await firstSupervisor.start();
    await secondSupervisor.start();

    await expect(firstSupervisor.getSnapshot("first")).resolves.toMatchObject({ url: "https://first.test" });
    await expect(secondSupervisor.getSnapshot("second")).resolves.toMatchObject({ url: "https://second.test" });
    expect(first.sent).not.toBe(second.sent);
  });

  it("methods before start() fail deterministically", async () => {
    const supervisor = new CDPSupervisor({
      webSocketUrl: "ws://cdp/page-1",
      webSocketFactory: (url) => new FakeCdpSocket(url)
    });

    await expect(supervisor.send("Page.navigate", { url: "https://example.com" })).rejects.toThrow("CDP supervisor is not started.");
    await expect(supervisor.getSnapshot("session-1")).rejects.toThrow("CDP supervisor is not started.");
  });

  it("dialog opening adds and dialog closed removes a pending dialog", async () => {
    const socket = new FakeCdpSocket("ws://cdp/page-1");
    const supervisor = new CDPSupervisor({
      webSocketUrl: "ws://cdp/page-1",
      webSocketFactory: () => socket
    });

    await supervisor.start();
    socket.emitMessage({
      method: "Page.javascriptDialogOpening",
      params: {
        type: "prompt",
        message: "Name?",
        defaultPrompt: "Ada"
      }
    });

    await expect(supervisor.getSnapshot("session-1")).resolves.toMatchObject({
      pendingDialogs: [{
        id: "dialog-1",
        type: "prompt",
        message: "Name?",
        defaultPrompt: "Ada"
      }]
    });

    socket.emitMessage({ method: "Page.javascriptDialogClosed", params: {} });
    await expect(supervisor.getSnapshot("session-1")).resolves.toMatchObject({
      pendingDialogs: []
    });
  });

  it("captures console events and caps history at 50 entries", async () => {
    const socket = new FakeCdpSocket("ws://cdp/page-1");
    const supervisor = new CDPSupervisor({
      webSocketUrl: "ws://cdp/page-1",
      webSocketFactory: () => socket
    });

    await supervisor.start();
    for (let i = 0; i < 55; i++) {
      socket.emitMessage({
        method: "Runtime.consoleAPICalled",
        params: {
          type: "log",
          timestamp: 0,
          args: [{ value: `message-${i}` }]
        }
      });
    }

    const snapshot = await supervisor.getSnapshot("session-1");
    expect(snapshot.consoleHistory).toHaveLength(50);
    expect(snapshot.consoleHistory[0]).toMatchObject({ text: "message-5" });
    expect(snapshot.consoleHistory.at(-1)).toMatchObject({
      level: "log",
      text: "message-54",
      timestamp: "1970-01-01T00:00:00.000Z"
    });
  });

  it("captures frame navigation data in a bounded frame list", async () => {
    const socket = new FakeCdpSocket("ws://cdp/page-1");
    const supervisor = new CDPSupervisor({
      webSocketUrl: "ws://cdp/page-1",
      webSocketFactory: () => socket
    });

    await supervisor.start();
    socket.emitMessage({
      method: "Page.frameNavigated",
      params: {
        frame: {
          id: "frame-1",
          parentId: "root",
          url: "https://example.com/path"
        }
      }
    });

    await expect(supervisor.getSnapshot("session-1")).resolves.toMatchObject({
      frameTree: [{
        frameId: "frame-1",
        parentFrameId: "root",
        url: "https://example.com/path",
        origin: "https://example.com",
        isOopif: false
      }]
    });
  });

  it("request interception aborts metadata, private, policy, and secret URLs", async () => {
    const socket = new FakeCdpSocket("ws://cdp/page-1");
    const supervisor = new CDPSupervisor({
      webSocketUrl: "ws://cdp/page-1",
      webSocketFactory: () => socket,
      requestInterception: {
        websiteBlocklist: { domains: ["blocked.test"] },
        resolveHostname: (hostname) => hostname === "public.test" || hostname === "blocked.test" ? ["93.184.216.34"] : ["127.0.0.1"]
      }
    });

    await supervisor.start();
    for (const [index, url] of [
      "http://169.254.169.254/latest",
      "http://localhost:8080",
      "https://blocked.test",
      "https://public.test/?token=secret"
    ].entries()) {
      socket.emitMessage({
        method: "Fetch.requestPaused",
        params: {
          requestId: `blocked-${index}`,
          request: { url }
        }
      });
    }
    await flushAsyncEvents();

    const failRequests = socket.sent.filter((message) => message.method === "Fetch.failRequest");
    expect(failRequests).toHaveLength(4);
    expect(failRequests.map((message) => message.params?.requestId).sort()).toEqual([
      "blocked-0",
      "blocked-1",
      "blocked-2",
      "blocked-3"
    ]);
  });

  it("request interception continues safe public URLs", async () => {
    const socket = new FakeCdpSocket("ws://cdp/page-1");
    const supervisor = new CDPSupervisor({
      webSocketUrl: "ws://cdp/page-1",
      webSocketFactory: () => socket,
      requestInterception: {
        resolveHostname: () => ["93.184.216.34"]
      }
    });

    await supervisor.start();
    socket.emitMessage({
      method: "Fetch.requestPaused",
      params: {
        requestId: "safe-1",
        request: { url: "https://example.com/script.js" }
      }
    });
    await flushAsyncEvents();

    expect(socket.sent.at(-1)).toMatchObject({
      method: "Fetch.continueRequest",
      params: { requestId: "safe-1" }
    });
  });

  it("allowPrivateUrls allows ordinary private requests but still blocks metadata", async () => {
    const socket = new FakeCdpSocket("ws://cdp/page-1");
    const supervisor = new CDPSupervisor({
      webSocketUrl: "ws://cdp/page-1",
      webSocketFactory: () => socket,
      requestInterception: {
        allowPrivateUrls: true,
        resolveHostname: () => ["127.0.0.1"]
      }
    });

    await supervisor.start();
    socket.emitMessage({
      method: "Fetch.requestPaused",
      params: {
        requestId: "private-1",
        request: { url: "http://localhost:8080/app.js" }
      }
    });
    socket.emitMessage({
      method: "Fetch.requestPaused",
      params: {
        requestId: "metadata-1",
        request: { url: "http://169.254.169.254/latest" }
      }
    });
    await flushAsyncEvents();

    expect(socket.sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "Fetch.continueRequest", params: { requestId: "private-1" } }),
      expect.objectContaining({ method: "Fetch.failRequest", params: { requestId: "metadata-1", errorReason: "BlockedByClient" } })
    ]));
  });

  it("event handling ignores malformed or missing event fields", async () => {
    const socket = new FakeCdpSocket("ws://cdp/page-1");
    const supervisor = new CDPSupervisor({
      webSocketUrl: "ws://cdp/page-1",
      webSocketFactory: () => socket,
      requestInterception: {}
    });

    await supervisor.start();
    socket.emitMessage({ method: "Page.javascriptDialogOpening", params: null });
    socket.emitMessage({ method: "Runtime.consoleAPICalled", params: { args: "not-array" } });
    socket.emitMessage({ method: "Page.frameNavigated", params: { frame: {} } });
    socket.emitMessage({ method: "Fetch.requestPaused", params: { requestId: "missing-url" } });
    await flushAsyncEvents();

    await expect(supervisor.getSnapshot("session-1")).resolves.toMatchObject({
      pendingDialogs: [],
      frameTree: [],
      consoleHistory: [{ level: "log", text: "" }]
    });
    expect(socket.sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "Fetch.continueRequest", params: { requestId: "missing-url" } })
    ]));
  });
});
