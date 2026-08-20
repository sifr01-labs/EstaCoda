import type {
  BrowserActionInput,
  BrowserFindResult,
  BrowserLocator,
  BrowserLocatorCandidate,
  BrowserSnapshot,
  BrowserStateIdentity
} from "../contracts/browser.js";
import { redactSensitiveText } from "../utils/redaction.js";
import { isBrowserSnapshotElementInteractable } from "./browser-interactability.js";

const MAX_LOCATOR_TEXT = 500;
const MAX_CANDIDATES = 8;
const MAX_NEARBY_CANDIDATES = 4;

export type BrowserTargetFailureReason =
  | "invalid-browser-target"
  | "stale-browser-ref"
  | "browser-ref-wrong-session"
  | "browser-ref-wrong-tab"
  | "browser-target-not-found"
  | "browser-target-ambiguous"
  | "browser-target-hidden"
  | "browser-target-disabled"
  | "browser-target-not-interactable";

export class BrowserTargetError extends Error {
  readonly reason: BrowserTargetFailureReason;
  readonly candidates: BrowserLocatorCandidate[];
  readonly nearbyCandidates: BrowserLocatorCandidate[];
  readonly currentSessionId?: string;
  readonly currentIdentity?: BrowserStateIdentity;
  readonly currentTabRef?: string;

  constructor(input: {
    reason: BrowserTargetFailureReason;
    message: string;
    candidates?: BrowserLocatorCandidate[];
    nearbyCandidates?: BrowserLocatorCandidate[];
    currentSessionId?: string;
    currentIdentity?: BrowserStateIdentity;
    currentTabRef?: string;
  }) {
    super(input.message);
    this.name = "BrowserTargetError";
    this.reason = input.reason;
    this.candidates = input.candidates?.slice(0, MAX_CANDIDATES) ?? [];
    this.nearbyCandidates = input.nearbyCandidates?.slice(0, MAX_NEARBY_CANDIDATES) ?? [];
    this.currentSessionId = input.currentSessionId;
    this.currentIdentity = input.currentIdentity;
    this.currentTabRef = input.currentTabRef;
  }
}

export function findBrowserLocator(snapshot: BrowserSnapshot, locator: BrowserLocator): BrowserFindResult {
  const normalized = normalizeBrowserLocator(locator);
  const tabRef = requireSnapshotTab(snapshot);
  assertLocatorIdentity(normalized, snapshot, tabRef);
  const available = (snapshot.elements ?? []).filter(isBrowserSnapshotElementInteractable);
  const candidates = available
    .filter((element) => locatorMatches(element, normalized))
    .slice(0, MAX_CANDIDATES)
    .map((element) => locatorCandidate(element, snapshot.identity, tabRef));
  const nearbyCandidates = candidates.length === 0
    ? nearbyBrowserLocatorCandidates(available, normalized, snapshot.identity, tabRef)
    : [];
  return {
    sessionId: snapshot.sessionId,
    identity: { ...snapshot.identity },
    tabRef,
    status: candidates.length === 0 ? "not-found" : candidates.length === 1 ? "found" : "ambiguous",
    candidates,
    ...(nearbyCandidates.length === 0 ? {} : { nearbyCandidates })
  };
}

