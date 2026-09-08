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

  hydrate(plan: ExecutionPlan): ExecutionPlan {
    return this.replace(plan);
  }

  clear(): void {
    this.#plan = undefined;
  }
}

export function cloneExecutionPlan(plan: ExecutionPlan): ExecutionPlan {
  return {
    ...plan,
    ...(plan.provenance === undefined ? {} : { provenance: { ...plan.provenance } }),
    ...(plan.requirements === undefined ? {} : {
      requirements: plan.requirements.map((requirement) => ({ ...requirement }))
    }),
    ...(plan.capabilityPreflight === undefined ? {} : {
      capabilityPreflight: {
        status: plan.capabilityPreflight.status,
        assessments: plan.capabilityPreflight.assessments.map((assessment) => ({
          ...assessment,
          ...(assessment.resolution === undefined ? {} : {
            resolution: {
              ...assessment.resolution,
              ...(assessment.resolution.protectedInput === undefined ? {} : {
                protectedInput: {
                  ...assessment.resolution.protectedInput,
                  paths: [...assessment.resolution.protectedInput.paths]
                }
              }),
              ...(assessment.resolution.verification === undefined ? {} : {
                verification: {
                  mutationTools: [...assessment.resolution.verification.mutationTools]
                }
              })
            }
          })
        }))
      }
    }),
    ...(plan.runtimeSynchronization === undefined ? {} : {
      runtimeSynchronization: {
        ...plan.runtimeSynchronization,
        ...(plan.runtimeSynchronization.evidenceCallIds === undefined ? {} : {
          evidenceCallIds: [...plan.runtimeSynchronization.evidenceCallIds]
        })
      }
    }),
    items: plan.items.map((item) => ({
      ...item,
      ...(item.evidenceCallIds === undefined ? {} : { evidenceCallIds: [...item.evidenceCallIds] }),
      ...(item.evidence === undefined ? {} : {
        evidence: item.evidence.map((entry) => ({ ...entry }))
      }),
      ...(item.completionKind === undefined ? {} : { completionKind: item.completionKind }),
      ...(item.blocker === undefined ? {} : { blocker: { ...item.blocker } }),
      ...(item.runtimeProgress === undefined ? {} : {
        runtimeProgress: {
          status: item.runtimeProgress.status,
          evidence: item.runtimeProgress.evidence.map((entry) => ({ ...entry }))
        }
      })
    }))
  };
}
