import type { LoadedRuntimeConfig } from "../config/runtime-config.js";
import { loadRuntimeConfig } from "../config/runtime-config.js";
import { resolveProfileStateHome } from "../config/profile-home.js";
import { join } from "node:path";
import type { SecurityRequest, SecurityPolicy } from "../contracts/security.js";
import { assessSecurityPolicy } from "../contracts/security.js";
import { createSecurityPolicyForMode } from "../security/security-policy-factory.js";
import { assessHardlineFloor } from "../security/command-safety.js";
import { ChannelApprovalStore } from "../channels/channel-approval-store.js";
import { channelApprovalScope, localApprovalScope, samePendingAuthority, validApprovalScope } from "../security/approval-scope.js";
import { withDispatchAuthorization } from "../security/dispatch-authorization.js";
import { securityActionKey } from "../security/pending-action-approval.js";
import { verifyHostExecution } from "../execution/host-authority.js";
import { ExecutionTargetStore } from "../workspaces/execution-target.js";
import { WorkspaceTrustStore } from "../security/workspace-trust-store.js";
import { normalizeWhatsAppAllowlist, normalizeWhatsAppGroupAllowlist, normalizeWhatsAppGroupId, normalizeWhatsAppUserId } from "../channels/whatsapp-identity.js";
import type { CronJob } from "./cron-store.js";
import { parseCronExecutionOrigin, type CronExecutionOrigin } from "./cron-origin.js";

/** Recheck the recorded principal against current channel policy. A job's delivery
 * recipient and legacy origin fields never grant execution authority. */
export function recurringPrincipalAllowed(origin: CronExecutionOrigin, config: LoadedRuntimeConfig): boolean {
  const channels = config.config.channels;
  const key = origin.sessionKey;
  if (key.platform === "telegram") {
    const policy = channels?.telegram;
    return policy?.enabled === true && ((policy.allowedUserIds ?? []).includes(origin.principalId) || (policy.allowedChatIds ?? []).includes(key.chatId));
  }
  if (key.platform === "discord") {
    const policy = channels?.discord;
    return policy?.enabled === true && ((policy.allowedUsers ?? []).includes(origin.principalId) || (origin.guildId !== undefined && (policy.allowedGuilds ?? []).includes(origin.guildId)));
  }
  if (key.platform === "email") {
    const policy = channels?.email;
    return policy?.enabled === true && (policy.allowedSenders ?? []).some((sender) => sender.toLowerCase() === origin.principalId.toLowerCase());
  }
  if (key.platform === "whatsapp") {
    const policy = channels?.whatsapp;
    if (policy?.enabled !== true) return false;
    if (key.chatType === "group") return policy.groupPolicy === "open" || (policy.groupPolicy === "allowlist" && normalizeWhatsAppGroupAllowlist(policy.allowedGroups).includes(normalizeWhatsAppGroupId(key.chatId)));
    return policy.dmPolicy === "open" || ((policy.dmPolicy ?? "allowlist") === "allowlist" && normalizeWhatsAppAllowlist(policy.allowedUsers).includes(normalizeWhatsAppUserId(origin.principalId)));
  }
  return false;
}

export async function validateCronAuthority(job: CronJob, context: { profileId: string; homeDir?: string }): Promise<LoadedRuntimeConfig | undefined> {
  if(job.localTarget!==undefined){
    if(!job.localTarget||job.executionOrigin||job.localTarget.profileId!==context.profileId||job.workdir!==job.localTarget.binding.workspace.canonicalPath)throw new Error('Recurring profile/target mismatch.');
    const targets=new ExecutionTargetStore(context);try{await targets.validate(job.localTarget.binding,job.workdir);}finally{targets.close();}
    if(!await new WorkspaceTrustStore(context).isTrusted(job.workdir))throw new Error('Recurring workspace trust was revoked.');
    return loadRuntimeConfig({...context,workspaceRoot:job.workdir});
  }
  if (job.executionOrigin === undefined) return undefined;
  const origin = parseCronExecutionOrigin(job.executionOrigin);
  if (!["local", "origin"].includes(job.delivery)) throw new Error("Recurring delivery exceeds its authorized origin.");
  if (origin.profileId !== context.profileId || job.workdir !== origin.target.workspace.canonicalPath) throw new Error("Recurring execution profile/workspace mismatch.");
  const targets = new ExecutionTargetStore(context);
  try { await targets.validate(origin.target, job.workdir); } finally { targets.close(); }
  if (!await new WorkspaceTrustStore(context).isTrusted(job.workdir)) throw new Error("Recurring workspace trust was revoked.");
  const config = await loadRuntimeConfig({ ...context, workspaceRoot: job.workdir });
  if (!recurringPrincipalAllowed(origin, config)) throw new Error("Recurring channel authorization was revoked. Renew through local setup.");
  return config;
}

