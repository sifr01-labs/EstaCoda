import type { ProviderUsageEntry } from "../contracts/provider-usage.js";
import type { SessionContextWindowUsage, SessionDB, SessionMessage } from "../contracts/session.js";
import type { TaskStatus } from "../contracts/task.js";
import type {
  SessionCostSummary,
  SpendingBudgetSummary,
  TurnUsageSummary,
  UsageCostSummary
} from "../contracts/usage-cost.js";
import type { ProviderSpendingScope } from "../contracts/provider-spend.js";
import {
  unavailableUsageCostSummary,
  usageCostSummaryFromEntries,
  usageCostSummaryFromTotals
} from "../providers/provider-usage-projection.js";
import type { TaskOperatorService, TaskStatusProjection } from "../tasks/task-operator-service.js";
import { taskListCursor, type TaskStore } from "../tasks/task-store.js";
import { loadSessionContextWindowUsage } from "./session-context-window-usage.js";
import { loadSessionCostUsage } from "./session-cost-usage.js";
import { verifiedCompressionLineage } from "./session-lineage.js";

const MAX_TURN_TASKS = 1_000;
const MAX_TURN_TASK_PAGES = 100;
const TERMINAL_TASK_STATUSES = new Set<TaskStatus>(["completed", "partial", "failed", "cancelled"]);

export type SessionUsageInspection = {
  scope: "session";
  sessionId: string;
  usage: SessionCostSummary;
  contextWindow?: SessionContextWindowUsage;
  asOf: "latest-settled-provider-call";
};

export type TurnUsageInspection = {
  scope: "turn";
  selection: "latest" | "replied" | "specific";
  sessionId: string;
  usage: TurnUsageSummary;
  originatingTasks: {
    active: number;
    settled: number;
    scanTruncated: boolean;
  };
  asOf: "latest-settled-provider-call";
};

export type TaskUsageInspection = {
  scope: "task";
  sessionId: string;
  taskId: string;
  status: TaskStatus;
  usage: UsageCostSummary;
  budget?: SpendingBudgetSummary;
  provisional: boolean;
  asOf: "latest-settled-provider-call";
};

export type UsageInspection = SessionUsageInspection | TurnUsageInspection | TaskUsageInspection;

export type UsageInspector = {
  inspectSession(sessionId: string): Promise<SessionUsageInspection | undefined>;
  inspectLatestTurn(sessionId: string, options?: { excludeTurnId?: string }): Promise<TurnUsageInspection | undefined>;
  inspectRepliedTurn(sessionId: string, currentTurnId: string): Promise<TurnUsageInspection | undefined>;
  inspectLinkedTurn(sessionId: string, linkedSessionId: string, turnId: string): Promise<TurnUsageInspection | undefined>;
  inspectTurn(sessionId: string, turnId: string): Promise<TurnUsageInspection | undefined>;
  inspectTask(sessionId: string, taskId: string): Promise<TaskUsageInspection | undefined>;
};

