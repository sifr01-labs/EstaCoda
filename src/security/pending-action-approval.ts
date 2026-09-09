import { createHash, randomUUID } from "node:crypto";
import type { SecurityRequest } from "../contracts/security.js";
import { samePendingAuthority, validApprovalScope, type ApprovalExecutionScope } from "./approval-scope.js";

export type PendingActionApproval = {
  schemaVersion: 1; id: string; executionScope: ApprovalExecutionScope;
  actionKey: string; authorizationRevision: number; expiresAt: number;
};
export function exactActionKey(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)]));
  return value;
}
export function securityActionKey(request: Pick<SecurityRequest, "actionKey" | "toolName" | "riskClass" | "targetKey" | "command">): string {
  return request.actionKey ?? exactActionKey([request.toolName, request.riskClass, request.targetKey, request.command]);
}
export function createPendingAction(request: SecurityRequest, authorizationRevision: number, now = Date.now()): PendingActionApproval | undefined {
  if (!validApprovalScope(request.executionScope)) return undefined;
  return { schemaVersion: 1, id: randomUUID(), executionScope: structuredClone(request.executionScope), actionKey: securityActionKey(request),
    authorizationRevision, expiresAt: now + 10 * 60_000 };
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
