import { mkdir, writeFile, rm } from "node:fs/promises";
import { readdirSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ArtifactStore } from "../artifacts/artifact-store.js";
import type { ArtifactRecord, SessionArtifactRegistration } from "../contracts/artifact.js";
import type { ExecutionTargetBinding, SourceWorkspaceBinding, TemporaryCopyTarget } from "../contracts/workspace.js";
import { resolveProfileStateHome } from "../config/profile-home.js";
import { ExecutionTargetStore, targetBinding } from "./execution-target.js";
import { COPY_LIMITS, copyPath, hash, sameFile, snapshot, validateSnapshot, type FileSnapshot } from "./copy-files.js";

export type WorkspaceChange = { path: string; operation: "create" | "update" | "delete"; before: FileSnapshot | null; after: FileSnapshot | null };
export type ChangeBundle = { version: 1; profileId: string; sessionId: string; target: ExecutionTargetBinding; source: SourceWorkspaceBinding; manifestHash: string; changes: WorkspaceChange[] };
export class ChangeArtifactStore extends ExecutionTargetStore {
  readonly artifacts: ArtifactStore;
  readonly artifactRoot: string;
  constructor(readonly options: { homeDir?: string; profileId: string }) {
    super(options);
    this.artifactRoot = join(resolveProfileStateHome(options).profileRoot, "artifacts");
    this.artifacts = new ArtifactStore({ storageRoot: this.artifactRoot });
    try { this.db.exec("create table if not exists workspace_change_artifacts (id text primary key, record_json text not null)"); }
    catch (error) { this.close(); throw error; }
  }
  async export(targetId: string, sessionId: string, persist?: (registration: SessionArtifactRegistration) => Promise<void>): Promise<ArtifactRecord> {
    const target = this.getTarget(targetId);
    if (target?.kind !== "temporary-copy") throw new Error("Changes require an owned temporary-copy target.");
    await this.validate(targetBinding(target), target.workspace.canonicalPath);
    const manifest = this.copyManifest(targetId), baseline = new Map(manifest.entries.filter((entry) => entry.origin !== "dependency").map((entry) => [entry.path, entry.baseline]));
    const dependencies = new Set(manifest.entries.filter((entry) => entry.origin === "dependency").map((entry) => entry.path));
    const paths = new Set(baseline.keys()); let scanned = 0;
    const scan = (directory: string, prefix = "") => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (++scanned > 2048) throw new Error("Change enumeration exceeded its bound.");
        const path = prefix + entry.name;
        if (["node_modules", ".estacoda", ".git"].includes(entry.name) || dependencies.has(path)) continue;
        copyPath(path);
        if (entry.isDirectory()) scan(join(directory, entry.name), path + "/");
        else { paths.add(path); if (paths.size > COPY_LIMITS.files) throw new Error("Too many changed files."); }
      }
    };
    scan(target.workspace.canonicalPath);
    let total = 0;
    const changes: WorkspaceChange[] = [];
    for (const path of [...paths].sort()) {
      const before = baseline.get(path) ?? null, after = snapshot(target.workspace.canonicalPath, path);
      total += after ? Buffer.from(after.content, "base64").length : 0;
      if (total > COPY_LIMITS.totalBytes) throw new Error("Change export exceeds the 32 MiB working-content limit.");
      if (!sameFile(before, after)) changes.push({ path, before, after, operation: before === null ? "create" : after === null ? "delete" : "update" });
    }
    await this.validate(targetBinding(target), target.workspace.canonicalPath);
    const bundle: ChangeBundle = { version: 1, profileId: this.profileId, sessionId, target: targetBinding(target), source: target.source, manifestHash: target.manifestHash, changes };
    const bytes = Buffer.from(JSON.stringify(bundle));
    const staging = join(this.artifactRoot, "staging"); await mkdir(staging, { recursive: true, mode: 0o700 });
    if (lstatSync(staging).isSymbolicLink()) throw new Error("Artifact staging cannot be a symlink.");
    const capturePath = join(staging, randomUUID()); await writeFile(capturePath, bytes, { flag: "wx", mode: 0o600 });
    try {
      return await this.artifacts.retainSessionArtifact({ sessionId, profileId: this.profileId, capturePath, kind: "data", bytes: bytes.length,
        provenance: { target: { targetId: target.id, targetGeneration: target.generation }, ...(target.source.registeredWorkspaceId ? { sourceWorkspaceId: target.source.registeredWorkspaceId } : {}) },
        mimeType: "application/json", sha256: hash(bytes), summary: `${changes.length} workspace changes; source files are unchanged.`,
        source: { kind: "workspace.changes", filename: "workspace-changes.json", origin: `workspace:${target.id}`, description: "Temporary-copy changes with source baseline" },
        persist: async (registration) => {
          this.transaction(() => this.db.query("insert into workspace_change_artifacts values (?, ?)").run(registration.id, JSON.stringify(registration)));
          await persist?.(registration);
        } });
    } finally { await rm(capturePath, { force: true }); }
  }
  async load(id: string): Promise<{ artifact: ArtifactRecord; bundle: ChangeBundle; target: TemporaryCopyTarget }> {
    const row = this.db.query<{ record_json: string }>("select record_json from workspace_change_artifacts where id=?").get(id);
    if (!row) throw new Error("Change artifact not found in the selected profile.");
    const registration = JSON.parse(row.record_json) as SessionArtifactRegistration;
    if (registration.source.kind !== "workspace.changes" || registration.profileId !== this.profileId || registration.bytes > 96 * 1024 * 1024) throw new Error("Invalid change artifact registration.");
    const [artifact] = await this.artifacts.hydrateSessionArtifacts({ events: [{ kind: "session-artifact-registered", artifact: registration }], sessionId: registration.sessionId, profileId: this.profileId });
    if (!artifact?.localPath) throw new Error("Change artifact is missing or was altered.");
    const content = readFileSync(artifact.localPath);
    if (hash(content) !== registration.sha256) throw new Error("Change artifact was altered during inspection.");
    const bundle = JSON.parse(content.toString("utf8")) as ChangeBundle;
    const target = this.getTarget(bundle.target?.targetId);
    if (target?.kind !== "temporary-copy" || bundle.version !== 1 || bundle.profileId !== this.profileId || bundle.sessionId !== registration.sessionId ||
      registration.source.origin !== `workspace:${target.id}` || bundle.manifestHash !== target.manifestHash ||
      JSON.stringify(bundle.source) !== JSON.stringify(target.source) || JSON.stringify(bundle.target) !== JSON.stringify(targetBinding(target)) ||
      !Array.isArray(bundle.changes) || bundle.changes.length > COPY_LIMITS.files) throw new Error("Change artifact provenance does not match its source target.");
    const entries = new Map(this.copyManifest(target.id).entries.map((entry) => [entry.path, entry]));
    const seen = new Set<string>(); let bytes = 0;
    for (const change of bundle.changes) {
      copyPath(change.path); validateSnapshot(change.before); validateSnapshot(change.after);
      const entry = entries.get(change.path);
      if (seen.has(change.path) || entry?.origin === "dependency" || change.path.split("/").includes("node_modules") ||
        !sameFile(change.before, entry?.baseline ?? null) || sameFile(change.before, change.after) ||
        change.operation !== (change.before === null ? "create" : change.after === null ? "delete" : "update")) throw new Error("Invalid change operation or source baseline.");
      bytes += change.after ? Buffer.from(change.after.content, "base64").length : 0; seen.add(change.path);
    }
    if (bytes > COPY_LIMITS.totalBytes) throw new Error("Change artifact exceeds its limit.");
    return { artifact, bundle, target };
  }
}