function nearbyBrowserLocatorCandidates(
  elements: NonNullable<BrowserSnapshot["elements"]>,
  locator: BrowserLocator,
  identity: BrowserStateIdentity,
  tabRef: string
): BrowserLocatorCandidate[] {
  const requestedTokens = locatorTextTokens(locator);
  if (requestedTokens.length === 0) return [];
  const regionActionCounts = elements.reduce((counts, element) => {
    const region = comparable(element.regionText ?? element.withinText ?? "");
    if (region.length > 0) counts.set(region, (counts.get(region) ?? 0) + 1);
    return counts;
  }, new Map<string, number>());
  return elements
    .map((element, index) => ({
      element,
      index,
      score: nearbyCandidateScore(element, locator, requestedTokens, regionActionCounts)
    }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, MAX_NEARBY_CANDIDATES)
    .map(({ element }) => locatorCandidate(element, identity, tabRef));
}

function nearbyCandidateScore(
  element: NonNullable<BrowserSnapshot["elements"]>[number],
  locator: BrowserLocator,
  requestedTokens: readonly string[],
  regionActionCounts: ReadonlyMap<string, number>
): number {
  const directText = comparable([
    element.name,
    element.text,
    element.label
  ].filter((value): value is string => value !== undefined).join(" "));
  const regionText = comparable(element.regionText ?? element.withinText ?? "");
  const directTokens = new Set(tokenizeLocatorText(directText));
  const regionTokens = new Set(tokenizeLocatorText(regionText));
  const directOverlap = requestedTokens.filter((token) => directTokens.has(token)).length;
  const regionOverlap = requestedTokens.filter((token) => regionTokens.has(token)).length;
  const phrase = requestedTokens.join(" ");
  const directPhrase = phrase.length >= 4 && directText.includes(phrase) ? 12 : 0;
  const regionPhrase = phrase.length >= 4 && regionText.includes(phrase) ? 8 : 0;
  const regionCompactness = regionOverlap === 0
    ? 0
    : regionTokens.size <= 16
      ? 6
      : regionTokens.size <= 32
        ? 3
        : 0;
  const sharedRegionActions = regionOverlap === 0 ? 0 : regionActionCounts.get(regionText) ?? 0;
  const sharedRegionBonus = Math.max(0, Math.min(sharedRegionActions, 4) - 1) * 16;
  const role = locator.role !== undefined && comparable(element.role ?? "") === comparable(locator.role) ? 1 : 0;
  return directOverlap * 8 + regionOverlap * 4 + directPhrase + regionPhrase + regionCompactness + sharedRegionBonus +
    (directOverlap > 0 || regionOverlap > 0 ? role : 0);
}

function locatorTextTokens(locator: BrowserLocator): string[] {
  return tokenizeLocatorText([
    locator.name,
    locator.text,
    locator.label,
    locator.withinText
  ].filter((value): value is string => value !== undefined).join(" "));
}

function tokenizeLocatorText(value: string): string[] {
  return [...new Set(comparable(value)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 2))];
}

export function resolveBrowserTarget(snapshot: BrowserSnapshot, input: BrowserActionInput): BrowserLocatorCandidate {
  const tabRef = requireSnapshotTab(snapshot);
  const hasRef = input.ref !== undefined;
  const hasLocator = input.locator !== undefined;
  if (hasRef === hasLocator) {
    throw targetError("invalid-browser-target", "Browser action requires exactly one of ref or locator.", snapshot, tabRef);
  }

  if (input.locator !== undefined) {
    const result = findBrowserLocator(snapshot, input.locator);
    if (result.status === "not-found") {
      const unavailable = findUnavailableMatch(snapshot, input.locator, tabRef);
      if (unavailable?.hidden === true) {
        throw targetError("browser-target-hidden", "Browser locator matched only a hidden target.", snapshot, tabRef);
      }
      if (unavailable?.disabled === true) {
        throw targetError("browser-target-disabled", "Browser locator matched only a disabled target.", snapshot, tabRef);
      }
      if (unavailable?.interactable === false) {
        throw targetError(
          "browser-target-not-interactable",
          `Browser locator matched only a non-interactable target${unavailable.interactabilityReason === undefined ? "." : ` (${unavailable.interactabilityReason}).`}`,
          snapshot,
          tabRef
        );
      }
      throw targetError(
        "browser-target-not-found",
        "Browser locator did not match a current element.",
        snapshot,
        tabRef,
        result.nearbyCandidates
      );
    }
    if (result.status === "ambiguous") {
      throw new BrowserTargetError({
        reason: "browser-target-ambiguous",
        message: `Browser locator matched ${result.candidates.length} current elements; refine the locator instead of guessing.`,
        candidates: result.candidates,
        currentSessionId: snapshot.sessionId,
        currentIdentity: snapshot.identity,
        currentTabRef: tabRef
      });
    }
    return result.candidates[0]!;
  }

  assertBrowserTargetContext(snapshot, input);
  const element = (snapshot.elements ?? []).find((candidate) => candidate.ref === input.ref);
  if (element === undefined) {
    throw targetError("browser-target-not-found", `Browser element ref not found: ${input.ref}`, snapshot, tabRef);
  }
  if (element.hidden === true) {
    throw targetError("browser-target-hidden", `Browser element ref is hidden: ${input.ref}`, snapshot, tabRef);
  }
  if (element.disabled === true) {
    throw targetError("browser-target-disabled", `Browser element ref is disabled: ${input.ref}`, snapshot, tabRef);
  }
  if (element.interactable === false) {
    throw targetError(
      "browser-target-not-interactable",
      `Browser element ref is not interactable${element.interactabilityReason === undefined ? `: ${input.ref}` : ` (${element.interactabilityReason}): ${input.ref}`}`,
      snapshot,
      tabRef
    );
  }
  return locatorCandidate(element, snapshot.identity, tabRef);
}

