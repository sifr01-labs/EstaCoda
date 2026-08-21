import type { BrowserSnapshot } from "../contracts/browser.js";
import {
  isActionableBrowserRole,
  type BrowserDocumentSignal,
  type BrowserSnapshotInput
} from "./snapshot-state.js";
import {
  BROWSER_INTERACTABILITY_EVALUATOR_SOURCE,
  isBrowserSnapshotElementInteractable
} from "./browser-interactability.js";
import {
  type CdpClient,
  type CdpSendOptions,
  type CdpWebSocketEvent,
  type CdpWebSocketFactory,
  type CdpWebSocketLike
} from "./cdp-client.js";
import { CdpClient as PersistentCdpClient } from "./cdp-client.js";
import {
  isSafeUrl,
  redactUrlForMetadata,
  scanUrlForSecrets,
  type ResolveHostnameFn
} from "./url-safety.js";
import {
  checkWebsiteAccess,
  loadWebsiteBlocklist,
  type WebsiteBlocklistPolicy,
  type WebsitePolicyConfig
} from "./website-policy.js";

export type SupervisorSnapshot = BrowserSnapshotInput & {
  pendingDialogs: NonNullable<BrowserSnapshot["pendingDialogs"]>;
  frameTree: NonNullable<BrowserSnapshot["frameTree"]>;
  consoleHistory: NonNullable<BrowserSnapshot["consoleHistory"]>;
  documentSignal: BrowserDocumentSignal;
};

export type BrowserSnapshotOptions = {
  full?: boolean;
};

export type BrowserPopupAttempt = {
  url: string;
  userGesture: boolean;
};

export type BrowserDownloadEventResult = {
  outcome: "download-started" | "download-completed" | "download-failed";
  guid?: string;
  url?: string;
  suggestedFilename?: string;
  receivedBytes?: number;
  reason?: string;
};

type BrowserDownloadAttempt = Omit<BrowserDownloadEventResult, "outcome" | "reason">;

const MAX_POPUP_ATTEMPTS = 8;

export type CDPSupervisorOptions = {
  webSocketUrl: string;
  webSocketFactory?: CdpWebSocketFactory;
  requestTimeoutMs?: number;
  requestInterception?: {
    allowPrivateUrls?: boolean;
    websiteBlocklist?: WebsitePolicyConfig;
    resolveHostname?: ResolveHostnameFn;
  };
};

export class CDPSupervisor {
  readonly #webSocketUrl: string;
  readonly #webSocketFactory: CdpWebSocketFactory | undefined;
  readonly #requestTimeoutMs: number | undefined;
  readonly #interception: CDPSupervisorOptions["requestInterception"];
  readonly #websitePolicy: WebsiteBlocklistPolicy;
  #client: CdpClient | undefined;
  #socket: CdpWebSocketLike | undefined;
  #startPromise: Promise<void> | undefined;
  #dialogCounter = 0;
  #pendingDialogs = new Map<string, NonNullable<BrowserSnapshot["pendingDialogs"]>[number]>();
  #consoleHistory: NonNullable<BrowserSnapshot["consoleHistory"]> = [];
  #sensitiveInputActive = false;
  #frameTree: NonNullable<BrowserSnapshot["frameTree"]> = [];
  #mainFrameId: string | undefined;
  #mainLoaderId: string | undefined;
  #mainExecutionContextId: number | undefined;
  #popupAttempts: BrowserPopupAttempt[] = [];
  #downloadAttempts = new Map<string, BrowserDownloadAttempt>();
  #downloadResults: BrowserDownloadEventResult[] = [];
  #downloadWaiters: Array<(result: BrowserDownloadEventResult) => void> = [];
  #downloadMaxBytes: number | undefined;
  #activeDownloadGuid: string | undefined;

  constructor(options: CDPSupervisorOptions) {
    this.#webSocketUrl = options.webSocketUrl;
    this.#webSocketFactory = options.webSocketFactory;
    this.#requestTimeoutMs = options.requestTimeoutMs;
    this.#interception = options.requestInterception;
    this.#websitePolicy = loadWebsiteBlocklist(options.requestInterception?.websiteBlocklist ?? {});
  }

  async start(): Promise<void> {
    if (this.#client !== undefined) {
      return;
    }
    if (this.#startPromise !== undefined) {
      return this.#startPromise;
    }

    this.#startPromise = (async () => {
      const socket = await this.#connectSocket();
      socket.addEventListener("message", (event) => this.#handleMessage(event));
      const client = new PersistentCdpClient(socket, { requestTimeoutMs: this.#requestTimeoutMs });
      await client.send("Page.enable");
      await client.send("Runtime.enable");
      if (this.#interception !== undefined) {
        await client.send("Fetch.enable", {
          patterns: [{ urlPattern: "*" }]
        });
      }
      this.#socket = socket;
      this.#client = client;
    })();

    try {
      await this.#startPromise;
    } finally {
      this.#startPromise = undefined;
    }
  }

  async send(method: string, params?: Record<string, unknown>, options?: CdpSendOptions): Promise<unknown> {
    return this.#requireClient().send(method, params, options);
  }

  async waitFor(method: string, timeoutMs: number): Promise<void> {
    await this.#requireClient().waitFor(method, timeoutMs);
  }

  async prepareDownload(directory: string, maxBytes: number, signal?: AbortSignal): Promise<void> {
    this.#downloadAttempts.clear();
    this.#downloadResults = [];
    this.#activeDownloadGuid = undefined;
    this.#downloadMaxBytes = maxBytes;
    try {
      await this.send("Browser.setDownloadBehavior", {
        behavior: "allowAndName",
        downloadPath: directory,
        eventsEnabled: true
      }, { signal });
    } catch {
      await this.send("Page.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: directory
      }, { signal });
    }
  }

