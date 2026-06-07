import type { BrowserActionInput, BrowserBackend, BrowserBackendStatus, BrowserConsoleEntry, BrowserNavigateInput, BrowserNavigateResult, BrowserScreenshotResult, BrowserSnapshot } from "../contracts/browser.js";
import type { LoadedRuntimeConfig } from "../config/runtime-config.js";
import { connectCdp, type CdpClient, type CdpFetchLike, type CdpWebSocketFactory } from "./cdp-client.js";
import { evaluateCdpSnapshot } from "./cdp-supervisor.js";
import { registerDefaultBrowserProviders, selectBrowserProvider } from "./browser-registry.js";
import { createSupervisedLocalCdpBrowserBackend } from "./supervised-local-cdp-backend.js";
import { createBrowserbaseBrowserBackend, type BrowserbaseBrowserBackendOptions } from "./browser-providers/browserbase-provider.js";
import { classifyBrowserUrl, type HybridClassificationResult } from "./hybrid-classifier.js";
import { decideBrowserRoute, type BrowserRouteDecision } from "./hybrid-router.js";
import type { ResolveHostnameFn } from "./url-safety.js";

export type { CdpFetchLike, CdpWebSocketEvent, CdpWebSocketFactory, CdpWebSocketLike } from "./cdp-client.js";

export type UnconfiguredBrowserBackendOptions = {
  reason?: string;
};

export function createUnconfiguredBrowserBackend(options: UnconfiguredBrowserBackendOptions = {}): BrowserBackend {
  return {
    kind: "unconfigured",
    isAvailable: () => false,
    status: () => ({
      backend: "unconfigured",
      available: false,
      reason: options.reason ?? "No browser backend is configured."
    }),
    async navigate(input: BrowserNavigateInput): Promise<BrowserNavigateResult> {
      throw new Error(options.reason ?? `No browser backend is configured for ${input.url}.`);
    }
  };
}

export function createMockBrowserBackend(input: {
  sessionId?: string;
  title?: string;
  text?: string;
} = {}): BrowserBackend {
  const sessionId = input.sessionId ?? "mock-browser-session";
  const snapshot = (url = "mock://browser"): BrowserSnapshot => ({
    sessionId,
    url,
    title: input.title ?? "Mock Browser Page",
    text: input.text ?? `Mock browser snapshot for ${url}.`,
    elements: [{ ref: "@e1", role: "button", name: "Mock Button" }]
  });

  return {
    kind: "mock",
    isAvailable: () => true,
    status: () => ({
      backend: "mock",
      available: true,
      browser: input.title ?? "Mock Browser"
    }),
    async navigate(request) {
      return {
        session: {
          id: request.sessionId ?? sessionId,
          backend: "mock",
          currentUrl: request.url,
          createdAt: new Date("2026-04-18T00:00:00.000Z").toISOString()
        },
        snapshot: snapshot(request.url)
      };
    },
    snapshot: async () => snapshot(),
    click: async () => snapshot(),
    type: async () => snapshot(),
    scroll: async () => snapshot(),
    press: async () => snapshot(),
    back: async () => snapshot(),
    getImages: async () => [{ src: "https://example.com/mock.png", alt: "Mock image" }],
    console: async () => [{ level: "log", text: "Mock console entry", timestamp: "2026-04-18T00:00:00.000Z" }],
    cdp: async (request) => ({ method: request.method ?? "Mock.method", params: request.params ?? {} }),
    screenshot: async () => ({
      mimeType: "image/png",
      base64: "iVBORw0KGgo="
    }),
    dialog: async () => snapshot()
  };
}

export type LocalCdpBrowserBackendOptions = {
  cdpUrl?: string;
  launchCommand?: string;
  launchExecutable?: string;
  launchArgs?: string[];
  chromeFlags?: string[];
  autoLaunch?: boolean;
  fetch?: CdpFetchLike;
  webSocketFactory?: CdpWebSocketFactory;
};

