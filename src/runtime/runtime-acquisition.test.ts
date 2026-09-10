import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ResourceCleanup } from "../execution/resource-cleanup.js";
import { SQLiteSessionDB } from "../session/sqlite-session-db.js";
import { RuntimeSessionOwner } from "./session-execution-owner.js";
import { acquireRuntimeContext } from "./runtime-acquisition.js";
import { createRuntime } from "./create-runtime.js";
import { ProviderRegistry } from "../providers/provider-registry.js";
import { resolveTokens } from "../theme/token-resolver.js";
import { WorkspaceTrustStore } from "../security/workspace-trust-store.js";
import { openDefaultSQLiteDatabase } from "../storage/factory.js";
import { resolveProfileStateHome } from "../config/profile-home.js";
import { ExecutionTargetStore } from "../workspaces/execution-target.js";

it("retains the persisted claim when construction resource cleanup is uncertain", async () => {
  const root = await mkdtemp(join(tmpdir(), "acquisition-failure-"));
  const db = new SQLiteSessionDB({ path: join(root, "sessions.sqlite") });
  try {
    const rollback = new ResourceCleanup();
    const context = await acquireRuntimeContext({ options: { profileId: "default", homeDir: root, workspaceRoot: root }, sessionDb: db, sessionId: "failure", rollback });
    context.executionLease.own({ release: () => { throw new Error("unconfirmed cleanup"); } });
    await expect(rollback.release()).rejects.toThrow();
    await expect(RuntimeSessionOwner.acquire(db, "failure", "default")).rejects.toThrow("busy");
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});
it.skipIf(process.platform === "win32")("cancels active commands and refuses settlement after target invalidation", async () => {
  const root = await mkdtemp(join(tmpdir(), "target-invalidation-"));
  const db = new SQLiteSessionDB({ path: join(root, "sessions.sqlite") });
  const trust = new WorkspaceTrustStore({ homeDir: root }); await trust.grant(root);
  const runtime = await createRuntime({ tokens: resolveTokens("standard", "dark", "kemetBlue"),
    model: { provider: "unconfigured", id: "fixture", contextWindowTokens: 8192, supportsTools: false, supportsVision: false, supportsStructuredOutput: false },
    providerRegistry: new ProviderRegistry(), homeDir: root, workspaceRoot: root, localSkillsRoot: join(root, "skills"),
    profileId: "default", sessionId: "target", sessionDb: db, closeSessionDbOnDispose: false, securityMode: "open" });
  try {
    const running = runtime.executeTool!({ tool: "terminal.run", toolInput: { command: "printf started > phase.txt; sleep 3; printf forbidden > finished.txt" } });
    const rejected = expect(running).rejects.toThrow(/target|closed/);
    for (let i = 0; i < 100; i++) { try { await access(join(root, "phase.txt")); break; } catch { await new Promise((resolve) => setTimeout(resolve, 20)); } }
    await access(join(root, "phase.txt"));
    const targets = new ExecutionTargetStore({ homeDir: root, profileId: "default" });
    const target = targets.getTarget((await db.getSession("target"))!.executionTarget!.targetId)!;
    const targetDb = openDefaultSQLiteDatabase({ path: join(resolveProfileStateHome({ homeDir: root, profileId: "default" }).profileRoot, "workspaces.sqlite") });
    targetDb.query("update execution_targets set record_json=? where id=?").run(JSON.stringify({ ...target, generation: target.generation + 1, status: "archived" }), target.id);
    targetDb.close(); targets.close();
    await rejected;
    await expect(access(join(root, "finished.txt"))).rejects.toThrow();
  } finally { await runtime.dispose(); db.close(); await rm(root, { recursive: true, force: true }); }
});
