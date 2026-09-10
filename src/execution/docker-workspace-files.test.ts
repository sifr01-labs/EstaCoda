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