/** Read-only projection over the canonical provider-usage ledger and authorized Task status. */
export function createUsageInspector(input: {
  sessionDb: SessionDB;
  taskStore?: TaskStore;
  taskOperatorService?: TaskOperatorService;
  profileId: string;
  spendingScope?: (ownerId: string) => ProviderSpendingScope | null;
}): UsageInspector {
  const inspector: UsageInspector = {
    async inspectSession(sessionId) {
      const usage = await loadSessionCostUsage({
        sessionDb: input.sessionDb,
        taskStore: input.taskStore,
        profileId: input.profileId,
        sessionId,
        ...(input.spendingScope === undefined ? {} : { spendingScope: input.spendingScope })
      });
      if (usage === undefined) return undefined;
      const contextWindow = await loadSessionContextWindowUsage({
        sessionDb: input.sessionDb,
        profileId: input.profileId,
        sessionId
      });
      return {
        scope: "session",
        sessionId,
        usage,
        ...(contextWindow === undefined ? {} : { contextWindow }),
        asOf: "latest-settled-provider-call"
      };
    },

    async inspectLatestTurn(sessionId, options = {}) {
      const turnId = await latestCompletedTurnId(
        input.sessionDb,
        input.profileId,
        sessionId,
        options.excludeTurnId
      );
      const inspection = turnId === undefined ? undefined : await inspector.inspectTurn(sessionId, turnId);
      return inspection === undefined ? undefined : { ...inspection, selection: "latest" };
    },

    async inspectRepliedTurn(sessionId, currentTurnId) {
      const lineage = await verifiedCompressionLineage(input.sessionDb, sessionId, input.profileId);
      if (lineage === undefined) return undefined;
      const currentTurn = await userTurnInLineage(
        input.sessionDb,
        lineage.map((item) => item.id),
        currentTurnId
      );
      const repliedTurnId = currentTurn?.metadata?.usageReplyToTurnId;
      if (typeof repliedTurnId !== "string" || repliedTurnId.length === 0 || repliedTurnId.length > 512) {
        return undefined;
      }
      const inspection = await inspector.inspectTurn(sessionId, repliedTurnId);
      return inspection === undefined ? undefined : { ...inspection, selection: "replied" };
    },

    async inspectLinkedTurn(sessionId, linkedSessionId, turnId) {
      const lineage = await verifiedCompressionLineage(input.sessionDb, sessionId, input.profileId);
      if (lineage === undefined || !lineage.some((session) => session.id === linkedSessionId)) return undefined;
      const linkedTurn = (await input.sessionDb.listMessages(linkedSessionId))
        .some((message) => message.id === turnId && message.role === "user");
      if (!linkedTurn) return undefined;
      return await inspector.inspectTurn(sessionId, turnId);
    },

    async inspectTurn(sessionId, turnId) {
      const lineage = await verifiedCompressionLineage(input.sessionDb, sessionId, input.profileId);
      if (lineage === undefined || !await lineageContainsUserTurn(input.sessionDb, lineage.map((item) => item.id), turnId)) {
        return undefined;
      }
      const entries = await input.sessionDb.listProviderUsageEntries(input.profileId, { visibleTurnId: turnId });
      const taskState = inspectTurnTaskState(input.taskStore, lineage.map((item) => item.id), turnId);
      const usage = projectTurnUsageEntries(entries, {
        emptyMainUsageIsComplete: true,
        provisional: taskState.provisional,
        taskScanTruncated: taskState.truncated,
        turnId
      });
      return {
        scope: "turn",
        selection: "specific",
        sessionId,
        usage,
        originatingTasks: {
          active: taskState.active,
          settled: taskState.settled,
          scanTruncated: taskState.truncated
        },
        asOf: "latest-settled-provider-call"
      };
    },

    async inspectTask(sessionId, taskId) {
      if (input.taskOperatorService === undefined) return undefined;
      let status: TaskStatusProjection;
      try {
        status = input.taskOperatorService.status(taskId, sessionId);
      } catch {
        return undefined;
      }
      return {
        scope: "task",
        sessionId,
        taskId: status.taskId,
        status: status.status,
        usage: usageCostSummaryFromTotals({
          ...status.usage,
          cacheReadTokens: status.usage.cacheReadTokens ?? 0,
          cacheWriteTokens: status.usage.cacheWriteTokens ?? 0
        }),
        ...(status.spending === undefined ? {} : { budget: status.spending }),
        provisional: !TERMINAL_TASK_STATUSES.has(status.status),
        asOf: "latest-settled-provider-call"
      };
    }
  };
  return inspector;
}

export function projectTurnUsageEntries(
  entries: readonly ProviderUsageEntry[],
  options: {
    turnId: string;
    emptyMainUsageIsComplete: boolean;
    provisional?: boolean;
    taskScanTruncated?: boolean;
  }
): TurnUsageSummary {
  const mainAgent = usageCostSummaryFromEntries(entries.filter((entry) =>
    entry.taskId === undefined && entry.sourceKind === "main"
  ), { emptyUsageIsComplete: options.emptyMainUsageIsComplete });
  const auxiliaryModels = usageCostSummaryFromEntries(entries.filter((entry) =>
    entry.taskId === undefined && entry.sourceKind === "auxiliary"
  ), { emptyUsageIsComplete: true });
  const rawDelegatedWork = usageCostSummaryFromEntries(entries.filter((entry) => entry.taskId !== undefined), {
    emptyUsageIsComplete: true
  });
  const rawTotal = usageCostSummaryFromEntries(entries, {
    emptyUsageIsComplete: options.emptyMainUsageIsComplete
  });
  const delegatedWork = options.taskScanTruncated === true
    ? markIncomplete(rawDelegatedWork, "turn-task-scan-truncated")
    : rawDelegatedWork;
  const total = options.taskScanTruncated === true
    ? markIncomplete(rawTotal, "turn-task-scan-truncated")
    : rawTotal;
  return {
    turnId: options.turnId,
    mainAgent,
    auxiliaryModels,
    delegatedWork,
    total,
    provisional: options.provisional === true
  };
}

