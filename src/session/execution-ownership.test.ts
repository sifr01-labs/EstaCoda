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

it("fences authoritative writes after an await without holding a transaction across I/O", async () => {
  const { withExecutionFence } = await import("./execution-fence-context.js");
  const owner = new SessionExecutionOwnership(db.db);
  const claim = owner.claim(input);
  let resume!: () => void;
  const barrier = new Promise<void>((resolve) => { resume = resolve; });
  const staleWrite = withExecutionFence(db.db, claim, async () => {
    await barrier;
    await db.appendMessage({ sessionId: input.sessionId, role: "agent", content: "stale result" });
  });
  owner.release(claim);
  new SessionExecutionOwnership(other.db).claim(input);
  resume();
  await expect(staleWrite).rejects.toThrow("fence");
  expect(await db.listMessages(input.sessionId)).toHaveLength(0);
});

it("excludes an independent process and permits recovery only after its confirmed exit", async () => {
  const { fork } = await import("node:child_process");
  const { writeFile } = await import("node:fs/promises");
  const { pathToFileURL } = await import("node:url");
  const { resolve } = await import("node:path");
  const script = join(root, "owner.mjs");
  await writeFile(script, `
    import { SQLiteSessionDB } from ${JSON.stringify(pathToFileURL(resolve("src/session/sqlite-session-db.ts")).href)};
    import { SessionExecutionOwnership } from ${JSON.stringify(pathToFileURL(resolve("src/session/execution-ownership.ts")).href)};
    const db = new SQLiteSessionDB({ path: process.argv[2] });
    const owner = new SessionExecutionOwnership(db.db);
    process.on('message', (input) => { const claim = owner.claim(input); process.send({ fence: claim.fence }); });
  `);
  const child = fork(script, [join(root, "sessions.sqlite")], { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  try {
    const claimed = new Promise<{ fence: number }>((resolve, reject) => { child.once("message", (value) => resolve(value as { fence: number })); child.once("error", reject); });
    child.send(input);
    const first = await claimed;
    const contender = new SessionExecutionOwnership(db.db);
    db.db.exec("update session_execution_owners set expires_at = 0");
    expect(() => contender.claim(input)).toThrow("busy");
    child.kill("SIGKILL"); await exited;
    const recovered = contender.claim(input);
    expect(recovered.fence).toBe(first.fence + 1);
    contender.release(recovered);
  } finally { child.kill("SIGKILL"); await exited; }
}, 10_000);
