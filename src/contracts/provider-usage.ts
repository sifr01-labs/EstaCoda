import type { ProviderRouteRole } from "./provider.js";
import type { ProviderPricingSnapshot } from "./provider-spend.js";

export type ProviderUsageEntryId = string;

/** Caller-owned attribution supplied before a logical provider execution begins. */
export type ProviderUsageContext = {
  requestKey: string;
  sourceKind: "main" | "task" | "auxiliary";
  auxiliaryKind?: string;
  executionSessionId?: string;
  sessionBudgetScopeId?: string;
  visibleTurnId?: string;
  taskId?: string;
  rootTaskId?: string;
  planRevisionId?: string;
  stepId?: string;
  attemptId?: string;
  /** Overrides isolated auxiliary fallback execution back to its logical chain identity. */
  routeRole?: ProviderRouteRole;
  routeIndex?: number;
};

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
  /** Session whose runtime executed the provider request. */
  sessionId?: string;
  /** Logical originating Session whose spending scope receives this fact. */
  sessionBudgetScopeId?: string;
  /** The persisted user-message ID whose visible response caused this request. */
  visibleTurnId?: string;
  /** Stable request identity. Replays and settlement retries must not double count it. */
  requestKey: string;
  provider: string;
  model: string;
  routeRole: ProviderRouteRole;
  routeIndex: number;
  providerAttemptIndex: number;
  sourceKind: "main" | "task" | "auxiliary";
  auxiliaryKind?: string;
  pricing: ProviderPricingSnapshot;
  pricingFingerprint: string;
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
  sessionBudgetScopeId?: string;
  visibleTurnId?: string;
  taskId?: string;
  rootTaskId?: string;
  attemptId?: string;
};
