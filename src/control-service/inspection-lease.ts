import {lstat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {ExecutionTargetStore,targetBinding} from '../workspaces/execution-target.js';
import {WorkspaceTrustStore} from '../security/workspace-trust-store.js';
import {HostEnvironment,type ExecutionLease} from '../execution/host-environment.js';
import {selectedExecutionPolicy} from '../execution/docker-policy.js';
import {DockerContainer} from '../execution/docker-container.js';
import {DockerWorkspaceFiles} from '../execution/docker-workspace-files.js';
import {DockerProcessScope} from '../execution/docker-processes.js';
import type {TargetReference} from '../contracts/desktop-control/index.js';
/** Independent inspection owner; shares target identity and execution policy, never a Session owner. */
export async function withInspection<T>(input:{homeDir:string;profileId:string},reference:TargetReference,signal:AbortSignal,read:(lease:ExecutionLease,root:string)=>Promise<T>):Promise<T>{
 const store=new ExecutionTargetStore(input);let stamp:{dev:number;ino:number}|undefined;let release:(()=>void)|undefined,environment:HostEnvironment|undefined,lease:ExecutionLease|undefined;
 const verify=async()=>{
  signal.throwIfAborted();const target=store.getTarget(reference.targetId);
  if(!target||target.generation!==reference.targetGeneration)throw new Error('Target unavailable.');
  await store.validate(targetBinding(target),target.workspace.canonicalPath,signal);
  if(!await new WorkspaceTrustStore(input).isTrusted(target.workspace.canonicalPath))throw new Error('Workspace trust required.');
  const info=await lstat(target.workspace.canonicalPath);
  if(!info.isDirectory()||info.isSymbolicLink()||stamp&&(stamp.dev!==info.dev||stamp.ino!==info.ino))throw new Error('Target directory changed.');
  stamp??={dev:info.dev,ino:info.ino};signal.throwIfAborted();return target;
 };
 try{
  const target=await verify();release=await store.borrow(targetBinding(target));
  const root=target.workspace.canonicalPath,policy=await selectedExecutionPolicy(input);
  if(policy.backend==='docker'){
   const container=await DockerContainer.prepare({...input,workspaceRoot:root,policy});
   environment=HostEnvironment.prepared(input.profileId,container.facts,{files:(active,processes)=>new DockerWorkspaceFiles(container,active,processes,input.homeDir),processes:()=>new DockerProcessScope(container,input.homeDir),dispose:()=>container.release()});
  }else environment=await HostEnvironment.create({profileId:input.profileId,workspaceRoot:root,policy});
  lease=environment.acquire({profileId:input.profileId,sessionId:randomUUID(),surface:'desktop-inspection'});
  const activeLease=lease;
  const abort=()=>{void activeLease.release().catch(()=>{/* Retained borrower on failed settlement. */});};
  signal.addEventListener('abort',abort,{once:true});
  try{await verify();const result=await read(lease,root);await verify();return result;}
  finally{signal.removeEventListener('abort',abort);}
 }finally{
  // A failed resource shutdown retains the durable borrower; cleanup must remain blocked.
  try{await lease?.release();await environment?.destroy();release?.();}finally{store.close();}
 }
}
