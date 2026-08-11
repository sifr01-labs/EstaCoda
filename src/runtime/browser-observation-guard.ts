import { createHash } from "node:crypto";
import type { ToolExecutionRecord } from "../tools/tool-executor.js";

const BROWSER_OBSERVATION_TOOLS = new Set([
  "browser.snapshot",
  "browser.tabs"
]);

export type BrowserObservationAssessment = {
  tool: string;
  count: number;
  shouldNudge: boolean;
  shouldStop: boolean;
} | undefined;

/**
 * Tracks identical successful browser observations within one provider turn.
 * Fingerprints are held only in memory and are never exposed to event or session payloads.
 */
export class BrowserObservationGuard {
  readonly #limit: number;
  #lastFingerprint: string | undefined;
  #repeatedCount = 0;

  constructor(limit: number) {
    this.#limit = Math.max(2, Math.floor(limit));
  }

  observe(executions: ToolExecutionRecord[]): BrowserObservationAssessment {
    const observations = executions.filter((execution) =>
      execution.result?.ok === true && BROWSER_OBSERVATION_TOOLS.has(execution.tool.name)
    );
    const containsOtherOutcome = executions.some((execution) =>
      execution.result?.ok !== true || !BROWSER_OBSERVATION_TOOLS.has(execution.tool.name)
    );

    if (observations.length === 0 || containsOtherOutcome) {
      this.#reset();
      return undefined;
    }

    const fingerprint = fingerprintObservations(observations);
    if (fingerprint === this.#lastFingerprint) {
      this.#repeatedCount += 1;
    } else {
      this.#lastFingerprint = fingerprint;
      this.#repeatedCount = 1;
    }

    const tools = [...new Set(observations.map((execution) => execution.tool.name))].sort();
    return {
      tool: tools.join(", "),
      count: this.#repeatedCount,
      shouldNudge: this.#repeatedCount === this.#limit - 1,
      shouldStop: this.#repeatedCount >= this.#limit
    };
  }

  #reset(): void {
    this.#lastFingerprint = undefined;
    this.#repeatedCount = 0;
  }
}

function fingerprintObservations(executions: ToolExecutionRecord[]): string {
  const hash = createHash("sha256");
  const observations = executions
    .map((execution) => `${execution.tool.name}\0${stableSerialize(observationState(execution))}`)
    .sort();
  for (const observation of observations) {
    hash.update(observation);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function observationState(execution: ToolExecutionRecord): unknown {
  const metadata = execution.result?.metadata;
  if (execution.tool.name === "browser.snapshot" && metadata?.snapshot !== undefined) {
    return metadata.snapshot;
  }
  if (execution.tool.name === "browser.tabs" && metadata !== undefined) {
    return {
      sessionId: metadata.sessionId,
      tabs: metadata.tabs,
      blockedCount: metadata.blockedCount
    };
  }
  return execution.result?.content ?? "";
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }

  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`)
    .join(",")}}`;
}
