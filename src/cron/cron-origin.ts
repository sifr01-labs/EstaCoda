import { AsyncLocalStorage } from "node:async_hooks";
import type { ChannelSessionKey } from "../contracts/channel.js";
import type { ExecutionTargetBinding } from "../contracts/workspace.js";
import { parseExecutionTargetBinding } from "../workspaces/execution-target.js";
import { channelSurfaceId } from "../channels/channel-workspace-store.js";

export type CronExecutionOrigin = {
  schemaVersion: 1; profileId: string; target: ExecutionTargetBinding;
  sessionKey: ChannelSessionKey; principalId: string; guildId?: string;
};
const originContext = new AsyncLocalStorage<CronExecutionOrigin>();
/** Supplied only by the authenticated gateway, never parsed from tool arguments. */
export function withCronExecutionOrigin<T>(origin: CronExecutionOrigin | undefined, work: () => T): T {
  return origin === undefined ? work() : originContext.run(parseCronExecutionOrigin(origin), work);
}
export function currentCronExecutionOrigin(): CronExecutionOrigin | undefined {
  const origin = originContext.getStore(); return origin && structuredClone(origin);
}
export function parseCronExecutionOrigin(value: unknown): CronExecutionOrigin {
  const origin = value as CronExecutionOrigin | undefined;
  if (!origin || origin.schemaVersion !== 1 || typeof origin.profileId !== "string" || !origin.profileId ||
    typeof origin.principalId !== "string" || !origin.principalId || !origin.sessionKey ||
    !["telegram", "whatsapp", "discord", "email"].includes(origin.sessionKey.platform) ||
    typeof origin.sessionKey.chatId !== "string" || !origin.sessionKey.chatId ||
    [origin.sessionKey.accountId, origin.sessionKey.userId, origin.sessionKey.threadId, origin.guildId].some((v) => v !== undefined && typeof v !== "string")) {
    throw new Error("Invalid recurring execution origin; renew this workflow from its authorized channel.");
  }
  return structuredClone({ ...origin, target: parseExecutionTargetBinding(origin.target) });
}
export function sameCronExecutionOrigin(left: CronExecutionOrigin | undefined, right: CronExecutionOrigin | undefined): boolean {
  return !!left && !!right && left.profileId === right.profileId && left.target.workspace.identityHash === right.target.workspace.identityHash &&
    channelSurfaceId(left.sessionKey, { groupSessionsPerUser: true, threadSessionsPerUser: true }) === channelSurfaceId(right.sessionKey, { groupSessionsPerUser: true, threadSessionsPerUser: true });
}
