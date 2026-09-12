import {it,expect} from 'vitest';
import {mkdtemp,mkdir,rm,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {ExecutionTargetStore} from '../workspaces/execution-target.js';
import {WorkspaceTrustStore} from '../security/workspace-trust-store.js';
import {TerminalCapabilities} from './terminal-capabilities.js';
it('issues bridge-owned capabilities only for trusted current targets and revokes stale use',async()=>{
 const homeDir=await realpath(await mkdtemp('/tmp/ec-terminal-cap-')),root=join(homeDir,'repo'),input={homeDir,profileId:'p'};await mkdir(root);
 const store=new ExecutionTargetStore(input),caps=new TerminalCapabilities(input),signal=new AbortController().signal;
 try{
  const record=await store.acquireLocal(root),target={targetId:record.id,targetGeneration:1};
  await expect(caps.acquire(target,signal)).rejects.toThrow('trust');await new WorkspaceTrustStore(input).grant(root);
  const value=await caps.acquire(target,signal);expect(value).toMatchObject({target,workingRoot:root,backend:'host',container:null});
  await expect(new TerminalCapabilities(input).verify(value.capabilityId,signal)).rejects.toThrow();
  expect((await caps.verify(value.capabilityId,signal)).expiresAt).toBeGreaterThan(Date.now());
  expect(await caps.release(value.capabilityId)).toEqual({released:true});await expect(caps.verify(value.capabilityId,signal)).rejects.toThrow();
  await expect(caps.acquire({...target,targetGeneration:2},signal)).rejects.toThrow();
 }finally{caps.dispose();store.close();await rm(homeDir,{recursive:true,force:true});}
});
it('revokes replacement and expired targets while retaining cleanup guards until explicit settlement',async()=>{
 const {rename}=await import('node:fs/promises'),{vi}=await import('vitest'),{ManagedWorktrees}=await import('../workspaces/managed-worktrees.js');
 const homeDir=await realpath(await mkdtemp('/tmp/ec-cap-fence-')),root=join(homeDir,'repo'),input={homeDir,profileId:'p'};await mkdir(root);
 const store=new ManagedWorktrees(input),caps=new TerminalCapabilities(input),signal=new AbortController().signal;
 try{
  const record=await store.acquireLocal(root),target={targetId:record.id,targetGeneration:1};await new WorkspaceTrustStore(input).grant(root);
  const cap=await caps.acquire(target,signal);expect(store.borrowers(target.targetId)).toBe(1);
  const now=vi.spyOn(Date,'now').mockReturnValue(cap.expiresAt+1);try{await expect(caps.verify(cap.capabilityId,signal)).rejects.toThrow('expired');}finally{now.mockRestore();}
  expect(store.borrowers(target.targetId)).toBe(1);await caps.release(cap.capabilityId);expect(store.borrowers(target.targetId)).toBe(0);
  const replacement=await caps.acquire(target,signal);await rename(root,root+'-old');await mkdir(root);
  await expect(caps.verify(replacement.capabilityId,signal)).rejects.toThrow('directory changed');await caps.release(replacement.capabilityId);
  const disconnected=await caps.acquire(target,signal);caps.dispose();expect(store.borrowers(target.targetId)).toBe(1);await expect(caps.verify(disconnected.capabilityId,signal)).rejects.toThrow();
 }finally{caps.dispose();store.close();await rm(homeDir,{recursive:true,force:true});}
});
