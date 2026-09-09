import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { SQLiteSessionDB } from "./sqlite-session-db.js";
import { ensureRuntimeSession } from "./session-workspace-ownership.js";
import { SessionExecutionOwnership } from "./execution-ownership.js";

let root: string, db: SQLiteSessionDB, other: SQLiteSessionDB;
let input: { sessionId: string; profileId: string; targetId: string };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "execution-owner-"));
  db = new SQLiteSessionDB({ path: join(root, "sessions.sqlite") });
  await ensureRuntimeSession({ sessionDb: db, sessionId: "session", profileId: "default", workspaceRoot: root, homeDir: root, durable: true });
  input = { sessionId: "session", profileId: "default", targetId: (await db.getSession("session"))!.executionTarget!.targetId };
  other = new SQLiteSessionDB({ path: join(root, "sessions.sqlite") });
});
afterEach(async () => { other.close(); db.close(); await rm(root, { recursive: true, force: true }); });
it("atomically excludes a second connection even after heartbeat expiry", () => {
  const owner = new SessionExecutionOwnership(db.db), contender = new SessionExecutionOwnership(other.db);
  const claim = owner.claim(input);
  db.db.exec("update session_execution_owners set expires_at = 0, heartbeat_at = 0");
  expect(() => contender.claim(input)).toThrow("busy");
  owner.renew(claim); owner.advance(claim, "turn"); owner.advance(claim, "control");
  owner.release(claim);
  const successor = contender.claim(input);
  expect(successor.fence).toBe(claim.fence + 1);
  for (const operation of [() => owner.assert(claim), () => owner.renew(claim), () => owner.release(claim), () => owner.advance(claim, "turn")]) {
    expect(operation).toThrow("lost");
  }
  contender.assert(successor);
});
it("rejects cross-profile and cross-target requests before ownership writes", () => {
  const owner = new SessionExecutionOwnership(db.db);
  expect(() => owner.claim({ ...input, profileId: "other" })).toThrow("match");
  expect(() => owner.claim({ ...input, targetId: "other" })).toThrow("match");
  expect(db.db.query<{ count: number }>("select count(*) as count from session_execution_owners").get()!.count).toBe(0);
});
it("keeps unknown or reused live PID evidence busy across reopen", () => {
  const owner = new SessionExecutionOwnership(db.db);
  owner.claim(input);
  db.db.exec("update session_execution_owners set owner_pid = 0, expires_at = 0");
  expect(() => new SessionExecutionOwnership(other.db).claim(input)).toThrow("busy");
});
