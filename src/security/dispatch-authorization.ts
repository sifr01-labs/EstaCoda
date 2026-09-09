import type { SecurityAssessment } from "../contracts/security.js";

// Receipts are process-local capabilities. They never enter assessment logs,
// serialized queue rows, cloned Tool records, or model-visible tool arguments.
const fences = new WeakMap<SecurityAssessment, () => void | Promise<void>>();
export function withDispatchAuthorization(assessment: SecurityAssessment, fence: () => void | Promise<void>): SecurityAssessment {
  const result = { ...assessment };
  fences.set(result, fence);
  return result;
}
export async function validateDispatchAuthorization(assessment: SecurityAssessment): Promise<void> {
  await fences.get(assessment)?.();
}
