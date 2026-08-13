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
]);

export type BrowserObservationAssessment = {
  tool: string;
  count: number;
  shouldNudge: boolean;
  shouldStop: boolean;
} | undefined;

/**
 * Tracks browser observation work that does not change semantic page/tab state.
 * Alternating read tools and blocked observations cannot reset the guard.
 * Fingerprints are held only in memory and never exposed in events or results.
 */
export class BrowserObservationGuard {
  readonly #limit: number;
  #lastStateFingerprint: string | undefined;
  #noProgressCount = 0;

  constructor(limit: number) {
    this.#limit = Math.max(2, Math.floor(limit));
  }

  observe(executions: ToolExecutionRecord[]): BrowserObservationAssessment {
    if (executions.some((execution) =>
      execution.result?.ok === true && BROWSER_ACTION_TOOLS.has(execution.tool.name)
    )) {
      this.#reset();
      return undefined;
    }

    const observations = executions.filter((execution) => BROWSER_OBSERVATION_TOOLS.has(execution.tool.name));
    const containsOtherWork = executions.some((execution) =>
      !BROWSER_OBSERVATION_TOOLS.has(execution.tool.name) && !BROWSER_ACTION_TOOLS.has(execution.tool.name)
    );
    if (observations.length === 0 || containsOtherWork) {
      this.#reset();
      return undefined;
    }

    const stateFingerprint = semanticBrowserStateFingerprint(observations);
    if (
      stateFingerprint !== undefined &&
      this.#lastStateFingerprint !== undefined &&
      stateFingerprint !== this.#lastStateFingerprint
    ) {
      this.#noProgressCount = 1;
    } else {
      this.#noProgressCount += 1;
    }
    if (stateFingerprint !== undefined) this.#lastStateFingerprint = stateFingerprint;

    const tools = [...new Set(observations.map((execution) => execution.tool.name))].sort();
    return {
      tool: tools.join(", "),
      count: this.#noProgressCount,
      shouldNudge: this.#noProgressCount === this.#limit - 1,
      shouldStop: this.#noProgressCount >= this.#limit,
    };
  }

  #reset(): void {
    this.#lastStateFingerprint = undefined;
    this.#noProgressCount = 0;
  }
}

function semanticBrowserStateFingerprint(executions: ToolExecutionRecord[]): string | undefined {
  const states = executions.flatMap((execution) => {
    const metadata = execution.result?.metadata;
    if (metadata?.snapshot !== undefined) return [stableBrowserSnapshot(metadata.snapshot)];
    if (execution.tool.name === "browser.tabs" && metadata !== undefined) {
      return [{
        sessionId: metadata.sessionId,
        tabs: metadata.tabs,
        blockedCount: metadata.blockedCount,
      }];
    }
    return [];
  });
  if (states.length === 0) return undefined;
  const hash = createHash("sha256");
  for (const state of states.map(stableSerialize).sort()) {
    hash.update(state);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function stableBrowserSnapshot(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const {
    observedAt: _observedAt,
    revision: _revision,
    actionDelta: _actionDelta,
    ...stable
  } = value as Record<string, unknown>;
  return stable;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`)
    .join(",")}}`;
}
