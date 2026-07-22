import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatWorkspaceLabel, resolveWorkspaceStatus } from "./workspace-status.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("workspace status", () => {
  it("compacts a workspace beneath the user home without exposing the username", () => {
    expect(formatWorkspaceLabel(
      "/Users/akira/Documents/randomlabs-root/worktrees/EstaCoda",
      "/Users/akira"
    )).toBe("~/Documents/…/EstaCoda");
  });

  it("removes terminal and bidi control characters from workspace labels", () => {
    const label = formatWorkspaceLabel("/tmp/Esta\u001b[31m\u202eCoda", "/Users/akira");

    expect(label).not.toContain("\u001b");
    expect(label).not.toContain("\u202e");
  });

  it("reads a bounded branch name from the workspace Git HEAD without running Git", async () => {
    const home = await createTemporaryRoot();
    const workspace = join(home, "Documents", "projects", "EstaCoda");
    await mkdir(join(workspace, ".git"), { recursive: true });
    await writeFile(join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");

    await expect(resolveWorkspaceStatus(workspace, { userHome: home })).resolves.toEqual({
      label: "~/Documents/projects/EstaCoda",
      shortLabel: "EstaCoda",
      branch: "main",
    });
  });

  it("reads the branch from a Git worktree pointer", async () => {
    const home = await createTemporaryRoot();
    const workspace = join(home, "Documents", "worktrees", "EstaCoda");
    const gitDirectory = join(home, "Documents", "project", ".git", "worktrees", "EstaCoda");
    await mkdir(workspace, { recursive: true });
    await mkdir(gitDirectory, { recursive: true });
    await writeFile(join(workspace, ".git"), `gitdir: ${gitDirectory}\n`, "utf8");
    await writeFile(join(gitDirectory, "HEAD"), "ref: refs/heads/feature/prompt-rail\n", "utf8");

    await expect(resolveWorkspaceStatus(workspace, { userHome: home })).resolves.toMatchObject({
      branch: "feature/prompt-rail",
    });
  });

  it("omits branch metadata outside a normal workspace Git directory", async () => {
    const home = await createTemporaryRoot();
    const workspace = join(home, "EstaCoda");
    await mkdir(workspace, { recursive: true });

    await expect(resolveWorkspaceStatus(workspace, { userHome: home })).resolves.toEqual({
      label: "~/EstaCoda",
      shortLabel: "EstaCoda",
    });
  });

  it("omits a branch containing terminal direction controls", async () => {
    const home = await createTemporaryRoot();
    const workspace = join(home, "EstaCoda");
    await mkdir(join(workspace, ".git"), { recursive: true });
    await writeFile(join(workspace, ".git", "HEAD"), "ref: refs/heads/main\u202eevil\n", "utf8");

    await expect(resolveWorkspaceStatus(workspace, { userHome: home })).resolves.not.toHaveProperty("branch");
  });
});

async function createTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "estacoda-workspace-status-"));
  temporaryRoots.push(root);
  return root;
}