export function createLocalCdpBrowserBackend(options: LocalCdpBrowserBackendOptions = {}): BrowserBackend {
  const endpoint = normalizeCdpUrl(options.cdpUrl);
  const sessions = new Map<string, {
    id: string;
    webSocketDebuggerUrl: string;
  }>();
  let latestSessionId: string | undefined;

  return {
    kind: "local-cdp",
    isAvailable: async () => (await checkLocalCdpStatus(endpoint, options.fetch)).available,
    status: () => checkLocalCdpStatus(endpoint, options.fetch),
    async navigate(input) {
      return navigateWithLocalCdp({
        endpoint,
        input,
        fetch: options.fetch,
        webSocketFactory: options.webSocketFactory,
        sessions,
        setLatestSessionId: (sessionId) => {
          latestSessionId = sessionId;
        }
      });
    },
    snapshot: (input) => runCdpSessionAction({
      sessions,
      latestSessionId,
      input,
      webSocketFactory: options.webSocketFactory,
      action: async (client, sessionId) => evaluateCdpSnapshot(client, sessionId)
    }),
    click: (input) => runCdpSessionAction({
      sessions,
      latestSessionId,
      input,
      webSocketFactory: options.webSocketFactory,
      action: async (client, sessionId) => {
        await client.send("Runtime.evaluate", {
          expression: refActionExpression(input.ref, "click"),
          awaitPromise: true
        });
        return evaluateCdpSnapshot(client, sessionId);
      }
    }),
    type: (input) => runCdpSessionAction({
      sessions,
      latestSessionId,
      input,
      webSocketFactory: options.webSocketFactory,
      action: async (client, sessionId) => {
        await client.send("Runtime.evaluate", {
          expression: refActionExpression(input.ref, "type", input.text ?? ""),
          awaitPromise: true
        });
        return evaluateCdpSnapshot(client, sessionId);
      }
    }),
    scroll: (input) => runCdpSessionAction({
      sessions,
      latestSessionId,
      input,
      webSocketFactory: options.webSocketFactory,
      action: async (client, sessionId) => {
        const amount = input.amount ?? 700;
        const delta = input.direction === "up" ? -amount : amount;
        await client.send("Runtime.evaluate", {
          expression: `window.scrollBy(0, ${JSON.stringify(delta)}); "ok";`,
          returnByValue: true
        });
        return evaluateCdpSnapshot(client, sessionId);
      }
    }),
    press: (input) => runCdpSessionAction({
      sessions,
      latestSessionId,
      input,
      webSocketFactory: options.webSocketFactory,
      action: async (client, sessionId) => {
        const key = input.key ?? "Enter";
        await client.send("Input.dispatchKeyEvent", { type: "keyDown", key });
        await client.send("Input.dispatchKeyEvent", { type: "keyUp", key });
        return evaluateCdpSnapshot(client, sessionId);
      }
    }),
    back: (input = {}) => runCdpSessionAction({
      sessions,
      latestSessionId,
      input,
      webSocketFactory: options.webSocketFactory,
      action: async (client, sessionId) => {
        await client.send("Runtime.evaluate", {
          expression: "history.back(); 'ok';",
          returnByValue: true
        });
        await client.waitFor("Page.loadEventFired", 2_000).catch(() => undefined);
        return evaluateCdpSnapshot(client, sessionId);
      }
    }),
    getImages: (input = {}) => runCdpSessionAction({
      sessions,
      latestSessionId,
      input,
      webSocketFactory: options.webSocketFactory,
      action: async (client) => {
        const evaluated = await client.send("Runtime.evaluate", {
          expression: "JSON.stringify(Array.from(document.images).slice(0, 100).map((img) => ({ src: img.currentSrc || img.src, alt: img.alt || undefined })))",
          returnByValue: true
        }) as { result?: { value?: unknown } };
        return parseJsonArray(evaluated.result?.value);
      }
    }),
    console: (input = {}) => runCdpSessionAction({
      sessions,
      latestSessionId,
      input,
      webSocketFactory: options.webSocketFactory,
      action: async (client) => {
        await ensureConsoleCapture(client);
        const evaluated = await client.send("Runtime.evaluate", {
          expression: `(() => {
            const logs = Array.isArray(window.__estacodaConsoleLogs) ? window.__estacodaConsoleLogs : [];
            ${input.clear === true ? "window.__estacodaConsoleLogs = [];" : ""}
            return JSON.stringify(logs.slice(-200));
          })()`,
          returnByValue: true
        }) as { result?: { value?: unknown } };
        return parseConsoleEntries(evaluated.result?.value);
      }
    }),
    cdp: (input) => runCdpSessionAction({
      sessions,
      latestSessionId,
      input,
      webSocketFactory: options.webSocketFactory,
      action: async (client) => {
        if (input.method === undefined || input.method.trim().length === 0) {
          throw new Error("browser.cdp requires a CDP method.");
        }
        return await client.send(input.method, input.params);
      }
    }),
    screenshot: (input = {}) => runCdpSessionAction({
      sessions,
      latestSessionId,
      input,
      webSocketFactory: options.webSocketFactory,
      action: async (client) => {
        const result = await client.send("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: true
        }) as { data?: unknown };
        if (typeof result.data !== "string") {
          throw new Error("CDP screenshot did not return image data.");
        }
        return {
          mimeType: "image/png",
          base64: result.data
        } satisfies BrowserScreenshotResult;
      }
    }),
    dialog: (input = {}) => runCdpSessionAction({
      sessions,
      latestSessionId,
      input,
      webSocketFactory: options.webSocketFactory,
      action: async (client, sessionId) => {
        await client.send("Page.handleJavaScriptDialog", {
          accept: input.action !== "dismiss",
          promptText: input.promptText ?? ""
        });
        return evaluateCdpSnapshot(client, sessionId);
      }
    })
  };
}