  async waitForDownload(timeoutMs: number, signal?: AbortSignal): Promise<BrowserDownloadEventResult> {
    const queued = this.#downloadResults.shift();
    if (queued !== undefined) return queued;
    if (signal?.aborted === true) throw downloadAbortError();

    return await new Promise<BrowserDownloadEventResult>((resolve, reject) => {
      let settled = false;
      const finish = (result: BrowserDownloadEventResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        this.#downloadWaiters = this.#downloadWaiters.filter((candidate) => candidate !== finish);
        resolve(result);
      };
      const onAbort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        this.#downloadWaiters = this.#downloadWaiters.filter((candidate) => candidate !== finish);
        if (this.#activeDownloadGuid !== undefined) {
          void this.send("Browser.cancelDownload", { guid: this.#activeDownloadGuid }).catch(() => undefined);
        }
        reject(downloadAbortError());
      };
      const timeout = setTimeout(() => {
        const started = [...this.#downloadAttempts.values()].at(-1);
        if (started?.guid !== undefined) {
          void this.send("Browser.cancelDownload", { guid: started.guid }).catch(() => undefined);
        }
        finish(started === undefined
          ? { outcome: "download-failed", reason: "download-event-timeout" }
          : { outcome: "download-started", ...started, reason: "download-completion-timeout" });
      }, timeoutMs);
      this.#downloadWaiters.push(finish);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async getSnapshot(sessionId = "cdp-supervisor", options: BrowserSnapshotOptions = {}): Promise<SupervisorSnapshot> {
    const snapshot = await evaluateCdpSnapshot(this.#requireClient(), sessionId, options);
    return {
      ...snapshot,
      pendingDialogs: [...this.#pendingDialogs.values()],
      frameTree: [...this.#frameTree],
      consoleHistory: [...this.#consoleHistory],
      documentSignal: {
        ...(this.#mainFrameId === undefined ? {} : { frameId: this.#mainFrameId }),
        ...(this.#mainLoaderId === undefined ? {} : { loaderId: this.#mainLoaderId }),
        ...(this.#mainExecutionContextId === undefined ? {} : { executionContextId: this.#mainExecutionContextId })
      }
    };
  }

  async respondToDialog(input: {
    accept: boolean;
    promptText?: string;
  }): Promise<void> {
    await this.send("Page.handleJavaScriptDialog", {
      accept: input.accept,
      promptText: input.promptText ?? ""
    });
  }

  consoleHistory(options: { clear?: boolean } = {}): NonNullable<BrowserSnapshot["consoleHistory"]> {
    if (this.#sensitiveInputActive) return [];
    const entries = [...this.#consoleHistory];
    if (options.clear === true) {
      this.#consoleHistory = [];
    }
    return entries;
  }

  popupAttempts(options: { clear?: boolean } = {}): BrowserPopupAttempt[] {
    const attempts = this.#popupAttempts.map((attempt) => ({ ...attempt }));
    if (options.clear === true) this.#popupAttempts = [];
    return attempts;
  }

  setSensitiveInputActive(active: boolean): void {
    this.#sensitiveInputActive = active;
    if (active) this.#consoleHistory = [];
  }

  close(): void {
    if (this.#client === undefined && this.#socket === undefined) {
      return;
    }
    this.#client?.close();
    this.#client = undefined;
    this.#socket = undefined;
    this.#popupAttempts = [];
    this.#downloadAttempts.clear();
    this.#downloadResults = [];
    this.#downloadWaiters = [];
    this.#downloadMaxBytes = undefined;
    this.#activeDownloadGuid = undefined;
  }

  #requireClient(): CdpClient {
    if (this.#client === undefined) {
      throw new Error("CDP supervisor is not started.");
    }
    return this.#client;
  }

  async #connectSocket(): Promise<CdpWebSocketLike> {
    const factory = this.#webSocketFactory ?? ((url) => {
      if (typeof WebSocket === "undefined") {
        throw new Error("WebSocket is not available in this runtime.");
      }
      return new WebSocket(url) as unknown as CdpWebSocketLike;
    });
    const socket = factory(this.#webSocketUrl);

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

    return socket;
  }

  #handleMessage(event: CdpWebSocketEvent): void {
    const message = parseCdpMessage(event.data);
    if (message?.method === undefined) {
      return;
    }

    if (message.method === "Page.javascriptDialogOpening") {
      this.#handleDialogOpening(message.params);
      return;
    }
    if (message.method === "Page.windowOpen") {
      this.#handleWindowOpen(message.params);
      return;
    }
    if (message.method === "Browser.downloadWillBegin" || message.method === "Page.downloadWillBegin") {
      this.#handleDownloadWillBegin(message.params);
      return;
    }
    if (message.method === "Browser.downloadProgress" || message.method === "Page.downloadProgress") {
      this.#handleDownloadProgress(message.params);
      return;
    }
    if (message.method === "Page.javascriptDialogClosed") {
      this.#pendingDialogs.clear();
      return;
    }
    if (message.method === "Runtime.consoleAPICalled") {
      this.#handleConsole(message.params);
      return;
    }
    if (message.method === "Page.frameNavigated") {
      this.#handleFrameNavigated(message.params);
      return;
    }
    if (message.method === "Runtime.executionContextCreated") {
      this.#handleExecutionContextCreated(message.params);
      return;
    }
    if (message.method === "Fetch.requestPaused") {
      void this.#handleRequestPaused(message.params);
    }
  }

  #handleWindowOpen(params: unknown): void {
    if (!isRecord(params) || typeof params.url !== "string" || params.url.trim() === "") return;
    this.#popupAttempts.push({
      url: params.url,
      userGesture: params.userGesture === true
    });
    if (this.#popupAttempts.length > MAX_POPUP_ATTEMPTS) {
      this.#popupAttempts.splice(0, this.#popupAttempts.length - MAX_POPUP_ATTEMPTS);
    }
  }

  #handleDownloadWillBegin(params: unknown): void {
    if (!isRecord(params) || typeof params.guid !== "string") return;
    if (this.#activeDownloadGuid !== undefined && this.#activeDownloadGuid !== params.guid) {
      void this.send("Browser.cancelDownload", { guid: params.guid }).catch(() => undefined);
      return;
    }
    this.#activeDownloadGuid = params.guid;
    this.#downloadAttempts.set(params.guid, {
      guid: params.guid,
      ...(typeof params.url === "string" ? { url: params.url } : {}),
      ...(typeof params.suggestedFilename === "string" ? { suggestedFilename: params.suggestedFilename } : {})
    });
  }

  #handleDownloadProgress(params: unknown): void {
    if (!isRecord(params) || typeof params.guid !== "string" || typeof params.state !== "string") return;
    const attempt = this.#downloadAttempts.get(params.guid) ?? { guid: params.guid };
    if (
      typeof params.receivedBytes === "number" &&
      this.#downloadMaxBytes !== undefined &&
      params.receivedBytes > this.#downloadMaxBytes
    ) {
      void this.send("Browser.cancelDownload", { guid: params.guid }).catch(() => undefined);
      this.#downloadAttempts.delete(params.guid);
      this.#activeDownloadGuid = undefined;
      const tooLarge: BrowserDownloadEventResult = {
        outcome: "download-failed",
        ...attempt,
        receivedBytes: params.receivedBytes,
        reason: "download-too-large"
      };
      const waiter = this.#downloadWaiters.shift();
      if (waiter === undefined) this.#downloadResults.push(tooLarge);
      else waiter(tooLarge);
      return;
    }
    const result: BrowserDownloadEventResult = {
      outcome: params.state === "completed" ? "download-completed" : "download-failed",
      ...attempt,
      ...(typeof params.receivedBytes === "number" ? { receivedBytes: params.receivedBytes } : {}),
      ...(params.state === "canceled" ? { reason: "download-canceled" } : {})
    };
    if (params.state !== "completed" && params.state !== "canceled") {
      this.#downloadAttempts.set(params.guid, {
        ...attempt,
        ...(typeof params.receivedBytes === "number" ? { receivedBytes: params.receivedBytes } : {})
      });
      return;
    }
    this.#downloadAttempts.delete(params.guid);
    this.#activeDownloadGuid = undefined;
    const waiter = this.#downloadWaiters.shift();
    if (waiter === undefined) this.#downloadResults.push(result);
    else waiter(result);
  }

