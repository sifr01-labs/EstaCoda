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
import { connectCdp, type CdpFetchLike, type CdpWebSocketFactory } from "./cdp-client.js";
import type { ResolveHostnameFn } from "./url-safety.js";
import { CDPSupervisor } from "./cdp-supervisor.js";
import type { BrowserSessionLifecycle } from "./session-lifecycle.js";
import { findChromiumExecutable, type ChromiumFinderOptions, type ChromiumFinderResult } from "./chromium-finder.js";
import { launchChrome, type ChromeLauncherOptions, type LaunchedChrome } from "./chrome-launcher.js";
import { CdpTargetManager, type CdpTargetManagerOptions } from "./cdp-target-manager.js";
import { BrowserSessionManager, type BrowserManagedSession, type BrowserSessionManagerOptions } from "./session-manager.js";

export type SupervisedLocalCdpBackendOptions = {
  cdpUrl?: string;
  launchCommand?: string;
  launchExecutable?: string;
  launchArgs?: string[];
  chromeFlags?: string[];
  autoLaunch?: boolean;
  fetch?: CdpFetchLike;
  webSocketFactory?: CdpWebSocketFactory;
  securityConfig?: Pick<LoadedRuntimeConfig["security"], "allowPrivateUrls" | "websiteBlocklist">;
  resolveHostname?: ResolveHostnameFn;
  lifecycle?: BrowserSessionLifecycle;
  findChromiumExecutable?: (options?: ChromiumFinderOptions) => Promise<ChromiumFinderResult>;
  launchChrome?: (options: ChromeLauncherOptions) => Promise<LaunchedChrome>;
  createTargetManager?: (options: CdpTargetManagerOptions) => TargetManagerLike;
  createSessionManager?: (options: BrowserSessionManagerOptions) => BrowserSessionManagerLike;
};

type TargetManagerLike = Pick<CdpTargetManager, "createTarget" | "close">;

type BrowserSessionManagerLike = Pick<BrowserSessionManager, "acquire" | "close" | "closeAll" | "has">;

type BrowserSessionStack = {
  endpoint: string;
  targetManager: TargetManagerLike;
  sessionManager: BrowserSessionManagerLike;
};

type ResolvedSessionStack = {
  stack: BrowserSessionStack;
  launchedDuringCall: boolean;
};

type PageSupervisor = Pick<CDPSupervisor,
  | "send"
  | "waitFor"
  | "getSnapshot"
  | "consoleHistory"
  | "respondToDialog"
  | "close"
>;

type ManagedBackendSession = BrowserManagedSession & {
  supervisor: PageSupervisor;
};

