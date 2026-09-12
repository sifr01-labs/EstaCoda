import {validateDockerWorktree} from './docker-worktree-workflow.js';
import { validateDockerRuntimeWorkflows } from "./docker-runtime-workflows.js";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExecutionLease } from "../src/execution/host-environment.js";
import type { RequestedExecutionPolicy } from "../src/contracts/execution-authority.js";
const runtimeRoot = process.argv.includes("--dist") ? "../dist" : "../src";
const { prepareTemporaryCopy } = await import(new URL(`${runtimeRoot}/workspaces/temporary-copy.js`, import.meta.url).href);
const { ChangeApplicationStore } = await import(new URL(`${runtimeRoot}/workspaces/change-application.js`, import.meta.url).href);
const { HostWorkspaceFiles } = await import(new URL(`${runtimeRoot}/execution/host-workspace-files.js`, import.meta.url).href);
const { ToolRegistry } = await import(new URL(`${runtimeRoot}/tools/tool-registry.js`, import.meta.url).href);
const { ToolExecutor } = await import(new URL(`${runtimeRoot}/tools/tool-executor.js`, import.meta.url).href);
const { InMemorySessionDB } = await import(new URL(`${runtimeRoot}/session/in-memory-session-db.js`, import.meta.url).href);
const { TrajectoryRecorder } = await import(new URL(`${runtimeRoot}/trajectory/trajectory-recorder.js`, import.meta.url).href);
const { dockerToolAdmissionGuard } = await import(new URL(`${runtimeRoot}/execution/docker-tool-boundary.js`, import.meta.url).href);
const { DockerClient, probeDocker } = await import(new URL(`${runtimeRoot}/execution/docker-client.js`, import.meta.url).href);
const { DockerContainer } = await import(new URL(`${runtimeRoot}/execution/docker-container.js`, import.meta.url).href);
const { DockerProcessScope } = await import(new URL(`${runtimeRoot}/execution/docker-processes.js`, import.meta.url).href);
const { DockerWorkspaceFiles } = await import(new URL(`${runtimeRoot}/execution/docker-workspace-files.js`, import.meta.url).href);
const { HostEnvironment } = await import(new URL(`${runtimeRoot}/execution/host-environment.js`, import.meta.url).href);
const { createWorkspaceTools } = await import(new URL(`${runtimeRoot}/tools/workspace-tools.js`, import.meta.url).href);
const { createExecuteCodeTool } = await import(new URL(`${runtimeRoot}/tools/execute-code-tool.js`, import.meta.url).href);
const { createGrepTools } = await import(new URL(`${runtimeRoot}/tools/grep-tools.js`, import.meta.url).href);
const { createGlobTools } = await import(new URL(`${runtimeRoot}/tools/glob-tools.js`, import.meta.url).href);
const { createNotebookTools } = await import(new URL(`${runtimeRoot}/tools/notebook-tools.js`, import.meta.url).href);
const { createPythonTools } = await import(new URL(`${runtimeRoot}/tools/python-tools.js`, import.meta.url).href);
const { ProcessManager } = await import(new URL(`${runtimeRoot}/process/process-manager.js`, import.meta.url).href);
const { executionAuthorityFingerprint } = await import(new URL(`${runtimeRoot}/execution/execution-authority.js`, import.meta.url).href);
// This gate intentionally has no skip path and never downloads an image.
const client = await DockerClient.connect();
const probe = await probeDocker(client);
assert(probe.available && probe.imageId, "Docker gate requires Linux/cgroup v2/seccomp and the explicitly prepared estacoda-execution:v1 image.");
const parent = resolve(process.argv.slice(2).find((arg) => arg !== "--dist") ?? process.cwd());
const root = await mkdtemp(join(parent, ".estacoda-docker-test-"));
const copyRoot = `${root}-copy`;
const home = await mkdtemp(join(tmpdir(), "estacoda-docker-gate-home-"));
const profileId = "docker-gate";
const policy: RequestedExecutionPolicy = { backend: "docker", imageId: probe.imageId };
async function prepared(request: RequestedExecutionPolicy = policy, workspaceRoot = root) {
  const acquisitionStart = performance.now();
  const container = await DockerContainer.prepare({ client, profileId, workspaceRoot, homeDir: home, policy: request });
  const environment = HostEnvironment.prepared(profileId, container.facts, {
    files: (active, processes) => new DockerWorkspaceFiles(container, active, processes, home),
    processes: () => new DockerProcessScope(container, home), dispose: () => container.release()
  });
  const acquisitionMs = performance.now() - acquisitionStart;
  if (acquisitionMs > 60_000) await environment.destroy();
  assert(acquisitionMs <= 60_000, "Docker cold acquisition exceeded the 60s fixture budget");
  console.log(`MEASURE: Docker cold acquisition ${Math.round(acquisitionMs)}ms`);
  const lease = environment.acquire({ profileId, sessionId: "gate", surface: "test" });
  return { container, environment, lease, async close() { await lease.release(); await environment.destroy(); } };
}
async function command(lease: ExecutionLease, program: string, args: string[]) {
  const child = lease.processes.spawn(program, args); let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
  const code = await new Promise((accept, reject) => { child.once("error", reject); child.once("close", accept); });
  await lease.processes.terminate(child);
  return { code, stdout, stderr };
}
try {
  await validateDockerWorktree(runtimeRoot,parent,client,policy);
  await writeFile(join(root, "example.txt"), "selected needle مرحبا\n");
  await writeFile(join(root, "example.ipynb"), JSON.stringify({ cells: [{ id: "one", cell_type: "markdown", source: "old" }], metadata: {}, nbformat: 4, nbformat_minor: 5 }));
  await symlink("/etc/shadow", join(root, "escape"));
  const writable = await prepared();
  const fingerprint = executionAuthorityFingerprint(writable.container.facts);
  try {
    const lease = writable.lease, options = { workspaceRoot: "/unselected-view", executionLease: lease };
    const tools = createWorkspaceTools(options), tool = (name: string) => tools.find((entry) => entry.name === name)!;
    assert.equal((await tool("file.read").run({ path: "example.txt" })).ok, true);
    const payload = Buffer.alloc(8 * 1024 * 1024, "x");
    await writeFile(join(root, "large.bin"), payload);
    assert.deepEqual(await lease.files.readFile("large.bin"), await new HostWorkspaceFiles(root).readFile("large.bin"));
    await writeFile(join(root, "oversized.bin"), Buffer.alloc(payload.length + 1));
    await assert.rejects(lease.files.readFile("oversized.bin"), /8 MiB/);
    await lease.files.rm("oversized.bin");
    let creations = 0;
    const originalRun = client.run.bind(client);
    client.run = async (args, timeout) => { if (args[0] === "create") creations++; return originalRun(args, timeout); };
    const start = performance.now();
    try { for (let i = 0; i < 3; i++) assert.deepEqual(await lease.files.readFile("large.bin"), payload); }
    finally { client.run = originalRun; }
    assert.equal(creations, 0, "Warm file reads must reuse their owned container");
    assert(performance.now() - start <= 30_000, "Docker warm read fixture exceeded the 30s budget");
    console.log(`PASS: 8 MiB Host/Docker parity; three warm reads ${Math.round(performance.now() - start)}ms, zero new containers`);
    assert.equal((await lease.files.resolvePath("escape")).ok, false);
    assert.equal((await lease.files.resolvePath("../outside")).ok, false);
    await lease.files.writeFile("new.txt", "مرحبا"); assert.equal(await lease.files.readFile("new.txt", "utf8"), "مرحبا");
    await lease.files.rename("new.txt", "renamed.txt"); await lease.files.rm("renamed.txt");
    assert((await createGrepTools(options)[0]!.run({ pattern: "needle" })).content.includes("selected needle"));
    assert((await createGlobTools(options)[0]!.run({ pattern: "*.txt" })).content.includes("example.txt"));
    assert.equal((await createNotebookTools(options)[0]!.run({ notebook_path: "example.ipynb", cell_id: "one", new_source: "new" })).ok, true);
    assert.equal(JSON.parse(await readFile(join(root, "example.ipynb"), "utf8")).cells[0].source, "new");
    assert((await createPythonTools(options).find((entry) => entry.name === "document.probe")!.run({ path: "example.txt" })).content.includes("selected needle"));
    const shell = await tool("terminal.run").run({ command: "printf shell-parity" }); assert(shell.ok, shell.content);
    const inspection = await tool("terminal.inspect").run({ argv: ["pwd"] }); assert(inspection.ok, inspection.content);
    const registry = new ToolRegistry(); for (const entry of tools) registry.register(entry);
    let hostCalls = 0;
    registry.register({ name: "host.network", description: "test host boundary", inputSchema: { type: "object", properties: {} }, riskClass: "read-only-network", toolsets: ["web"], progressLabel: "test", maxResultSizeChars: 100, isAvailable: () => true, run: async () => { hostCalls++; return { ok: true, content: "host" }; } });
    const sessionDb = new InMemorySessionDB(); await sessionDb.createSession({ id: "gate", profileId });
    const trajectoryRecorder = new TrajectoryRecorder({ profileId, sessionId: "gate", modelId: "test" });
    const toolExecutor = new ToolExecutor({ registry, sessionDb, trajectoryRecorder, workspaceRoot: root, profileId, securityPolicy: { decide: () => "allow" }, executionAdmissionGuard: dockerToolAdmissionGuard });
    const harness = createExecuteCodeTool({ ...options, toolExecutor, sessionDb, trajectoryRecorder, sessionId: "gate", trustedWorkspace: async () => true, allowedTools: ["file.read", "host.network"] });
    const code = await harness.run({ code: 'print(open("example.txt").read())' }); assert(code.ok, code.content); assert(code.content.includes("selected needle"));
    const nested = await harness.run({ timeoutMs: 30000, code: 'r=tool("file.read", {"path":"example.txt"})\nassert r["ok"]\nassert not tool("host.network", {})["ok"]\nprint("broker checked")' });
    assert(nested.ok, nested.content); assert(nested.content.includes("broker checked")); assert.equal(hostCalls, 0);
    const fileInspection = await tool("terminal.inspect").run({ argv: ["file", "example.txt"] }); assert(fileInspection.ok, fileInspection.content);
    const isolated = await command(lease, "python3", ["-c", 'import os,socket; assert os.getuid()!=0; assert "OPENAI_API_KEY" not in os.environ; assert not os.path.exists("/var/run/docker.sock"); assert not os.path.exists('+JSON.stringify(home)+'); s=socket.socket(); s.settimeout(1)\ntry: s.connect(("1.1.1.1",443)); raise AssertionError("network escape")\nexcept OSError: pass\nprint("contained")']);
    assert.equal(isolated.code, 0, isolated.stderr); assert(isolated.stdout.includes("contained"));
    console.log("PASS: file, shell, inspection, grep/glob, notebook, worker, code and network containment");
    const child = lease.child({ profileId, sessionId: "independent", surface: "task" });
    assert((await child.files.readFile("example.txt", "utf8")).includes("مرحبا"));
    const sibling = lease.child({ profileId, sessionId: "file-sibling", surface: "task" });
    assert((await sibling.files.readFile("example.txt", "utf8")).includes("مرحبا"));
    await sibling.release();
    assert((await child.files.readFile("example.txt", "utf8")).includes("مرحبا"));
    const manager = new ProcessManager({ ...options });
    try {
      const record = await manager.start("printf managed; sleep 30");
      for (let i = 0; i < 100 && !manager.logs(record.id)?.some((entry) => entry.text.includes("managed")); i++) await new Promise((r) => setTimeout(r, 100));
      assert(manager.logs(record.id)?.some((entry) => entry.text.includes("managed")));
      await manager.stop(record.id); await lease.release();
      assert.equal((await command(child, "sh", ["-c", "echo independent"])).code, 0);
      assert((await child.files.readFile("example.txt", "utf8")).includes("مرحبا"));
    } finally { await manager.dispose(); await child.release(); }
    console.log("PASS: managed process cancellation and independent child scope");
  } finally { await writable.close(); }
  const readonly = await prepared({ ...policy, workspaceAccess: { value: "read-only", requirement: "mandatory" } });
  try {
    assert.notEqual(executionAuthorityFingerprint(readonly.container.facts), fingerprint);
    assert((await readonly.lease.files.readFile("example.txt", "utf8")).includes("مرحبا"));
    await assert.rejects(readonly.lease.files.writeFile("denied.txt", "denied"), /read-only/);
    assert.notEqual((await command(readonly.lease, "sh", ["-c", "echo denied > denied.txt"])).code, 0);
  } finally { await readonly.close(); }
  const limited = await prepared({ ...policy, limits: { requirement: "mandatory", value: { cpu: 0.5, pids: 32, outputBytes: 1024, timeoutMs: 500 } } });
  try {
    assert.equal((await limited.lease.files.readFile("large.bin")).length, 8 * 1024 * 1024);
    assert.equal((await command(limited.lease, "python3", ["-c", "import time; time.sleep(60)"])).code, 124);
    const output = await command(limited.lease, "python3", ["-c", "print('x'*10000)"]); assert.equal(output.code, 124); assert(output.stdout.length <= 1024);
  } finally { await limited.close(); }
  const retryable = await prepared();
  let settlements = 0;
  retryable.container.own({ release: async () => { if (++settlements === 1) throw new Error("transient cleanup failure"); } });
  await assert.rejects(retryable.close(), /did not settle/);
  assert.throws(() => retryable.container.id, /unavailable/);
  assert.throws(() => retryable.container.own({ release: async () => {} }), /unavailable/);
  await retryable.close(); assert.equal(settlements, 2);
  const direct = await prepared({ ...policy, commandNetwork: { requirement: "mandatory", value: "unrestricted" } });
  try { assert.equal(direct.container.facts.networkContainment, false); assert.notEqual(executionAuthorityFingerprint(direct.container.facts), fingerprint); } finally { await direct.close(); }
  const changes = new ChangeApplicationStore({ homeDir: home, profileId });
  try {
    await changes.add("gate-source", root); await changes.trust.grant(root);
    const target = await prepareTemporaryCopy({ homeDir: home, profileId, source: "gate-source", destination: copyRoot, manifest: { version: 1, files: [{ path: "example.txt", origin: "untracked" }] } });
    await changes.authorize(target.id, { version: 1, outcome: "apply", paths: [{ path: "example.txt", operations: ["update"] }] });
    const before = await readFile(join(root, "example.txt"), "utf8"), copy = await prepared(policy, copyRoot);
    try { await copy.lease.files.writeFile("example.txt", "authorized Docker copy مرحبا"); }
    finally { await copy.close(); }
    assert.equal(await readFile(join(root, "example.txt"), "utf8"), before);
    const applied = await changes.finish(target.id, target.id); assert.equal(applied.status, "applied", applied.reason);
    assert.equal(await readFile(join(root, "example.txt"), "utf8"), "authorized Docker copy مرحبا");
    assert.equal((await changes.recover(applied.artifact.id)).status, "review");
    assert.equal(await readFile(join(root, "example.txt"), "utf8"), before);
    console.log("PASS: Docker temporary-copy target, preauthorized application and guarded rollback");
  } finally { changes.close(); }
  await validateDockerRuntimeWorkflows({ runtimeRoot, workspaceRoot: root, homeDir: home, profileId, imageId: probe.imageId, client });
  await assert.rejects(prepared({ ...policy, imageId: `sha256:${"0".repeat(64)}` }));
  assert.equal((await readdir(join(home, ".estacoda", "profiles", profileId, "execution", "docker"))).filter((name) => name.endsWith(".json")).length, 0);
  console.log("PASS: both bind modes, limits, explicit direct network, missing image and settled ownership receipts");
} finally {
  const remaining = await readdir(join(home, ".estacoda", "profiles", profileId, "execution", "docker")).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
  if (remaining.some((name) => name.endsWith(".json"))) throw new Error("Docker gate cleanup is uncertain; temporary workspace and ownership receipts were preserved for inspection.");
  await rm(copyRoot, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); await rm(home, { recursive: true, force: true });
}
