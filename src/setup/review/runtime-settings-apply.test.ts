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

it('saves run limits without changing execution authority and rejects unlimited unattended work',async()=>{
 const homeDir=await mkdtemp(join(tmpdir(),'ec-run-settings-')),input={homeDir,profileId:'default'},paths=resolveProfileStateHome(input);
 try{await mkdir(paths.profileRoot,{recursive:true});await writeFile(paths.configPath,JSON.stringify({execution:{backend:'host'},security:{mode:'strict'}}));
 await applyPublicSettings([{fieldId:'runLimits.interactive.maxIterations',selectors:[],value:0},{fieldId:'runLimits.unattended.maxIterations',selectors:[],value:120}],input);
 const saved=await readFile(paths.configPath,'utf8'),config=JSON.parse(saved);expect(config.runLimits).toEqual({interactive:{maxIterations:0},unattended:{maxIterations:120}});expect(config.security.mode).toBe('strict');expect(config.execution.backend).toBe('host');
 await expect(applyPublicSettings([{fieldId:'runLimits.unattended.maxIterations',selectors:[],value:0}],input)).rejects.toThrow();expect(await readFile(paths.configPath,'utf8')).toBe(saved);
 }finally{await rm(homeDir,{recursive:true,force:true});}
});
