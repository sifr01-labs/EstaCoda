import type { ExecutionMetricSnapshot, Trajectory } from "../contracts/trajectory.js";
const keys: Array<Exclude<keyof ExecutionMetricSnapshot, "version">> = ["elapsedMs", "providerCompletions", "providerDispatches", "reportedTokens", "usageReports", "approvalRequests", "deniedTools", "toolResults", "failedTools", "cancellations", "checkpointUpdates", "completedTurns", "failedTurns"];
/** Whitelist persisted diagnostic fields; never promote event content to authority. */
export function executionObservations(value: unknown): Pick<Trajectory, "executionMetrics" | "executionReferences"> {
  if (!value || typeof value !== "object") return {};
  const data = value as Record<string, unknown>, result: Pick<Trajectory, "executionMetrics" | "executionReferences"> = {};
  const metrics = data.executionMetrics as ExecutionMetricSnapshot | undefined;
  if (metrics?.version === 1 && keys.every((key) => Number.isSafeInteger(metrics[key]) && metrics[key] >= 0 && metrics[key] <= 1e9)) {
    result.executionMetrics = Object.fromEntries([["version", 1], ...keys.map((key) => [key, metrics[key]])]) as ExecutionMetricSnapshot;
  }
  const refs = data.executionReferences as Trajectory["executionReferences"];
  if (refs && typeof refs.definitionRevision === "string" && typeof refs.authorityRevision === "string" && /^[a-f0-9]{64}$/u.test(refs.definitionRevision) && /^[a-f0-9]{64}$/u.test(refs.authorityRevision)) {
    result.executionReferences = { definitionRevision: refs.definitionRevision, authorityRevision: refs.authorityRevision };
  }
  return result;
}
