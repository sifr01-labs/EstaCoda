import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import { ExecutionTargetStore, parseExecutionTargetBinding, targetBinding } from "./execution-target.js";

let homeDir: string;
let targets: ExecutionTargetStore;
let sessions: SQLiteSessionDB;
beforeEach(async () => {
  homeDir = await mkdtemp(join(tmpdir(), "execution-target-"));
  targets = new ExecutionTargetStore({ homeDir, profileId: "default" });
  sessions = new SQLiteSessionDB({ path: join(homeDir, "sessions.sqlite") });
});
afterEach(async () => { sessions.close(); targets.close(); await rm(homeDir, { recursive: true, force: true }); });

it("reuses verified local targets, preserving named source snapshots across rename and move", async () => {
  const workspace = await targets.add("project", homeDir);
  const source = { identity: workspace.identity, registeredWorkspaceId: workspace.id, registeredWorkspaceRevision: 1 };
  const first = await targets.acquireLocal(homeDir, source);
  targets.rename("project", "renamed");
  expect(await targets.acquireLocal(homeDir, source)).toEqual(first);
  await mkdir(join(homeDir, "next"));
  const moved = await targets.move(workspace.id, join(homeDir, "next"), 1);
  await expect(targets.acquireLocal(homeDir, source)).rejects.toThrow("moved");
  const next = await targets.acquireLocal(moved.identity.canonicalPath, {
    identity: moved.identity, registeredWorkspaceId: moved.id, registeredWorkspaceRevision: moved.locationRevision,
  });
  expect(next.id).not.toBe(first.id);
  expect(targets.getTarget(first.id)).toEqual(first);
  await expect(targets.validate(targetBinding(first), moved.identity.canonicalPath)).rejects.toThrow("different workspace");
  targets.remove(moved.id);
  expect(targets.getTarget(first.id)).toEqual(first);
});

it("persists immutable session bindings, inherits them to children and rejects wrong roots and versions", async () => {
  const binding = targetBinding(await targets.acquireLocal(homeDir));
  await sessions.createSession({ id: "one", profileId: "default", executionTarget: binding });
  expect((await sessions.getSession("one"))?.executionTarget).toEqual(binding);
  expect((await sessions.createSession({ id: "child", profileId: "default", parentSessionId: "one" })).executionTarget).toEqual(binding);
  expect(() => sessions.db.query("update sessions set execution_target_json = null where id = 'one'").run()).toThrow("immutable");
  expect(() => sessions.db.query("update sessions set metadata_json = '{}' where id = 'one'").run()).toThrow("immutable");
  await expect(sessions.createSession({ id: "wrong", profileId: "default", executionTarget: binding, metadata: { workspaceRoot: "/wrong" } })).rejects.toThrow("does not match");
  expect(() => parseExecutionTargetBinding({ ...binding, schemaVersion: 99 })).toThrow("unsupported");
  const other = new ExecutionTargetStore({ homeDir, profileId: "other" });
  try { await expect(other.validate(binding, homeDir)).rejects.toThrow("another profile"); } finally { other.close(); }
});
it("rejects unknown persisted versions without changing stored ownership", async () => {
  const binding = targetBinding(await targets.acquireLocal(homeDir));
  await sessions.createSession({ id: "future", profileId: "default", executionTarget: binding });
  // Simulate a newer writer; unknown database versions cannot be opened by this binary.
  sessions.db.query("insert into schema_version (version) values (?)").run(99);
  expect(() => new SQLiteSessionDB({ path: join(homeDir, "sessions.sqlite") })).toThrow(/newer|unsupported|Unsupported/);
  expect((await sessions.getSession("future"))?.executionTarget).toEqual(binding);
});
