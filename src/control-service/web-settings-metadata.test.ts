import {validateControlRequest,validateControlResponse,parseControlFrame,serializeControlFrame} from '../contracts/desktop-control/index.js';
import {it,expect,vi} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {resolveProfileStateHome} from '../config/profile-home.js';
import {CredentialCandidates} from './credential-candidates.js';
import {PublicSettings} from './public-settings.js';

it('projects effective web policy and selected-profile credentials without network or writes',async()=>{
 const homeDir=await mkdtemp(join(tmpdir(),'ec-web-settings-')),input={homeDir,profileId:'default'},paths=resolveProfileStateHome(input),candidates=new CredentialCandidates('default','instance'),owner=new PublicSettings(input,candidates);
 const fetch=vi.spyOn(globalThis,'fetch').mockRejectedValue(new Error('Network forbidden'));
 try{
  await mkdir(paths.profileRoot,{recursive:true});const config=JSON.stringify({browser:{backend:'local-cdp',headless:false,allowPrivateUrls:true},security:{allowPrivateUrls:false},web:{brave:{apiKeyEnv:'WEB_PRIVATE_TEST'}}});await writeFile(paths.configPath,config);await writeFile(paths.envPath,'WEB_PRIVATE_TEST="private-value-never-rendered"\nBROWSERBASE_PROJECT_ID="private-project"\n');
  let offset:number|undefined=0;const effective=new Map(),defaults=new Map();
  do{const page=await owner.read('browser',offset);expect(page.web).toBeDefined();const context={profileId:'default',instanceId:'test',capabilities:{methods:['settings.read'] as Array<'settings.read'>,events:[]}};const request=validateControlRequest({jsonrpc:'2.0',id:'read',method:'settings.read',params:{section:'browser',offset}},context);expect(()=>validateControlResponse(parseControlFrame(serializeControlFrame({jsonrpc:'2.0',id:'read',result:page})),request,context)).not.toThrow();expect(JSON.stringify(page)).not.toMatch(/private-value-never-rendered|private-project|WEB_PRIVATE_TEST/);for(const c of page.web!.effective)effective.set(c.fieldId,c.value);for(const c of page.web!.defaults)defaults.set(c.fieldId,c.value);if(offset===0){expect(page.web!.resolvedSearch).toBe('brave');expect(page.web!.searchProviders?.find(p=>p.id==='tavily')).toMatchObject({implemented:false,available:false});}offset=page.nextOffset;}while(offset!==undefined);
  expect(effective.get('web.brave.apiKeyEnv')).toBe('configured');expect(effective.get('browserbase.projectId')).toBe('configured');expect(effective.get('browser.supervised')).toBe(true);expect(effective.get('browser.headless')).toBe(false);expect(defaults.get('browser.headless')).toBe(true);expect(effective.get('security.allowPrivateUrls')).toBe(false);expect(defaults.get('security.allowPrivateUrls')).toBe(true);expect(fetch).not.toHaveBeenCalled();expect(await readFile(paths.configPath,'utf8')).toBe(config);
  const other=new PublicSettings({...input,profileId:'other'},candidates);try{const page=await other.read('browser');expect(page.web?.searchProviders?.find(p=>p.id==='brave')?.available).toBe(false);}finally{other.dispose();}
 }finally{fetch.mockRestore();owner.dispose();candidates.dispose();await rm(homeDir,{recursive:true,force:true});}
});
