import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { HostWorkspaceFiles } from "./host-workspace-files.js";
import { beginCommandFileObservation, finishCommandFileObservation } from "./command-file-evidence.js";
import { deriveRequestRequirements } from "../runtime/request-requirements.js";

it("observes only bounded, safe named outputs through the supplied execution view", async () => {
  const root = await mkdtemp(join(tmpdir(), "estacoda-output-observation-"));
  try {
    await mkdir(join(root, "secrets"));
    await writeFile(join(root, "secrets/key.txt"), "private");
    await writeFile(join(root, "large.txt"), Buffer.alloc(8 * 1024 * 1024 + 1));
    await symlink(join(root, "secrets/key.txt"), join(root, "alias.txt"));
    const files = new HostWorkspaceFiles(root);
    const read = vi.spyOn(files, "readFile");
    for (const path of ["../outside.txt", "secrets/key.txt", "alias.txt", "large.txt"]) {
      expect(await beginCommandFileObservation(files, deriveRequestRequirements(`Write ${path}. Read back the file.`, "turn"), "turn")).toBeUndefined();
    }
    expect(read).not.toHaveBeenCalled();
    const requirements = deriveRequestRequirements("Write nested/out.custom. Read back the file.", "turn");
    expect(await beginCommandFileObservation(files, requirements)).toBeUndefined();
    const before = await beginCommandFileObservation(files, requirements, "turn");
    expect(before?.files).toEqual([{ path: "nested/out.custom", before: null }]);
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested/out.custom"), "materialized");
    const after = await finishCommandFileObservation(files, before);
    expect(after).toMatchObject({ id: before!.id, originTurnId: "turn", completed: true, files: [{ path: "nested/out.custom", before: null, after: expect.stringMatching(/^[a-f0-9]{64}$/u) }] });
    expect(JSON.stringify(after)).not.toContain("materialized");
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("observes large binary and generated key outputs without reading content or weakening file access", async () => {
  const root = await mkdtemp(join(tmpdir(), "estacoda-output-metadata-"));
  try {
    const files = new HostWorkspaceFiles(root);
    const read = vi.spyOn(files, "readFile");
    for (const path of ["model.pt", "weights.npy", "rows.parquet", "server.key"]) {
      const requirements = deriveRequestRequirements(`Generate ${path}`, "turn");
      const before = await beginCommandFileObservation(files, requirements, "turn");
      expect(before?.files).toEqual([{ path, before: null, metadataOnly: true }]);
      await writeFile(join(root, path), Buffer.alloc(8 * 1024 * 1024 + 1));
      const after = await finishCommandFileObservation(files, before);
      expect(after?.files[0]).toMatchObject({ before: null, metadataOnly: true, after: expect.stringMatching(/^metadata:[a-f0-9]{64}$/u) });
      const unchanged = await beginCommandFileObservation(files, requirements, "turn");
      expect((await finishCommandFileObservation(files, unchanged))?.files[0]?.after).toBe(unchanged?.files[0]?.before);
    }
    expect(read).not.toHaveBeenCalled();
    expect((await files.resolvePath("server.key")).ok).toBe(false);
    await expect(files.readFile("server.key")).rejects.toThrow(/sensitive/);
    await mkdir(join(root, "secrets"));
    await symlink(join(root, "model.pt"), join(root, "alias.pt"));
    for (const path of ["../outside.pt", "secrets/out.pt", ".ssh/key.pt", ".env", "alias.pt", "secrets"]) {
      await expect(files.observeOutput(path)).rejects.toThrow();
    }
    expect(await files.observeOutput("missing/deep/out.pt")).toBeNull();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it("does not use a host fallback when the selected view cannot observe an output", async () => {
  const readFile = vi.fn();
  const files = { readFile } as unknown as HostWorkspaceFiles;
  expect(await beginCommandFileObservation(files, deriveRequestRequirements("Write output.pt", "turn"), "turn")).toBeUndefined();
  expect(readFile).not.toHaveBeenCalled();
});
