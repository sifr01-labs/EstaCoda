import { randomBytes } from "node:crypto";
import { exactActionKey } from "./exact-action-key.js";

// Argument fingerprints remain in process memory. Only a random opaque token
// crosses into approval receipts, so credential-bearing arguments cannot leak
// secret-derived hashes into durable queues or logs.
const actions = new Map<string, { token: string; expiresAt: number; retentions: Map<string, number> }>();
export function executionActionIdentity(profileId: string | undefined, sessionId: string, tool: string, risk: string, input: unknown): string {
  const key = exactActionKey([profileId, sessionId, tool, risk, input]);
  const now = Date.now();
  for (const [id, action] of actions) {
    if (action.expiresAt <= now) actions.delete(id);
    else for (const [owner, expiry] of action.retentions) if (expiry <= now) action.retentions.delete(owner);
  }
  const existing = actions.get(key);
  if (existing !== undefined) return existing.token;
  if (actions.size >= 1000) {
    const evictable = [...actions].find(([, action]) => action.retentions.size === 0);
    if (evictable === undefined) throw new Error("Too many pending actions. Wait for existing action retention to expire before requesting another action.");
    actions.delete(evictable[0]);
  }
  const token = randomBytes(32).toString("hex");
  actions.set(key, { token, expiresAt: now + 10 * 60_000, retentions: new Map() });
  return token;
}

/** Keep an issued token through the exact approval's lifetime. Retention does not
 * grant authority: pending expiry, consumption and dispatch checks still apply.
 * Unknown tokens (including identities lost on restart) are never recreated. */
export function retainExecutionActionIdentity(token: string | undefined, expiresAt: number, owner = token): void {
  if (owner === undefined) return;
  if (!Number.isFinite(expiresAt)) throw new Error("Invalid action retention expiry.");
  for (const action of actions.values()) {
    if (action.token !== token) continue;
    action.expiresAt = Math.max(action.expiresAt, expiresAt);
    action.retentions.set(owner, Math.max(action.retentions.get(owner) ?? 0, expiresAt));
    return;
  }
}

/** Consuming or denying a durable Task releases only that link's retention.
 * Another pending approval for the same action must keep its own identity. */
export function releaseExecutionActionRetention(owner: string): void {
  for (const action of actions.values()) action.retentions.delete(owner);
}
