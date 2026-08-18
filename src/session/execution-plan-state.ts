import {
  EXECUTION_PLAN_EVENT_KINDS,
  EXECUTION_PLAN_MAX_SERIALIZED_BYTES,
  type ExecutionPlan,
  type ExecutionPlanLifecycleEvent
} from "../contracts/execution-plan.js";
import type { SessionEvent } from "../contracts/session.js";

const EVENT_KINDS = new Set<string>(EXECUTION_PLAN_EVENT_KINDS);
const HYDRATABLE_STATUSES = new Set(["active", "blocked"]);

export function isExecutionPlanLifecycleEvent(event: SessionEvent): event is ExecutionPlanLifecycleEvent {
  return EVENT_KINDS.has(event.kind);
}

export function latestExecutionPlanSnapshot(events: readonly SessionEvent[]): ExecutionPlan | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event !== undefined && isExecutionPlanLifecycleEvent(event) && isSafeSnapshot(event.plan)) {
      return cloneExecutionPlanSnapshot(event.plan);
    }
  }
  return undefined;
}

function cloneExecutionPlanSnapshot(plan: ExecutionPlan): ExecutionPlan {
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
                verification: { mutationTools: [...assessment.resolution.verification.mutationTools] }
              })
            }
          })
        }))
      }
    }),
    items: plan.items.map((item) => ({
      ...item,
      ...(item.evidenceCallIds === undefined ? {} : { evidenceCallIds: [...item.evidenceCallIds] }),
      ...(item.evidence === undefined ? {} : { evidence: item.evidence.map((entry) => ({ ...entry })) }),
      ...(item.completionKind === undefined ? {} : { completionKind: item.completionKind }),
      ...(item.blocker === undefined ? {} : { blocker: { ...item.blocker } })
    }))
  };
}

export function hydratableExecutionPlanSnapshot(events: readonly SessionEvent[]): ExecutionPlan | undefined {
  const plan = latestExecutionPlanSnapshot(events);
  return plan !== undefined && HYDRATABLE_STATUSES.has(plan.status) ? plan : undefined;
}

export function executionPlanCarryForwardEvent(
  events: readonly SessionEvent[]
): ExecutionPlanLifecycleEvent | undefined {
  const plan = hydratableExecutionPlanSnapshot(events);
  if (plan === undefined) return undefined;
  return {
    kind: plan.status === "blocked" ? "execution-plan-blocked" : "execution-plan-updated",
    plan
  };
}

function isSafeSnapshot(plan: unknown): plan is ExecutionPlan {
  if (typeof plan !== "object" || plan === null || Array.isArray(plan)) return false;
  const candidate = plan as Partial<ExecutionPlan>;
  if (
    typeof candidate.objective !== "string" ||
    typeof candidate.originTurnId !== "string" ||
    !Number.isSafeInteger(candidate.revision) ||
    typeof candidate.status !== "string" ||
    !Array.isArray(candidate.items)
  ) return false;
  try {
    return Buffer.byteLength(JSON.stringify(candidate), "utf8") <= EXECUTION_PLAN_MAX_SERIALIZED_BYTES;
  } catch {
    return false;
  }
}
