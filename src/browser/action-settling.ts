import type {
  BrowserActionDelta,
  BrowserActionDeltaElement,
  BrowserSnapshot,
  BrowserTab,
  BrowserWaitCondition
} from "../contracts/browser.js";
import { redactSensitiveText } from "../utils/redaction.js";
import { redactUrlForMetadata } from "./url-safety.js";

const DEFAULT_WAIT_TIMEOUT_MS = 2_000;
const DEFAULT_POLL_INTERVAL_MS = 75;
const DEFAULT_STABLE_WINDOW_MS = 150;
const DEFAULT_MINIMUM_OBSERVATION_MS = 250;
const MAX_WAIT_TIMEOUT_MS = 10_000;
const MAX_DELTA_ELEMENTS = 12;

export type BrowserActionSettlement = {
  snapshot: BrowserSnapshot;
  waitCondition: BrowserWaitCondition["kind"];
  conditionMet: boolean;
  timedOut: boolean;
};

export type NormalizedBrowserActionSettlementInput = {
  waitFor: BrowserWaitCondition;
  waitTimeoutMs: number;
};

/**
 * Validate model-provided wait arguments before a browser action is dispatched.
 * The backend still normalizes again while settling so direct callers cannot
 * bypass the runtime boundary.
 */
export function normalizeBrowserActionSettlementInput(input: {
  waitFor?: unknown;
  waitTimeoutMs?: unknown;
}): NormalizedBrowserActionSettlementInput {
  return {
    waitFor: normalizeWaitCondition(input.waitFor),
    waitTimeoutMs: normalizeWaitTimeout(input.waitTimeoutMs)
  };
}

export async function settleBrowserAction(input: {
  capture: () => Promise<BrowserSnapshot>;
  waitFor?: BrowserWaitCondition;
  waitTimeoutMs?: number;
  initialSnapshot?: BrowserSnapshot;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  stableWindowMs?: number;
  minimumObservationMs?: number;
  now?: () => number;
}): Promise<BrowserActionSettlement> {
  const normalized = normalizeBrowserActionSettlementInput(input);
  const waitFor = normalized.waitFor;
  const timeoutMs = normalized.waitTimeoutMs;
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const stableWindowMs = input.stableWindowMs ?? DEFAULT_STABLE_WINDOW_MS;
  const minimumObservationMs = input.minimumObservationMs ?? DEFAULT_MINIMUM_OBSERVATION_MS;
  const now = input.now ?? monotonicNow;
  const startedAt = now();
  let snapshot = input.initialSnapshot ?? await input.capture();
  let lastActionIdentity = browserActionIdentityKey(snapshot);
  let stableSince = startedAt;

  while (true) {
    throwIfAborted(input.signal);
    const elapsed = now() - startedAt;
    if (waitFor.kind !== "dom-stable" && browserWaitConditionMet(snapshot, waitFor)) {
      return { snapshot, waitCondition: waitFor.kind, conditionMet: true, timedOut: false };
    }
    if (
      waitFor.kind === "dom-stable" &&
      elapsed >= minimumObservationMs &&
      now() - stableSince >= stableWindowMs
    ) {
      return { snapshot, waitCondition: waitFor.kind, conditionMet: true, timedOut: false };
    }
    if (elapsed >= timeoutMs) {
      return { snapshot, waitCondition: waitFor.kind, conditionMet: false, timedOut: true };
    }

    await abortableDelay(Math.min(pollIntervalMs, timeoutMs - elapsed), input.signal);
    snapshot = await input.capture();
    const actionIdentity = browserActionIdentityKey(snapshot);
    if (actionIdentity !== lastActionIdentity) {
      lastActionIdentity = actionIdentity;
      stableSince = now();
    }
  }
}

export function withDispatchedActionSettlementFailure(input: {
  before?: BrowserSnapshot;
  latest: BrowserSnapshot;
  waitCondition: BrowserWaitCondition["kind"];
  stateObservation: "post-dispatch" | "last-known";
  openedTabs?: BrowserTab[];
}): BrowserSnapshot {
  const delta = createBrowserActionDelta({
    before: input.before,
    after: input.latest,
    waitCondition: input.waitCondition,
    conditionMet: false,
    timedOut: false,
    openedTabs: input.openedTabs
  });
  return {
    ...input.latest,
    actionDelta: {
      ...delta,
      outcome: "dispatched-unverified",
      actionDispatched: true,
      settlementFailed: true,
      documentChangeObserved: input.before !== undefined &&
        input.latest.identity.documentEpoch > input.before.identity.documentEpoch,
      stateObservation: input.stateObservation
    }
  };
}

