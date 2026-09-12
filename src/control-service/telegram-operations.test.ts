import {it,expect} from 'vitest';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {TelegramOperations} from './telegram-operations.js';
import {resolveProfileStateHome} from '../config/profile-home.js';
it('restricts outbound tests, expires/cancels pairing, and never repeats uncertain delivery',async()=>{
 const homeDir=await mkdtemp(join(tmpdir(),'ec-tg-ops-')),input={homeDir,profileId:'selected',version:'test'},paths=resolveProfileStateHome(input);let calls=0;
 try{await mkdir(paths.profileRoot,{recursive:true});await writeFile(paths.configPath,JSON.stringify({channels:{telegram:{enabled:true,botTokenEnv:'BOT_TOKEN',allowedUserIds:['123']}}}));await writeFile(paths.envPath,'BOT_TOKEN=12345:abcdefghijklmnopqrstuvwxyz\n');
 const service=new TelegramOperations(input,(async()=>{calls++;throw new Error('token URL');}) as typeof fetch);
 await expect(service.execute({operationId:'denied',action:'test',destination:'999'},new AbortController().signal)).rejects.toThrow();expect(calls).toBe(0);
 expect((await service.execute({operationId:'test',action:'test',destination:'123'},new AbortController().signal)).state).toBe('uncertain');await service.execute({operationId:'test',action:'test',destination:'123'},new AbortController().signal);expect(calls).toBe(1);
 expect((await service.execute({operationId:'pair',action:'pairingCreate'},new AbortController().signal)).state).toBe('completed');expect((await service.pairing()).code).toBeTruthy();expect((await new TelegramOperations({...input,profileId:'other'}).pairing()).code).toBeNull();
 await service.execute({operationId:'cancel',action:'pairingCancel'},new AbortController().signal);expect((await service.pairing()).code).toBeNull();
 }finally{await rm(homeDir,{recursive:true,force:true});}
});
