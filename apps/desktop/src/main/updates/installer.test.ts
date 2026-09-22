import {it,expect} from 'vitest';
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {UpdateInstaller,type PlatformInstaller} from './installer.js';
import {UpdateCoordinator} from './coordinator.js';
import {publicKey,now,fixture,envelope} from './release-fixtures.js';
it('preserves Later, gates active resources, records intent and verifies the new launch',async()=>{
 const directory=mkdtempSync('/tmp/ec-install-receipt-'),body='test package',release=fixture();release.updater.bytes=body.length;release.updater.sha256=createHash('sha256').update(body).digest('hex');let installs=0,running=0,verified=0;
 const options={version:'1.0.0',platform:'darwin',arch:'arm64',os:'15.0.0',protocol:1,schema:36,publicKey,teamId:release.teamId,now:()=>now,installation:()=>({ownership:'owned' as const,canReplace:true}),fetcher:(async(url:unknown)=>new Response(String(url).endsWith('latest.json')?Buffer.from(envelope(release)).toString():body)) as typeof fetch};
 const platform:PlatformInstaller={restartEvidence:async()=>({compatible:true,readersCoordinated:true,runtimeAssetsRetained:true,running,queued:0,terminals:0,browserTakeovers:0,credentialEntries:0,draftsSaved:true}),install:async()=>{installs++;},verifyRunning:async()=>{verified++;}};
 try{
 const updates=new UpdateInstaller(options,new UpdateCoordinator(directory),async()=>{},platform);await updates.check();expect((await updates.download()).phase).toBe('ready');expect(installs).toBe(0);
 const restart=new UpdateInstaller(options,new UpdateCoordinator(directory),async()=>{},platform);expect((await restart.restore()).phase).toBe('ready');expect(installs).toBe(0);
 running=1;expect((await restart.install()).problem).toBe('active_runtime');expect(installs).toBe(0);running=0;await restart.restore();await Promise.all([restart.install(),restart.install()]);expect(installs).toBe(1);expect(restart.status().phase).toBe('installing');expect(JSON.parse(readFileSync(directory+'/receipt.json','utf8')).phase).toBe('replacement_requested');
 const failedLaunch=new UpdateInstaller(options,new UpdateCoordinator(directory),async()=>{},platform);expect((await failedLaunch.restore()).problem).toBe('recovery_required');
 const installed=new UpdateInstaller({...options,version:release.version},new UpdateCoordinator(directory),async()=>{},platform);expect((await installed.restore()).phase).toBe('installed');expect(verified).toBe(1);
 writeFileSync(directory+'/receipt.json','invalid');const corrupt=new UpdateInstaller(options,new UpdateCoordinator(directory),async()=>{},platform);expect((await corrupt.restore()).problem).toBe('recovery_required');
 }finally{rmSync(directory,{recursive:true,force:true});}
});
it('never downloads or installs without the deferred platform verifier/installer',async()=>{
 const directory=mkdtempSync('/tmp/ec-unavailable-');let requests=0;try{const updates=new UpdateInstaller({version:'1.0.0',platform:'darwin',arch:'arm64',os:'15.0.0',protocol:1,schema:36,publicKey:null,teamId:null,installation:()=>({ownership:'unverified',canReplace:false}),fetcher:(async()=>{requests++;throw Error();}) as typeof fetch},new UpdateCoordinator(directory));expect((await updates.download()).phase).toBe('disabled');expect((await updates.install()).phase).toBe('disabled');expect(requests).toBe(0);}finally{rmSync(directory,{recursive:true,force:true});}
});
