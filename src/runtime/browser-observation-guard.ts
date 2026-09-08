import { createHash } from "node:crypto";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";

const BROWSER_OBSERVATION_TOOLS = new Set([
  "browser.snapshot",
  "browser.tabs",
  "browser.find",
  "browser.extract",
  "browser.get_images",
  "browser.console",
  "browser.screenshot",
  "browser.vision",
  "browser.cdp",
]);

const BROWSER_ACTION_TOOLS = new Set([
  "browser.navigate",
  "browser.click",
  "browser.type",
  "browser.fill_protected_form",
  "browser.select",
  "browser.scroll",
  "browser.press",
  "browser.back",
  "browser.switch_tab",
  "browser.dialog",
  "browser.download",
]);

const WHOLE_STATE_OBSERVATIONS = new Set([
  "browser.snapshot",
  "browser.tabs",
  "browser.get_images",
  "browser.console",
  "browser.screenshot",
  "browser.vision",
]);

const TARGET_FAILURE_REASONS = new Set([
  "browser-target-not-found",
  "browser-target-ambiguous",
  "browser-target-hidden",
  "browser-target-disabled",
  "browser-target-not-interactable",
  "stale-browser-ref",
  "browser-ref-wrong-session",
  "browser-ref-wrong-tab",
]);

export type BrowserObservationAssessment = {
  tool: string;
  count: number;
  evidenceAdvanced: boolean;
  actionDispatched: boolean;
  shouldNudge: boolean;
  shouldRetarget: boolean;
  shouldStop: boolean;
  suppressedTools: string[];
  visualEscalationReason?:
    | "semantic-match-ambiguous"
    | "visible-text-without-grounded-action"
    | "grounded-target-not-found"
    | "target-resolution-failed"
    | "native-action-no-change"
    | "repeated-incidental-match";
} | undefined;

/**
 * Supervises browser work from trusted execution results without treating an
 * unchanged page as proof that the agent learned nothing. Fingerprints remain
 * bounded, in memory, and are never exposed or persisted.
 */
export class BrowserObservationGuard {
  readonly #repeatLimit: number;
  readonly #seenEvidence = new Set<string>();
  readonly #suppressedTools = new Set<string>();
  readonly #ineffectiveActionSignatures = new Set<string>();
  readonly #targetFailureSignatures = new Set<string>();
  readonly #terminalStrategySignatures = new Set<string>();
  readonly #semanticPages = new Map<string, string>();
  #noProgressCount = 0;
  #retargetUsed = false;

  constructor(limit: number) {
    this.#repeatLimit = Math.max(2, Math.floor(limit));
  }

