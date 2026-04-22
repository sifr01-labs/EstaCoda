import type { BrowserBackend, BrowserBackendStatus, BrowserNavigateInput, BrowserNavigateResult } from "../contracts/browser.js";

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
  return {
    kind: "mock",
    isAvailable: () => true,
    status: () => ({
      backend: "mock",
      available: true,
      browser: input.title ?? "Mock Browser"
    }),
    async navigate(request) {
      const sessionId = request.sessionId ?? input.sessionId ?? "mock-browser-session";

      return {
        session: {
          id: sessionId,
          backend: "mock",
          currentUrl: request.url,
          createdAt: new Date("2026-04-18T00:00:00.000Z").toISOString()
        },
        snapshot: {
          sessionId,
          url: request.url,
          title: input.title ?? "Mock Browser Page",
          text: input.text ?? `Mock browser snapshot for ${request.url}.`,
          elements: []
        }
      };
    }
  };
}

export type LocalCdpBrowserBackendOptions = {
  cdpUrl?: string;
  launchCommand?: string;
  autoLaunch?: boolean;
  fetch?: CdpFetchLike;
  webSocketFactory?: CdpWebSocketFactory;
};

export type CdpFetchLike = (url: string, init?: {
  method?: string;
  signal?: AbortSignal;
}) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export type CdpWebSocketEvent = {
  data?: unknown;
};

export type CdpWebSocketLike = {
  readonly readyState?: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "error" | "close", listener: (event: CdpWebSocketEvent) => void, options?: {
    once?: boolean;
  }): void;
};

export type CdpWebSocketFactory = (url: string) => CdpWebSocketLike;

export function createLocalCdpBrowserBackend(options: LocalCdpBrowserBackendOptions = {}): BrowserBackend {
  const endpoint = normalizeCdpUrl(options.cdpUrl);

  return {
    kind: "local-cdp",
    isAvailable: async () => (await checkLocalCdpStatus(endpoint, options.fetch)).available,
    status: () => checkLocalCdpStatus(endpoint, options.fetch),
    async navigate(input) {
      return navigateWithLocalCdp({
        endpoint,
        input,
        fetch: options.fetch,
        webSocketFactory: options.webSocketFactory
      });
    }
  };
}