  #handleDialogOpening(params: unknown): void {
    if (!isRecord(params)) {
      return;
    }
    const message = typeof params.message === "string" ? params.message : "";
    const type = typeof params.type === "string" ? params.type : "unknown";
    const defaultPrompt = typeof params.defaultPrompt === "string" ? params.defaultPrompt : undefined;
    const id = `dialog-${++this.#dialogCounter}`;
    this.#pendingDialogs.set(id, {
      id,
      type,
      message: message.slice(0, 500),
      ...(defaultPrompt !== undefined ? { defaultPrompt: defaultPrompt.slice(0, 500) } : {})
    });
  }

  #handleConsole(params: unknown): void {
    if (this.#sensitiveInputActive) return;
    if (!isRecord(params)) {
      return;
    }
    const level = typeof params.type === "string" ? params.type : "log";
    const args = Array.isArray(params.args) ? params.args : [];
    const text = args.map(formatConsoleArg).join(" ").slice(0, 2_000);
    const timestamp = typeof params.timestamp === "number"
      ? new Date(params.timestamp).toISOString()
      : undefined;
    this.#consoleHistory.push({
      level,
      text,
      ...(timestamp !== undefined ? { timestamp } : {})
    });
    this.#consoleHistory = this.#consoleHistory.slice(-50);
  }

  #handleFrameNavigated(params: unknown): void {
    if (!isRecord(params) || !isRecord(params.frame)) {
      return;
    }
    const frame = params.frame;
    const frameId = typeof frame.id === "string" ? frame.id : undefined;
    const url = typeof frame.url === "string" ? frame.url : undefined;
    if (frameId === undefined || url === undefined) {
      return;
    }
    const parentFrameId = typeof frame.parentId === "string" ? frame.parentId : undefined;
    if (parentFrameId === undefined) {
      const loaderId = typeof frame.loaderId === "string" && frame.loaderId !== "" ? frame.loaderId : undefined;
      if (this.#mainFrameId !== frameId || (loaderId !== undefined && this.#mainLoaderId !== loaderId)) {
        this.#mainExecutionContextId = undefined;
      }
      this.#mainFrameId = frameId;
      this.#mainLoaderId = loaderId;
    }
    const origin = originForUrl(url);
    const entry = {
      frameId,
      url: url.slice(0, 2_000),
      origin,
      ...(parentFrameId !== undefined ? { parentFrameId } : {}),
      isOopif: false
    };
    this.#frameTree = [
      ...this.#frameTree.filter((candidate) => candidate.frameId !== frameId),
      entry
    ].slice(-30);
  }

  #handleExecutionContextCreated(params: unknown): void {
    if (!isRecord(params) || !isRecord(params.context)) return;
    const context = params.context;
    const contextId = typeof context.id === "number" ? context.id : undefined;
    const auxData = isRecord(context.auxData) ? context.auxData : undefined;
    const frameId = auxData !== undefined && typeof auxData.frameId === "string" ? auxData.frameId : undefined;
    const isDefault = auxData?.isDefault === true;
    if (contextId === undefined || frameId === undefined || !isDefault) return;
    if (this.#mainFrameId === undefined) this.#mainFrameId = frameId;
    if (frameId === this.#mainFrameId) this.#mainExecutionContextId = contextId;
  }

  async #handleRequestPaused(params: unknown): Promise<void> {
    const requestId = isRecord(params) && typeof params.requestId === "string" ? params.requestId : undefined;
    const url = isRecord(params) && isRecord(params.request) && typeof params.request.url === "string"
      ? params.request.url
      : undefined;
    if (requestId === undefined) {
      return;
    }
    if (url === undefined) {
      await this.#continueRequest(requestId);
      return;
    }

    const reason = await this.#blockedRequestReason(url);
    if (reason === undefined) {
      await this.#continueRequest(requestId);
      return;
    }

    await this.#failRequest(requestId);
  }

  async #blockedRequestReason(url: string): Promise<string | undefined> {
    if (scanUrlForSecrets(url) !== undefined) {
      return "secret-in-url";
    }
    if (!await isSafeUrl(url, {
      allowPrivateUrls: this.#interception?.allowPrivateUrls === true,
      resolveHostname: this.#interception?.resolveHostname
    })) {
      return "unsafe-url";
    }
    const websiteAccess = checkWebsiteAccess(url, this.#websitePolicy);
    if (websiteAccess?.allowed === false) {
      return "website-policy";
    }
    return undefined;
  }

  async #continueRequest(requestId: string): Promise<void> {
    try {
      await this.send("Fetch.continueRequest", { requestId });
    } catch {
      // Best-effort: a paused request can disappear if the target closes.
    }
  }

  async #failRequest(requestId: string): Promise<void> {
    try {
      await this.send("Fetch.failRequest", {
        requestId,
        errorReason: "BlockedByClient"
      });
    } catch {
      // Best-effort: a paused request can disappear if the target closes.
    }
  }
}

