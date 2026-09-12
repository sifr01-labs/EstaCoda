import {callPrivateControl} from '../gateway/private-control.js';
import {resolveProfileStateHome} from '../config/profile-home.js';
import {safeText} from './work-projections.js';
import type {WorkProjection,MethodContracts} from '../contracts/desktop-control/index.js';
/** Ephemeral owner preview; persisted transcript/outcomes remain authoritative. Never starts a host. */
export async function liveWork(input:{homeDir:string;profileId:string;version:string},work:WorkProjection,signal:AbortSignal):Promise<MethodContracts['work.live']['result']>{
 if(work.profileId!==input.profileId||work.kind!=='session'||!work.target)throw new Error('Live Work unavailable.');
 const response=await callPrivateControl({...input,directory:resolveProfileStateHome(input).gatewayStatePath,requireTargetGeneration:true,signal,request:{method:'inspect',sessionId:work.canonicalId,targetId:work.target.targetId,targetGeneration:work.target.targetGeneration,operationId:'desktop-preview'}}) as {execution?:{active?:boolean;preview?:{turnId?:string;text?:string;truncated?:boolean}}};
 const preview=response.execution?.preview;
 return{active:response.execution?.active===true,turnId:typeof preview?.turnId==='string'?preview.turnId:null,text:typeof preview?.text==='string'?safeText(preview.text,16384):'',truncated:preview?.truncated===true};
}
