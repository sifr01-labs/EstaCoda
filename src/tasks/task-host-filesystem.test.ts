import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ArtifactRecord } from "../contracts/artifact.js";
import { createTaskArtifactContentResolver } from "./task-artifact-content.js";
import { resolveTaskWorkspaceBinding } from "./task-workspace.js";

describe("Task host filesystem boundaries", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
  });

  it("uses the canonical workspace path as a stable host identity", async () => {
    const root = temporaryDirectory();
    const workspace = join(root, "workspace");
    const alias = join(root, "workspace-alias");
    mkdirSync(workspace);
    symlinkSync(workspace, alias);

    const expectedPath = await realpath(workspace);
    await expect(resolveTaskWorkspaceBinding(alias)).resolves.toEqual({
      canonicalPath: expectedPath,
      identityHash: createHash("sha256").update(expectedPath).digest("hex")
    });
  });

  it("reads only exact regular files beneath reviewed roots", async () => {
    const root = temporaryDirectory();
    const allowed = join(root, "allowed");
    const outside = join(root, "outside");
    mkdirSync(allowed);
    mkdirSync(outside);
    const file = join(allowed, "result.bin");
    const outsideFile = join(outside, "secret.bin");
    const symlink = join(allowed, "linked.bin");
    writeFileSync(file, Buffer.from([1, 2, 3]));
    writeFileSync(outsideFile, Buffer.from([4, 5, 6]));
    symlinkSync(outsideFile, symlink);
    const resolveContent = await createTaskArtifactContentResolver([allowed]);

    await expect(resolveContent(context(artifact(file, 3)))).resolves.toEqual(new Uint8Array([1, 2, 3]));
    await expect(resolveContent(context(artifact(file, 2)))).resolves.toBeUndefined();
    await expect(resolveContent(context(artifact(outsideFile, 3)))).resolves.toBeUndefined();
    await expect(resolveContent(context(artifact(symlink, 3)))).resolves.toBeUndefined();
    await expect(resolveContent(context(artifact("relative.bin", 3)))).resolves.toBeUndefined();
  });

  it("admits a reviewed cache root created later but rejects a symlinked replacement", async () => {
    const root = temporaryDirectory();
    const lateRoot = join(root, "late-cache");
    const symlinkRoot = join(root, "linked-cache");
    const outside = join(root, "outside");
    const resolveContent = await createTaskArtifactContentResolver([lateRoot, symlinkRoot]);
    mkdirSync(lateRoot);
    mkdirSync(outside);
    const lateFile = join(lateRoot, "result.bin");
    const outsideFile = join(outside, "result.bin");
    writeFileSync(lateFile, Buffer.from([1]));
    writeFileSync(outsideFile, Buffer.from([2]));
    symlinkSync(outside, symlinkRoot);

    await expect(resolveContent(context(artifact(lateFile, 1)))).resolves.toEqual(new Uint8Array([1]));
    await expect(resolveContent(context(artifact(outsideFile, 1)))).resolves.toBeUndefined();
  });

  function temporaryDirectory(): string {
    const path = mkdtempSync(join(tmpdir(), "estacoda-task-host-fs-"));
    tempDirs.push(path);
    return path;
  }
});

function artifact(localPath: string, bytes: number): ArtifactRecord {
  return {
    id: "artifact-1",
    path: "artifact.bin",
    kind: "data",
    mimeType: "application/octet-stream",
    bytes,
    createdAt: "2030-01-01T00:00:00.000Z",
    localPath
  };
}

function context(record: ArtifactRecord) {
  return {
    artifact: record,
    task: {} as never,
    step: {} as never,
    attempt: {} as never
  };
}
