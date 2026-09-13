import {it,expect} from 'vitest';
import {runCronCommand} from './cron-command.js';
import {scheduleFixture} from '../control-service/schedule-test-fixture.js';
it('round-trips once, interval and Cron schedules between CLI and Desktop without losing advanced controls',async()=>{const f=await scheduleFixture();try{
 const store=await f.owner.store();const context=await store.create({prompt:'Prior report',schedule:'every 1d'});
 for(const [index,schedule] of ['2099-01-01T09:00:00Z','every 2h','0 9 * * 1-5'].entries()){
  const result=await runCronCommand({store,args:['add','--schedule',schedule,'--command','فحص التغييرات /workspace','--name',`CLI ${index}`,'--workdir',f.target.workspace.canonicalPath,'--skill','research','--context-from',context.id,'--script','audit.js','--script-arg','--format','--script-arg','Arabic report','--script-timeout-ms','10000','--no-agent','--repeat','3','--delivery','silent'],workdirControls:{defaultWorkspaceRoot:f.target.workspace.canonicalPath,allowedRoots:[f.target.workspace.canonicalPath],isWorkspaceTrusted:async()=>true}});expect(result.ok,result.output).toBe(true);
  const job=(await store.list()).find(j=>j.name===`CLI ${index}`)!;const draft=await f.owner.draft(job.id);expect(draft).toMatchObject({schedule,skills:['research'],contextFrom:[context.id],script:'audit.js',scriptArgs:['--format','Arabic report'],scriptTimeoutMs:10000,noAgent:true,repeat:3,delivery:'silent',target:f.draft.target});
  const review=await f.owner.review({action:'save',id:job.id,draft:{...draft,name:`Desktop ${index}`}});expect((await f.owner.execute({reviewId:review.reviewId,operationId:`edit-${index}`,confirmed:true})).state).toBe('completed');
  expect((await runCronCommand({store,args:['show',job.id]})).output).toContain(`Desktop ${index}`);expect(await f.owner.draft(job.id)).toEqual({...draft,name:`Desktop ${index}`});
  expect((await runCronCommand({store,args:['pause',job.id]})).ok).toBe(true);expect((await f.owner.get(job.id)).status).toBe('paused');
  expect((await runCronCommand({store,args:['edit',job.id,'--name',`CLI again ${index}`]})).ok).toBe(true);expect((await f.owner.draft(job.id)).name).toBe(`CLI again ${index}`);
  const remove=await f.owner.review({action:'delete',id:job.id});await f.owner.execute({reviewId:remove.reviewId,operationId:`delete-${index}`,confirmed:true});expect((await runCronCommand({store,args:['show',job.id]})).ok).toBe(false);
 }
 }finally{await f.dispose();}});
