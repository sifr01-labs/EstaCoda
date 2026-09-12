import {it,expect} from 'vitest';
import {mkdtemp,mkdir,writeFile,rm,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {ExecutionTargetStore} from '../workspaces/execution-target.js';
import {WorkspaceTrustStore} from '../security/workspace-trust-store.js';
import {inspectFiles} from './workspace-files.js';
it('reads bounded text and binary metadata through a trusted target borrower',async()=>{
 const homeDir=await realpath(await mkdtemp('/tmp/ec-files-')),root=join(homeDir,'repo'),input={homeDir,profileId:'p'};await mkdir(root);
 const store=new ExecutionTargetStore(input),signal=new AbortController().signal;
 try{
  const record=await store.acquireLocal(root),target={targetId:record.id,targetGeneration:1};
  await writeFile(join(root,'large.txt'),'x'.repeat(40000));await writeFile(join(root,'binary.bin'),Buffer.from([0,1,2]));
  await expect(inspectFiles(input,'files.list',{target,path:'.'},signal)).rejects.toThrow('trust');
  await new WorkspaceTrustStore(input).grant(root);
  expect((await inspectFiles(input,'files.list',{target,path:'.'},signal)).items).toHaveLength(2);
  expect(await inspectFiles(input,'files.preview',{target,path:'large.txt'},signal)).toMatchObject({size:40000,text:'x'.repeat(16384),truncated:true,binary:false});
  expect(await inspectFiles(input,'files.preview',{target,path:'binary.bin'},signal)).toMatchObject({size:3,text:null,binary:true});
 }finally{store.close();await rm(homeDir,{recursive:true,force:true});}
});
