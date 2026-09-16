import {it,expect} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {resolveProfileStateHome} from '../config/profile-home.js';
import {CredentialCandidates} from './credential-candidates.js';
import {PublicSettings} from './public-settings.js';

it('projects normalized media defaults and credential presence without leaking values or mutating the profile',async()=>{
 const homeDir=await mkdtemp(join(tmpdir(),'ec-media-settings-')),input={homeDir,profileId:'default'},paths=resolveProfileStateHome(input),candidates=new CredentialCandidates('default','instance'),owner=new PublicSettings(input,candidates);
 try{
  await mkdir(paths.profileRoot,{recursive:true});
  const config=JSON.stringify({tts:{provider:'openai',speed:1.5,openai:{apiKeyEnv:'MEDIA_TEST_PRIVATE'}},stt:{provider:'xai',xai:{diarization:true,language:'ar'}}});
  await writeFile(paths.configPath,config);await writeFile(paths.envPath,'MEDIA_TEST_PRIVATE="never-send-this-value"\n');
  const effective=new Map(),defaults=new Map();let offset:number|undefined=0;
  do{const page=await owner.read('voice',offset);expect(page.media).toBeDefined();expect(JSON.stringify(page)).not.toContain('never-send-this-value');expect(JSON.stringify(page)).not.toContain('MEDIA_TEST_PRIVATE');for(const c of page.media!.effective)effective.set(c.fieldId,c.value);for(const c of page.media!.defaults)defaults.set(c.fieldId,c.value);offset=page.nextOffset;}while(offset!==undefined);
  expect(effective.get('tts.openai.apiKeyEnv')).toBe('configured');expect(effective.get('tts.openai.speed')).toBe(1.5);expect(defaults.get('tts.openai.speed')).toBe(1);expect(effective.get('stt.xai.diarize')).toBe(true);expect(effective.get('stt.xai.language')).toBe('ar');
  const images=await owner.read('vision');expect(images.media?.imageModels?.some(m=>m.providerId==='openai')).toBe(true);expect(images.media?.effective.find(v=>v.fieldId==='imageGen.provider')?.value).toBe('fal');
  expect(await readFile(paths.configPath,'utf8')).toBe(config);
 }finally{owner.dispose();candidates.dispose();await rm(homeDir,{recursive:true,force:true});}
});
