import {mkdtemp,rm,readFile,access} from 'node:fs/promises';
import {it,expect} from 'vitest';
import {resolveProfileStateHome} from '../config/profile-home.js';
import {CredentialCandidates} from './credential-candidates.js';
import {TelegramSetup,telegramScope} from './telegram-setup.js';
const settings={enabled:true,authorization:'allowlist' as const,allowedUserIds:['123'],allowedChatIds:[],secureInputMode:'protected-handoff' as const,directDmAcknowledged:false,streaming:true,pollTimeoutSeconds:25};
it('requires authorization and commits staged tokens only through reviewed profile Apply',async()=>{
 const homeDir=await mkdtemp('/tmp/ec-telegram-setup-'),input={homeDir,profileId:'p'},paths=resolveProfileStateHome(input),candidates=new CredentialCandidates('p','bridge'),service=new TelegramSetup(input,candidates,()=>{}),scope=telegramScope({windowId:'w',generation:1});
 try{
  const candidateId=candidates.stage(scope,'123456:synthetic-private-token'),params={windowId:'w',generation:1,candidateId,settings};
  await expect(service.review({...params,settings:{...settings,allowedUserIds:[]}})).rejects.toThrow();
  const draft=await service.review(params);expect(JSON.stringify(draft)).not.toContain('synthetic-private');await expect(access(paths.envPath)).rejects.toThrow();
  const binding={draftId:draft.draftId,windowId:'w',generation:1};expect(await service.apply(binding,new AbortController().signal)).toMatchObject({state:'applied'});
  const config=JSON.parse(await readFile(paths.configPath,'utf8'));expect(config.channels.telegram).toMatchObject({enabled:true,allowedUserIds:['123'],secureInputMode:'protected-handoff',busyPolicy:'queue',streaming:{enabled:true}});expect(JSON.stringify(config)).not.toContain('synthetic-private');expect(await readFile(paths.envPath,'utf8')).toContain('synthetic-private-token');
  expect(await new TelegramSetup(input,candidates,()=>{}).inspect()).toMatchObject({operationId:draft.draftId,state:'applied'});
 }finally{service.dispose();candidates.dispose();await rm(homeDir,{recursive:true,force:true});}
});
