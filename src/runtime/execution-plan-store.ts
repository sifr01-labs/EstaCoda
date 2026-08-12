import type { ExecutionPlan, ExecutionPlanReader } from "../contracts/execution-plan.js";

export class ExecutionPlanStore implements ExecutionPlanReader {
  #plan: ExecutionPlan | undefined;

  current(): ExecutionPlan | undefined {
    return this.#plan === undefined ? undefined : cloneExecutionPlan(this.#plan);
  }

  replace(plan: ExecutionPlan): ExecutionPlan {
    this.#plan = cloneExecutionPlan(plan);
    return cloneExecutionPlan(this.#plan);
  }
}

export function cloneExecutionPlan(plan: ExecutionPlan): ExecutionPlan {
  return {
    ...plan,
    items: plan.items.map((item) => ({
      ...item,
      ...(item.evidenceCallIds === undefined ? {} : { evidenceCallIds: [...item.evidenceCallIds] }),
      ...(item.evidence === undefined ? {} : {
        evidence: item.evidence.map((entry) => ({ ...entry }))
      }),
      ...(item.blocker === undefined ? {} : { blocker: { ...item.blocker } })
    }))
  };
}
