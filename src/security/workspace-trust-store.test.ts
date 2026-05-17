import { mkdtemp, mkdir, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceTrustStore } from "./workspace-trust-store.js";

describe("WorkspaceTrustStore", () => {
  let tempDir: string;
  let storePath: string;
  const grantedAt = "2026-05-17T00:00:00.000Z";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "estacoda-workspace-trust-"));
    storePath = join(tempDir, "trust.json");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("inherits a parent directory grant for child directories", async () => {
    const store = new WorkspaceTrustStore({ path: storePath, now: () => new Date(grantedAt) });
    const root = join(tempDir, "workspace");
    const child = join(root, "packages", "app");
    await mkdir(child, { recursive: true });

    await store.grant(root);

    await expect(store.isTrusted(child)).resolves.toBe(true);
  });

  it("revokes a root grant globally", async () => {
    const store = new WorkspaceTrustStore({ path: storePath, now: () => new Date(grantedAt) });
    const root = join(tempDir, "workspace");
    await mkdir(root, { recursive: true });

    await store.grant(root);
    await expect(store.isTrusted(root)).resolves.toBe(true);

    await expect(store.revoke(root)).resolves.toBe(true);
    await expect(store.isTrusted(root)).resolves.toBe(false);
  });

  it("round-trips the v2 directory grant format", async () => {
    const store = new WorkspaceTrustStore({ path: storePath, now: () => new Date(grantedAt) });
    const root = join(tempDir, "workspace");
    await mkdir(root, { recursive: true });

    const grant = await store.grant(root, { label: "Local workspace" });
    const raw = JSON.parse(await readFile(storePath, "utf8")) as unknown;

    expect(raw).toEqual({
      version: 2,
      grants: [{
        root: await realpath(root),
        grantedAt,
        label: "Local workspace"
      }]
    });
    await expect(new WorkspaceTrustStore({ path: storePath }).list()).resolves.toEqual([grant]);
  });

  it("does not persist an extra identity key on trust grants", async () => {
    const store = new WorkspaceTrustStore({ path: storePath, now: () => new Date(grantedAt) });
    const root = join(tempDir, "workspace");
    const forbiddenKey = ["pro", "fileId"].join("");
    await mkdir(root, { recursive: true });

    await store.grant(root);
    const raw = JSON.parse(await readFile(storePath, "utf8")) as { grants: Array<Record<string, unknown>> };

    expect(raw.grants[0]).not.toHaveProperty(forbiddenKey);
  });

  it("canonicalizes grants through real paths", async () => {
    const store = new WorkspaceTrustStore({ path: storePath, now: () => new Date(grantedAt) });
    const realRoot = join(tempDir, "real-workspace");
    const linkedRoot = join(tempDir, "linked-workspace");
    await mkdir(realRoot, { recursive: true });
    await symlink(realRoot, linkedRoot, "dir");

    const grant = await store.grant(linkedRoot);

    expect(grant.root).toBe(await realpath(realRoot));
    await expect(store.isTrusted(realRoot)).resolves.toBe(true);
  });
});
