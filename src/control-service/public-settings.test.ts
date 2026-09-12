import {it,expect} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {PublicSettings} from './public-settings.js';import {CredentialCandidates} from './credential-candidates.js';
import {resolveProfileStateHome} from '../config/profile-home.js';
it('projects only registered values and binds read-only review/cancel to one window and profile',async()=>{
 const homeDir=await mkdtemp(join(tmpdir(),'ec-settings-')),input={homeDir,profileId:'default'},paths=resolveProfileStateHome(input),candidates=new CredentialCandidates('default','instance'),owner=new PublicSettings(input,candidates);
 try{await mkdir(paths.profileRoot,{recursive:true});const original=JSON.stringify({ui:{language:'en'},providers:{private:{headers:{Authorization:'secret-not-for-renderer'}}}});await writeFile(paths.configPath,original);
 const page=await owner.read('runtime');expect(JSON.stringify(page)).not.toContain('secret-not-for-renderer');expect(page.values.find(v=>v.fieldId==='ui.language')?.value).toBe('en');
 const params={windowId:'window',generation:1,changes:[{fieldId:'ui.language',selectors:[],value:'ar'}]},review=await owner.review(params);expect(review.previous[0]?.value).toBe('en');expect(await readFile(paths.configPath,'utf8')).toBe(original);
 expect(()=>owner.cancel({draftId:review.draftId,windowId:'other',generation:1})).toThrow();expect(owner.cancel({...params,draftId:review.draftId})).toEqual({cancelled:true});
 await expect(owner.review({...params,changes:[{fieldId:'providers.private.headers.Authorization',selectors:[],value:'no'}]})).rejects.toThrow();
 await expect(owner.review({...params,changes:[{fieldId:'ui.language',selectors:[],value:'fr'}]})).rejects.toThrow();
 const next=await owner.review(params);candidates.closeWindow('window',1);expect(()=>owner.require({...params,draftId:next.draftId})).toThrow();
 }finally{owner.dispose();candidates.dispose();await rm(homeDir,{recursive:true,force:true});}
});
it('uses the recoverable profile transaction, rejects stale review and keeps candidate secrets out of projections',async()=>{
 const homeDir=await mkdtemp(join(tmpdir(),'ec-settings-')),input={homeDir,profileId:'default'},paths=resolveProfileStateHome(input),candidates=new CredentialCandidates('default','instance'),owner=new PublicSettings(input,candidates);
 try{await mkdir(paths.profileRoot,{recursive:true});await writeFile(paths.configPath,JSON.stringify({ui:{language:'en'},profile:{mode:'focused'}}));
 const binding={windowId:'w',generation:1};const review=await owner.review({...binding,changes:[{fieldId:'ui.language',selectors:[],value:'ar'}]});
 expect((await owner.apply({...binding,draftId:review.draftId},new AbortController().signal)).state).toBe('applied');expect(JSON.parse(await readFile(paths.configPath,'utf8')).ui.language).toBe('ar');expect((await owner.inspect(review.draftId)).state).toBe('applied');
 const stale=await owner.review({...binding,changes:[{fieldId:'ui.language',selectors:[],value:'en'}]});await writeFile(paths.configPath,JSON.stringify({ui:{language:'ar'},profile:{mode:'builder'}}));await expect(owner.apply({...binding,draftId:stale.draftId},new AbortController().signal)).rejects.toThrow('Profile changed');owner.cancel({...binding,draftId:stale.draftId});
 const id=candidates.stage(owner.scope(binding,'web.brave.apiKeyEnv'),'private-test-value');const credential=await owner.review({...binding,changes:[{fieldId:'web.brave.apiKeyEnv',selectors:[],value:id}]});expect(JSON.stringify(credential)).not.toContain(id);expect(JSON.stringify(credential)).not.toContain('private-test-value');
 expect((await owner.apply({...binding,draftId:credential.draftId},new AbortController().signal)).state).toBe('applied');const config=JSON.parse(await readFile(paths.configPath,'utf8'));expect(config.web.brave.apiKeyEnv).toMatch(/^ESTACODA_CREDENTIAL_/);expect(await readFile(paths.envPath,'utf8')).toContain('private-test-value');expect(JSON.stringify(await owner.read('browser'))).not.toContain('private-test-value');
 expect(()=>candidates.read(id,owner.scope(binding,'web.brave.apiKeyEnv'))).toThrow();expect((await owner.verify()).state).toBe('configured');
 const discard=candidates.stage(owner.scope(binding,'web.brave.apiKeyEnv'),'cancelled-test-value');const cancelled=await owner.review({...binding,changes:[{fieldId:'web.brave.apiKeyEnv',selectors:[],value:discard}]});owner.cancel({...binding,draftId:cancelled.draftId});expect(()=>candidates.read(discard,owner.scope(binding,'web.brave.apiKeyEnv'))).toThrow();expect(await readFile(paths.envPath,'utf8')).not.toContain('cancelled-test-value');
 }finally{owner.dispose();candidates.dispose();await rm(homeDir,{recursive:true,force:true});}
});
it('round trips public specialist options and pages every registered model setting',async()=>{
 const homeDir=await mkdtemp(join(tmpdir(),'ec-settings-')),input={homeDir,profileId:'default'},paths=resolveProfileStateHome(input),candidates=new CredentialCandidates('default','instance'),owner=new PublicSettings(input,candidates);
 try{await mkdir(paths.profileRoot,{recursive:true});await writeFile(paths.configPath,JSON.stringify({auxiliaryModels:{compression:'local/test-model'}}));const first=await owner.read('models');expect(first.nextOffset).toBe(100);const second=await owner.read('models',first.nextOffset);expect(second.fields.some(f=>f.id==='auxiliaryModels.profile_context.timeoutMs')).toBe(true);
 const binding={windowId:'w',generation:1};const review=await owner.review({...binding,changes:[{fieldId:'auxiliaryModels.compression.timeoutMs',selectors:[],value:12000},{fieldId:'model.maxTokens',selectors:[],value:4096}]});await owner.apply({...binding,draftId:review.draftId},new AbortController().signal);const config=JSON.parse(await readFile(paths.configPath,'utf8'));expect(config.auxiliaryModels.compression).toMatchObject({provider:'local',id:'test-model',timeoutMs:12000});expect((await owner.value({fieldId:'model.maxTokens',selectors:[]})).value).toBe(4096);
 await expect(owner.review({...binding,changes:[{fieldId:'providers.*.baseUrl',selectors:['test'],value:'https://user:secret@example.com'}]})).rejects.toThrow();
 }finally{owner.dispose();candidates.dispose();await rm(homeDir,{recursive:true,force:true});}
});
