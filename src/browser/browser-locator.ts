import type {
  BrowserActionInput,
  BrowserFindResult,
  BrowserLocator,
  BrowserLocatorCandidate,
  BrowserSnapshot
} from "../contracts/browser.js";
import { redactSensitiveText } from "../utils/redaction.js";

const MAX_LOCATOR_TEXT = 500;
const MAX_CANDIDATES = 8;

export type BrowserTargetFailureReason =
  | "invalid-browser-target"
  | "stale-browser-ref"
  | "browser-ref-wrong-tab"
  | "browser-target-not-found"
  | "browser-target-ambiguous"
  | "browser-target-hidden"
  | "browser-target-disabled";

export class BrowserTargetError extends Error {
  readonly reason: BrowserTargetFailureReason;
  readonly candidates: BrowserLocatorCandidate[];
  readonly currentRevision?: number;
  readonly currentTabRef?: string;

  constructor(input: {
    reason: BrowserTargetFailureReason;
    message: string;
    candidates?: BrowserLocatorCandidate[];
    currentRevision?: number;
    currentTabRef?: string;
  }) {
    super(input.message);
    this.name = "BrowserTargetError";
    this.reason = input.reason;
    this.candidates = input.candidates?.slice(0, MAX_CANDIDATES) ?? [];
    this.currentRevision = input.currentRevision;
    this.currentTabRef = input.currentTabRef;
  }
}

export function findBrowserLocator(snapshot: BrowserSnapshot, locator: BrowserLocator): BrowserFindResult {
  const normalized = normalizeBrowserLocator(locator);
  const tabRef = requireSnapshotTab(snapshot);
  assertLocatorRevision(normalized, snapshot, tabRef);
  const available = (snapshot.elements ?? []).filter((element) => element.hidden !== true && element.disabled !== true);
  const candidates = available
    .filter((element) => locatorMatches(element, normalized))
    .slice(0, MAX_CANDIDATES)
    .map((element) => locatorCandidate(element, snapshot.revision, tabRef));
  return {
    sessionId: snapshot.sessionId,
    revision: snapshot.revision,
    tabRef,
    status: candidates.length === 0 ? "not-found" : candidates.length === 1 ? "found" : "ambiguous",
    candidates
  };
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
      throw targetError("browser-target-not-found", "Browser locator did not match a current element.", snapshot, tabRef);
    }
    if (result.status === "ambiguous") {
      throw new BrowserTargetError({
        reason: "browser-target-ambiguous",
        message: `Browser locator matched ${result.candidates.length} current elements; refine the locator instead of guessing.`,
        candidates: result.candidates,
        currentRevision: snapshot.revision,
        currentTabRef: tabRef
      });
    }
    return result.candidates[0]!;
  }

  if (!Number.isInteger(input.revision) || (input.revision ?? 0) <= 0 || input.tabRef?.trim().length === 0 || input.tabRef === undefined) {
    throw targetError(
      "invalid-browser-target",
      "Ref-based browser actions require the snapshot revision and tabRef that produced the ref.",
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
  if (input.revision !== snapshot.revision) {
    throw targetError(
      "stale-browser-ref",
      `Browser ref ${input.ref} came from revision ${input.revision}, but the current revision is ${snapshot.revision}. Take a fresh snapshot or use a semantic locator.`,
      snapshot,
      tabRef
    );
  }
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
  return locatorCandidate(element, snapshot.revision, tabRef);
}

export function browserTargetFailureMetadata(error: unknown): Record<string, unknown> | undefined {
  if (!(error instanceof BrowserTargetError)) return undefined;
  return {
    reason: error.reason,
    ...(error.currentRevision === undefined ? {} : { currentRevision: error.currentRevision }),
    ...(error.currentTabRef === undefined ? {} : { currentTabRef: error.currentTabRef }),
    ...(error.candidates.length === 0 ? {} : { candidates: error.candidates })
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
    ...(locator.revision === undefined ? {} : { revision: locator.revision })
  };
  if (normalized.role === undefined && normalized.name === undefined && normalized.text === undefined && normalized.label === undefined && normalized.withinText === undefined) {
    throw new BrowserTargetError({
      reason: "invalid-browser-target",
      message: "Browser locator requires role, name, text, label, or withinText."
    });
  }
  if (normalized.revision !== undefined && (!Number.isInteger(normalized.revision) || normalized.revision <= 0)) {
    throw new BrowserTargetError({
      reason: "invalid-browser-target",
      message: "Browser locator revision must be a positive integer."
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
  revision: number,
  tabRef: string
): BrowserLocatorCandidate {
  return {
    ref: element.ref,
    revision,
    tabRef,
    ...(element.role === undefined ? {} : { role: safeCandidateText(element.role) }),
    ...(element.name === undefined ? {} : { name: safeCandidateText(element.name) }),
    ...(element.text === undefined ? {} : { text: safeCandidateText(element.text) }),
    ...(element.label === undefined ? {} : { label: safeCandidateText(element.label) }),
    ...(element.withinText === undefined ? {} : { withinText: safeCandidateText(element.withinText) })
  };
}

function safeCandidateText(value: string): string {
  return redactSensitiveText(value).slice(0, 240);
}

function findUnavailableMatch(snapshot: BrowserSnapshot, locator: BrowserLocator, tabRef: string) {
  const normalized = normalizeBrowserLocator(locator);
  assertLocatorRevision(normalized, snapshot, tabRef);
  return (snapshot.elements ?? []).find((element) => locatorMatches(element, normalized));
}

function assertLocatorRevision(locator: BrowserLocator, snapshot: BrowserSnapshot, tabRef: string): void {
  if (locator.revision !== undefined && locator.revision !== snapshot.revision) {
    throw targetError(
      "stale-browser-ref",
      `Browser locator revision ${locator.revision} is stale; the current revision is ${snapshot.revision}.`,
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
      currentRevision: snapshot.revision
    });
  }
  return tabRef;
}

function targetError(
  reason: BrowserTargetFailureReason,
  message: string,
  snapshot: BrowserSnapshot,
  tabRef: string
): BrowserTargetError {
  return new BrowserTargetError({
    reason,
    message,
    currentRevision: snapshot.revision,
    currentTabRef: tabRef
  });
}
