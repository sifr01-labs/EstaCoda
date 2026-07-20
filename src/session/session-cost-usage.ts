import type { ProviderUsageEntry } from "../contracts/provider-usage.js";
import type { SessionCostSummary } from "../contracts/usage-cost.js";
import type { SessionDB } from "../contracts/session.js";
import { usageCostSummaryFromEntries } from "../providers/provider-usage-projection.js";
import type { TaskStore } from "../workflow/task-store.js";
import { verifiedCompressionLineage } from "./session-lineage.js";

const MAX_SESSION_TASKS = 1_000;

/** Projects conversation and originating Task spend from the one canonical request ledger. */
export async function loadSessionCostUsage(input: {
  sessionDb: SessionDB;
  taskStore?: TaskStore;
  profileId: string;
  sessionId: string;
}): Promise<SessionCostSummary | undefined> {
  const lineage = await verifiedCompressionLineage(input.sessionDb, input.sessionId, input.profileId);
  if (lineage === undefined) return undefined;
  const lineageIds = new Set(lineage.map((session) => session.id));
  const entries: ProviderUsageEntry[] = [];
  let taskScanTruncated = false;

  for (const session of lineage) {
    const direct = await input.sessionDb.listProviderUsageEntries(input.profileId, { sessionId: session.id });
    entries.push(...direct.filter((entry) => entry.taskId === undefined));
  }

  if (input.taskStore !== undefined) {
    const listedTasks = input.taskStore.listTasks({ limit: MAX_SESSION_TASKS });
    const roots = listedTasks.filter((task) =>
      task.rootTaskId === task.id && lineageIds.has(task.originSessionId)
    );
    for (const task of roots) {
      entries.push(...input.taskStore.listProviderUsageEntries({ rootTaskId: task.id }));
    }
    taskScanTruncated = listedTasks.length >= MAX_SESSION_TASKS;
  }

  if (taskScanTruncated) {
    const lowerBound = usageCostSummaryFromEntries(deduplicate(entries), { emptyUsageIsComplete: true });
    const { estimatedCostUsd, ...knownUsage } = lowerBound;
    return {
      ...knownUsage,
      ...(estimatedCostUsd !== undefined && estimatedCostUsd > 0 ? { estimatedCostUsd } : {}),
      usageComplete: false,
      costComplete: false,
      incompleteReasons: [...lowerBound.incompleteReasons, "session-task-scan-truncated"]
    };
  }

  return usageCostSummaryFromEntries(deduplicate(entries), { emptyUsageIsComplete: true });
}

function deduplicate(entries: readonly ProviderUsageEntry[]): ProviderUsageEntry[] {
  const unique = new Map<string, ProviderUsageEntry>();
  for (const entry of entries) unique.set(`${entry.profileId}\0${entry.requestKey}`, entry);
  return [...unique.values()];
}