async function runCdpSessionAction<T>(input: {
  sessions: Map<string, { id: string; webSocketDebuggerUrl: string }>;
  latestSessionId: string | undefined;
  input: BrowserActionInput | undefined;
  webSocketFactory: CdpWebSocketFactory | undefined;
  action(client: CdpClient, sessionId: string): Promise<T>;
}): Promise<T> {
  const sessionId = input.input?.sessionId ?? input.latestSessionId;
  if (sessionId === undefined) {
    throw new Error("No active browser session. Call browser.navigate first.");
  }
  const session = input.sessions.get(sessionId);
  if (session === undefined) {
    throw new Error(`Browser session not found: ${sessionId}`);
  }
  const client = await connectCdp({
    webSocketUrl: session.webSocketDebuggerUrl,
    webSocketFactory: input.webSocketFactory
  });
  try {
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await ensureConsoleCapture(client);
    return await input.action(client, session.id);
  } finally {
    client.close();
  }
}

async function ensureConsoleCapture(client: CdpClient): Promise<void> {
  await client.send("Runtime.evaluate", {
    expression: `(() => {
      if (window.__estacodaConsoleInstalled) return 'already-installed';
      window.__estacodaConsoleInstalled = true;
      window.__estacodaConsoleLogs = window.__estacodaConsoleLogs || [];
      for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
        const original = console[level]?.bind(console);
        if (!original) continue;
        console[level] = (...args) => {
          try {
            window.__estacodaConsoleLogs.push({
              level,
              text: args.map((arg) => {
                if (typeof arg === 'string') return arg;
                try { return JSON.stringify(arg); } catch { return String(arg); }
              }).join(' '),
              timestamp: new Date().toISOString()
            });
          } catch {}
          return original(...args);
        };
      }
      return 'installed';
    })()`,
    returnByValue: true
  });
}

function refActionExpression(ref: string | undefined, action: "click" | "type", text = ""): string {
  const index = refToIndex(ref);
  if (action === "click") {
    return `(() => { const el = window.__estacodaElements?.[${index}]; if (!el) throw new Error('Browser element ref not found: ${ref ?? ""}'); el.click(); return 'clicked'; })()`;
  }
  return `(() => { const el = window.__estacodaElements?.[${index}]; if (!el) throw new Error('Browser element ref not found: ${ref ?? ""}'); el.focus(); el.value = ${JSON.stringify(text)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return 'typed'; })()`;
}

function refToIndex(ref: string | undefined): number {
  const match = /^@?e(\d+)$/u.exec(ref ?? "");
  if (match === null) {
    throw new Error(`Invalid browser element ref: ${ref ?? ""}`);
  }
  return Number(match[1]) - 1;
}

function parseJsonArray(value: unknown): Array<{ src: string; alt?: string }> {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as Array<{ src?: string; alt?: string }>;
    return parsed.flatMap((entry) => entry.src === undefined ? [] : [{ src: entry.src, alt: entry.alt }]);
  } catch {
    return [];
  }
}

function parseConsoleEntries(value: unknown): BrowserConsoleEntry[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as Array<Partial<BrowserConsoleEntry>>;
    return parsed.map((entry) => ({
      level: entry.level ?? "log",
      text: entry.text ?? "",
      timestamp: entry.timestamp
    }));
  } catch {
    return [];
  }
}

