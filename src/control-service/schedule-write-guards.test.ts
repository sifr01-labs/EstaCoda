import {it,expect,vi} from 'vitest';
import {readFile,writeFile} from 'node:fs/promises';
import {scheduleFixture} from './schedule-test-fixture.js';
import {loadRuntimeConfig} from '../config/runtime-config.js';
import {validateCronRuntimeControls} from '../cron/cron-runtime-validation.js';
import {BUILTIN_TOOLSETS} from '../contracts/tool.js';

for(const action of ['save','delete','enable','disable','run-now'] as const)it(`rejects ${action} when a Cron writer changes the job after final review validation`,async()=>{
 const f=await scheduleFixture();try{
  const initial=await f.owner.review({action:'save',draft:f.draft});await f.owner.execute({reviewId:initial.reviewId,operationId:'create',confirmed:true});const store=await f.owner.store(),job=(await store.list())[0]!;
  const review=await f.owner.review(action==='save'?{action,id:job.id,draft:{...f.draft,name:'Desktop'}}:{action,id:job.id});
  const original=f.owner.store.bind(f.owner);const spy=vi.spyOn(f.owner,'store').mockImplementation(async guard=>{
   const guarded=await original(guard);
   // The final guard is prepared, but the independent writer commits before its transaction.
   if(guard)await store.update(job.id,{name:'CLI change',prompt:'A new objective'});
   return guarded;
  });
  const receipt=await f.owner.execute({reviewId:review.reviewId,operationId:'write',confirmed:true});spy.mockRestore();expect(receipt.state).toBe('failed');expect((await f.owner.operations.inspect('write')).state).toBe('failed');expect(await store.get(job.id)).toMatchObject({name:'CLI change',prompt:'A new objective',status:'active'});expect((await store.get(job.id))?.runRequested).not.toBe(true);
 }finally{await f.dispose();}
});
it('rejects creation at the count limit without stranding list/delete recovery',async()=>{const f=await scheduleFixture();try{
 const store=await f.owner.store(),job=await store.create({prompt:'Report',schedule:'every 1h'});await writeFile(store.path,JSON.stringify({jobs:Array.from({length:1000},(_,i)=>({...job,id:'cron-'+i}))}));const before=await readFile(store.path);
 const review=await f.owner.review({action:'save',draft:f.draft});expect((await f.owner.execute({reviewId:review.reviewId,operationId:'overflow',confirmed:true})).state).toBe('failed');expect(await readFile(store.path)).toEqual(before);expect((await f.owner.list()).items.length).toBeGreaterThan(0);
 const remove=await f.owner.review({action:'delete',id:'cron-0'});expect((await f.owner.execute({reviewId:remove.reviewId,operationId:'remove',confirmed:true})).state).toBe('completed');expect(await store.list()).toHaveLength(999);
 }finally{await f.dispose();}});
it('checks serialized UTF-8 bytes before publication, and permits deletion to recover space',async()=>{const f=await scheduleFixture();try{
 const store=await f.owner.store(),job=await store.create({prompt:'Report',schedule:'every 1h'});await writeFile(store.path,JSON.stringify({jobs:[{...job,prompt:'x'.repeat(1_040_000)}]}));const before=await readFile(store.path);
 const review=await f.owner.review({action:'save',draft:{...f.draft,scriptArgs:Array.from({length:32},()=> 'ع'.repeat(512))}});expect((await f.owner.execute({reviewId:review.reviewId,operationId:'overflow',confirmed:true})).state).toBe('failed');expect(await readFile(store.path)).toEqual(before);expect((await f.owner.list()).items).toHaveLength(1);
 const remove=await f.owner.review({action:'delete',id:job.id});expect((await f.owner.execute({reviewId:remove.reviewId,operationId:'remove',confirmed:true})).state).toBe('completed');expect((await f.owner.list()).items).toEqual([]);
 }finally{await f.dispose();}});
it('uses shared toolset validation for built-in names and preserves explicit empty restrictions',async()=>{const f=await scheduleFixture();try{
 const config=await loadRuntimeConfig({...f.input,workspaceRoot:f.root});
 for(const toolsets of [['filse'],['cron'],[' cron '],['messaging'],['clarify']]){expect((await validateCronRuntimeControls({enabledToolsets:toolsets,config,availableToolsets:BUILTIN_TOOLSETS})).ok).toBe(false);await expect(f.owner.review({action:'save',draft:{...f.draft,toolsets}})).rejects.toThrow();}
 for(const [i,toolsets] of [[],['files','mcp','configuration'],[' files ','files']].entries()){
  const review=await f.owner.review({action:'save',draft:{...f.draft,toolsets}});expect((await f.owner.execute({reviewId:review.reviewId,operationId:'create-'+i,confirmed:true})).state).toBe('completed');
 }
 expect((await(await f.owner.store()).list()).map(j=>j.enabledToolsets)).toEqual([[],['files','mcp','configuration'],['files']]);
 }finally{await f.dispose();}});
