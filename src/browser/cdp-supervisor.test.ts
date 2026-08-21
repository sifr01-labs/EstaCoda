import { describe, expect, it } from "vitest";
import { CDPSupervisor, parseCdpSnapshot, snapshotExpression } from "./cdp-supervisor.js";
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
      failElementClear?: boolean;
      callFunctionValue?: unknown;
      silentMethods?: ReadonlySet<string>;
    } = {}
  ) {}

  send(data: string): void {
    const message = JSON.parse(data) as {
      id: number;
      method: string;
      params?: Record<string, unknown>;
    };
    this.sent.push(message);
    if (this.options.silentMethods?.has(message.method) === true) return;
    if (message.method === "Accessibility.getFullAXTree" && this.options.failAxTree === true) {
      this.#emit("message", {
        data: JSON.stringify({
          id: message.id,
          error: { message: "Accessibility domain unavailable" }
        })
      });
      return;
    }
    if (
      message.method === "Runtime.evaluate" &&
      this.options.failElementClear === true &&
      message.params?.expression === "window.__estacodaElements = []; 'ok';"
    ) {
      this.#emit("message", {
        data: JSON.stringify({
          id: message.id,
          error: { message: "Cannot clear browser element bindings" }
        })
      });
      return;
    }

    const result = message.method === "Runtime.evaluate"
      ? { result: { value: JSON.stringify(this.options.snapshot ?? defaultSnapshot()) } }
      : message.method === "Accessibility.getFullAXTree"
        ? this.options.axTree ?? { nodes: [] }
        : message.method === "DOM.resolveNode"
          ? { object: { objectId: `object-${message.params?.backendNodeId ?? "unknown"}` } }
          : message.method === "Runtime.callFunctionOn"
            ? { result: { value: this.options.callFunctionValue ?? true } }
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
  it("keeps the browser-side structured snapshot expression syntactically valid", () => {
    expect(() => new Function(`return ${snapshotExpression()};`)).not.toThrow();
  });

  it("preserves page text while removing non-interactable DOM controls", () => {
    expect(parseCdpSnapshot(JSON.stringify({
      url: "https://example.com",
      title: "Modal",
      text: "Background diagnostics remain readable",
      elements: [
        { ref: "@e1", role: "button", name: "Background", interactable: false, interactabilityReason: "modal-blocked" },
        {
          ref: "@e2",
          role: "button",
          name: "Confirm",
          withinText: "Account Settings Confirm Cancel",
          regionText: "Account Settings Confirm Cancel",
          interactable: true
        }
      ]
    }), "session-1")).toMatchObject({
      text: "Background diagnostics remain readable",
      elements: [{
        ref: "@e2",
        role: "button",
        name: "Confirm",
        withinText: "Account Settings Confirm Cancel",
        regionText: "Account Settings Confirm Cancel"
      }]
    });
  });

  it("parses bounded visible regions while omitting secret-bearing or unsafe links", () => {
    const parsed = parseCdpSnapshot(JSON.stringify({
      url: "https://example.com/apps",
      title: "Apps",
      text: "TikTok Connect",
      elements: [
        { ref: "@e1", role: "link", name: "Callback URL" },
        { ref: "@e2", role: "button", name: "Edit" },
        { ref: "@e3", role: "button", name: "Delete" }
      ],
      regions: [{
        ref: "@r1",
        text: "TikTok Connect Callback URL Edit Delete",
        actionRefs: ["@e1", "@e2", "@e3", "@e99", "not-a-ref"],
        links: [
          { text: "Callback URL", href: "https://example.com/callback" },
          { text: "Private callback", href: "https://example.com/callback?token=do-not-render" },
          { text: "CSRF callback", href: "https://example.com/callback?csrf=also-do-not-render" },
          { text: "Credential URL", href: "https://user:password@example.com/callback" },
          { text: "Unsafe", href: "javascript:alert(1)" }
        ],
        hitTestable: true
      }]
    }), "session-1");

    expect(parsed.regions).toEqual([{
      ref: "@r1",
      text: "TikTok Connect Callback URL Edit Delete",
      actionRefs: ["@e1", "@e2", "@e3"],
      links: [{ text: "Callback URL", href: "https://example.com/callback" }],
      hitTestable: true
    }]);
    expect(JSON.stringify(parsed)).not.toContain("do-not-render");
    expect(JSON.stringify(parsed)).not.toContain("also-do-not-render");
    expect(JSON.stringify(parsed)).not.toContain("javascript:");
  });

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

  it("times out a CDP command when the connected browser never replies", async () => {
    const socket = new FakeCdpSocket("ws://cdp/page-1", {
      silentMethods: new Set(["Runtime.evaluate"])
    });
    const supervisor = new CDPSupervisor({
      webSocketUrl: "ws://cdp/page-1",
      webSocketFactory: () => socket,
      requestTimeoutMs: 5
    });

    await supervisor.start();
    await expect(supervisor.send("Runtime.evaluate", { expression: "1" }))
      .rejects.toThrow("Timed out waiting for CDP command Runtime.evaluate.");

    const timedOutRequest = socket.sent.at(-1)!;
    socket.emitMessage({ id: timedOutRequest.id, result: { result: { value: 1 } } });
    await expect(supervisor.send("Page.navigate", { url: "https://example.com/next" }))
      .resolves.toMatchObject({ method: "Page.navigate" });
  });

  it("cancels a pending CDP command through its AbortSignal", async () => {
    const socket = new FakeCdpSocket("ws://cdp/page-1", {
      silentMethods: new Set(["Runtime.evaluate"])
    });
    const supervisor = new CDPSupervisor({
      webSocketUrl: "ws://cdp/page-1",
      webSocketFactory: () => socket,
      requestTimeoutMs: 1_000
    });
    const controller = new AbortController();

    await supervisor.start();
    const pending = supervisor.send("Runtime.evaluate", { expression: "1" }, { signal: controller.signal });
    controller.abort("test cancellation");

    await expect(pending).rejects.toMatchObject({
      name: "AbortError",
      message: "CDP command Runtime.evaluate was cancelled."
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
      readiness: "unknown",
      title: "Example",
      text: "Readable text",
      elements: [{ ref: "@e1", role: "button", name: "Continue" }],
      pendingDialogs: [],
      frameTree: [],
      consoleHistory: [],
      documentSignal: {}
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
            backendDOMNodeId: 101,
            role: { value: "button" },
            name: { value: "Continue" },
            properties: [{ name: "disabled", value: { type: "boolean", value: true } }]
          },
          {
            nodeId: "input-1",
            backendDOMNodeId: 102,
            role: { value: "textbox" },
            name: { value: "Email" },
            value: { value: "ada@example.com" }
          },
          {
            nodeId: "checkbox-1",
            backendDOMNodeId: 103,
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
        { ref: "@e1", role: "textbox", name: "Email", value: "ada@example.com" },
        { ref: "@e2", role: "checkbox", name: "Subscribe", checked: "mixed" }
      ],
      pendingDialogs: [],
      frameTree: [],
      consoleHistory: []
    });
    expect(socket.sent.map((message) => message.method)).toContain("Accessibility.getFullAXTree");
    expect(socket.sent.filter((message) => message.method === "DOM.resolveNode").map((message) => message.params)).toEqual([
      { backendNodeId: 101 },
      { backendNodeId: 102 },
      { backendNodeId: 103 }
    ]);
    expect(socket.sent.filter((message) => message.method === "Runtime.callFunctionOn")).toHaveLength(3);
  });

  it("excludes AX controls rejected by the shared interactability evaluator", async () => {
    const socket = new FakeCdpSocket("ws://cdp/page-1", {
      snapshot: { url: "https://example.com", title: "Example", text: "Background text remains", elements: [] },
      axTree: {
        nodes: [{
          nodeId: "covered-button",
          backendDOMNodeId: 101,
          role: { value: "button" },
          name: { value: "Covered action" }
        }]
      },
      callFunctionValue: {
        text: "Covered action",
        interactable: false,
        interactabilityReason: "modal-blocked",
        hidden: false,
        disabled: false
      }
    });
    const supervisor = new CDPSupervisor({
      webSocketUrl: "ws://cdp/page-1",
      webSocketFactory: () => socket
    });

    await supervisor.start();
    await expect(supervisor.getSnapshot("session-1")).resolves.toMatchObject({
      text: "Background text remains",
      elements: []
    });
  });

  it("binds actionable AX controls to their compact visible page region", async () => {
    const socket = new FakeCdpSocket("ws://cdp/page-1", {
      axTree: {
        nodes: [{
          nodeId: "edit-button",
          backendDOMNodeId: 101,
          role: { value: "button" },
          name: { value: "Edit" }
        }]
      },
      callFunctionValue: {
        text: "Edit",
        withinText: "TikTok Connect Callback URL Edit Delete",
        regionText: "TikTok Connect Callback URL Edit Delete",
        interactable: true,
        hidden: false,
        disabled: false
      }
    });
    const supervisor = new CDPSupervisor({
      webSocketUrl: "ws://cdp/page-1",
      webSocketFactory: () => socket
    });

    await supervisor.start();

    await expect(supervisor.getSnapshot("session-1")).resolves.toMatchObject({
      elements: [{
        ref: "@e1",
        role: "button",
        name: "Edit",
        withinText: "TikTok Connect Callback URL Edit Delete",
        regionText: "TikTok Connect Callback URL Edit Delete"
      }]
    });
  });

  it("getSnapshot() falls back when compact AX refs cannot be bound to DOM nodes", async () => {
    const socket = new FakeCdpSocket("ws://cdp/page-1", {
      axTree: {
        nodes: [
          { nodeId: "button-1", role: { value: "button" }, name: { value: "Unbound Continue" } }
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
      elements: [{ ref: "@e1", role: "button", name: "Continue" }]
    });
  });

  it("does not expose password values from AX snapshots", async () => {
    const socket = new FakeCdpSocket("ws://cdp/page-1", {
      axTree: {
        nodes: [{
          nodeId: "password-1",
          backendDOMNodeId: 201,
          role: { value: "textbox" },
          name: { value: "Password" },
          value: { value: "plain-user-password" }
        }]
      },
      callFunctionValue: { label: "Password", sensitive: true, hidden: false }
    });
    const supervisor = new CDPSupervisor({
      webSocketUrl: "ws://cdp/page-1",
      webSocketFactory: () => socket
    });

    await supervisor.start();
    const snapshot = await supervisor.getSnapshot("session-1");

    expect(snapshot.elements).toEqual([{
      ref: "@e1",
      role: "textbox",
      name: "Password",
      label: "Password",
      hidden: false
    }]);
    expect(JSON.stringify(snapshot)).not.toContain("plain-user-password");
  });

  it("getSnapshot() falls back when AX element bindings cannot be cleared", async () => {
    const socket = new FakeCdpSocket("ws://cdp/page-1", {
      failElementClear: true,
      axTree: {
        nodes: [
          { nodeId: "button-1", backendDOMNodeId: 101, role: { value: "button" }, name: { value: "AX Continue" } }
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
      elements: [{ ref: "@e1", role: "button", name: "Continue" }]
    });
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
              backendDOMNodeId: 101,
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

  it("getSnapshot() returns additional useful named AX nodes for full snapshots", async () => {
    const axTree = {
      nodes: [
        { nodeId: "root", role: { value: "RootWebArea" }, name: { value: "Example" } },
        { nodeId: "heading-1", role: { value: "heading" }, name: { value: "Account Settings" } },
        { nodeId: "button-1", backendDOMNodeId: 101, role: { value: "button" }, name: { value: "Save" } },
        { nodeId: "paragraph-1", role: { value: "paragraph" }, name: { value: "Profile details" } }
      ]
    };
    const compactSocket = new FakeCdpSocket("ws://cdp/page-compact", { axTree });
    const fullSocket = new FakeCdpSocket("ws://cdp/page-full", { axTree });
    const compactSupervisor = new CDPSupervisor({
      webSocketUrl: "ws://cdp/page-compact",
      webSocketFactory: () => compactSocket
    });
    const fullSupervisor = new CDPSupervisor({
      webSocketUrl: "ws://cdp/page-full",
      webSocketFactory: () => fullSocket
    });

    await compactSupervisor.start();
    await fullSupervisor.start();
    const compact = await compactSupervisor.getSnapshot("session-1");
    const full = await fullSupervisor.getSnapshot("session-1", { full: true });

    expect(compact.elements).toEqual([{ ref: "@e1", role: "button", name: "Save" }]);
    expect(full.elements).toEqual([
      { ref: "@e1", role: "button", name: "Save" },
      { ref: "@e2", role: "heading", name: "Account Settings" },
      { ref: "@e3", role: "paragraph", name: "Profile details" }
    ]);
    expect((compact.elements ?? []).length).toBeLessThan((full.elements ?? []).length);
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

  it("captures browser-owned popup attempts in a bounded, clearable queue", async () => {
    const socket = new FakeCdpSocket("ws://127.0.0.1:9222/devtools/page/popup-attempts");
    const supervisor = new CDPSupervisor({
      webSocketUrl: "ws://127.0.0.1:9222/devtools/page/popup-attempts",
      webSocketFactory: () => socket
    });
    await supervisor.start();

    socket.emitMessage({ method: "Page.windowOpen", params: { url: "", userGesture: true } });
    socket.emitMessage({ method: "Page.windowOpen", params: { url: 42, userGesture: true } });
    for (let index = 0; index < 10; index += 1) {
      socket.emitMessage({
        method: "Page.windowOpen",
        params: { url: `https://example.com/popup-${index}`, userGesture: index % 2 === 0 }
      });
    }

    expect(supervisor.popupAttempts()).toEqual(Array.from({ length: 8 }, (_, offset) => ({
      url: `https://example.com/popup-${offset + 2}`,
      userGesture: (offset + 2) % 2 === 0
    })));
    expect(supervisor.popupAttempts({ clear: true })).toHaveLength(8);
    expect(supervisor.popupAttempts()).toEqual([]);
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

  it("clears and suppresses console history while protected input is active", async () => {
    const socket = new FakeCdpSocket("ws://cdp/page-1");
    const supervisor = new CDPSupervisor({
      webSocketUrl: "ws://cdp/page-1",
      webSocketFactory: () => socket
    });

    await supervisor.start();
    socket.emitMessage({
      method: "Runtime.consoleAPICalled",
      params: { type: "log", args: [{ value: "before-protected-entry" }] }
    });
    supervisor.setSensitiveInputActive(true);
    socket.emitMessage({
      method: "Runtime.consoleAPICalled",
      params: { type: "log", args: [{ value: "protected-sentinel-secret" }] }
    });

    expect(supervisor.consoleHistory()).toEqual([]);
    expect(JSON.stringify(await supervisor.getSnapshot("session-1"))).not.toContain("protected-sentinel-secret");
    supervisor.setSensitiveInputActive(false);
    expect(supervisor.consoleHistory()).toEqual([]);
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

  it("reports manual same-URL document replacement through main-frame loader signals", async () => {
    const socket = new FakeCdpSocket("ws://cdp/page-1");
    const supervisor = new CDPSupervisor({
      webSocketUrl: "ws://cdp/page-1",
      webSocketFactory: () => socket
    });

    await supervisor.start();
    socket.emitMessage({
      method: "Page.frameNavigated",
      params: { frame: { id: "main", loaderId: "loader-1", url: "https://example.com/page" } }
    });
    const before = await supervisor.getSnapshot("session-1");
    socket.emitMessage({
      method: "Page.frameNavigated",
      params: { frame: { id: "main", loaderId: "loader-2", url: "https://example.com/page" } }
    });
    const after = await supervisor.getSnapshot("session-1");

    expect(before.url).toBe(after.url);
    expect(before.documentSignal).toEqual({ frameId: "main", loaderId: "loader-1" });
    expect(after.documentSignal).toEqual({ frameId: "main", loaderId: "loader-2" });
  });

  it("uses the default main-frame execution context when a loader id is unavailable", async () => {
    const socket = new FakeCdpSocket("ws://cdp/page-1");
    const supervisor = new CDPSupervisor({
      webSocketUrl: "ws://cdp/page-1",
      webSocketFactory: () => socket
    });

    await supervisor.start();
    socket.emitMessage({
      method: "Page.frameNavigated",
      params: { frame: { id: "main", url: "https://example.com/page" } }
    });
    socket.emitMessage({
      method: "Runtime.executionContextCreated",
      params: { context: { id: 41, auxData: { frameId: "main", isDefault: true } } }
    });
    const before = await supervisor.getSnapshot("session-1");
    socket.emitMessage({
      method: "Runtime.executionContextCreated",
      params: { context: { id: 42, auxData: { frameId: "main", isDefault: true } } }
    });
    const after = await supervisor.getSnapshot("session-1");

    expect(before.documentSignal).toEqual({ frameId: "main", executionContextId: 41 });
    expect(after.documentSignal).toEqual({ frameId: "main", executionContextId: 42 });
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

  it("captures trusted browser download lifecycle events", async () => {
    const socket = new FakeCdpSocket("ws://cdp/page-1");
    const supervisor = new CDPSupervisor({
      webSocketUrl: "ws://cdp/page-1",
      webSocketFactory: () => socket
    });
    await supervisor.start();
    await supervisor.prepareDownload("/tmp/estacoda-download-test", 1_024);
    const waiting = supervisor.waitForDownload(1_000);

    socket.emitMessage({
      method: "Browser.downloadWillBegin",
      params: { guid: "guid-1", url: "https://example.com/openapi.json", suggestedFilename: "openapi.json" }
    });
    socket.emitMessage({
      method: "Browser.downloadProgress",
      params: { guid: "guid-1", state: "completed", receivedBytes: 128 }
    });

    await expect(waiting).resolves.toEqual({
      outcome: "download-completed",
      guid: "guid-1",
      url: "https://example.com/openapi.json",
      suggestedFilename: "openapi.json",
      receivedBytes: 128
    });
    expect(socket.sent).toEqual(expect.arrayContaining([
      expect.objectContaining({
        method: "Browser.setDownloadBehavior",
        params: { behavior: "allowAndName", downloadPath: "/tmp/estacoda-download-test", eventsEnabled: true }
      })
    ]));
  });

  it("cancels a download as soon as trusted progress exceeds the size limit", async () => {
    const socket = new FakeCdpSocket("ws://cdp/page-1");
    const supervisor = new CDPSupervisor({
      webSocketUrl: "ws://cdp/page-1",
      webSocketFactory: () => socket
    });
    await supervisor.start();
    await supervisor.prepareDownload("/tmp/estacoda-download-test", 64);
    socket.emitMessage({
      method: "Browser.downloadWillBegin",
      params: { guid: "guid-large", url: "https://example.com/large.zip", suggestedFilename: "large.zip" }
    });
    socket.emitMessage({
      method: "Browser.downloadProgress",
      params: { guid: "guid-large", state: "inProgress", receivedBytes: 65 }
    });
    const waiting = supervisor.waitForDownload(1_000);

    await expect(waiting).resolves.toMatchObject({ outcome: "download-failed", reason: "download-too-large" });
    expect(socket.sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "Browser.cancelDownload", params: { guid: "guid-large" } })
    ]));
  });

  it("cancels an active partial download when the runtime request is aborted", async () => {
    const socket = new FakeCdpSocket("ws://cdp/page-1");
    const supervisor = new CDPSupervisor({
      webSocketUrl: "ws://cdp/page-1",
      webSocketFactory: () => socket
    });
    const controller = new AbortController();
    await supervisor.start();
    await supervisor.prepareDownload("/tmp/estacoda-download-test", 1_024, controller.signal);
    const waiting = supervisor.waitForDownload(1_000, controller.signal);
    socket.emitMessage({
      method: "Browser.downloadWillBegin",
      params: { guid: "guid-partial", url: "https://example.com/openapi.json", suggestedFilename: "openapi.json" }
    });

    controller.abort();

    await expect(waiting).rejects.toMatchObject({ name: "AbortError" });
    expect(socket.sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "Browser.cancelDownload", params: { guid: "guid-partial" } })
    ]));
  });
});
