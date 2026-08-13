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
  const waitFor = normalizeWaitCondition(input.waitFor);
  const timeoutMs = normalizeWaitTimeout(input.waitTimeoutMs);
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const stableWindowMs = input.stableWindowMs ?? DEFAULT_STABLE_WINDOW_MS;
  const minimumObservationMs = input.minimumObservationMs ?? DEFAULT_MINIMUM_OBSERVATION_MS;
  const now = input.now ?? monotonicNow;
  const startedAt = now();
  let snapshot = input.initialSnapshot ?? await input.capture();
  let lastRevision = snapshot.revision;
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
    if (snapshot.revision !== lastRevision) {
      lastRevision = snapshot.revision;
      stableSince = now();
    }
  }
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
  const changed = input.before === undefined ||
    input.before.revision !== input.after.revision ||
    (input.openedTabs?.length ?? 0) > 0;

  return {
    outcome: input.timedOut ? "timeout" : changed ? "changed" : "no-change",
    beforeRevision: input.before?.revision ?? 0,
    afterRevision: input.after.revision,
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
    })
  };
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

function normalizeWaitCondition(condition: BrowserWaitCondition | undefined): BrowserWaitCondition {
  if (condition === undefined) return { kind: "dom-stable" };
  if (condition.kind === "url") return { kind: "url", contains: boundedRequired(condition.contains, "URL wait text") };
  if (condition.kind === "text") return { kind: "text", value: boundedRequired(condition.value, "page wait text") };
  if (condition.kind === "element") {
    if (condition.role === undefined && condition.name === undefined) {
      throw new Error("Browser element wait requires role or name.");
    }
    return {
      kind: "element",
      ...(condition.role === undefined ? {} : { role: boundedRequired(condition.role, "element role") }),
      ...(condition.name === undefined ? {} : { name: boundedRequired(condition.name, "element name") })
    };
  }
  if (condition.kind === "dialog" || condition.kind === "dom-stable") return condition;
  throw new Error("Unsupported browser wait condition.");
}

function normalizeWaitTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_WAIT_TIMEOUT_MS;
  if (!Number.isFinite(value) || value <= 0) throw new Error("Browser waitTimeoutMs must be a positive number.");
  return Math.min(Math.floor(value), MAX_WAIT_TIMEOUT_MS);
}

function boundedRequired(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} must not be empty.`);
  if (normalized.length > 500) throw new Error(`${label} must be 500 characters or fewer.`);
  return normalized;
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
