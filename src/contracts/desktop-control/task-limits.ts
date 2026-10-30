/** Transport bounds only. Task admission additionally enforces the selected profile ceiling. */
export const TASK_CREATION_LIMITS = {
  maxProviderCalls: 1_000_000,
  maxTotalTokens: 1_000_000,
  maxWallClockMs: 10_080 * 60_000
} as const;
