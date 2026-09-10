import type { ExecutionMetricSnapshot, TrajectoryEventKind } from "../contracts/trajectory.js";

const LIMIT = 1_000_000_000;
const number = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(LIMIT, Math.floor(v))) : 0;
const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" ? v as Record<string, unknown> : {};
/** Fixed-size cumulative observations. These counters confer no recovery authority. */
export class ExecutionMetrics {
  readonly #started = performance.now();
  readonly #values = { providerCompletions: 0, providerDispatches: 0, reportedTokens: 0, usageReports: 0, approvalRequests: 0,
    deniedTools: 0, toolResults: 0, failedTools: 0, cancellations: 0, checkpointUpdates: 0, completedTurns: 0, failedTurns: 0 };
  observe(kind: TrajectoryEventKind, data: Record<string, unknown>): void {
    const add = (key: Exclude<keyof ExecutionMetricSnapshot, "version" | "elapsedMs">, value = 1) => { this.#values[key] = Math.min(LIMIT, this.#values[key] + number(value)); };
    if (kind === "provider-completion") {
      add("providerCompletions");
      for (const raw of Array.isArray(data.attempts) ? data.attempts.slice(0, 256) : []) {
        const attempt = object(raw);
        if (attempt.state !== "dispatched") continue;
        add("providerDispatches");
        const usage = object(attempt.usage);
        if (typeof usage.totalTokens === "number" && Number.isFinite(usage.totalTokens) && usage.totalTokens >= 0) {
          add("usageReports"); add("reportedTokens", usage.totalTokens);
        }
      }
    }
    if (kind === "tool-gated" && data.decision === "ask") add("approvalRequests");
    if (kind === "tool-gated" && data.decision === "deny") add("deniedTools");
    if (kind === "tool-result") { add("toolResults"); if (object(data.result).ok === false) add("failedTools"); }
    if (kind === "agent-cancelled") add("cancellations");
    if (kind === "execution-checkpoint-updated") add("checkpointUpdates");
    if (kind === "session-end") add(object(data.outcome).success === true ? "completedTurns" : "failedTurns");
  }
  snapshot(): ExecutionMetricSnapshot { return { version: 1, elapsedMs: number(performance.now() - this.#started), ...this.#values }; }
}
