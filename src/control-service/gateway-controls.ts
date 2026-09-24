import {join} from 'node:path';
import {withProfileWriteLock} from '../config/profile-write-lock.js';
import {setTimeout as delay} from 'node:timers/promises';
import {inspectDesktopRuntimeBuild} from '../gateway/desktop-runtime-build.js';
import {probePrivateRuntimeBuild} from '../gateway/private-control.js';
import {supervisorReadiness} from './supervisor-client.js';
import {resolveProfileStateHome} from '../config/profile-home.js';
import {connectionDiagnostics} from './connection-diagnostics.js';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';
import {installService,probeServiceState,detectServiceManager} from '../gateway/service-manager.js';
import {runGatewayStartService,runGatewayStop,runGatewayRestart} from '../cli/gateway-commands.js';
import {telegramConnection} from './connections.js';
import {ConnectionOperations} from './connection-operations.js';
import type {GatewayAction,GatewayDiagnostics,ConnectionOperationIssue} from '../contracts/desktop-control/index.js';
type Input={homeDir:string;profileId:string;version:string};
export async function gatewayLifecycle(input:Input,action:GatewayAction):Promise<boolean|{ok:boolean;issue?:ConnectionOperationIssue}>{
 // The installed runtime is selected by the backend. Renderer paths and commands are never accepted.
 const workspaceRoot=fileURLToPath(new URL('../../',import.meta.url));
 if(action==='update'){
  const build=inspectDesktopRuntimeBuild(undefined,undefined,true);
  if(!build)return {ok:false,issue:'runtime_unavailable'};
  if((await supervisorReadiness(input)).state!=='stopped')return {ok:false,issue:'gateway_not_stopped'};
  if(!(await probeServiceState({serviceUserHomeDir:homedir(),profileId:input.profileId,system:false})).installed)return {ok:false,issue:'runtime_unavailable'};
  const result=await installService({stateHomeDir:input.homeDir,serviceUserHomeDir:homedir(),workspaceRoot:build.workspaceRoot,profileId:input.profileId,force:true,requireStopped:true,verifyActivation:async()=>{
   const deadline=Date.now()+15000;
   do{try{if(await probePrivateRuntimeBuild({directory:resolveProfileStateHome(input).gatewayStatePath,profileId:input.profileId,version:input.version,signal:AbortSignal.timeout(1000)})===build.digest)return true;}catch{}await delay(250);}while(Date.now()<deadline);
   return false;
  }});
  return result.ok?true:{ok:false,issue:'activation_failed'};
 }
 if(action==='install')return(await installService({stateHomeDir:input.homeDir,serviceUserHomeDir:homedir(),workspaceRoot,profileId:input.profileId})).ok;
 const command=action==='start'?runGatewayStartService:action==='stop'?runGatewayStop:runGatewayRestart;
 return(await command({...input,workspaceRoot,system:false})).ok;
}
export class GatewayControls {
 readonly operations:ConnectionOperations;
 constructor(readonly input:Input,readonly run=gatewayLifecycle){this.operations=new ConnectionOperations(input);}
 execute(operationId:string,action:GatewayAction){return this.operations.execute(operationId,'gateway.'+action,()=>withProfileWriteLock(join(this.operations.root,'.gateway-lifecycle'),()=>this.run(this.input,action)));}
 async diagnostics(signal:AbortSignal):Promise<GatewayDiagnostics>{
  const connection=await telegramConnection(this.input,signal);let service:GatewayDiagnostics['service']='unknown';
  try{service=(await probeServiceState({serviceUserHomeDir:homedir(),profileId:this.input.profileId,system:false})).installed?'installed':'absent';}catch{}
  const target=inspectDesktopRuntimeBuild();let build:GatewayDiagnostics['build']='unknown';
  if(target){try{const live=await probePrivateRuntimeBuild({directory:resolveProfileStateHome(this.input).gatewayStatePath,profileId:this.input.profileId,version:this.input.version,signal:AbortSignal.any([signal,AbortSignal.timeout(1000)])});if(live)build=live===target.digest?'current':'different';}catch{signal.throwIfAborted();}}
  return{build,updateAvailable:!!target&&service==='installed',...await connectionDiagnostics(this.input),service,manager:detectServiceManager(),runtime:connection.runtimeState==='running'?'running':connection.runtimeState==='stopped'?'stopped':'disconnected',polling:connection.telegram?.polling??'unknown',observedAt:connection.telegram?.observedAt??null};
 }
}
