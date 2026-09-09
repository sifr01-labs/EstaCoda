import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { expect, it } from "vitest";
import { WorkspaceApprovalStore } from "./workspace-approval-controller.js";
import { readApprovalFile } from "./approval-file.js";

const storeUrl = new URL("./workspace-approval-controller.ts", import.meta.url).href;
const scopeUrl = new URL("./approval-scope.ts", import.meta.url).href;
const hostUrl = new URL("../execution/host-authority.ts", import.meta.url).href;
function child(script: string, args: string[] = []) {
  return spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
}
async function completion(process: ReturnType<typeof child>) {
  let errors = "";
  process.stderr.on("data", (chunk) => { errors += chunk; });
  const [code] = await once(process, "exit");
  if (code !== 0) throw new Error(errors || `Child exited with ${code}`);
}
it("serializes competing process writers without losing grants or reusing generations", async () => {
  const root = await mkdtemp(join(tmpdir(), "approval-processes-"));
  const processes: ReturnType<typeof child>[] = [];
  try {
    const path = join(root, "approvals.json");
    const script = `
      import { WorkspaceApprovalStore } from ${JSON.stringify(storeUrl)};
      import { localApprovalScope } from ${JSON.stringify(scopeUrl)};
      import { verifyHostExecution } from ${JSON.stringify(hostUrl)};
      const [path, root, prefix] = process.argv.slice(1);
      const store = new WorkspaceApprovalStore({ path });
      const executionScope = localApprovalScope("test", "session", await verifyHostExecution(root));
      for (let i = 0; i < 12; i++) await store.grant({ workspaceRoot: root, toolName: "file.write", riskClass: "workspace-write", targetKey: prefix + i, executionScope });
    `;
    await Promise.all(Array.from({ length: 4 }, (_, index) => {
      const running = child(script, [path, root, `writer-${index}-`]); processes.push(running); return completion(running);
    }));
    const store = new WorkspaceApprovalStore({ path });
    const grants = await store.listForWorkspace(root);
    expect(grants).toHaveLength(48);
    expect(store.revision()).toBe(48);
    expect(new Set(grants.map((grant) => grant.authorizationGeneration)).size).toBe(48);
    expect(JSON.parse(await readFile(path, "utf8")).version).toBe(2);
  } finally {
    for (const process of processes) if (process.exitCode === null) process.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

it("releases the write mutex when its owner process dies", async () => {
  const root = await mkdtemp(join(tmpdir(), "approval-dead-owner-"));
  let running: ReturnType<typeof child> | undefined;
  try {
    const path = join(root, "approvals.json");
    running = child(`
      import { openDefaultSQLiteDatabase } from ${JSON.stringify(new URL("../storage/factory.ts", import.meta.url).href)};
      const db = openDefaultSQLiteDatabase({ path: process.argv[1] });
      db.exec("begin immediate");
      process.stdout.write("locked");
      setInterval(() => {}, 1000);
    `, [path + ".lock.sqlite"]);
    await once(running.stdout, "data");
    const exited = once(running, "exit"); running.kill("SIGKILL"); await exited;
    const store = new WorkspaceApprovalStore({ path });
    await expect(store.grant({ workspaceRoot: root, toolName: "file.write", riskClass: "workspace-write" })).resolves.toHaveProperty("authorizationGeneration", 1);
  } finally { running?.kill("SIGKILL"); await rm(root, { recursive: true, force: true }); }
}, 10_000);

it("fails closed on unknown versions and dangling lock symlinks; version-one fields never confer authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "approval-format-"));
  try {
    const path = join(root, "approvals.json");
    await writeFile(path, JSON.stringify({ version: 99, grants: [] }));
    expect(() => readApprovalFile(path, (_): _ is unknown => true)).toThrow(/Unsupported/);
    await writeFile(path, JSON.stringify({ version: 1, grants: [{ id: "legacy", executionScope: {}, authorizationGeneration: 50 }] }));
    expect(readApprovalFile(path, (_): _ is unknown => true)).toEqual({ version: 2, revision: 0, grants: [{ id: "legacy" }] });
    await symlink(join(root, "missing-target"), path + ".lock.sqlite");
    const store = new WorkspaceApprovalStore({ path });
    await expect(store.grant({ workspaceRoot: root, toolName: "file.write", riskClass: "workspace-write" })).rejects.toThrow(/symbolic link/);
    await expect(readFile(join(root, "missing-target"))).rejects.toHaveProperty("code", "ENOENT");
  } finally { await rm(root, { recursive: true, force: true }); }
});
