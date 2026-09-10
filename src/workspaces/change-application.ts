import * as fs from "node:fs";
import { dirname, join, posix } from "node:path";
import { randomUUID } from "node:crypto";
import type { ArtifactRecord, SessionArtifactRegistration } from "../contracts/artifact.js";
import { resolveGlobalStateHome } from "../config/profile-home.js";
import { openDefaultSQLiteDatabase } from "../storage/factory.js";
import { assessHardlineFloor } from "../security/command-safety.js";
import { ChangeAuthorizationStore } from "./change-authorization.js";
import { type WorkspaceChange } from "./change-artifact.js";
import { checkedFile, hash, sameFile, snapshot, writeNew } from "./copy-files.js";
import { targetBinding } from "./execution-target.js";

export type ApplicationResult = { status: "applied" | "review" | "conflict" | "attention"; artifact: ArtifactRecord; paths: string[]; reason?: string };

/** Shared kernel mutex across profiles applying into the same destination. The
 * database stores no task state and never steals locks based on timestamps. */
export function withSourceApplicationLock<T>(options: { homeDir?: string }, identityHash: string, work: () => T): T {
  const root = join(resolveGlobalStateHome(options).stateRoot, "workspace-application-locks");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error("Application lock directory cannot be a symlink.");
  const path = join(root, `${identityHash}.sqlite`);
  try { if (fs.lstatSync(path).isSymbolicLink()) throw new Error("Application lock cannot be a symlink."); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const lock = openDefaultSQLiteDatabase({ path });
  try { fs.chmodSync(path, 0o600); lock.exec("begin immediate"); const result = work(); lock.exec("commit"); return result; }
  finally { lock.close(); }
}

/** Synchronous optimistic replacement: no provider work, shell or await occurs
 * between final baseline/containment validation and the filesystem mutation. */
export function replaceFile(root: string, change: WorkspaceChange): void {
  const destination = checkedFile(root, change.path);
  if (!sameFile(snapshot(root, change.path), change.before)) throw new Error(`Conflict: ${change.path}`);
  if (change.after === null) {
    const denial = assessHardlineFloor(`rm -- '${destination.replaceAll("'", "'\\''")}'`);
    if (denial) throw new Error(denial.reason);
    checkedFile(root, change.path); fs.unlinkSync(destination); return;
  }
  const temporary = posix.join(posix.dirname(change.path), `.estacoda-apply-${randomUUID()}.tmp`);
  writeNew(root, temporary, change.after);
  try {
    if (!sameFile(snapshot(root, change.path), change.before)) throw new Error(`Conflict: ${change.path}`);
    checkedFile(root, change.path);
    const staged = checkedFile(root, temporary);
    if (change.before === null) { fs.linkSync(staged, destination); fs.unlinkSync(staged); }
    else fs.renameSync(staged, destination);
    const parent = fs.openSync(dirname(destination), fs.constants.O_RDONLY); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
  } finally {
    const staged = snapshot(root, temporary);
    if (staged && sameFile(staged, change.after)) fs.unlinkSync(checkedFile(root, temporary));
  }
}

export class ChangeApplicationStore extends ChangeAuthorizationStore {
  async finish(targetId: string, sessionId: string, persist?: (registration: SessionArtifactRegistration) => Promise<void>): Promise<ApplicationResult> {
    const artifact = await this.export(targetId, sessionId, persist);
    if (this.authorization(targetId)?.plan.outcome !== "apply") return { status: "review", artifact, paths: [] };
    return this.apply(artifact.id);
  }
  async apply(artifactId: string): Promise<ApplicationResult> {
    const { artifact, bundle, target } = await this.load(artifactId);
    try {
      await this.validate(targetBinding(target), target.workspace.canonicalPath);
      const currentSource = this.get(target.source.registeredWorkspaceId!);
      if (!currentSource || currentSource.locationRevision !== target.source.registeredWorkspaceRevision || currentSource.identity.identityHash !== target.source.identity.identityHash) throw new Error("Source selection moved or was removed.");
      const checkGrant = await this.checkAuthorization(bundle);
      const trustRevision = hash(fs.readFileSync(this.trust.path));
      const check = () => {
        checkGrant();
        if (hash(fs.readFileSync(this.trust.path)) !== trustRevision) throw new Error("Workspace trust changed during application.");
      };
      return withSourceApplicationLock(this.options, target.source.identity.identityHash, () => {
        check();
        const root = target.source.identity.canonicalPath;
        const conflicts = bundle.changes.filter((change) => !sameFile(snapshot(root, change.path), change.before)).map((change) => change.path);
        if (conflicts.length) return { status: "conflict", artifact, paths: conflicts };
        for (const change of bundle.changes) { check(); replaceFile(root, change); }
        return { status: "applied", artifact, paths: bundle.changes.map((change) => change.path) };
      });
    } catch (error) { return { status: "attention", artifact, paths: [], reason: error instanceof Error ? error.message : "Change application is blocked." }; }
  }
}
