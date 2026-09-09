import { randomBytes } from "node:crypto";
import { exactActionKey } from "./pending-action-approval.js";

// Argument fingerprints remain in process memory. Only a random opaque token
// crosses into approval receipts, so credential-bearing arguments cannot leak
// secret-derived hashes into durable queues or logs.
const actions = new Map<string, { token: string; expiresAt: number }>();
export function executionActionIdentity(profileId: string | undefined, sessionId: string, tool: string, risk: string, input: unknown): string {
  const key = exactActionKey([profileId, sessionId, tool, risk, input]);
  const now = Date.now();
  for (const [id, action] of actions) if (action.expiresAt <= now) actions.delete(id);
  const existing = actions.get(key);
  if (existing !== undefined) return existing.token;
  if (actions.size >= 1000) actions.delete(actions.keys().next().value!);
  const token = randomBytes(32).toString("hex");
  actions.set(key, { token, expiresAt: now + 10 * 60_000 });
  return token;
}
