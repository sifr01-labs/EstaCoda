import { vi } from "vitest";
import type {
  CdpFetchLike,
  CdpWebSocketEvent,
  CdpWebSocketFactory,
  CdpWebSocketLike,
} from "../../browser/cdp-client.js";

export type FakeCdpAuthElement = {
  ref: string;
  role: string;
  name: string;
  withinText?: string;
  label?: string;
  value?: string;
};

export type FakeCdpAuthSnapshot = {
  url: string;
  title: string;
  text: string;
  elements: FakeCdpAuthElement[];
};

/**
 * Test-only CDP peer with explicit hooks for protected delivery and submission.
 * It is intentionally stateful so browser tests can model authentication page
 * transitions without starting Chrome or handling real protected values.
 */
export class FakeCdpAuthPortalSocket implements CdpWebSocketLike {
  readonly readyState = 1;
  readonly sent: Array<{ id: number; method: string; params?: Record<string, unknown> }> = [];
  readonly #listeners = new Map<string, Array<(event: CdpWebSocketEvent) => void>>();
  readonly failMethods = new Map<string, string>();
  readonly missingElementIndexes = new Set<number>();
  #contextCounter = 0;
  #targetCounter = 0;
  closed = false;
  snapshot: FakeCdpAuthSnapshot = {
    url: "https://example.com/final",
    title: "Supervised Page",
    text: "Supervised text",
    elements: [{ ref: "@e1", role: "button", name: "Open" }],
  };
  axTree: unknown;
  protectedFieldInspection = {
    connected: true,
    current: true,
    visible: true,
    disabled: false,
    editable: true,
    semanticsMatch: true,
    conflictCount: 1,
  };
  protectedSubmitInspection = {
    connected: true,
    current: true,
    visible: true,
    disabled: false,
    clickable: true,
    semanticsMatch: true,
  };
  documentCurrent = true;
  frameId = "main-frame";
  onProtectedDelivery?: () => void;
  onProtectedSubmit?: () => void;
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
            error: { message: `Browser element ref not found at index ${index}` },
          }),
        });
        return;
      }
    }
    const failure = this.failMethods.get(message.method);
    if (failure !== undefined) {
      this.#emit("message", {
        data: JSON.stringify({
          id: message.id,
          error: { message: failure },
        }),
      });
      return;
    }
    const result = this.#resultFor(message);
    this.#emit("message", {
      data: JSON.stringify({
        id: message.id,
        result,
      }),
    });
    if (
      message.method === "Page.navigate" ||
      (message.method === "Runtime.evaluate" &&
        typeof message.params?.expression === "string" &&
        message.params.expression.includes("history.back"))
    ) {
      setTimeout(
        () =>
          this.#emit("message", {
            data: JSON.stringify({ method: "Page.loadEventFired", params: {} }),
          }),
        0,
      );
    }
  }

  close(): void {
    this.closed = true;
    this.#emit("close", {});
  }

  addEventListener(
    type: "open" | "message" | "error" | "close",
    listener: (event: CdpWebSocketEvent) => void,
  ): void {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener);
    this.#listeners.set(type, listeners);
  }

  emitMessage(message: unknown): void {
    this.#emit("message", { data: JSON.stringify(message) });
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
          browserContextId: `context-${index + 1}`,
        })),
      };
    }
    if (method === "Runtime.evaluate") {
      if (message.params?.expression === "document") {
        return { result: { objectId: "protected-document-object" } };
      }
      if (
        typeof message.params?.expression === "string" &&
        /^window\.__estacodaElements\?\.\[\d+\]$/u.test(message.params.expression)
      ) {
        const index = /\[(\d+)\]/u.exec(message.params.expression)?.[1] ?? "unknown";
        return { result: { objectId: `protected-field-object-${index}` } };
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
      if (
        typeof message.params?.functionDeclaration === "string" &&
        message.params.functionDeclaration.includes("this === document")
      ) {
        return { result: { value: this.documentCurrent } };
      }
      if (
        typeof message.params?.functionDeclaration === "string" &&
        message.params.functionDeclaration.includes("conflictCount")
      ) {
        return { result: { value: this.protectedFieldInspection } };
      }
      if (
        typeof message.params?.functionDeclaration === "string" &&
        message.params.functionDeclaration.includes("clickable:")
      ) {
        return { result: { value: this.protectedSubmitInspection } };
      }
      if (
        typeof message.params?.functionDeclaration === "string" &&
        message.params.functionDeclaration.includes("protectedValue")
      ) {
        this.onProtectedDelivery?.();
        return { result: { value: true } };
      }
      if (
        typeof message.params?.functionDeclaration === "string" &&
        message.params.functionDeclaration.includes("this.click();")
      ) {
        this.onProtectedSubmit?.();
        return { result: { value: true } };
      }
      return { result: { value: true } };
    }
    if (method === "Page.getFrameTree") {
      return { frameTree: { frame: { id: this.frameId, url: this.snapshot.url } } };
    }
    if (method === "Page.captureScreenshot") {
      return { data: "png-data" };
    }
    return { ok: true, method };
  }

  #emit(type: string, event: CdpWebSocketEvent): void {
    for (const listener of this.#listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

export function showCredentialLoginPage(socket: FakeCdpAuthPortalSocket): void {
  resetProtectedInspections(socket);
  socket.snapshot = {
    url: "https://accounts.example.com/login",
    title: "Sign in",
    text: "Sign in",
    elements: [
      { ref: "@e1", role: "textbox", name: "Email" },
      { ref: "@e2", role: "textbox", name: "Password" },
      { ref: "@e3", role: "button", name: "Log in" },
    ],
  };
}

export function showOtpChallengePage(socket: FakeCdpAuthPortalSocket): void {
  resetProtectedInspections(socket);
  socket.snapshot = {
    url: "https://accounts.example.com/challenge",
    title: "Verify account",
    text: "Enter authenticator code",
    elements: [
      { ref: "@e1", role: "textbox", name: "One-time code" },
      { ref: "@e2", role: "button", name: "Authenticate" },
    ],
  };
}

export function showAuthenticatedHome(
  socket: FakeCdpAuthPortalSocket,
  options: { documentChanged?: boolean } = {}
): void {
  socket.protectedFieldInspection.current = false;
  socket.protectedFieldInspection.conflictCount = 0;
  socket.protectedSubmitInspection.current = false;
  if (options.documentChanged ?? true) socket.documentCurrent = false;
  socket.snapshot = {
    url: "https://accounts.example.com/home",
    title: "Account home",
    text: "Welcome",
    elements: [{ ref: "@e1", role: "link", name: "My profile" }],
  };
}

export function createFakeCdpAuthPortalSocketFactory(): {
  webSocketFactory: CdpWebSocketFactory;
  sockets: FakeCdpAuthPortalSocket[];
  browserSocket: () => FakeCdpAuthPortalSocket | undefined;
  pageSocket: (index?: number) => FakeCdpAuthPortalSocket | undefined;
} {
  const sockets: FakeCdpAuthPortalSocket[] = [];
  const webSocketFactory: CdpWebSocketFactory = vi.fn(() => {
    const socket = new FakeCdpAuthPortalSocket();
    sockets.push(socket);
    return socket;
  });
  return {
    webSocketFactory,
    sockets,
    browserSocket: () => sockets[0],
    pageSocket: (index = 0) => sockets[index + 1],
  };
}

function resetProtectedInspections(socket: FakeCdpAuthPortalSocket): void {
  socket.documentCurrent = true;
  socket.frameId = "main-frame";
  Object.assign(socket.protectedFieldInspection, {
    connected: true,
    current: true,
    visible: true,
    disabled: false,
    editable: true,
    semanticsMatch: true,
    conflictCount: 1,
  });
  Object.assign(socket.protectedSubmitInspection, {
    connected: true,
    current: true,
    visible: true,
    disabled: false,
    clickable: true,
    semanticsMatch: true,
  });
}

export function createFakeCdpFetch(overrides?: {
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
          webSocketDebuggerUrl: "ws://cdp/browser",
        },
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
            webSocketDebuggerUrl: `ws://cdp/${id}`,
          };
        }),
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
    text: async () => JSON.stringify(input.payload),
  };
}