/** Validates a runtime-bound action without resolving a semantic locator again. */
export function assertBrowserTargetContext(snapshot: BrowserSnapshot, input: BrowserActionInput): void {
  const tabRef = requireSnapshotTab(snapshot);
  if (input.sessionId?.trim().length === 0 || input.sessionId === undefined || !isBrowserStateIdentity(input.identity) || input.tabRef?.trim().length === 0 || input.tabRef === undefined) {
    throw targetError(
      "invalid-browser-target",
      "Ref-based browser actions require the sessionId, canonical identity, and tabRef that produced the ref.",
      snapshot,
      tabRef
    );
  }
  if (input.sessionId !== snapshot.sessionId) {
    throw targetError(
      "browser-ref-wrong-session",
      `Browser ref ${input.ref} belongs to session ${input.sessionId}, but the current session is ${snapshot.sessionId}.`,
      snapshot,
      tabRef
    );
  }
  if (input.tabRef !== tabRef) {
    throw targetError(
      "browser-ref-wrong-tab",
      `Browser ref ${input.ref} belongs to tab ${input.tabRef}, but the controlled tab is ${tabRef}.`,
      snapshot,
      tabRef
    );
  }
  if (!sameRefValidityIdentity(input.identity, snapshot.identity)) {
    throw targetError(
      "stale-browser-ref",
      `Browser ref ${input.ref} came from documentEpoch=${input.identity.documentEpoch}, actionRevision=${input.identity.actionRevision}, but the current identity is documentEpoch=${snapshot.identity.documentEpoch}, actionRevision=${snapshot.identity.actionRevision}. Take a fresh snapshot or use a semantic locator.`,
      snapshot,
      tabRef
    );
  }
}

export function browserTargetFailureMetadata(error: unknown): Record<string, unknown> | undefined {
  if (!(error instanceof BrowserTargetError)) return undefined;
  return {
    reason: error.reason,
    actionDispatched: false,
    ...(error.currentSessionId === undefined ? {} : { currentSessionId: error.currentSessionId }),
    ...(error.currentIdentity === undefined ? {} : { currentIdentity: error.currentIdentity }),
    ...(error.currentTabRef === undefined ? {} : { currentTabRef: error.currentTabRef }),
    ...(error.candidates.length === 0 ? {} : { candidates: error.candidates }),
    ...(error.nearbyCandidates.length === 0 ? {} : { nearbyCandidates: error.nearbyCandidates })
  };
}

function normalizeBrowserLocator(locator: BrowserLocator): BrowserLocator {
  const normalized: BrowserLocator = {
    ...(locator.role === undefined ? {} : { role: bounded(locator.role, "role") }),
    ...(locator.name === undefined ? {} : { name: bounded(locator.name, "name") }),
    ...(locator.text === undefined ? {} : { text: bounded(locator.text, "text") }),
    ...(locator.label === undefined ? {} : { label: bounded(locator.label, "label") }),
    ...(locator.withinText === undefined ? {} : { withinText: bounded(locator.withinText, "withinText") }),
    ...(locator.exact === undefined ? {} : { exact: locator.exact }),
    ...(locator.identity === undefined ? {} : { identity: normalizeBrowserStateIdentity(locator.identity) })
  };
  if (normalized.role === undefined && normalized.name === undefined && normalized.text === undefined && normalized.label === undefined && normalized.withinText === undefined) {
    throw new BrowserTargetError({
      reason: "invalid-browser-target",
      message: "Browser locator requires role, name, text, label, or withinText."
    });
  }
  return normalized;
}

function locatorMatches(element: NonNullable<BrowserSnapshot["elements"]>[number], locator: BrowserLocator): boolean {
  return matches(element.role, locator.role, locator.exact, true) &&
    matches(element.name, locator.name, locator.exact) &&
    matches(element.text ?? element.name, locator.text, locator.exact) &&
    matches(element.label ?? element.name, locator.label, locator.exact) &&
    matches(element.withinText, locator.withinText, locator.exact);
}