export async function recurringCronSecurityPolicy(job: CronJob, context: { profileId: string; homeDir?: string; sessionId: string }): Promise<SecurityPolicy | undefined> {
  const initialConfig = await validateCronAuthority(job, context);
  if (!initialConfig || !job.executionOrigin) return undefined;
  const origin = parseCronExecutionOrigin(job.executionOrigin);
  const store = new ChannelApprovalStore({ path: join(resolveProfileStateHome(context).gatewayStatePath, "channel-approvals.json") });
  const scope = async (request: SecurityRequest) => {
    if (validApprovalScope(request.executionScope)) {
      if (request.executionScope.profileId !== context.profileId || request.executionScope.sessionId !== context.sessionId ||
          request.executionScope.workspaceIdentityHash !== origin.target.workspace.identityHash) throw new Error("Recurring execution scope mismatch.");
      return channelApprovalScope(request.executionScope, origin.sessionKey);
    }
    if (initialConfig.config.execution?.backend === "docker") throw new Error("Recurring Docker execution requires a verified runtime scope.");
    return channelApprovalScope(localApprovalScope(context.profileId, context.sessionId,
      await verifyHostExecution(origin.target.workspace.canonicalPath)), origin.sessionKey);
  };
  return {
    decide: (request) => createSecurityPolicyForMode(initialConfig.security.approvalMode).decide(request),
    assess: async (request) => {
      const config = (await validateCronAuthority(job, context))!;
      const base = createSecurityPolicyForMode(config.security.approvalMode);
      request.executionScope = await scope(request);
      const originalScope = structuredClone(request.executionScope);
      const action = securityActionKey(request), revision = store.revision(request);
      const assessment = await assessSecurityPolicy(base, request, config.security.approvalMode);
      if (assessment.decision === "deny" || !request.context.trustedWorkspace || (request.command && assessHardlineFloor(request.command))) return assessment;
      const grant = await store.findReusableGrant(request);
      const result = grant ? { ...assessment, decision: "allow" as const, reason: "Allowed by the originating channel's persistent workspace grant." } : assessment;
      if (result.decision !== "allow") return result;
      const validate = async () => {
        await validateCronAuthority(job, context);
        if (revision !== store.revision(request) || (grant && !store.hasGrant(grant)) || !samePendingAuthority(originalScope, await scope(request)) ||
          action !== securityActionKey(request) || !request.context.trustedWorkspace) throw new Error("Recurring execution approval was revoked.");
      };
      let dispatched = false;
      return withDispatchAuthorization(result, async () => {
        if (dispatched) throw new Error("Recurring dispatch approval was already consumed.");
        dispatched = true; await validate();
      }, validate);
    }
  };
}

export async function recurringCronRuntimeOptions(job: CronJob, context: { profileId: string; homeDir?: string; sessionId: string }) {
  const securityPolicy = await recurringCronSecurityPolicy(job, context);
  if (!job.executionOrigin&&!job.localTarget) return {};
  await validateCronAuthority(job,context);
  const targets = new ExecutionTargetStore(context);
  try {
    const sourceWorkspace = targets.getTarget((job.executionOrigin?.target??job.localTarget!.binding).targetId)!.source;
    return { securityPolicy, sourceWorkspace, validateExecutionAuthority: async () => { await validateCronAuthority(job, context); } };
  } finally { targets.close(); }
}
