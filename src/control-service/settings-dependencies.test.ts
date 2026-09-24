import {it,expect,vi} from 'vitest';import {mkdtemp,mkdir,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {resolveProfileStateHome} from '../config/profile-home.js';import {SettingsDependencies} from './settings-dependencies.js';
it('installs only explicitly approved registered packages and never repeats an uncertain operation',async()=>{
 const homeDir=await mkdtemp(join(tmpdir(),'ec-dependency-')),input={homeDir,profileId:'default'};let finish!:(v:any)=>void;const install=vi.fn((_input:unknown)=>new Promise<any>(r=>{finish=r;})),owner=new SettingsDependencies(input,install);
 try{await mkdir(resolveProfileStateHome(input).profileRoot,{recursive:true});const request={operationId:'00000000-0000-0000-0000-000000000001',capabilityId:'edge-tts',groups:[],downloadApproved:true as const};await expect(owner.start({...request,downloadApproved:false as true})).rejects.toThrow();await expect(owner.start({...request,capabilityId:'arbitrary-package'})).rejects.toThrow();await expect(owner.start({...request,groups:['arbitrary-group']})).rejects.toThrow();expect(install).not.toHaveBeenCalled();
 expect((await owner.start(request)).state).toBe('uncertain');await owner.start(request);expect(install).toHaveBeenCalledTimes(1);expect(install.mock.calls[0]![0]).not.toHaveProperty('packages');finish({ok:true});await vi.waitFor(async()=>expect((await owner.inspect(request.operationId)).state).toBe('completed'));const restarted=new SettingsDependencies(input,install);await restarted.start(request);expect(install).toHaveBeenCalledTimes(1);
 }finally{await rm(homeDir,{recursive:true,force:true});}
});

it('prepares only the bundled Docker image after explicit download approval and reconciles without replay',async()=>{const homeDir=await mkdtemp(join(tmpdir(),'ec-docker-dependency-')),input={homeDir,profileId:'default'},provision=vi.fn(async()=> 'sha256:'+'a'.repeat(64)),owner=new SettingsDependencies(input,vi.fn(),{probe:async()=>({available:true,imageId:'sha256:'+'a'.repeat(64)}),provision});try{await mkdir(resolveProfileStateHome(input).profileRoot,{recursive:true});const request={operationId:'00000000-0000-0000-0000-000000000002',capabilityId:'docker-execution',groups:[],downloadApproved:true as const};await expect(owner.start({...request,groups:['custom-build']})).rejects.toThrow();await expect(owner.start({...request,downloadApproved:false as true})).rejects.toThrow();expect(provision).not.toHaveBeenCalled();await owner.start(request);await vi.waitFor(async()=>expect((await owner.inspect(request.operationId)).state).toBe('completed'));await owner.start(request);expect(provision).toHaveBeenCalledTimes(1);}finally{await rm(homeDir,{recursive:true,force:true});}});

it('does not reserve or invoke a Docker build when the engine is unavailable',async()=>{const homeDir=await mkdtemp(join(tmpdir(),'ec-docker-unavailable-')),input={homeDir,profileId:'default'},provision=vi.fn(),owner=new SettingsDependencies(input,vi.fn(),{probe:async()=>({available:false}),provision});try{await mkdir(resolveProfileStateHome(input).profileRoot,{recursive:true});const operationId='00000000-0000-0000-0000-000000000003';await expect(owner.start({operationId,capabilityId:'docker-execution',groups:[],downloadApproved:true})).rejects.toThrow();expect(provision).not.toHaveBeenCalled();expect((await owner.inspect(operationId)).state).toBe('unknown');}finally{await rm(homeDir,{recursive:true,force:true});}});

it('retains actionable failure codes across restarts without persisting installer output or retrying',async()=>{
 const homeDir=await mkdtemp(join(tmpdir(),'ec-dependency-failure-')),input={homeDir,profileId:'default'};
 const install=vi.fn(async()=>({ok:false as const,capabilityId:'ddgs',reason:'python_missing' as const,message:'private installer path',diagnostic:'secret raw stderr'}));
 try{
  await mkdir(resolveProfileStateHome(input).profileRoot,{recursive:true});
  const owner=new SettingsDependencies(input,install),request={operationId:'failed-python',capabilityId:'ddgs',groups:[],downloadApproved:true as const};
  await owner.start(request);
  await vi.waitFor(async()=>expect(await owner.inspect(request.operationId)).toMatchObject({state:'failed',issue:'python_required'}));
  const restarted=new SettingsDependencies(input,install);expect(await restarted.start(request)).toMatchObject({state:'failed',issue:'python_required'});expect(install).toHaveBeenCalledTimes(1);
  const {readFile}=await import('node:fs/promises');const raw=await readFile(owner.operations.path,'utf8');expect(raw).not.toContain('secret');expect(raw).not.toContain('private installer');
 }finally{await rm(homeDir,{recursive:true,force:true});}
});

it('persists bounded progress and never lets late progress overwrite a terminal receipt',async()=>{
 const homeDir=await mkdtemp(join(tmpdir(),'ec-dependency-progress-')),input={homeDir,profileId:'default'};
 let finish!:(value:any)=>void;
 const install:typeof import('../python-env/capability-manager.js').installManagedPythonCapabilityEnvironment=async options=>{options.onProgress?.('private message','installing');return new Promise(resolve=>{finish=resolve;});};
 try{
  await mkdir(resolveProfileStateHome(input).profileRoot,{recursive:true});const owner=new SettingsDependencies(input,install);
  await owner.start({operationId:'progress',capabilityId:'ddgs',groups:[],downloadApproved:true});
  await vi.waitFor(async()=>expect(await owner.inspect('progress')).toMatchObject({state:'uncertain',phase:'installing'}));
  finish({ok:true});await vi.waitFor(async()=>expect(await owner.inspect('progress')).toMatchObject({state:'completed'}));
  await owner.operations.progress('progress','verifying');expect(await owner.inspect('progress')).not.toHaveProperty('phase');
 }finally{await rm(homeDir,{recursive:true,force:true});}
});
