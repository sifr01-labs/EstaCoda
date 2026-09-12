import {mkdtemp,mkdir,rm} from 'node:fs/promises';
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

it('pages every target and directly validates a selected target beyond page one',async()=>{
 const {TargetControls}=await import('./target-controls.js');const {join}=await import('node:path');
 const homeDir=await mkdtemp('/tmp/ec-target-pages-'),input={homeDir,profileId:'p'},store=new ExecutionTargetStore(input),signal=new AbortController().signal,controls=new TargetControls(input);
 try{
  for(let i=0;i<101;i++){const root=join(homeDir,'repo-'+i);await mkdir(root);await store.acquireLocal(root);}
  await new WorkspaceTrustStore(input).grant(homeDir);
  const first=await controls.list(signal),last=await controls.list(signal,first.nextCursor);
  expect(first.items).toHaveLength(100);expect(first.truncated).toBe(true);expect(last.items).toHaveLength(1);expect(last.truncated).toBe(false);
  expect(new Set([...first.items,...last.items].map(row=>row.targetId)).size).toBe(101);
  const target={targetId:last.items[0]!.targetId,targetGeneration:1};
  expect(await controls.inspect(target)).toMatchObject({readiness:'ready'});
  expect((await availableWorkTargets(input,signal,{target})).items).toMatchObject([target]);
  expect((await availableWorkTargets(input,signal,{cursor:first.nextCursor})).items).toMatchObject([target]);
  expect((await availableWorkTargets(input,signal,{target:{...target,targetGeneration:2}})).items).toEqual([]);
  expect((await availableWorkTargets({...input,profileId:'other'},signal,{target})).items).toEqual([]);
  await expect(controls.list(signal,'../elsewhere')).rejects.toThrow('cursor');
 }finally{controls.dispose();store.close();await rm(homeDir,{recursive:true,force:true});}
});