export function createSupervisedLocalCdpBrowserBackend(options: SupervisedLocalCdpBackendOptions = {}): BrowserBackend {
  const configuredEndpoint = normalizeCdpUrl(options.cdpUrl);
  const lifecycle = options.lifecycle;
  const sessionStacks = new Map<string, BrowserSessionStack>();
  let launchedChrome: LaunchedChrome | undefined;
  let launchPromise: Promise<LaunchedChrome> | undefined;
  let configuredStack: BrowserSessionStack | undefined;
  let launchedStack: BrowserSessionStack | undefined;
  let closed = false;
  lifecycle?.start();

  const getSession = async (input?: BrowserActionInput): Promise<ManagedBackendSession> => {
    const sessionId = requireSessionId(input?.sessionId);
    const stack = sessionStacks.get(sessionId);
    if (stack === undefined || !stack.sessionManager.has(sessionId)) {
      sessionStacks.delete(sessionId);
      throw new Error(`Browser session not found: ${sessionId}`);
    }
    return asBackendSession(await stack.sessionManager.acquire(sessionId));
  };

  const closeSession = async (sessionId: string): Promise<void> => {
    const stack = sessionStacks.get(sessionId);
    if (stack === undefined || !stack.sessionManager.has(sessionId)) {
      sessionStacks.delete(sessionId);
      lifecycle?.unregister(sessionId);
      await closeLaunchedChromeIfIdle();
      return;
    }

    let closeError: unknown;
    try {
      await stack.sessionManager.close(sessionId);
    } catch (error) {
      closeError = error;
    } finally {
      sessionStacks.delete(sessionId);
    }

    try {
      await closeLaunchedChromeIfIdle();
    } catch (error) {
      closeError ??= error;
    }

    if (closeError !== undefined) {
      throw closeError;
    }
  };

  const closeLaunchedChromeIfIdle = async (): Promise<void> => {
    if (launchedStack !== undefined && hasSessionsForStack(launchedStack)) {
      return;
    }
    const stack = launchedStack;
    if (stack !== undefined) {
      launchedStack = undefined;
      await closeStack(stack);
    }
    await killLaunchedChrome();
  };

  const hasSessionsForStack = (stack: BrowserSessionStack): boolean => {
    for (const owner of sessionStacks.values()) {
      if (owner === stack) {
        return true;
      }
    }
    return false;
  };

  const removeSessionKeysForStack = (stack: BrowserSessionStack): void => {
    for (const [sessionId, owner] of [...sessionStacks.entries()]) {
      if (owner === stack) {
        sessionStacks.delete(sessionId);
      }
    }
  };

  const killLaunchedChrome = async (): Promise<void> => {
    const chrome = launchedChrome;
    launchedChrome = undefined;
    launchPromise = undefined;
    if (chrome !== undefined) {
      await chrome.kill();
    }
  };

  const ensureAutoLaunchedChrome = async (): Promise<{
    chrome: LaunchedChrome;
    launchedDuringCall: boolean;
  }> => {
    if (launchedChrome !== undefined) {
      return { chrome: launchedChrome, launchedDuringCall: false };
    }
    const finder = options.findChromiumExecutable ?? findChromiumExecutable;
    const launcher = options.launchChrome ?? launchChrome;
    let created = false;
    launchPromise ??= (async () => {
      const found = await finder({
        launchExecutable: options.launchExecutable,
        launchCommand: options.launchCommand
      });
      if (found.executablePath === undefined) {
        throw new Error([
          "Chromium executable was not found using browser.launchExecutable, deprecated browser.launchCommand, CHROME_PATH, CHROMIUM_PATH, node_modules/.bin/chromium, platform defaults, Homebrew paths, or Docker paths.",
          "Set browser.launchExecutable or pass --launch-executable."
        ].join(" "));
      }
      created = true;
      const chrome = await launcher({
        launchExecutable: found.executablePath,
        launchArgs: options.launchArgs,
        chromeFlags: options.chromeFlags,
        fetch: options.fetch as typeof globalThis.fetch | undefined
      });
      launchedChrome = chrome;
      return chrome;
    })();

    try {
      const chrome = await launchPromise;
      return { chrome, launchedDuringCall: created };
    } catch (error) {
      launchPromise = undefined;
      throw error;
    }
  };

  const createStack = (endpoint: string): BrowserSessionStack => {
    const targetManagerFactory = options.createTargetManager ?? ((targetOptions) => new CdpTargetManager(targetOptions));
    const sessionManagerFactory = options.createSessionManager ?? ((sessionOptions) => new BrowserSessionManager(sessionOptions));
    const targetManager = targetManagerFactory({
      endpoint,
      fetch: options.fetch,
      createClient: async (webSocketUrl) => connectCdp({
        webSocketUrl,
        webSocketFactory: options.webSocketFactory
      }),
      supervisorFactory: async (supervisorOptions) => {
        const supervisor = new CDPSupervisor({
          ...supervisorOptions,
          webSocketFactory: options.webSocketFactory,
          requestInterception: {
            allowPrivateUrls: options.securityConfig?.allowPrivateUrls,
            websiteBlocklist: options.securityConfig?.websiteBlocklist,
            resolveHostname: options.resolveHostname
          }
        });
        await supervisor.start();
        return supervisor;
      }
    });
    const sessionManager = sessionManagerFactory({
      targetManager,
      lifecycle: lifecycle === undefined
        ? undefined
        : {
          register: (sessionId, metadata) => {
            lifecycle.register(sessionId, {
              backend: "local-cdp",
              ...(isRecord(metadata) ? metadata : {})
            });
          },
          touch: (sessionId) => lifecycle.touch(sessionId),
          unregister: (sessionId) => lifecycle.unregister(sessionId)
        }
    });
    return {
      endpoint,
      targetManager,
      sessionManager
    };
  };

  const closeStack = async (stack: BrowserSessionStack | undefined): Promise<void> => {
    if (stack === undefined) {
      return;
    }
    let firstError: unknown;
    try {
      await stack.sessionManager.closeAll();
    } catch (error) {
      firstError ??= error;
    }
    try {
      await stack.targetManager.close();
    } catch (error) {
      firstError ??= error;
    }
    removeSessionKeysForStack(stack);
    if (firstError !== undefined) {
      throw firstError;
    }
  };

  const closeBackend = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    const stacks = new Set([configuredStack, launchedStack].filter((stack): stack is BrowserSessionStack => stack !== undefined));
    let firstError: unknown;
    for (const stack of stacks) {
      try {
        await closeStack(stack);
      } catch (error) {
        firstError ??= error;
      }
    }
    sessionStacks.clear();
    configuredStack = undefined;
    launchedStack = undefined;
    try {
      await killLaunchedChrome();
    } catch (error) {
      firstError ??= error;
    }
    lifecycle?.stop();
    if (firstError !== undefined) {
      throw firstError;
    }
  };

  const resolveLaunchedSessionStack = async (configuredEndpointFailure?: unknown): Promise<ResolvedSessionStack> => {
    try {
      const launched = await ensureAutoLaunchedChrome();
      try {
        launchedStack ??= createStack(launched.chrome.endpoint);
        return {
          stack: launchedStack,
          launchedDuringCall: launched.launchedDuringCall
        };
      } catch (error) {
        if (launched.launchedDuringCall) {
          launchedStack = undefined;
          await killLaunchedChrome();
        }
        throw error;
      }
    } catch (error) {
      if (configuredEndpointFailure !== undefined) {
        throw new Error(
          `Configured CDP endpoint ${configuredEndpoint} failed (${errorMessage(configuredEndpointFailure)}); auto-launch fallback also failed: ${errorMessage(error)}`,
          { cause: error }
        );
      }
      throw error;
    }
  };

  const resolveSessionStack = async (): Promise<ResolvedSessionStack> => {
    let configuredEndpointFailure: unknown;
    if (configuredEndpoint !== undefined) {
      try {
        configuredStack ??= createStack(configuredEndpoint);
        return {
          stack: configuredStack,
          launchedDuringCall: false
        };
      } catch (error) {
        if (options.autoLaunch !== true) {
          throw error;
        }
        configuredEndpointFailure = error;
      }
    } else if (options.autoLaunch !== true) {
      throw new Error("CDP URL is not configured.");
    }

    return resolveLaunchedSessionStack(configuredEndpointFailure);
  };

  const backend: BrowserBackend & {
    closeSession(sessionId: string): Promise<void>;
    close(): Promise<void>;
  } = {
    kind: "local-cdp",
    isAvailable: async () => (await checkLocalCdpStatus(launchedStack?.endpoint ?? launchedChrome?.endpoint ?? configuredEndpoint, options.fetch)).available,
    status: () => checkLocalCdpStatus(launchedStack?.endpoint ?? launchedChrome?.endpoint ?? configuredEndpoint, options.fetch),
    async navigate(input: BrowserNavigateInput): Promise<BrowserNavigateResult> {
      if (closed) {
        throw new Error("Browser backend is closed.");
      }

      const sessionId = requireSessionId(input.sessionId);
      const existingStack = sessionStacks.get(sessionId);
      const resolved = existingStack === undefined
        ? await resolveSessionStack()
        : { stack: existingStack, launchedDuringCall: false };
      let sessionStack = resolved.stack;
      let session: ManagedBackendSession | undefined;

      try {
        try {
          session = asBackendSession(await resolved.stack.sessionManager.acquire(sessionId));
        } catch (error) {
          if (resolved.stack === configuredStack && options.autoLaunch === true) {
            await closeStack(configuredStack).catch(() => undefined);
            configuredStack = undefined;
            const launched = await resolveLaunchedSessionStack(error);
            try {
              session = asBackendSession(await launched.stack.sessionManager.acquire(sessionId));
              sessionStack = launched.stack;
            } catch (fallbackError) {
              if (launched.launchedDuringCall) {
                await closeStack(launched.stack).catch(() => undefined);
                if (launched.stack === launchedStack) {
                  launchedStack = undefined;
                }
                await killLaunchedChrome();
              }
              throw new Error(
                `Configured CDP endpoint ${configuredEndpoint} failed (${errorMessage(error)}); auto-launch fallback also failed: ${errorMessage(fallbackError)}`,
                { cause: fallbackError }
              );
            }
            if (launched.launchedDuringCall) {
              resolved.launchedDuringCall = true;
            }
          } else {
            if (resolved.launchedDuringCall) {
              await closeStack(resolved.stack).catch(() => undefined);
              if (resolved.stack === launchedStack) {
                launchedStack = undefined;
              }
              await killLaunchedChrome();
            }
            throw error;
          }
        }
        if (session === undefined) {
          throw new Error(`Browser session not found: ${sessionId}`);
        }
        const supervisor = session.supervisor;
        await supervisor.send("Page.navigate", { url: input.url });
        await supervisor.waitFor("Page.loadEventFired", 5_000).catch(() => undefined);

        const snapshot = await supervisor.getSnapshot(sessionId);
        sessionStacks.set(sessionId, existingStack ?? sessionStack);

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
        if (resolved.launchedDuringCall) {
          await closeStack(launchedStack).catch(() => undefined);
          launchedStack = undefined;
          await killLaunchedChrome();
        }
        throw error;
      }
    },
    snapshot: async (input) => {
      const session = await getSession(input);
      return session.supervisor.getSnapshot(session.key, { full: input?.full === true });
    },
    click: async (input) => {
      const session = await getSession(input);
      await session.supervisor.send("Runtime.evaluate", {
        expression: refActionExpression(input.ref, "click"),
        awaitPromise: true
      });
      return session.supervisor.getSnapshot(session.key);
    },
    type: async (input) => {
      const session = await getSession(input);
      await session.supervisor.send("Runtime.evaluate", {
        expression: refActionExpression(input.ref, "type", input.text ?? ""),
        awaitPromise: true
      });
      return session.supervisor.getSnapshot(session.key);
    },
    scroll: async (input) => {
      const session = await getSession(input);
      const amount = input.amount ?? 700;
      const delta = input.direction === "up" ? -amount : amount;
      await session.supervisor.send("Runtime.evaluate", {
        expression: `window.scrollBy(0, ${JSON.stringify(delta)}); "ok";`,
        returnByValue: true
      });
      return session.supervisor.getSnapshot(session.key);
    },
    press: async (input) => {
      const session = await getSession(input);
      const key = input.key ?? "Enter";
      await session.supervisor.send("Input.dispatchKeyEvent", { type: "keyDown", key });
      await session.supervisor.send("Input.dispatchKeyEvent", { type: "keyUp", key });
      return session.supervisor.getSnapshot(session.key);
    },
    back: async (input = {}) => {
      const session = await getSession(input);
      await session.supervisor.send("Runtime.evaluate", {
        expression: "history.back(); 'ok';",
        returnByValue: true
      });
      await session.supervisor.waitFor("Page.loadEventFired", 2_000).catch(() => undefined);
      return session.supervisor.getSnapshot(session.key);
    },
    getImages: async (input = {}) => {
      const session = await getSession(input);
      const evaluated = await session.supervisor.send("Runtime.evaluate", {
        expression: "JSON.stringify(Array.from(document.images).slice(0, 100).map((img) => ({ src: img.currentSrc || img.src, alt: img.alt || undefined })))",
        returnByValue: true
      }) as { result?: { value?: unknown } };
      return parseJsonArray(evaluated.result?.value);
    },
    console: async (input = {}): Promise<BrowserConsoleEntry[]> => {
      const session = await getSession(input);
      return session.supervisor.consoleHistory({ clear: input.clear });
    },
    cdp: async (input) => {
      const session = await getSession(input);
      if (input.method === undefined || input.method.trim().length === 0) {
        throw new Error("browser.cdp requires a CDP method.");
      }
      return session.supervisor.send(input.method, input.params);
    },
    screenshot: async (input = {}) => {
      const session = await getSession(input);
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
      const session = await getSession(input);
      await session.supervisor.respondToDialog({
        accept: input.action !== "dismiss",
        promptText: input.promptText
      });
      return session.supervisor.getSnapshot(session.key);
    },
    closeSession,
    close: closeBackend
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireSessionId(sessionId: string | undefined): string {
  if (sessionId === undefined || sessionId.trim().length === 0) {
    throw new Error("Browser sessionId is required for supervised local CDP operations.");
  }
  return sessionId;
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

function asBackendSession(session: BrowserManagedSession): ManagedBackendSession {
  return {
    ...session,
    supervisor: session.supervisor as PageSupervisor
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
