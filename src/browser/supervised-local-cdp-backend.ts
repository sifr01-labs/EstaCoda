import type {
  BrowserActionInput,
  BrowserBackend,
  BrowserConsoleEntry,
  BrowserBackendStatus,
  BrowserExtractResult,
  BrowserNavigateInput,
  BrowserNavigateResult,
  BrowserProtectedFieldDeliveryInput,
  BrowserProtectedFieldInput,
  BrowserScreenshotResult,
  BrowserSnapshot,
  BrowserStateIdentity,
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
import { BrowserSessionStateError, browserSessionStateReason } from "./session-state.js";
import { settleBrowserAction, withBrowserActionDelta } from "./action-settling.js";
import { findBrowserLocator, resolveBrowserTarget } from "./browser-locator.js";
import { findChromiumExecutable, type ChromiumFinderOptions, type ChromiumFinderResult } from "./chromium-finder.js";
import { launchChrome, type ChromeLauncherOptions, type LaunchedChrome } from "./chrome-launcher.js";
import { CdpTargetManager, type CdpTargetManagerOptions } from "./cdp-target-manager.js";
import {
  BrowserSessionManager,
  type BrowserManagedSession,
  type BrowserManagedTab,
  type BrowserSessionManagerOptions
} from "./session-manager.js";
import type { BrowserDocumentSignal, BrowserSnapshotInput } from "./snapshot-state.js";
import { redactSensitiveText } from "../utils/redaction.js";
import { ProtectedBrowserFormTransactionController } from "./protected-browser-field.js";

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
  settling?: {
    pollIntervalMs?: number;
    stableWindowMs?: number;
    minimumObservationMs?: number;
  };
};

type TargetManagerLike = Pick<CdpTargetManager, "createTarget" | "close">;

type BrowserSessionManagerLike = Pick<BrowserSessionManager, "acquire" | "close" | "closeAll" | "has" | "observeSnapshot"> &
  Partial<Pick<BrowserSessionManager, "listTabs" | "visibleTab" | "switchTab">>;

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
  | "setSensitiveInputActive"
  | "close"
>;

type BackendRawSnapshot = BrowserSnapshotInput & {
  documentSignal?: BrowserDocumentSignal;
};

type ManagedBackendSession = BrowserManagedSession & {
  supervisor: PageSupervisor;
};

