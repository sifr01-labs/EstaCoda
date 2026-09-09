import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { ExecutionTargetBinding, LocalExecutionTarget, SourceWorkspaceBinding, WorkspaceIdentity } from "../contracts/workspace.js";
import { WorkspaceRegistry, resolveWorkspaceDirectory } from "./workspace-registry.js";

export function parseWorkspaceIdentity(value: unknown): WorkspaceIdentity {
  const identity = value as WorkspaceIdentity | undefined;
  if (!identity || typeof identity.canonicalPath !== "string" || !isAbsolute(identity.canonicalPath) ||
    identity.identityHash !== createHash("sha256").update(identity.canonicalPath).digest("hex")) throw new Error("Invalid workspace identity.");
  return { canonicalPath: identity.canonicalPath, identityHash: identity.identityHash };
}

export function parseExecutionTargetBinding(value: unknown): ExecutionTargetBinding {
  const binding = value as ExecutionTargetBinding | undefined;
  if (!binding || binding.schemaVersion !== 1 || typeof binding.targetId !== "string" || !/^target_[a-f0-9-]{36}$/u.test(binding.targetId) ||
    !Number.isSafeInteger(binding.targetGeneration) || binding.targetGeneration < 1) throw new Error("Invalid or unsupported execution target binding.");
  return { schemaVersion: 1, targetId: binding.targetId, targetGeneration: binding.targetGeneration, workspace: parseWorkspaceIdentity(binding.workspace) };
}

export function targetBinding(target: LocalExecutionTarget): ExecutionTargetBinding {
  return { schemaVersion: 1, targetId: target.id, targetGeneration: target.generation, workspace: { ...target.workspace } };
}

export function targetSessionMetadata(metadata: Record<string, unknown> | undefined, binding: ExecutionTargetBinding | undefined) {
  if (binding === undefined) return metadata;
  const root = parseExecutionTargetBinding(binding).workspace.canonicalPath;
  for (const key of ["workspaceRoot", "workspaceDirectory", "projectRoot"]) {
    if (metadata?.[key] !== undefined && metadata[key] !== root) throw new Error("Session workspace does not match its execution target.");
  }
  return { ...metadata, workspaceRoot: root };
}

/** One core database owns optional names and local targets. Source snapshots are
 * immutable, so alias moves/removal cannot retarget historical Sessions or Tasks. */
export class ExecutionTargetStore extends WorkspaceRegistry {
  constructor(options: { homeDir?: string; profileId: string }) {
    super(options);
    try { this.db.exec(`create table if not exists execution_targets (
      id text primary key, selection_key text not null unique, record_json text not null
    )`); } catch (error) { this.close(); throw error; }
  }

  getTarget(id: string): LocalExecutionTarget | undefined {
    const row = this.db.query<{ record_json: string }>("select record_json from execution_targets where id = ?").get(id);
    if (!row) return undefined;
    const target = JSON.parse(row.record_json) as LocalExecutionTarget;
    parseExecutionTargetBinding(targetBinding(target));
    parseWorkspaceIdentity(target.source?.identity);
    if (target.schemaVersion !== 1 || target.id !== id || target.profileId !== this.profileId || target.kind !== "local" ||
      !["available", "archived"].includes(target.status) || target.source.identity.identityHash !== target.workspace.identityHash) {
      throw new Error("Invalid execution target ownership record.");
    }
    return target;
  }

  async acquireLocal(path: string, source?: SourceWorkspaceBinding): Promise<LocalExecutionTarget> {
    const workspace = await resolveWorkspaceDirectory(path);
    const snapshot: SourceWorkspaceBinding = source === undefined ? { identity: workspace } : structuredClone(source);
    parseWorkspaceIdentity(snapshot.identity);
    if (snapshot.identity.identityHash !== workspace.identityHash) throw new Error("Local target source must match its working directory.");
    if ((snapshot.registeredWorkspaceId === undefined) !== (snapshot.registeredWorkspaceRevision === undefined)) throw new Error("Incomplete registered workspace reference.");
    return this.transaction(() => {
      if (snapshot.registeredWorkspaceId !== undefined) {
        const current = this.require(snapshot.registeredWorkspaceId);
        if (current.locationRevision !== snapshot.registeredWorkspaceRevision || current.identity.identityHash !== workspace.identityHash) {
          throw new Error("Workspace moved during target acquisition. Select it again.");
        }
      }
      const key = JSON.stringify([workspace.identityHash, snapshot.registeredWorkspaceId ?? null, snapshot.registeredWorkspaceRevision ?? null]);
      const existing = this.db.query<{ id: string }>("select id from execution_targets where selection_key = ?").get(key);
      if (existing) {
        const target = this.getTarget(existing.id)!;
        if (target.status !== "available") throw new Error("Execution target is unavailable.");
        return target;
      }
      const target: LocalExecutionTarget = { schemaVersion: 1, profileId: this.profileId, id: `target_${randomUUID()}`,
        kind: "local", generation: 1, source: snapshot, workspace, status: "available" };
      this.db.query("insert into execution_targets values (?, ?, ?)").run(target.id, key, JSON.stringify(target));
      return target;
    });
  }

  async validate(value: ExecutionTargetBinding, path: string): Promise<LocalExecutionTarget> {
    const binding = parseExecutionTargetBinding(value);
    const target = this.getTarget(binding.targetId);
    if (!target || target.status !== "available" || target.generation !== binding.targetGeneration ||
      target.workspace.identityHash !== binding.workspace.identityHash) throw new Error("Execution target is missing, stale or belongs to another profile.");
    const actual = await resolveWorkspaceDirectory(path);
    if (actual.identityHash !== target.workspace.identityHash) throw new Error("Session execution target belongs to a different workspace.");
    return target;
  }
}
