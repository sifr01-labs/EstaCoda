import {it,expect} from 'vitest';
import {mkdtemp,rm,readdir,writeFile,mkdir,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {detectOnboarding,bootstrapOnboarding} from './onboarding-detection.js';
import {resolveProfileStateHome,resolveGlobalStateHome} from '../config/profile-home.js';
import {SettingsActions} from './settings-actions.js';
import {readFile} from 'node:fs/promises';
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

it('also detects a read-only selected profile under otherwise writable global state',async()=>{
 const {chmod}=await import('node:fs/promises');const homeDir=await mkdtemp(join(tmpdir(),'ec-onboard-profile-ro-')),input={homeDir,profileId:'default'},root=resolveProfileStateHome(input).profileRoot;
 try{await mkdir(root,{recursive:true});await chmod(root,0o500);expect(await detectOnboarding(input)).toMatchObject({state:'state-not-writable',writable:false,launchReady:false});await expect(bootstrapOnboarding(input)).rejects.toThrow();expect(await readdir(root)).toEqual([]);}finally{await chmod(root,0o700);await rm(homeDir,{recursive:true,force:true});}
});

it('starts a reviewed separate setup without clearing existing credentials or selecting a CLI default',async()=>{
 const homeDir=await mkdtemp('/tmp/ec-separate-'),input={homeDir,profileId:'default'},paths=resolveProfileStateHome(input);
 try {
  await mkdir(paths.profileRoot,{recursive:true});await writeFile(paths.configPath,'{"model":{"provider":"existing","id":"model"}}');await writeFile(paths.envPath,'KEEP=synthetic\n');
  const actions=new SettingsActions(input),review=await actions.review({action:'profile.create',subject:'desktop',value:''});
  expect((await detectOnboarding({...input,profileId:'desktop'})).mode).toBe('first-run');
  await expect(bootstrapOnboarding({...input,profileId:'desktop'})).rejects.toThrow();
  expect((await actions.execute({reviewId:review.reviewId,operationId:'separate',confirmed:true})).state).toBe('completed');
  expect((await bootstrapOnboarding({...input,profileId:'desktop'})).mode).toBe('first-run');
  expect(await readFile(paths.envPath,'utf8')).toBe('KEEP=synthetic\n');
  expect(await readFile(paths.configPath,'utf8')).toBe('{"model":{"provider":"existing","id":"model"}}');
  expect(await readdir(resolveGlobalStateHome(input).stateRoot)).not.toContain('active-profile.json');
  await expect(actions.review({action:'profile.create',subject:'default',value:''})).rejects.toThrow();
 } finally {await rm(homeDir,{recursive:true,force:true});}
});
