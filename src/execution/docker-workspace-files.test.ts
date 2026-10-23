import { expect, it, vi } from "vitest";
import { DockerWorkspaceFiles } from "./docker-workspace-files.js";
import type { DockerContainer } from "./docker-container.js";
it("rejects writes to a read-only Docker view and host/sensitive paths before transport", async () => {
  const spawn = vi.fn();
  const container = { workspace: { canonicalPath: "/project" }, facts: { workspaceAccess: "read-only" }, client: { spawn }, verify: vi.fn() } as unknown as DockerContainer;
  const files = new DockerWorkspaceFiles(container);
  for (const call of [() => files.writeFile("a.txt", "data"), () => files.mkdir("a"), () => files.rm("a"), () => files.rename("a", "b")]) await expect(call()).rejects.toThrow("read-only");
  expect((await files.resolvePath("/etc/passwd")).ok).toBe(false);
  expect((await files.resolvePath("../outside")).ok).toBe(false);
  expect((await files.resolvePath(".env")).ok).toBe(false);
  expect(spawn).not.toHaveBeenCalled();
});
it("does not fall back to host inspection after Docker lease verification fails", async () => {
  const spawn = vi.fn();
  const container = { workspace: { canonicalPath: "/project" }, client: { spawn }, verify: async () => { throw new Error("Docker unavailable"); } } as unknown as DockerContainer;
  const files = new DockerWorkspaceFiles(container);
  expect(await files.resolvePath("a.txt")).toEqual({ ok: false, content: "Docker unavailable" });
  expect(spawn).not.toHaveBeenCalled();
});
it('sends bounded previews through the Docker file scope and never retries against host files',async()=>{
 const workspaceRequest=vi.fn().mockResolvedValue({bytes:Buffer.from('inside').toString('base64'),size:90000});
 const container={workspace:{canonicalPath:'/project'},facts:{workspaceAccess:'read-only'}} as unknown as DockerContainer;
 const files=new DockerWorkspaceFiles(container,()=>{},{workspaceRequest} as any);
 expect(await files.preview('/project/app.txt')).toEqual({bytes:Buffer.from('inside'),size:90000});
 expect(JSON.parse(workspaceRequest.mock.calls[0]![0])).toEqual({root:'/project',op:'preview',path:'/project/app.txt'});
 workspaceRequest.mockRejectedValueOnce(new Error('Docker scope lost'));await expect(files.preview('/project/app.txt')).rejects.toThrow('Docker scope lost');
 await expect(files.preview('/etc/passwd')).rejects.toThrow();expect(workspaceRequest).toHaveBeenCalledTimes(2);
});

it("uses only container metadata for output evidence while retaining sensitive read protections", async () => {
  const workspaceRequest = vi.fn().mockResolvedValue({ kind: "file", ino: 42, size: 1e9, mtimeMs: 1000, ctimeMs: 2000 });
  const container = { workspace: { canonicalPath: "/project" }, facts: { workspaceAccess: "read-only" } } as unknown as DockerContainer;
  const files = new DockerWorkspaceFiles(container, () => {}, { workspaceRequest } as any);
  expect(await files.observeOutput("server.key")).toMatch(/^metadata:[a-f0-9]{64}$/u);
  expect(JSON.parse(workspaceRequest.mock.calls[0]![0])).toEqual({ root: "/project", op: "output-metadata", path: "server.key" });
  for (const path of ["../outside.pt", "/etc/key.pt", "secrets/out.pt", ".ssh/key.pt", ".env"]) await expect(files.observeOutput(path)).rejects.toThrow();
  await expect(files.readFile("server.key")).rejects.toThrow(/sensitive/);
  expect(workspaceRequest).toHaveBeenCalledTimes(1);
  workspaceRequest.mockResolvedValueOnce(null);
  expect(await files.observeOutput("missing.pt")).toBeNull();
  workspaceRequest.mockRejectedValueOnce(new Error("scope lost"));
  await expect(files.observeOutput("model.pt")).rejects.toThrow("scope lost");
});

it("enforces regular-file and containment rules in the container metadata worker", async () => {
  const { mkdtemp, realpath, mkdir, rm, symlink, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, resolve } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const { resolveTestPythonBinary } = await import("../test/test-python.js");
  const python = await resolveTestPythonBinary();
  const root = await realpath(await mkdtemp(join(tmpdir(), "container-output-metadata-")));
  const query = (path: string) => {
    const result = spawnSync(python, [resolve("workers/docker/files.py")], { input: JSON.stringify({ root, op: "output-metadata", path }), encoding: "utf8", timeout: 5000 });
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout);
  };
  try {
    await writeFile(join(root, "server.key"), "fixture content must not be returned");
    await symlink(join(root, "server.key"), join(root, "alias.key"));
    await mkdir(join(root, "folder"));
    expect(spawnSync(python, ["-c", "import os,sys; os.mkfifo(sys.argv[1])", join(root, "pipe")]).status).toBe(0);
    await symlink(join(root, "folder"), join(root, "link"));
    expect(query("server.key")).toMatchObject({ ok: true, value: { kind: "file" } });
    expect(JSON.stringify(query("server.key"))).not.toContain("fixture content");
    expect(query("missing/deep/out.pt")).toEqual({ ok: true, value: null });
    for (const path of ["alias.key", "link/out.pt", "../outside.pt", "folder", "pipe"]) expect(query(path).ok).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
