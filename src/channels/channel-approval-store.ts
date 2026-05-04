import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ChannelSessionKey } from "../contracts/channel.js";

export type PersistedApprovalGrant = {
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

type ApprovalFile = {
  version: 1;
  grants: PersistedApprovalGrant[];
};

export class ChannelApprovalStore {
  readonly #path: string;
  readonly #now: () => Date;
  readonly #idFactory: () => string;

  constructor(options: {
    path?: string;
    now?: () => Date;
    idFactory?: () => string;
  } = {}) {
    this.#path = options.path ?? join(homedir(), ".estacoda", "channel-approvals.json");
    this.#now = options.now ?? (() => new Date());
    this.#idFactory = options.idFactory ?? (() => `approval-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
  }

  get path(): string {
    return this.#path;
  }

  async listForSession(sessionKey: ChannelSessionKey): Promise<PersistedApprovalGrant[]> {
    const file = await this.#read();
    return file.grants.filter((grant) => matchesSessionScope(grant, sessionKey));
  }

  async listAll(): Promise<PersistedApprovalGrant[]> {
    const file = await this.#read();
    return file.grants;
  }

  async grant(input: {
    sessionKey: ChannelSessionKey;
    toolName: string;
    riskClass: string;
    targetKey?: string;
    targetSummary?: string;
  }): Promise<PersistedApprovalGrant> {
    const file = await this.#read();
    const existing = file.grants.find((grant) =>
      grant.platform === input.sessionKey.platform &&
      grant.userId === input.sessionKey.userId &&
      grant.chatId === input.sessionKey.chatId &&
      grant.toolName === input.toolName &&
      grant.riskClass === input.riskClass &&
      grant.targetKey === input.targetKey &&
      grant.targetSummary === input.targetSummary
    );

    if (existing !== undefined) {
      return existing;
    }

    const grant: PersistedApprovalGrant = {
      id: this.#idFactory(),
      platform: input.sessionKey.platform,
      userId: input.sessionKey.userId,
      chatId: input.sessionKey.chatId,
      toolName: input.toolName,
      riskClass: input.riskClass,
      targetKey: input.targetKey,
      targetSummary: input.targetSummary,
      grantedAt: this.#now().toISOString()
    };

    file.grants.push(grant);
    file.grants.sort((left, right) => left.grantedAt.localeCompare(right.grantedAt) || left.id.localeCompare(right.id));
    await this.#write(file);

    return grant;
  }

  async revoke(id: string, sessionKey?: ChannelSessionKey): Promise<boolean> {
    const file = await this.#read();
    const before = file.grants.length;
    file.grants = file.grants.filter((grant) => {
      if (grant.id !== id) {
        return true;
      }

      return sessionKey !== undefined && !matchesSessionScope(grant, sessionKey);
    });

    if (file.grants.length === before) {
      return false;
    }

    await this.#write(file);
    return true;
  }

  async #read(): Promise<ApprovalFile> {
    try {
      const parsed = JSON.parse(await readFile(this.#path, "utf8")) as Partial<ApprovalFile>;
      return {
        version: 1,
        grants: Array.isArray(parsed.grants) ? parsed.grants.filter(isGrant) : []
      };
    } catch {
      return {
        version: 1,
        grants: []
      };
    }
  }

  async #write(file: ApprovalFile): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    await writeFile(this.#path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
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