function matches(actual: string | undefined, expected: string | undefined, exact = false, forceExact = false): boolean {
  if (expected === undefined) return true;
  if (actual === undefined) return false;
  const left = comparable(actual);
  const right = comparable(expected);
  return exact || forceExact ? left === right : left.includes(right);
}

function comparable(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase();
}

function bounded(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > MAX_LOCATOR_TEXT) {
    throw new BrowserTargetError({
      reason: "invalid-browser-target",
      message: `Browser locator ${field} must contain 1-${MAX_LOCATOR_TEXT} characters.`
    });
  }
  return normalized;
}

function locatorCandidate(
  element: NonNullable<BrowserSnapshot["elements"]>[number],
  identity: BrowserStateIdentity,
  tabRef: string
): BrowserLocatorCandidate {
  return {
    ref: element.ref,
    identity: { ...identity },
    tabRef,
    ...(element.role === undefined ? {} : { role: safeCandidateText(element.role) }),
    ...(element.name === undefined ? {} : { name: safeCandidateText(element.name) }),
    ...(element.text === undefined ? {} : { text: safeCandidateText(element.text) }),
    ...(element.label === undefined ? {} : { label: safeCandidateText(element.label) }),
    ...(element.withinText === undefined ? {} : { withinText: safeCandidateText(element.withinText) }),
    ...(element.regionText === undefined ? {} : { regionText: safeCandidateText(element.regionText) })
  };
}

function safeCandidateText(value: string): string {
  return redactSensitiveText(value).slice(0, 240);
}

function findUnavailableMatch(snapshot: BrowserSnapshot, locator: BrowserLocator, tabRef: string) {
  const normalized = normalizeBrowserLocator(locator);
  assertLocatorIdentity(normalized, snapshot, tabRef);
  return (snapshot.elements ?? []).find((element) => locatorMatches(element, normalized));
}

function assertLocatorIdentity(locator: BrowserLocator, snapshot: BrowserSnapshot, tabRef: string): void {
  if (locator.identity !== undefined && !sameRefValidityIdentity(locator.identity, snapshot.identity)) {
    throw targetError(
      "stale-browser-ref",
      `Browser locator identity is stale; the current identity is documentEpoch=${snapshot.identity.documentEpoch}, actionRevision=${snapshot.identity.actionRevision}.`,
      snapshot,
      tabRef
    );
  }
}

function requireSnapshotTab(snapshot: BrowserSnapshot): string {
  const tabRef = snapshot.tab?.ref;
  if (tabRef === undefined || tabRef.trim().length === 0) {
    throw new BrowserTargetError({
      reason: "invalid-browser-target",
      message: "Browser target resolution requires a controlled tab reference.",
      currentIdentity: snapshot.identity,
      currentSessionId: snapshot.sessionId
    });
  }
  return tabRef;
}

function targetError(
  reason: BrowserTargetFailureReason,
  message: string,
  snapshot: BrowserSnapshot,
  tabRef: string,
  nearbyCandidates?: BrowserLocatorCandidate[]
): BrowserTargetError {
  return new BrowserTargetError({
    reason,
    message,
    currentIdentity: snapshot.identity,
    currentSessionId: snapshot.sessionId,
    currentTabRef: tabRef,
    nearbyCandidates
  });
}

export function isBrowserStateIdentity(value: unknown): value is BrowserStateIdentity {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const identity = value as Partial<BrowserStateIdentity>;
  return Number.isSafeInteger(identity.documentEpoch) && (identity.documentEpoch ?? 0) > 0 &&
    Number.isSafeInteger(identity.actionRevision) && (identity.actionRevision ?? 0) > 0 &&
    Number.isSafeInteger(identity.observationId) && (identity.observationId ?? 0) > 0;
}

function normalizeBrowserStateIdentity(identity: BrowserStateIdentity): BrowserStateIdentity {
  if (!isBrowserStateIdentity(identity)) {
    throw new BrowserTargetError({
      reason: "invalid-browser-target",
      message: "Browser identity requires positive integer documentEpoch, actionRevision, and observationId values."
    });
  }
  return { ...identity };
}

function sameRefValidityIdentity(left: BrowserStateIdentity, right: BrowserStateIdentity): boolean {
  return left.documentEpoch === right.documentEpoch && left.actionRevision === right.actionRevision;
}
