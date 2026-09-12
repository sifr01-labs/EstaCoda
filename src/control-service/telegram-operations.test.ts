import {it,expect,vi} from 'vitest';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {TelegramOperations} from './telegram-operations.js';
import {resolveProfileStateHome} from '../config/profile-home.js';
it('restricts outbound tests, expires/cancels pairing, and never repeats uncertain delivery',async()=>{
 const homeDir=await mkdtemp(join(tmpdir(),'ec-tg-ops-')),input={homeDir,profileId:'selected',version:'test'},paths=resolveProfileStateHome(input);let calls=0;
 try{await mkdir(paths.profileRoot,{recursive:true});await writeFile(paths.configPath,JSON.stringify({channels:{telegram:{enabled:true,botTokenEnv:'BOT_TOKEN',allowedUserIds:['123']}}}));await writeFile(paths.envPath,'BOT_TOKEN=12345:abcdefghijklmnopqrstuvwxyz\n');
 const service=new TelegramOperations(input,(async()=>{calls++;throw new Error('token URL');}) as typeof fetch);
 expect(await service.execute({operationId:'denied',action:'test',destination:'999'},new AbortController().signal)).toMatchObject({state:'failed'});expect(await service.operations.inspect('denied')).toMatchObject({state:'failed'});expect(calls).toBe(0);
 expect((await service.execute({operationId:'test',action:'test',destination:'123'},new AbortController().signal)).state).toBe('uncertain');await service.execute({operationId:'test',action:'test',destination:'123'},new AbortController().signal);expect(calls).toBe(1);
 expect((await service.execute({operationId:'pair',action:'pairingCreate'},new AbortController().signal)).state).toBe('completed');expect((await service.pairing()).code).toBeTruthy();expect((await new TelegramOperations({...input,profileId:'other'}).pairing()).code).toBeNull();
 await service.execute({operationId:'cancel',action:'pairingCancel'},new AbortController().signal);expect((await service.pairing()).code).toBeNull();
 }finally{await rm(homeDir,{recursive:true,force:true});}
});

it('pairing cancellation preserves a disable committed after its configuration read',async()=>{
 const {setupTelegramConfig}=await import('../config/runtime-config.js');
 const snapshots=await import('../setup/review/profile-apply.js');
 const homeDir=await mkdtemp(join(tmpdir(),'ec-tg-cancel-')),input={homeDir,profileId:'selected',version:'test'},paths=resolveProfileStateHome(input);
 try{
  await mkdir(paths.profileRoot,{recursive:true});
  await writeFile(paths.configPath,JSON.stringify({channels:{telegram:{enabled:true,allowedUserIds:['123'],pairing:{code:'old-code',expiresAt:new Date(Date.now()+600000).toISOString()}}}}));
  const capture=snapshots.captureProfileApplySnapshot;
  vi.spyOn(snapshots,'captureProfileApplySnapshot').mockImplementationOnce(async options=>{
   const snapshot=await capture(options);
   await setupTelegramConfig({...input,workspaceRoot:homeDir,input:{enabled:false,allowedUserIds:['456']}});
   return snapshot;
  });
  const result=await new TelegramOperations(input).execute({operationId:'cancel',action:'pairingCancel'},new AbortController().signal);
  const config=JSON.parse(await readFile(paths.configPath,'utf8'));
  expect(result.state).toBe('completed');expect(config.channels.telegram).toMatchObject({enabled:false,allowedUserIds:['456']});expect(config.channels.telegram.pairing).toBeUndefined();
 }finally{vi.restoreAllMocks();await rm(homeDir,{recursive:true,force:true});}
});
it('allows a corrected delivery after durable preflight failure, including restart',async()=>{
 const homeDir=await mkdtemp(join(tmpdir(),'ec-tg-retry-')),input={homeDir,profileId:'selected',version:'test'},paths=resolveProfileStateHome(input);let calls=0;
 try{
  await mkdir(paths.profileRoot,{recursive:true});await writeFile(paths.configPath,JSON.stringify({channels:{telegram:{enabled:true,botTokenEnv:'BOT_TOKEN',allowedUserIds:['123']}}}));await writeFile(paths.envPath,'BOT_TOKEN=12345:abcdefghijklmnopqrstuvwxyz\n');
  const fetcher=(async()=>{calls++;return new Response(JSON.stringify({ok:true,result:{}}));}) as typeof fetch;
  const service=new TelegramOperations(input,fetcher);
  expect((await service.execute({operationId:'rejected',action:'test',destination:'999'},new AbortController().signal)).state).toBe('failed');expect(calls).toBe(0);
  const restarted=new TelegramOperations(input,fetcher);expect((await restarted.operations.inspect('rejected')).state).toBe('failed');
  expect((await restarted.execute({operationId:'corrected',action:'test',destination:'123'},new AbortController().signal)).state).toBe('completed');expect(calls).toBe(1);
 }finally{await rm(homeDir,{recursive:true,force:true});}
});