export function unavailableTurnUsage(turnId: string, reason: string): TurnUsageSummary {
  const unavailable = unavailableUsageCostSummary(reason);
  return {
    turnId,
    mainAgent: unavailable,
    auxiliaryModels: unavailable,
    delegatedWork: unavailable,
    total: unavailable,
    provisional: false
  };
}

async function latestCompletedTurnId(
  sessionDb: SessionDB,
  profileId: string,
  sessionId: string,
  excludeTurnId: string | undefined
): Promise<string | undefined> {
  const lineage = await verifiedCompressionLineage(sessionDb, sessionId, profileId);
  if (lineage === undefined) return undefined;
  const messages = (await Promise.all(
    [...lineage].reverse().map((session) => sessionDb.listMessages(session.id))
  )).flat();

  for (const message of [...messages].reverse()) {
    if (message.role !== "agent" || message.metadata?.kind === "provider-tool-call-turn") continue;
    const respondingToTurnId = message.metadata?.respondingToTurnId;
    if (typeof respondingToTurnId === "string" && respondingToTurnId !== excludeTurnId) {
      if (messages.some((candidate) => candidate.id === respondingToTurnId && candidate.role === "user")) {
        return respondingToTurnId;
      }
    }
  }

  const latestVisibleAgentIndex = findLastIndex(messages, (message) =>
    message.role === "agent" && message.metadata?.kind !== "provider-tool-call-turn"
  );
  if (latestVisibleAgentIndex < 0) return undefined;
  for (let index = latestVisibleAgentIndex - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === "user" && message.id !== excludeTurnId) return message.id;
  }
  return undefined;
}

async function lineageContainsUserTurn(
  sessionDb: SessionDB,
  sessionIds: readonly string[],
  turnId: string
): Promise<boolean> {
  for (const sessionId of sessionIds) {
    const messages = await sessionDb.listMessages(sessionId);
    if (messages.some((message) => message.id === turnId && message.role === "user")) return true;
  }
  return false;
}

async function userTurnInLineage(
  sessionDb: SessionDB,
  sessionIds: readonly string[],
  turnId: string
): Promise<SessionMessage | undefined> {
  for (const sessionId of sessionIds) {
    const message = (await sessionDb.listMessages(sessionId))
      .find((candidate) => candidate.id === turnId && candidate.role === "user");
    if (message !== undefined) return message;
  }
  return undefined;
}

function inspectTurnTaskState(
  taskStore: TaskStore | undefined,
  sessionIds: readonly string[],
  turnId: string
): { provisional: boolean; truncated: boolean; active: number; settled: number } {
  if (taskStore === undefined) return { provisional: false, truncated: false, active: 0, settled: 0 };
  let cursor: ReturnType<typeof taskListCursor> | undefined;
  let provisional = false;
  let active = 0;
  let settled = 0;
  for (let pageIndex = 0; pageIndex < MAX_TURN_TASK_PAGES; pageIndex++) {
    const tasks = taskStore.listTasks({
      originSessionIds: sessionIds,
      order: "created_asc",
      cursor,
      limit: MAX_TURN_TASKS
    });
    for (const task of tasks) {
      if (task.originTurnId !== turnId) continue;
      if (TERMINAL_TASK_STATUSES.has(task.status)) {
        settled += 1;
      } else {
        active += 1;
        provisional = true;
      }
    }
    if (tasks.length < MAX_TURN_TASKS) return { provisional, truncated: false, active, settled };
    cursor = taskListCursor(tasks[tasks.length - 1]!, "created_asc");
  }
  return { provisional, truncated: true, active, settled };
}

function markIncomplete(usage: UsageCostSummary, reason: string): UsageCostSummary {
  return {
    ...usage,
    usageComplete: false,
    costComplete: false,
    incompleteReasons: [...new Set([...usage.incompleteReasons, reason])]
  };
}

function findLastIndex<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index--) {
    if (predicate(items[index]!)) return index;
  }
  return -1;
}
