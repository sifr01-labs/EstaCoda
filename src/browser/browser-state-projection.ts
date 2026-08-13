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
const BROWSER_STATE_MAX_TEXT_CHARS = 160;

export async function refreshBrowserStateProjection(input: {
  backend: BrowserBackend;
  sessionId: string;
  previous?: BrowserStateProjection;
}): Promise<BrowserStateProjection> {
  if (input.backend.kind === "unconfigured") {
    return preserveLastAction({
      sessionStatus: "unconfigured",
      freshness: "current"
    }, input.previous);
  }

  let available = false;
  try {
    available = await input.backend.isAvailable();
  } catch {
    return staleOrMissing(input);
  }
  if (!available) return staleOrMissing(input);

  try {
    const tabs = input.backend.tabs === undefined
      ? undefined
      : await input.backend.tabs({ sessionId: input.sessionId });
    const snapshot = input.backend.snapshot === undefined
      ? undefined
      : await input.backend.snapshot({ sessionId: input.sessionId });
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
    ...(input.snapshot?.revision === undefined ? input.previous?.revision === undefined ? {} : { revision: input.previous.revision } : { revision: input.snapshot.revision }),
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
  if (!isRecord(value) || typeof value.sessionId !== "string" || typeof value.url !== "string" || typeof value.revision !== "number") {
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
  if (previous.revision !== undefined && next.revision !== undefined && previous.revision !== next.revision) return true;
  return tabKeys(previous.tabs).join("\n") !== tabKeys(next.tabs).join("\n");
}

function tabKeys(tabs: readonly BrowserTab[] | undefined): string[] {
  return (tabs ?? []).map((tab) => `${tab.ref}\u0000${tab.url}\u0000${tab.controlled ? "1" : "0"}`);
}

function browserExecutionChanged(tool: string, snapshot: BrowserSnapshot | undefined): boolean {
  if (snapshot?.actionDelta !== undefined) return snapshot.actionDelta.outcome === "changed";
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
