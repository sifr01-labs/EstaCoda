import { connectCdp, type CdpFetchLike } from "./cdp-client.js";
import { CDPSupervisor, type CDPSupervisorOptions } from "./cdp-supervisor.js";

export type CdpTargetSupervisorOptions = CDPSupervisorOptions;

export interface CdpClientLike {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

export interface CdpTargetSupervisor {
  close(): void | Promise<void>;
}

export interface CdpTargetManagerOptions {
  endpoint: string;
  createClient?: (webSocketUrl: string) => Promise<CdpClientLike>;
  fetch?: CdpFetchLike;
  supervisorFactory?: (options: CdpTargetSupervisorOptions) => Promise<CdpTargetSupervisor>;
}

export interface ManagedCdpTarget {
  browserContextId: string;
  targetId: string;
  pageWebSocketDebuggerUrl: string;
  supervisor: CdpTargetSupervisor;
  close: () => Promise<void>;
}

export interface CdpPageTarget {
  browserContextId: string;
  targetId: string;
  pageWebSocketDebuggerUrl: string;
  url: string;
  title?: string;
  openerId?: string;
}

export interface AttachedCdpTarget extends CdpPageTarget {
  supervisor: CdpTargetSupervisor;
  close: () => Promise<void>;
}

type VersionPayload = {
  webSocketDebuggerUrl?: unknown;
};

type ListEntry = {
  id?: unknown;
  webSocketDebuggerUrl?: unknown;
};

type TargetInfo = {
  targetId?: unknown;
  type?: unknown;
  title?: unknown;
  url?: unknown;
  browserContextId?: unknown;
  openerId?: unknown;
};

export class CdpTargetManager {
  readonly #endpoint: string;
  readonly #fetch: CdpFetchLike;
  readonly #createClient: (webSocketUrl: string) => Promise<CdpClientLike>;
  readonly #supervisorFactory: (options: CdpTargetSupervisorOptions) => Promise<CdpTargetSupervisor>;
  readonly #targets = new Set<ManagedTargetHandle>();
  #browserClient: CdpClientLike | undefined;
  #browserClientPromise: Promise<CdpClientLike> | undefined;
  #closed = false;

