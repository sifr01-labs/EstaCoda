import {it,expect} from 'vitest';import {mkdtemp,mkdir,rm,readdir,rename} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {OnboardingWorkspace} from './onboarding-workspace.js';import {WorkspaceRegistry} from '../workspaces/workspace-registry.js';import {WorkspaceTrustStore} from '../security/workspace-trust-store.js';import {resolveProfileStateHome} from '../config/profile-home.js';
it('keeps review inert and supports registration with deferred trust, explicit trust and cancellation',async()=>{
 const homeDir=await mkdtemp(join(tmpdir(),'ec-onboard-ws-')),input={homeDir,profileId:'default'},owner=new OnboardingWorkspace(input);await mkdir(join(homeDir,'work'));await mkdir(resolveProfileStateHome(input).profileRoot,{recursive:true});
 try{let r=await owner.review({path:join(homeDir,'work'),alias:'work',trust:true});expect(await readdir(resolveProfileStateHome(input).profileRoot)).toEqual([]);owner.cancel(r.reviewId);await expect(owner.apply({reviewId:r.reviewId,operationId:'cancel',confirmed:true})).rejects.toThrow();expect(await new WorkspaceTrustStore(input).isTrusted(join(homeDir,'work'))).toBe(false);
 r=await owner.review({path:join(homeDir,'work'),alias:'work',trust:false});expect((await owner.apply({reviewId:r.reviewId,operationId:'defer',confirmed:true})).state).toBe('completed');expect(await new WorkspaceTrustStore(input).isTrusted(join(homeDir,'work'))).toBe(false);
 r=await owner.review({path:join(homeDir,'work'),alias:'work',trust:true});expect((await owner.apply({reviewId:r.reviewId,operationId:'trust',confirmed:true})).state).toBe('completed');expect(await new WorkspaceTrustStore(input).isTrusted(join(homeDir,'work'))).toBe(true);const registry=new WorkspaceRegistry(input);try{expect(registry.list()).toHaveLength(1);}finally{registry.close();}
 }finally{owner.dispose();await rm(homeDir,{recursive:true,force:true});}
});
it('rejects a selected directory replaced after review',async()=>{
 const homeDir=await mkdtemp(join(tmpdir(),'ec-onboard-ws-')),input={homeDir,profileId:'default'},owner=new OnboardingWorkspace(input);await mkdir(join(homeDir,'work'));
 try{const r=await owner.review({path:join(homeDir,'work'),alias:'work',trust:true});await rename(join(homeDir,'work'),join(homeDir,'old'));await mkdir(join(homeDir,'work'));await expect(owner.apply({reviewId:r.reviewId,operationId:'stale',confirmed:true})).rejects.toThrow();expect(await new WorkspaceTrustStore(input).isTrusted(join(homeDir,'work'))).toBe(false);}finally{owner.dispose();await rm(homeDir,{recursive:true,force:true});}
});
