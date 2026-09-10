import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { WorkspaceTrustStore } from "../security/workspace-trust-store.js";
import { createLiveAuthority } from "./live-execution-authority.js";
import { RuntimeSessionOwner } from "./session-execution-owner.js";
import { InMemorySessionDB } from "../session/in-memory-session-db.js";

it("keeps cosmetic changes compatible and detects trust and policy revocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "live-authority-"));
  const profileRoot = join(root, "profile"); await mkdir(profileRoot);
  const trustStore = new WorkspaceTrustStore({ homeDir: root }); await trustStore.grant(root);
  await writeFile(join(profileRoot, "config.json"), JSON.stringify({ security: { mode: "adaptive" }, ui: { theme: "old" } }));
  try {
    const check = await createLiveAuthority({ profileRoot, workspaceRoot: root, trustStore });
    await writeFile(join(profileRoot, "config.json"), JSON.stringify({ ui: { theme: "new" }, security: { mode: "adaptive" } }));
    await expect(check()).resolves.toBeUndefined();
    await trustStore.revoke(root); await expect(check()).rejects.toThrow("revoked");
    await trustStore.grant(root);
    await writeFile(join(profileRoot, "config.json"), JSON.stringify({ security: { mode: "strict" } }));
    await expect(check()).rejects.toThrow("configuration changed");
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("aborts an active owner and settles owned resources after live revocation", async () => {
  const owner = await RuntimeSessionOwner.acquire(new InMemorySessionDB(), "session", "default");
  let revoked = false, stopped = 0;
  owner.setValidator(async () => { if (revoked) throw new Error("revoked"); }, async () => { stopped++; });
  const running = owner.run(async () => { await new Promise((resolve) => owner.signal.addEventListener("abort", resolve, { once: true })); });
  const rejected = expect(running).rejects.toThrow("closed");
  await new Promise((resolve) => setTimeout(resolve, 10)); revoked = true;
  await rejected;
  expect(stopped).toBeGreaterThan(0);
  await owner.settle(); owner.release();
});
it("detects emptied env values and removed OAuth entries while allowing token refresh", async () => {
  const root = await mkdtemp(join(tmpdir(), "credential-authority-"));
  const trustStore = new WorkspaceTrustStore({ homeDir: root }); await trustStore.grant(root);
  const env = join(root, ".env"), auth = join(root, "auth.json");
  try {
    await writeFile(env, 'TEST_KEY="synthetic"\n');
    await writeFile(auth, JSON.stringify({ version: 1, providers: { test: { authMethod: "oauth_device", accessToken: "synthetic" } } }));
    const check = await createLiveAuthority({ profileRoot: root, workspaceRoot: root, trustStore });
    await writeFile(auth, JSON.stringify({ version: 1, providers: { test: { authMethod: "oauth_device", accessToken: "refreshed-synthetic" } } }));
    await expect(check()).resolves.toBeUndefined();
    await writeFile(env, 'TEST_KEY=""\n');
    await expect(check()).rejects.toThrow("credential availability");
    await writeFile(env, 'TEST_KEY=synthetic\n');
    await writeFile(auth, JSON.stringify({ version: 1, providers: {} }));
    await expect(check()).rejects.toThrow("credential availability");
  } finally { await rm(root, { recursive: true, force: true }); }
});
it("retires settled operation checks and retains borrowed background authority", async () => {
  const { withExecutionAuthority, withExecutionOperation, retainExecutionAuthority, retainCurrentExecutionOperation } = await import("./live-execution-authority.js");
  const checks = new Set<() => void>();
  await withExecutionAuthority(async () => { for (const check of checks) check(); }, checks, async () => {
    for (let i = 0; i < 1100; i++) await withExecutionOperation(async () => { retainExecutionAuthority(() => undefined); });
    expect(checks.size).toBe(0);
    let release!: () => void;
    let revoked = false;
    await withExecutionOperation(async () => {
      retainExecutionAuthority(() => { if (revoked) throw new Error("revoked background grant"); });
      release = retainCurrentExecutionOperation();
    });
    expect(checks.size).toBe(1); revoked = true;
    expect(() => { for (const check of checks) check(); }).toThrow("revoked background grant");
    release(); expect(checks.size).toBe(0);
  });
});
it("does not release an owner while a detached tool operation remains unsettled", async () => {
  const { withExecutionOperation } = await import("./live-execution-authority.js");
  const owner = await RuntimeSessionOwner.acquire(new InMemorySessionDB(), "pending", "default");
  let finish!: () => void;
  const barrier = new Promise<void>((resolve) => { finish = resolve; });
  await owner.run(async () => { void withExecutionOperation(() => barrier).catch(() => undefined); });
  let settled = false;
  const closing = owner.settle().then(() => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(settled).toBe(false); finish(); await closing; owner.release();
});
it("keeps background-process approval checks live after the launching operation returns", async () => {
  const { HostEnvironment } = await import("../execution/host-environment.js");
  const { withExecutionOperation, retainExecutionAuthority } = await import("./live-execution-authority.js");
  const root = await mkdtemp(join(tmpdir(), "background-authority-"));
  const environment = await HostEnvironment.create({ profileId: "default", workspaceRoot: root });
  const lease = environment.acquire({ profileId: "default", sessionId: "background", surface: "test" });
  const owner = await RuntimeSessionOwner.acquire(new InMemorySessionDB(), "background", "default");
  owner.setValidator(async () => undefined, () => lease.release());
  let revoked = false;
  try {
    const child = await owner.run(() => withExecutionOperation(async () => {
      retainExecutionAuthority(() => { if (revoked) throw new Error("grant revoked"); });
      return lease.processes.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
    }));
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    revoked = true;
    await closed;
    expect(owner.signal.aborted).toBe(true);
  } finally { await owner.settle(); owner.release(); environment.destroy(); await rm(root, { recursive: true, force: true }); }
}, 5000);
