import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ExecutionTargetStore } from "./execution-target.js";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";

let homeDir: string;
beforeEach(async () => { homeDir = await mkdtemp(join(tmpdir(), "workspace-processes-")); });
afterEach(async () => { await rm(homeDir, { recursive: true, force: true }); });

// Each participant loads its modules, then waits at a common stdin barrier.
// A process timeout bounds failures; no child can survive the test indefinitely.
async function race(operations: string[]): Promise<Array<{ ok: boolean; value?: unknown; error?: string }>> {
  const children = operations.map((operation) => {
    const code = `
      import { ExecutionTargetStore } from ${JSON.stringify(new URL("./execution-target.ts", import.meta.url).href)};
      import { SQLiteSessionDB } from ${JSON.stringify(new URL("../session/sqlite-session-db.ts", import.meta.url).href)};
      import { ensureRuntimeSession } from ${JSON.stringify(new URL("../session/session-workspace-ownership.ts", import.meta.url).href)};
      const homeDir = ${JSON.stringify(homeDir)};
      const start = new Promise(resolve => process.stdin.once('data', resolve));
      process.stdout.write('ready\\n');
      await start;
      try { const value = await (async () => { ${operation} })(); console.log(JSON.stringify({ok: true, value})); }
      catch (error) { console.log(JSON.stringify({ok: false, error: error.message})); }
      process.stdin.destroy();
    `;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
      cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"], timeout: 15_000,
    });
    let output = ""; let errors = "";
    const ready = new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (chunk) => { output += String(chunk); if (output.includes("ready\n")) resolve(); });
      child.once("error", reject);
      child.once("close", () => { if (!output.includes("ready\n")) reject(new Error(errors || "Child exited before barrier")); });
    });
    child.stderr.on("data", (chunk) => { errors += String(chunk); });
    const result = new Promise<{ ok: boolean; value?: unknown; error?: string }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => {
        if (code !== 0) { reject(new Error(errors || `Child exited ${code}`)); return; }
        try { resolve(JSON.parse(output.trim().split("\n").at(-1)!)); } catch (error) { reject(error); }
      });
    });
    return { child, ready, result };
  });
  // Observe all results immediately, including a startup failure before the barrier.
  const results = Promise.all(children.map(({ result }) => result));
  try {
    await Promise.all(children.map(({ ready }) => ready));
    for (const { child } of children) child.stdin.end("go\n");
    return await results;
  } catch (error) {
    for (const { child } of children) child.kill();
    await results.catch(() => undefined);
    throw error;
  }
}

it("serializes aliases, location revisions and target acquisition across independent processes", async () => {
  const store = new ExecutionTargetStore({ homeDir, profileId: "default" });
  try {
    const add = (alias: string) => `const store = new ExecutionTargetStore({homeDir, profileId:'default'}); try {return await store.add('${alias}', homeDir);} finally {store.close();}`;
    const added = await race([add("one"), add("two"), add("same"), add("same")]);
    expect(added.filter((result) => result.ok)).toHaveLength(3);
    expect(added.find((result) => !result.ok)?.error).toContain("already exists");
    expect(store.list().map((row) => row.alias)).toEqual(["one", "same", "two"]);
    await mkdir(join(homeDir, "a")); await mkdir(join(homeDir, "b"));
    const moved = await race(["a", "b"].map((dir) => `const store = new ExecutionTargetStore({homeDir, profileId:'default'}); try {return await store.move('one', homeDir+'/${dir}', 1);} finally {store.close();}`));
    expect(moved.filter((result) => result.ok)).toHaveLength(1);
    expect(moved.find((result) => !result.ok)?.error).toContain("revision changed");
    expect(store.get("one")?.locationRevision).toBe(2);
    const acquire = `const store = new ExecutionTargetStore({homeDir, profileId:'default'}); try {return (await store.acquireLocal(homeDir)).id;} finally {store.close();}`;
    const targets = await race([acquire, acquire]);
    expect(targets.every((result) => result.ok)).toBe(true);
    expect(new Set(targets.map((result) => result.value)).size).toBe(1);
  } finally { store.close(); }
}, 30_000);

it("allows only one workspace to bind a new Session across processes and survives reopen", async () => {
  await mkdir(join(homeDir, "a")); await mkdir(join(homeDir, "b"));
  const path = join(homeDir, "sessions.sqlite");
  new SQLiteSessionDB({ path }).close();
  const results = await race(["a", "b"].map((dir) => `const sessionDb = new SQLiteSessionDB({path:homeDir+'/sessions.sqlite'}); try {
    await ensureRuntimeSession({sessionDb, homeDir, profileId:'default', sessionId:'shared', workspaceRoot:homeDir+'/${dir}', durable:true});
    return (await sessionDb.getSession('shared')).executionTarget;
  } finally {sessionDb.close();}`));
  expect(results.filter((result) => result.ok)).toHaveLength(1);
  expect(results.find((result) => !result.ok)?.error).toMatch(/different workspace|another execution target/);
  const db = new SQLiteSessionDB({ path });
  try { expect((await db.getSession("shared"))?.executionTarget).toEqual(results.find((result) => result.ok)?.value); }
  finally { db.close(); }
}, 30_000);
