import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveTaskWorkspaceBinding } from "../tasks/task-workspace.js";
import { resolveWorkspaceIdentity } from "./workspace-identity.js";

it("preserves legacy Task hashes and resolves symlink aliases", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-identity-"));
  try {
    await symlink(root, join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
    const canonicalPath = await realpath(root);
    const expected = { canonicalPath, identityHash: createHash("sha256").update(canonicalPath).digest("hex") };
    expect(await resolveWorkspaceIdentity(join(root, "alias"))).toEqual(expected);
    expect(await resolveTaskWorkspaceBinding(root)).toEqual(expected);
    await expect(resolveWorkspaceIdentity(join(root, "missing"))).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
