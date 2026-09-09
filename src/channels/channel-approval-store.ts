import { readApprovalFile, updateApprovalFile } from "../security/approval-file.js";
import { sameReusableAuthority, validApprovalScope, type ApprovalExecutionScope } from "../security/approval-scope.js";
import { join } from "node:path";
import { resolveHomeDir } from "../config/home-dir.js";
import type { ChannelSessionKey } from "../contracts/channel.js";

export type PersistedApprovalGrant = {
  executionScope?: ApprovalExecutionScope;
  authorizationGeneration?: number;
  id: string;
  platform: string;
  userId?: string;
  chatId?: string;
  toolName: string;
  riskClass: string;
  targetKey?: string;
  targetSummary?: string;
  grantedAt: string;
};

export class ChannelApprovalStore {
  readonly #path: string;
  readonly #now: () => Date;
  readonly #idFactory: () => string;

  constructor(options: {
    path?: string;
    homeDir?: string;
    now?: () => Date;
    idFactory?: () => string;
  } = {}) {
    this.#path = options.path ?? join(resolveHomeDir(options.homeDir), ".estacoda", "channel-approvals.json");
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? (() => `approval-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  }

  get path(): string {
    return this.#path;
  }

  async listForSession(sessionKey: ChannelSessionKey): Promise<PersistedApprovalGrant[]> {
    return readApprovalFile(this.#path, isGrant).grants.filter((grant) => matchesSessionScope(grant, sessionKey));
  }
  async listAll(): Promise<PersistedApprovalGrant[]> { return readApprovalFile(this.#path, isGrant).grants; }
  revision(): number { return readApprovalFile(this.#path, isGrant).revision; }

  async grant(input: {
    sessionKey: ChannelSessionKey; toolName: string; riskClass: string;
    targetKey?: string; targetSummary?: string; executionScope?: ApprovalExecutionScope; expectedRevision?: number;
  }): Promise<PersistedApprovalGrant> {
    if (input.executionScope !== undefined && !validApprovalScope(input.executionScope)) throw new Error("Invalid approval execution scope.");
    return updateApprovalFile(this.#path, isGrant, (file) => {
      if (input.expectedRevision !== undefined && input.expectedRevision !== file.revision) throw new Error("Approval authority changed. Review the current action to renew approval.");
      const existing = file.grants.find((grant) => matchesSessionScope(grant, input.sessionKey) && grant.toolName === input.toolName &&
        grant.riskClass === input.riskClass && grant.targetKey === input.targetKey && sameReusableAuthority(grant.executionScope, input.executionScope));
      if (existing) return existing;
      const grant: PersistedApprovalGrant = { id: this.#idFactory(), platform: input.sessionKey.platform,
        userId: input.sessionKey.userId, chatId: input.sessionKey.chatId, toolName: input.toolName, riskClass: input.riskClass,
        targetKey: input.targetKey, targetSummary: input.targetSummary, executionScope: input.executionScope,
        authorizationGeneration: ++file.revision, grantedAt: this.#now().toISOString() };
      file.grants.push(grant);
      return grant;
    });
  }
  async revoke(id: string, sessionKey?: ChannelSessionKey): Promise<boolean> {
    return updateApprovalFile(this.#path, isGrant, (file) => {
      const before = file.grants.length;
      file.grants = file.grants.filter((grant) => grant.id !== id || (sessionKey !== undefined && !matchesSessionScope(grant, sessionKey)));
      if (before === file.grants.length) return false;
      file.revision++;
      return true;
    });
  }

}

function matchesSessionScope(grant: PersistedApprovalGrant, sessionKey: ChannelSessionKey): boolean {
  if (grant.platform !== sessionKey.platform) {
    return false;
  }

  if (grant.chatId !== undefined && grant.chatId !== sessionKey.chatId) {
    return false;
  }

  if (grant.userId !== undefined && grant.userId !== sessionKey.userId) {
    return false;
  }

  return true;
}

function isGrant(value: unknown): value is PersistedApprovalGrant {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Partial<PersistedApprovalGrant>;

  return typeof candidate.id === "string" &&
    typeof candidate.platform === "string" &&
    typeof candidate.toolName === "string" &&
    typeof candidate.riskClass === "string" &&
    typeof candidate.grantedAt === "string";
}
