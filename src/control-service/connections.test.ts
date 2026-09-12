import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {it,expect} from 'vitest';
import {resolveProfileStateHome} from '../config/profile-home.js';
import {telegramConnection} from './connections.js';
it('separates selected-profile authorization and token presence from gateway liveness',async()=>{
 const homeDir=await mkdtemp('/tmp/ec-connections-'),input={homeDir,profileId:'p',version:'test'},paths=resolveProfileStateHome(input),signal=new AbortController().signal;
 try{
  expect(await telegramConnection(input,signal)).toMatchObject({runtimeState:'stopped',telegram:{status:'disabled'}});
  await mkdir(paths.profileRoot,{recursive:true});await writeFile(paths.configPath,JSON.stringify({channels:{telegram:{enabled:true,botTokenEnv:'TELEGRAM_BOT_TOKEN',allowedUserIds:['123']}}}));
  expect(await telegramConnection(input,signal)).toMatchObject({authorizationState:'configured',telegram:{status:'credential_missing',allowedUsers:1}});
  await writeFile(paths.envPath,'TELEGRAM_BOT_TOKEN=synthetic-private-token\n');
  const ready=await telegramConnection(input,signal);expect(ready).toMatchObject({configurationState:'configured',runtimeState:'stopped',telegram:{status:'ready',polling:'unknown',lastVerifiedAt:null}});expect(JSON.stringify(ready)).not.toContain('synthetic-private-token');
  expect(await telegramConnection({...input,profileId:'q'},signal)).toMatchObject({authorizationState:'denied',telegram:{status:'disabled',allowedUsers:0}});
  await writeFile(paths.configPath,JSON.stringify({channels:{telegram:{enabled:true,botTokenEnv:'TELEGRAM_BOT_TOKEN',pairing:{code:'PRIVATE-CODE',expiresAt:new Date(Date.now()-1000).toISOString()}}}}));
  expect(await telegramConnection(input,signal)).toMatchObject({authorizationState:'denied',telegram:{status:'authorization_missing',pairingExpiresAt:null}});
 }finally{await rm(homeDir,{recursive:true,force:true});}
});