function parseCdpMessage(raw: unknown): { method?: string; params?: unknown } | undefined {
  try {
    const text = typeof raw === "string" ? raw : raw instanceof ArrayBuffer ? new TextDecoder().decode(raw) : String(raw ?? "");
    if (text.length === 0) {
      return undefined;
    }
    return JSON.parse(text) as { method?: string; params?: unknown };
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function formatConsoleArg(arg: unknown): string {
  if (!isRecord(arg)) {
    return "";
  }
  if (typeof arg.value === "string") {
    return arg.value;
  }
  if (typeof arg.value === "number" || typeof arg.value === "boolean") {
    return String(arg.value);
  }
  if (typeof arg.description === "string") {
    return arg.description;
  }
  if (typeof arg.type === "string") {
    return `[${arg.type}]`;
  }
  return "";
}

function originForUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "null";
  }
}

function downloadAbortError(): Error {
  const error = new Error("Browser download was cancelled.");
  error.name = "AbortError";
  return error;
}

export async function evaluateCdpSnapshot(client: CdpClient, sessionId: string, options: BrowserSnapshotOptions = {}): Promise<BrowserSnapshotInput> {
  const axSnapshot = await evaluateAxSnapshot(client, sessionId, options).catch(() => undefined);
  if (axSnapshot !== undefined) {
    return axSnapshot;
  }

  const evaluated = await client.send("Runtime.evaluate", {
    expression: snapshotExpression(),
    returnByValue: true
  }) as { result?: { value?: unknown } };
  return parseCdpSnapshot(evaluated.result?.value, sessionId);
}

async function evaluateAxSnapshot(client: CdpClient, sessionId: string, options: BrowserSnapshotOptions): Promise<BrowserSnapshotInput | undefined> {
  const axTree = await client.send("Accessibility.getFullAXTree") as unknown;
  const candidates = parseAxElements(axTree, options);
  const elements = await bindAxElements(client, candidates, options);
  if (elements.length === 0) {
    return undefined;
  }

  const pageMetadata = await evaluatePageSnapshotMetadata(client).catch(() => undefined);
  if (pageMetadata === undefined) {
    return undefined;
  }
  const { regions: observedRegions, ...metadata } = pageMetadata;
  const regions = bindVisibleRegionActions(observedRegions, elements);

  return {
    sessionId,
    ...metadata,
    elements,
    ...(regions.length === 0 ? {} : { regions })
  };
}

async function evaluatePageSnapshotMetadata(client: CdpClient): Promise<Omit<BrowserSnapshotInput, "sessionId" | "elements"> | undefined> {
  const evaluated = await client.send("Runtime.evaluate", {
    expression: pageSnapshotMetadataExpression(),
    returnByValue: true
  }) as { result?: { value?: unknown } };
  return parsePageSnapshotMetadata(evaluated.result?.value);
}

