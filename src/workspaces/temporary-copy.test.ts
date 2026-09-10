import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, rename, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { prepareTemporaryCopy, parseCopyInput } from "./temporary-copy.js";
import { ExecutionTargetStore, targetBinding } from "./execution-target.js";
import { WorkspaceTrustStore } from "../security/workspace-trust-store.js";

export async function copyFixture() {
  const homeDir = await mkdtemp(join(tmpdir(), "copy-tests-")), source = join(homeDir, "source"), destination = join(homeDir, "copy");
  await mkdir(source); await writeFile(join(source, "hello.bin"), Buffer.from([0, 255, 1])); await chmod(join(source, "hello.bin"), 0o755);
  const options = { homeDir, profileId: "work" };
  const store = new ExecutionTargetStore(options); await store.add("source", source); store.close();
  await new WorkspaceTrustStore(options).grant(source);
  return { ...options, source, destination, input: { version: 1, files: [{ path: "hello.bin", origin: "untracked" }] },
    cleanup: () => rm(homeDir, { recursive: true, force: true }) };
}
it("copies only manifest inputs and preserves binary bytes, modes and source provenance", async () => {
  const f = await copyFixture();
  try {
    await writeFile(join(f.source, "secret.txt"), "excluded");
    const target = await prepareTemporaryCopy({ ...f, source: "source", manifest: f.input });
    expect(await readFile(join(f.destination, "hello.bin"))).toEqual(Buffer.from([0, 255, 1]));
    await expect(readFile(join(f.destination, "secret.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    const store = new ExecutionTargetStore(f);
    try {
      expect((await store.acquireLocal(f.destination)).id).toBe(target.id);
      expect(store.copyManifest(target.id).entries[0]!.baseline.mode).toBe(0o755);
      expect(target.workspace.identityHash).not.toBe(target.source.identity.identityHash);
      await rename(f.destination, f.destination + "-old"); await mkdir(f.destination);
      await expect(store.validate(targetBinding(target), f.destination)).rejects.toThrow("replaced");
    } finally { store.close(); }
    expect(await new WorkspaceTrustStore(f).isTrusted(f.destination)).toBe(false);
  } finally { await f.cleanup(); }
});
it("rejects sensitive, traversing, symlink and undeclared dependency inputs", async () => {
  for (const path of ["../outside", "/etc/passwd", ".env", ".git/config", "node_modules/a.js", "secrets/key", "x\\y", "a//b"]) expect(() => parseCopyInput({ version: 1, files: [{ path, origin: "untracked" }] })).toThrow();
  const f = await copyFixture();
  try {
    await symlink("hello.bin", join(f.source, "link"));
    await expect(prepareTemporaryCopy({ ...f, source: "source", manifest: { version: 1, files: [{ path: "link", origin: "untracked" }] } })).rejects.toThrow("symlinks");
    await expect(prepareTemporaryCopy({ ...f, source: "source", destination: join(f.source, "nested"), manifest: f.input })).rejects.toThrow("non-nested");
  } finally { await f.cleanup(); }
});