export function withBrowserActionDelta(input: {
  before?: BrowserSnapshot;
  settlement: BrowserActionSettlement;
  after?: BrowserSnapshot;
  openedTabs?: BrowserTab[];
}): BrowserSnapshot {
  const after = input.after ?? input.settlement.snapshot;
  return {
    ...after,
    actionDelta: createBrowserActionDelta({
      before: input.before,
      after,
      waitCondition: input.settlement.waitCondition,
      conditionMet: input.settlement.conditionMet,
      timedOut: input.settlement.timedOut,
      openedTabs: input.openedTabs
    })
  };
}

export function createBrowserActionDelta(input: {
  before?: BrowserSnapshot;
  after: BrowserSnapshot;
  waitCondition: BrowserWaitCondition["kind"];
  conditionMet: boolean;
  timedOut: boolean;
  openedTabs?: BrowserTab[];
}): BrowserActionDelta {
  const beforeElements = deltaElements(input.before?.elements ?? []);
  const afterElements = deltaElements(input.after.elements ?? []);
  const beforeKeys = new Set(beforeElements.map(deltaElementKey));
  const afterKeys = new Set(afterElements.map(deltaElementKey));
  const addedElements = afterElements.filter((element) => !beforeKeys.has(deltaElementKey(element))).slice(0, MAX_DELTA_ELEMENTS);
  const removedElements = beforeElements.filter((element) => !afterKeys.has(deltaElementKey(element))).slice(0, MAX_DELTA_ELEMENTS);
  const beforeUrl = input.before === undefined ? undefined : redactUrlForMetadata(input.before.url);
  const afterUrl = redactUrlForMetadata(input.after.url);
  const sourceTab = input.before?.tab;
  const destinationTab = input.after.tab;
  const tabTransition = sourceTab !== undefined &&
    destinationTab !== undefined &&
    sourceTab.ref !== destinationTab.ref
    ? {
        source: safeDeltaTab(sourceTab),
        destination: safeDeltaTab(destinationTab)
      }
    : undefined;
  const changed = input.before === undefined ||
    !sameBrowserActionIdentity(input.before.identity, input.after.identity) ||
    beforeUrl !== afterUrl ||
    (input.openedTabs?.length ?? 0) > 0 ||
    tabTransition !== undefined;

  return {
    outcome: input.timedOut ? "timeout" : changed ? "changed" : "no-change",
    ...(input.before === undefined ? {} : { beforeIdentity: { ...input.before.identity } }),
    afterIdentity: { ...input.after.identity },
    waitCondition: input.waitCondition,
    conditionMet: input.conditionMet,
    url: {
      changed: beforeUrl !== afterUrl,
      ...(beforeUrl === undefined ? {} : { before: beforeUrl }),
      after: afterUrl
    },
    ...(addedElements.length === 0 ? {} : { addedElements }),
    ...(removedElements.length === 0 ? {} : { removedElements }),
    ...(input.openedTabs === undefined || input.openedTabs.length === 0 ? {} : {
      openedTabs: input.openedTabs.slice(0, 5).map((tab) => ({
        ref: tab.ref,
        url: redactUrlForMetadata(tab.url),
        ...(tab.title === undefined ? {} : { title: safeDeltaText(tab.title) })
      }))
    }),
    ...(tabTransition === undefined ? {} : { tabTransition })
  };
}

function browserActionIdentityKey(snapshot: BrowserSnapshot): string {
  return `${snapshot.identity.documentEpoch}:${snapshot.identity.actionRevision}`;
}

function sameBrowserActionIdentity(
  left: BrowserSnapshot["identity"],
  right: BrowserSnapshot["identity"]
): boolean {
  return left.documentEpoch === right.documentEpoch && left.actionRevision === right.actionRevision;
}