async function navigateWithLocalCdp(input: {
  endpoint: string | undefined;
  input: BrowserNavigateInput;
  fetch: CdpFetchLike | undefined;
  webSocketFactory: CdpWebSocketFactory | undefined;
  sessions: Map<string, { id: string; webSocketDebuggerUrl: string }>;
  setLatestSessionId(sessionId: string): void;
}): Promise<BrowserNavigateResult> {
  if (input.endpoint === undefined) {
    throw new Error("CDP URL is not configured.");
  }

  const target = await createCdpTarget({
    endpoint: input.endpoint,
    url: input.input.url,
    fetch: input.fetch
  });
  const client = await connectCdp({
    webSocketUrl: target.webSocketDebuggerUrl,
    webSocketFactory: input.webSocketFactory
  });

  try {
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await ensureConsoleCapture(client);
    await client.send("Page.navigate", {
      url: input.input.url
    });
    await client.waitFor("Page.loadEventFired", 5_000).catch(() => undefined);

    const sessionId = input.input.sessionId ?? target.id ?? `cdp-${Date.now()}`;
    const snapshot = await evaluateCdpSnapshot(client, sessionId);
    input.sessions.set(sessionId, {
      id: sessionId,
      webSocketDebuggerUrl: target.webSocketDebuggerUrl
    });
    input.setLatestSessionId(sessionId);

    return {
      session: {
        id: sessionId,
        backend: "local-cdp",
        currentUrl: snapshot.url,
        createdAt: new Date().toISOString()
      },
      snapshot
    };
  } finally {
    client.close();
  }
}

async function createCdpTarget(input: {
  endpoint: string;
  url: string;
  fetch: CdpFetchLike | undefined;
}): Promise<{
  id?: string;
  url?: string;
  webSocketDebuggerUrl: string;
}> {
  const fetchLike = input.fetch ?? globalThis.fetch;
  const encodedUrl = encodeURIComponent(input.url);
  const created = await fetchLike(`${input.endpoint}/json/new?${encodedUrl}`, {
    method: "PUT"
  });

  if (created.ok) {
    const payload = await created.json() as {
      id?: string;
      url?: string;
      webSocketDebuggerUrl?: string;
    };

    if (payload.webSocketDebuggerUrl !== undefined) {
      return {
        id: payload.id,
        url: payload.url,
        webSocketDebuggerUrl: payload.webSocketDebuggerUrl
      };
    }
  }

  const listed = await fetchLike(`${input.endpoint}/json/list`, {
    method: "GET"
  });

  if (!listed.ok) {
    throw new Error(`CDP target discovery failed with ${listed.status} ${listed.statusText}`);
  }

  const targets = await listed.json() as Array<{
    id?: string;
    url?: string;
    type?: string;
    webSocketDebuggerUrl?: string;
  }>;
  const target = targets.find((candidate) => candidate.type === "page" && candidate.webSocketDebuggerUrl !== undefined)
    ?? targets.find((candidate) => candidate.webSocketDebuggerUrl !== undefined);

  if (target?.webSocketDebuggerUrl === undefined) {
    throw new Error("CDP target discovery did not return a debuggable page target.");
  }

  return {
    id: target.id,
    url: target.url,
    webSocketDebuggerUrl: target.webSocketDebuggerUrl
  };
}