function pageSnapshotMetadataExpression(): string {
  return `(() => {
    ${visibleRegionsSource()}
    return JSON.stringify({
      url: location.href,
      title: document.title,
      readiness: document.readyState,
      text: (document.body && document.body.innerText ? document.body.innerText : '').slice(0, 12000),
      regions: collectVisibleRegions()
    });
  })()`;
}

export function snapshotExpression(): string {
  return `(() => {
    const candidates = Array.from(document.querySelectorAll('a,button,input,textarea,select,[role],[tabindex]')).slice(0, 120);
    window.__estacodaElements = candidates;
    const assessInteractability = ${BROWSER_INTERACTABILITY_EVALUATOR_SOURCE};
    const clean = (value, max = 240) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, max);
    const actionSelector = 'a[href],button,input,select,textarea,[role="button"],[role="link"],[role="tab"],[role="menuitem"]';
    const labelText = (el) => clean(Array.from(el.labels || []).map((label) => label.innerText || label.textContent || '').join(' ') || el.getAttribute('aria-label') || el.closest('label')?.innerText || '');
    const elementText = (el) => clean(el.innerText || el.textContent || '');
    const sensitive = (el) => el instanceof HTMLInputElement && el.type.toLowerCase() === 'password';
    const name = (el) => clean(el.getAttribute('aria-label') || labelText(el) || el.innerText || el.getAttribute('title') || el.getAttribute('name') || el.id || '', 160);
    const role = (el) => {
      const explicit = el.getAttribute('role');
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      if (tag === 'a') return 'link';
      if (tag === 'button') return 'button';
      if (tag === 'textarea') return 'textbox';
      if (tag === 'select') return el.multiple ? 'listbox' : 'combobox';
      if (tag === 'input') {
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        if (type === 'range') return 'slider';
        if (type === 'number') return 'spinbutton';
        return 'textbox';
      }
      return tag;
    };
    const regionText = (el) => {
      let node = el.parentElement;
      for (let depth = 0; node && depth < 7 && node !== document.body && node !== document.documentElement; depth += 1, node = node.parentElement) {
        const rawText = String(node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim();
        if (rawText.length === 0 || rawText.length > 1200) continue;
        const controls = Array.from(node.querySelectorAll(actionSelector)).slice(0, 17);
        if (controls.length === 0 || controls.length > 16) continue;
        const controlText = controls.map((control) => String(control.innerText || control.textContent || control.getAttribute?.('aria-label') || '')).join(' ').replace(/\\s+/g, ' ').trim();
        if (rawText.length <= controlText.length + 2) continue;
        return clean(rawText, 480);
      }
      return '';
    };
    const elements = candidates.map((el, index) => {
      const interactability = assessInteractability(el);
      const region = regionText(el);
      return {
        ref: '@e' + (index + 1),
        role: role(el),
        name: name(el),
        text: elementText(el),
        label: labelText(el),
        withinText: region || clean(el.closest('article,li,form,section,[role="listitem"],[role="group"],[role="row"],tr')?.innerText || el.parentElement?.innerText || ''),
        regionText: region,
        interactable: interactability.interactable,
        interactabilityReason: interactability.reason,
        hidden: interactability.hidden,
        disabled: interactability.disabled
      };
    });
    ${visibleRegionsSource()}
    return JSON.stringify({
      url: location.href,
      title: document.title,
      readiness: document.readyState,
      text: (document.body && document.body.innerText ? document.body.innerText : '').slice(0, 12000),
      elements: elements.filter((element) => element.interactable),
      regions: collectVisibleRegions()
    });
  })()`;
}

