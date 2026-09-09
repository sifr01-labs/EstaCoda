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
