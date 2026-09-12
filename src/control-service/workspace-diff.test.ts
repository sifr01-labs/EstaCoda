import {it,expect} from 'vitest';
import {mkdtemp,mkdir,writeFile,rm,realpath,rename} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {ExecutionTargetStore} from '../workspaces/execution-target.js';
import {WorkspaceTrustStore} from '../security/workspace-trust-store.js';
import {inspectDiff} from './workspace-diff.js';
it('projects staged renames, unstaged edits, untracked previews and binary changes',async()=>{
 const homeDir=await realpath(await mkdtemp('/tmp/ec-diff-')),root=join(homeDir,'repo'),input={homeDir,profileId:'p'};await mkdir(root);
 const git=(args:string[])=>execFileSync('git',['-C',root,...args]);git(['init','-q']);
 await writeFile(join(root,'old.txt'),'initial\n');await writeFile(join(root,'binary.bin'),Buffer.from([0,1]));git(['add','.']);git(['-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','Initial']);
 await rename(join(root,'old.txt'),join(root,'new.txt'));git(['add','.']);await writeFile(join(root,'new.txt'),'initial\nchanged\n');await writeFile(join(root,'binary.bin'),Buffer.from([0,2]));await writeFile(join(root,'untracked.txt'),'new file');
 const store=new ExecutionTargetStore(input),signal=new AbortController().signal;
 try{
  const record=await store.acquireLocal(root),target={targetId:record.id,targetGeneration:1};await new WorkspaceTrustStore(input).grant(root);
  const result=await inspectDiff(input,'diff.list',{target},signal);
  expect(result.items).toEqual(expect.arrayContaining([expect.objectContaining({path:'new.txt',previousPath:'old.txt',stage:'staged',status:'renamed'}),expect.objectContaining({path:'new.txt',stage:'unstaged'}),expect.objectContaining({path:'untracked.txt',stage:'untracked'})]));
  expect((await inspectDiff(input,'diff.patch',{target,path:'new.txt',stage:'unstaged'},signal)).text).toContain('+changed');
  expect(await inspectDiff(input,'diff.patch',{target,path:'binary.bin',stage:'unstaged'},signal)).toMatchObject({binary:true,text:null});
  expect((await inspectDiff(input,'diff.patch',{target,path:'untracked.txt',stage:'untracked'},signal)).text).toBe('new file');
  await expect(inspectDiff(input,'diff.patch',{target,path:'../escape',stage:'unstaged'},signal)).rejects.toThrow();
 }finally{store.close();await rm(homeDir,{recursive:true,force:true});}
});
