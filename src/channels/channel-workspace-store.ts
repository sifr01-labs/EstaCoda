import { createHash, randomUUID } from "node:crypto";
import type { ChannelSessionKey } from "../contracts/channel.js";
import type { ExecutionTargetBinding, SourceWorkspaceBinding } from "../contracts/workspace.js";
import { ExecutionTargetStore, parseExecutionTargetBinding, parseWorkspaceIdentity, targetBinding } from "../workspaces/execution-target.js";
import { normalizeWorkspaceAlias } from "../workspaces/workspace-registry.js";
import { normalizeSessionKey, shouldAutoResetSession, type ChannelSessionPolicy } from "./channel-session-store.js";

/** A routing handle for the complete normalized channel scope, never authority. */
export function channelSurfaceId(key: ChannelSessionKey, policy: ChannelSessionPolicy = {}): string {
  const scope = normalizeSessionKey(key, policy);
  return `scope_${createHash("sha256").update(JSON.stringify([scope.platform, scope.accountId ?? null,
    scope.chatType, scope.chatId, scope.threadId ?? null, scope.userId ?? null])).digest("hex")}`;
}

export type ChannelWorkspaceBinding = {
  schemaVersion: 1; profileId: string; surfaceId: string; revision: number;
  source: SourceWorkspaceBinding; target: ExecutionTargetBinding; sessionId: string; lastActivityAt?: string;
};

/** Extends the core profile-local workspace database. Selection and the fresh
 * future Session pointer commit together; existing Session targets never change. */
export class ChannelWorkspaceStore extends ExecutionTargetStore {
  readonly #policy: ChannelSessionPolicy;
  constructor(options: { homeDir?: string; profileId: string; policy?: ChannelSessionPolicy }) {
    super(options); this.#policy = options.policy ?? {};
    try { this.db.exec("create table if not exists channel_workspace_bindings (surface_id text primary key, record_json text not null)"); }
    catch (error) { this.close(); throw error; }
  }
  current(key: ChannelSessionKey): ChannelWorkspaceBinding | undefined {
    const surfaceId = channelSurfaceId(key, this.#policy);
    const row = this.db.query<{ record_json: string }>("select record_json from channel_workspace_bindings where surface_id=?").get(surfaceId);
    if (!row) return undefined;
    const binding = JSON.parse(row.record_json) as ChannelWorkspaceBinding;
    parseExecutionTargetBinding(binding.target); parseWorkspaceIdentity(binding.source?.identity);
    if (binding.schemaVersion !== 1 || binding.profileId !== this.profileId || binding.surfaceId !== surfaceId ||
      (binding.lastActivityAt !== undefined && (typeof binding.lastActivityAt !== "string" || !Number.isFinite(Date.parse(binding.lastActivityAt)))) ||
      !Number.isSafeInteger(binding.revision) || binding.revision < 1 || !binding.sessionId ||
      !binding.source.registeredWorkspaceId || !Number.isSafeInteger(binding.source.registeredWorkspaceRevision) ||
      binding.source.identity.identityHash !== binding.target.workspace.identityHash) throw new Error("Invalid channel workspace binding. Select the workspace again.");
    return binding;
  }
  async select(key: ChannelSessionKey, alias: string, expectedRevision: number): Promise<ChannelWorkspaceBinding> {
    const workspace = await this.resolve(normalizeWorkspaceAlias(alias));
    const source = { identity: workspace.identity, registeredWorkspaceId: workspace.id, registeredWorkspaceRevision: workspace.locationRevision };
    const target = await this.acquireLocal(workspace.identity.canonicalPath, source);
    return this.transaction(() => {
      if ((this.current(key)?.revision ?? 0) !== expectedRevision) throw new Error("Channel selection changed. Inspect /workspace and retry.");
      const current = this.require(workspace.id);
      const live = this.getTarget(target.id);
      if (current.locationRevision !== workspace.locationRevision || !live || live.status !== "available" || live.generation !== target.generation) throw new Error("Workspace changed during selection. Select it again.");
      const binding: ChannelWorkspaceBinding = { schemaVersion: 1, profileId: this.profileId,
        surfaceId: channelSurfaceId(key, this.#policy), revision: expectedRevision + 1, source,
        target: targetBinding(target), sessionId: randomUUID() };
      this.#write(binding); return binding;
    });
  }
  async validateSelection(binding: ChannelWorkspaceBinding): Promise<void> {
    const workspace = this.get(binding.source.registeredWorkspaceId!);
    if (!workspace || workspace.locationRevision !== binding.source.registeredWorkspaceRevision || workspace.identity.identityHash !== binding.source.identity.identityHash) {
      throw new Error("Selected workspace moved or was removed. Use /workspace use <alias> to select explicitly.");
    }
    await this.validate(binding.target, binding.target.workspace.canonicalPath);
  }
  /** Validation can yield; compare the selection again inside the write transaction.
   * Activity and any future Session rotation are committed together across processes. */
  async touchSession(key: ChannelSessionKey, receivedAt: Date, policy: ChannelSessionPolicy): Promise<ChannelWorkspaceBinding | undefined> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const selected = this.current(key); if (!selected) return undefined;
      await this.validateSelection(selected);
      const result = this.transaction(() => {
        const current = this.current(key);
        if (!current || current.revision !== selected.revision) return undefined;
        const time = new Date(Math.max(receivedAt.getTime(), Date.parse(current.lastActivityAt ?? "") || 0));
        const reset = current.lastActivityAt !== undefined && shouldAutoResetSession(current.lastActivityAt, time, policy);
        const next = { ...current, lastActivityAt: time.toISOString(),
          ...(reset ? { revision: current.revision + 1, sessionId: randomUUID() } : {}) };
        this.#write(next); return next;
      });
      if (result) return result;
    }
    throw new Error("Channel selection changed repeatedly. Retry the message.");
  }
  resetSession(key: ChannelSessionKey, sessionId: string = randomUUID(), receivedAt = new Date()): string | undefined {
    return this.transaction(() => {
      const current = this.current(key); if (!current) return undefined;
      this.#write({ ...current, revision: current.revision + 1, sessionId, lastActivityAt: receivedAt.toISOString() }); return sessionId;
    });
  }
  #write(binding: ChannelWorkspaceBinding): void {
    this.db.query("insert into channel_workspace_bindings values (?,?) on conflict(surface_id) do update set record_json=excluded.record_json")
      .run(binding.surfaceId, JSON.stringify(binding));
  }
}
