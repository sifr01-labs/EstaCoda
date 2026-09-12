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
