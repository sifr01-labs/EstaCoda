import {it,expect} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {resolveProfileStateHome} from '../../config/profile-home.js';
import {applyPublicSettings} from './public-settings-apply.js';
import {parseExecutionPolicy} from '../../execution/docker-policy.js';
import {runtimeSettings} from '../public-settings-runtime.js';
it('clears explicitly reset Docker controls on a reviewed host transition',async()=>{
 const homeDir=await mkdtemp(join(tmpdir(),'ec-runtime-apply-')),input={homeDir,profileId:'default'},paths=resolveProfileStateHome(input);
 try{await mkdir(paths.profileRoot,{recursive:true});await writeFile(paths.configPath,JSON.stringify({execution:{backend:'docker',imageId:'sha256:'+'a'.repeat(64),limits:{requirement:'mandatory',value:{cpu:1}},credentialCapabilities:{value:[],requirement:'mandatory'}},ui:{language:'ar'}}));
 await applyPublicSettings(runtimeSettings.map(f=>({fieldId:f.id,selectors:[],value:f.id==='execution.backend'?'host':null})),input);
 const config=JSON.parse(await readFile(paths.configPath,'utf8'));expect(parseExecutionPolicy(config.execution)).toEqual({backend:'host'});expect(config.ui.language).toBe('ar');
 }finally{await rm(homeDir,{recursive:true,force:true});}
});