  observe(executions: readonly ToolExecutionRecord[]): BrowserObservationAssessment {
    const browserExecutions = executions.filter((execution) =>
      BROWSER_OBSERVATION_TOOLS.has(execution.tool.name) || BROWSER_ACTION_TOOLS.has(execution.tool.name)
    );
    if (browserExecutions.length === 0) return undefined;

    const terminalStrategies = browserExecutions.filter(isTerminalBrowserStrategyFailure);
    if (terminalStrategies.length > 0) return this.#observeTerminalStrategies(terminalStrategies);

    // Document revisions prove freshness, not useful progress. Compare the actual
    // page before the successful-action fast paths can reset the loop budget.
    const unchangedNavigations = new Set<ToolExecutionRecord>();
    for (const execution of browserExecutions) {
      const snapshot = asRecord(execution.result?.metadata?.snapshot);
      if (execution.result?.ok !== true || snapshot === undefined) continue;
      const key = stableSerialize([snapshot.sessionId, asRecord(snapshot.tab)?.ref]);
      const evidence = fingerprint(stableBrowserSnapshot(snapshot));
      if (isNavigationAction(execution) && this.#semanticPages.get(key) === evidence) {
        unchangedNavigations.add(execution);
      }
      if (!this.#semanticPages.has(key) && this.#semanticPages.size >= 16) {
        this.#semanticPages.delete(this.#semanticPages.keys().next().value!);
      }
      this.#semanticPages.set(key, evidence);
    }
    const changedAction = browserExecutions.find((execution) =>
      !unchangedNavigations.has(execution) && isStateChangingBrowserAction(execution));
    if (changedAction !== undefined) {
      this.#resetAfterProgress();
      return undefined;
    }

    const targetFailures = browserExecutions.filter(isTargetResolutionFailure);
    if (targetFailures.length > 0) return this.#observeTargetFailures(targetFailures);

    const ineffectiveActions = browserExecutions.filter((execution) =>
      unchangedNavigations.has(execution) || isIneffectiveDispatchedAction(execution));
    if (ineffectiveActions.length > 0) return this.#observeIneffectiveActions(ineffectiveActions);

    const successfulAction = browserExecutions.find((execution) =>
      !unchangedNavigations.has(execution) && BROWSER_ACTION_TOOLS.has(execution.tool.name) && execution.result?.ok === true
    );
    if (successfulAction !== undefined) {
      this.#resetAfterProgress();
      return undefined;
    }

    const evidenceFingerprints = browserExecutions.map(browserEvidenceFingerprint).filter(
      (value): value is string => value !== undefined
    );
    const evidenceAdvanced = evidenceFingerprints.some((fingerprint) => !this.#seenEvidence.has(fingerprint));
    for (const fingerprint of evidenceFingerprints) this.#rememberEvidence(fingerprint);

    if (evidenceAdvanced) {
      this.#noProgressCount = 0;
      this.#suppressedTools.clear();
      return assessment({
        executions: browserExecutions,
        count: 0,
        evidenceAdvanced: true,
        actionDispatched: false,
        shouldNudge: false,
        shouldRetarget: false,
        shouldStop: false,
        suppressedTools: [],
        visualEscalationReason: browserVisualEscalationReason(browserExecutions)
      });
    }

    this.#noProgressCount += 1;
    for (const execution of browserExecutions) {
      if (WHOLE_STATE_OBSERVATIONS.has(execution.tool.name)) this.#suppressedTools.add(execution.tool.name);
    }
    return assessment({
      executions: browserExecutions,
      count: this.#noProgressCount,
      evidenceAdvanced: false,
      actionDispatched: false,
      shouldNudge: this.#noProgressCount === 1,
      shouldRetarget: false,
      shouldStop: this.#noProgressCount >= this.#repeatLimit - 1,
      suppressedTools: [...this.#suppressedTools].sort(),
      visualEscalationReason: browserExecutions.some((execution) => execution.tool.name === "browser.find")
        ? "repeated-incidental-match"
        : browserVisualEscalationReason(browserExecutions)
    });
  }

  #observeTargetFailures(executions: readonly ToolExecutionRecord[]): NonNullable<BrowserObservationAssessment> {
    const signatures = executions.map(browserCallSignature);
    const repeatedTarget = signatures.some((signature) => this.#targetFailureSignatures.has(signature));
    for (const signature of signatures) this.#targetFailureSignatures.add(signature);
    this.#noProgressCount += 1;
    const shouldStop = repeatedTarget || this.#retargetUsed;
    this.#retargetUsed = true;
    return assessment({
      executions,
      count: this.#noProgressCount,
      evidenceAdvanced: false,
      actionDispatched: false,
      shouldNudge: !shouldStop,
      shouldRetarget: !shouldStop,
      shouldStop,
      suppressedTools: [...this.#suppressedTools].sort(),
      visualEscalationReason: shouldStop ? undefined : "target-resolution-failed"
    });
  }

  #observeIneffectiveActions(executions: readonly ToolExecutionRecord[]): NonNullable<BrowserObservationAssessment> {
    const signatures = executions.map(browserCallSignature);
    const repeatedAction = signatures.some((signature) => this.#ineffectiveActionSignatures.has(signature));
    for (const signature of signatures) this.#ineffectiveActionSignatures.add(signature);
    this.#noProgressCount += 1;
    const shouldStop = repeatedAction || this.#noProgressCount >= this.#repeatLimit;
    return assessment({
      executions,
      count: this.#noProgressCount,
      evidenceAdvanced: false,
      actionDispatched: true,
      shouldNudge: !shouldStop,
      shouldRetarget: false,
      shouldStop,
      suppressedTools: [...this.#suppressedTools].sort(),
      visualEscalationReason: shouldStop || executions.every(isNavigationAction) ? undefined : "native-action-no-change"
    });
  }

  #observeTerminalStrategies(executions: readonly ToolExecutionRecord[]): NonNullable<BrowserObservationAssessment> {
    const signatures = executions.map(browserTerminalStrategySignature);
    const repeatedStrategy = signatures.some((signature) => this.#terminalStrategySignatures.has(signature));
    for (const signature of signatures) this.#terminalStrategySignatures.add(signature);
    this.#noProgressCount += 1;
    const shouldStop = repeatedStrategy || this.#noProgressCount >= this.#repeatLimit;
    return assessment({
      executions,
      count: this.#noProgressCount,
      evidenceAdvanced: false,
      actionDispatched: true,
      shouldNudge: !shouldStop,
      shouldRetarget: false,
      shouldStop,
      suppressedTools: [...this.#suppressedTools].sort()
    });
  }

  #rememberEvidence(fingerprint: string): void {
    if (this.#seenEvidence.size >= 64) {
      const oldest = this.#seenEvidence.values().next().value as string | undefined;
      if (oldest !== undefined) this.#seenEvidence.delete(oldest);
    }
    this.#seenEvidence.add(fingerprint);
  }

  #resetAfterProgress(): void {
    this.#seenEvidence.clear();
    this.#suppressedTools.clear();
    this.#ineffectiveActionSignatures.clear();
    this.#targetFailureSignatures.clear();
    this.#noProgressCount = 0;
    this.#retargetUsed = false;
  }
}

function assessment(input: {
  executions: readonly ToolExecutionRecord[];
  count: number;
  evidenceAdvanced: boolean;
  actionDispatched: boolean;
  shouldNudge: boolean;
  shouldRetarget: boolean;
  shouldStop: boolean;
  suppressedTools: string[];
  visualEscalationReason?: NonNullable<BrowserObservationAssessment>["visualEscalationReason"];
}): NonNullable<BrowserObservationAssessment> {
  return {
    tool: [...new Set(input.executions.map((execution) => execution.tool.name))].sort().join(", "),
    count: input.count,
    evidenceAdvanced: input.evidenceAdvanced,
    actionDispatched: input.actionDispatched,
    shouldNudge: input.shouldNudge,
    shouldRetarget: input.shouldRetarget,
    shouldStop: input.shouldStop,
    suppressedTools: input.suppressedTools,
    ...(input.visualEscalationReason === undefined ? {} : { visualEscalationReason: input.visualEscalationReason })
  };
}

function browserVisualEscalationReason(
  executions: readonly ToolExecutionRecord[]
): NonNullable<BrowserObservationAssessment>["visualEscalationReason"] | undefined {
  for (const execution of executions) {
    const value = execution.result?.metadata?.visualEscalation;
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const reason = (value as { reason?: unknown }).reason;
    if (reason === "semantic-match-ambiguous" || reason === "visible-text-without-grounded-action" ||
        reason === "grounded-target-not-found") return reason;
  }
  return undefined;
}

function isStateChangingBrowserAction(execution: ToolExecutionRecord): boolean {
  if (!BROWSER_ACTION_TOOLS.has(execution.tool.name) || execution.result?.ok !== true) return false;
  if (execution.tool.name === "browser.download") {
    return execution.result.metadata?.outcome === "download-completed";
  }
  const outcome = browserActionOutcome(execution);
  if (outcome === "changed" || outcome === "new-tab-opened" || outcome === "same-tab-navigation") return true;
  if (outcome === "dispatched-unverified") {
    const delta = browserActionDelta(execution);
    return delta?.documentChangeObserved === true || asRecord(delta?.url)?.changed === true;
  }
  return outcome === undefined;
}

function isNavigationAction(execution: ToolExecutionRecord): boolean {
  return execution.tool.name === "browser.navigate" || execution.tool.name === "browser.back" ||
    browserActionOutcome(execution) === "same-tab-navigation";
}

function isIneffectiveDispatchedAction(execution: ToolExecutionRecord): boolean {
  if (!BROWSER_ACTION_TOOLS.has(execution.tool.name)) return false;
  if (execution.tool.name === "browser.download") {
    return execution.result?.metadata?.outcome !== "download-completed";
  }
  if (execution.result?.ok !== true) return false;
  const outcome = browserActionOutcome(execution);
  if (outcome === "no-change" || outcome === "timeout" || outcome === "action-no-change" || outcome === "popup-blocked") return true;
  if (outcome !== "dispatched-unverified") return false;
  const delta = browserActionDelta(execution);
  return delta?.documentChangeObserved !== true && asRecord(delta?.url)?.changed !== true;
}

function isTerminalBrowserStrategyFailure(execution: ToolExecutionRecord): boolean {
  if (execution.tool.name !== "browser.navigate" || execution.result?.ok !== true) return false;
  return terminalBrowserStatus(execution) !== undefined;
}

function terminalBrowserStatus(execution: ToolExecutionRecord): number | undefined {
  const metadata = execution.result?.metadata;
  const snapshot = asRecord(metadata?.snapshot);
  const explicit = asRecord(snapshot?.mainDocument)?.status;
  if (typeof explicit === "number" && explicit >= 400 && explicit <= 599) return explicit;
  const title = typeof snapshot?.title === "string" ? snapshot.title.trim() : "";
  const text = typeof snapshot?.text === "string" ? snapshot.text.slice(0, 500) : "";
  const match = /^(?:error\s*)?(4\d\d|5\d\d)\b/iu.exec(title) ??
    /\b(?:error\s*)?(4\d\d|5\d\d)(?:\s+(?:error|forbidden|not\s+found|method\s+not\s+allowed|server\s+error))?\b/iu.exec(text);
  return match === null ? undefined : Number(match[1]);
}

function browserTerminalStrategySignature(execution: ToolExecutionRecord): string {
  const input = asRecord(execution.input);
  return fingerprint({
    kind: "terminal-navigation",
    destination: typeof input?.url === "string" ? normalizeDestination(input.url) : "unknown",
    disposition: input?.disposition ?? "current-tab",
    status: terminalBrowserStatus(execution)
  });
}

function normalizeDestination(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch {
    return value.trim();
  }
}

function isTargetResolutionFailure(execution: ToolExecutionRecord): boolean {
  if (!BROWSER_ACTION_TOOLS.has(execution.tool.name) || execution.result?.ok !== false) return false;
  return TARGET_FAILURE_REASONS.has(String(execution.result.metadata?.reason ?? ""));
}

function browserActionOutcome(execution: ToolExecutionRecord): string | undefined {
  const outcome = browserActionDelta(execution)?.outcome;
  return typeof outcome === "string" ? outcome : undefined;
}

function browserActionDelta(execution: ToolExecutionRecord): Record<string, unknown> | undefined {
  const snapshot = asRecord(execution.result?.metadata?.snapshot);
  return asRecord(snapshot?.actionDelta);
}

function browserEvidenceFingerprint(execution: ToolExecutionRecord): string | undefined {
  if (BROWSER_ACTION_TOOLS.has(execution.tool.name)) {
    if (execution.result?.ok === false) {
      return fingerprint({ kind: "browser-action-failure", reason: execution.result.metadata?.reason ?? "unknown" });
    }
    return undefined;
  }
  const metadata = execution.result?.metadata;
  const snapshot = metadata?.snapshot;
  if (snapshot !== undefined) {
    return fingerprint({ kind: "snapshot", evidence: stableBrowserSnapshot(snapshot) });
  }
  if (execution.tool.name === "browser.find" && metadata !== undefined) {
    return fingerprint({
      kind: "find",
      status: metadata.status,
      candidates: stableBrowserCandidates(metadata.candidates),
      nearbyCandidates: stableBrowserCandidates(metadata.nearbyCandidates),
      alternative: stableBrowserCandidates([asRecord(metadata.alternative)?.candidate]),
      tabRef: metadata.tabRef
    });
  }
  if (execution.tool.name === "browser.tabs" && metadata !== undefined) {
    return fingerprint({
      kind: "tabs",
      sessionId: metadata.sessionId,
      tabs: metadata.tabs,
      blockedCount: metadata.blockedCount
    });
  }
  return fingerprint({
    kind: execution.result?.ok === false ? "browser-observation-failure" : execution.tool.name,
    ok: execution.result?.ok,
    reason: metadata?.reason,
    content: execution.result?.content
  });
}

/** Shared semantic evidence for loop progress; never export raw page content or persist this hash. */
export function browserDiscoveryFingerprint(execution: ToolExecutionRecord): string | undefined {
  if (!BROWSER_OBSERVATION_TOOLS.has(execution.tool.name) && !BROWSER_ACTION_TOOLS.has(execution.tool.name)) return undefined;
  const metadata = execution.result?.metadata;
  if (metadata?.snapshot !== undefined) {
    return fingerprint({ kind: "snapshot", evidence: stableBrowserSnapshot(metadata.snapshot) });
  }
  if (execution.tool.name === "browser.find" && metadata?.status === "found") {
    return browserEvidenceFingerprint(execution);
  }
  if (execution.tool.name === "browser.extract" && asRecord(metadata?.target) !== undefined) {
    return fingerprint({
      kind: "extract", sessionId: metadata?.sessionId, tabRef: metadata?.tabRef,
      target: stableBrowserCandidates([metadata?.target]),
      text: stableBrowserText(metadata?.text), links: metadata?.links,
      actions: stableBrowserCandidates(metadata?.actions)
    });
  }
  return undefined;
}

function stableBrowserSnapshot(value: unknown): unknown {
  const snapshot = asRecord(value);
  if (snapshot === undefined) return value;
  const elements = Array.isArray(snapshot.elements)
    ? snapshot.elements.map(stableBrowserElement).sort((left, right) => stableSerialize(left).localeCompare(stableSerialize(right)))
    : undefined;
  return {
    sessionId: snapshot.sessionId,
    url: snapshot.url,
    title: snapshot.title,
    readiness: snapshot.readiness,
    sensitiveInputActive: snapshot.sensitiveInputActive,
    tab: snapshot.tab,
    text: stableBrowserText(snapshot.text),
    mainDocument: asRecord(snapshot.mainDocument)?.status,
    elements,
    regions: Array.isArray(snapshot.regions)
      ? snapshot.regions.map(stableBrowserRegion).sort((left, right) => stableSerialize(left).localeCompare(stableSerialize(right)))
      : undefined,
    pendingDialogs: snapshot.pendingDialogs,
    frameTree: Array.isArray(snapshot.frameTree)
      ? snapshot.frameTree.map((frame) => ({ url: asRecord(frame)?.url, origin: asRecord(frame)?.origin }))
      : undefined
  };
}

function stableBrowserRegion(value: unknown): unknown {
  const region = asRecord(value);
  if (region === undefined) return value;
  const { ref: _ref, actionRefs: _actionRefs, ...stable } = region;
  return { ...stable, text: stableBrowserText(stable.text) };
}

function stableBrowserElement(value: unknown): unknown {
  const element = asRecord(value);
  if (element === undefined) return value;
  const { ref: _ref, ...stable } = element;
  return { ...stable, text: stableBrowserText(stable.text) };
}

function stableBrowserText(value: unknown): unknown {
  // Only explicit clock timestamps are volatile; preserve business values and dates.
  return typeof value === "string"
    ? value.replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/gu, "[timestamp]")
    : value;
}

function stableBrowserCandidates(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.map((candidate) => {
    const record = asRecord(candidate);
    if (record === undefined) return candidate;
    const { ref: _ref, identity: _identity, ...stable } = record;
    return stable;
  }).sort((left, right) => stableSerialize(left).localeCompare(stableSerialize(right)));
}

function stableBrowserIdentity(value: unknown): unknown {
  const identity = asRecord(value);
  if (identity === undefined) return undefined;
  return { documentEpoch: identity.documentEpoch, actionRevision: identity.actionRevision };
}

function browserCallSignature(execution: ToolExecutionRecord): string {
  if (isNavigationAction(execution)) {
    const snapshot = asRecord(execution.result?.metadata?.snapshot);
    return fingerprint({ kind: "navigation", session: snapshot?.sessionId, tab: asRecord(snapshot?.tab)?.ref,
      url: snapshot?.url, evidence: stableBrowserSnapshot(snapshot) });
  }
  if (execution.tool.name === "browser.download") {
    return fingerprint({
      kind: "browser-download",
      input: stableBrowserCallInput(execution.input),
      outcome: execution.result?.metadata?.outcome,
      reason: execution.result?.metadata?.reason
    });
  }
  const snapshot = asRecord(execution.result?.metadata?.snapshot);
  const delta = asRecord(snapshot?.actionDelta);
  const popup = asRecord(delta?.popup);
  if (delta?.outcome === "popup-blocked" && typeof popup?.destination === "string") {
    return fingerprint({ kind: "popup-blocked", destination: popup.destination });
  }
  return fingerprint({
    tool: execution.tool.name,
    input: stableBrowserCallInput(execution.input),
    state: stableBrowserIdentity(execution.result?.metadata?.currentIdentity ?? snapshot?.identity),
    target: execution.targetKey ?? execution.targetSummary
  });
}

function stableBrowserCallInput(value: unknown): unknown {
  const input = asRecord(value);
  if (input === undefined) return value;
  const { sessionId: _sessionId, signal: _signal, identity, ...stable } = input;
  return { ...stable, identity: stableBrowserIdentity(identity) };
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableSerialize(value)).digest("hex");
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`)
    .join(",")}}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
