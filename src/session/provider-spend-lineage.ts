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
  const lineage = await verifiedCompressionLineage(sessionDb, request.executionSessionId, request.profileId);
  if (lineage === undefined) throw new Error("Provider spend execution Session lineage is invalid.");
  if (request.sessionBudgetScopeId !== undefined) {
    const scope = await sessionDb.getSession(request.sessionBudgetScopeId);
    if (scope === undefined || scope.profileId !== request.profileId) {
      throw new Error("Provider spend Session budget scope is invalid.");
    }
  }
  if (request.visibleTurnId === undefined) return;
  for (const session of lineage) {
    const messages = await sessionDb.listMessages(session.id);
    if (messages.some((message) => message.id === request.visibleTurnId && message.role === "user")) return;
  }
  throw new Error("Provider spend visible turn does not belong to the execution Session compression lineage.");
}
