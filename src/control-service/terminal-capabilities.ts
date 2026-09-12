import {assertInspectionRoot} from './inspection-lease.js';
import {lstat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {ExecutionTargetStore,targetBinding} from '../workspaces/execution-target.js';
import {WorkspaceTrustStore} from '../security/workspace-trust-store.js';
import {selectedExecutionPolicy} from '../execution/docker-policy.js';
import {DockerContainer} from '../execution/docker-container.js';
import {HostEnvironment} from '../execution/host-environment.js';
import type {MethodContracts,TargetReference} from '../contracts/desktop-control/index.js';
type Capability=MethodContracts['terminal.acquire']['result'];
type Held={stamp:{dev:number;ino:number};value:Capability;store:ExecutionTargetStore;release:()=>void;container?:DockerContainer;policy:string;revoked:boolean};
/** Only the trusted Main transport receives these capabilities. Expiry revokes
 * use but does not assert native process settlement or release a host borrower. */
export class TerminalCapabilities{
 readonly #held=new Map<string,Held>();#disposed=false;#opening=false;
 constructor(readonly input:{homeDir:string;profileId:string}){}
 async acquire(target:TargetReference,signal:AbortSignal):Promise<Capability>{
  if(this.#disposed||this.#opening||this.#held.size>=2)throw new Error('Terminal capability unavailable.');
  this.#opening=true;const store=new ExecutionTargetStore(this.input);let release:(()=>void)|undefined,container:DockerContainer|undefined;
  try{
   const record=store.getTarget(target.targetId);if(!record||record.generation!==target.targetGeneration)throw new Error('Stale target.');
   const root=record.workspace.canonicalPath,stamp=await lstat(root);
   await assertInspectionRoot(this.input,root);
   if(!stamp.isDirectory()||stamp.isSymbolicLink())throw new Error('Target directory changed.');
   await store.validate(targetBinding(record),root,signal);
   if(!await new WorkspaceTrustStore(this.input).isTrusted(root))throw new Error('Workspace trust required.');
   release=await store.borrow(targetBinding(record));const policy=await selectedExecutionPolicy(this.input);
   if(policy.backend==='docker')container=await DockerContainer.prepare({...this.input,workspaceRoot:root,policy});
   else{const environment=await HostEnvironment.create({profileId:this.input.profileId,workspaceRoot:root,policy});await environment.destroy();}
   signal.throwIfAborted();if(this.#disposed)throw new Error('Terminal owner closed.');
   await store.validate(targetBinding(record),root,signal);
   const fresh=await lstat(root);if(fresh.ino!==stamp.ino||fresh.dev!==stamp.dev)throw new Error('Target directory changed.');
   const value:Capability={capabilityId:randomUUID(),target,workingRoot:root,backend:policy.backend,expiresAt:Date.now()+3000,container:container?{id:container.id,user:container.user,endpoint:container.client.endpoint}:null};
   this.#held.set(value.capabilityId,{stamp:{dev:stamp.dev,ino:stamp.ino},value,store,release,container,policy:JSON.stringify(policy),revoked:false});return value;
  }catch(error){try{await container?.release();release?.();}finally{store.close();}throw error;}finally{this.#opening=false;}
 }
 async verify(id:string,signal:AbortSignal):Promise<{expiresAt:number}>{
  const held=this.#held.get(id);if(!held||this.#disposed||held.revoked||held.value.expiresAt<=Date.now())throw new Error('Terminal capability expired.');
  try{
   const record=held.store.getTarget(held.value.target.targetId);if(!record||record.generation!==held.value.target.targetGeneration)throw new Error('Stale target.');
   await held.store.validate(targetBinding(record),held.value.workingRoot,signal);
   if(!await new WorkspaceTrustStore(this.input).isTrusted(held.value.workingRoot)||JSON.stringify(await selectedExecutionPolicy(this.input))!==held.policy)throw new Error('Terminal authority changed.');
   const fresh=await lstat(held.value.workingRoot);if(fresh.ino!==held.stamp.ino||fresh.dev!==held.stamp.dev||fresh.isSymbolicLink())throw new Error('Target directory changed.');
   await held.container?.verify();signal.throwIfAborted();
   if(this.#disposed||held.revoked||held.value.expiresAt<=Date.now())throw new Error('Terminal capability expired.');
   held.value.expiresAt=Date.now()+3000;return{expiresAt:held.value.expiresAt};
  }catch(error){held.revoked=true;throw error;}
 }
 async release(id:string):Promise<{released:boolean}>{
  const held=this.#held.get(id);if(!held)return{released:false};held.revoked=true;
  await held.container?.release();held.release();held.store.close();this.#held.delete(id);return{released:true};
 }
 dispose():void{
  this.#disposed=true;
  for(const held of this.#held.values()){
   held.revoked=true;
   // Main closes on transport loss. Host settlement cannot be inferred here;
   // retain its durable borrower rather than permitting unsafe worktree cleanup.
   if(held.container)void this.release(held.value.capabilityId).catch(()=>{});
   else held.store.close();
  }
 }
}
