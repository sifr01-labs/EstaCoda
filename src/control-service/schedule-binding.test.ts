import {it,expect,vi} from 'vitest';
import {writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {scheduleFixture} from './schedule-test-fixture.js';
import {ScheduleDecisions} from './schedule-decisions.js';
import {WorkspaceTrustStore} from '../security/workspace-trust-store.js';
import {validateCronAuthority,recurringCronRuntimeOptions} from '../cron/cron-authority.js';
import {resolveCronModelRoute} from '../cron/cron-runtime-validation.js';
import {createRuntimeCronRunner} from '../cron/cron-runner.js';
import {loadRuntimeConfig} from '../config/runtime-config.js';
import {withCronExecutionOrigin} from '../cron/cron-origin.js';
import {targetBinding} from '../workspaces/execution-target.js';
const modelConfig={model:{provider:'local',id:'primary'},providers:{local:{baseUrl:'http://127.0.0.1:8080/v1',authMethod:'none',enableNetwork:true,models:['primary','scheduled']}}};
it('binds profile, target generation and trust through dispatch, and rejects foreign profile queries',async()=>{const f=await scheduleFixture();const other=new ScheduleDecisions({...f.input,profileId:'other'});try{
 const r=await f.owner.review({action:'save',draft:f.draft});await f.owner.execute({reviewId:r.reviewId,operationId:'create',confirmed:true});const job=(await(await f.owner.store()).list())[0]!;
 expect(await other.list()).toMatchObject({items:[]});await expect(other.draft(job.id)).rejects.toThrow();await expect(other.history(job.id)).rejects.toThrow();await expect(validateCronAuthority(job,{...f.input,profileId:'other'})).rejects.toThrow('mismatch');
 const options=await recurringCronRuntimeOptions(job,{...f.input,sessionId:'run'});expect(options.sourceWorkspace).toBeDefined();await options.validateExecutionAuthority!();
 await new WorkspaceTrustStore(f.input).revoke(f.root);await expect(options.validateExecutionAuthority!()).rejects.toThrow('trust');
 const runtimeFactory=vi.fn(),deliver=vi.fn();const runner=createRuntimeCronRunner({runtimeFactory,deliver,store:await f.owner.store(),workspaceRoot:f.root,scriptExecution:f.input,isWorkspaceTrusted:async()=>true});expect((await runner.runJob(job)).ok).toBe(false);expect(runtimeFactory).not.toHaveBeenCalled();expect(deliver).not.toHaveBeenCalled();
 await new WorkspaceTrustStore(f.input).grant(f.root);await expect(validateCronAuthority({...job,localTarget:{...job.localTarget!,binding:{...job.localTarget!.binding,targetGeneration:99}}},f.input)).rejects.toThrow();
 }finally{other.dispose();await f.dispose();}});
it('revalidates the current model, spending policy and delivery configuration without invoking a provider',async()=>{const f=await scheduleFixture();try{
 await writeFile(f.owner.paths.configPath,JSON.stringify({...modelConfig,security:{approvalMode:'strict'},budgets:{session:{maxEstimatedCostUsd:2}},channels:{telegram:{enabled:true,allowedUserIds:['owner']}}}));
 const draft={...f.draft,noAgent:false,script:null,model:{provider:'',model:'scheduled'},delivery:'telegram:destination:thread'};
 const r=await f.owner.review({action:'save',draft});expect(r).toMatchObject({model:'local/scheduled',authority:'strict',spendUsd:2});expect((await f.owner.execute({reviewId:r.reviewId,operationId:'create',confirmed:true})).state).toBe('completed');const job=(await(await f.owner.store()).list())[0]!;expect(job.modelOverride).toEqual({model:'scheduled'});expect(job.delivery).toBe(draft.delivery);
 expect((await resolveCronModelRoute({job,latestConfig:await loadRuntimeConfig({...f.input,workspaceRoot:f.root})}))?.id).toBe('scheduled');
 await writeFile(f.owner.paths.configPath,JSON.stringify({...modelConfig,channels:{telegram:{enabled:false}}}));await expect(validateCronAuthority(job,f.input)).rejects.toThrow('delivery');
 for(const delivery of ['origin','unknown','telegram:destination'])await expect(f.owner.review({action:'save',draft:{...draft,delivery}})).rejects.toThrow();
 await expect(f.owner.review({action:'save',draft:{...draft,delivery:'local',model:{provider:'missing-provider',model:'x'}}})).rejects.toThrow();
 }finally{await f.dispose();}});
it('preserves channel execution origin and blocks retargeting or delivery expansion',async()=>{const f=await scheduleFixture();try{
 await writeFile(f.owner.paths.configPath,JSON.stringify({channels:{telegram:{enabled:true,allowedUserIds:['owner']}}}));const origin={schemaVersion:1 as const,profileId:'one',target:targetBinding(f.target),principalId:'owner',sessionKey:{platform:'telegram' as const,chatId:'chat',chatType:'dm' as const}};
 const store=await f.owner.store(),job=await withCronExecutionOrigin(origin,()=>store.create({prompt:'Report',schedule:'every 1h',delivery:'origin',script:'report.js',noAgent:true}));const draft=await f.owner.draft(job.id);
 const r=await f.owner.review({action:'save',id:job.id,draft:{...draft,name:'Reviewed'}});expect((await f.owner.execute({reviewId:r.reviewId,operationId:'edit',confirmed:true})).state).toBe('completed');expect((await store.get(job.id))?.executionOrigin).toEqual(origin);
 await expect(f.owner.review({action:'save',id:job.id,draft:{...draft,delivery:'telegram:other'}})).rejects.toThrow();await mkdir(join(f.input.homeDir,'other-workspace'));const other=await f.targets.acquireLocal(join(f.input.homeDir,'other-workspace'));await new WorkspaceTrustStore(f.input).grant(other.workspace.canonicalPath);await expect(f.owner.review({action:'save',id:job.id,draft:{...draft,target:{targetId:other.id,targetGeneration:other.generation}}})).rejects.toThrow();
 }finally{await f.dispose();}});
it('does not replay a consumed or uncertain operation and rejects an intervening CLI edit',async()=>{const f=await scheduleFixture();try{
 const r=await f.owner.review({action:'save',draft:f.draft});const input={reviewId:r.reviewId,operationId:'create',confirmed:true as const};await f.owner.execute(input);expect((await f.owner.execute(input)).state).toBe('completed');const store=await f.owner.store(),job=(await store.list())[0]!;expect(await store.list()).toHaveLength(1);
 const edit=await f.owner.review({action:'save',id:job.id,draft:{...f.draft,name:'Desktop'}});await store.update(job.id,{name:'CLI'});expect((await f.owner.execute({reviewId:edit.reviewId,operationId:'stale',confirmed:true})).state).toBe('failed');expect((await store.get(job.id))?.name).toBe('CLI');
 const again=await f.owner.review({action:'save',draft:f.draft});await f.owner.operations.execute('uncertain','schedule',async()=>{throw new Error('lost response');});expect((await f.owner.execute({reviewId:again.reviewId,operationId:'uncertain',confirmed:true})).state).toBe('uncertain');expect(await store.list()).toHaveLength(1);
 const unconfirmed=await f.owner.review({action:'delete',id:job.id});expect((await f.owner.execute({reviewId:unconfirmed.reviewId,operationId:'unconfirmed',confirmed:false as never})).state).toBe('failed');expect(await store.get(job.id)).toBeDefined();
 }finally{await f.dispose();}});
it('opens a legacy CLI schedule for explicit target binding without mutating it',async()=>{const f=await scheduleFixture();try{const store=await f.owner.store(),job=await store.create({prompt:'Inspect',schedule:'every 1h',workdir:f.target.workspace.canonicalPath});const draft=await f.owner.draft(job.id);expect(draft.target?.targetId).toBe(f.target.id);expect((await store.get(job.id))?.localTarget).toBeUndefined();await expect(f.owner.review({action:'run-now',id:job.id})).rejects.toThrow();}finally{await f.dispose();}});
