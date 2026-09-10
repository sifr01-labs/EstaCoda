import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { resolveProfileStateHome } from "../config/profile-home.js";
import type { RegisteredWorkspace, WorkspaceIdentity } from "../contracts/workspace.js";
import { openDefaultSQLiteDatabase } from "../storage/factory.js";
import type { SQLiteDatabase } from "../storage/sqlite.js";
import { resolveWorkspaceIdentity } from "./workspace-identity.js";

type WorkspaceRow = { id: string; profile_id: string; alias: string; path: string; hash: string; revision: number };

export function normalizeWorkspaceAlias(value: string): string {
  const alias = value.toLowerCase();
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(alias)) throw new Error("Workspace aliases must be 1–64 ASCII letters, digits or hyphens, starting with a letter.");
  return alias;
}

export async function resolveWorkspaceDirectory(path: string): Promise<WorkspaceIdentity> {
  const identity = await resolveWorkspaceIdentity(path);
  if (!(await stat(identity.canonicalPath)).isDirectory()) throw new Error("Workspace must be an existing directory.");
  return identity;
}

/** Profile-local core store. SQLite transactions coordinate independent processes;
 * no timestamp-based lock stealing, cross-file read/modify/write, or trust writes. */
export class WorkspaceRegistry {
  readonly profileId: string;
  protected readonly db: SQLiteDatabase;

  constructor(options: { homeDir?: string; profileId: string }) {
    const paths = resolveProfileStateHome(options);
    this.profileId = paths.profileId;
    mkdirSync(paths.profileRoot, { recursive: true, mode: 0o700 });
    const path = join(paths.profileRoot, "workspaces.sqlite");
    try { if (lstatSync(path).isSymbolicLink()) throw new Error("Workspace registry must not be a symbolic link."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    this.db = openDefaultSQLiteDatabase({ path });
    try {
      chmodSync(path, 0o600);
      this.transaction(() => {
        const version = this.db.query<{ user_version: number }>("pragma user_version").get()!.user_version;
        if (version !== 0 && version !== 1 && version !== 2) throw new Error("Unsupported workspace registry version. Upgrade EstaCoda before opening it.");
        this.db.exec(`create table if not exists workspaces (
          id text primary key, profile_id text not null, alias text not null unique,
          path text not null, hash text not null, revision integer not null check(revision > 0)
        ); pragma user_version = ${Math.max(version, 1)};`);
      });
    } catch (error) { this.db.close(); throw error; }
  }

  close(): void { this.db.close(); }

  protected transaction<T>(work: () => T): T {
    this.db.exec("begin immediate");
    try { const result = work(); this.db.exec("commit"); return result; }
    catch (error) { this.db.exec("rollback"); throw error; }
  }

  list(): RegisteredWorkspace[] {
    return this.db.query<WorkspaceRow>("select * from workspaces order by alias").all().map((row) => this.decode(row));
  }

  get(selector: string): RegisteredWorkspace | undefined {
    const key = selector.startsWith("ws_") ? selector : normalizeWorkspaceAlias(selector);
    const row = this.db.query<WorkspaceRow>("select * from workspaces where id = ? or alias = ?").get(key, key);
    return row === null ? undefined : this.decode(row);
  }

  async resolve(selector: string): Promise<RegisteredWorkspace> {
    const workspace = this.require(selector);
    const identity = await resolveWorkspaceDirectory(workspace.identity.canonicalPath);
    if (identity.identityHash !== workspace.identity.identityHash) throw new Error("Workspace location changed; use workspace move and select it explicitly.");
    // An asynchronous filesystem check must not return a concurrently moved record.
    const current = this.require(workspace.id);
    if (current.locationRevision !== workspace.locationRevision) throw new Error("Workspace moved during selection. Select it again.");
    return current;
  }

  async add(alias: string, path: string): Promise<RegisteredWorkspace> {
    const normalized = normalizeWorkspaceAlias(alias);
    const identity = await resolveWorkspaceDirectory(path);
    return this.transaction(() => {
      if (this.get(normalized)) throw new Error("Workspace alias already exists.");
      const id = `ws_${randomUUID()}`;
      this.db.query("insert into workspaces values (?, ?, ?, ?, ?, 1)")
        .run(id, this.profileId, normalized, identity.canonicalPath, identity.identityHash);
      return this.require(id);
    });
  }

  rename(selector: string, alias: string): RegisteredWorkspace {
    const normalized = normalizeWorkspaceAlias(alias);
    return this.transaction(() => {
      const workspace = this.require(selector);
      const collision = this.get(normalized);
      if (collision && collision.id !== workspace.id) throw new Error("Workspace alias already exists.");
      this.db.query("update workspaces set alias = ? where id = ?").run(normalized, workspace.id);
      return this.require(workspace.id);
    });
  }

  async move(selector: string, path: string, expectedRevision: number): Promise<RegisteredWorkspace> {
    const identity = await resolveWorkspaceDirectory(path);
    return this.transaction(() => {
      const workspace = this.require(selector);
      if (workspace.locationRevision !== expectedRevision) throw new Error("Workspace revision changed. Inspect it before retrying the move.");
      if (identity.identityHash !== workspace.identity.identityHash) {
        this.db.query("update workspaces set path = ?, hash = ?, revision = revision + 1 where id = ?")
          .run(identity.canonicalPath, identity.identityHash, workspace.id);
      }
      return this.require(workspace.id);
    });
  }

  remove(selector: string): void {
    this.transaction(() => { this.db.query("delete from workspaces where id = ?").run(this.require(selector).id); });
  }

  protected require(selector: string): RegisteredWorkspace {
    const workspace = this.get(selector);
    if (!workspace) throw new Error("Workspace not found in the selected profile.");
    return workspace;
  }

  private decode(row: WorkspaceRow): RegisteredWorkspace {
    if (row.profile_id !== this.profileId || !Number.isSafeInteger(row.revision) || row.revision < 1) {
      throw new Error("Invalid workspace ownership record.");
    }
    normalizeWorkspaceAlias(row.alias);
    return { schemaVersion: 1, id: row.id, profileId: row.profile_id, alias: row.alias,
      identity: { canonicalPath: row.path, identityHash: row.hash }, locationRevision: row.revision };
  }
}