async function checkLocalCdpStatus(endpoint: string | undefined, fetchLike: CdpFetchLike | undefined): Promise<BrowserBackendStatus> {
  if (endpoint === undefined) {
    return {
      backend: "local-cdp",
      available: false,
      reason: "CDP URL is not configured."
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);

  try {
    const response = await (fetchLike ?? globalThis.fetch)(`${endpoint}/json/version`, {
      method: "GET",
      signal: controller.signal
    });

    if (!response.ok) {
      return {
        backend: "local-cdp",
        available: false,
        endpoint,
        reason: `CDP endpoint returned ${response.status} ${response.statusText}`
      };
    }

    const payload = await response.json() as {
      Browser?: string;
      "Protocol-Version"?: string;
    };

    return {
      backend: "local-cdp",
      available: true,
      endpoint,
      browser: payload.Browser,
      version: payload["Protocol-Version"]
    };
  } catch (error) {
    return {
      backend: "local-cdp",
      available: false,
      endpoint,
      reason: error instanceof Error ? error.message : "CDP status check failed."
    };
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeCdpUrl(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }

  return value.trim().replace(/\/$/, "");
}

type ClosableBrowserBackend = BrowserBackend & {
  closeSession?: (sessionId: string) => void | Promise<void>;
  close?: () => void | Promise<void>;
};

type HybridRouteKind = Extract<BrowserRouteDecision["kind"], "cloud" | "local">;

type HybridSessionRoute = {
  route: HybridRouteKind;
  routedSessionId: string;
  reason: string;
};

export type HybridBrowserBackendOptions = {
  cloudBackend: ClosableBrowserBackend;
  localBackend: ClosableBrowserBackend;
  allowPrivateUrls: boolean;
  hybridRouting: boolean;
  resolveHostname?: ResolveHostnameFn;
};

export function createHybridBrowserBackend(options: HybridBrowserBackendOptions): BrowserBackend {
  const routesByBrowserKey = new Map<string, HybridSessionRoute>();
  let latestBrowserKey: string | undefined;
  let lastNavigationBackend: BrowserBackend["kind"] | undefined;
  let lastRouteReason: string | undefined;
  let closed = false;

  const classify = async (url: string): Promise<HybridClassificationResult> => classifyBrowserUrl(url, {
    resolveHostname: options.resolveHostname
  });

  const decide = (classification: HybridClassificationResult): BrowserRouteDecision => decideBrowserRoute(classification, {
    allowPrivateUrls: options.allowPrivateUrls,
    hybridRouting: options.hybridRouting,
    cloudProviderConfigured: true
  });

  const backendForRoute = (route: HybridRouteKind): ClosableBrowserBackend =>
    route === "cloud" ? options.cloudBackend : options.localBackend;

  const browserKeyForInput = (sessionId: string | undefined): string => {
    const key = sessionId ?? latestBrowserKey;
    if (key === undefined) {
      throw new Error("No active browser session. Call browser.navigate first.");
    }
    return key.endsWith("::local") ? key.slice(0, -"::local".length) : key;
  };

  const routedSessionIdFor = (browserKey: string, route: HybridRouteKind): string =>
    route === "local" ? `${browserKey}::local` : browserKey;

  const recordRoute = (browserKey: string, route: HybridRouteKind, reason: string): HybridSessionRoute => {
    const routedSessionId = routedSessionIdFor(browserKey, route);
    const sessionRoute = { route, routedSessionId, reason };
    routesByBrowserKey.set(browserKey, sessionRoute);
    latestBrowserKey = browserKey;
    lastRouteReason = reason;
    return sessionRoute;
  };

  const resolveActionRoute = (input: BrowserActionInput | undefined): HybridSessionRoute => {
    const browserKey = browserKeyForInput(input?.sessionId);
    const route = routesByBrowserKey.get(browserKey);
    if (route === undefined) {
      throw new Error(`Browser session not found: ${browserKey}`);
    }
    latestBrowserKey = browserKey;
    return route;
  };

  const closeRouteSession = async (browserKey: string, route: HybridRouteKind): Promise<void> => {
    const routedSessionId = routedSessionIdFor(browserKey, route);
    const backend = backendForRoute(route);
    if (backend.closeSession !== undefined) {
      await backend.closeSession(routedSessionId);
    }
    const current = routesByBrowserKey.get(browserKey);
    if (current?.route === route) {
      routesByBrowserKey.delete(browserKey);
    }
    if (latestBrowserKey === browserKey && !routesByBrowserKey.has(browserKey)) {
      latestBrowserKey = [...routesByBrowserKey.keys()].at(-1);
    }
  };

  const closeBothRouteSessions = async (browserKey: string): Promise<void> => {
    let firstError: unknown;
    for (const route of ["cloud", "local"] as const) {
      try {
        await closeRouteSession(browserKey, route);
      } catch (error) {
        firstError ??= error;
      }
    }
    routesByBrowserKey.delete(browserKey);
    if (firstError !== undefined) {
      throw firstError;
    }
  };

  const rewriteSnapshotSession = <T extends BrowserSnapshot>(snapshot: T, browserKey: string): T => ({
    ...snapshot,
    sessionId: browserKey
  });

  const actionInputForRoute = <T extends BrowserActionInput | undefined>(input: T, route: HybridSessionRoute): T =>
    input === undefined
      ? { sessionId: route.routedSessionId } as T
      : { ...input, sessionId: route.routedSessionId };

  const runSnapshotAction = async (
    input: BrowserActionInput | undefined,
    method: Exclude<keyof BrowserBackend, "kind" | "isAvailable" | "status" | "navigate">,
    displayName: string
  ): Promise<BrowserSnapshot> => {
    if (closed) {
      throw new Error("Hybrid browser backend is closed.");
    }
    const route = resolveActionRoute(input);
    const backend = backendForRoute(route.route);
    const action = backend[method] as ((actionInput?: BrowserActionInput) => Promise<BrowserSnapshot>) | undefined;
    if (action === undefined) {
      throw new Error(`Hybrid browser ${route.route} backend does not support ${displayName}.`);
    }
    const snapshot = await action(actionInputForRoute(input, route));
    return rewriteSnapshotSession(snapshot, browserKeyForInput(input?.sessionId));
  };

  const routeNavigation = async (input: BrowserNavigateInput): Promise<{
    browserKey: string;
    route: HybridSessionRoute;
    decision: BrowserRouteDecision;
  }> => {
    const classification = await classify(input.url);
    const decision = decide(classification);
    if (decision.kind === "invalid") {
      throw new Error(`Invalid browser URL: ${decision.reason}`);
    }
    if (decision.kind === "blocked") {
      throw new Error(`Blocked browser URL: ${decision.reason}`);
    }
    const browserKey = input.sessionId ?? latestBrowserKey ?? `browser-${Date.now()}`;
    return {
      browserKey,
      route: {
        route: decision.kind,
        routedSessionId: routedSessionIdFor(browserKey, decision.kind),
        reason: decision.reason
      },
      decision
    };
  };

  const validatePostNavigation = async (input: {
    browserKey: string;
    route: HybridSessionRoute;
    finalUrl: string | undefined;
  }): Promise<void> => {
    if (input.finalUrl === undefined || input.finalUrl.trim().length === 0) {
      return;
    }
    const classification = await classify(input.finalUrl);
    const decision = decide(classification);
    const unsafeCloudRedirect = input.route.route === "cloud" &&
      (classification.classification === "private-or-internal" ||
        classification.classification === "always-blocked" ||
        classification.classification === "invalid");
    const unsafeLocalRedirect = input.route.route === "local" &&
      (classification.classification === "always-blocked" || classification.classification === "invalid");
    if (!unsafeCloudRedirect && !unsafeLocalRedirect && decision.kind !== "blocked" && decision.kind !== "invalid") {
      return;
    }

    await closeRouteSession(input.browserKey, input.route.route).catch(() => undefined);
    throw new Error(`Browser redirect safety violation: ${decision.reason}`);
  };

  const backend: BrowserBackend = {
    kind: "browserbase",
    isAvailable: async () => (await options.cloudBackend.isAvailable()) || (await options.localBackend.isAvailable()),
    status: async () => {
      const cloudStatus = await options.cloudBackend.status();
      const localStatus = await options.localBackend.status();
      return {
        ...cloudStatus,
        backend: "browserbase",
        available: cloudStatus.available || localStatus.available,
        reason: cloudStatus.available || localStatus.available ? cloudStatus.reason : cloudStatus.reason ?? localStatus.reason,
        hybridRouting: options.hybridRouting,
        lastNavigationBackend,
        lastRouteReason
      };
    },
    async navigate(input) {
      if (closed) {
        throw new Error("Hybrid browser backend is closed.");
      }
      const { browserKey, route, decision } = await routeNavigation(input);
      const delegate = backendForRoute(route.route);
      const result = await delegate.navigate({
        ...input,
        sessionId: route.routedSessionId
      });
      await validatePostNavigation({
        browserKey,
        route,
        finalUrl: result.session.currentUrl ?? result.snapshot.url
      });

      recordRoute(browserKey, route.route, decision.reason);
      lastNavigationBackend = result.session.backend;
      lastRouteReason = decision.reason;
      return {
        ...result,
        session: {
          ...result.session,
          id: browserKey
        },
        snapshot: rewriteSnapshotSession(result.snapshot, browserKey),
        metadata: {
          ...(result.metadata ?? {}),
          route: route.route,
          routeReason: decision.reason,
          routedSessionId: route.routedSessionId,
          servedBackend: result.session.backend
        }
      };
    },
    snapshot: (input) => runSnapshotAction(input, "snapshot", "snapshot"),
    click: (input) => runSnapshotAction(input, "click", "click"),
    type: (input) => runSnapshotAction(input, "type", "type"),
    scroll: (input) => runSnapshotAction(input, "scroll", "scroll"),
    press: (input) => runSnapshotAction(input, "press", "press"),
    back: (input = {}) => runSnapshotAction(input, "back", "back"),
    getImages: async (input = {}) => {
      const route = resolveActionRoute(input);
      const method = backendForRoute(route.route).getImages;
      if (method === undefined) {
        throw new Error(`Hybrid browser ${route.route} backend does not support getImages.`);
      }
      return method(actionInputForRoute(input, route));
    },
    console: async (input = {}) => {
      const route = resolveActionRoute(input);
      const method = backendForRoute(route.route).console;
      if (method === undefined) {
        throw new Error(`Hybrid browser ${route.route} backend does not support console.`);
      }
      return method(actionInputForRoute(input, route));
    },
    cdp: async (input) => {
      const route = resolveActionRoute(input);
      const method = backendForRoute(route.route).cdp;
      if (method === undefined) {
        throw new Error(`Hybrid browser ${route.route} backend does not support cdp.`);
      }
      return method(actionInputForRoute(input, route));
    },
    screenshot: async (input = {}) => {
      const route = resolveActionRoute(input);
      const method = backendForRoute(route.route).screenshot;
      if (method === undefined) {
        throw new Error(`Hybrid browser ${route.route} backend does not support screenshot.`);
      }
      return method(actionInputForRoute(input, route));
    },
    dialog: (input = {}) => runSnapshotAction(input, "dialog", "dialog"),
    closeSession: closeBothRouteSessions,
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      let firstError: unknown;
      try {
        await options.cloudBackend.close?.();
      } catch (error) {
        firstError ??= error;
      }
      try {
        await options.localBackend.close?.();
      } catch (error) {
        firstError ??= error;
      }
      routesByBrowserKey.clear();
      latestBrowserKey = undefined;
      if (firstError !== undefined) {
        throw firstError;
      }
    }
  };

  return backend;
}

export function createBrowserBackendFromConfig(config: {
  backend: "local-cdp" | "browserbase" | "firecrawl" | "camofox" | "mock" | "unconfigured";
  cloudProvider?: string;
  cdpUrl?: string;
  launchCommand?: string;
  launchExecutable?: string;
  launchArgs?: string[];
  chromeFlags?: string[];
  autoLaunch?: boolean;
  hybridRouting?: boolean;
  cloudFallback?: boolean;
  cloudSpendApproved?: "pending" | boolean;
  fetch?: CdpFetchLike;
  webSocketFactory?: CdpWebSocketFactory;
  supervised?: boolean;
  securityConfig?: Pick<LoadedRuntimeConfig["security"], "allowPrivateUrls" | "websiteBlocklist">;
  resolveHostname?: ResolveHostnameFn;
  browserbase?: Pick<BrowserbaseBrowserBackendOptions, "apiKey" | "projectId" | "client" | "createClient" | "browserbaseFetch" | "createSupervisedBackend" | "log">;
}): BrowserBackend {
  if ((config.cloudProvider === "browserbase" || config.backend === "browserbase") && config.hybridRouting === true) {
    const localBackendOptions = {
      cdpUrl: config.cdpUrl,
      launchCommand: config.launchCommand,
      launchExecutable: config.launchExecutable,
      launchArgs: config.launchArgs,
      chromeFlags: config.chromeFlags,
      autoLaunch: config.autoLaunch,
      fetch: config.fetch,
      webSocketFactory: config.webSocketFactory,
      securityConfig: config.securityConfig,
      resolveHostname: config.resolveHostname
    };
    const cloudSecurityConfig = config.securityConfig === undefined
      ? undefined
      : {
        ...config.securityConfig,
        allowPrivateUrls: false
      };
    return createHybridBrowserBackend({
      cloudBackend: createBrowserbaseBrowserBackend({
        apiKey: config.browserbase?.apiKey,
        projectId: config.browserbase?.projectId,
        client: config.browserbase?.client,
        createClient: config.browserbase?.createClient,
        browserbaseFetch: config.browserbase?.browserbaseFetch,
        createSupervisedBackend: config.browserbase?.createSupervisedBackend,
        log: config.browserbase?.log,
        cloudSpendApproved: config.cloudSpendApproved,
        cloudFallback: config.cloudFallback,
        cdpUrl: config.cdpUrl,
        launchCommand: config.launchCommand,
        launchExecutable: config.launchExecutable,
        launchArgs: config.launchArgs,
        chromeFlags: config.chromeFlags,
        autoLaunch: config.autoLaunch,
        fetch: config.fetch,
        webSocketFactory: config.webSocketFactory,
        securityConfig: cloudSecurityConfig,
        resolveHostname: config.resolveHostname
      }),
      localBackend: config.browserbase?.createSupervisedBackend?.(localBackendOptions) ??
        createSupervisedLocalCdpBrowserBackend(localBackendOptions),
      allowPrivateUrls: config.securityConfig?.allowPrivateUrls === true,
      hybridRouting: true,
      resolveHostname: config.resolveHostname
    });
  }

  switch (config.backend) {
    case "local-cdp":
      if (config.supervised === true) {
        return createSupervisedLocalCdpBrowserBackend({
          cdpUrl: config.cdpUrl,
          launchCommand: config.launchCommand,
          launchExecutable: config.launchExecutable,
          launchArgs: config.launchArgs,
          chromeFlags: config.chromeFlags,
          autoLaunch: config.autoLaunch,
          fetch: config.fetch,
          webSocketFactory: config.webSocketFactory,
          securityConfig: config.securityConfig,
          resolveHostname: config.resolveHostname
        });
      }
      return createLocalCdpBrowserBackend({
        cdpUrl: config.cdpUrl,
        launchCommand: config.launchCommand,
        launchExecutable: config.launchExecutable,
        launchArgs: config.launchArgs,
        chromeFlags: config.chromeFlags,
        autoLaunch: config.autoLaunch,
        fetch: config.fetch,
        webSocketFactory: config.webSocketFactory
      });
    case "unconfigured":
      if (config.cloudProvider === "browserbase") {
        return createBrowserbaseBrowserBackend({
          apiKey: config.browserbase?.apiKey,
          projectId: config.browserbase?.projectId,
          client: config.browserbase?.client,
          createClient: config.browserbase?.createClient,
          browserbaseFetch: config.browserbase?.browserbaseFetch,
          createSupervisedBackend: config.browserbase?.createSupervisedBackend,
          log: config.browserbase?.log,
          cloudSpendApproved: config.cloudSpendApproved,
          cloudFallback: config.cloudFallback,
          cdpUrl: config.cdpUrl,
          launchCommand: config.launchCommand,
          launchExecutable: config.launchExecutable,
          launchArgs: config.launchArgs,
          chromeFlags: config.chromeFlags,
          autoLaunch: config.autoLaunch,
          fetch: config.fetch,
          webSocketFactory: config.webSocketFactory,
          securityConfig: config.securityConfig,
          resolveHostname: config.resolveHostname
        });
      }
      if (config.cloudProvider !== undefined) {
        return createCloudProviderStatusBackend({
          backend: "unconfigured",
          cloudProvider: config.cloudProvider
        });
      }
      return createUnconfiguredBrowserBackend();
    case "browserbase":
      return createBrowserbaseBrowserBackend({
        apiKey: config.browserbase?.apiKey,
        projectId: config.browserbase?.projectId,
        client: config.browserbase?.client,
        createClient: config.browserbase?.createClient,
        browserbaseFetch: config.browserbase?.browserbaseFetch,
        createSupervisedBackend: config.browserbase?.createSupervisedBackend,
        log: config.browserbase?.log,
        cloudSpendApproved: config.cloudSpendApproved,
        cloudFallback: config.cloudFallback,
        cdpUrl: config.cdpUrl,
        launchCommand: config.launchCommand,
        launchExecutable: config.launchExecutable,
        launchArgs: config.launchArgs,
        chromeFlags: config.chromeFlags,
        autoLaunch: config.autoLaunch,
        fetch: config.fetch,
        webSocketFactory: config.webSocketFactory,
        securityConfig: config.securityConfig,
        resolveHostname: config.resolveHostname
      });
    case "firecrawl":
    case "camofox":
      return createCloudProviderStatusBackend({
        backend: config.backend,
        cloudProvider: config.cloudProvider ?? config.backend
      });
    default:
      return createUnconfiguredBrowserBackend({
        reason: `${config.backend} browser backend is recognized but not implemented in this release.`
      });
  }
}

function createCloudProviderStatusBackend(config: {
  backend: "browserbase" | "firecrawl" | "camofox" | "unconfigured";
  cloudProvider: string;
}): BrowserBackend {
  registerDefaultBrowserProviders();

  const status = async (): Promise<BrowserBackendStatus> => {
    const selection = await selectBrowserProvider({
      backend: config.backend,
      cloudProvider: config.cloudProvider
    });
    const providerLabel = selection.providerName ?? config.cloudProvider;
    const reason = selection.availability.available
      ? `${providerLabel} browser provider is available, but cloud browser sessions are not implemented in this release.`
      : selection.availability.reason ?? `${providerLabel} browser provider is unavailable.`;

    return {
      backend: config.backend,
      available: false,
      reason
    };
  };

  return {
    kind: config.backend,
    isAvailable: async () => false,
    status,
    async navigate(input) {
      const current = await status();
      throw new Error(current.reason ?? `No cloud browser backend is configured for ${input.url}.`);
    }
  };
}
