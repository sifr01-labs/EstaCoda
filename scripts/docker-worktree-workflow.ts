import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
/** Source and dist gate: the sole bind is the worktree, never its Git common directory. */
export async function validateDockerWorktree(runtimeRoot:string,parent:string,client:any,policy:any){
 const {ManagedWorktrees}=await import(new URL(`${runtimeRoot}/workspaces/managed-worktrees.js`,import.meta.url).href);
 const {targetBinding}=await import(new URL(`${runtimeRoot}/workspaces/execution-target.js`,import.meta.url).href);
 const {WorkspaceTrustStore}=await import(new URL(`${runtimeRoot}/security/workspace-trust-store.js`,import.meta.url).href);
 const {DockerContainer}=await import(new URL(`${runtimeRoot}/execution/docker-container.js`,import.meta.url).href);
 const {DockerWorkspaceFiles}=await import(new URL(`${runtimeRoot}/execution/docker-workspace-files.js`,import.meta.url).href);
 const {DockerProcessScope}=await import(new URL(`${runtimeRoot}/execution/docker-processes.js`,import.meta.url).href);
 const {HostEnvironment}=await import(new URL(`${runtimeRoot}/execution/host-environment.js`,import.meta.url).href);
 const homeDir=await mkdtemp(join(parent,'.estacoda-worktree-gate-')),source=join(homeDir,'repo'),profileId='worktree-gate';
 let store:any,environment:any,lease:any,release:(()=>void)|undefined;
 try{
  await mkdir(source);execFileSync('git',['init','-q',source]);await writeFile(join(source,'file'),'source');execFileSync('git',['-C',source,'add','file']);execFileSync('git',['-C',source,'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','Initial']);
  store=new ManagedWorktrees({homeDir,profileId});await new WorkspaceTrustStore({homeDir}).grant(source);
  const target=await store.create(await store.review(targetBinding(await store.acquireLocal(source))),true);
  release=await store.borrow(targetBinding(target));
  const container=await DockerContainer.prepare({client,profileId,homeDir,workspaceRoot:target.workspace.canonicalPath,policy});
  environment=HostEnvironment.prepared(profileId,container.facts,{files:(active:any,processes:any)=>new DockerWorkspaceFiles(container,active,processes,homeDir),processes:()=>new DockerProcessScope(container,homeDir),dispose:()=>container.release()});
  lease=environment.acquire({profileId,sessionId:'worktree-gate',surface:'test'});
  assert.equal(await lease.files.readFile('file','utf8'),'source');await lease.files.writeFile('file','worktree');
  assert.equal(await readFile(join(source,'file'),'utf8'),'source');assert.equal(await readFile(join(target.workspace.canonicalPath,'file'),'utf8'),'worktree');
  const child=lease.processes.spawn('python3',['-c',`import os; assert not os.path.exists(${JSON.stringify(source)}); assert not os.path.exists(${JSON.stringify(join(homeDir,'.estacoda'))})`]);
  const exit=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});await lease.processes.terminate(child);assert.equal(exit,0);
  await lease.release();lease=undefined;await environment.destroy();environment=undefined;release();release=undefined;
  const archived=store.archive({targetId:target.id,targetGeneration:1});await assert.rejects(store.cleanup({targetId:target.id,targetGeneration:archived.generation}),/Dirty/);
  console.log('PASS: managed worktree Docker files/commands use the working root; source and runtime state remain outside the mount; dirty cleanup refused');
 }finally{await lease?.release();await environment?.destroy();release?.();store?.close();await rm(homeDir,{recursive:true,force:true});}
}
