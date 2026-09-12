import {createTelegramPairingCode,setupTelegramConfig} from '../config/runtime-config.js';
import {captureProfileApplySnapshot} from '../setup/review/profile-apply.js';
import {readEnvSecretValue} from '../config/env-secret-store.js';
import {resolveProfileStateHome} from '../config/profile-home.js';
import {notifyPrivateConfigurationChanged} from '../gateway/private-control.js';
import {telegramRequest} from './telegram-verification.js';
import {ConnectionOperations} from './connection-operations.js';
import {ControlProtocolError,type TelegramOperationAction,type TelegramPairing} from '../contracts/desktop-control/index.js';
import {telegramGatewayCommands} from '../channels/channel-gateway.js';
export class TelegramOperations {
 readonly operations:ConnectionOperations;
 constructor(readonly input:{homeDir:string;profileId:string;version:string},readonly fetcher:typeof fetch=fetch){this.operations=new ConnectionOperations(input);}
 private async saved(){const snapshot=await captureProfileApplySnapshot(this.input),config=JSON.parse(snapshot.files['config.json']??'{}').channels?.telegram;return{config,token:typeof config?.botTokenEnv==='string'?readEnvSecretValue(snapshot.files['.env']??'',config.botTokenEnv):undefined};}
 async pairing():Promise<TelegramPairing>{const{config}=await this.saved(),pairing=config?.pairing,expiresAt=Date.parse(pairing?.expiresAt);return typeof pairing?.code==='string'&&/^[A-Za-z0-9-]{4,64}$/.test(pairing.code)&&expiresAt>Date.now()?{code:pairing.code,expiresAt}:{code:null,expiresAt:null};}
 async execute(params:{operationId:string;action:TelegramOperationAction;destination?:string},signal:AbortSignal){
  const{config,token}=await this.saved();signal.throwIfAborted();
  if(params.action!=='pairingCancel'&&(!config?.enabled||!token))throw new ControlProtocolError('-32602');
  if(params.action==='test'&&(!params.destination||!/^\-?\d{1,20}$/.test(params.destination)||![...(config.allowedChatIds??[]),...(config.allowedUserIds??[])].includes(params.destination)))throw new ControlProtocolError('-32003');
  return this.operations.execute(params.operationId,'telegram.'+params.action,async()=>{
   if(params.action==='pairingCreate'||params.action==='pairingCancel'){
    if(params.action==='pairingCreate')await createTelegramPairingCode({...this.input,workspaceRoot:this.input.homeDir,input:{ttlMinutes:10}});
    else await setupTelegramConfig({...this.input,workspaceRoot:this.input.homeDir,input:{clearPairing:true,enabled:config?.enabled===true}});
    try{await notifyPrivateConfigurationChanged({directory:resolveProfileStateHome(this.input).gatewayStatePath,profileId:this.input.profileId,version:this.input.version,signal:AbortSignal.timeout(2000)});}catch{}
    return true;
   }
   const result=await telegramRequest(token!,params.action==='sync'?'setMyCommands':'sendMessage',params.action==='sync'?{commands:telegramGatewayCommands().map(command=>({command:command.command.replace(/^\//,''),description:command.description.slice(0,256)}))}:{chat_id:params.destination,text:'EstaCoda connection test. This bot can deliver messages to this authorized destination.'},AbortSignal.any([signal,AbortSignal.timeout(8000)]),this.fetcher);
   return result.ok;
  });
 }
}
