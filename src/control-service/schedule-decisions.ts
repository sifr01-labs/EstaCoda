import {BUILTIN_TOOLSETS} from '../contracts/tool.js';
import {createHash,randomUUID} from 'node:crypto';
import {ControlProtocolError,type ScheduleAction,type ScheduleDraft,type ScheduleReview} from '../contracts/desktop-control/index.js';
import {ScheduleQueries,SCHEDULE_STORE_MAX_JOBS,SCHEDULE_STORE_MAX_BYTES} from './schedule-queries.js';
import {ConnectionOperations} from './connection-operations.js';
import {ExecutionTargetStore,targetBinding} from '../workspaces/execution-target.js';
import {WorkspaceTrustStore} from '../security/workspace-trust-store.js';
import {assertInspectionRoot} from './inspection-lease.js';
import {loadRuntimeConfig} from '../config/runtime-config.js';
import {resolveCronModelRoute,validateCronRuntimeControls,CRON_FORCED_DISABLED_TOOLSETS} from '../cron/cron-runtime-validation.js';
import {parseCronSchedule,CronWriteRejectedError,type CronJob} from '../cron/cron-store.js';
import {assertCronPromptSafe} from '../cron/cron-safety.js';
import {withProfileWriteLock} from '../config/profile-write-lock.js';
import {validateCronAuthority,assertLocalCronDelivery} from '../cron/cron-authority.js';
export class ScheduleDecisions extends ScheduleQueries{
 readonly operations=new ConnectionOperations(this.input);
 readonly reviews=new Map<string,{review:ScheduleReview;fingerprint:string}>();
 readonly controller=new AbortController();
 async draft(id:string):Promise<ScheduleDraft>{
  const job=await(await this.store()).get(id);if(!job)throw new ControlProtocolError('-32004');
  const binding=job.executionOrigin?.target??job.localTarget?.binding;
  let target=binding?{targetId:binding.targetId,targetGeneration:binding.targetGeneration}:null;
  if(!target&&job.workdir){try{const store=new ExecutionTargetStore({...this.input,readonly:true});try{let after:string|undefined;for(let page=0;page<10;page++){const rows=store.listTargets(100,after,true),found=rows.find(t=>t.workspace.canonicalPath===job.workdir);if(found){target={targetId:found.id,targetGeneration:found.generation};break;}if(rows.length<100)break;after=rows.at(-1)!.id;}}finally{store.close();}}catch(error){if((error as NodeJS.ErrnoException).code!=='SQLITE_CANTOPEN'&&(error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}
  const result:ScheduleDraft={name:job.name,objective:job.prompt,schedule:job.schedule,target,model:job.modelOverride?{provider:job.modelOverride.provider??'',model:job.modelOverride.model}:null,delivery:job.delivery,skills:job.skills,toolsets:job.enabledToolsets??null,contextFrom:job.contextFrom??[],repeat:job.repeat??null,script:job.script??null,scriptArgs:job.scriptArgs??[],scriptTimeoutMs:job.scriptTimeoutMs??null,noAgent:job.noAgent===true};
  // Do not return truncated editable data that could overwrite a longer CLI definition.
  const {validateControlResponse,CONTROL_METHODS}=await import('../contracts/desktop-control/index.js');
  validateControlResponse({jsonrpc:'2.0',id:'draft',result},{jsonrpc:'2.0',id:'draft',method:'schedules.draft',params:{id}},{profileId:this.input.profileId,instanceId:'draft',capabilities:{methods:[...CONTROL_METHODS],events:[]}});
  return result;
 }
 private async state(action:ScheduleAction){
  this.controller.signal.throwIfAborted();const store=await this.store(),job=action.id?await store.get(action.id):undefined;if(action.id&&!job)throw new ControlProtocolError('-32004');
  if(action.action==='delete'||action.action==='disable')return{job,definition:null,patch:undefined,fingerprint:JSON.stringify(job),workspace:job?.workdir??null,nextRunAt:null,authority:'existing',spendUsd:null,model:''};
  if(action.action!=='save'){if(!job?.executionOrigin&&!job?.localTarget)throw new ControlProtocolError('-32003');await validateCronAuthority(job!,this.input);}
  const d=action.action==='save'?action.draft:await this.draft(action.id);
  if(action.action==='enable'&&job?.repeat!==undefined&&job.runCount>=job.repeat)throw new ControlProtocolError('-32602');
  if(action.action==='run-now'&&job?.runRequested)throw new ControlProtocolError('-32009');if(!d.target)throw new ControlProtocolError('-32003');assertCronPromptSafe(d.objective);const parsed=parseCronSchedule(d.schedule);if(!parsed.nextRunAt||!Number.isFinite(parsed.nextRunAt.getTime())||parsed.nextRunAt.getTime()<=Date.now()&&(!job||job.schedule!==d.schedule||action.action==='enable'))throw new ControlProtocolError('-32602');
  if(d.noAgent&&!d.script||d.contextFrom.includes(action.id??'')||d.toolsets?.some(t=>CRON_FORCED_DISABLED_TOOLSETS.includes(t as typeof CRON_FORCED_DISABLED_TOOLSETS[number])))throw new ControlProtocolError('-32602');
  for(const id of d.contextFrom)if(!await store.get(id))throw new ControlProtocolError('-32003');
  const targets=new ExecutionTargetStore({...this.input,readonly:true});
  try{
   const target=targets.getTarget(d.target.targetId);if(!target||target.generation!==d.target.targetGeneration)throw new ControlProtocolError('-32004');
   const binding=targetBinding(target);await targets.validate(binding,target.workspace.canonicalPath,this.controller.signal);await assertInspectionRoot(this.input,target.workspace.canonicalPath);if(!await new WorkspaceTrustStore(this.input).isTrusted(target.workspace.canonicalPath))throw new ControlProtocolError('-32003');
   if(job?.executionOrigin){await validateCronAuthority(job,this.input);if(JSON.stringify(job.executionOrigin.target)!==JSON.stringify(binding)||!['local','origin'].includes(d.delivery))throw new ControlProtocolError('-32003');}
   const config=await loadRuntimeConfig({...this.input,workspaceRoot:target.workspace.canonicalPath,configurationInspection:true});
   const controls=await validateCronRuntimeControls({enabledToolsets:d.toolsets??undefined,config,availableToolsets:BUILTIN_TOOLSETS});
   if(!controls.ok)throw new ControlProtocolError('-32602');
   const patch={name:d.name,prompt:d.objective,schedule:d.schedule,workdir:target.workspace.canonicalPath,modelOverride:d.model?{...(d.model.provider?{provider:d.model.provider}:{}),model:d.model.model}:undefined,delivery:d.delivery,skills:d.skills,enabledToolsets:controls.normalized.enabledToolsets,contextFrom:d.contextFrom,repeat:d.repeat??undefined,script:d.script??undefined,scriptArgs:d.scriptArgs,scriptTimeoutMs:d.scriptTimeoutMs??undefined,noAgent:d.noAgent,localTarget:job?.executionOrigin?undefined:{profileId:this.input.profileId,binding}};
   if(!job?.executionOrigin)assertLocalCronDelivery({...job,...patch} as CronJob,config);
   const route=d.noAgent?undefined:await resolveCronModelRoute({job:{...job,...patch} as CronJob,latestConfig:config});if(!d.noAgent&&(!route||route.provider==='unconfigured'))throw new ControlProtocolError('-32003');
   return{job,definition:d,patch,fingerprint:createHash('sha256').update(JSON.stringify([job??null,binding,config.config])).digest('hex'),workspace:patch.workdir,nextRunAt:action.action==='run-now'?null:parsed.nextRunAt.toISOString(),authority:config.security.approvalMode,spendUsd:config.budgets.session?.maxEstimatedCostUsd??null,model:route?`${route.provider}/${route.id}`:'none'};
  }finally{targets.close();}
 }
 async review(action:ScheduleAction){const state=await this.state(action);for(const[id,r]of this.reviews)if(r.review.expiresAt<=Date.now())this.reviews.delete(id);if(this.reviews.size>=16)throw new ControlProtocolError('-32009');const review:ScheduleReview={reviewId:randomUUID(),action:structuredClone(action),definition:state.definition,profileId:this.input.profileId,workspace:state.workspace,nextRunAt:state.nextRunAt,authority:state.authority,spendUsd:state.spendUsd,model:state.model,expiresAt:Date.now()+300000};this.reviews.set(review.reviewId,{review,fingerprint:state.fingerprint});return review;}
 cancel(id:string){this.reviews.delete(id);return{cancelled:true};}
 async execute(input:{reviewId:string;operationId:string;confirmed:true}){
  return this.operations.execute(input.operationId,'schedule',async()=>{
   const r=this.reviews.get(input.reviewId);this.reviews.delete(input.reviewId);if(!r||r.review.expiresAt<=Date.now()||input.confirmed!==true)return false;
   return withProfileWriteLock(this.paths.profileRoot,async()=>{
    let state;try{state=await this.state(r.review.action);}catch{return false;}if(state.fingerprint!==r.fingerprint)return false;
    try {
    const store=await this.store({expectedJob:state.job,maxJobs:SCHEDULE_STORE_MAX_JOBS,maxBytes:SCHEDULE_STORE_MAX_BYTES});if(r.review.action.action==='delete')return await store.remove(r.review.action.id);
    if(r.review.action.action==='disable')return !!await store.pause(r.review.action.id);
    if(r.review.action.action==='enable')return !!await store.resume(r.review.action.id);
    if(r.review.action.action==='run-now')return !!await store.requestRun(r.review.action.id);
    if(!state.patch)return false;if(r.review.action.id)return !!await store.update(r.review.action.id,state.patch);await store.create(state.patch);return true;
    }catch(error){if(error instanceof CronWriteRejectedError)return false;throw error;}
   });
  });
 }
 dispose(){this.controller.abort();this.reviews.clear();}
}
