import type { ProviderRouteRole } from "./provider.js";

export type ProviderUsageEntryId = string;

export type ProviderUsageTotals = {
  providerCalls: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  usageComplete: boolean;
  pricingComplete: boolean;
  incompleteReasons: readonly string[];
};

/** One canonical row for one request that reached a provider adapter. */
export type ProviderUsageEntry = {
  id: ProviderUsageEntryId;
  profileId: string;
  sessionId: string;
  /** The persisted user-message ID whose visible response caused this request. */
  visibleTurnId: string;
  /** Stable request identity. Replays and settlement retries must not double count it. */
  requestKey: string;
  provider: string;
  model: string;
  routeRole: ProviderRouteRole;
  routeIndex: number;
  providerAttemptIndex: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  /** Sum of the price components that are known; inspect pricingComplete before display. */
  estimatedCostUsd: number;
  usageComplete: boolean;
  pricingComplete: boolean;
  incompleteReasons: readonly string[];
  taskId?: string;
  rootTaskId?: string;
  planRevisionId?: string;
  stepId?: string;
  attemptId?: string;
  dispatchedAt: string;
};

export type ProviderUsageQuery = {
  sessionId?: string;
  visibleTurnId?: string;
  taskId?: string;
  rootTaskId?: string;
  attemptId?: string;
};