  constructor(options: CdpTargetManagerOptions) {
    this.#endpoint = normalizeEndpoint(options.endpoint);
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#createClient = options.createClient ?? (async (webSocketUrl) => connectCdp({
      webSocketUrl,
      webSocketFactory: undefined
    }));
    this.#supervisorFactory = options.supervisorFactory ?? defaultSupervisorFactory;
  }

  async createTarget(): Promise<ManagedCdpTarget> {
    if (this.#closed) {
      throw new Error("CDP target manager is closed.");
    }

    const client = await this.#getBrowserClient();
    let browserContextId: string | undefined;
    let targetId: string | undefined;
    let supervisor: CdpTargetSupervisor | undefined;

    try {
      browserContextId = await sendRequiredStringResult(
        client,
        "Target.createBrowserContext",
        undefined,
        "browserContextId",
        "Target.createBrowserContext"
      );
      targetId = await sendRequiredStringResult(
        client,
        "Target.createTarget",
        {
          url: "about:blank",
          browserContextId
        },
        "targetId",
        "Target.createTarget"
      );

      const pageWebSocketDebuggerUrl = await this.#findPageWebSocketDebuggerUrl(targetId);
      supervisor = await this.#createPageSupervisor(pageWebSocketDebuggerUrl);
      const handle = new ManagedTargetHandle({
        browserContextId,
        targetId,
        pageWebSocketDebuggerUrl,
        supervisor,
        cleanup: async () => {
          await cleanupTarget({
            client,
            browserContextId,
            targetId,
            supervisor
          });
          this.#targets.delete(handle);
        }
      });

      this.#targets.add(handle);
      return handle;
    } catch (error) {
      await cleanupTarget({
        client,
        browserContextId,
        targetId,
        supervisor
      }).catch(() => undefined);
      throw error;
    }
  }

  async createPageTarget(browserContextId: string, url: string): Promise<CdpPageTarget> {
    if (this.#closed) throw new Error("CDP target manager is closed.");
    const contextId = requireNonEmptyString(browserContextId, "browserContextId");
    const destination = requireNonEmptyString(url, "url");
    const client = await this.#getBrowserClient();
    const targetId = await sendRequiredStringResult(
      client,
      "Target.createTarget",
      { url: destination, browserContextId: contextId },
      "targetId",
      "Target.createTarget"
    );
    try {
      const pageWebSocketDebuggerUrl = await this.#findPageWebSocketDebuggerUrl(targetId);
      const info = (await this.#fetchTargetInfos()).find((candidate) => candidate.targetId === targetId);
      if (info?.browserContextId !== contextId || info.type !== "page") {
        throw new Error(`Created CDP target ${targetId} was not a page in browser context ${contextId}.`);
      }
      return {
        browserContextId: contextId,
        targetId,
        pageWebSocketDebuggerUrl,
        url: typeof info.url === "string" ? info.url : destination,
        ...(typeof info.title === "string" && info.title.trim() !== "" ? { title: info.title } : {}),
        ...(typeof info.openerId === "string" && info.openerId.trim() !== "" ? { openerId: info.openerId } : {})
      };
    } catch (error) {
      await client.send("Target.closeTarget", { targetId }).catch(() => undefined);
      throw error;
    }
  }

  async closePageTarget(browserContextId: string, targetId: string): Promise<void> {
    const contextId = requireNonEmptyString(browserContextId, "browserContextId");
    const requestedTargetId = requireNonEmptyString(targetId, "targetId");
    const target = (await this.listPageTargets(contextId)).find((entry) => entry.targetId === requestedTargetId);
    if (target === undefined) {
      throw new Error(`CDP page target ${requestedTargetId} is not available in browser context ${contextId}.`);
    }
    await (await this.#getBrowserClient()).send("Target.closeTarget", { targetId: requestedTargetId });
  }

  async listPageTargets(browserContextId: string): Promise<CdpPageTarget[]> {
    if (this.#closed) {
      throw new Error("CDP target manager is closed.");
    }
    const contextId = requireNonEmptyString(browserContextId, "browserContextId");
    const [targetInfos, entries] = await Promise.all([
      this.#fetchTargetInfos(),
      this.#fetchTargetList()
    ]);
    const webSocketUrls = new Map(entries.flatMap((entry) => (
      typeof entry.id === "string" &&
      typeof entry.webSocketDebuggerUrl === "string" &&
      entry.webSocketDebuggerUrl.trim() !== ""
        ? [[entry.id, entry.webSocketDebuggerUrl] as const]
        : []
    )));
    return targetInfos.flatMap((targetInfo) => {
      const pageWebSocketDebuggerUrl = typeof targetInfo.targetId === "string"
        ? webSocketUrls.get(targetInfo.targetId)
        : undefined;
      if (
        targetInfo.type !== "page" ||
        targetInfo.browserContextId !== contextId ||
        typeof targetInfo.targetId !== "string" ||
        targetInfo.targetId.trim() === "" ||
        typeof targetInfo.url !== "string" ||
        pageWebSocketDebuggerUrl === undefined
      ) {
        return [];
      }
      return [{
        browserContextId: contextId,
        targetId: targetInfo.targetId,
        pageWebSocketDebuggerUrl,
        url: targetInfo.url,
        ...(typeof targetInfo.title === "string" && targetInfo.title.trim() !== "" ? { title: targetInfo.title } : {}),
        ...(typeof targetInfo.openerId === "string" && targetInfo.openerId.trim() !== "" ? { openerId: targetInfo.openerId } : {})
      }];
    });
  }

  async findVisiblePageTargetId(browserContextId: string, preferredTargetId?: string): Promise<string | undefined> {
    const targets = await this.listPageTargets(browserContextId);
    const ordered = preferredTargetId === undefined
      ? targets
      : [
          ...targets.filter((target) => target.targetId === preferredTargetId),
          ...targets.filter((target) => target.targetId !== preferredTargetId)
        ];
    for (const target of ordered.slice(0, 16)) {
      let client: CdpClientLike | undefined;
      try {
        client = await this.#createClient(target.pageWebSocketDebuggerUrl);
        const result = await client.send("Runtime.evaluate", {
          expression: "document.visibilityState",
          returnByValue: true
        });
        if (runtimeEvaluationValue(result) === "visible") return target.targetId;
      } catch {
        // A closing or transient target is ignored; no page content is read.
      } finally {
        client?.close();
      }
    }
    return undefined;
  }

  async attachTarget(browserContextId: string, targetId: string): Promise<AttachedCdpTarget> {
    const contextId = requireNonEmptyString(browserContextId, "browserContextId");
    const requestedTargetId = requireNonEmptyString(targetId, "targetId");
    const target = (await this.listPageTargets(contextId)).find((entry) => entry.targetId === requestedTargetId);
    if (target === undefined) {
      throw new Error(`CDP page target ${requestedTargetId} is not available in browser context ${contextId}.`);
    }
    const supervisor = await this.#createPageSupervisor(target.pageWebSocketDebuggerUrl);
    let closed = false;
    return {
      ...target,
      supervisor,
      close: async () => {
        if (closed) return;
        closed = true;
        await supervisor.close();
      }
    };
  }

  async activateTarget(browserContextId: string, targetId: string): Promise<void> {
    const contextId = requireNonEmptyString(browserContextId, "browserContextId");
    const requestedTargetId = requireNonEmptyString(targetId, "targetId");
    const target = (await this.listPageTargets(contextId)).find((entry) => entry.targetId === requestedTargetId);
    if (target === undefined) {
      throw new Error(`CDP page target ${requestedTargetId} is not available in browser context ${contextId}.`);
    }
    const client = await this.#getBrowserClient();
    await client.send("Target.activateTarget", { targetId: requestedTargetId });
  }

  async close(): Promise<void> {
    if (this.#closed && this.#browserClient === undefined) {
      return;
    }

    this.#closed = true;
    const targets = [...this.#targets];
    await Promise.all(targets.map((target) => target.close()));
    this.#targets.clear();
    this.#browserClient?.close();
    this.#browserClient = undefined;
    this.#browserClientPromise = undefined;
  }

  async #getBrowserClient(): Promise<CdpClientLike> {
    if (this.#browserClient !== undefined) {
      return this.#browserClient;
    }
    if (this.#browserClientPromise !== undefined) {
      return this.#browserClientPromise;
    }

    this.#browserClientPromise = (async () => {
      const webSocketUrl = await this.#fetchBrowserWebSocketDebuggerUrl();
      let client: CdpClientLike;
      try {
        client = await this.#createClient(webSocketUrl);
      } catch (error) {
        throw new Error(`Failed to connect to browser CDP websocket from ${this.#endpoint}/json/version: ${errorMessage(error)}`, {
          cause: error
        });
      }
      this.#browserClient = client;
      return client;
    })();

    try {
      return await this.#browserClientPromise;
    } finally {
      this.#browserClientPromise = undefined;
    }
  }

  async #fetchBrowserWebSocketDebuggerUrl(): Promise<string> {
    const versionUrl = `${this.#endpoint}/json/version`;
    const response = await this.#fetch(versionUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch CDP browser version from ${versionUrl}: HTTP ${response.status} ${response.statusText}`);
    }
    const payload = await response.json();
    if (!isRecord(payload)) {
      throw new Error(`CDP browser version from ${versionUrl} did not include a usable webSocketDebuggerUrl.`);
    }
    const webSocketUrl = payload.webSocketDebuggerUrl;
    if (typeof webSocketUrl !== "string" || webSocketUrl.trim() === "") {
      throw new Error(`CDP browser version from ${versionUrl} did not include a usable webSocketDebuggerUrl.`);
    }
    return webSocketUrl;
  }

  async #findPageWebSocketDebuggerUrl(targetId: string): Promise<string> {
    const listUrl = `${this.#endpoint}/json/list`;
    const entry = (await this.#fetchTargetList()).find((candidate) => candidate.id === targetId);
    if (entry === undefined) {
      throw new Error(`CDP target list from ${listUrl} did not include created target ${targetId}.`);
    }
    if (typeof entry.webSocketDebuggerUrl !== "string" || entry.webSocketDebuggerUrl.trim() === "") {
      throw new Error(`CDP target ${targetId} from ${listUrl} did not include a usable webSocketDebuggerUrl.`);
    }
    return entry.webSocketDebuggerUrl;
  }

  async #fetchTargetList(): Promise<ListEntry[]> {
    const listUrl = `${this.#endpoint}/json/list`;
    const response = await this.#fetch(listUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch CDP target list from ${listUrl}: HTTP ${response.status} ${response.statusText}`);
    }
    const payload = await response.json();
    if (!Array.isArray(payload)) {
      throw new Error(`CDP target list from ${listUrl} was not an array.`);
    }
    return payload as ListEntry[];
  }

  async #fetchTargetInfos(): Promise<TargetInfo[]> {
    const client = await this.#getBrowserClient();
    const payload = await client.send("Target.getTargets");
    if (!isRecord(payload) || !Array.isArray(payload.targetInfos)) {
      throw new Error("Target.getTargets did not return a targetInfos array.");
    }
    return payload.targetInfos as TargetInfo[];
  }

  async #createPageSupervisor(pageWebSocketDebuggerUrl: string): Promise<CdpTargetSupervisor> {
    try {
      return await this.#supervisorFactory({
        webSocketUrl: pageWebSocketDebuggerUrl
      });
    } catch (error) {
      throw new Error(`Failed to create CDP page supervisor for target websocket ${pageWebSocketDebuggerUrl}: ${errorMessage(error)}`, {
        cause: error
      });
    }
  }
}

