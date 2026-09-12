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

  it("uses ESTACODA_HOME before HOME for the default trust store path", () => {
    const prodHome = join(tempDir, "prod-home");
    const devHome = join(tempDir, "dev-home");
    const previousHome = process.env.HOME;
    const previousEstacodaHome = process.env.ESTACODA_HOME;
    process.env.HOME = prodHome;
    process.env.ESTACODA_HOME = devHome;
    try {
      const store = new WorkspaceTrustStore();

      expect(store.path).toBe(join(devHome, ".estacoda", "trust.json"));
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      if (previousEstacodaHome === undefined) {
        delete process.env.ESTACODA_HOME;
      } else {
        process.env.ESTACODA_HOME = previousEstacodaHome;
      }
    }
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

it('preserves unrelated trust changes from concurrent store instances',async()=>{
 const homeDir=await mkdtemp(join(tmpdir(),'trust-concurrency-'));
 try{
  const roots=await Promise.all(['one','two','three'].map(async name=>{const root=join(homeDir,name);await mkdir(root);return root;}));
  await Promise.all(roots.map(root=>new WorkspaceTrustStore({homeDir}).grant(root)));
  expect((await new WorkspaceTrustStore({homeDir}).list()).length).toBe(3);
  await Promise.all([new WorkspaceTrustStore({homeDir}).revoke(roots[0]!),new WorkspaceTrustStore({homeDir}).revoke(roots[1]!)]);
  expect(await new WorkspaceTrustStore({homeDir}).isTrusted(roots[0]!)).toBe(false);
  expect(await new WorkspaceTrustStore({homeDir}).isTrusted(roots[1]!)).toBe(false);
  expect(await new WorkspaceTrustStore({homeDir}).isTrusted(roots[2]!)).toBe(true);
 }finally{await rm(homeDir,{recursive:true,force:true});}
});
