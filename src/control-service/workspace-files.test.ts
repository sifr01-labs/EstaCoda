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
it('rejects traversal, protected areas, symlink leaves/parents, foreign profiles and stale/moved targets',async()=>{
 const {symlink,rename}=await import('node:fs/promises');
 const homeDir=await realpath(await mkdtemp('/tmp/ec-files-fence-')),root=join(homeDir,'repo'),input={homeDir,profileId:'p'};await mkdir(root);
 const store=new ExecutionTargetStore(input),signal=new AbortController().signal;
 try{
  await writeFile(join(homeDir,'outside.txt'),'outside canary');await writeFile(join(root,'inside.txt'),'inside');await mkdir(join(root,'folder'));await writeFile(join(root,'folder','child.txt'),'inside');
  await writeFile(join(root,'.env'),'protected canary');await symlink(join(homeDir,'outside.txt'),join(root,'escape'));await symlink(join(root,'inside.txt'),join(root,'internal-link'));await symlink(join(root,'folder'),join(root,'linked-folder'));
  const record=await store.acquireLocal(root),target={targetId:record.id,targetGeneration:1};await new WorkspaceTrustStore(input).grant(root);
  for(const path of ['../outside.txt','/etc/passwd','folder/../../outside.txt','.git/config','.env','escape','internal-link','linked-folder/child.txt','folder\\child.txt'])await expect(inspectFiles(input,'files.preview',{target,path},signal)).rejects.toThrow();
  await expect(inspectFiles({...input,profileId:'other'},'files.preview',{target,path:'inside.txt'},signal)).rejects.toThrow();
  await expect(inspectFiles(input,'files.preview',{target:{...target,targetGeneration:2},path:'inside.txt'},signal)).rejects.toThrow();
  const aborted=new AbortController();aborted.abort();await expect(inspectFiles(input,'files.list',{target,path:'.'},aborted.signal)).rejects.toThrow();
  await rename(root,root+'-moved');await expect(inspectFiles(input,'files.preview',{target,path:'inside.txt'},signal)).rejects.toThrow();
 }finally{store.close();await rm(homeDir,{recursive:true,force:true});}
});
it('pages bounded directory results without hiding files behind the first page',async()=>{
 const homeDir=await realpath(await mkdtemp('/tmp/ec-files-pages-')),root=join(homeDir,'repo'),input={homeDir,profileId:'p'};await mkdir(root);const store=new ExecutionTargetStore(input),signal=new AbortController().signal;
 try{
  await Promise.all(Array.from({length:40},(_,index)=>writeFile(join(root,'file-'+String(index).padStart(2,'0')),'x')));
  const record=await store.acquireLocal(root),target={targetId:record.id,targetGeneration:1};await new WorkspaceTrustStore(input).grant(root);
  const first=await inspectFiles(input,'files.list',{target,path:'.'},signal);expect(first.items).toHaveLength(32);expect(first.truncated).toBe(true);
  const second=await inspectFiles(input,'files.list',{target,path:'.',cursor:first.nextCursor},signal);expect(second.items).toHaveLength(8);expect(second.truncated).toBe(false);expect(new Set([...first.items,...second.items].map(item=>item.path)).size).toBe(40);
 }finally{store.close();await rm(homeDir,{recursive:true,force:true});}
});
it('withholds an inspection result if the bound directory is replaced during the read',async()=>{
 const {withInspection}=await import('./inspection-lease.js'),{rename}=await import('node:fs/promises');
 const homeDir=await realpath(await mkdtemp('/tmp/ec-files-replace-')),root=join(homeDir,'repo'),input={homeDir,profileId:'p'};await mkdir(root);const store=new ExecutionTargetStore(input);
 try{
  const record=await store.acquireLocal(root),target={targetId:record.id,targetGeneration:1};await new WorkspaceTrustStore(input).grant(root);
  await expect(withInspection(input,target,new AbortController().signal,async()=>{await rename(root,root+'-old');await mkdir(root);return 'must not escape';})).rejects.toThrow('directory changed');
 }finally{store.close();await rm(homeDir,{recursive:true,force:true});}
});
it('uses the Docker file worker descriptor checks for bounded previews and symlink rejection',async()=>{
 const {execFileSync}=await import('node:child_process'),{symlink}=await import('node:fs/promises');
 const homeDir=await realpath(await mkdtemp('/tmp/ec-preview-worker-')),root=join(homeDir,'repo');await mkdir(root);
 try{
  await writeFile(join(root,'large.txt'),'x'.repeat(30000));await symlink(join(root,'large.txt'),join(root,'linked.txt'));
  const request=(path:string)=>JSON.parse(execFileSync('python3',['workers/docker/files.py'],{input:JSON.stringify({root,op:'preview',path}),encoding:'utf8'}));
  const result=request('large.txt');expect(result.ok).toBe(true);expect(result.value.size).toBe(30000);expect(Buffer.from(result.value.bytes,'base64')).toHaveLength(16384);
  for(const path of ['linked.txt','../outside','/etc/passwd'])expect(request(path).ok).toBe(false);
 }finally{await rm(homeDir,{recursive:true,force:true});}
});
