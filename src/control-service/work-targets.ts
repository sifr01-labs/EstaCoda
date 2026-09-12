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
  const records=store.listTargets(101),items:TargetProjection[]=[];
  for(const target of records.slice(0,100)){
   signal.throwIfAborted();if(target.status!=='available')continue;
   try{await store.validate(targetBinding(target),target.workspace.canonicalPath);if(!await new WorkspaceTrustStore(input).isTrusted(target.workspace.canonicalPath))continue;}catch{continue;}
   // A target is a directory binding, not a sandbox grant.
   items.push({targetId:target.id,targetGeneration:target.generation,label:basename(target.workspace.canonicalPath).slice(0,240)||'Workspace',isolation:'host'});
  }
  return{items,truncated:records.length>100};
 }finally{store.close();}
}
