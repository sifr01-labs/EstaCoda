import type {
  BrowserBackend,
  BrowserSnapshot,
  BrowserStateProjection,
  BrowserTab,
  BrowserTabList
} from "../contracts/browser.js";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";
import { redactSensitiveText } from "../utils/redaction.js";
import { browserSessionStateReason } from "./session-state.js";
import { redactUrlForMetadata } from "./url-safety.js";

export const BROWSER_STATE_MAX_TABS = 8;
export const BROWSER_STATE_REFRESH_TIMEOUT_MS = 5_000;
const BROWSER_STATE_MAX_TEXT_CHARS = 160;

export async function refreshBrowserStateProjection(input: {
  backend: BrowserBackend;
  sessionId: string;
  previous?: BrowserStateProjection;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<BrowserStateProjection> {
  if (input.backend.kind === "unconfigured") {
    return preserveLastAction({
      sessionStatus: "unconfigured",
      freshness: "current"
    }, input.previous);
  }

  const controller = linkedTimeoutController(input.signal, input.timeoutMs ?? BROWSER_STATE_REFRESH_TIMEOUT_MS);
  let available = false;
  try {
    available = await abortableBrowserStateCall(
      Promise.resolve(input.backend.isAvailable()),
      controller.signal
    );
  } catch {
    controller.dispose();
    return staleOrMissing(input);
  }
  if (!available) {
    controller.dispose();
    return staleOrMissing(input);
  }

  try {
    const tabs = input.backend.tabs === undefined
      ? undefined
      : await abortableBrowserStateCall(
        input.backend.tabs({ sessionId: input.sessionId, signal: controller.signal }),
        controller.signal
      );
    const snapshot = input.backend.snapshot === undefined
      ? undefined
      : await abortableBrowserStateCall(
        input.backend.snapshot({ sessionId: input.sessionId, signal: controller.signal }),
        controller.signal
      );
    if (tabs === undefined && snapshot === undefined) return staleOrMissing(input);
    return currentProjection({
      sessionId: input.sessionId,
      tabs,
      snapshot,
      previous: input.previous,
      detectExternalChange: true
    });
  } catch (error) {
    const reason = browserSessionStateReason(error);
    if (reason === "session_missing" || reason === "browser_process_missing" || reason === "tab_missing") {
      return preserveLastAction({
        sessionStatus: "missing",
        sessionId: input.sessionId,
        freshness: "current"
      }, input.previous);
    }
    return staleOrMissing(input);
  } finally {
    controller.dispose();
  }
}

export function projectBrowserStateFromExecutions(input: {
  executions: readonly ToolExecutionRecord[];
  sessionId: string;
  previous?: BrowserStateProjection;
}): BrowserStateProjection | undefined {
  const browserExecutions = input.executions.filter((execution) => execution.tool.name.startsWith("browser."));
  if (browserExecutions.length === 0) return undefined;

  let projection = input.previous;
  for (const execution of browserExecutions) {
    const metadata = asRecord(execution.result?.metadata);
    const snapshot = browserSnapshot(metadata?.snapshot);
    const tabs = browserTabList(metadata);
    const metadataReason = metadata?.reason;
    const failedReason = metadataReason === "session_missing" ||
      metadataReason === "browser_process_missing" ||
      metadataReason === "tab_missing"
      ? metadataReason
      : execution.result?.ok === false
        ? browserSessionStateReason(new Error(execution.result.content))
        : undefined;
    const lastAction: NonNullable<BrowserStateProjection["lastAction"]> = {
      tool: boundedText(execution.tool.name),
      status: execution.result?.ok === true ? "succeeded" : "failed",
      changed: browserExecutionChanged(execution.tool.name, snapshot)
    };

    if (failedReason === "session_missing" || failedReason === "browser_process_missing" || failedReason === "tab_missing") {
      projection = {
        sessionStatus: "missing",
        sessionId: input.sessionId,
        freshness: "current",
        lastAction
      };
      continue;
    }
    if (execution.tool.name === "browser.status" && metadata?.backend === "unconfigured") {
      projection = {
        sessionStatus: "unconfigured",
        freshness: "current",
        lastAction
      };
      continue;
    }
    if (execution.tool.name === "browser.status") {
      projection = projection?.sessionStatus === "active"
        ? { ...projection, freshness: "stale", lastAction }
        : {
            sessionStatus: "missing",
            sessionId: input.sessionId,
            freshness: "current",
            lastAction
          };
      continue;
    }
    if (execution.result?.ok !== true) {
      projection = {
        ...(projection ?? { sessionStatus: "missing" as const }),
        freshness: "stale",
        lastAction
      };
      continue;
    }

    projection = currentProjection({
      sessionId: snapshot?.sessionId ?? tabs?.sessionId ?? input.sessionId,
      tabs,
      snapshot,
      previous: projection,
      detectExternalChange: lastAction.changed === false,
      lastAction
    });
  }
  return projection;
}

function currentProjection(input: {
  sessionId: string;
  tabs?: BrowserTabList;
  snapshot?: BrowserSnapshot;
  previous?: BrowserStateProjection;
  detectExternalChange: boolean;
  lastAction?: BrowserStateProjection["lastAction"];
}): BrowserStateProjection {
  const safeTabs = boundedTabs(input.tabs?.tabs ?? input.previous?.tabs ?? []);
  const snapshotTab = input.snapshot?.tab === undefined ? undefined : safeTab(input.snapshot.tab);
  const controlledTab = snapshotTab ?? safeTabs.find((tab) => tab.controlled) ?? input.previous?.controlledTab;
  const tabs = mergeControlledTab(safeTabs, controlledTab);
  const next: BrowserStateProjection = {
    sessionStatus: "active",
    sessionId: boundedText(input.sessionId),
    ...(controlledTab === undefined ? {} : { controlledTab }),
    ...(tabs.length === 0 ? {} : { tabs }),
    ...(input.tabs !== undefined || (
      input.previous?.sessionId === input.sessionId && input.previous.tabInventoryComplete === true
    )
      ? { tabInventoryComplete: true }
      : {}),
    ...(input.snapshot?.identity === undefined ? input.previous?.identity === undefined ? {} : { identity: input.previous.identity } : { identity: { ...input.snapshot.identity } }),
    ...(input.snapshot?.readiness === undefined ? input.previous?.readiness === undefined ? {} : { readiness: input.previous.readiness } : { readiness: input.snapshot.readiness }),
    freshness: "current",
    ...(input.lastAction ?? input.previous?.lastAction) === undefined
      ? {}
      : { lastAction: input.lastAction ?? input.previous!.lastAction }
  };
  if (input.detectExternalChange && browserStateChanged(input.previous, next)) {
    next.externalChangeDetected = true;
  }
  return next;
}

function staleOrMissing(input: {
  sessionId: string;
  previous?: BrowserStateProjection;
}): BrowserStateProjection {
  if (input.previous?.sessionStatus === "active") {
    return {
      ...input.previous,
      freshness: "stale"
    };
  }
  return preserveLastAction({
    sessionStatus: "missing",
    sessionId: input.sessionId,
    freshness: "stale"
  }, input.previous);
}

function preserveLastAction(
  projection: BrowserStateProjection,
  previous: BrowserStateProjection | undefined
): BrowserStateProjection {
  return previous?.lastAction === undefined ? projection : { ...projection, lastAction: previous.lastAction };
}

function browserSnapshot(value: unknown): BrowserSnapshot | undefined {
  if (!isRecord(value) || typeof value.sessionId !== "string" || typeof value.url !== "string" || !isBrowserStateIdentity(value.identity)) {
    return undefined;
  }
  return value as BrowserSnapshot;
}

function browserTabList(value: Record<string, unknown> | undefined): BrowserTabList | undefined {
  if (value === undefined || typeof value.sessionId !== "string" || !Array.isArray(value.tabs)) return undefined;
  return {
    sessionId: value.sessionId,
    tabs: value.tabs.filter(isBrowserTab),
    blockedCount: typeof value.blockedCount === "number" ? value.blockedCount : 0
  };
}

function boundedTabs(tabs: readonly BrowserTab[]): BrowserTab[] {
  return tabs.slice(0, BROWSER_STATE_MAX_TABS).map(safeTab);
}

function safeTab(tab: BrowserTab): BrowserTab {
  return {
    ref: boundedText(tab.ref),
    url: redactUrlForMetadata(redactSensitiveText(tab.url)).slice(0, 500),
    ...(tab.title === undefined ? {} : { title: boundedText(tab.title) }),
    controlled: tab.controlled === true
  };
}

function mergeControlledTab(tabs: BrowserTab[], controlledTab: BrowserTab | undefined): BrowserTab[] {
  if (controlledTab === undefined) return tabs;
  const withoutControlled = tabs.filter((tab) => tab.ref !== controlledTab.ref).map((tab) => ({ ...tab, controlled: false }));
  return [controlledTab, ...withoutControlled].slice(0, BROWSER_STATE_MAX_TABS);
}

function browserStateChanged(previous: BrowserStateProjection | undefined, next: BrowserStateProjection): boolean {
  if (previous?.sessionStatus !== "active") return false;
  if (previous.controlledTab?.ref !== next.controlledTab?.ref) return true;
  if (previous.controlledTab?.url !== next.controlledTab?.url) return true;
  if (previous.identity !== undefined && next.identity !== undefined &&
    (previous.identity.documentEpoch !== next.identity.documentEpoch ||
      previous.identity.actionRevision !== next.identity.actionRevision)) return true;
  return tabKeys(previous.tabs).join("\n") !== tabKeys(next.tabs).join("\n");
}

function isBrowserStateIdentity(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.documentEpoch === "number" && Number.isSafeInteger(value.documentEpoch) && value.documentEpoch > 0 &&
    typeof value.actionRevision === "number" && Number.isSafeInteger(value.actionRevision) && value.actionRevision > 0 &&
    typeof value.observationId === "number" && Number.isSafeInteger(value.observationId) && value.observationId > 0;
}

function tabKeys(tabs: readonly BrowserTab[] | undefined): string[] {
  return (tabs ?? []).map((tab) => `${tab.ref}\u0000${tab.url}\u0000${tab.controlled ? "1" : "0"}`);
}

function browserExecutionChanged(tool: string, snapshot: BrowserSnapshot | undefined): boolean {
  if (snapshot?.actionDelta !== undefined) {
    return snapshot.actionDelta.outcome === "changed" ||
      snapshot.actionDelta.outcome === "new-tab-opened" ||
      snapshot.actionDelta.outcome === "same-tab-navigation";
  }
  return tool === "browser.navigate" || tool === "browser.switch_tab" || tool === "browser.dialog";
}

function boundedText(value: string): string {
  return redactSensitiveText(value).slice(0, BROWSER_STATE_MAX_TEXT_CHARS);
}

function isBrowserTab(value: unknown): value is BrowserTab {
  return isRecord(value) &&
    typeof value.ref === "string" &&
    typeof value.url === "string" &&
    typeof value.controlled === "boolean";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function linkedTimeoutController(
  signal: AbortSignal | undefined,
  timeoutMs: number
): AbortController & { dispose(): void } {
  const controller = new AbortController() as AbortController & { dispose(): void };
  const onAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted === true) controller.abort(signal.reason);
  else signal?.addEventListener("abort", onAbort, { once: true });
  const boundedTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? Math.floor(timeoutMs)
    : BROWSER_STATE_REFRESH_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort("browser-state-refresh-timeout"), boundedTimeoutMs);
  controller.dispose = () => {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onAbort);
  };
  return controller;
}

function abortableBrowserStateCall<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(browserStateAbortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(browserStateAbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

function browserStateAbortError(): Error {
  const error = new Error("Browser state refresh was cancelled.");
  error.name = "AbortError";
  return error;
}