function visibleRegionsSource(): string {
  return `
    const collectVisibleRegions = () => {
      const cleanRegion = (value, max = 600) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, max);
      const actionSelector = 'a[href],button,input,select,textarea,[role="button"],[role="link"],[role="tab"],[role="menuitem"]';
      const containers = Array.from(document.querySelectorAll('article,li,tr,section,[role="listitem"],[role="row"],[role="group"],[data-testid],.card,[class*="card"],div')).slice(0, 600);
      const elementBindings = Array.isArray(window.__estacodaElements) ? window.__estacodaElements : [];
      const actionAt = (point, container) => {
        const hit = document.elementFromPoint(point.x, point.y);
        if (!(hit instanceof Element) || !(hit === container || container.contains(hit))) return undefined;
        const nestedAction = hit.closest(actionSelector);
        if (nestedAction && nestedAction !== container && container.contains(nestedAction)) return undefined;
        return point;
      };
      const pointFor = (container, rect) => {
        const insetX = Math.min(16, rect.width / 4);
        const insetY = Math.min(16, rect.height / 4);
        const points = [
          { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
          { x: rect.left + insetX, y: rect.top + insetY },
          { x: rect.right - insetX, y: rect.top + insetY },
          { x: rect.left + insetX, y: rect.bottom - insetY },
          { x: rect.right - insetX, y: rect.bottom - insetY }
        ];
        return points.map((point) => actionAt(point, container)).find(Boolean);
      };
      const candidates = [];
      for (const container of containers) {
        if (!(container instanceof HTMLElement) || !container.isConnected || container.hidden || container.getAttribute('aria-hidden') === 'true') continue;
        const style = getComputedStyle(container);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue;
        const rect = container.getBoundingClientRect();
        if (rect.width <= 8 || rect.height <= 8 || rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) continue;
        const text = cleanRegion(container.innerText || container.textContent || '');
        if (text.length < 2 || text.length > 600) continue;
        const actions = Array.from(container.querySelectorAll(actionSelector)).slice(0, 17);
        const explicit = container.matches(actionSelector) || container.hasAttribute('onclick') || typeof container.onclick === 'function' ||
          container.tabIndex >= 0 || style.cursor === 'pointer';
        if (!explicit && (actions.length === 0 || actions.length > 16)) continue;
        const point = pointFor(container, rect);
        const centerHit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        const actionRefs = elementBindings
          .map((element, index) => element instanceof Element && container.contains(element) ? '@e' + (index + 1) : undefined)
          .filter(Boolean)
          .slice(0, 16);
        const links = Array.from(container.querySelectorAll('a[href]')).slice(0, 12).map((link) => ({
          text: cleanRegion(link.innerText || link.textContent || link.getAttribute('aria-label') || '', 160),
          href: String(link.href || '').slice(0, 2000)
        })).filter((link) => link.text && /^https?:/u.test(link.href));
        candidates.push({ container, text, actionRefs, links, hitTestable: point !== undefined,
          blockedBy: point !== undefined ? undefined : cleanRegion(centerHit?.getAttribute?.('aria-label') || centerHit?.innerText || centerHit?.textContent || centerHit?.tagName || '', 120) });
      }
      candidates.sort((left, right) => left.text.length - right.text.length);
      const unique = [];
      const seen = new Set();
      for (const candidate of candidates) {
        const key = candidate.text.toLocaleLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(candidate);
        if (unique.length >= 60) break;
      }
      window.__estacodaRegions = unique.map((candidate) => candidate.container);
      return unique.map((candidate, index) => ({
        ref: '@r' + (index + 1),
        text: candidate.text,
        actionRefs: candidate.actionRefs,
        links: candidate.links,
        hitTestable: candidate.hitTestable,
        blockedBy: candidate.blockedBy
      }));
    };`;
}

type BrowserSnapshotElement = NonNullable<BrowserSnapshot["elements"]>[number];
type AxSnapshotElementCandidate = BrowserSnapshotElement & {
  backendDOMNodeId?: number;
  actionable: boolean;
};

type BoundElementMetadata = Pick<BrowserSnapshotElement,
  "text" | "label" | "withinText" | "regionText" | "hidden" | "disabled" | "interactable" | "interactabilityReason"> & {
  sensitive?: boolean;
};

const AX_UNHELPFUL_ROLES = new Set([
  "generic",
  "ignored",
  "none",
  "presentation",
  "RootWebArea",
  "StaticText",
  "InlineTextBox"
]);

function parseAxElements(value: unknown, options: BrowserSnapshotOptions): AxSnapshotElementCandidate[] {
  if (!isRecord(value) || !Array.isArray(value.nodes)) {
    return [];
  }

  const elements: AxSnapshotElementCandidate[] = [];
  for (const node of value.nodes) {
    const element = parseAxElement(node, elements.length + 1, options);
    if (element !== undefined) {
      elements.push(element);
    }
    if (elements.length >= (options.full === true ? 1_000 : 120)) {
      break;
    }
  }
  return elements;
}

function parseAxElement(value: unknown, index: number, options: BrowserSnapshotOptions): AxSnapshotElementCandidate | undefined {
  if (!isRecord(value) || value.ignored === true) {
    return undefined;
  }

  const role = axPropertyString(value.role);
  if (role === undefined || AX_UNHELPFUL_ROLES.has(role)) {
    return undefined;
  }

  const name = axPropertyString(value.name);
  const elementValue = axPropertyString(value.value);
  const disabled = axBooleanProperty(value, "disabled");
  const checked = axCheckedProperty(value);
  const backendDOMNodeId = axBackendDomNodeId(value);

  const isInteractive = isActionableBrowserRole(role);
  // Compact AX snapshots are currently a bounded actionable subset, not a
  // viewport-geometry filter. Do not pretend viewport visibility without real
  // DOM/bounding data from CDP.
  if (options.full !== true && !isInteractive) {
    return undefined;
  }
  if (options.full === true && !isInteractive && name === undefined && elementValue === undefined && checked === undefined) {
    return undefined;
  }

  return {
    ref: `@e${index}`,
    role,
    ...(name !== undefined ? { name } : {}),
    ...(elementValue !== undefined ? { value: elementValue } : {}),
    ...(disabled !== undefined ? { disabled } : {}),
    ...(checked !== undefined ? { checked } : {}),
    ...(backendDOMNodeId !== undefined ? { backendDOMNodeId } : {}),
    actionable: isInteractive
  };
}

