import { createGrepTools } from "../tools/grep-tools.js";
import { createGlobTools } from "../tools/glob-tools.js";
import { createNotebookTools } from "../tools/notebook-tools.js";
import { createPythonTools } from "../tools/python-tools.js";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { HostEnvironment } from "./host-environment.js";
import { createWorkspaceTools } from "../tools/workspace-tools.js";
import { ProcessManager } from "../process/process-manager.js";
import { createExecuteCodeTool } from "../tools/execute-code-tool.js";
import { resolveTestPythonBinary } from "../test/test-python.js";
import type { ToolExecutor } from "../tools/tool-executor.js";
import type { SessionDB } from "../contracts/session.js";
import type { TrajectoryRecorder } from "../trajectory/trajectory-recorder.js";

it("keeps editor observations distinct and blocks all materialized execution until saved", async () => {
  const root = await mkdtemp(join(tmpdir(), "editor-parity-"));
  const environment = await HostEnvironment.create({ profileId: "test", workspaceRoot: root });
  const lease = environment.acquire({ profileId: "test", sessionId: "editor", surface: "acp" });
  const child = lease.child({ profileId: "test", sessionId: "child", surface: "task" });
  const manager = new ProcessManager({ workspaceRoot: "/wrong-view", executionLease: child });
  const path = join(lease.workspaceRoot, "example.txt");
  let editor = "saved\nsecond\n";
  const tools = createWorkspaceTools({ workspaceRoot: "/wrong-view", executionLease: lease,
    fsAdapter: { readTextFile: async () => editor, writeMode: "materialized" } });
  const tool = (name: string) => tools.find((tool) => tool.name === name)!;
  const harness = createExecuteCodeTool({ workspaceRoot: "/wrong-view", executionLease: child,
    toolExecutor: {} as ToolExecutor, sessionDb: {} as SessionDB, trajectoryRecorder: {} as TrajectoryRecorder,
    sessionId: "child", trustedWorkspace: async () => true, pythonBinary: await resolveTestPythonBinary() });
  try {
    await writeFile(path, editor);
    const saved = await tool("file.read").run({ path: "example.txt", lineStart: 2, lineEnd: 2 });
    expect(saved.content).toContain("second"); expect(saved.content).not.toContain("saved");
    expect(saved.metadata).toMatchObject({ contentSource: "editor", materialized: true });
    // The buffer changes after the initial read: dispatch must re-read it.
    editor = "unsaved\nsecond\n";
    expect((await tool("terminal.run").run({ command: "cat example.txt" })).content).toContain("Save or reload");
    expect((await tool("terminal.inspect").run({ argv: ["cat", "example.txt"] })).ok).toBe(false);
    expect((await tool("file.search").run({ query: "saved" })).ok).toBe(false);
    expect((await harness.run({ code: 'print(open("example.txt").read())' })).ok).toBe(false);
    await expect(manager.start("cat example.txt")).rejects.toThrow(/Save or reload/);
    expect((await tool("file.read").run({ path: "example.txt" })).metadata?.materialized).toBe(false);
    await writeFile(path, editor); // Explicit user/editor save materializes the buffer.
    const command = await tool("terminal.run").run({ command: "cat example.txt" });
    expect(command.ok).toBe(true); expect(command.content).toContain("unsaved");
    expect((await harness.run({ code: 'print(open("example.txt").read())' })).content).toContain("unsaved");
    await lease.release(); child.assertActive();
  } finally { await manager.dispose(); await lease.release(); await child.release(); environment.destroy(); await rm(root, { recursive: true, force: true }); }
});

it("preserves multi-file materialized ACP patches and never falls back for a read-only adapter", async () => {
  const root = await mkdtemp(join(tmpdir(), "editor-patch-"));
  const environment = await HostEnvironment.create({ profileId: "test", workspaceRoot: root });
  const lease = environment.acquire({ profileId: "test", sessionId: "editor", surface: "acp" });
  const original = new Map([[join(lease.workspaceRoot, "a.txt"), "alpha\n"], [join(lease.workspaceRoot, "b.txt"), "beta\n"]]);
  const readTextFile = async ({ path }: { path: string }) => {
    const text = original.get(path);
    if (text === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return text;
  };
  try {
    for (const [path, text] of original) await writeFile(path, text);
    const readonly = createWorkspaceTools({ workspaceRoot: root, executionLease: lease, fsAdapter: { readTextFile } });
    await expect(readonly.find((tool) => tool.name === "file.write")!.run({ path: "a.txt", content: "changed", overwrite: true })).rejects.toThrow(/does not support writes/);
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("alpha\n");
    const tools = createWorkspaceTools({ workspaceRoot: root, executionLease: lease, fsAdapter: { readTextFile, writeMode: "materialized" } });
    const patch = await tools.find((tool) => tool.name === "file.patch")!.run({ mode: "patch", patch: "*** Begin Patch\n*** Update File: a.txt\n@@\n-alpha\n+updated alpha\n*** Update File: b.txt\n@@\n-beta\n+updated beta\n*** Add File: nested/new.txt\n+new\n*** End Patch" });
    expect(patch.ok).toBe(true);
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe("updated alpha\n");
    expect(await readFile(join(root, "b.txt"), "utf8")).toBe("updated beta\n");
    expect(await readFile(join(root, "nested/new.txt"), "utf8")).toBe("new\n");
  } finally { await lease.release(); environment.destroy(); await rm(root, { recursive: true, force: true }); }
});

it("routes grep, glob fallback, notebook edits and document workers through the selected view", async () => {
  const root = await mkdtemp(join(tmpdir(), "host-extra-parity-"));
  const environment = await HostEnvironment.create({ profileId: "test", workspaceRoot: root });
  const lease = environment.acquire({ profileId: "test", sessionId: "test", surface: "cli" });
  const options = { workspaceRoot: "/unselected-view", executionLease: lease };
  try {
    await writeFile(join(root, "example.txt"), "selected needle\n");
    await writeFile(join(root, "example.ipynb"), JSON.stringify({ cells: [{ id: "one", cell_type: "markdown", source: "old" }], metadata: {}, nbformat: 4, nbformat_minor: 5 }));
    const glob = createGlobTools({ ...options, rgCommand: "missing-rg-for-host-parity-test" })[0]!;
    expect((await glob.run({ pattern: "*.txt" })).content).toBe("example.txt");
    const grep = createGrepTools(options)[0]!;
    expect((await grep.run({ pattern: "needle" })).content).toContain("selected needle");
    const notebook = createNotebookTools(options)[0]!;
    expect((await notebook.run({ notebook_path: "example.ipynb", cell_id: "one", new_source: "new" })).ok).toBe(true);
    expect(JSON.parse(await readFile(join(root, "example.ipynb"), "utf8")).cells[0].source).toBe("new");
    const probes = createPythonTools(options);
    expect((await probes.find((tool) => tool.name === "document.probe")!.run({ path: "example.txt" })).content).toContain("selected needle");
    await lease.release();
    expect((await glob.run({ pattern: "*.txt" })).ok).toBe(false);
  } finally { await lease.release(); environment.destroy(); await rm(root, { recursive: true, force: true }); }
});
