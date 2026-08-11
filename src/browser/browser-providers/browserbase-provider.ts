import type {
  BrowserActionInput,
  BrowserBackend,
  BrowserBackendStatus,
  BrowserConsoleEntry,
  BrowserNavigateInput,
  BrowserNavigateResult,
  BrowserScreenshotResult,
  BrowserSnapshot
} from "../../contracts/browser.js";
import type { LoadedRuntimeConfig } from "../../config/runtime-config.js";
import type { CdpFetchLike, CdpWebSocketFactory } from "../cdp-client.js";
import type { BrowserProvider, ProviderAvailability } from "../browser-provider.js";
import type { ResolveHostnameFn } from "../url-safety.js";
import { createSupervisedLocalCdpBrowserBackend, type SupervisedLocalCdpBackendOptions } from "../supervised-local-cdp-backend.js";
import { BrowserbaseClient, type BrowserbaseSession } from "./browserbase-client.js";

export type BrowserbaseClientLike = {
  createSession(): Promise<BrowserbaseSession>;
  closeSession(sessionId: string): Promise<void>;
};

export type BrowserbaseBrowserBackendOptions = {
  apiKey?: string;
  projectId?: string;
  cloudSpendApproved?: "pending" | boolean;
  cloudFallback?: boolean;
  cdpUrl?: string;
  launchCommand?: string;
  launchExecutable?: string;
  launchArgs?: string[];
  chromeFlags?: string[];
  autoLaunch?: boolean;
  headless?: boolean;
  fetch?: CdpFetchLike;
  webSocketFactory?: CdpWebSocketFactory;
  browserbaseFetch?: typeof globalThis.fetch;
  securityConfig?: Pick<LoadedRuntimeConfig["security"], "allowPrivateUrls" | "websiteBlocklist">;
  resolveHostname?: ResolveHostnameFn;
  client?: BrowserbaseClientLike;
  createClient?: (options: { apiKey: string; projectId: string }) => BrowserbaseClientLike;
  createSupervisedBackend?: (options: SupervisedLocalCdpBackendOptions) => BrowserBackend;
  log?: (event: string, metadata?: Record<string, unknown>) => void;
};

type ClosableBrowserBackend = BrowserBackend & {
  close?: () => void | Promise<void>;
  closeSession?: (sessionId: string) => void | Promise<void>;
};

type ActiveMode = "cloud" | "fallback";

type ActiveBackend = {
  mode: ActiveMode;
  backend: ClosableBrowserBackend;
};

type CloudSessionState = {
  session: BrowserbaseSession;
  backend: ClosableBrowserBackend;
};

type FallbackMetadata = {
  fallbackFromCloud: true;
  fallbackProvider: "browserbase";
  fallbackReason: string;
};

const CLOUD_SPEND_APPROVAL_ERROR = "Browserbase cloud browser sessions may incur charges and require browser.cloudSpendApproved: true before EstaCoda can create a cloud session.";

export const browserbaseProvider: BrowserProvider = {
  name: "browserbase",
  displayName: "Browserbase",
  getAvailability: () => getBrowserbaseAvailability(),
  async createSession() {
    throw new Error("Browserbase sessions must be created through the browser backend so browser.cloudSpendApproved can be enforced.");
  },
  async closeSession(providerSessionId) {
    const apiKey = process.env.BROWSERBASE_API_KEY;
    const projectId = process.env.BROWSERBASE_PROJECT_ID;
    const availability = getBrowserbaseAvailability({ apiKey, projectId });
    if (!availability.available) {
      return false;
    }
    await new BrowserbaseClient({
      apiKey: apiKey ?? "",
      projectId: projectId ?? ""
    }).closeSession(providerSessionId);
    return true;
  },
  emergencyCleanup: () => undefined
};

export function getBrowserbaseAvailability(input: {
  apiKey?: string;
  projectId?: string;
} = {}): ProviderAvailability {
  const apiKey = input.apiKey ?? process.env.BROWSERBASE_API_KEY;
  const projectId = input.projectId ?? process.env.BROWSERBASE_PROJECT_ID;
  const missing = [
    apiKey === undefined || apiKey.trim() === "" ? "BROWSERBASE_API_KEY" : undefined,
    projectId === undefined || projectId.trim() === "" ? "BROWSERBASE_PROJECT_ID" : undefined
  ].filter((name): name is string => name !== undefined);

  return missing.length > 0
    ? { available: false, reason: `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing.` }
    : { available: true };
}

