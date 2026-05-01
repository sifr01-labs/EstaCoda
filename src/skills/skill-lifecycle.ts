import type { SkillLifecycleState } from "../contracts/skill.js";

export type SkillLifecycleDecision =
  | { ok: true }
  | {
      ok: false;
      reason: string;
    };

export function isSkillLifecycleActive(state: SkillLifecycleState | undefined): boolean {
  return state === undefined || state === "active" || state === "stale";
}

export function canTransitionSkillLifecycle(input: {
  current: SkillLifecycleState | undefined;
  next: SkillLifecycleState;
  pinned?: boolean;
}): SkillLifecycleDecision {
  if (input.pinned === true && input.current !== input.next) {
    return {
      ok: false,
      reason: "Pinned skills cannot change lifecycle state until they are unpinned."
    };
  }

  return { ok: true };
}

export function lifecycleStateForUsage(input: {
  useCount: number;
  successCount: number;
  failureCount: number;
  archivedAt?: string;
}): SkillLifecycleState {
  if (input.archivedAt !== undefined) {
    return "archived";
  }

  if (input.useCount === 0) {
    return "inactive";
  }

  if (input.failureCount >= 3 && input.failureCount > input.successCount) {
    return "stale";
  }

  return "active";
}