function runtimeEvaluationValue(value: unknown): unknown {
  if (!isRecord(value) || !isRecord(value.result)) return undefined;
  return value.result.value;
}

function requireNonEmptyString(value: string, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

class ManagedTargetHandle implements ManagedCdpTarget {
  readonly browserContextId: string;
  readonly targetId: string;
  readonly pageWebSocketDebuggerUrl: string;
  readonly supervisor: CdpTargetSupervisor;
  readonly #cleanup: () => Promise<void>;
  #closed = false;

  constructor(input: {
    browserContextId: string;
    targetId: string;
    pageWebSocketDebuggerUrl: string;
    supervisor: CdpTargetSupervisor;
    cleanup: () => Promise<void>;
  }) {
    this.browserContextId = input.browserContextId;
    this.targetId = input.targetId;
    this.pageWebSocketDebuggerUrl = input.pageWebSocketDebuggerUrl;
    this.supervisor = input.supervisor;
    this.#cleanup = input.cleanup;
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await this.#cleanup();
  }
}

async function defaultSupervisorFactory(options: CdpTargetSupervisorOptions): Promise<CdpTargetSupervisor> {
  const supervisor = new CDPSupervisor(options);
  await supervisor.start();
  return supervisor;
}

async function cleanupTarget(input: {
  client: CdpClientLike;
  browserContextId: string | undefined;
  targetId: string | undefined;
  supervisor: CdpTargetSupervisor | undefined;
}): Promise<void> {
  let firstError: unknown;

  if (input.supervisor !== undefined) {
    try {
      await input.supervisor.close();
    } catch (error) {
      firstError ??= error;
    }
  }

  if (input.targetId !== undefined) {
    try {
      await input.client.send("Target.closeTarget", {
        targetId: input.targetId
      });
    } catch (error) {
      firstError ??= error;
    }
  }

  if (input.browserContextId !== undefined) {
    try {
      await input.client.send("Target.disposeBrowserContext", {
        browserContextId: input.browserContextId
      });
    } catch (error) {
      firstError ??= error;
    }
  }

  if (firstError !== undefined) {
    throw firstError;
  }
}

function parseStringResult(result: unknown, key: string, method: string): string {
  if (!isRecord(result)) {
    throw new Error(`${method} did not return a result object.`);
  }
  const value = result[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${method} did not return a usable ${key}.`);
  }
  return value;
}

async function sendRequiredStringResult(
  client: CdpClientLike,
  method: string,
  params: Record<string, unknown> | undefined,
  key: string,
  label: string
): Promise<string> {
  let result: unknown;
  try {
    result = await client.send(method, params);
  } catch (error) {
    throw new Error(`${label} failed: ${errorMessage(error)}`, {
      cause: error
    });
  }
  return parseStringResult(result, key, label);
}

function normalizeEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim();
  if (trimmed === "") {
    throw new Error("CDP target manager endpoint is required.");
  }
  return trimmed.replace(/\/+$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
