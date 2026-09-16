import {it,expect} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PUBLIC_SETTINGS} from '../setup/public-settings.js';
import {runtimeSettingsMetadata} from './runtime-settings-metadata.js';
import {resolveProfileStateHome} from '../config/profile-home.js';
import {PublicSettings} from './public-settings.js';
import {CredentialCandidates} from './credential-candidates.js';
import {validateControlRequest,validateControlResponse} from '../contracts/desktop-control/index.js';
const fields=PUBLIC_SETTINGS.filter(f=>f.section==='runtime');
it('projects real defaults and preserves requested controls without claiming enforcement',()=>{
 const meta=runtimeSettingsMetadata({ui:{language:'ar'},execution:{backend:'host',workspaceAccess:{value:'read-only',requirement:'mandatory'}}},fields);
 const value=(id:string)=>meta.effective.find(c=>c.fieldId===id)?.value;
 expect(value('ui.flavor')).toBe('arabic-light');expect(value('ui.activityLabels')).toBe('ar');expect(value('ui.showResponseProgress')).toBe(false);expect(value('profile.mode')).toBe('builder');
 expect(value('execution.workspaceAccess.value')).toBe('read-only');expect(value('execution.workspaceAccess.requirement')).toBe('mandatory');expect(value('execution.limits.value.memoryBytes')).toBeNull();
 const docker=runtimeSettingsMetadata({execution:{backend:'docker',imageId:'sha256:'+'a'.repeat(64),limits:{requirement:'mandatory',value:{memoryBytes:1024*1024*1024}}}},fields);
 expect(docker.effective.find(c=>c.fieldId==='execution.limits.value.memoryBytes')?.value).toBe(1024*1024*1024);expect(docker.effective.find(c=>c.fieldId==='execution.limits.value.cpu')?.value).toBe(1);
});
it('accepts each real runtime settings page at the strict protocol boundary without leaking unrelated config',async()=>{
 const homeDir=await mkdtemp(join(tmpdir(),'ec-runtime-metadata-')),input={homeDir,profileId:'default'},paths=resolveProfileStateHome(input),candidates=new CredentialCandidates('default','test'),owner=new PublicSettings(input,candidates);
 try{await mkdir(paths.profileRoot,{recursive:true});const config=JSON.stringify({ui:{language:'ar'},channels:{telegram:{botTokenEnv:'PRIVATE_REFERENCE'}}});await writeFile(paths.configPath,config);
 let offset:number|undefined=0,count=0;
 do{const page=await owner.read('runtime',offset);expect(page.runtime).toBeDefined();const context={profileId:'default',instanceId:'test',capabilities:{methods:['settings.read'] as Array<'settings.read'>,events:[]}},request=validateControlRequest({jsonrpc:'2.0',id:'r',method:'settings.read',params:{section:'runtime',offset}},context);
 expect(()=>validateControlResponse({jsonrpc:'2.0',id:'r',result:page},request,context)).not.toThrow();expect(JSON.stringify(page)).not.toContain('PRIVATE_REFERENCE');expect(()=>validateControlResponse({jsonrpc:'2.0',id:'r',result:{...page,runtime:{...page.runtime,secret:'x'}}},request,context)).toThrow();count+=page.fields.length;offset=page.nextOffset;}while(offset!==undefined);
 expect(count).toBe(fields.length);expect(await readFile(paths.configPath,'utf8')).toBe(config);
 }finally{owner.dispose();candidates.dispose();await rm(homeDir,{recursive:true,force:true});}
});
