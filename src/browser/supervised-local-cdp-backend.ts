import type {
  BrowserActionInput,
  BrowserBackend,
  BrowserConsoleEntry,
  BrowserBackendStatus,
  BrowserNavigateInput,
  BrowserNavigateResult,
  BrowserScreenshotResult
} from "../contracts/browser.js";
import type { LoadedRuntimeConfig } from "../config/runtime-config.js";
import type { CdpFetchLike, CdpWebSocketFactory } from "./cdp-client.js";
import type { ResolveHostnameFn } from "./url-safety.js";
import { CDPSupervisor } from "./cdp-supervisor.js";
import type { BrowserSessionLifecycle } from "./session-lifecycle.js";

export type SupervisedLocalCdpBackendOptions = {
  cdpUrl?: string;
  launchCommand?: string;
  autoLaunch?: boolean;
  fetch?: CdpFetchLike;
  webSocketFactory?: CdpWebSocketFactory;
  securityConfig?: Pick<LoadedRuntimeConfig["security"], "allowPrivateUrls" | "websiteBlocklist">;
  resolveHostname?: ResolveHostnameFn;
  lifecycle?: BrowserSessionLifecycle;
};

type SupervisedSession = {
  id: string;
  webSocketDebuggerUrl: string;
  supervisor: CDPSupervisor;
};

