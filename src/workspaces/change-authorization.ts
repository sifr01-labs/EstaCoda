import { ChangeArtifactStore, type ChangeBundle } from "./change-artifact.js";
import { COPY_LIMITS, checkStamp, copyPath, hash, snapshot } from "./copy-files.js";
import { WorkspaceApprovalStore, type PersistedWorkspaceApprovalGrant } from "../security/workspace-approval-controller.js";
import { localApprovalScope, sameReusableAuthority } from "../security/approval-scope.js";
import { verifyHostExecution } from "../execution/host-authority.js";
import { WorkspaceTrustStore } from "../security/workspace-trust-store.js";
import { targetBinding } from "./execution-target.js";

export type ApplicationPlan = { version: 1; outcome: "review" | "apply"; paths: Array<{ path: string; operations: Array<"create" | "update" | "delete"> }> };
export type ApplicationAuthorization = { version: 1; targetId: string; manifestHash: string; plan: ApplicationPlan; grant?: PersistedWorkspaceApprovalGrant };
export function parseApplicationPlan(value: unknown): ApplicationPlan {
  const plan = value as ApplicationPlan;
  if (!plan || plan.version !== 1 || !["review", "apply"].includes(plan.outcome) || !Array.isArray(plan.paths) || plan.paths.length > COPY_LIMITS.files || plan.outcome === "apply" && !plan.paths.length) throw new Error("Application plan requires an outcome and bounded exact paths/mutation types.");
  const seen = new Set<string>();
  for (const entry of plan.paths) {
    copyPath(entry?.path);
    if (seen.has(entry.path) || entry.path.split("/").includes("node_modules") || !Array.isArray(entry.operations) || !entry.operations.length || entry.operations.length > 3 || entry.operations.some((op) => !["create", "update", "delete"].includes(op)) || new Set(entry.operations).size !== entry.operations.length) throw new Error("Invalid application scope.");
    seen.add(entry.path);
  }
  return { version: 1, outcome: plan.outcome, paths: plan.paths.map((entry) => ({ path: entry.path, operations: [...entry.operations].sort() })).sort((a, b) => a.path.localeCompare(b.path)) };
}
export class ChangeAuthorizationStore extends ChangeArtifactStore {
  readonly approvals: WorkspaceApprovalStore;
  readonly trust: WorkspaceTrustStore;
  constructor(options: { homeDir?: string; profileId: string }) {
    super(options); this.approvals = new WorkspaceApprovalStore(options); this.trust = new WorkspaceTrustStore(options);
    try { this.db.exec("create table if not exists copy_application_authorizations (target_id text primary key, record_json text not null)"); }
    catch (error) { this.close(); throw error; }
  }
  authorization(targetId: string): ApplicationAuthorization | undefined {
    const row = this.db.query<{ record_json: string }>("select record_json from copy_application_authorizations where target_id=?").get(targetId);
    if (!row) return undefined;
    const value = JSON.parse(row.record_json) as ApplicationAuthorization;
    parseApplicationPlan(value.plan);
    if (value.version !== 1 || value.targetId !== targetId || !/^[a-f0-9]{64}$/u.test(value.manifestHash)) throw new Error("Invalid application authorization.");
    return value;
  }
  /** Local operator entry point only. Exports and model output never call grant(). */
  async authorize(targetId: string, input: unknown): Promise<ApplicationAuthorization> {
    const plan = parseApplicationPlan(input), target = this.getTarget(targetId);
    if (target?.kind !== "temporary-copy") throw new Error("Application authorization requires an owned copy target.");
    await this.validate(targetBinding(target), target.workspace.canonicalPath);
    const existing = this.authorization(targetId);
    if (existing) {
      if (JSON.stringify(existing.plan) !== JSON.stringify(plan)) throw new Error("Copy outcome/scope is already fixed. Prepare a new copy for expanded authorization.");
      return existing;
    }
    const manifest = this.copyManifest(targetId);
    checkStamp(target.source.identity.canonicalPath, manifest.sourceStamp);
    if (!await this.trust.isTrusted(target.source.identity.canonicalPath)) throw new Error("Source workspace trust is required for application authority.");
    for (const entry of plan.paths) {
      const baseline = manifest.entries.find((candidate) => candidate.path === entry.path);
      if (baseline?.origin === "dependency" || !baseline && (entry.operations.some((op) => op !== "create") || snapshot(target.source.identity.canonicalPath, entry.path) !== null)) throw new Error("Application scope must use source-manifest files or explicitly absent new paths.");
    }
    const record: ApplicationAuthorization = { version: 1, targetId, manifestHash: target.manifestHash, plan };
    if (plan.outcome === "apply") {
      const executionScope = localApprovalScope(this.profileId, target.id, await verifyHostExecution(target.source.identity.canonicalPath));
      record.grant = await this.approvals.grant({ workspaceRoot: target.source.identity.canonicalPath, toolName: "workspace.apply",
        riskClass: plan.paths.some((entry) => entry.operations.includes("delete")) ? "destructive-local" : "workspace-write",
        targetKey: hash(JSON.stringify([target.id, target.manifestHash, plan])), executionScope });
    }
    return this.transaction(() => {
      if (this.authorization(targetId)) throw new Error("Copy authorization changed concurrently; inspect it before continuing.");
      this.db.query("insert into copy_application_authorizations values (?, ?)").run(targetId, JSON.stringify(record)); return record;
    });
  }
  async checkAuthorization(bundle: ChangeBundle): Promise<() => void> {
    const record = this.authorization(bundle.target.targetId), target = this.getTarget(bundle.target.targetId);
    if (!record || record.plan.outcome !== "apply" || !record.grant || target?.kind !== "temporary-copy" || record.manifestHash !== bundle.manifestHash) throw new Error("Review-only changes: application was not authorized.");
    const source = target.source.identity.canonicalPath;
    const current = localApprovalScope(this.profileId, target.id, await verifyHostExecution(source));
    if (!await this.trust.isTrusted(source)) throw new Error("Source workspace trust was revoked.");
    const entryMap = new Map(record.plan.paths.map((entry) => [entry.path, entry.operations]));
    for (const change of bundle.changes) if (!entryMap.get(change.path)?.includes(change.operation)) throw new Error("Changes exceed the authorized paths or mutation types. Export for review.");
    const grant = record.grant;
    const check = () => {
      if (!sameReusableAuthority(grant.executionScope, current) || grant.toolName !== "workspace.apply" || grant.workspaceRoot !== source ||
        grant.targetKey !== hash(JSON.stringify([target.id, target.manifestHash, record.plan])) || !this.approvals.hasGrant(grant) ||
        JSON.stringify(this.authorization(target.id)) !== JSON.stringify(record)) throw new Error("Change-application grant was revoked or changed.");
      checkStamp(source, this.copyManifest(target.id).sourceStamp);
    };
    check(); return check;
  }
}