async function navigateWithLocalCdp(input: {
  endpoint: string | undefined;
  input: BrowserNavigateInput;
  fetch: CdpFetchLike | undefined;
  webSocketFactory: CdpWebSocketFactory | undefined;
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
    await client.send("Page.navigate", {
      url: input.input.url
    });
    await client.waitFor("Page.loadEventFired", 5_000).catch(() => undefined);

    const evaluated = await client.send("Runtime.evaluate", {
      expression: [
        "JSON.stringify({",
        "url: location.href,",
        "title: document.title,",
        "text: (document.body && document.body.innerText ? document.body.innerText : '').slice(0, 12000)",
        "})"
      ].join(""),
      returnByValue: true
    }) as {
      result?: {
        value?: unknown;
      };
    };
    const snapshot = parseEvaluatedSnapshot(evaluated.result?.value, target.url ?? input.input.url);
    const sessionId = input.input.sessionId ?? target.id ?? `cdp-${Date.now()}`;

    return {
      session: {
        id: sessionId,
        backend: "local-cdp",
        currentUrl: snapshot.url,
        createdAt: new Date().toISOString()
      },
      snapshot: {
        sessionId,
        url: snapshot.url,
        title: snapshot.title,
        text: snapshot.text,
        elements: []
      }
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

async function connectCdp(input: {
  webSocketUrl: string;
  webSocketFactory: CdpWebSocketFactory | undefined;
}): Promise<CdpClient> {
  const factory = input.webSocketFactory ?? ((url) => {
    if (typeof WebSocket === "undefined") {
      throw new Error("WebSocket is not available in this runtime.");
    }

    return new WebSocket(url) as unknown as CdpWebSocketLike;
  });
  const socket = factory(input.webSocketUrl);

  await new Promise<void>((resolve, reject) => {
    if (socket.readyState === 1) {
      resolve();
      return;
    }

    const timeout = setTimeout(() => reject(new Error("Timed out while connecting to CDP WebSocket.")), 5_000);
    socket.addEventListener("open", () => {
      clearTimeout(timeout);
      resolve();
    }, {
      once: true
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("CDP WebSocket connection failed."));
    }, {
      once: true
    });
  });

  return new CdpClient(socket);
}

class CdpClient {
  #nextId = 1;
  #pending = new Map<number, {
    resolve(value: unknown): void;
    reject(error: Error): void;
  }>();
  #eventWaiters = new Map<string, Array<() => void>>();

  constructor(private readonly socket: CdpWebSocketLike) {
    this.socket.addEventListener("message", (event) => {
      this.#handleMessage(event.data);
    });
    this.socket.addEventListener("close", () => {
      this.#rejectAll(new Error("CDP WebSocket closed."));
    });
    this.socket.addEventListener("error", () => {
      this.#rejectAll(new Error("CDP WebSocket errored."));
    });
  }

  send(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.#nextId++;

    return new Promise((resolve, reject) => {
      this.#pending.set(id, {
        resolve,
        reject
      });
      this.socket.send(JSON.stringify({
        id,
        method,
        params
      }));
    });
  }

  waitFor(method: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timed out waiting for ${method}.`));
      }, timeoutMs);
      const waiter = () => {
        clearTimeout(timeout);
        resolve();
      };
      const waiters = this.#eventWaiters.get(method) ?? [];

      waiters.push(waiter);
      this.#eventWaiters.set(method, waiters);
    });
  }

  close(): void {
    this.socket.close();
  }

  #handleMessage(raw: unknown): void {
    const text = typeof raw === "string" ? raw : raw instanceof ArrayBuffer ? new TextDecoder().decode(raw) : String(raw ?? "");

    if (text.length === 0) {
      return;
    }

    const message = JSON.parse(text) as {
      id?: number;
      method?: string;
      result?: unknown;
      error?: {
        message?: string;
      };
    };

    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);

      if (pending === undefined) {
        return;
      }

      this.#pending.delete(message.id);

      if (message.error !== undefined) {
        pending.reject(new Error(message.error.message ?? "CDP command failed."));
        return;
      }

      pending.resolve(message.result);
      return;
    }

    if (message.method !== undefined) {
      const waiters = this.#eventWaiters.get(message.method) ?? [];

      this.#eventWaiters.delete(message.method);

      for (const waiter of waiters) {
        waiter();
      }
    }
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }

    this.#pending.clear();
  }
}

function parseEvaluatedSnapshot(value: unknown, fallbackUrl: string): {
  url: string;
  title?: string;
  text: string;
} {
  if (typeof value !== "string") {
    return {
      url: fallbackUrl,
      text: ""
    };
  }

  try {
    const parsed = JSON.parse(value) as {
      url?: string;
      title?: string;
      text?: string;
    };

    return {
      url: parsed.url ?? fallbackUrl,
      title: parsed.title,
      text: parsed.text ?? ""
    };
  } catch {
    return {
      url: fallbackUrl,
      text: value
    };
  }
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

export function createBrowserBackendFromConfig(config: {
  backend: "local-cdp" | "browserbase" | "firecrawl" | "camofox" | "mock" | "unconfigured";
  cdpUrl?: string;
  launchCommand?: string;
  autoLaunch?: boolean;
  fetch?: CdpFetchLike;
  webSocketFactory?: CdpWebSocketFactory;
}): BrowserBackend {
  switch (config.backend) {
    case "local-cdp":
      return createLocalCdpBrowserBackend({
        cdpUrl: config.cdpUrl,
        launchCommand: config.launchCommand,
        autoLaunch: config.autoLaunch,
        fetch: config.fetch,
        webSocketFactory: config.webSocketFactory
      });
    case "unconfigured":
      return createUnconfiguredBrowserBackend();
    default:
      return createUnconfiguredBrowserBackend({
        reason: `${config.backend} browser backend is not implemented in v2 yet.`
      });
  }
}
