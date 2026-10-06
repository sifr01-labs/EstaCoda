import {it,expect} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PublicSettings} from './public-settings.js';
import {CredentialCandidates} from './credential-candidates.js';
import {resolveProfileStateHome} from '../config/profile-home.js';
import {loadRuntimeConfig} from '../config/runtime-config.js';

it('reviews routing and protected credentials, isolates profiles, and preserves the conversation model',async()=>{
 const homeDir=await mkdtemp(join(tmpdir(),'ec-routing-')),input={homeDir,profileId:'p'},paths=resolveProfileStateHome(input),sibling=resolveProfileStateHome({...input,profileId:'q'});
 const candidates=new CredentialCandidates('p','instance'),owner=new PublicSettings(input,candidates),binding={windowId:'w',generation:1};
 const original=JSON.stringify({model:{provider:'local',id:'local-test-model'},routing:{jev:{timeoutMs:9000}}});
 try{
  await mkdir(paths.profileRoot,{recursive:true});await mkdir(sibling.profileRoot,{recursive:true});await writeFile(paths.configPath,original);await writeFile(sibling.configPath,'{}');
  const fieldId='routing.jev.apiKeyEnv',candidate=candidates.stage(owner.scope(binding,fieldId),'private-jev-fixture');
  const review=await owner.review({...binding,changes:[{fieldId:'routing.mode',selectors:[],value:'jev-assisted'},{fieldId:'routing.jev.id',selectors:[],value:'jev-1.13.0'},{fieldId,selectors:[],value:candidate}]});
  expect(JSON.stringify(review)).not.toContain('private-jev-fixture');expect(await readFile(paths.configPath,'utf8')).toBe(original);
  expect((await owner.apply({...binding,draftId:review.draftId},new AbortController().signal)).state).toBe('applied');
  const config=JSON.parse(await readFile(paths.configPath,'utf8'));
  expect(config.model).toEqual(JSON.parse(original).model);expect(config.routing).toMatchObject({mode:'jev-assisted',jev:{id:'jev-1.13.0',timeoutMs:9000}});
  expect(config.routing.jev.apiKeyEnv).toMatch(/^ESTACODA_CREDENTIAL_/);expect(JSON.stringify(config)).not.toContain('private-jev-fixture');expect(await readFile(paths.envPath,'utf8')).toContain('private-jev-fixture');
  const page=await owner.read('runtime');expect(JSON.stringify(page)).not.toContain(config.routing.jev.apiKeyEnv);expect(JSON.stringify(page)).not.toContain('private-jev-fixture');expect(page.runtime?.effective.find(c=>c.fieldId===fieldId)?.value).toBe('configured');expect(page.runtime?.routingModels).toContainEqual({id:'jev-1.13.0',label:'Jev 1.13'});
  expect((await owner.value({fieldId,selectors:[]})).value).toBe('configured');
  const off=await owner.review({...binding,changes:[{fieldId:'routing.mode',selectors:[],value:'standard'}]});await owner.apply({...binding,draftId:off.draftId},new AbortController().signal);
  const loaded=await loadRuntimeConfig({...input,workspaceRoot:homeDir,configurationInspection:true});expect(loaded.routing.mode).toBe('standard');expect(loaded.routing.jev).toEqual(config.routing.jev.provider?config.routing.jev:{...config.routing.jev,provider:'typesafe'});
  expect(await readFile(sibling.configPath,'utf8')).toBe('{}');
  const before=await readFile(paths.configPath,'utf8'),envBefore=await readFile(paths.envPath,'utf8');
  const staged=candidates.stage(owner.scope(binding,fieldId),'cancelled-fixture');const cancelled=await owner.review({...binding,changes:[{fieldId,selectors:[],value:staged}]});expect(owner.cancel({...binding,draftId:cancelled.draftId}).cancelled).toBe(true);
  expect(await readFile(paths.configPath,'utf8')).toBe(before);expect(await readFile(paths.envPath,'utf8')).toBe(envBefore);
  const invalid=await owner.review({...binding,changes:[{fieldId:'routing.jev.id',selectors:[],value:'not-a-jev-model'}]});await owner.apply({...binding,draftId:invalid.draftId},new AbortController().signal).catch(()=>{});expect(await readFile(paths.configPath,'utf8')).toBe(before);
 }finally{owner.dispose();candidates.dispose();await rm(homeDir,{recursive:true,force:true});}
});
