import {mkdtemp,rm} from 'node:fs/promises';
import {it,expect} from 'vitest';
import {ExecutionTargetStore} from '../workspaces/execution-target.js';
import {WorkspaceTrustStore} from '../security/workspace-trust-store.js';
import {availableWorkTargets} from './work-targets.js';
it('offers only existing trusted targets in the selected profile',async()=>{
 const homeDir=await mkdtemp('/tmp/ec-target-list-');const input={homeDir,profileId:'p'};const store=new ExecutionTargetStore(input);
 try{const target=await store.acquireLocal(homeDir);expect((await availableWorkTargets(input,new AbortController().signal)).items).toEqual([]);const trust=new WorkspaceTrustStore(input);await trust.grant(homeDir);expect((await availableWorkTargets(input,new AbortController().signal)).items).toMatchObject([{targetId:target.id,targetGeneration:1,approvalMode:'adaptive'}]);expect((await availableWorkTargets({homeDir,profileId:'q'},new AbortController().signal)).items).toEqual([]);}finally{store.close();await rm(homeDir,{recursive:true,force:true});}
});
it('projects immutable bindings and blockers without creating trust',async()=>{
 const {inspectCoreTarget}=await import('./work-targets.js');
 const homeDir=await mkdtemp('/tmp/ec-target-inspect-');const input={homeDir,profileId:'p'};const store=new ExecutionTargetStore(input);
 try{const target=await store.acquireLocal(homeDir);const ref={targetId:target.id,targetGeneration:1};
  expect(await inspectCoreTarget(input,ref)).toMatchObject({kind:'local',workingRoot:target.workspace.canonicalPath,sourceRoot:target.workspace.canonicalPath,readiness:'untrusted',managed:false});
  await expect(inspectCoreTarget(input,{...ref,targetGeneration:2})).rejects.toThrow('stale');
  const other=new ExecutionTargetStore({...input,profileId:'q'});other.close();
  await expect(inspectCoreTarget({...input,profileId:'q'},ref)).rejects.toThrow('missing');
 }finally{store.close();await rm(homeDir,{recursive:true,force:true});}
});