export function createSupervisedLocalCdpBrowserBackend(options: SupervisedLocalCdpBackendOptions = {}): BrowserBackend {
  const configuredEndpoint = normalizeCdpUrl(options.cdpUrl);
  const lifecycle = options.lifecycle;
  const sessionStacks = new Map<string, BrowserSessionStack>();
  const lostSessions = new Map<string, "session_missing" | "browser_process_missing">();
  const latestSnapshots = new Map<string, BrowserSnapshot>();
  const latestSnapshotScopes = new Map<string, boolean>();
  const latestObservedUrls = new Map<string, string>();
  const protectedFields = new ProtectedBrowserFormTransactionController();
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
      latestSnapshots.delete(sessionId);
      latestSnapshotScopes.delete(sessionId);
      latestObservedUrls.delete(sessionId);
      await protectedFields.clearSession(sessionId);
      throw new BrowserSessionStateError("session_missing", `Browser session not found: ${sessionId}`);
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
      throw new BrowserSessionStateError("session_missing", `Browser session not found: ${sessionId}`);
    }
    const listTabs = stack.sessionManager.listTabs;
    if (listTabs === undefined) {
      throw new Error("Browser backend does not support tab listing.");
    }
    return listTabs.call(stack.sessionManager, sessionId);
  };

  const listSafeTabs = async (sessionId: string): Promise<BrowserTabList> => {
    let managedTabs = await listManagedTabs(sessionId);
    const stack = sessionStacks.get(sessionId)!;
    const visibleTab = await stack.sessionManager.visibleTab?.call(stack.sessionManager, sessionId);
    if (
      visibleTab !== undefined &&
      !visibleTab.controlled &&
      await tabIsAllowed(visibleTab) &&
      stack.sessionManager.switchTab !== undefined
    ) {
      await stack.sessionManager.switchTab.call(stack.sessionManager, sessionId, visibleTab.ref);
      managedTabs = await listManagedTabs(sessionId);
    }
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

  const observeSessionSnapshot = async (
    session: ManagedBackendSession,
    snapshot: BackendRawSnapshot
  ): Promise<BrowserSnapshot> => {
    const manager = sessionStacks.get(session.key)?.sessionManager;
    if (manager === undefined) {
      throw new BrowserSessionStateError("session_missing", `Browser session not found: ${session.key}`);
    }
    const previousUrl = latestObservedUrls.get(session.key);
    const { documentSignal, ...rawSnapshot } = snapshot;
    const observed = manager.observeSnapshot(session.key, rawSnapshot, documentSignal).snapshot;
    latestObservedUrls.set(session.key, observed.url);
    if (previousUrl !== undefined && previousUrl !== observed.url && protectedFields.isSensitive(session.key) &&
        !protectedFields.isSettling(session.key)) {
      await protectedFields.invalidateSession(session);
    } else {
      await protectedFields.reconcile(session);
    }
    const protectedSnapshot = protectedFields.protectSnapshot(session.key, observed);
    latestSnapshots.set(session.key, protectedSnapshot);
    return protectedSnapshot;
  };

  const captureSessionSnapshot = async (
    session: ManagedBackendSession,
    openedTabs: BrowserTab[] = [],
    full = false
  ): Promise<BrowserSnapshot> => {
    const raw = withSessionTab(
      session,
      await session.supervisor.getSnapshot(session.key, { full }),
      openedTabs
    );
    latestSnapshotScopes.set(session.key, full);
    return await observeSessionSnapshot(session, raw);
  };

  const captureProtectedSettlementSnapshot = async (
    session: ManagedBackendSession,
    signal?: AbortSignal
  ): Promise<BrowserSnapshot> => {
    const attempts = 12;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (signal?.aborted === true) throw new Error("Protected browser settlement was cancelled.");
      try {
        return await captureSessionSnapshot(session);
      } catch (error) {
        if (attempt === attempts || !isTransientNavigationObservationError(error)) throw error;
        await abortableProtectedSettlementDelay(75, signal);
      }
    }
    throw new Error("Protected browser settlement did not produce a snapshot.");
  };

  const captureSafeTargetSnapshot = async (
    session: ManagedBackendSession,
    input: BrowserActionInput
  ): Promise<{ snapshot: BrowserSnapshot; full: boolean }> => {
    const full = input.ref !== undefined && latestSnapshotScopes.get(session.key) === true;
    const snapshot = await captureSessionSnapshot(session, [], full);
    if (!await tabUrlIsAllowed(snapshot.url)) {
      throw new Error("Browser target resolution is blocked because the controlled tab URL violates browser policy.");
    }
    return { snapshot, full };
  };

  const settleAction = async (input: {
    session: ManagedBackendSession;
    before?: BrowserSnapshot;
    actionInput: Pick<BrowserActionInput, "waitFor" | "waitTimeoutMs" | "signal">;
    capture?: () => Promise<BrowserSnapshot>;
    initialSnapshot?: BrowserSnapshot;
    openedTabs?: BrowserTab[];
    full?: boolean;
  }): Promise<BrowserSnapshot> => {
    const beforeObservedUrl = latestObservedUrls.get(input.session.key);
    const settlement = await settleBrowserAction({
      capture: input.capture ?? (() => captureSessionSnapshot(input.session, [], input.full === true)),
      waitFor: input.actionInput.waitFor,
      waitTimeoutMs: input.actionInput.waitTimeoutMs,
      signal: input.actionInput.signal,
      initialSnapshot: input.initialSnapshot,
      pollIntervalMs: options.settling?.pollIntervalMs,
      stableWindowMs: options.settling?.stableWindowMs,
      minimumObservationMs: options.settling?.minimumObservationMs
    });
    const settledSnapshot = withBrowserActionDelta({
      before: input.before,
      settlement,
      openedTabs: input.openedTabs
    });
    const snapshot = protectedFields.protectSnapshot(input.session.key, settledSnapshot);
    latestSnapshots.set(input.session.key, snapshot);
    const afterObservedUrl = latestObservedUrls.get(input.session.key);
    if (beforeObservedUrl !== undefined && afterObservedUrl !== undefined && beforeObservedUrl !== afterObservedUrl &&
        !protectedFields.isSettling(input.session.key)) {
      await protectedFields.invalidateSession(input.session);
    }
    return snapshot;
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
      throw new BrowserSessionStateError(
        "tab_missing",
        `Browser tab is unavailable under the current session or URL policy: ${input.tabRef}`
      );
    }
    const stack = sessionStacks.get(sessionId)!;
    const switchTab = stack.sessionManager.switchTab;
    if (switchTab === undefined) {
      throw new Error("Browser backend does not support tab switching.");
    }
    const previousTab = tabs.tabs.find((tab) => tab.controlled);
    const session = asBackendSession(await switchTab.call(stack.sessionManager, sessionId, input.tabRef));
    const rawSnapshot = withSessionTab(session, await session.supervisor.getSnapshot(session.key));
    if (!await tabUrlIsAllowed(rawSnapshot.url)) {
      if (previousTab !== undefined && previousTab.ref !== input.tabRef) {
        await switchTab.call(stack.sessionManager, sessionId, previousTab.ref).catch(() => undefined);
      }
      throw new Error("Browser tab changed to a URL blocked by browser policy before it could be controlled.");
    }
    const snapshot = await observeSessionSnapshot(session, rawSnapshot);
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
    await protectedFields.clearSession(sessionId);
    const stack = sessionStacks.get(sessionId);
    if (stack === undefined || !stack.sessionManager.has(sessionId)) {
      sessionStacks.delete(sessionId);
      latestSnapshots.delete(sessionId);
      latestSnapshotScopes.delete(sessionId);
      latestObservedUrls.delete(sessionId);
      lifecycle?.unregister(sessionId);
      await closeLaunchedChromeIfIdle();
      return;
    }

    lostSessions.set(sessionId, "session_missing");

    let closeError: unknown;
    try {
      await stack.sessionManager.close(sessionId);
    } catch (error) {
      closeError = error;
    } finally {
      sessionStacks.delete(sessionId);
      latestSnapshots.delete(sessionId);
      latestSnapshotScopes.delete(sessionId);
      latestObservedUrls.delete(sessionId);
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
        latestSnapshots.delete(sessionId);
        latestSnapshotScopes.delete(sessionId);
        latestObservedUrls.delete(sessionId);
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
        sessionState: "browser_process_missing",
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
      sessionState: "backend_available",
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
    for (const sessionId of sessionStacks.keys()) {
      try {
        await protectedFields.clearSession(sessionId);
      } catch (error) {
        firstError ??= error;
      }
    }
    for (const stack of stacks) {
      try {
        await closeStack(stack);
      } catch (error) {
        firstError ??= error;
      }
    }
    sessionStacks.clear();
    lostSessions.clear();
    latestSnapshots.clear();
    latestSnapshotScopes.clear();
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
        throw new BrowserSessionStateError("browser_process_missing", "Browser backend is closed.");
      }

      const sessionId = requireSessionId(input.sessionId);
      const priorSessionLoss = lostSessions.get(sessionId);
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
          throw new BrowserSessionStateError("session_missing", `Browser session not found: ${sessionId}`);
        }
        await protectedFields.invalidateSession(session);
        const supervisor = session.supervisor;
        const before = latestSnapshots.get(sessionId);
        await supervisor.send("Page.navigate", { url: input.url });
        await supervisor.waitFor("Page.loadEventFired", 5_000).catch(() => undefined);

        sessionStacks.set(sessionId, existingStack ?? sessionStack);
        const initialSnapshot = await captureSessionSnapshot(session);
        const snapshot = await settleAction({
          session,
          before,
          actionInput: input,
          initialSnapshot
        });
        lostSessions.delete(sessionId);

        return {
          session: {
            id: sessionId,
            backend: "local-cdp",
            currentUrl: snapshot.url,
            createdAt: new Date().toISOString(),
          },
          snapshot,
          ...(priorSessionLoss === undefined ? {} : {
            metadata: {
              sessionRecovery: {
                reason: priorSessionLoss,
                authenticationPreserved: false
              }
            }
          })
        };
      } catch (error) {
        const reason = browserSessionStateReason(error);
        if (reason === "browser_process_missing") {
          lostSessions.set(sessionId, reason);
        }
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
      return captureSessionSnapshot(session, [], input?.full === true);
    },
    find: async (input) => {
      if (input.locator === undefined) {
        throw new Error("browser.find requires a semantic locator.");
      }
      const session = await getSession(input);
      const { snapshot } = await captureSafeTargetSnapshot(session, input);
      return findBrowserLocator(snapshot, input.locator);
    },
    click: async (input) => {
      let session = await getSession(input);
      const targetState = await captureSafeTargetSnapshot(session, input);
      const before = targetState.snapshot;
      const beforeObservedUrl = latestObservedUrls.get(session.key);
      const target = resolveBrowserTarget(before, input);
      const beforeTabs = supportsTabManagement(session.key) ? await listManagedTabs(session.key) : undefined;
      await session.supervisor.send("Runtime.evaluate", {
        expression: refActionExpression(target.ref, "click"),
        awaitPromise: true
      });
      const priorRefs = new Set(beforeTabs?.map((tab) => tab.ref) ?? []);
      let openedTabs: BrowserTab[] = [];
      const capture = async (): Promise<BrowserSnapshot> => {
        if (beforeTabs !== undefined && openedTabs.length === 0) {
          const afterTabs = await listManagedTabs(session.key);
          const openedCandidates = afterTabs.filter((tab) => !priorRefs.has(tab.ref));
          openedTabs = (await Promise.all(openedCandidates.map(async (tab) => (
            await tabIsAllowed(tab) ? toBrowserTab(tab) : undefined
          )))).filter((tab): tab is BrowserTab => tab !== undefined);
          if (openedTabs.length === 1) {
            const switched = await switchSafeTab({
              sessionId: session.key,
              tabRef: openedTabs[0]!.ref,
              signal: input.signal
            });
            session = switched.session;
            openedTabs = [switched.tab];
          }
        }
        return captureSessionSnapshot(session, openedTabs, targetState.full);
      };
      const settlement = await settleBrowserAction({
        capture,
        waitFor: input.waitFor,
        waitTimeoutMs: input.waitTimeoutMs,
        signal: input.signal,
        pollIntervalMs: options.settling?.pollIntervalMs,
        stableWindowMs: options.settling?.stableWindowMs,
        minimumObservationMs: options.settling?.minimumObservationMs
      });
      const settledSnapshot = withBrowserActionDelta({ before, settlement, openedTabs });
      const snapshot = protectedFields.protectSnapshot(session.key, settledSnapshot);
      latestSnapshots.set(session.key, snapshot);
      const afterObservedUrl = latestObservedUrls.get(session.key);
      if (beforeObservedUrl !== undefined && afterObservedUrl !== undefined && beforeObservedUrl !== afterObservedUrl) {
        await protectedFields.invalidateSession(session);
      }
      return snapshot;
    },
    type: async (input) => {
      const session = await getSession(input);
      const targetState = await captureSafeTargetSnapshot(session, input);
      const before = targetState.snapshot;
      const target = resolveBrowserTarget(before, input);
      await session.supervisor.send("Runtime.evaluate", {
        expression: refActionExpression(target.ref, "type", input.text ?? ""),
        awaitPromise: true
      });
      return settleAction({ session, before, actionInput: input, full: targetState.full });
    },
    select: async (input) => {
      const session = await getSession(input);
      const targetState = await captureSafeTargetSnapshot(session, input);
      const before = targetState.snapshot;
      const target = resolveBrowserTarget(before, input);
      if (input.value === undefined || input.value.length === 0) {
        throw new Error("browser.select requires a non-empty value.");
      }
      await session.supervisor.send("Runtime.evaluate", {
        expression: selectActionExpression(target.ref, input.value),
        awaitPromise: true
      });
      return settleAction({ session, before, actionInput: input, full: targetState.full });
    },
    extract: async (input): Promise<BrowserExtractResult> => {
      const session = await getSession(input);
      const { snapshot } = await captureSafeTargetSnapshot(session, input);
      protectedFields.assertContentObservationAllowed(session.key);
      const target = resolveBrowserTarget(snapshot, input);
      const element = snapshot.elements?.find((candidate) => candidate.ref === target.ref);
      return {
        sessionId: snapshot.sessionId,
        identity: { ...snapshot.identity },
        tabRef: target.tabRef,
        target,
        ...(element?.text === undefined && element?.name === undefined ? {} : { text: redactSensitiveText(element.text ?? element.name ?? "").slice(0, 4_000) }),
        ...(element?.value === undefined ? {} : { value: redactSensitiveText(element.value).slice(0, 1_000) })
      };
    },
    scroll: async (input) => {
      const session = await getSession(input);
      const before = latestSnapshots.get(session.key) ?? await captureSessionSnapshot(session);
      const amount = input.amount ?? 700;
      const delta = input.direction === "up" ? -amount : amount;
      await session.supervisor.send("Runtime.evaluate", {
        expression: `window.scrollBy(0, ${JSON.stringify(delta)}); "ok";`,
        returnByValue: true
      });
      return settleAction({ session, before, actionInput: input });
    },
    press: async (input) => {
      const session = await getSession(input);
      const before = latestSnapshots.get(session.key) ?? await captureSessionSnapshot(session);
      const key = input.key ?? "Enter";
      await session.supervisor.send("Input.dispatchKeyEvent", { type: "keyDown", key });
      await session.supervisor.send("Input.dispatchKeyEvent", { type: "keyUp", key });
      return settleAction({ session, before, actionInput: input });
    },
    back: async (input = {}) => {
      const session = await getSession(input);
      await protectedFields.invalidateSession(session);
      const before = latestSnapshots.get(session.key) ?? await captureSessionSnapshot(session);
      await session.supervisor.send("Runtime.evaluate", {
        expression: "history.back(); 'ok';",
        returnByValue: true
      });
      await session.supervisor.waitFor("Page.loadEventFired", 2_000).catch(() => undefined);
      return settleAction({ session, before, actionInput: input });
    },
    getImages: async (input = {}) => {
      const session = await getSession(input);
      await protectedFields.reconcile(session);
      if (protectedFields.isSensitive(session.key)) return [];
      const evaluated = await session.supervisor.send("Runtime.evaluate", {
        expression: "JSON.stringify(Array.from(document.images).slice(0, 100).map((img) => ({ src: img.currentSrc || img.src, alt: img.alt || undefined })))",
        returnByValue: true
      }) as { result?: { value?: unknown } };
      return parseJsonArray(evaluated.result?.value);
    },
    console: async (input = {}): Promise<BrowserConsoleEntry[]> => {
      const session = await getSession(input);
      await protectedFields.reconcile(session);
      if (protectedFields.isSensitive(session.key)) return [];
      return session.supervisor.consoleHistory({ clear: input.clear });
    },
    tabs: async (input = {}) => {
      const session = await getSession(input);
      if (!protectedFields.isSensitive(session.key)) return listSafeTabs(session.key);
      const snapshot = latestSnapshots.get(session.key) ?? await captureSessionSnapshot(session);
      return {
        sessionId: session.key,
        tabs: snapshot.tab === undefined ? [] : [{
          ref: snapshot.tab.ref,
          url: originForUrl(snapshot.tab.url),
          controlled: true,
        }],
        blockedCount: 0,
      };
    },
    switchTab: async (input) => {
      await protectedFields.invalidateSession(await getSession(input));
      const before = latestSnapshots.get(requireSessionId(input.sessionId));
      const switched = await switchSafeTab(input);
      const snapshot = await settleAction({
        session: switched.session,
        before,
        actionInput: input,
        initialSnapshot: switched.snapshot
      });
      return {
        tab: snapshot.tab!,
        snapshot
      };
    },
    cdp: async (input) => {
      const session = await getSession(input);
      await protectedFields.reconcile(session);
      if (protectedFields.isSensitive(session.key)) {
        throw new Error("Raw browser CDP access is blocked while protected input is active.");
      }
      if (input.method === undefined || input.method.trim().length === 0) {
        throw new Error("browser.cdp requires a CDP method.");
      }
      return session.supervisor.send(input.method, input.params);
    },
    screenshot: async (input = {}) => {
      const session = await getSession(input);
      await protectedFields.reconcile(session);
      protectedFields.assertVisualObservationAllowed(session.key);
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
    prepareProtectedField: async (input) => {
      const session = await getSession(input);
      const { snapshot } = await captureSafeTargetSnapshot(session, input);
      const target = resolveBrowserTarget(snapshot, input);
      const submit = input.submitRef === undefined
        ? undefined
        : resolveBrowserTarget(snapshot, {
            sessionId: input.sessionId,
            ref: input.submitRef,
            identity: input.identity,
            tabRef: input.tabRef,
          });
      if (submit?.ref === target.ref) {
        throw new Error("Protected browser input and submit controls must be different elements.");
      }
      const origin = originForUrl(snapshot.url);
      if (origin === "null") {
        throw new Error("Protected browser input requires an HTTP or HTTPS origin.");
      }
      const frameTree = await session.supervisor.send("Page.getFrameTree") as {
        frameTree?: { frame?: { id?: unknown } };
      };
      const frameId = typeof frameTree.frameTree?.frame?.id === "string"
        ? frameTree.frameTree.frame.id
        : undefined;
      return {
        type: "browser-field",
        sessionId: session.key,
        ref: target.ref,
        identity: { ...snapshot.identity },
        expectedOrigin: origin,
        tabRef: target.tabRef,
        ...(frameId === undefined ? {} : { frameId }),
        ...(submit === undefined ? {} : {
          label: submit.name === undefined
            ? `Browser field and verified submit control at ${origin}`
            : `Browser field with verified submit control ${JSON.stringify(submit.name)} at ${origin}`,
          submit: { ref: submit.ref },
        }),
      };
    },
    verifyProtectedField: async (input: BrowserProtectedFieldInput) => {
      const session = await getSession({ sessionId: input.destination.sessionId });
      return await protectedFields.verify(session, input);
    },
    deliverProtectedField: async (input: BrowserProtectedFieldDeliveryInput) => {
      const session = await getSession({ sessionId: input.destination.sessionId });
      const before = latestSnapshots.get(session.key) ?? await captureSessionSnapshot(session);
      const outcome = await protectedFields.deliver(session, input);
      if (input.destination.submit === undefined || outcome.submission === "not-requested") return;
      protectedFields.beginSettlement(input.destination);
      const snapshot = await settleAction({
        session,
        before,
        actionInput: { signal: input.signal },
        capture: async () => await captureProtectedSettlementSnapshot(session, input.signal),
      });
      let challengeCurrent: boolean | undefined;
      if (
        protectedFields.isSensitive(session.key) &&
        snapshot.identity.documentEpoch <= input.destination.identity!.documentEpoch
      ) {
        const raw = withSessionTab(session, await session.supervisor.getSnapshot(session.key));
        challengeCurrent = protectedChallengePresent(raw, input.kind);
      }
      await protectedFields.settle(session, input, {
        before,
        snapshot,
        fallbackChallengeCurrent: challengeCurrent,
        captureAfterDeparture: async () => await captureProtectedSettlementSnapshot(session, input.signal),
      });
    },
    abortProtectedFieldGroup: async (destinations) => {
      const sessionId = destinations[0]?.sessionId;
      let currentIdentity: BrowserStateIdentity | undefined;
      if (sessionId !== undefined && destinations.every((destination) => destination.sessionId === sessionId)) {
        try {
          const session = await getSession({ sessionId });
          currentIdentity = (await captureProtectedSettlementSnapshot(session)).identity;
        } catch {
          // The controller still verifies its bound document before attempting cleanup.
        }
      }
      await protectedFields.abort(destinations, currentIdentity);
    },
    takeProtectedFieldDeliveryResult: (destination) => protectedFields.takeDeliveryResult(destination),
    releaseProtectedField: async (destination) => {
      await protectedFields.release(destination);
    },
    isSensitiveInputActive: (sessionId) => protectedFields.isSensitive(sessionId),
    dialog: async (input = {}) => {
      const session = await getSession(input);
      const before = latestSnapshots.get(session.key) ?? await captureSessionSnapshot(session);
      await session.supervisor.respondToDialog({
        accept: input.action !== "dismiss",
        promptText: input.promptText
      });
      return settleAction({ session, before, actionInput: input });
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

function protectedChallengePresent(
  snapshot: BrowserSnapshotInput,
  kind: BrowserProtectedFieldDeliveryInput["kind"]
): boolean | undefined {
  if (snapshot.elements === undefined) return undefined;
  if (kind !== "one-time-code") return undefined;
  return snapshot.elements.some((element) => {
    if (element.hidden === true || element.disabled === true) return false;
    const hint = [element.name, element.label, element.text]
      .filter((value): value is string => typeof value === "string")
      .join(" ")
      .normalize("NFKC")
      .toLocaleLowerCase("en-US");
    return /one[ _-]?time|otp|authenticator|verification[ _-]?code|security[ _-]?code/iu.test(hint);
  });
}

function withSessionTab(
  session: ManagedBackendSession,
  snapshot: BackendRawSnapshot,
  openedTabs: BrowserTab[] = []
): BackendRawSnapshot {
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
    return `(() => { const el = window.__estacodaElements?.[${index}]; if (!el || !el.isConnected) throw new Error('Browser element ref not found: ${ref ?? ""}'); if (el.matches(':disabled,[aria-disabled="true"]')) throw new Error('Browser element is disabled: ${ref ?? ""}'); const style = getComputedStyle(el); if (style.display === 'none' || style.visibility === 'hidden' || el.getClientRects().length === 0) throw new Error('Browser element is hidden: ${ref ?? ""}'); el.click(); return 'clicked'; })()`;
  }
  return `(() => { const el = window.__estacodaElements?.[${index}]; if (!el || !el.isConnected) throw new Error('Browser element ref not found: ${ref ?? ""}'); if (el.matches(':disabled,[aria-disabled="true"]')) throw new Error('Browser element is disabled: ${ref ?? ""}'); const style = getComputedStyle(el); if (style.display === 'none' || style.visibility === 'hidden' || el.getClientRects().length === 0) throw new Error('Browser element is hidden: ${ref ?? ""}'); if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement) && !el.isContentEditable) throw new Error('Browser target does not accept text: ${ref ?? ""}'); el.focus(); if (el.isContentEditable) el.textContent = ${JSON.stringify(text)}; else el.value = ${JSON.stringify(text)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return 'typed'; })()`;
}

function selectActionExpression(ref: string | undefined, value: string): string {
  const index = refToIndex(ref);
  return `(() => {
    const el = window.__estacodaElements?.[${index}];
    if (!el || !el.isConnected) throw new Error('Browser element ref not found: ${ref ?? ""}');
    if (el.matches(':disabled,[aria-disabled="true"]')) throw new Error('Browser element is disabled: ${ref ?? ""}');
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || el.getClientRects().length === 0) throw new Error('Browser element is hidden: ${ref ?? ""}');
    if (!(el instanceof HTMLSelectElement)) throw new Error('Browser target is not a select element: ${ref ?? ""}');
    const requested = ${JSON.stringify(value)};
    const option = Array.from(el.options).find((entry) => entry.value === requested || entry.text.trim() === requested);
    if (!option) throw new Error('Browser select option not found');
    el.value = option.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return 'selected';
  })()`;
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

function isTransientNavigationObservationError(error: unknown): boolean {
  return /execution context was destroyed|cannot find (?:context|execution context)|context with specified id|no frame with given id|inspected target navigated|target closed|session closed/iu
    .test(errorMessage(error));
}

async function abortableProtectedSettlementDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error("Protected browser settlement was cancelled."));
      return;
    }
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new Error("Protected browser settlement was cancelled."));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function requireSessionId(sessionId: string | undefined): string {
  if (sessionId === undefined || sessionId.trim().length === 0) {
    throw new Error("Browser sessionId is required for supervised local CDP operations.");
  }
  return sessionId;
}

function originForUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : "null";
  } catch {
    return "null";
  }
}

async function checkLocalCdpStatus(endpoint: string | undefined, fetchLike: CdpFetchLike | undefined): Promise<BrowserBackendStatus> {
  if (endpoint === undefined) {
    return {
      backend: "local-cdp",
      available: false,
      sessionState: "browser_process_missing",
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
        sessionState: "browser_process_missing",
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
      sessionState: "backend_available",
      browser: payload.Browser,
      version: payload["Protocol-Version"]
    };
  } catch (error) {
    return {
      backend: "local-cdp",
      available: false,
      endpoint,
      sessionState: "browser_process_missing",
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
