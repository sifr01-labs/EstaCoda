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
it("persists definition references for the final tool registry and stable authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "runtime-references-"));
  const db = new SQLiteSessionDB({ path: join(root, "sessions.sqlite") });
  const trustStore = new WorkspaceTrustStore({ homeDir: root }); await trustStore.grant(root);
  const model = { provider: "fixture", id: "fixture", contextWindowTokens: 8192, supportsTools: true, supportsVision: false, supportsStructuredOutput: false };
  const registry = new ProviderRegistry();
  registry.register({ id: model.provider, name: "Fixture", executable: true, health: () => ({ available: true }), listModels: () => [model],
    complete: async () => ({ ok: true, provider: model.provider, model: model.id, content: "Hello.", finishReason: "stop" }) });
  const references: Array<{ definitionRevision: string; authorityRevision: string }> = [];
  try {
    for (const disabledToolsets of [[], ["shell-write"], ["shell-write"]]) {
      const sessionId = `reference-${references.length}`;
      const runtime = await createRuntime({ tokens: resolveTokens("standard", "dark", "kemetBlue"), model, providerRegistry: registry,
        primaryModelRoute: { provider: model.provider, id: model.id, profile: model, authMethod: "none" },
        homeDir: root, workspaceRoot: root, localSkillsRoot: join(root, "skills"), profileId: "default", sessionId, sessionDb: db,
        closeSessionDbOnDispose: false, securityMode: "open", trustStore, disabledToolsets });
      try {
        await runtime.handle({ channel: "cli", text: "Hello" });
        const refs = (await db.listTrajectoriesForSession(sessionId))[0]!.executionReferences!;
        expect(refs.definitionRevision).toMatch(/^[a-f0-9]{64}$/u);
        expect(refs.authorityRevision).toMatch(/^[a-f0-9]{64}$/u);
        references.push(refs);
      } finally { await runtime.dispose(); }
    }
    expect(references[0]!.definitionRevision).not.toBe(references[1]!.definitionRevision);
    expect(references[1]).toEqual(references[2]);
    expect(references[0]!.authorityRevision).toBe(references[1]!.authorityRevision);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});
it('keeps runtime tools on the managed worktree and releases its guard after settlement',async()=>{
 const {execFileSync}=await import('node:child_process');const {mkdir,writeFile,readFile}=await import('node:fs/promises');
 const {ManagedWorktrees}=await import('../workspaces/managed-worktrees.js');const {targetBinding}=await import('../workspaces/execution-target.js');
 const homeDir=await mkdtemp(join(tmpdir(),'runtime-worktree-')),source=join(homeDir,'repo');await mkdir(source);
 execFileSync('git',['init','-q',source]);await writeFile(join(source,'file'),'source');execFileSync('git',['-C',source,'add','file']);execFileSync('git',['-C',source,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','Initial']);
 const store=new ManagedWorktrees({homeDir,profileId:'default'}),db=new SQLiteSessionDB({path:join(homeDir,'sessions.sqlite')});
 let runtime:Awaited<ReturnType<typeof createRuntime>>|undefined;
 try{
  await new WorkspaceTrustStore({homeDir}).grant(source);const target=await store.create(await store.review(targetBinding(await store.acquireLocal(source))),true);
  runtime=await createRuntime({tokens:resolveTokens('standard','dark','kemetBlue'),model:{provider:'unconfigured',id:'fixture',contextWindowTokens:8192,supportsTools:false,supportsVision:false,supportsStructuredOutput:false},providerRegistry:new ProviderRegistry(),homeDir,workspaceRoot:target.workspace.canonicalPath,profileId:'default',sessionId:'tree-runtime',sessionDb:db,closeSessionDbOnDispose:false,securityMode:'open'});
  await runtime.executeTool!({tool:'terminal.run',toolInput:{command:'printf worktree > file'}});
  expect(await readFile(join(target.workspace.canonicalPath,'file'),'utf8')).toBe('worktree');expect(await readFile(join(source,'file'),'utf8')).toBe('source');
  expect((await db.getSession('tree-runtime'))!.executionTarget).toEqual(targetBinding(target));
  expect(store.borrowers(target.id)).toBe(1);await runtime.dispose();runtime=undefined;expect(store.borrowers(target.id)).toBe(0);
 }finally{await runtime?.dispose();db.close();store.close();await rm(homeDir,{recursive:true,force:true});}
});