async function bindAxElements(
  client: CdpClient,
  candidates: AxSnapshotElementCandidate[],
  options: BrowserSnapshotOptions
): Promise<BrowserSnapshotElement[]> {
  if (candidates.length === 0) {
    return [];
  }

  const cleared = await client.send("Runtime.evaluate", {
    expression: "window.__estacodaElements = []; 'ok';",
    returnByValue: true
  }).then(() => true, () => false);
  if (!cleared) {
    return [];
  }

  const elements: BrowserSnapshotElement[] = [];
  const orderedCandidates = options.full === true
    ? [...candidates.filter((candidate) => candidate.actionable), ...candidates.filter((candidate) => !candidate.actionable)]
    : candidates;
  for (const candidate of orderedCandidates) {
    const binding = candidate.backendDOMNodeId === undefined
      ? undefined
      : await bindAxElement(client, candidate.backendDOMNodeId, elements.length);
    if (candidate.actionable && binding === undefined) {
      continue;
    }
    if (options.full !== true && binding === undefined) {
      continue;
    }
    const { backendDOMNodeId: _backendDOMNodeId, actionable: _actionable, ...element } = candidate;
    const { value: elementValue, ...elementWithoutValue } = element;
    const { sensitive, interactable: observedInteractable, ...publicMetadata } = binding?.metadata ?? {};
    const interactable = observedInteractable ?? isBrowserSnapshotElementInteractable({
      ...elementWithoutValue,
      ...publicMetadata
    });
    if (candidate.actionable && !interactable) {
      continue;
    }
    elements.push({
      ...elementWithoutValue,
      ...(sensitive === true || elementValue === undefined ? {} : { value: elementValue }),
      ...publicMetadata,
      ref: `@e${elements.length + 1}`
    });
  }
  return elements;
}

