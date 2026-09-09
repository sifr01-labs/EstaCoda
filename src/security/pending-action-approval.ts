import { exactActionKey } from "./exact-action-key.js";
export { exactActionKey } from "./exact-action-key.js";
import { retainExecutionActionIdentity } from "./execution-action-identity.js";
import { randomUUID } from "node:crypto";
import type { SecurityRequest } from "../contracts/security.js";
import { samePendingAuthority, validApprovalScope, type ApprovalExecutionScope } from "./approval-scope.js";

export type PendingActionApproval = {
  schemaVersion: 1; id: string; executionScope: ApprovalExecutionScope;
  actionKey: string; authorizationRevision: number; expiresAt: number;
};
export function securityActionKey(request: Pick<SecurityRequest, "actionKey" | "toolName" | "riskClass" | "targetKey" | "command">): string {
  return request.actionKey ?? exactActionKey([request.toolName, request.riskClass, request.targetKey, request.command]);
}
export function createPendingAction(request: SecurityRequest, authorizationRevision: number, now = Date.now()): PendingActionApproval | undefined {
  if (!validApprovalScope(request.executionScope)) return undefined;
  const actionKey = securityActionKey(request);
  const expiresAt = now + 10 * 60_000;
  const id = randomUUID();
  retainExecutionActionIdentity(actionKey, expiresAt, id);
  return { schemaVersion: 1, id, executionScope: structuredClone(request.executionScope), actionKey,
    authorizationRevision, expiresAt };
}
export function validPendingAction(value: unknown): value is PendingActionApproval {
  const p = value as PendingActionApproval | undefined;
  return !!p && p.schemaVersion === 1 && typeof p.id === "string" && p.id.length > 0 && validApprovalScope(p.executionScope) &&
    typeof p.actionKey === "string" && /^[a-f0-9]{64}$/u.test(p.actionKey) && Number.isSafeInteger(p.authorizationRevision) && p.authorizationRevision >= 0 && Number.isFinite(p.expiresAt);
}
export function assertPendingAction(pending: unknown, scope: ApprovalExecutionScope, revision: number, actionKey?: string, now = Date.now()): asserts pending is PendingActionApproval {
  if (!validPendingAction(pending) || !samePendingAuthority(pending.executionScope, scope) || pending.authorizationRevision !== revision ||
    pending.expiresAt <= now || (actionKey !== undefined && pending.actionKey !== actionKey)) {
    throw new Error("Approval is stale or its execution scope changed. Review the current action to renew approval.");
  }
}
