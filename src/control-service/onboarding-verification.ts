import {lstat} from 'node:fs/promises';import {join} from 'node:path';
import {resolveProfileStateHome} from '../config/profile-home.js';
import {ExecutionTargetStore,targetBinding} from '../workspaces/execution-target.js';
import {WorkspaceTrustStore} from '../security/workspace-trust-store.js';
import {detectOnboarding} from './onboarding-detection.js';
import type {OnboardingVerification} from '../contracts/desktop-control/index.js';
/** Saved-state verification is read-only, never starts a runtime, and never runs a provider test. */
export async function verifyOnboarding(input:{homeDir:string;profileId:string},alias?:string):Promise<OnboardingVerification>{
 let store:ExecutionTargetStore|undefined;
 try{
  await lstat(join(resolveProfileStateHome(input).profileRoot,'workspaces.sqlite'));store=new ExecutionTargetStore({...input,readonly:true});
  const workspace=alias?await store.resolve(alias):store.list()[0];
  if(!workspace)return {detection:await detectOnboarding(input),workspace:null,target:null};
  const resolved=await store.resolve(workspace.id),detection=await detectOnboarding(input,resolved.identity.canonicalPath);
  let target:ReturnType<ExecutionTargetStore['getTarget']>,cursor:string|undefined;
  for(let page=0;page<10&&!target;page++){const rows=store.listTargets(100,cursor,true);target=rows.find(t=>t.source.registeredWorkspaceId===resolved.id&&t.source.registeredWorkspaceRevision===resolved.locationRevision&&t.status==='available');if(rows.length<100)break;cursor=rows.at(-1)!.id;}
  if(!target)return {detection:{...detection,launchReady:false},workspace:resolved.alias,target:null};
  await store.validate(targetBinding(target),resolved.identity.canonicalPath);
  const trusted=await new WorkspaceTrustStore(input).isTrusted(resolved.identity.canonicalPath);
  return {detection:{...detection,launchReady:detection.launchReady&&trusted},workspace:resolved.alias,target:detection.launchReady&&trusted?{targetId:target.id,targetGeneration:target.generation}:null};
 }catch{return {detection:{...await detectOnboarding(input),launchReady:false},workspace:null,target:null};}finally{store?.close();}
}
