import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { SQLiteSessionDB } from "./sqlite-session-db.js";
import { ensureRuntimeSession, validateSessionWorkspaceOwnership } from "./session-workspace-ownership.js";
import { ExecutionTargetStore } from "../workspaces/execution-target.js";

let root: string;
let db: SQLiteSessionDB;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "session-ownership-"));
  await mkdir(join(root, "one")); await mkdir(join(root, "two"));
  db = new SQLiteSessionDB({ path: join(root, "sessions.sqlite") });
});
afterEach(async () => { db.close(); await rm(root, { recursive: true, force: true }); });
const input = () => ({ homeDir: root, sessionDb: db, sessionId: "session", profileId: "default", workspaceRoot: join(root, "one"), durable: true });

it("creates a recoverable target reference and rejects cross-workspace/profile construction", async () => {
  await ensureRuntimeSession(input());
  const original = await db.getSession("session");
  expect(original?.executionTarget?.schemaVersion).toBe(1);
  await ensureRuntimeSession(input());
  await expect(ensureRuntimeSession({ ...input(), workspaceRoot: join(root, "two") })).rejects.toThrow("different workspace");
  await expect(ensureRuntimeSession({ ...input(), profileId: "other" })).rejects.toThrow("different profile");
  expect(await db.getSession("session")).toEqual(original);
});

it("binds an established legacy root, allowing rootless local adoption only through the explicit local flow", async () => {
  await db.createSession({ id: "session", profileId: "default", metadata: { workspaceRoot: join(root, "one") } });
  await ensureRuntimeSession(input());
  expect((await db.getSession("session"))?.executionTarget).toBeDefined();
  await db.createSession({ id: "local", profileId: "default", metadata: { originSurface: "cli" } });
  await expect(ensureRuntimeSession({ ...input(), sessionId: "local" })).rejects.toThrow("ambiguous");
  await ensureRuntimeSession({ ...input(), sessionId: "local", allowLegacyLocalBinding: true });
  await db.createSession({ id: "remote", profileId: "default", metadata: { originSurface: "telegram" } });
  await expect(ensureRuntimeSession({ ...input(), sessionId: "remote", allowLegacyLocalBinding: true })).rejects.toThrow("ambiguous");
  expect((await db.getSession("remote"))?.executionTarget).toBeUndefined();
});

it("retains named source provenance after alias removal and rejects missing targets", async () => {
  const targets = new ExecutionTargetStore({ homeDir: root, profileId: "default" });
  try {
    const workspace = await targets.add("project", join(root, "one"));
    await ensureRuntimeSession({ ...input(), sourceWorkspace: { identity: workspace.identity, registeredWorkspaceId: workspace.id, registeredWorkspaceRevision: 1 } });
    const session = (await db.getSession("session"))!;
    targets.remove(workspace.id);
    await validateSessionWorkspaceOwnership({ ...input(), session });
    expect(targets.getTarget(session.executionTarget!.targetId)?.source.registeredWorkspaceId).toBe(workspace.id);
    await expect(validateSessionWorkspaceOwnership({ ...input(), session: { ...session, executionTarget: { ...session.executionTarget!, targetGeneration: 2 } } })).rejects.toThrow("stale");
  } finally { targets.close(); }
});

it("does not rebind competing creations or accept stale migration snapshots", async () => {
  const results = await Promise.allSettled([ensureRuntimeSession(input()), ensureRuntimeSession({ ...input(), workspaceRoot: join(root, "two") })]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  const session = (await db.getSession("session"))!;
  await db.createSession({ id: "legacy", profileId: "default", metadata: { workspaceRoot: join(root, "one") } });
  await expect(db.bindSessionExecutionTarget({ sessionId: "legacy", profileId: "default", binding: session.executionTarget!, expectedMetadata: {} })).rejects.toThrow("changed");
});

it("persists legacy canonical aliases across reopen and refuses conflicting metadata", async () => {
  const alias = join(root, "alias");
  await symlink(join(root, "one"), alias);
  await db.createSession({ id: "session", profileId: "default", metadata: { workspaceDirectory: alias, projectRoot: join(root, "one"), custom: "retained" } });
  await ensureRuntimeSession(input());
  const original = await db.getSession("session");
  db.close(); db = new SQLiteSessionDB({ path: join(root, "sessions.sqlite") });
  await ensureRuntimeSession({ ...input(), workspaceRoot: alias });
  expect(await db.getSession("session")).toEqual(original);
  expect(original?.metadata).toEqual({ workspaceRoot: original?.executionTarget?.workspace.canonicalPath, custom: "retained" });
  for (const metadata of [{ workspaceRoot: join(root, "one"), projectRoot: join(root, "two") }, { workspaceRoot: 4, originSurface: "cli" }]) {
    const session = await db.createSession({ profileId: "default", metadata });
    await expect(ensureRuntimeSession({ ...input(), sessionId: session.id, allowLegacyLocalBinding: true })).rejects.toThrow("different workspace");
    expect((await db.getSession(session.id))?.executionTarget).toBeUndefined();
  }
});
