import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CdpFetchLike } from "./cdp-client.js";
import {
  FakeCdpAuthPortalSocket as FakeCdpSocket,
  createFakeCdpAuthPortalSocketFactory as createSocketFactory,
  createFakeCdpFetch as createFetch,
  showAuthenticatedHome,
  showCredentialLoginPage,
  showOtpChallengePage,
} from "../test/fakes/fake-cdp-auth-portal.js";
import { createBrowserBackendFromConfig } from "./browser-backend.js";
import { createSupervisedLocalCdpBrowserBackend } from "./supervised-local-cdp-backend.js";
import { BrowserSessionLifecycle } from "./session-lifecycle.js";
import {
  createBrowserSnapshotIdentityState,
  observeBrowserState,
  type BrowserDocumentSignal,
  type BrowserSnapshotInput
} from "./snapshot-state.js";

function createSnapshotObserver() {
  const state = createBrowserSnapshotIdentityState();
  return vi.fn((_key: string, snapshot: BrowserSnapshotInput, signal?: BrowserDocumentSignal) =>
    observeBrowserState(snapshot, state, signal));
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
    expect(configured.capabilities).toMatchObject({
      nativePointer: true,
      popupObservation: true,
      downloads: true,
      protectedInput: true,
      protectedSourceRelay: true
    });
  });

  it("captures a current identity-bound download through native input and trusted CDP events", async () => {
    const root = await mkdtemp(join(tmpdir(), "estacoda-supervised-download-"));
    const socket = new FakeCdpSocket();
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      fetch: createFetch(),
      webSocketFactory: () => socket,
      resolveHostname: () => ["93.184.216.34"]
    });
    try {
      const navigation = await backend.navigate({
        url: "https://developer.example.test/apps",
        sessionId: "session-download"
      });
      socket.onNativeClick = () => {
        void writeFile(join(root, "guid-download"), '{"openapi":"3.1.0"}').then(() => {
          socket.emitMessage({
            method: "Browser.downloadWillBegin",
            params: {
              guid: "guid-download",
              url: "https://developer.example.test/openapi.json",
              suggestedFilename: "openapi.json"
            }
          });
          socket.emitMessage({
            method: "Browser.downloadProgress",
            params: { guid: "guid-download", state: "completed", receivedBytes: 19 }
          });
        });
      };

      await expect(backend.download?.({
        sessionId: "session-download",
        ref: "@e1",
        identity: navigation.snapshot.identity,
        tabRef: navigation.snapshot.tab!.ref,
        destinationDirectory: root,
        maxBytes: 1_024
      })).resolves.toMatchObject({
        outcome: "download-completed",
        localPath: join(root, "guid-download"),
        suggestedFilename: "openapi.json",
        sourceUrl: "https://developer.example.test/openapi.json"
      });
      expect(socket.sent).toEqual(expect.arrayContaining([
        expect.objectContaining({ method: "Input.dispatchMouseEvent", params: expect.objectContaining({ type: "mouseReleased" }) }),
        expect.objectContaining({ method: "Browser.setDownloadBehavior" })
      ]));
    } finally {
      await backend.close?.();
      await rm(root, { recursive: true, force: true });
    }
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
      capabilities: backend.capabilities,
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
      capabilities: backend.capabilities,
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

  it("opens and controls new-tab navigation through the existing supervised session", async () => {
    const sent: Array<{ tab: string; method: string; params?: Record<string, unknown> }> = [];
    const mainSupervisor = {
      send: vi.fn(async (method: string, params?: Record<string, unknown>) => {
        sent.push({ tab: "@t1", method, params });
        return {};
      }),
      waitFor: vi.fn(async () => undefined),
      getSnapshot: vi.fn(async () => ({
        sessionId: "session-1",
        url: "https://example.com/apps",
        title: "Apps",
        text: "Apps",
        elements: []
      })),
      consoleHistory: vi.fn(() => []),
      respondToDialog: vi.fn(async () => undefined),
      close: vi.fn()
    };
    const newTabSupervisor = {
      ...mainSupervisor,
      send: vi.fn(async (method: string, params?: Record<string, unknown>) => {
        sent.push({ tab: "@t2", method, params });
        return {};
      }),
      getSnapshot: vi.fn(async () => ({
        sessionId: "session-1",
        url: "https://example.com/connect",
        title: "Connect",
        text: "Connect",
        elements: []
      }))
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
    const sessionManager = {
      acquire: vi.fn(async () => session),
      openTab: vi.fn(async (_key: string, url: string) => {
        expect(url).toBe("about:blank");
        session.targetId = "target-2";
        session.tabRef = "@t2";
        session.pageWebSocketDebuggerUrl = "ws://target-2";
        session.supervisor = newTabSupervisor;
        return session;
      }),
      close: vi.fn(async () => undefined),
      closeAll: vi.fn(async () => undefined),
      has: vi.fn(() => true),
      observeSnapshot: createSnapshotObserver()
    };
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      fetch: createFetch(),
      resolveHostname: () => ["93.184.216.34"],
      settling: { pollIntervalMs: 5, stableWindowMs: 10, minimumObservationMs: 20 },
      createTargetManager: () => ({
        createTarget: vi.fn(async () => { throw new Error("unused"); }),
        close: vi.fn(async () => undefined)
      }),
      createSessionManager: () => sessionManager
    });

    await backend.navigate({ url: "https://example.com/apps", sessionId: "session-1" });
    const opened = await backend.navigate({
      url: "https://example.com/connect",
      sessionId: "session-1",
      disposition: "new-tab"
    });

    expect(sessionManager.openTab).toHaveBeenCalledWith("session-1", "about:blank");
    expect(sent).toContainEqual({
      tab: "@t2",
      method: "Page.navigate",
      params: { url: "https://example.com/connect" }
    });
    expect(opened).toMatchObject({
      snapshot: {
        url: "https://example.com/connect",
        tab: { ref: "@t2", controlled: true },
        actionDelta: {
          outcome: "new-tab-opened",
          tabTransition: {
            source: { ref: "@t1" },
            destination: { ref: "@t2" }
          }
        }
      },
      metadata: { disposition: "new-tab", controlledTab: "@t2" }
    });
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
      identity: launchedNavigation.snapshot.identity,
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
      { ref: "@e1", role: "button", name: "Open" },
      { ref: "@e2", role: "heading", name: "Overview" }
    ]);
    await backend.click?.({
      sessionId: "session-1",
      ref: "@e1",
      identity: full!.identity,
      tabRef: full!.tab!.ref
    });
    expect(socket.sent).toContainEqual(expect.objectContaining({
      method: "Runtime.evaluate",
      params: expect.objectContaining({ expression: expect.stringContaining("__estacodaElements?.[0]") })
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
      identity: navigation.snapshot.identity,
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

  it("clicks a runtime-grounded visible region through native pointer input", async () => {
    const socket = new FakeCdpSocket();
    socket.snapshot = {
      url: "https://example.com/apps",
      title: "Apps",
      text: "TikTok Connect Callback URL Edit Delete",
      elements: [
        { ref: "@e1", role: "link", name: "Callback URL" },
        { ref: "@e2", role: "button", name: "Edit" },
        { ref: "@e3", role: "button", name: "Delete" }
      ],
      regions: [{
        ref: "@r1",
        text: "TikTok Connect Callback URL Edit Delete",
        actionRefs: ["@e1", "@e2", "@e3"],
        links: [
          { text: "Callback URL", href: "https://example.com/callback" },
          { text: "Local admin", href: "http://127.0.0.1/admin" }
        ],
        hitTestable: true
      }]
    };
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      fetch: createFetch(),
      webSocketFactory: () => socket,
      resolveHostname: () => ["93.184.216.34"]
    });

    const navigation = await backend.navigate({ url: "https://example.com/apps", sessionId: "session-region" });
    await expect(backend.extract?.({
      sessionId: "session-region",
      regionRef: "@r1",
      identity: navigation.snapshot.identity,
      tabRef: navigation.snapshot.tab!.ref
    })).resolves.toMatchObject({
      links: [{ text: "Callback URL", href: "https://example.com/callback" }]
    });
    const clicked = await backend.click!({
      sessionId: "session-region",
      regionRef: "@r1",
      identity: navigation.snapshot.identity,
      tabRef: navigation.snapshot.tab!.ref
    });
    expect(clicked).toMatchObject({
      sessionId: "session-region",
      actionDelta: expect.objectContaining({
        outcome: "action-no-change",
        target: expect.objectContaining({ ref: "@r1" })
      })
    });
    await expect(backend.type?.({
      sessionId: "session-region",
      regionRef: "@r1",
      identity: clicked.identity,
      tabRef: clicked.tab!.ref,
      text: "not permitted"
    })).rejects.toThrow("visible regions are supported only for grounded click and extraction");
    await expect(backend.select?.({
      sessionId: "session-region",
      regionRef: "@r1",
      identity: clicked.identity,
      tabRef: clicked.tab!.ref,
      value: "not permitted"
    })).rejects.toThrow("visible regions are supported only for grounded click and extraction");

    const runtimeExpressions = socket.sent
      .filter((message) => message.method === "Runtime.evaluate")
      .map((message) => String(message.params?.expression));
    expect(runtimeExpressions.some((expression) => expression.includes("window.__estacodaRegions?.[0]"))).toBe(true);
    expect(runtimeExpressions.some((expression) => expression.includes(".click()"))).toBe(false);
    expect(socket.sent.filter((message) => message.method === "Input.dispatchMouseEvent")).toHaveLength(3);
  });

  it("resolves card-scoped semantic locators against the current identity", async () => {
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
    socket.snapshot = {
      ...socket.snapshot,
      text: "Externally changed",
      elements: [{ ref: "@e1", role: "button", name: "Open updated view" }]
    };

    await expect(backend.click?.({
      sessionId: "session-1",
      ref: "@e1",
      identity: navigation.snapshot.identity,
      tabRef: navigation.snapshot.tab!.ref
    })).rejects.toMatchObject({ reason: "stale-browser-ref", currentIdentity: expect.objectContaining({ actionRevision: navigation.snapshot.identity.actionRevision + 1 }) });
    await expect(backend.click?.({
      sessionId: "session-1",
      ref: "@e1",
      identity: { ...navigation.snapshot.identity, actionRevision: navigation.snapshot.identity.actionRevision + 1 },
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
      elements: [
        { ref: "@e1", role: "textbox", name: "Password" },
        { ref: "@e2", role: "button", name: "Help" },
      ]
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
      identity: navigation.snapshot.identity,
      tabRef: navigation.snapshot.tab!.ref
    });

    expect(destination).toMatchObject({
      type: "browser-field",
      sessionId: "session-1",
      ref: "@e1",
      identity: {
        documentEpoch: navigation.snapshot.identity.documentEpoch,
        actionRevision: navigation.snapshot.identity.actionRevision,
      },
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
    expect(afterDeliverySnapshot).not.toHaveProperty("title");
    expect(afterDeliverySnapshot).not.toHaveProperty("text");
    expect(afterDeliverySnapshot?.elements?.every((element) =>
      element.name === undefined && element.label === undefined && element.value === undefined
    )).toBe(true);
    await expect(backend.extract?.({
      sessionId: "session-1",
      ref: "@e1",
      identity: afterDeliverySnapshot!.identity,
      tabRef: afterDeliverySnapshot!.tab!.ref
    })).rejects.toMatchObject({ code: "sensitive-input-active" });
    await expect(backend.getImages?.({ sessionId: "session-1" })).resolves.toEqual([]);
    const protectedTabs = await backend.tabs?.({ sessionId: "session-1" });
    expect(protectedTabs?.tabs.every((tab) => tab.title === undefined && new URL(tab.url).pathname === "/")).toBe(true);
    await expect(backend.screenshot?.({ sessionId: "session-1" })).rejects.toMatchObject({
      code: "sensitive-input-active"
    });

    showAuthenticatedHome(socket);
    await backend.press?.({ sessionId: "session-1", key: "Enter" });
    await expect(backend.screenshot?.({ sessionId: "session-1" })).resolves.toMatchObject({
      observation: { captureScope: "viewport", sanitized: true }
    });
    await expect(backend.cdp?.({ sessionId: "session-1", method: "Browser.getVersion" })).resolves.toBeDefined();
    const restoredSnapshot = await backend.snapshot?.({ sessionId: "session-1" });
    await expect(backend.extract?.({
      sessionId: "session-1",
      ref: "@e1",
      identity: restoredSnapshot!.identity,
      tabRef: restoredSnapshot!.tab!.ref,
    })).resolves.toMatchObject({ text: "My profile" });
  });

  it("binds multiple protected fields from one unchanged browser form", async () => {
    const socket = new FakeCdpSocket();
    showCredentialLoginPage(socket);
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      fetch: createFetch(),
      webSocketFactory: () => socket,
      resolveHostname: () => ["93.184.216.34"]
    });
    const navigation = await backend.navigate({
      url: socket.snapshot.url,
      sessionId: "session-group"
    });
    const common = {
      sessionId: "session-group",
      identity: navigation.snapshot.identity,
      tabRef: navigation.snapshot.tab!.ref
    };
    const email = await backend.prepareProtectedField?.({ ...common, ref: "@e1" });
    const password = await backend.prepareProtectedField?.({ ...common, ref: "@e2" });

    await expect(backend.verifyProtectedField?.({
      destination: email!, kind: "account-identifier", phase: "before-collection"
    })).resolves.toEqual({ status: "verified" });
    await expect(backend.verifyProtectedField?.({
      destination: password!, kind: "password", phase: "before-collection"
    })).resolves.toEqual({ status: "verified" });
    await expect(backend.verifyProtectedField?.({
      destination: email!, kind: "account-identifier", phase: "before-delivery"
    })).resolves.toEqual({ status: "verified" });
    await expect(backend.verifyProtectedField?.({
      destination: password!, kind: "password", phase: "before-delivery"
    })).resolves.toEqual({ status: "verified" });

    const evaluatedObjects = socket.sent.filter((message) =>
      message.method === "Runtime.evaluate" && String(message.params?.expression).startsWith("window.__estacodaElements")
    );
    expect(evaluatedObjects).toHaveLength(2);
    expect(socket.sent.filter((message) =>
      message.method === "Runtime.evaluate" && message.params?.expression === "document"
    )).toHaveLength(1);
    await backend.releaseProtectedField?.(email!);
    await backend.releaseProtectedField?.(password!);
    await backend.releaseProtectedField?.(password!);
    const releasedObjectIds = socket.sent
      .filter((message) => message.method === "Runtime.releaseObject")
      .map((message) => message.params?.objectId);
    expect(releasedObjectIds).toHaveLength(3);
    expect(new Set(releasedObjectIds).size).toBe(3);
  });

  it("completes grouped credentials and OTP through prebound controls across identity changes", async () => {
    const socket = new FakeCdpSocket();
    showCredentialLoginPage(socket);
    const events: string[] = [];
    let credentialDeliveries = 0;
    socket.onProtectedDelivery = () => {
      events.push(`credential-delivery-${++credentialDeliveries}`);
      if (credentialDeliveries === 1) socket.snapshot.text = "Sign in details received";
    };
    socket.onProtectedSubmit = () => {
      events.push("login-submit");
      showOtpChallengePage(socket);
      socket.documentCurrent = false;
    };
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      fetch: createFetch(),
      webSocketFactory: () => socket,
      resolveHostname: () => ["93.184.216.34"],
      settling: { pollIntervalMs: 5, stableWindowMs: 10, minimumObservationMs: 10 },
    });
    const login = await backend.navigate({ url: socket.snapshot.url, sessionId: "session-full-auth" });
    const loginInput = {
      sessionId: "session-full-auth",
      identity: login.snapshot.identity,
      tabRef: login.snapshot.tab!.ref,
      submitRef: "@e3",
    };
    const email = await backend.prepareProtectedField?.({ ...loginInput, ref: "@e1" });
    const password = await backend.prepareProtectedField?.({ ...loginInput, ref: "@e2" });
    await backend.verifyProtectedField?.({ destination: email!, kind: "account-identifier", phase: "before-collection" });
    await backend.verifyProtectedField?.({ destination: password!, kind: "password", phase: "before-collection" });
    await backend.verifyProtectedField?.({ destination: email!, kind: "account-identifier", phase: "before-delivery" });
    await backend.verifyProtectedField?.({ destination: password!, kind: "password", phase: "before-delivery" });

    await backend.deliverProtectedField?.({
      destination: email!, kind: "account-identifier", value: new TextEncoder().encode("person@example.com"),
    });
    expect(events).toEqual(["credential-delivery-1"]);
    await backend.deliverProtectedField?.({
      destination: password!, kind: "password", value: new TextEncoder().encode("password-sentinel"),
    });
    const loginResult = backend.takeProtectedFieldDeliveryResult?.(password!);
    expect(events).toEqual(["credential-delivery-1", "credential-delivery-2", "login-submit"]);
    expect(loginResult).toMatchObject({
      submission: "clicked",
      documentChanged: true,
      challengeState: "departed",
      conditionMet: true,
      sensitiveInputActive: false,
      snapshot: { url: "https://accounts.example.com/challenge", title: "Verify account" },
    });
    expect(loginResult?.snapshot.elements).toEqual([
      expect.objectContaining({ ref: "@e1", name: "One-time code" }),
      expect.objectContaining({ ref: "@e2", name: "Authenticate" }),
    ]);
    expect(loginResult!.afterIdentity.actionRevision).toBeGreaterThan(login.snapshot.identity.actionRevision);
    await backend.releaseProtectedField?.(email!);
    await backend.releaseProtectedField?.(password!);

    socket.documentCurrent = true;
    socket.onProtectedDelivery = () => events.push("otp-delivery");
    socket.onProtectedSubmit = () => {
      events.push("authenticate-submit");
      showAuthenticatedHome(socket);
    };
    const otp = await backend.prepareProtectedField?.({
      sessionId: "session-full-auth",
      identity: loginResult!.snapshot.identity,
      tabRef: loginResult!.snapshot.tab!.ref,
      ref: "@e1",
      submitRef: "@e2",
    });
    await expect(backend.verifyProtectedField?.({
      destination: otp!, kind: "one-time-code", phase: "before-collection",
    })).resolves.toEqual({ status: "verified" });
    await backend.deliverProtectedField?.({
      destination: otp!, kind: "one-time-code", value: new TextEncoder().encode("123456"),
    });
    const otpResult = backend.takeProtectedFieldDeliveryResult?.(otp!);

    expect(events).toEqual([
      "credential-delivery-1",
      "credential-delivery-2",
      "login-submit",
      "otp-delivery",
      "authenticate-submit",
    ]);
    expect(otpResult).toMatchObject({
      submission: "clicked",
      documentChanged: true,
      challengeState: "departed",
      conditionMet: true,
      sensitiveInputActive: false,
      snapshot: { url: "https://accounts.example.com/home", title: "Account home" },
    });
    expect(JSON.stringify([loginResult, otpResult])).not.toContain("person@example.com");
    expect(JSON.stringify([loginResult, otpResult])).not.toContain("password-sentinel");
    expect(JSON.stringify([loginResult, otpResult])).not.toContain("123456");
  });

  it("settles protected authentication when submission replaces the document and the first observation fails", async () => {
    const socket = new FakeCdpSocket();
    showCredentialLoginPage(socket);
    socket.onProtectedSubmit = () => {
      showOtpChallengePage(socket);
      socket.emitMessage({
        method: "Page.frameNavigated",
        params: { frame: { id: "main-frame", loaderId: "challenge-loader", url: socket.snapshot.url } },
      });
      socket.failNextMethods.set("Runtime.evaluate", {
        remaining: 1,
        message: "Execution context was destroyed, most likely because of a navigation.",
      });
    };
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      fetch: createFetch(),
      webSocketFactory: () => socket,
      resolveHostname: () => ["93.184.216.34"],
      settling: { pollIntervalMs: 5, stableWindowMs: 10, minimumObservationMs: 10 },
    });
    await backend.navigate({ url: socket.snapshot.url, sessionId: "session-transient-transition" });
    socket.emitMessage({
      method: "Page.frameNavigated",
      params: { frame: { id: "main-frame", loaderId: "login-loader", url: socket.snapshot.url } },
    });
    const boundLogin = await backend.snapshot?.({ sessionId: "session-transient-transition" });
    const common = {
      sessionId: "session-transient-transition",
      identity: boundLogin!.identity,
      tabRef: boundLogin!.tab!.ref,
      submitRef: "@e3",
    };
    const email = await backend.prepareProtectedField?.({ ...common, ref: "@e1" });
    const password = await backend.prepareProtectedField?.({ ...common, ref: "@e2" });
    await backend.verifyProtectedField?.({ destination: email!, kind: "account-identifier", phase: "before-collection" });
    await backend.verifyProtectedField?.({ destination: password!, kind: "password", phase: "before-collection" });

    await backend.deliverProtectedField?.({
      destination: email!, kind: "account-identifier", value: new TextEncoder().encode("person@example.com"),
    });
    await backend.deliverProtectedField?.({
      destination: password!, kind: "password", value: new TextEncoder().encode("password-sentinel"),
    });
    const result = backend.takeProtectedFieldDeliveryResult?.(password!);

    expect(result).toMatchObject({
      submission: "clicked",
      documentChanged: true,
      challengeState: "departed",
      sensitiveInputActive: false,
      snapshot: {
        url: "https://accounts.example.com/challenge",
        title: "Verify account",
        elements: expect.arrayContaining([expect.objectContaining({ name: "One-time code" })]),
      },
    });
    expect(result!.afterIdentity.documentEpoch).toBeGreaterThan(email!.identity!.documentEpoch);
    expect(socket.sent.some((message) =>
      message.method === "Runtime.callFunctionOn" &&
      String(message.params?.functionDeclaration).includes("setter.call(this, '')")
    )).toBe(false);
    await backend.abortProtectedFieldGroup?.([email!, password!]);
    await backend.releaseProtectedField?.(email!);
    await backend.releaseProtectedField?.(password!);
    await expect(backend.screenshot?.({ sessionId: "session-transient-transition" }))
      .resolves.toMatchObject({ observation: { captureScope: "viewport", sanitized: true } });
  });

  it("binds, delivers, and submits a one-time-code challenge as one local transaction", async () => {
    const socket = new FakeCdpSocket();
    showOtpChallengePage(socket);
    const localTransactionEvents: string[] = [];
    socket.onProtectedDelivery = () => {
      localTransactionEvents.push("delivery");
    };
    socket.onProtectedSubmit = () => {
      localTransactionEvents.push("submit");
      showAuthenticatedHome(socket);
    };
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      fetch: createFetch(),
      webSocketFactory: () => socket,
      resolveHostname: () => ["93.184.216.34"],
      settling: { pollIntervalMs: 5, stableWindowMs: 10, minimumObservationMs: 10 }
    });
    const navigation = await backend.navigate({
      url: socket.snapshot.url,
      sessionId: "session-otp"
    });
    const destination = await backend.prepareProtectedField?.({
      sessionId: "session-otp",
      ref: "@e1",
      submitRef: "@e2",
      identity: navigation.snapshot.identity,
      tabRef: navigation.snapshot.tab!.ref
    });

    expect(destination).toMatchObject({
      ref: "@e1",
      submit: { ref: "@e2" },
      label: "Browser field with verified submit control \"Authenticate\" at https://accounts.example.com"
    });
    expect(destination).not.toHaveProperty("transactionId");
    await expect(backend.verifyProtectedField?.({
      destination: destination!,
      kind: "one-time-code",
      phase: "before-collection"
    })).resolves.toEqual({ status: "verified" });

    const secret = "123456";
    await backend.deliverProtectedField?.({
      destination: destination!,
      kind: "one-time-code",
      value: new TextEncoder().encode(secret)
    });
    expect(localTransactionEvents).toEqual(["delivery", "submit"]);
    await backend.releaseProtectedField?.(destination!);
    await backend.releaseProtectedField?.(destination!);
    const result = backend.takeProtectedFieldDeliveryResult?.(destination!);

    expect(result).toMatchObject({
      delivery: "delivered",
      submission: "clicked",
      challengeState: "departed",
      sensitiveInputActive: false,
      snapshot: { url: "https://accounts.example.com/home", title: "Account home" }
    });
    expect(result!.afterIdentity.actionRevision).toBeGreaterThanOrEqual(result!.beforeIdentity.actionRevision);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result).not.toHaveProperty("transactionId");
    expect(socket.sent.filter((message) =>
      message.method === "Runtime.callFunctionOn" &&
      String(message.params?.functionDeclaration).includes("this.click();")
    )).toHaveLength(1);
    const releasedObjectIds = socket.sent
      .filter((message) => message.method === "Runtime.releaseObject")
      .map((message) => message.params?.objectId);
    expect(releasedObjectIds).toHaveLength(3);
    expect(new Set(releasedObjectIds).size).toBe(3);
  });

  it("does not double-submit when protected code entry replaces the challenge", async () => {
    const socket = new FakeCdpSocket();
    showOtpChallengePage(socket);
    socket.onProtectedDelivery = () => {
      showAuthenticatedHome(socket, { documentChanged: false });
    };
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      fetch: createFetch(),
      webSocketFactory: () => socket,
      resolveHostname: () => ["93.184.216.34"],
      settling: { pollIntervalMs: 5, stableWindowMs: 10, minimumObservationMs: 10 }
    });
    const navigation = await backend.navigate({ url: socket.snapshot.url, sessionId: "session-auto-otp" });
    const destination = await backend.prepareProtectedField?.({
      sessionId: "session-auto-otp",
      ref: "@e1",
      submitRef: "@e2",
      identity: navigation.snapshot.identity,
      tabRef: navigation.snapshot.tab!.ref
    });
    await backend.verifyProtectedField?.({
      destination: destination!, kind: "one-time-code", phase: "before-collection"
    });

    await backend.deliverProtectedField?.({
      destination: destination!, kind: "one-time-code", value: new TextEncoder().encode("654321")
    });
    const result = backend.takeProtectedFieldDeliveryResult?.(destination!);

    expect(result).toMatchObject({
      submission: "automatic",
      documentChanged: false,
      challengeState: "departed",
      conditionMet: true,
      sensitiveInputActive: false,
      snapshot: {
        title: "Account home",
        elements: [expect.objectContaining({ ref: "@e1", name: "My profile" })],
      },
    });
    expect(socket.sent.some((message) =>
      message.method === "Runtime.callFunctionOn" &&
      String(message.params?.functionDeclaration).includes("this.click();")
    )).toBe(false);
    await backend.releaseProtectedField?.(destination!);
    await expect(backend.screenshot?.({ sessionId: "session-auto-otp" })).resolves.toMatchObject({
      observation: { captureScope: "viewport", sanitized: true }
    });
    await expect(backend.cdp?.({ sessionId: "session-auto-otp", method: "Browser.getVersion" })).resolves.toBeDefined();
    await expect(backend.extract?.({
      sessionId: "session-auto-otp",
      ref: "@e1",
      identity: result!.snapshot.identity,
      tabRef: result!.snapshot.tab!.ref,
    })).resolves.toMatchObject({ text: "My profile" });
  });

  it("clears partially delivered grouped values before releasing browser protection", async () => {
    const socket = new FakeCdpSocket();
    showCredentialLoginPage(socket);
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      fetch: createFetch(),
      webSocketFactory: () => socket,
      resolveHostname: () => ["93.184.216.34"],
    });
    const navigation = await backend.navigate({ url: socket.snapshot.url, sessionId: "session-partial-clear" });
    const common = {
      sessionId: "session-partial-clear",
      identity: navigation.snapshot.identity,
      tabRef: navigation.snapshot.tab!.ref,
      submitRef: "@e3",
    };
    const email = await backend.prepareProtectedField?.({ ...common, ref: "@e1" });
    const password = await backend.prepareProtectedField?.({ ...common, ref: "@e2" });
    await backend.verifyProtectedField?.({ destination: email!, kind: "account-identifier", phase: "before-collection" });
    await backend.verifyProtectedField?.({ destination: password!, kind: "password", phase: "before-collection" });
    await backend.deliverProtectedField?.({
      destination: email!, kind: "account-identifier", value: new TextEncoder().encode("person@example.com"),
    });

    await backend.abortProtectedFieldGroup?.([email!, password!]);
    await backend.releaseProtectedField?.(email!);
    await backend.releaseProtectedField?.(password!);

    expect(socket.sent.filter((message) =>
      message.method === "Runtime.callFunctionOn" &&
      String(message.params?.functionDeclaration).includes("setter.call(this, '')")
    )).toHaveLength(1);
    expect(socket.sent.filter((message) =>
      message.method === "Runtime.callFunctionOn" &&
      String(message.params?.functionDeclaration).includes("this.value === ''")
    )).toHaveLength(1);
    await expect(backend.screenshot?.({ sessionId: "session-partial-clear" })).resolves.toMatchObject({
      observation: { captureScope: "viewport", sanitized: true }
    });
    expect(socket.sent.some((message) =>
      message.method === "Runtime.callFunctionOn" && String(message.params?.functionDeclaration).includes("this.click();")
    )).toBe(false);
  });

  it("keeps the browser protected when failed-submission clearing cannot be verified", async () => {
    const socket = new FakeCdpSocket();
    showOtpChallengePage(socket);
    socket.onProtectedDelivery = () => {
      socket.protectedSubmitInspection.current = false;
      socket.protectedClearVerification = false;
    };
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      fetch: createFetch(),
      webSocketFactory: () => socket,
      resolveHostname: () => ["93.184.216.34"],
      settling: { pollIntervalMs: 5, stableWindowMs: 10, minimumObservationMs: 10 },
    });
    const navigation = await backend.navigate({ url: socket.snapshot.url, sessionId: "session-clear-blocked" });
    const destination = await backend.prepareProtectedField?.({
      sessionId: "session-clear-blocked",
      identity: navigation.snapshot.identity,
      tabRef: navigation.snapshot.tab!.ref,
      ref: "@e1",
      submitRef: "@e2",
    });
    await backend.verifyProtectedField?.({ destination: destination!, kind: "one-time-code", phase: "before-collection" });

    await expect(backend.deliverProtectedField?.({
      destination: destination!, kind: "one-time-code", value: new TextEncoder().encode("123456"),
    })).rejects.toMatchObject({
      code: "protected-field-clear-unverified",
      message: "Protected browser values could not be verified as cleared. The browser remains protected; review it locally before retrying.",
    });
    await expect(backend.releaseProtectedField?.(destination!)).rejects.toMatchObject({
      code: "protected-field-clear-unverified",
    });
    await expect(backend.screenshot?.({ sessionId: "session-clear-blocked" })).rejects.toMatchObject({
      code: "sensitive-input-active",
    });
    await expect(backend.cdp?.({ sessionId: "session-clear-blocked", method: "Browser.getVersion" })).rejects.toThrow(
      "Raw browser CDP access is blocked"
    );
    const protectedSnapshot = await backend.snapshot?.({ sessionId: "session-clear-blocked" });
    await expect(backend.extract?.({
      sessionId: "session-clear-blocked",
      ref: "@e1",
      identity: protectedSnapshot!.identity,
      tabRef: protectedSnapshot!.tab!.ref,
    })).rejects.toMatchObject({ code: "sensitive-input-active" });
    await backend.closeSession?.("session-clear-blocked");
  });

  it("verifiably clears delivered values after a failed protected submission", async () => {
    const socket = new FakeCdpSocket();
    showOtpChallengePage(socket);
    socket.onProtectedDelivery = () => {
      socket.protectedSubmitInspection.current = false;
    };
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      fetch: createFetch(),
      webSocketFactory: () => socket,
      resolveHostname: () => ["93.184.216.34"],
      settling: { pollIntervalMs: 5, stableWindowMs: 10, minimumObservationMs: 10 },
    });
    const navigation = await backend.navigate({ url: socket.snapshot.url, sessionId: "session-failed-submit-clear" });
    const destination = await backend.prepareProtectedField?.({
      sessionId: "session-failed-submit-clear",
      identity: navigation.snapshot.identity,
      tabRef: navigation.snapshot.tab!.ref,
      ref: "@e1",
      submitRef: "@e2",
    });
    await backend.verifyProtectedField?.({ destination: destination!, kind: "one-time-code", phase: "before-collection" });

    await backend.deliverProtectedField?.({
      destination: destination!, kind: "one-time-code", value: new TextEncoder().encode("123456"),
    });
    const result = backend.takeProtectedFieldDeliveryResult?.(destination!);
    await backend.releaseProtectedField?.(destination!);

    expect(result).toMatchObject({
      submission: "failed",
      documentChanged: false,
      challengeState: "still-present",
      conditionMet: true,
      sensitiveInputActive: false,
      snapshot: {
        elements: expect.arrayContaining([
          expect.objectContaining({ ref: "@e1", name: "One-time code" }),
        ]),
      },
    });
    expect(socket.sent.some((message) =>
      message.method === "Runtime.callFunctionOn" &&
      String(message.params?.functionDeclaration).includes("setter.call(this, '')")
    )).toBe(true);
    expect(socket.sent.some((message) =>
      message.method === "Runtime.callFunctionOn" &&
      String(message.params?.functionDeclaration).includes("this.value === ''")
    )).toBe(true);
    await expect(backend.screenshot?.({ sessionId: "session-failed-submit-clear" })).resolves.toMatchObject({
      observation: { captureScope: "viewport", sanitized: true }
    });
    await expect(backend.cdp?.({ sessionId: "session-failed-submit-clear", method: "Browser.getVersion" })).resolves.toBeDefined();
    await expect(backend.extract?.({
      sessionId: "session-failed-submit-clear",
      ref: "@e1",
      identity: result!.snapshot.identity,
      tabRef: result!.snapshot.tab!.ref,
    })).resolves.toMatchObject({ target: expect.objectContaining({ ref: "@e1" }) });
  });

  it("reverifies the prebound submit control and blocks delivery when it detaches", async () => {
    const socket = new FakeCdpSocket();
    showOtpChallengePage(socket);
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      fetch: createFetch(),
      webSocketFactory: () => socket,
      resolveHostname: () => ["93.184.216.34"]
    });
    const navigation = await backend.navigate({ url: socket.snapshot.url, sessionId: "session-detached-submit" });
    const destination = await backend.prepareProtectedField?.({
      sessionId: "session-detached-submit",
      ref: "@e1",
      submitRef: "@e2",
      identity: navigation.snapshot.identity,
      tabRef: navigation.snapshot.tab!.ref
    });
    socket.protectedSubmitInspection.semanticsMatch = false;
    await expect(backend.verifyProtectedField?.({
      destination: destination!, kind: "one-time-code", phase: "before-collection"
    })).resolves.toEqual({ status: "rejected", reason: "field-missing" });
    socket.protectedSubmitInspection.semanticsMatch = true;
    socket.protectedSubmitInspection.conflictCount = 2;
    await expect(backend.verifyProtectedField?.({
      destination: destination!, kind: "one-time-code", phase: "before-collection"
    })).resolves.toEqual({ status: "rejected", reason: "field-missing" });
    socket.protectedSubmitInspection.conflictCount = 1;
    await expect(backend.verifyProtectedField?.({
      destination: destination!, kind: "one-time-code", phase: "before-collection"
    })).resolves.toEqual({ status: "verified" });

    socket.protectedSubmitInspection.connected = false;
    await expect(backend.verifyProtectedField?.({
      destination: destination!, kind: "one-time-code", phase: "before-delivery"
    })).resolves.toEqual({ status: "rejected", reason: "field-replaced" });
    expect(socket.sent.some((message) =>
      message.method === "Runtime.callFunctionOn" &&
      String(message.params?.functionDeclaration).includes("protectedValue")
    )).toBe(false);
    await backend.releaseProtectedField?.(destination!);
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
      identity: navigation.snapshot.identity,
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
    await expect(backend.verifyProtectedField?.({
      destination: { ...base, tabRef: "@t999" },
      kind: "password",
      phase: "before-collection"
    })).resolves.toEqual({ status: "rejected", reason: "tab-mismatch" });

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
    await expect(backend.verifyProtectedField?.({
      destination: { ...base, tabRef: "@t999" },
      kind: "password",
      phase: "before-delivery"
    })).resolves.toEqual({ status: "rejected", reason: "tab-mismatch" });
    socket.snapshot.url = "https://attacker.example/redirect";
    await expect(backend.verifyProtectedField?.({
      destination: base,
      kind: "password",
      phase: "before-delivery"
    })).resolves.toEqual({ status: "rejected", reason: "origin-mismatch" });
    socket.snapshot.url = "https://accounts.example.com/login";
    socket.frameId = "replacement-main-frame";
    await expect(backend.verifyProtectedField?.({
      destination: base,
      kind: "password",
      phase: "before-delivery"
    })).resolves.toEqual({ status: "rejected", reason: "frame-mismatch" });
    socket.frameId = "main-frame";
    socket.documentCurrent = false;
    await expect(backend.verifyProtectedField?.({
      destination: base,
      kind: "password",
      phase: "before-delivery"
    })).resolves.toEqual({ status: "rejected", reason: "field-replaced" });
    socket.documentCurrent = true;
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
    page!.onNativeClick = () => {
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
      identity: navigation.snapshot.identity,
      tabRef: navigation.snapshot.tab!.ref,
      waitFor: { kind: "text", value: "React update complete" },
      waitTimeoutMs: 200
    });

    expect(result).toMatchObject({
      text: "React update complete",
      actionDelta: {
        outcome: "changed",
        beforeIdentity: expect.objectContaining({
          documentEpoch: navigation.snapshot.identity.documentEpoch,
          actionRevision: navigation.snapshot.identity.actionRevision,
        }),
        conditionMet: true,
        addedElements: [{ role: "button", name: "View product" }]
      }
    });
    expect(result!.identity.actionRevision).toBeGreaterThan(navigation.snapshot.identity.actionRevision);
  });

  it("dispatches native pointer input and reports a safe blocked popup without changing Chrome permissions", async () => {
    const sockets = createSocketFactory();
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      fetch: createFetch(),
      webSocketFactory: sockets.webSocketFactory,
      resolveHostname: () => ["93.184.216.34"],
      settling: { pollIntervalMs: 5, stableWindowMs: 10, minimumObservationMs: 20 }
    });
    const navigation = await backend.navigate({
      url: "https://example.com/apps",
      sessionId: "session-popup"
    });
    const page = sockets.pageSocket()!;
    page.onNativeClick = () => {
      page.emitMessage({
        method: "Page.windowOpen",
        params: {
          url: "https://example.com/connect?source=apps",
          windowName: "connect",
          windowFeatures: ["popup"],
          userGesture: true
        }
      });
    };

    const result = await backend.click?.({
      sessionId: "session-popup",
      ref: "@e1",
      identity: navigation.snapshot.identity,
      tabRef: navigation.snapshot.tab!.ref
    });

    expect(result?.actionDelta).toMatchObject({
      outcome: "popup-blocked",
      popup: {
        destination: "https://example.com/connect?source=apps",
        userGesture: true
      }
    });
    expect(page.sent.filter((message) => message.method === "Input.dispatchMouseEvent").map((message) =>
      message.params?.type)).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
    expect(page.sent.some((message) =>
      message.method === "Runtime.evaluate" && String(message.params?.expression).includes(".click()"))).toBe(false);
    expect(page.sent.some((message) => message.method.includes("Permission"))).toBe(false);
  });

  it("does not expose an unsafe blocked-popup destination", async () => {
    const sockets = createSocketFactory();
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      fetch: createFetch(),
      webSocketFactory: sockets.webSocketFactory,
      resolveHostname: () => ["93.184.216.34"],
      settling: { pollIntervalMs: 5, stableWindowMs: 10, minimumObservationMs: 20 }
    });
    const navigation = await backend.navigate({ url: "https://example.com/apps", sessionId: "session-unsafe-popup" });
    const page = sockets.pageSocket()!;
    page.onNativeClick = () => page.emitMessage({
      method: "Page.windowOpen",
      params: { url: "http://169.254.169.254/latest/meta-data", userGesture: true }
    });

    const result = await backend.click?.({
      sessionId: "session-unsafe-popup",
      ref: "@e1",
      identity: navigation.snapshot.identity,
      tabRef: navigation.snapshot.tab!.ref
    });

    expect(result?.actionDelta).toMatchObject({
      outcome: "popup-blocked",
      popup: { userGesture: true }
    });
    expect(result?.actionDelta?.popup).not.toHaveProperty("destination");
  });

  it("preserves a partially dispatched native click as unverified instead of inviting a retry", async () => {
    const sockets = createSocketFactory();
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      fetch: createFetch(),
      webSocketFactory: sockets.webSocketFactory,
      resolveHostname: () => ["93.184.216.34"],
      settling: { pollIntervalMs: 5, stableWindowMs: 10, minimumObservationMs: 20 }
    });
    const navigation = await backend.navigate({ url: "https://example.com/apps", sessionId: "session-partial-click" });
    const page = sockets.pageSocket()!;
    page.failNextMouseRelease = "CDP response lost after pointer press";

    const result = await backend.click?.({
      sessionId: "session-partial-click",
      ref: "@e1",
      identity: navigation.snapshot.identity,
      tabRef: navigation.snapshot.tab!.ref
    });

    expect(result?.actionDelta).toMatchObject({
      outcome: "dispatched-unverified",
      actionDispatched: true,
      settlementFailed: true
    });
    expect(page.sent.filter((message) =>
      message.method === "Input.dispatchMouseEvent" && message.params?.type === "mouseReleased")).toHaveLength(2);
  });

  it("rejects an invalid wait before dispatching click()", async () => {
    const sockets = createSocketFactory();
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      fetch: createFetch(),
      webSocketFactory: sockets.webSocketFactory,
      resolveHostname: () => ["93.184.216.34"]
    });
    const navigation = await backend.navigate({
      url: "https://example.com/start",
      sessionId: "session-invalid-wait"
    });
    const page = sockets.pageSocket()!;
    const clicksBefore = page.sent.filter((message) =>
      message.method === "Runtime.evaluate" &&
      typeof message.params?.expression === "string" &&
      message.params.expression.includes(".click()")
    ).length;

    await expect(backend.click?.({
      sessionId: "session-invalid-wait",
      ref: "@e1",
      identity: navigation.snapshot.identity,
      tabRef: navigation.snapshot.tab!.ref,
      waitFor: { kind: "url" } as never
    })).rejects.toThrow("URL wait text is required.");

    expect(page.sent.filter((message) =>
      message.method === "Runtime.evaluate" &&
      typeof message.params?.expression === "string" &&
      message.params.expression.includes(".click()")
    )).toHaveLength(clicksBefore);
  });

  it("returns the changed browser state when click settlement observation initially fails", async () => {
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
    await backend.navigate({
      url: "https://example.com/apps",
      sessionId: "session-settlement-failure"
    });
    const page = sockets.pageSocket()!;
    page.emitMessage({
      method: "Page.frameNavigated",
      params: {
        frame: {
          id: "main-frame",
          loaderId: "apps-page-loader",
          url: page.snapshot.url
        }
      }
    });
    const beforeClick = await backend.snapshot?.({ sessionId: "session-settlement-failure" });
    page.onNativeClick = () => {
      page.snapshot = {
        url: "https://example.com/apps/example/edit",
        title: "Edit app",
        text: "Edit app settings",
        elements: [{ ref: "@e1", role: "button", name: "Save" }]
      };
      page.emitMessage({
        method: "Page.frameNavigated",
        params: {
          frame: {
            id: "main-frame",
            loaderId: "edit-page-loader",
            url: page.snapshot.url
          }
        }
      });
      queueMicrotask(() => {
        page.failNextMethods.set("Runtime.evaluate", {
          remaining: 1,
          message: "Execution context was destroyed during navigation"
        });
      });
    };

    const result = await backend.click?.({
      sessionId: "session-settlement-failure",
      ref: "@e1",
      identity: beforeClick!.identity,
      tabRef: beforeClick!.tab!.ref,
      waitFor: { kind: "url", contains: "/edit" },
      waitTimeoutMs: 200
    });

    expect(result).toMatchObject({
      url: "https://example.com/apps/example/edit",
      actionDelta: {
        outcome: "dispatched-unverified",
        actionDispatched: true,
        settlementFailed: true,
        documentChangeObserved: true,
        stateObservation: "post-dispatch",
        url: {
          changed: true,
          before: "https://example.com/final",
          after: "https://example.com/apps/example/edit"
        }
      }
    });
    expect(result!.identity.documentEpoch).toBeGreaterThan(beforeClick!.identity.documentEpoch);
  });

  it("preflights current click targets structurally without activating them", async () => {
    const sockets = createSocketFactory();
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      fetch: createFetch(),
      webSocketFactory: sockets.webSocketFactory,
      resolveHostname: () => ["93.184.216.34"]
    });
    await backend.navigate({ url: "https://example.com/start", sessionId: "session-preflight" });
    const page = sockets.pageSocket()!;
    page.snapshot = {
      url: "https://example.com/start",
      title: "Actions",
      text: "Continue",
      elements: [{ ref: "@e1", role: "link", name: "Continue" }]
    };
    page.browserActionPreflight = {
      kind: "link",
      tag: "a",
      role: "link",
      label: "Continue token=secret-value",
      href: "https://example.com/next?token=secret-value",
      formAssociated: false,
      submit: false
    };
    const current = await backend.snapshot?.({ sessionId: "session-preflight" });

    const beforeClicks = page.sent.filter((message) =>
      message.method === "Runtime.evaluate" && String(message.params?.expression).includes(".click()")
    ).length;
    const result = await backend.preflightAction?.("click", {
      sessionId: "session-preflight",
      ref: "@e1",
      identity: current!.identity,
      tabRef: current!.tab!.ref
    });

    expect(result).toMatchObject({
      action: "click",
      sessionId: "session-preflight",
      url: "https://example.com/start",
      target: {
        ref: "@e1",
        kind: "link",
        tag: "a",
        role: "link",
        label: "Continue token=[REDACTED]",
        href: "[REDACTED_URL_WITH_SECRET]",
        formAssociated: false,
        submit: false
      }
    });
    expect(page.sent.filter((message) =>
      message.method === "Runtime.evaluate" && String(message.params?.expression).includes(".click()")
    )).toHaveLength(beforeClicks);
  });

  it("resolves a one-use screenshot coordinate only to a current grounded target and expires it on viewport change", async () => {
    const sockets = createSocketFactory();
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      fetch: createFetch(),
      webSocketFactory: sockets.webSocketFactory,
      resolveHostname: () => ["93.184.216.34"]
    });
    await backend.navigate({ url: "https://example.com/start", sessionId: "session-visual-target" });
    const page = sockets.pageSocket()!;
    const first = await backend.screenshot?.({ sessionId: "session-visual-target" });

    await expect(backend.preflightAction?.("click", {
      sessionId: "session-visual-target",
      visualTarget: { screenshotId: first!.observation!.screenshotId, x: 8, y: 8 }
    })).resolves.toMatchObject({
      action: "click",
      target: { ref: "@e1", kind: "button" }
    });
    await expect(backend.preflightAction?.("click", {
      sessionId: "session-visual-target",
      visualTarget: { screenshotId: first!.observation!.screenshotId, x: 8, y: 8 }
    })).rejects.toThrow(/expired/u);

    const second = await backend.screenshot?.({ sessionId: "session-visual-target" });
    page.visualSurface.scrollY = 20;
    await expect(backend.preflightAction?.("click", {
      sessionId: "session-visual-target",
      visualTarget: { screenshotId: second!.observation!.screenshotId, x: 8, y: 8 }
    })).rejects.toThrow(/scrolling, resizing, or a DOM change/u);
  });

  it("rejects a target that becomes non-interactable during security preflight", async () => {
    const sockets = createSocketFactory();
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      fetch: createFetch(),
      webSocketFactory: sockets.webSocketFactory,
      resolveHostname: () => ["93.184.216.34"]
    });
    await backend.navigate({ url: "https://example.com/start", sessionId: "session-blocked-preflight" });
    const page = sockets.pageSocket()!;
    page.browserActionPreflight = {
      kind: "button",
      tag: "button",
      role: "button",
      label: "Continue",
      formAssociated: false,
      submit: false,
      interactable: false,
      interactabilityReason: "modal-blocked"
    };
    const current = await backend.snapshot?.({ sessionId: "session-blocked-preflight" });

    await expect(backend.preflightAction?.("click", {
      sessionId: "session-blocked-preflight",
      ref: "@e1",
      identity: current!.identity,
      tabRef: current!.tab!.ref
    })).rejects.toThrow(/not interactable \(modal-blocked\)/u);
  });

  it("rechecks interactability immediately before dispatch when the DOM changes", async () => {
    const sockets = createSocketFactory();
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      fetch: createFetch(),
      webSocketFactory: sockets.webSocketFactory,
      resolveHostname: () => ["93.184.216.34"]
    });
    const navigation = await backend.navigate({ url: "https://example.com/start", sessionId: "session-action-race" });
    const page = sockets.pageSocket()!;
    page.rejectBrowserActions = true;

    await expect(backend.click?.({
      sessionId: "session-action-race",
      ref: "@e1",
      identity: navigation.snapshot.identity,
      tabRef: navigation.snapshot.tab!.ref
    })).rejects.toThrow(/final interactability validation/u);
  });

  it("dispatches a reviewed key only while its exact focused target remains bound", async () => {
    const sockets = createSocketFactory();
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      fetch: createFetch(),
      webSocketFactory: sockets.webSocketFactory,
      resolveHostname: () => ["93.184.216.34"]
    });
    await backend.navigate({ url: "https://example.com/form", sessionId: "session-bound-press" });
    const page = sockets.pageSocket()!;
    page.snapshot = {
      url: "https://example.com/form",
      title: "Form",
      text: "Email",
      elements: [{ ref: "@e1", role: "textbox", name: "Email" }]
    };
    page.browserActionPreflight = {
      ref: "@e1",
      kind: "form-control",
      tag: "input",
      role: "textbox",
      label: "Email",
      formAssociated: true,
      submit: false
    };
    const current = await backend.snapshot?.({ sessionId: "session-bound-press" });

    await expect(backend.press?.({
      sessionId: "session-bound-press",
      ref: "@e1",
      identity: current!.identity,
      tabRef: current!.tab!.ref,
      key: "Enter"
    })).resolves.toMatchObject({ sessionId: "session-bound-press" });
    expect(page.sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "Input.dispatchKeyEvent", params: { type: "keyDown", key: "Enter" } }),
      expect.objectContaining({ method: "Input.dispatchKeyEvent", params: { type: "keyUp", key: "Enter" } })
    ]));

    const dispatchedBeforeMismatch = page.sent.filter((message) => message.method === "Input.dispatchKeyEvent").length;
    page.browserActionPreflight = {
      ...page.browserActionPreflight,
      ref: "@e2",
      label: "Other field"
    };
    await expect(backend.press?.({
      sessionId: "session-bound-press",
      ref: "@e1",
      identity: (await backend.snapshot?.({ sessionId: "session-bound-press" }))!.identity,
      tabRef: current!.tab!.ref,
      key: "Enter"
    })).rejects.toMatchObject({ reason: "browser-target-not-found" });
    expect(page.sent.filter((message) => message.method === "Input.dispatchKeyEvent")).toHaveLength(dispatchedBeforeMismatch);
  });

  it("accepts only the exact browser dialog bound during security review", async () => {
    const sockets = createSocketFactory();
    const backend = createSupervisedLocalCdpBrowserBackend({
      cdpUrl: "http://127.0.0.1:9222",
      fetch: createFetch(),
      webSocketFactory: sockets.webSocketFactory,
      resolveHostname: () => ["93.184.216.34"]
    });
    await backend.navigate({ url: "https://example.com/dialog", sessionId: "session-bound-dialog" });
    const page = sockets.pageSocket()!;
    page.snapshot = {
      url: "https://example.com/dialog",
      title: "Dialog",
      text: "Confirm",
      elements: []
    };
    page.emitMessage({
      method: "Page.javascriptDialogOpening",
      params: { type: "confirm", message: "Continue?" }
    });
    const current = await backend.snapshot?.({ sessionId: "session-bound-dialog" });

    await expect(backend.dialog?.({
      sessionId: "session-bound-dialog",
      ref: "dialog-1",
      identity: current!.identity,
      tabRef: current!.tab!.ref,
      action: "accept"
    })).resolves.toMatchObject({ sessionId: "session-bound-dialog" });
    expect(page.sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ method: "Page.handleJavaScriptDialog", params: { accept: true, promptText: "" } })
    ]));

    const dispatchedBeforeMismatch = page.sent.filter((message) => message.method === "Page.handleJavaScriptDialog").length;
    page.emitMessage({ method: "Page.javascriptDialogClosed", params: {} });
    await expect(backend.dialog?.({
      sessionId: "session-bound-dialog",
      ref: "dialog-1",
      identity: (await backend.snapshot?.({ sessionId: "session-bound-dialog" }))!.identity,
      tabRef: current!.tab!.ref,
      action: "accept"
    })).rejects.toMatchObject({ reason: "browser-target-not-found" });
    expect(page.sent.filter((message) => message.method === "Page.handleJavaScriptDialog")).toHaveLength(dispatchedBeforeMismatch);
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
      send: vi.fn(async (method: string) => method === "Runtime.evaluate"
        ? { result: { value: { x: 48, y: 24 } } }
        : {}),
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
      observeSnapshot: createSnapshotObserver(),
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
      identity: navigation.snapshot.identity,
      tabRef: navigation.snapshot.tab!.ref
    });

    expect(sessionManager.switchTab).toHaveBeenCalledWith("session-1", "@t2");
    expect(result).toMatchObject({
      url: detailSnapshot.url,
      title: "Loans",
      tab: { ref: "@t2", controlled: true },
      openedTabs: [{ ref: "@t2", controlled: true }],
      actionDelta: {
        outcome: "new-tab-opened",
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
      observeSnapshot: createSnapshotObserver(),
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
      observeSnapshot: createSnapshotObserver(),
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
      identity: navigation.snapshot.identity,
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
      identity: navigation.snapshot.identity,
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
