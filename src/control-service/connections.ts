import {telegramVerifiedAt} from './telegram-verification-state.js';
import {join} from 'node:path';
import {resolveProfileStateHome} from '../config/profile-home.js';
import {loadRuntimeConfig} from '../config/runtime-config.js';
import {readEnvSecretValue} from '../config/env-secret-store.js';
import {readProfileFile} from './profile-attention.js';
import {supervisorReadiness} from './supervisor-client.js';
import type {ConnectionProjection} from '../contracts/desktop-control/index.js';
/** Read-only, selected-profile metadata. No token, pairing code or adapter error text crosses RPC. */
export async function telegramConnection(input:{homeDir:string;profileId:string;version:string},signal:AbortSignal):Promise<ConnectionProjection>{
 const base:ConnectionProjection={id:'telegram',profileId:input.profileId,channel:'telegram',configurationState:'repair_required',runtimeState:'unknown',authorizationState:'unknown',summary:'Telegram configuration needs attention.'};
 const gateway=await supervisorReadiness({...input,signal});
 base.runtimeState=gateway.state==='ready'?'running':gateway.state==='stopped'?'stopped':'disconnected';
 try{
  const paths=resolveProfileStateHome(input),loaded=await loadRuntimeConfig({...input,workspaceRoot:input.homeDir,configurationInspection:true});
  const config=loaded.config.channels?.telegram;
  const env=await readProfileFile(paths.profileRoot,paths.envPath);
  const credential=Boolean(config?.botTokenEnv&&readEnvSecretValue(env??'',config.botTokenEnv)?.trim());
  const users=config?.allowedUserIds??[],chats=config?.allowedChatIds??[];
  if(!Array.isArray(users)||!Array.isArray(chats)||users.length>1000||chats.length>1000||[...users,...chats].some(id=>typeof id!=='string'||!/^\-?\d{1,20}$/.test(id)))return base;
  const expires=config?.pairing?.expiresAt?Date.parse(config.pairing.expiresAt):NaN;
  const pairing=Boolean(config?.pairing?.code&&Number.isFinite(expires)&&expires>Date.now());
  base.authorizationState=users.length+chats.length?'configured':pairing?'pairing_required':'denied';
  const status=!config?.enabled?'disabled':!credential?'credential_missing':base.authorizationState==='denied'?'authorization_missing':pairing&&!users.length&&!chats.length?'pairing_pending':'ready';
  base.configurationState=status==='disabled'?'unconfigured':status==='ready'?'configured':'repair_required';
  let polling:NonNullable<ConnectionProjection['telegram']>['polling']='unknown',observedAt:number|null=null;
  if(base.runtimeState==='running'){
   try{
    const state=JSON.parse(await readProfileFile(paths.profileRoot,join(paths.gatewayStatePath,'adapter-runtime-state.json'))??'null');
    const lock=JSON.parse(await readProfileFile(paths.profileRoot,join(paths.gatewayStatePath,'gateway.lock'))??'null');
    const at=Date.parse(state?.updatedAt),adapter=state?.adapters?.find((item:{kind:string})=>item.kind==='telegram');
    if(lock?.pid===state?.supervisorPid&&lock?.startedAt===state?.supervisorStartedAt&&Number.isFinite(at)&&at<=Date.now()&&Date.now()-at<300000&&adapter){
     polling=adapter.state==='healthy'&&adapter.pollsTotal>0?'healthy':adapter.state==='starting'?'starting':adapter.state==='stopped'?'stopped':'degraded';observedAt=at;
    }
   }catch{/* Unreadable or stale diagnostics cannot prove polling health. */}
  }
  base.telegram={configured:config!==undefined,status,allowedUsers:users.length,allowedChats:chats.length,pairingExpiresAt:pairing?expires:null,polling,observedAt,lastVerifiedAt:await telegramVerifiedAt(input,config?.botTokenEnv)};
  base.summary=status==='ready'?'Configured with bounded Telegram access. Gateway and polling state are shown separately.':status==='disabled'?'Telegram is disabled.':status==='credential_missing'?'Add a bot token.':status==='pairing_pending'?'Waiting for an authorized pairing.':'Configure an allowlist or a pairing policy.';
  signal.throwIfAborted();return base;
 }catch(error){signal.throwIfAborted();return base;}
}
