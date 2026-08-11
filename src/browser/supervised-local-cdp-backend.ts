import type {
  BrowserActionInput,
  BrowserBackend,
  BrowserConsoleEntry,
  BrowserBackendStatus,
  BrowserNavigateInput,
  BrowserNavigateResult,
  BrowserScreenshotResult,
  BrowserSnapshot,
  BrowserSwitchTabInput,
  BrowserTab,
  BrowserTabList
} from "../contracts/browser.js";
import type { LoadedRuntimeConfig } from "../config/runtime-config.js";
import { connectCdp, type CdpFetchLike, type CdpWebSocketFactory } from "./cdp-client.js";
import { isSafeUrl, redactUrlForMetadata, scanUrlForSecrets, type ResolveHostnameFn } from "./url-safety.js";
import { checkWebsiteAccess, loadWebsiteBlocklist } from "./website-policy.js";
import { CDPSupervisor } from "./cdp-supervisor.js";
import type { BrowserSessionLifecycle } from "./session-lifecycle.js";
import { findChromiumExecutable, type ChromiumFinderOptions, type ChromiumFinderResult } from "./chromium-finder.js";
import { launchChrome, type ChromeLauncherOptions, type LaunchedChrome } from "./chrome-launcher.js";
import { CdpTargetManager, type CdpTargetManagerOptions } from "./cdp-target-manager.js";
import {
  BrowserSessionManager,
  type BrowserManagedSession,
  type BrowserManagedTab,
  type BrowserSessionManagerOptions
} from "./session-manager.js";

