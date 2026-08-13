import { describe, expect, it, vi } from "vitest";
import type { CdpFetchLike } from "./cdp-client.js";
import {
  CdpTargetManager,
  type CdpClientLike,
  type CdpTargetSupervisor,
  type CdpTargetSupervisorOptions
} from "./cdp-target-manager.js";

type FetchRoute = {
  ok?: boolean;
  status?: number;
  statusText?: string;
  payload: unknown;
};

class FakeCdpClient implements CdpClientLike {
  readonly calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  closed = false;
  browserContextId = "context-1";
  targetId = "target-1";
  failContext = false;
  failTarget = false;
  targetInfos: unknown[] = [{
    targetId: "target-1",
    type: "page",
    title: "Main",
    url: "about:blank",
    browserContextId: "context-1"
  }];

  async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "Target.createBrowserContext") {
      if (this.failContext) {
        throw new Error("context failed");
      }
      return { browserContextId: this.browserContextId };
    }
    if (method === "Target.createTarget") {
      if (this.failTarget) {
        throw new Error("target failed");
      }
      return { targetId: this.targetId };
    }
    if (method === "Target.closeTarget") {
      return { success: true };
    }
    if (method === "Target.disposeBrowserContext") {
      return {};
    }
    if (method === "Target.activateTarget") {
      return {};
    }
    if (method === "Target.getTargets") {
      return { targetInfos: this.targetInfos };
    }
    throw new Error(`Unexpected CDP method: ${method}`);
  }

  close(): void {
    this.closed = true;
  }
}

class FakeSupervisor implements CdpTargetSupervisor {
  closed = false;

  constructor(
    readonly webSocketUrl: string,
    private readonly onClose?: () => void
  ) {}

  close(): void {
    this.closed = true;
    this.onClose?.();
  }
}

function createFetch(routes: Record<string, FetchRoute>): CdpFetchLike {
  return vi.fn(async (url: string) => {
    const route = routes[url];
    if (route === undefined) {
      throw new Error(`Unexpected fetch: ${url}`);
    }
    return {
      ok: route.ok ?? true,
      status: route.status ?? 200,
      statusText: route.statusText ?? "OK",
      json: async () => route.payload,
      text: async () => JSON.stringify(route.payload)
    };
  });
}

function createDefaultRoutes(overrides: Partial<Record<"version" | "list", FetchRoute>> = {}): Record<string, FetchRoute> {
  return {
    "http://127.0.0.1:9222/json/version": overrides.version ?? {
      payload: {
        webSocketDebuggerUrl: "ws://browser"
      }
    },
    "http://127.0.0.1:9222/json/list": overrides.list ?? {
      payload: [{
        id: "target-1",
        webSocketDebuggerUrl: "ws://page/target-1"
      }]
    }
  };
}

function createHarness(input: {
  fetch?: CdpFetchLike;
  client?: FakeCdpClient;
  supervisorFactory?: (options: CdpTargetSupervisorOptions) => Promise<CdpTargetSupervisor>;
  pageVisibility?: Record<string, "visible" | "hidden">;
} = {}) {
  const client = input.client ?? new FakeCdpClient();
  const createdClients: string[] = [];
  const supervisors: FakeSupervisor[] = [];
  const supervisorFactory = input.supervisorFactory ?? vi.fn(async (options: CdpTargetSupervisorOptions) => {
    const supervisor = new FakeSupervisor(options.webSocketUrl);
    supervisors.push(supervisor);
    return supervisor;
  });
  const manager = new CdpTargetManager({
    endpoint: "http://127.0.0.1:9222/",
    fetch: input.fetch ?? createFetch(createDefaultRoutes()),
    createClient: vi.fn(async (webSocketUrl: string) => {
      createdClients.push(webSocketUrl);
      if (webSocketUrl !== "ws://browser" && input.pageVisibility !== undefined) {
        return {
          send: vi.fn(async (method: string) => {
            if (method !== "Runtime.evaluate") throw new Error(`Unexpected CDP method: ${method}`);
            return { result: { value: input.pageVisibility?.[webSocketUrl] ?? "hidden" } };
          }),
          close: vi.fn()
        };
      }
      return client;
    }),
    supervisorFactory
  });

  return {
    client,
    createdClients,
    manager,
    supervisorFactory,
    supervisors
  };
}