export function browserWaitConditionMet(snapshot: BrowserSnapshot, condition: BrowserWaitCondition): boolean {
  if (condition.kind === "url") return snapshot.url.includes(condition.contains);
  if (condition.kind === "text") return (snapshot.text ?? "").includes(condition.value);
  if (condition.kind === "dialog") return (snapshot.pendingDialogs?.length ?? 0) > 0;
  if (condition.kind === "element") {
    return (snapshot.elements ?? []).some((element) =>
      (condition.role === undefined || element.role === condition.role) &&
      (condition.name === undefined || element.name?.includes(condition.name) === true));
  }
  return false;
}

function normalizeWaitCondition(condition: unknown): BrowserWaitCondition {
  if (condition === undefined) return { kind: "dom-stable" };
  if (typeof condition !== "object" || condition === null || Array.isArray(condition)) {
    throw new Error("Browser waitFor must be an object.");
  }
  const candidate = condition as Record<string, unknown>;
  if (candidate.kind === "url") {
    assertOnlyWaitKeys(candidate, ["kind", "contains"]);
    return { kind: "url", contains: boundedRequired(candidate.contains, "URL wait text") };
  }
  if (candidate.kind === "text") {
    assertOnlyWaitKeys(candidate, ["kind", "value"]);
    return { kind: "text", value: boundedRequired(candidate.value, "page wait text") };
  }
  if (candidate.kind === "element") {
    assertOnlyWaitKeys(candidate, ["kind", "role", "name"]);
    const role = optionalBounded(candidate.role, "element role");
    const name = optionalBounded(candidate.name, "element name");
    if (role === undefined && name === undefined) {
      throw new Error("Browser element wait requires role or name.");
    }
    return {
      kind: "element",
      ...(role === undefined ? {} : { role }),
      ...(name === undefined ? {} : { name })
    };
  }
  if (candidate.kind === "dialog" || candidate.kind === "dom-stable") {
    assertOnlyWaitKeys(candidate, ["kind"]);
    return { kind: candidate.kind };
  }
  throw new Error("Unsupported browser wait condition.");
}

function normalizeWaitTimeout(value: unknown): number {
  if (value === undefined) return DEFAULT_WAIT_TIMEOUT_MS;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error("Browser waitTimeoutMs must be a positive number.");
  }
  return Math.min(Math.floor(value), MAX_WAIT_TIMEOUT_MS);
}

function boundedRequired(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is required.`);
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} must not be empty.`);
  if (normalized.length > 500) throw new Error(`${label} must be 500 characters or fewer.`);
  return normalized;
}

function optionalBounded(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return boundedRequired(value, label);
}

function assertOnlyWaitKeys(candidate: Record<string, unknown>, allowed: readonly string[]): void {
  const unexpected = Object.keys(candidate).find((key) => !allowed.includes(key));
  if (unexpected !== undefined) {
    throw new Error(`Browser wait condition does not allow field '${unexpected}' for kind '${String(candidate.kind)}'.`);
  }
}

function deltaElements(elements: NonNullable<BrowserSnapshot["elements"]>): BrowserActionDeltaElement[] {
  return elements.map((element) => ({
    ...(element.role === undefined ? {} : { role: safeDeltaText(element.role) }),
    ...(element.name === undefined ? {} : { name: safeDeltaText(element.name) })
  }));
}

function deltaElementKey(element: BrowserActionDeltaElement): string {
  return `${element.role ?? ""}\u0000${element.name ?? ""}`;
}

function safeDeltaText(value: string): string {
  return redactSensitiveText(value).slice(0, 160);
}

function safeDeltaTab(tab: BrowserTab): Pick<BrowserTab, "ref" | "url" | "title"> {
  return {
    ref: safeDeltaText(tab.ref),
    url: redactUrlForMetadata(tab.url),
    ...(tab.title === undefined ? {} : { title: safeDeltaText(tab.title) })
  };
}

async function abortableDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error("Browser action settling cancelled."));
      return;
    }
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    const onAbort = (): void => {
      clearTimeout(timeout);
      reject(new Error("Browser action settling cancelled."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new Error("Browser action settling cancelled.");
}

function monotonicNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}
