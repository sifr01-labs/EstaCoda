import type { ProviderSpendRequest } from "../contracts/provider-spend.js";
import type { SessionDB } from "../contracts/session.js";
import { assertProviderSpendRequest } from "../contracts/provider-spend.js";
import { verifiedCompressionLineage } from "./session-lineage.js";

/** Verifies dynamic Session and visible-turn ownership after static envelope validation. */
export async function assertProviderSpendLineage(
  sessionDb: Pick<SessionDB, "getSession" | "listMessages">,
  request: ProviderSpendRequest
): Promise<void> {
  assertProviderSpendRequest(request);
  if (request.executionSessionId === undefined) return;
  const executionSession = await sessionDb.getSession(request.executionSessionId);
  if (executionSession === undefined || executionSession.profileId !== request.profileId) {
    throw new Error("Provider spend execution Session lineage is invalid.");
  }
  const lineage = await verifiedCompressionLineage(sessionDb, executionSession.id, request.profileId);
  if (lineage === undefined) throw new Error("Provider spend execution Session lineage is invalid.");
  if (request.sessionBudgetScopeId !== undefined) {
    const scope = await sessionDb.getSession(request.sessionBudgetScopeId);
    if (scope === undefined || scope.profileId !== request.profileId ||
        scope.spendingScopeSessionId !== scope.id || scope.spendingLimit === undefined ||
        executionSession.spendingScopeSessionId !== scope.id) {
      throw new Error("Provider spend Session budget scope is invalid.");
    }
  }
  if (request.visibleTurnId === undefined) return;
  const visibleLineageRoot = request.sourceKind === "task" && executionSession.parentSessionId !== undefined
    ? executionSession.parentSessionId
    : executionSession.id;
  const visibleLineage = await verifiedCompressionLineage(sessionDb, visibleLineageRoot, request.profileId);
  if (visibleLineage === undefined) throw new Error("Provider spend visible-turn Session lineage is invalid.");
  if (request.sessionBudgetScopeId !== undefined && visibleLineage.some(
    (session) => session.spendingScopeSessionId !== request.sessionBudgetScopeId
  )) {
    throw new Error("Provider spend visible-turn Session budget scope is invalid.");
  }
  for (const session of visibleLineage) {
    const messages = await sessionDb.listMessages(session.id);
    if (messages.some((message) => message.id === request.visibleTurnId && message.role === "user")) return;
  }
  throw new Error("Provider spend visible turn does not belong to the execution Session compression lineage.");
}
