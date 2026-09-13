import {it,expect} from 'vitest';
import {mkdtemp,rm,readdir,writeFile,mkdir,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {detectOnboarding,bootstrapOnboarding} from './onboarding-detection.js';
import {resolveProfileStateHome,resolveGlobalStateHome} from '../config/profile-home.js';
it('detects without writing and bootstraps only directories without committing setup or the active pointer',async()=>{
 const homeDir=await mkdtemp(join(tmpdir(),'ec-onboard-')),input={homeDir,profileId:'default'};
 try{expect((await detectOnboarding(input)).mode).toBe('first-run');expect(await readdir(homeDir)).toEqual([]);expect((await bootstrapOnboarding(input)).mode).toBe('first-run');expect(await readdir(resolveProfileStateHome(input).profileRoot)).toEqual([]);expect(await readdir(resolveGlobalStateHome(input).stateRoot)).not.toContain('active-profile.json');}finally{await rm(homeDir,{recursive:true,force:true});}
});
it('preserves existing malformed configuration, pointer and non-default profile ownership',async()=>{
 const homeDir=await mkdtemp(join(tmpdir(),'ec-onboard-')),input={homeDir,profileId:'default'},paths=resolveProfileStateHome(input);
 try{await mkdir(paths.profileRoot,{recursive:true});await writeFile(paths.configPath,'{');expect((await detectOnboarding(input)).mode).toBe('repair');await expect(bootstrapOnboarding(input)).rejects.toThrow();await expect(bootstrapOnboarding({...input,profileId:'other'})).rejects.toThrow();}finally{await rm(homeDir,{recursive:true,force:true});}
});
it('rejects a linked default profile',async()=>{
 const homeDir=await mkdtemp(join(tmpdir(),'ec-onboard-')),input={homeDir,profileId:'default'},paths=resolveProfileStateHome(input);
 try{await mkdir(join(homeDir,'.estacoda/profiles'),{recursive:true});await mkdir(join(homeDir,'elsewhere'));await symlink(join(homeDir,'elsewhere'),paths.profileRoot);await expect(bootstrapOnboarding(input)).rejects.toThrow();expect(await readdir(join(homeDir,'elsewhere'))).toEqual([]);}finally{await rm(homeDir,{recursive:true,force:true});}
});
it('reports unwritable state without attempting setup or changing files',async()=>{
 const {chmod}=await import('node:fs/promises');const homeDir=await mkdtemp(join(tmpdir(),'ec-onboard-ro-')),input={homeDir,profileId:'default'},root=resolveGlobalStateHome(input).stateRoot;
 try{await mkdir(root);await chmod(root,0o500);const result=await detectOnboarding(input);expect(result.state).toBe('state-not-writable');expect(result.writable).toBe(false);await expect(bootstrapOnboarding(input)).rejects.toThrow();expect(await readdir(root)).toEqual([]);}finally{await chmod(root,0o700);await rm(homeDir,{recursive:true,force:true});}
});