export type SupervisedLocalCdpBackendOptions = {
  cdpUrl?: string;
  launchCommand?: string;
  launchExecutable?: string;
  launchArgs?: string[];
  chromeFlags?: string[];
  autoLaunch?: boolean;
  headless?: boolean;
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

type BrowserSessionManagerLike = Pick<BrowserSessionManager, "acquire" | "close" | "closeAll" | "has"> &
  Partial<Pick<BrowserSessionManager, "listTabs" | "switchTab">>;

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
  const websitePolicy = loadWebsiteBlocklist(options.securityConfig?.websiteBlocklist ?? {});
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

  const tabUrlIsAllowed = async (url: string): Promise<boolean> => {
    if (url === "about:blank") return true;
    if (scanUrlForSecrets(url) !== undefined) return false;
    try {
      const parsed = new URL(url);
      if (parsed.username !== "" || parsed.password !== "") return false;
    } catch {
      return false;
    }
    if (!await isSafeUrl(url, {
      allowPrivateUrls: options.securityConfig?.allowPrivateUrls === true,
      resolveHostname: options.resolveHostname
    })) {
      return false;
    }
    return checkWebsiteAccess(url, websitePolicy)?.allowed !== false;
  };

  const tabIsAllowed = async (tab: BrowserManagedTab): Promise<boolean> => tabUrlIsAllowed(tab.url);

  const listManagedTabs = async (sessionId: string): Promise<BrowserManagedTab[]> => {
    const stack = sessionStacks.get(sessionId);
    if (stack === undefined || !stack.sessionManager.has(sessionId)) {
      throw new Error(`Browser session not found: ${sessionId}`);
    }
    const listTabs = stack.sessionManager.listTabs;
    if (listTabs === undefined) {
      throw new Error("Browser backend does not support tab listing.");
    }
    return listTabs.call(stack.sessionManager, sessionId);
  };

  const listSafeTabs = async (sessionId: string): Promise<BrowserTabList> => {
    const managedTabs = await listManagedTabs(sessionId);
    const decisions = await Promise.all(managedTabs.map(async (tab) => ({
      tab,
      allowed: await tabIsAllowed(tab)
    })));
    return {
      sessionId,
      tabs: decisions.filter((entry) => entry.allowed).map((entry) => toBrowserTab(entry.tab)),
      blockedCount: decisions.filter((entry) => !entry.allowed).length
    };
  };

  const supportsTabManagement = (sessionId: string): boolean => {
    const manager = sessionStacks.get(sessionId)?.sessionManager;
    return manager?.listTabs !== undefined && manager.switchTab !== undefined;
  };

  const switchSafeTab = async (input: BrowserSwitchTabInput): Promise<{
    session: ManagedBackendSession;
    tab: BrowserTab;
    snapshot: BrowserSnapshot;
  }> => {
    const sessionId = requireSessionId(input.sessionId);
    const tabs = await listSafeTabs(sessionId);
    const requestedTab = tabs.tabs.find((tab) => tab.ref === input.tabRef);
    if (requestedTab === undefined) {
      throw new Error(`Browser tab is unavailable under the current session or URL policy: ${input.tabRef}`);
    }
    const stack = sessionStacks.get(sessionId)!;
    const switchTab = stack.sessionManager.switchTab;
    if (switchTab === undefined) {
      throw new Error("Browser backend does not support tab switching.");
    }
    const previousTab = tabs.tabs.find((tab) => tab.controlled);
    const session = asBackendSession(await switchTab.call(stack.sessionManager, sessionId, input.tabRef));
    const snapshot = await session.supervisor.getSnapshot(session.key);
    if (!await tabUrlIsAllowed(snapshot.url)) {
      if (previousTab !== undefined && previousTab.ref !== input.tabRef) {
        await switchTab.call(stack.sessionManager, sessionId, previousTab.ref).catch(() => undefined);
      }
      throw new Error("Browser tab changed to a URL blocked by browser policy before it could be controlled.");
    }
    const tab: BrowserTab = {
      ref: session.tabRef,
      url: redactUrlForMetadata(snapshot.url),
      ...(snapshot.title === undefined ? {} : { title: snapshot.title }),
      controlled: true
    };
    return {
      session,
      tab,
      snapshot
    };
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
        headless: options.headless,
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

  const resolveAvailabilityStatus = async (): Promise<BrowserBackendStatus> => {
    if (closed) {
      return {
        backend: "local-cdp",
        available: false,
        reason: "Browser backend is closed."
      };
    }

    const endpoint = launchedStack?.endpoint ?? launchedChrome?.endpoint ?? configuredEndpoint;
    const currentStatus = await checkLocalCdpStatus(endpoint, options.fetch);
    if (currentStatus.available || options.autoLaunch !== true) {
      return currentStatus;
    }

    const finder = options.findChromiumExecutable ?? findChromiumExecutable;
    const found = await finder({
      launchExecutable: options.launchExecutable,
      launchCommand: options.launchCommand
    });
    if (found.executablePath === undefined) {
      return {
        ...currentStatus,
        reason: endpoint === undefined
          ? "CDP URL is not configured and Chrome/Chromium auto-launch is unavailable because no executable was found."
          : `${currentStatus.reason ?? "Configured CDP endpoint is unavailable."} Chrome/Chromium auto-launch fallback is unavailable because no executable was found.`
      };
    }

    return {
      backend: "local-cdp",
      available: true,
      ...(endpoint === undefined ? {} : { endpoint }),
      reason: endpoint === undefined
        ? "Chrome/Chromium auto-launch is ready and will start on the first browser action."
        : "Configured CDP endpoint is unavailable; Chrome/Chromium auto-launch fallback is ready and will start on the first browser action."
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
    isAvailable: async () => (await resolveAvailabilityStatus()).available,
    status: resolveAvailabilityStatus,
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

        const snapshot = withSessionTab(session, await supervisor.getSnapshot(sessionId));
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
      return withSessionTab(
        session,
        await session.supervisor.getSnapshot(session.key, { full: input?.full === true })
      );
    },
    click: async (input) => {
      const session = await getSession(input);
      const beforeTabs = supportsTabManagement(session.key) ? await listManagedTabs(session.key) : undefined;
      await session.supervisor.send("Runtime.evaluate", {
        expression: refActionExpression(input.ref, "click"),
        awaitPromise: true
      });
      const clickedSnapshot = await session.supervisor.getSnapshot(session.key);
      if (beforeTabs === undefined) {
        return withSessionTab(session, clickedSnapshot);
      }
      const afterTabs = await listManagedTabs(session.key);
      const priorRefs = new Set(beforeTabs.map((tab) => tab.ref));
      const openedCandidates = afterTabs.filter((tab) => !priorRefs.has(tab.ref));
      const openedTabs = (await Promise.all(openedCandidates.map(async (tab) => (
        await tabIsAllowed(tab) ? toBrowserTab(tab) : undefined
      )))).filter((tab): tab is BrowserTab => tab !== undefined);
      if (openedTabs.length === 1) {
        const switched = await switchSafeTab({
          sessionId: session.key,
          tabRef: openedTabs[0]!.ref,
          signal: input.signal
        });
        return withSessionTab(switched.session, switched.snapshot, [switched.tab]);
      }
      return withSessionTab(session, clickedSnapshot, openedTabs);
    },
    type: async (input) => {
      const session = await getSession(input);
      await session.supervisor.send("Runtime.evaluate", {
        expression: refActionExpression(input.ref, "type", input.text ?? ""),
        awaitPromise: true
      });
      return withSessionTab(session, await session.supervisor.getSnapshot(session.key));
    },
    scroll: async (input) => {
      const session = await getSession(input);
      const amount = input.amount ?? 700;
      const delta = input.direction === "up" ? -amount : amount;
      await session.supervisor.send("Runtime.evaluate", {
        expression: `window.scrollBy(0, ${JSON.stringify(delta)}); "ok";`,
        returnByValue: true
      });
      return withSessionTab(session, await session.supervisor.getSnapshot(session.key));
    },
    press: async (input) => {
      const session = await getSession(input);
      const key = input.key ?? "Enter";
      await session.supervisor.send("Input.dispatchKeyEvent", { type: "keyDown", key });
      await session.supervisor.send("Input.dispatchKeyEvent", { type: "keyUp", key });
      return withSessionTab(session, await session.supervisor.getSnapshot(session.key));
    },
    back: async (input = {}) => {
      const session = await getSession(input);
      await session.supervisor.send("Runtime.evaluate", {
        expression: "history.back(); 'ok';",
        returnByValue: true
      });
      await session.supervisor.waitFor("Page.loadEventFired", 2_000).catch(() => undefined);
      return withSessionTab(session, await session.supervisor.getSnapshot(session.key));
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
    tabs: async (input = {}) => {
      const session = await getSession(input);
      return listSafeTabs(session.key);
    },
    switchTab: async (input) => {
      const switched = await switchSafeTab(input);
      const snapshot = withSessionTab(switched.session, switched.snapshot);
      return {
        tab: snapshot.tab!,
        snapshot
      };
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
      return withSessionTab(session, await session.supervisor.getSnapshot(session.key));
    },
    closeSession,
    close: closeBackend
  };

  return backend;
}

function toBrowserTab(tab: BrowserManagedTab): BrowserTab {
  return {
    ref: tab.ref,
    url: redactUrlForMetadata(tab.url),
    ...(tab.title === undefined ? {} : { title: tab.title }),
    controlled: tab.controlled
  };
}

function withSessionTab(
  session: ManagedBackendSession,
  snapshot: BrowserSnapshot,
  openedTabs: BrowserTab[] = []
): BrowserSnapshot {
  return {
    ...snapshot,
    tab: {
      ref: session.tabRef,
      url: redactUrlForMetadata(snapshot.url),
      ...(snapshot.title === undefined ? {} : { title: snapshot.title }),
      controlled: true
    },
    ...(openedTabs.length === 0 ? {} : { openedTabs })
  };
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
