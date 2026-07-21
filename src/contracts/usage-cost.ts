export type UsageCostSummary = {
  providerCalls: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  /** Undefined means no usable price component is known. */
  estimatedCostUsd?: number;
  usageComplete: boolean;
  costComplete: boolean;
  incompleteReasons: readonly string[];
};

export type SpendingBudgetSummary = {
  /** Settled estimated provider cost charged to this immutable scope. */
  spentCostUsd: number;
  /** Conservative capacity held by provider calls that may still settle. */
  reservedCostUsd: number;
  /** Capacity available for a new provider reservation. */
  remainingCostUsd: number;
  maxEstimatedCostUsd: number;
  warningThresholdPercent: number;
  state: "available" | "warning" | "exhausted";
};

export type TurnUsageSummary = {
  /** Persisted user-message ID for the runtime handle that produced this summary. */
  turnId: string;
  mainAgent: UsageCostSummary;
  auxiliaryModels: UsageCostSummary;
  delegatedWork: UsageCostSummary;
  total: UsageCostSummary;
  /** True while durable delegated work can still add usage to this visible turn. */
  provisional: boolean;
};

export type SessionCostSummary = UsageCostSummary & {
  budget?: SpendingBudgetSummary;
};
