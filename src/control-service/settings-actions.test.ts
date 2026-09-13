import {it,expect} from 'vitest';
import {mkdtemp,mkdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {SettingsActions} from './settings-actions.js';
import {ensureProfileSkeleton} from '../cli/profile-state.js';
import {WorkspaceTrustStore} from '../security/workspace-trust-store.js';
import {resolveProfileStateHome,readActiveProfile} from '../config/profile-home.js';
it('separates registration, cancellation, trust and removal while preserving files',async()=>{
 const home=await mkdtemp(join(tmpdir(),'settings-actions-'));try{
 await ensureProfileSkeleton({homeDir:home,profileId:'default',blank:true});const dir=join(home,'repo');await mkdir(dir);const actions=new SettingsActions({homeDir:home,profileId:'default'}),trust=new WorkspaceTrustStore({homeDir:home});
 const cancelled=await actions.review({action:'workspace.add',subject:'repo',value:dir});actions.cancel(cancelled.reviewId);await expect(actions.execute({reviewId:cancelled.reviewId,operationId:'cancelled',confirmed:true})).rejects.toThrow();expect((await actions.workspaces()).items).toEqual([]);
 const add=await actions.review({action:'workspace.add',subject:'repo',value:dir});expect((await actions.execute({reviewId:add.reviewId,operationId:'add',confirmed:true})).state).toBe('completed');expect(await trust.isTrusted(dir)).toBe(false);
 const grant=await actions.review({action:'workspace.trust',subject:'repo',value:''});await actions.execute({reviewId:grant.reviewId,operationId:'grant',confirmed:true});expect(await trust.isTrusted(dir)).toBe(true);
 const stale=await actions.review({action:'workspace.remove',subject:'repo',value:''});const rename=await actions.review({action:'workspace.rename',subject:'repo',value:'renamed'});await actions.execute({reviewId:rename.reviewId,operationId:'rename',confirmed:true});await expect(actions.execute({reviewId:stale.reviewId,operationId:'stale',confirmed:true})).rejects.toThrow();
 }finally{await rm(home,{recursive:true,force:true});}
});
it('creates a credential-free profile without changing the CLI default',async()=>{const home=await mkdtemp(join(tmpdir(),'settings-profile-'));try{await ensureProfileSkeleton({homeDir:home,profileId:'default',blank:true});const actions=new SettingsActions({homeDir:home,profileId:'default'}),before=readActiveProfile({homeDir:home});const review=await actions.review({action:'profile.create',subject:'new',value:''});expect((await actions.execute({reviewId:review.reviewId,operationId:'create',confirmed:true})).state).toBe('completed');expect(readActiveProfile({homeDir:home})).toEqual(before);expect(await readFile(resolveProfileStateHome({homeDir:home,profileId:'new'}).envPath,'utf8')).toBe('');await expect(actions.review({action:'profile.create',subject:'../escape',value:''})).rejects.toThrow();}finally{await rm(home,{recursive:true,force:true});}});
