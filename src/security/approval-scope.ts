import { createHash } from "node:crypto";
import type { ChannelSessionKey } from "../contracts/channel.js";
import type { HostExecutionFacts } from "../contracts/execution-authority.js";
import { hostAuthorityFingerprint } from "../execution/host-authority.js";

export type ApprovalExecutionScope = {
  schemaVersion: 1;
  profileId: string;
  sessionId: string;
  workspaceIdentityHash: string;
  authorityFingerprint: string;
  environmentInstanceId: string;
  surfaceKey: string;
};

export function localApprovalScope(profileId: string, sessionId: string, facts: Readonly<HostExecutionFacts>): ApprovalExecutionScope {
  return { schemaVersion: 1, profileId, sessionId, workspaceIdentityHash: facts.workspace.identityHash,
    authorityFingerprint: hostAuthorityFingerprint(facts), environmentInstanceId: facts.environmentInstanceId, surfaceKey: "local" };
}
export function channelApprovalScope(scope: ApprovalExecutionScope, key: ChannelSessionKey): ApprovalExecutionScope {
  return { ...scope, surfaceKey: `channel:${createHash("sha256").update(JSON.stringify([
    key.platform, key.accountId ?? null, key.chatId ?? null, key.chatType ?? null, key.threadId ?? null, key.userId ?? null,
  ])).digest("hex")}` };
}
export function validApprovalScope(value: unknown): value is ApprovalExecutionScope {
  const v = value as ApprovalExecutionScope | undefined;
  return !!v && v.schemaVersion === 1 && typeof v.profileId === "string" && v.profileId.length > 0 &&
    typeof v.sessionId === "string" && v.sessionId.length > 0 && /^[a-f0-9]{64}$/u.test(v.workspaceIdentityHash) &&
    /^[a-f0-9]{64}$/u.test(v.authorityFingerprint) && typeof v.environmentInstanceId === "string" && v.environmentInstanceId.length > 0 &&
    typeof v.surfaceKey === "string" && (v.surfaceKey === "local" || /^channel:[a-f0-9]{64}$/u.test(v.surfaceKey));
}
/** Equal host authority is the only supported reusable comparison. Missing or
 * unknown legacy scope is never a wildcard. No child-scope inheritance is implied. */
export function sameReusableAuthority(grant: unknown, current: unknown): boolean {
  return validApprovalScope(grant) && validApprovalScope(current) && grant.profileId === current.profileId &&
    grant.workspaceIdentityHash === current.workspaceIdentityHash && grant.authorityFingerprint === current.authorityFingerprint && grant.surfaceKey === current.surfaceKey;
}
export function samePendingAuthority(grant: unknown, current: unknown): boolean {
  return sameReusableAuthority(grant, current) && validApprovalScope(grant) && validApprovalScope(current) &&
    grant.sessionId === current.sessionId && grant.environmentInstanceId === current.environmentInstanceId;
}