export function createBrowserbaseBrowserBackend(options: BrowserbaseBrowserBackendOptions = {}): BrowserBackend {
  const cloudFallback = options.cloudFallback ?? true;
  const createSupervisedBackend = options.createSupervisedBackend ?? createSupervisedLocalCdpBrowserBackend;
  let cloudSession: CloudSessionState | undefined;
  let fallbackBackend: ClosableBrowserBackend | undefined;
  let activeBackend: ActiveBackend | undefined;
  let latestFallbackMetadata: FallbackMetadata | undefined;
  let closed = false;

  const createLocalFallbackBackend = (): ClosableBrowserBackend => {
    fallbackBackend ??= createSupervisedBackend({
      cdpUrl: options.cdpUrl,
      launchCommand: options.launchCommand,
      launchExecutable: options.launchExecutable,
      launchArgs: options.launchArgs,
      chromeFlags: options.chromeFlags,
      autoLaunch: options.autoLaunch,
      headless: options.headless,
      fetch: options.fetch,
      webSocketFactory: options.webSocketFactory,
      securityConfig: options.securityConfig,
      resolveHostname: options.resolveHostname
    }) as ClosableBrowserBackend;
    return fallbackBackend;
  };

  const fallbackFromCloud = async <T>(error: unknown, run: (backend: ClosableBrowserBackend) => Promise<T>): Promise<T> => {
    const metadata = safeFallbackMetadata(error);
    latestFallbackMetadata = metadata;
    options.log?.("browserbase.fallback", metadata);
    activeBackend = {
      mode: "fallback",
      backend: createLocalFallbackBackend()
    };
    return await run(activeBackend.backend);
  };

  const createCloudClient = (): BrowserbaseClientLike => {
    if (options.client !== undefined) {
      return options.client;
    }

    const apiKey = options.apiKey ?? process.env.BROWSERBASE_API_KEY;
    const projectId = options.projectId ?? process.env.BROWSERBASE_PROJECT_ID;
    if (options.createClient !== undefined) {
      return options.createClient({
        apiKey: apiKey ?? "",
        projectId: projectId ?? ""
      });
    }
    return new BrowserbaseClient({
      apiKey: apiKey ?? "",
      projectId: projectId ?? "",
      fetch: options.browserbaseFetch
    });
  };

  const ensureCloudBackend = async (): Promise<ClosableBrowserBackend> => {
    if (options.cloudSpendApproved !== true) {
      throw new Error(CLOUD_SPEND_APPROVAL_ERROR);
    }
    if (cloudSession !== undefined) {
      activeBackend = { mode: "cloud", backend: cloudSession.backend };
      return cloudSession.backend;
    }

    const client = createCloudClient();
    const session = await client.createSession();
    const backend = createSupervisedBackend({
      cdpUrl: session.cdpUrl,
      autoLaunch: false,
      fetch: options.fetch,
      webSocketFactory: options.webSocketFactory,
      securityConfig: options.securityConfig,
      resolveHostname: options.resolveHostname
    }) as ClosableBrowserBackend;

    cloudSession = { session, backend };
    activeBackend = { mode: "cloud", backend };
    return backend;
  };

  const runWithBackend = async <T>(run: (backend: ClosableBrowserBackend) => Promise<T>): Promise<T> => {
    if (closed) {
      throw new Error("Browserbase browser backend is closed.");
    }
    if (activeBackend?.mode === "fallback") {
      return await run(activeBackend.backend);
    }

    let backend: ClosableBrowserBackend;
    try {
      backend = await ensureCloudBackend();
    } catch (error) {
      if (isCloudSpendApprovalError(error) || cloudFallback !== true) {
        throw error;
      }
      return await fallbackFromCloud(error, run);
    }

    try {
      return await run(backend);
    } catch (error) {
      if (cloudSession !== undefined) {
        await closeCloudSession().catch(() => undefined);
      }
      if (cloudFallback !== true) {
        throw error;
      }
      return await fallbackFromCloud(error, run);
    }
  };

  const closeCloudSession = async (): Promise<void> => {
    const state = cloudSession;
    cloudSession = undefined;
    let firstError: unknown;
    if (state?.backend.close !== undefined) {
      try {
        await state.backend.close();
      } catch (error) {
        firstError ??= error;
      }
    }
    if (state !== undefined) {
      try {
        await createCloudClient().closeSession(state.session.id);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) {
      throw firstError;
    }
  };

  const closeFallback = async (): Promise<void> => {
    const backend = fallbackBackend;
    fallbackBackend = undefined;
    if (backend?.close !== undefined) {
      await backend.close();
    }
  };

  const mapNavigateResult = (result: BrowserNavigateResult): BrowserNavigateResult => ({
    ...result,
    session: {
      ...result.session,
      backend: activeBackend?.mode === "fallback" ? result.session.backend : "browserbase"
    },
    metadata: {
      ...(result.metadata ?? {}),
      ...(activeBackend?.mode === "fallback" ? latestFallbackMetadata : undefined)
    }
  });

  const backend: BrowserBackend & {
    close(): Promise<void>;
    closeSession(sessionId: string): Promise<void>;
  } = {
    kind: "browserbase",
    isAvailable: async () => getBrowserbaseAvailability({
      apiKey: options.apiKey,
      projectId: options.projectId
    }).available && options.cloudSpendApproved === true,
    status: async (): Promise<BrowserBackendStatus> => {
      const availability = getBrowserbaseAvailability({
        apiKey: options.apiKey,
        projectId: options.projectId
      });
      return {
        backend: "browserbase",
        available: availability.available && options.cloudSpendApproved === true,
        reason: availability.available
          ? options.cloudSpendApproved === true ? undefined : CLOUD_SPEND_APPROVAL_ERROR
          : availability.reason,
        ...(latestFallbackMetadata ?? {})
      };
    },
    navigate: async (input: BrowserNavigateInput): Promise<BrowserNavigateResult> => mapNavigateResult(
      await runWithBackend((delegate) => delegate.navigate(input))
    ),
    snapshot: (input) => runWithBackend((delegate) => requiredMethod(delegate.snapshot, "snapshot")(input)),
    click: (input) => runWithBackend((delegate) => requiredMethod(delegate.click, "click")(input)),
    type: (input) => runWithBackend((delegate) => requiredMethod(delegate.type, "type")(input)),
    scroll: (input) => runWithBackend((delegate) => requiredMethod(delegate.scroll, "scroll")(input)),
    press: (input) => runWithBackend((delegate) => requiredMethod(delegate.press, "press")(input)),
    back: (input = {}) => runWithBackend((delegate) => requiredMethod(delegate.back, "back")(input)),
    getImages: (input = {}) => runWithBackend((delegate) => requiredMethod(delegate.getImages, "getImages")(input)),
    console: (input = {}): Promise<BrowserConsoleEntry[]> => runWithBackend((delegate) => requiredMethod(delegate.console, "console")(input)),
    cdp: (input) => runWithBackend((delegate) => requiredMethod(delegate.cdp, "cdp")(input)),
    screenshot: (input = {}): Promise<BrowserScreenshotResult> => runWithBackend((delegate) => requiredMethod(delegate.screenshot, "screenshot")(input)),
    dialog: (input = {}): Promise<BrowserSnapshot> => runWithBackend((delegate) => requiredMethod(delegate.dialog, "dialog")(input)),
    closeSession: async (sessionId: string): Promise<void> => {
      const delegate = activeBackend?.backend;
      if (delegate?.closeSession !== undefined) {
        await delegate.closeSession(sessionId);
      }
    },
    close: async (): Promise<void> => {
      if (closed) {
        return;
      }
      closed = true;
      let firstError: unknown;
      try {
        await closeCloudSession();
      } catch (error) {
        firstError ??= error;
      }
      try {
        await closeFallback();
      } catch (error) {
        firstError ??= error;
      }
      activeBackend = undefined;
      if (firstError !== undefined) {
        throw firstError;
      }
    }
  };

  return backend;
}

function requiredMethod<T extends (...args: never[]) => Promise<unknown>>(method: T | undefined, name: string): T {
  if (method === undefined) {
    throw new Error(`Browserbase delegate backend does not support ${name}.`);
  }
  return method;
}

function safeFallbackMetadata(error: unknown): FallbackMetadata {
  return {
    fallbackFromCloud: true,
    fallbackProvider: "browserbase",
    fallbackReason: safeFallbackReason(error)
  };
}

function safeFallbackReason(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const normalized = message.toLowerCase();
  if (normalized.includes("network")) {
    return "Browserbase network error.";
  }
  if (normalized.includes("rate limit")) {
    return "Browserbase rate limit error.";
  }
  if (normalized.includes("authentication")) {
    return "Browserbase authentication error.";
  }
  if (normalized.includes("server error")) {
    return "Browserbase server error.";
  }
  if (normalized.includes("connecturl")) {
    return "Browserbase create session response is missing connectUrl.";
  }
  if (normalized.includes("session id")) {
    return "Browserbase create session response is missing session id.";
  }
  if (normalized.includes("malformed json")) {
    return "Browserbase returned malformed JSON.";
  }
  if (normalized.includes("api key") || normalized.includes("project id")) {
    return "Browserbase credentials are not configured.";
  }
  return "Browserbase session could not be created.";
}

function isCloudSpendApprovalError(error: unknown): boolean {
  return error instanceof Error && error.message === CLOUD_SPEND_APPROVAL_ERROR;
}
