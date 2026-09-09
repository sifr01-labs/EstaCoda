import { mkdir, mkdtemp, rm, writeFile, rename, symlink, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { WorkspaceTrustStore } from "../security/workspace-trust-store.js";
import { WorkspaceRegistry } from "./workspace-registry.js";

let homeDir: string;
let store: WorkspaceRegistry;
beforeEach(async () => { homeDir = await mkdtemp(join(tmpdir(), "workspace-registry-")); store = new WorkspaceRegistry({ homeDir, profileId: "default" }); });
afterEach(async () => { store.close(); await rm(homeDir, { recursive: true, force: true }); });

it("preserves identity on rename, revisions moves, and never grants trust", async () => {
  const first = await store.add("Project", homeDir);
  expect(store.rename("project", "renamed")).toEqual({ ...first, alias: "renamed" });
  await mkdir(join(homeDir, "new"));
  const moved = await store.move(first.id, join(homeDir, "new"), 1);
  expect(moved.id).toBe(first.id);
  expect(moved.locationRevision).toBe(2);
  expect(moved.identity).not.toEqual(first.identity);
  await expect(store.move(first.id, homeDir, 1)).rejects.toThrow("revision changed");
  expect(await new WorkspaceTrustStore({ path: join(homeDir, "trust.json") }).list()).toEqual([]);
  store.remove("renamed");
  expect(store.list()).toEqual([]);
});

it("isolates profiles and rejects aliases, files and missing directories", async () => {
  await store.add("project", homeDir);
  const other = new WorkspaceRegistry({ homeDir, profileId: "other" });
  try { expect(other.get("project")).toBeUndefined(); } finally { other.close(); }
  await expect(store.add("PROJECT", homeDir)).rejects.toThrow("already exists");
  await expect(store.add("../escape", homeDir)).rejects.toThrow("aliases");
  await writeFile(join(homeDir, "file"), "fixture");
  await expect(store.add("file", join(homeDir, "file"))).rejects.toThrow("directory");
  await expect(store.add("missing", join(homeDir, "missing"))).rejects.toThrow();
});

it("coordinates separate connections without lost unrelated updates", async () => {
  const second = new WorkspaceRegistry({ homeDir, profileId: "default" });
  try {
    await Promise.all([store.add("one", homeDir), second.add("two", homeDir)]);
    expect(store.list().map((row) => row.alias)).toEqual(["one", "two"]);
    const results = await Promise.allSettled([store.add("same", homeDir), second.add("same", homeDir)]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  } finally { second.close(); }
});

it("does not transfer trust on move or follow a retargeted canonical directory", async () => {
  const firstPath = join(homeDir, "original");
  const nextPath = join(homeDir, "next");
  await mkdir(firstPath); await mkdir(nextPath);
  const trust = new WorkspaceTrustStore({ homeDir });
  await trust.grant(firstPath);
  const grants = await trust.list();
  const first = await store.add("project", firstPath);
  await store.move(first.id, nextPath, 1);
  expect(await trust.isTrusted(nextPath)).toBe(false);
  expect(await trust.list()).toEqual(grants);
  await rename(nextPath, join(homeDir, "moved-away"));
  await symlink(firstPath, nextPath);
  await expect(store.resolve("project")).rejects.toThrow("location changed");
  expect(store.get("project")?.locationRevision).toBe(2);
});

it("rejects dangling registry symlinks without creating their destination", async () => {
  const profile = join(homeDir, ".estacoda", "profiles", "linked");
  const destination = join(homeDir, "outside.sqlite");
  await mkdir(profile, { recursive: true });
  await symlink(destination, join(profile, "workspaces.sqlite"));
  expect(() => new WorkspaceRegistry({ homeDir, profileId: "linked" })).toThrow(/symbolic link/);
  await expect(lstat(destination)).rejects.toHaveProperty("code", "ENOENT");
});
