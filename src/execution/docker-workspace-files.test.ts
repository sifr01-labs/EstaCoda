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