describe("CdpTargetManager", () => {
  it("creates an isolated context and page supervisor from the browser CDP endpoint", async () => {
    const fetch = createFetch(createDefaultRoutes());
    const harness = createHarness({ fetch });

    const target = await harness.manager.createTarget();

    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:9222/json/version");
    expect(harness.createdClients).toEqual(["ws://browser"]);
    expect(harness.client.calls).toEqual([
      { method: "Target.createBrowserContext", params: undefined },
      { method: "Target.createTarget", params: { url: "about:blank", browserContextId: "context-1" } }
    ]);
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:9222/json/list");
    expect(target).toMatchObject({
      browserContextId: "context-1",
      targetId: "target-1",
      pageWebSocketDebuggerUrl: "ws://page/target-1"
    });
    expect(harness.supervisorFactory).toHaveBeenCalledWith({
      webSocketUrl: "ws://page/target-1"
    });
    expect(target.supervisor).toBe(harness.supervisors[0]);
  });

  it("closes supervisor before Target.closeTarget and disposes the browser context last", async () => {
    const order: string[] = [];
    const client = new FakeCdpClient();
    const originalSend = client.send.bind(client);
    client.send = async (method, params) => {
      if (method === "Target.closeTarget" || method === "Target.disposeBrowserContext") {
        order.push(method);
      }
      return originalSend(method, params);
    };
    const supervisorFactory = vi.fn(async (options: CdpTargetSupervisorOptions) => new FakeSupervisor(options.webSocketUrl, () => {
      order.push("supervisor.close");
    }));
    const harness = createHarness({ client, supervisorFactory });
    const target = await harness.manager.createTarget();

    await target.close();

    expect(order).toEqual([
      "supervisor.close",
      "Target.closeTarget",
      "Target.disposeBrowserContext"
    ]);
    expect(client.calls.slice(2)).toEqual([
      { method: "Target.closeTarget", params: { targetId: "target-1" } },
      { method: "Target.disposeBrowserContext", params: { browserContextId: "context-1" } }
    ]);
  });

  it("target cleanup is idempotent", async () => {
    const harness = createHarness();
    const target = await harness.manager.createTarget();

    await target.close();
    await target.close();

    expect(harness.client.calls.filter((call) => call.method === "Target.closeTarget")).toHaveLength(1);
    expect(harness.client.calls.filter((call) => call.method === "Target.disposeBrowserContext")).toHaveLength(1);
  });

  it("lists only page targets from the requested browser context", async () => {
    const client = new FakeCdpClient();
    client.targetInfos = [
      { targetId: "target-1", type: "page", title: "Main", url: "https://example.com", browserContextId: "context-1" },
      { targetId: "target-2", type: "page", title: "Details", url: "https://example.com/details", browserContextId: "context-1", openerId: "target-1" },
      { targetId: "target-other", type: "page", title: "Other", url: "https://other.example", browserContextId: "context-2" },
      { targetId: "browser-ui", type: "browser_ui", title: "Omnibox", url: "chrome://omnibox", browserContextId: "context-1" },
      { targetId: "missing-websocket", type: "page", title: "Broken", url: "https://broken.example", browserContextId: "context-1" }
    ];
    const harness = createHarness({
      client,
      fetch: createFetch(createDefaultRoutes({
        list: {
          payload: [
            { id: "target-1", webSocketDebuggerUrl: "ws://page/target-1" },
            { id: "target-2", webSocketDebuggerUrl: "ws://page/target-2" },
            { id: "target-other", webSocketDebuggerUrl: "ws://page/other" },
            { id: "browser-ui", webSocketDebuggerUrl: "ws://browser-ui" }
          ]
        }
      }))
    });

    await expect(harness.manager.listPageTargets("context-1")).resolves.toEqual([
      {
        browserContextId: "context-1",
        targetId: "target-1",
        pageWebSocketDebuggerUrl: "ws://page/target-1",
        url: "https://example.com",
        title: "Main"
      },
      {
        browserContextId: "context-1",
        targetId: "target-2",
        pageWebSocketDebuggerUrl: "ws://page/target-2",
        url: "https://example.com/details",
        title: "Details",
        openerId: "target-1"
      }
    ]);
  });

  it("detects the visible page target without reading page content", async () => {
    const client = new FakeCdpClient();
    client.targetInfos = [
      { targetId: "target-1", type: "page", url: "https://example.com/one", browserContextId: "context-1" },
      { targetId: "target-2", type: "page", url: "https://example.com/two", browserContextId: "context-1" }
    ];
    const harness = createHarness({
      client,
      fetch: createFetch(createDefaultRoutes({
        list: {
          payload: [
            { id: "target-1", webSocketDebuggerUrl: "ws://page/target-1" },
            { id: "target-2", webSocketDebuggerUrl: "ws://page/target-2" }
          ]
        }
      })),
      pageVisibility: {
        "ws://page/target-1": "hidden",
        "ws://page/target-2": "visible"
      }
    });

    await expect(harness.manager.findVisiblePageTargetId("context-1", "target-1")).resolves.toBe("target-2");
    expect(harness.createdClients).toEqual([
      "ws://browser",
      "ws://page/target-1",
      "ws://page/target-2"
    ]);
  });

  it("attaches and activates only same-context page targets without owning their lifecycle", async () => {
    const client = new FakeCdpClient();
    client.targetInfos = [
      { targetId: "target-2", type: "page", title: "Details", url: "https://example.com/details", browserContextId: "context-1" },
      { targetId: "target-other", type: "page", title: "Other", url: "https://other.example", browserContextId: "context-2" }
    ];
    const harness = createHarness({
      client,
      fetch: createFetch(createDefaultRoutes({
        list: {
          payload: [
            { id: "target-2", webSocketDebuggerUrl: "ws://page/target-2" },
            { id: "target-other", webSocketDebuggerUrl: "ws://page/other" }
          ]
        }
      }))
    });

    const attached = await harness.manager.attachTarget("context-1", "target-2");
    await harness.manager.activateTarget("context-1", "target-2");
    await attached.close();
    await attached.close();

    expect(attached).toMatchObject({
      browserContextId: "context-1",
      targetId: "target-2",
      pageWebSocketDebuggerUrl: "ws://page/target-2"
    });
    expect(harness.supervisors).toHaveLength(1);
    expect(harness.supervisors[0]?.closed).toBe(true);
    expect(harness.client.calls).toContainEqual({ method: "Target.activateTarget", params: { targetId: "target-2" } });
    expect(harness.client.calls.some((call) => call.method === "Target.closeTarget")).toBe(false);
    expect(harness.client.calls.some((call) => call.method === "Target.disposeBrowserContext")).toBe(false);
    await expect(harness.manager.attachTarget("context-1", "target-other")).rejects.toThrow(
      "CDP page target target-other is not available in browser context context-1."
    );
  });

  it("fails closed when Target.getTargets does not return target metadata", async () => {
    const client = new FakeCdpClient();
    client.send = vi.fn(async (method: string) => {
      if (method === "Target.getTargets") return {};
      throw new Error(`Unexpected CDP method: ${method}`);
    });
    const harness = createHarness({ client });

    await expect(harness.manager.listPageTargets("context-1")).rejects.toThrow(
      "Target.getTargets did not return a targetInfos array."
    );
  });

  it("fails closed when /json/version has no browser websocket URL", async () => {
    const harness = createHarness({
      fetch: createFetch(createDefaultRoutes({
        version: { payload: {} }
      }))
    });

    await expect(harness.manager.createTarget()).rejects.toThrow(
      "CDP browser version from http://127.0.0.1:9222/json/version did not include a usable webSocketDebuggerUrl."
    );
    expect(harness.createdClients).toEqual([]);
    expect(harness.client.calls).toEqual([]);
  });

  it("fails closed when /json/version returns an invalid payload", async () => {
    const harness = createHarness({
      fetch: createFetch(createDefaultRoutes({
        version: { payload: null }
      }))
    });

    await expect(harness.manager.createTarget()).rejects.toThrow(
      "CDP browser version from http://127.0.0.1:9222/json/version did not include a usable webSocketDebuggerUrl."
    );
    expect(harness.createdClients).toEqual([]);
    expect(harness.client.calls).toEqual([]);
  });

  it("wraps browser-level CDP connection failures with step context", async () => {
    const manager = new CdpTargetManager({
      endpoint: "http://127.0.0.1:9222",
      fetch: createFetch(createDefaultRoutes()),
      createClient: async () => {
        throw new Error("socket refused");
      },
      supervisorFactory: async (options) => new FakeSupervisor(options.webSocketUrl)
    });

    await expect(manager.createTarget()).rejects.toThrow(
      "Failed to connect to browser CDP websocket from http://127.0.0.1:9222/json/version: socket refused"
    );
  });

  it("fails closed when the created target is missing from /json/list and cleans up", async () => {
    const harness = createHarness({
      fetch: createFetch(createDefaultRoutes({
        list: { payload: [{ id: "other-target", webSocketDebuggerUrl: "ws://page/other" }] }
      }))
    });

    await expect(harness.manager.createTarget()).rejects.toThrow(
      "CDP target list from http://127.0.0.1:9222/json/list did not include created target target-1."
    );
    expect(harness.client.calls.slice(2)).toEqual([
      { method: "Target.closeTarget", params: { targetId: "target-1" } },
      { method: "Target.disposeBrowserContext", params: { browserContextId: "context-1" } }
    ]);
  });

  it("fails closed when the matched target has no page websocket URL and cleans up", async () => {
    const harness = createHarness({
      fetch: createFetch(createDefaultRoutes({
        list: { payload: [{ id: "target-1" }] }
      }))
    });

    await expect(harness.manager.createTarget()).rejects.toThrow(
      "CDP target target-1 from http://127.0.0.1:9222/json/list did not include a usable webSocketDebuggerUrl."
    );
    expect(harness.client.calls.slice(2)).toEqual([
      { method: "Target.closeTarget", params: { targetId: "target-1" } },
      { method: "Target.disposeBrowserContext", params: { browserContextId: "context-1" } }
    ]);
  });

  it("supervisor creation failure cleans up target and context", async () => {
    const harness = createHarness({
      supervisorFactory: async () => {
        throw new Error("supervisor failed");
      }
    });

    await expect(harness.manager.createTarget()).rejects.toThrow(
      "Failed to create CDP page supervisor for target websocket ws://page/target-1: supervisor failed"
    );
    expect(harness.client.calls.slice(2)).toEqual([
      { method: "Target.closeTarget", params: { targetId: "target-1" } },
      { method: "Target.disposeBrowserContext", params: { browserContextId: "context-1" } }
    ]);
  });

  it("target creation failure disposes the created browser context", async () => {
    const client = new FakeCdpClient();
    client.failTarget = true;
    const harness = createHarness({ client });

    await expect(harness.manager.createTarget()).rejects.toThrow("Target.createTarget failed: target failed");
    expect(client.calls).toEqual([
      { method: "Target.createBrowserContext", params: undefined },
      { method: "Target.createTarget", params: { url: "about:blank", browserContextId: "context-1" } },
      { method: "Target.disposeBrowserContext", params: { browserContextId: "context-1" } }
    ]);
  });

  it("context creation failure does not attempt target cleanup", async () => {
    const client = new FakeCdpClient();
    client.failContext = true;
    const harness = createHarness({ client });

    await expect(harness.manager.createTarget()).rejects.toThrow("Target.createBrowserContext failed: context failed");
    expect(client.calls).toEqual([
      { method: "Target.createBrowserContext", params: undefined }
    ]);
  });

  it("manager close() cleans still-open targets and closes the browser client", async () => {
    const client = new FakeCdpClient();
    const harness = createHarness({
      client,
      fetch: createFetch(createDefaultRoutes({
        list: {
          payload: [
            { id: "target-1", webSocketDebuggerUrl: "ws://page/target-1" },
            { id: "target-2", webSocketDebuggerUrl: "ws://page/target-2" }
          ]
        }
      }))
    });
    const first = await harness.manager.createTarget();
    client.browserContextId = "context-2";
    client.targetId = "target-2";
    const second = await harness.manager.createTarget();

    await harness.manager.close();
    await harness.manager.close();

    expect(client.closed).toBe(true);
    expect(harness.supervisors.every((supervisor) => supervisor.closed)).toBe(true);
    expect(client.calls.filter((call) => call.method === "Target.closeTarget")).toEqual([
      { method: "Target.closeTarget", params: { targetId: first.targetId } },
      { method: "Target.closeTarget", params: { targetId: second.targetId } }
    ]);
    expect(client.calls.filter((call) => call.method === "Target.disposeBrowserContext")).toEqual([
      { method: "Target.disposeBrowserContext", params: { browserContextId: first.browserContextId } },
      { method: "Target.disposeBrowserContext", params: { browserContextId: second.browserContextId } }
    ]);
  });
});
