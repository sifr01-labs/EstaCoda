import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { HostEnvironment } from "./host-environment.js";
import { createWorkspaceTools } from "../tools/workspace-tools.js";

it("uses the leased view for reads, search and transactional patches, then fences released access", async () => {
  const home = await mkdtemp(join(tmpdir(), "leased-files-"));
  const root = join(home, "workspace"); await mkdir(root);
  const environment = await HostEnvironment.create({ profileId: "work", workspaceRoot: root });
  const lease = environment.acquire({ profileId: "work", sessionId: "session", surface: "cli" });
  try {
    await writeFile(join(root, "inside.txt"), "visible needle\n");
    await writeFile(join(home, "outside.txt"), "private needle\n");
    await symlink(join(home, "outside.txt"), join(root, "escape.txt"));
    await symlink(join(root, "inside.txt"), join(root, "alias.txt"));
    await writeFile(join(root, ".env"), "secret needle\n");
    await symlink(join(root, ".env"), join(root, "hidden.txt"));
    const tools = createWorkspaceTools({ workspaceRoot: root, executionLease: lease });
    const read = tools.find((tool) => tool.name === "file.read")!;
    const search = tools.find((tool) => tool.name === "file.search")!;
    const patch = tools.find((tool) => tool.name === "file.patch")!;
    expect((await read.run({ path: "alias.txt" })).content).toContain("visible needle");
    expect((await read.run({ path: "escape.txt" })).ok).toBe(false);
    const matches = await search.run({ query: "needle" });
    expect(matches.ok).toBe(true); expect(matches.content).not.toContain("private needle");
    expect(matches.content).not.toContain("secret needle");
    expect((await patch.run({ mode: "replace", path: "alias.txt", old_string: "visible", new_string: "changed" })).ok).toBe(false);
    expect((await patch.run({ mode: "patch", patch: "*** Begin Patch\n*** Update File: inside.txt\n@@\n-visible needle\n+changed needle\n*** Add File: added.txt\n+new\n*** End Patch" })).ok).toBe(true);
    expect(await readFile(join(root, "inside.txt"), "utf8")).toBe("changed needle\n");
    expect(await readFile(join(root, "added.txt"), "utf8")).toBe("new\n");
    await lease.release();
    await expect(read.run({ path: "inside.txt" })).rejects.toThrow(/released/);
  } finally { await lease.release(); environment.destroy(); await rm(home, { recursive: true, force: true }); }
});
