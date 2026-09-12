import {connectionDiagnostics} from './connection-diagnostics.js';
import {fileURLToPath} from 'node:url';
import {homedir} from 'node:os';
import {installService,probeServiceState,detectServiceManager} from '../gateway/service-manager.js';
import {runGatewayStartService,runGatewayStop,runGatewayRestart} from '../cli/gateway-commands.js';
import {telegramConnection} from './connections.js';
import {ConnectionOperations} from './connection-operations.js';
import type {GatewayAction,GatewayDiagnostics} from '../contracts/desktop-control/index.js';
type Input={homeDir:string;profileId:string;version:string};
async function lifecycle(input:Input,action:GatewayAction):Promise<boolean>{
 // The installed runtime is selected by the backend. Renderer paths and commands are never accepted.
 const workspaceRoot=fileURLToPath(new URL('../../',import.meta.url));
 if(action==='install')return(await installService({stateHomeDir:input.homeDir,serviceUserHomeDir:homedir(),workspaceRoot,profileId:input.profileId})).ok;
 const command=action==='start'?runGatewayStartService:action==='stop'?runGatewayStop:runGatewayRestart;
 return(await command({...input,workspaceRoot,system:false})).ok;
}
export class GatewayControls {
 readonly operations:ConnectionOperations;
 constructor(readonly input:Input,readonly run=lifecycle){this.operations=new ConnectionOperations(input);}
 execute(operationId:string,action:GatewayAction){return this.operations.execute(operationId,'gateway.'+action,()=>this.run(this.input,action));}
 async diagnostics(signal:AbortSignal):Promise<GatewayDiagnostics>{
  const connection=await telegramConnection(this.input,signal);let service:GatewayDiagnostics['service']='unknown';
  try{service=(await probeServiceState({serviceUserHomeDir:homedir(),profileId:this.input.profileId,system:false})).installed?'installed':'absent';}catch{}
  return{...await connectionDiagnostics(this.input),service,manager:detectServiceManager(),runtime:connection.runtimeState==='running'?'running':connection.runtimeState==='stopped'?'stopped':'disconnected',polling:connection.telegram?.polling??'unknown',observedAt:connection.telegram?.observedAt??null};
 }
}
