import * as fs from "node:fs";
import { dirname, join, posix } from "node:path";
import { randomUUID } from "node:crypto";
import type { ArtifactRecord, SessionArtifactRegistration } from "../contracts/artifact.js";
import { resolveGlobalStateHome } from "../config/profile-home.js";
import { openDefaultSQLiteDatabase } from "../storage/factory.js";
import { assessHardlineFloor } from "../security/command-safety.js";
import { ChangeAuthorizationStore } from "./change-authorization.js";
import { type ChangeBundle, type WorkspaceChange } from "./change-artifact.js";
import { checkStamp, checkedFile, hash, sameFile, snapshot, writeNew } from "./copy-files.js";
import { targetBinding } from "./execution-target.js";

export type ApplicationResult = { status: "applied" | "review" | "conflict" | "attention"; artifact: ArtifactRecord; paths: string[]; reason?: string; code?: "copy-consumed" };

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
export function replaceFile(root: string, change: WorkspaceChange, temporary = posix.join(posix.dirname(change.path), `.estacoda-apply-${randomUUID()}.tmp`)): void {
  const destination = checkedFile(root, change.path);
  if (!sameFile(snapshot(root, change.path), change.before)) throw new Error(`Conflict: ${change.path}`);
  if (change.after === null) {
    const denial = assessHardlineFloor(`rm -- '${destination.replaceAll("'", "'\\''")}'`);
    if (denial) throw new Error(denial.reason);
    checkedFile(root, change.path); fs.unlinkSync(destination); return;
  }
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

type ApplicationJournal = {
  version: 1; targetId: string; artifactId: string;
  phase: "applying" | "applied" | "rolling-back" | "rolled-back" | "attention";
  steps: Array<{ path: string; temporary: string; rollbackTemporary: string; phase: "pending" | "applying" | "applied" | "rolling-back" | "rolled-back" | "conflict" }>;
};

function settleTemporary(root: string, change: WorkspaceChange, temporary: string): void {
  const file = snapshot(root, temporary, true);
  if (!file) return;
  if (!sameFile(file, change.after)) throw new Error("Application staging changed; preserve it for inspection.");
  const staged = checkedFile(root, temporary, true), info = fs.lstatSync(staged);
  if (info.nlink === 2) {
    const destination = fs.lstatSync(checkedFile(root, change.path, true));
    if (info.dev !== destination.dev || info.ino !== destination.ino) throw new Error("Application staging ownership is uncertain.");
  }
  fs.unlinkSync(staged);
}
function inverse(change: WorkspaceChange): WorkspaceChange {
  return { path: change.path, before: change.after, after: change.before,
    operation: change.after === null ? "create" : change.before === null ? "delete" : "update" };
}

export class ChangeApplicationStore extends ChangeAuthorizationStore {
  constructor(options: { homeDir?: string; profileId: string }) {
    super(options);
    try { this.db.exec("create table if not exists workspace_applications (target_id text primary key, record_json text not null)"); }
    catch (error) { this.close(); throw error; }
  }
  #journal(targetId: string): ApplicationJournal | undefined {
    const row = this.db.query<{ record_json: string }>("select record_json from workspace_applications where target_id=?").get(targetId);
    if (!row) return undefined;
    const journal = JSON.parse(row.record_json) as ApplicationJournal;
    if (journal.version !== 1 || journal.targetId !== targetId || !["applying", "applied", "rolling-back", "rolled-back", "attention"].includes(journal.phase) ||
      !Array.isArray(journal.steps) || journal.steps.length > 512 || journal.steps.some((step) =>
        !["pending", "applying", "applied", "rolling-back", "rolled-back", "conflict"].includes(step.phase) ||
        ![step.temporary, step.rollbackTemporary].every((path) => posix.dirname(path) === posix.dirname(step.path) && /^\.estacoda-apply-[a-f0-9-]{36}\.tmp$/u.test(posix.basename(path))))) throw new Error("Invalid application journal.");
    return journal;
  }
  #save(journal: ApplicationJournal): void {
    this.transaction(() => this.db.query("insert into workspace_applications values (?, ?) on conflict(target_id) do update set record_json=excluded.record_json").run(journal.targetId, JSON.stringify(journal)));
  }
  async finish(targetId: string, sessionId: string, persist?: (registration: SessionArtifactRegistration) => Promise<void>): Promise<ApplicationResult> {
    const prior = this.#journal(targetId);
    if (prior) {
      const { artifact } = await this.load(prior.artifactId);
      return { status: "attention", code: "copy-consumed", artifact, paths: [], reason: "This copy already has an application receipt. Inspect/recover it; use a fresh copy for further work." };
    }
    const artifact = await this.export(targetId, sessionId, persist);
    if (this.authorization(targetId)?.plan.outcome !== "apply") return { status: "review", artifact, paths: [] };
    return this.apply(artifact.id);
  }
  async #guard(bundle: ChangeBundle, recovering = false): Promise<() => void> {
    const target = this.getTarget(bundle.target.targetId)!;
    const currentSource = this.get(target.source.registeredWorkspaceId!);
    if (!currentSource || currentSource.locationRevision !== target.source.registeredWorkspaceRevision || currentSource.identity.identityHash !== target.source.identity.identityHash) throw new Error("Source selection moved or was removed.");
    const checkGrant = await this.checkAuthorization(bundle);
    const trustRevision = hash(fs.readFileSync(this.trust.path));
    return () => {
      checkGrant();
      const selected = this.get(target.source.registeredWorkspaceId!), live = this.getTarget(target.id);
      if (!selected || selected.locationRevision !== target.source.registeredWorkspaceRevision || !live || live.status !== "available" || live.generation !== bundle.target.targetGeneration) throw new Error("Application target/source changed.");
      if (!recovering && live.kind === "temporary-copy") checkStamp(live.workspace.canonicalPath, live.directoryStamp);
      if (hash(fs.readFileSync(this.trust.path)) !== trustRevision) throw new Error("Workspace trust changed during application.");
    };
  }
  async apply(artifactId: string): Promise<ApplicationResult> {
    const { artifact, bundle, target } = await this.load(artifactId);
    try {
      await this.validate(targetBinding(target), target.workspace.canonicalPath);
      const check = await this.#guard(bundle);
      return withSourceApplicationLock(this.options, target.source.identity.identityHash, () => {
        check();
        const previous = this.#journal(target.id);
        if (previous) return { status: previous.artifactId === artifactId && previous.phase === "applied" ? "applied" : "attention", artifact, paths: [], reason: "Application receipt already exists. Recover interrupted work before creating a fresh copy." };
        const root = target.source.identity.canonicalPath;
        const conflicts = bundle.changes.filter((change) => !sameFile(snapshot(root, change.path), change.before)).map((change) => change.path);
        if (conflicts.length) return { status: "conflict", artifact, paths: conflicts };
        if (!bundle.changes.length) return { status: "review", artifact, paths: [], reason: "No changes to apply; this copy remains available for work." };
        const journal: ApplicationJournal = { version: 1, targetId: target.id, artifactId, phase: "applying", steps: bundle.changes.map((change) => ({ path: change.path, phase: "pending",
          temporary: posix.join(posix.dirname(change.path), `.estacoda-apply-${randomUUID()}.tmp`), rollbackTemporary: posix.join(posix.dirname(change.path), `.estacoda-apply-${randomUUID()}.tmp`) })) };
        this.#save(journal); // Durable intent precedes the first filesystem mutation.
        for (const [index, change] of bundle.changes.entries()) {
          check(); const step = journal.steps[index]!;
          step.phase = "applying"; this.#save(journal);
          replaceFile(root, change, step.temporary);
          step.phase = "applied"; this.#save(journal);
        }
        journal.phase = "applied"; this.#save(journal);
        return { status: "applied", artifact, paths: bundle.changes.map((change) => change.path) };
      });
    } catch (error) { return { status: "attention", artifact, paths: [], reason: error instanceof Error ? error.message : "Change application is blocked." }; }
  }
  async recover(artifactId: string): Promise<ApplicationResult> {
    const { artifact, bundle, target } = await this.load(artifactId);
    try {
      const check = await this.#guard(bundle, true);
      return withSourceApplicationLock(this.options, target.source.identity.identityHash, () => {
        check(); const journal = this.#journal(target.id);
        if (!journal || journal.artifactId !== artifactId || journal.steps.length !== bundle.changes.length || journal.steps.some((step, index) => step.path !== bundle.changes[index]!.path)) throw new Error("No matching application journal.");
        if (journal.phase === "rolled-back") return { status: "review", artifact, paths: [], reason: "Application was already rolled back." };
        journal.phase = "rolling-back"; this.#save(journal);
        const root = target.source.identity.canonicalPath, conflicts: string[] = [];
        for (let index = journal.steps.length - 1; index >= 0; index--) {
          const step = journal.steps[index]!, change = bundle.changes[index]!;
          if (step.phase === "pending" || step.phase === "rolled-back") continue;
          check(); settleTemporary(root, change, step.temporary); settleTemporary(root, inverse(change), step.rollbackTemporary);
          const current = snapshot(root, change.path);
          if (sameFile(current, change.before)) { step.phase = "rolled-back"; this.#save(journal); continue; }
          if (!sameFile(current, change.after)) { step.phase = "conflict"; conflicts.push(change.path); this.#save(journal); continue; }
          step.phase = "rolling-back"; this.#save(journal);
          replaceFile(root, inverse(change), step.rollbackTemporary);
          step.phase = "rolled-back"; this.#save(journal);
        }
        journal.phase = conflicts.length ? "attention" : "rolled-back"; this.#save(journal);
        return { status: conflicts.length ? "attention" : "review", artifact, paths: conflicts, reason: conflicts.length ? "Later edits were preserved; inspect these paths." : "Application rolled back. Review the retained artifact or prepare a fresh copy." };
      });
    } catch (error) { return { status: "attention", artifact, paths: [], reason: error instanceof Error ? error.message : "Application recovery is blocked." }; }
  }
}
