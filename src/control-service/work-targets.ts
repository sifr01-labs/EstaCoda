import {loadRuntimeConfig} from '../config/runtime-config.js';
import {lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {resolveProfileStateHome} from '../config/profile-home.js';
import {basename} from 'node:path';
import type {TargetProjection} from '../contracts/desktop-control/index.js';
import {ExecutionTargetStore,targetBinding} from '../workspaces/execution-target.js';
import {WorkspaceTrustStore} from '../security/workspace-trust-store.js';
/** Existing core targets only. Discovery never creates targets or grants trust. */
export async function availableWorkTargets(input:{homeDir:string;profileId:string},signal:AbortSignal):Promise<{items:TargetProjection[];truncated:boolean}>{
 let store:ExecutionTargetStore;
 try{await lstat(join(resolveProfileStateHome(input).profileRoot,'workspaces.sqlite'));store=new ExecutionTargetStore({...input,readonly:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return{items:[],truncated:false};throw error;}
 try{
  const config=await loadRuntimeConfig({...input,workspaceRoot:input.homeDir,configurationInspection:true});
  const isolation=config.config.execution?.backend==='docker'?'unknown' as const:'host' as const;
  const records=store.listTargets(101),items:TargetProjection[]=[];
  for(const target of records.slice(0,100)){
   signal.throwIfAborted();if(target.status!=='available')continue;
   try{await store.validate(targetBinding(target),target.workspace.canonicalPath);if(!await new WorkspaceTrustStore(input).isTrusted(target.workspace.canonicalPath))continue;}catch{continue;}
   // A target is a directory binding, not a sandbox grant.
   items.push({targetId:target.id,targetGeneration:target.generation,label:basename(target.workspace.canonicalPath).slice(0,240)||'Workspace',isolation,approvalMode:config.security.approvalMode});
  }
  return{items,truncated:records.length>100};
 }finally{store.close();}
}

/** Management inspection includes blockers; discovery does not imply readiness. */
export async function inspectCoreTarget(input:{homeDir:string;profileId:string},reference:import('../contracts/desktop-control/index.js').TargetReference):Promise<import('../contracts/desktop-control/index.js').TargetDetails>{
 const store=new ExecutionTargetStore({...input,readonly:true});
 try{
  const target=store.getTarget(reference.targetId);
  if(!target||target.generation!==reference.targetGeneration)throw new Error('Target is missing or stale.');
  let readiness:import('../contracts/desktop-control/index.js').TargetDetails['readiness']='archived';
  if(target.status==='available'){
   try{await store.validate(targetBinding(target),target.workspace.canonicalPath);readiness=await new WorkspaceTrustStore(input).isTrusted(target.workspace.canonicalPath)?'ready':'untrusted';}catch{readiness='unavailable';}
  }
  return {...reference,kind:target.kind,label:basename(target.workspace.canonicalPath).slice(0,240)||'Workspace',workingRoot:target.workspace.canonicalPath,sourceRoot:target.source.identity.canonicalPath,status:target.status,readiness,managed:false};
 }finally{store.close();}
}