export function createSupervisedLocalCdpBrowserBackend(options: SupervisedLocalCdpBackendOptions = {}): BrowserBackend {
  const endpoint = normalizeCdpUrl(options.cdpUrl);
  const lifecycle = options.lifecycle;
  const sessions = new Map<string, SupervisedSession>();
  let latestSessionId: string | undefined;
  lifecycle?.start();

  const getSession = (input?: BrowserActionInput): SupervisedSession => {
    const sessionId = input?.sessionId ?? latestSessionId;
    if (sessionId === undefined) {
      throw new Error("No active browser session. Call browser.navigate first.");
    }
    const session = sessions.get(sessionId);
    if (session === undefined) {
      throw new Error(`Browser session not found: ${sessionId}`);
    }
    lifecycle?.touch(sessionId);
    return session;
  };

  const closeSession = (sessionId: string): void => {
    const session = sessions.get(sessionId);
    if (session === undefined) {
      lifecycle?.unregister(sessionId);
      return;
    }
    sessions.delete(sessionId);
    if (latestSessionId === sessionId) {
      latestSessionId = [...sessions.keys()].at(-1);
    }
    session.supervisor.close();
    lifecycle?.unregister(sessionId);
  };

  const backend: BrowserBackend & {
    closeSession(sessionId: string): void;
  } = {
    kind: "local-cdp",
    isAvailable: async () => (await checkLocalCdpStatus(endpoint, options.fetch)).available,
    status: () => checkLocalCdpStatus(endpoint, options.fetch),
    async navigate(input: BrowserNavigateInput): Promise<BrowserNavigateResult> {
      if (endpoint === undefined) {
        throw new Error("CDP URL is not configured.");
      }

      const target = await createCdpTarget({
        endpoint,
        url: input.url,
        fetch: options.fetch,
      });
      const sessionId = input.sessionId ?? target.id ?? `cdp-${Date.now()}`;
      const existing = sessions.get(sessionId);
      let createdSupervisor = false;
      const supervisor = existing?.webSocketDebuggerUrl === target.webSocketDebuggerUrl
        ? existing.supervisor
        : (() => {
          createdSupervisor = true;
          return new CDPSupervisor({
            webSocketUrl: target.webSocketDebuggerUrl,
            webSocketFactory: options.webSocketFactory,
            requestInterception: {
              allowPrivateUrls: options.securityConfig?.allowPrivateUrls,
              websiteBlocklist: options.securityConfig?.websiteBlocklist,
              resolveHostname: options.resolveHostname
            }
          });
        })();

      try {
        await supervisor.start();
        await supervisor.send("Page.navigate", { url: input.url });
        await supervisor.waitFor("Page.loadEventFired", 5_000).catch(() => undefined);

        const snapshot = await supervisor.getSnapshot(sessionId);
        if (existing !== undefined && existing.supervisor !== supervisor) {
          existing.supervisor.close();
        }
        sessions.set(sessionId, {
          id: sessionId,
          webSocketDebuggerUrl: target.webSocketDebuggerUrl,
          supervisor,
        });
        latestSessionId = sessionId;
        lifecycle?.register(sessionId, {
          backend: "local-cdp",
          webSocketDebuggerUrl: target.webSocketDebuggerUrl
        });
        lifecycle?.touch(sessionId);

        return {
          session: {
            id: sessionId,
            backend: "local-cdp",
            currentUrl: snapshot.url,
            createdAt: new Date().toISOString(),
          },
          snapshot,
        };
      } catch (error) {
        if (createdSupervisor) {
          supervisor.close();
        }
        throw error;
      }
    },
    snapshot: async (input) => {
      const session = getSession(input);
      return session.supervisor.getSnapshot(session.id);
    },
    click: async (input) => {
      const session = getSession(input);
      await session.supervisor.send("Runtime.evaluate", {
        expression: refActionExpression(input.ref, "click"),
        awaitPromise: true
      });
      return session.supervisor.getSnapshot(session.id);
    },
    type: async (input) => {
      const session = getSession(input);
      await session.supervisor.send("Runtime.evaluate", {
        expression: refActionExpression(input.ref, "type", input.text ?? ""),
        awaitPromise: true
      });
      return session.supervisor.getSnapshot(session.id);
    },
    scroll: async (input) => {
      const session = getSession(input);
      const amount = input.amount ?? 700;
      const delta = input.direction === "up" ? -amount : amount;
      await session.supervisor.send("Runtime.evaluate", {
        expression: `window.scrollBy(0, ${JSON.stringify(delta)}); "ok";`,
        returnByValue: true
      });
      return session.supervisor.getSnapshot(session.id);
    },
    press: async (input) => {
      const session = getSession(input);
      const key = input.key ?? "Enter";
      await session.supervisor.send("Input.dispatchKeyEvent", { type: "keyDown", key });
      await session.supervisor.send("Input.dispatchKeyEvent", { type: "keyUp", key });
      return session.supervisor.getSnapshot(session.id);
    },
    back: async (input = {}) => {
      const session = getSession(input);
      await session.supervisor.send("Runtime.evaluate", {
        expression: "history.back(); 'ok';",
        returnByValue: true
      });
      await session.supervisor.waitFor("Page.loadEventFired", 2_000).catch(() => undefined);
      return session.supervisor.getSnapshot(session.id);
    },
    getImages: async (input = {}) => {
      const session = getSession(input);
      const evaluated = await session.supervisor.send("Runtime.evaluate", {
        expression: "JSON.stringify(Array.from(document.images).slice(0, 100).map((img) => ({ src: img.currentSrc || img.src, alt: img.alt || undefined })))",
        returnByValue: true
      }) as { result?: { value?: unknown } };
      return parseJsonArray(evaluated.result?.value);
    },
    console: async (input = {}): Promise<BrowserConsoleEntry[]> => {
      const session = getSession(input);
      return session.supervisor.consoleHistory({ clear: input.clear });
    },
    cdp: async (input) => {
      const session = getSession(input);
      if (input.method === undefined || input.method.trim().length === 0) {
        throw new Error("browser.cdp requires a CDP method.");
      }
      return session.supervisor.send(input.method, input.params);
    },
    screenshot: async (input = {}) => {
      const session = getSession(input);
      const result = await session.supervisor.send("Page.captureScreenshot", {
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
    },
    dialog: async (input = {}) => {
      const session = getSession(input);
      await session.supervisor.respondToDialog({
        accept: input.action !== "dismiss",
        promptText: input.promptText
      });
      return session.supervisor.getSnapshot(session.id);
    },
    closeSession
  };

  return backend;
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