async function bindAxElement(
  client: CdpClient,
  backendNodeId: number,
  index: number
): Promise<{ metadata?: BoundElementMetadata } | undefined> {
  try {
    const resolved = await client.send("DOM.resolveNode", { backendNodeId }) as {
      object?: { objectId?: unknown };
    };
    const objectId = resolved.object?.objectId;
    if (typeof objectId !== "string" || objectId.length === 0) {
      return undefined;
    }
    const bound = await client.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function(index) {
        window.__estacodaElements = window.__estacodaElements || [];
        window.__estacodaElements[index] = this;
        const assessInteractability = ${BROWSER_INTERACTABILITY_EVALUATOR_SOURCE};
        const clean = (value, max = 240) => String(value || '').replace(/\\s+/g, ' ').trim().slice(0, max);
        const label = clean(Array.from(this.labels || []).map((entry) => entry.innerText || entry.textContent || '').join(' ') || this.getAttribute?.('aria-label') || this.closest?.('label')?.innerText || '');
        const interactability = assessInteractability(this);
        const actionSelector = 'a[href],button,input,select,textarea,[role="button"],[role="link"],[role="tab"],[role="menuitem"]';
        const region = (() => {
          let node = this.parentElement;
          for (let depth = 0; node && depth < 7 && node !== document.body && node !== document.documentElement; depth += 1, node = node.parentElement) {
            const rawText = String(node.innerText || node.textContent || '').replace(/\\s+/g, ' ').trim();
            if (rawText.length === 0 || rawText.length > 1200) continue;
            const controls = Array.from(node.querySelectorAll(actionSelector)).slice(0, 17);
            if (controls.length === 0 || controls.length > 16) continue;
            const controlText = controls.map((control) => String(control.innerText || control.textContent || control.getAttribute?.('aria-label') || '')).join(' ').replace(/\\s+/g, ' ').trim();
            if (rawText.length <= controlText.length + 2) continue;
            return clean(rawText, 480);
          }
          return '';
        })();
        return {
          text: clean(this.innerText || this.textContent || ''),
          label,
          withinText: region || clean(this.closest?.('article,li,form,section,[role="listitem"],[role="group"],[role="row"],tr')?.innerText || this.parentElement?.innerText || ''),
          regionText: region,
          interactable: interactability.interactable,
          interactabilityReason: interactability.reason,
          hidden: interactability.hidden,
          disabled: interactability.disabled,
          sensitive: this instanceof HTMLInputElement && this.type.toLowerCase() === 'password'
        };
      }`,
      arguments: [{ value: index }],
      returnByValue: true
    }) as { result?: { value?: unknown } };
    return { metadata: parseBoundElementMetadata(bound.result?.value) };
  } catch {
    return undefined;
  }
}

function parseBoundElementMetadata(value: unknown): BoundElementMetadata | undefined {
  if (!isRecord(value)) return undefined;
  const text = boundedMetadataText(value.text);
  const label = boundedMetadataText(value.label);
  const withinText = boundedMetadataText(value.withinText);
  const regionText = boundedMetadataText(value.regionText, 480);
  const interactabilityReason = parseInteractabilityReason(value.interactabilityReason);
  return {
    ...(text === undefined ? {} : { text }),
    ...(label === undefined ? {} : { label }),
    ...(withinText === undefined ? {} : { withinText }),
    ...(regionText === undefined ? {} : { regionText }),
    ...(typeof value.hidden === "boolean" ? { hidden: value.hidden } : {}),
    ...(typeof value.disabled === "boolean" ? { disabled: value.disabled } : {}),
    ...(typeof value.interactable === "boolean" ? { interactable: value.interactable } : {}),
    ...(interactabilityReason === undefined ? {} : { interactabilityReason }),
    ...(typeof value.sensitive === "boolean" ? { sensitive: value.sensitive } : {})
  };
}

function parseInteractabilityReason(value: unknown): BrowserSnapshotElement["interactabilityReason"] | undefined {
  return value === "detached" || value === "hidden" || value === "inert" || value === "disabled" || value === "modal-blocked"
    ? value
    : undefined;
}

function boundedMetadataText(value: unknown, maxChars = 240): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length === 0 ? undefined : normalized.slice(0, maxChars);
}

function axPropertyString(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const raw = value.value;
  if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") {
    return undefined;
  }
  const text = String(raw).trim();
  return text.length === 0 ? undefined : text.slice(0, 160);
}

function axBooleanProperty(node: Record<string, unknown>, name: string): boolean | undefined {
  const value = axNamedProperty(node, name);
  return typeof value === "boolean" ? value : undefined;
}

function axCheckedProperty(node: Record<string, unknown>): boolean | "mixed" | undefined {
  const value = axNamedProperty(node, "checked");
  if (value === true || value === false || value === "mixed") {
    return value;
  }
  return undefined;
}

function axNamedProperty(node: Record<string, unknown>, name: string): unknown {
  const direct = node[name];
  if (isRecord(direct) && "value" in direct) {
    return direct.value;
  }
  if (!Array.isArray(node.properties)) {
    return undefined;
  }
  const property = node.properties.find((candidate) => isRecord(candidate) && candidate.name === name);
  return isRecord(property) && isRecord(property.value) ? property.value.value : undefined;
}

function axBackendDomNodeId(node: Record<string, unknown>): number | undefined {
  const raw = node.backendDOMNodeId ?? node.backendDomNodeId;
  return typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? raw : undefined;
}

function parsePageSnapshotMetadata(value: unknown): Omit<BrowserSnapshotInput, "sessionId" | "elements"> | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value) as Partial<BrowserSnapshotInput>;
    const regions = parseVisibleRegions(parsed.regions);
    return {
      url: typeof parsed.url === "string" ? parsed.url : "about:blank",
      ...(typeof parsed.title === "string" ? { title: parsed.title } : {}),
      readiness: parseReadiness(parsed.readiness),
      ...(typeof parsed.text === "string" ? { text: parsed.text } : { text: "" }),
      ...(regions.length === 0 ? {} : { regions })
    };
  } catch {
    return undefined;
  }
}

export function parseCdpSnapshot(value: unknown, sessionId: string): BrowserSnapshotInput {
  if (typeof value !== "string") {
    return emptySnapshot(sessionId, "");
  }
  try {
    const parsed = JSON.parse(value) as BrowserSnapshotInput;
    const elements = Array.isArray(parsed.elements)
      ? parsed.elements.filter(isBrowserSnapshotElementInteractable).map((element) => {
          const {
            interactable: _interactable,
            interactabilityReason: _interactabilityReason,
            ...publicElement
          } = element;
          return publicElement;
        })
      : [];
    const regions = bindVisibleRegionActions(parseVisibleRegions(parsed.regions), elements);
    return {
      sessionId,
      url: parsed.url,
      readiness: parseReadiness(parsed.readiness),
      title: parsed.title,
      text: parsed.text,
      elements,
      ...(regions.length === 0 ? {} : { regions })
    };
  } catch {
    return emptySnapshot(sessionId, value);
  }
}

function parseVisibleRegions(value: unknown): NonNullable<BrowserSnapshot["regions"]> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 60).flatMap((entry, index) => {
    if (!isRecord(entry) || typeof entry.text !== "string") return [];
    const text = boundedMetadataText(entry.text, 600);
    if (text === undefined) return [];
    const ref = typeof entry.ref === "string" && /^@r\d+$/u.test(entry.ref) ? entry.ref : `@r${index + 1}`;
    const actionRefs = Array.isArray(entry.actionRefs)
      ? entry.actionRefs.filter((candidate): candidate is string => typeof candidate === "string" && /^@e\d+$/u.test(candidate)).slice(0, 16)
      : [];
    const links = Array.isArray(entry.links) ? entry.links.slice(0, 12).flatMap((link) => {
      if (!isRecord(link) || typeof link.text !== "string" || typeof link.href !== "string") return [];
      const safeText = boundedMetadataText(link.text, 160);
      if (safeText === undefined || scanUrlForSecrets(link.href) !== undefined) return [];
      let parsed: URL;
      try {
        parsed = new URL(link.href);
      } catch {
        return [];
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:" || parsed.username.length > 0 || parsed.password.length > 0 ||
          hasSensitiveRegionLinkParameters(parsed)) return [];
      return [{ text: safeText, href: redactUrlForMetadata(link.href) }];
    }) : [];
    const blockedBy = boundedMetadataText(entry.blockedBy, 120);
    return [{
      ref,
      text,
      actionRefs,
      links,
      hitTestable: entry.hitTestable === true,
      ...(blockedBy === undefined ? {} : { blockedBy })
    }];
  });
}

function bindVisibleRegionActions(
  regions: BrowserSnapshot["regions"],
  elements: NonNullable<BrowserSnapshot["elements"]>
): NonNullable<BrowserSnapshot["regions"]> {
  const currentRefs = new Set(elements.map((element) => element.ref));
  return (regions ?? []).map((region) => ({
    ...region,
    actionRefs: region.actionRefs.filter((ref) => currentRefs.has(ref))
  }));
}

function hasSensitiveRegionLinkParameters(url: URL): boolean {
  const sensitiveName = /(?:^|[_-])(?:access|auth|authorization|code|credential|csrf|key|nonce|secret|session|sig|signature|state|token|xsrf)(?:$|[_-])/iu;
  for (const key of url.searchParams.keys()) {
    if (sensitiveName.test(key)) return true;
  }
  return false;
}

function emptySnapshot(sessionId: string, text: string): BrowserSnapshotInput {
  return {
    sessionId,
    url: "about:blank",
    readiness: "unknown",
    text,
    elements: []
  };
}

function parseReadiness(value: unknown): NonNullable<BrowserSnapshot["readiness"]> {
  return value === "loading" || value === "interactive" || value === "complete" ? value : "unknown";
}
