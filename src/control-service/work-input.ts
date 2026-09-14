import {randomUUID} from 'node:crypto';
import {browserOwner} from './browser-view.js';
import {callPrivateControl} from '../gateway/private-control.js';
import {resolveProfileStateHome} from '../config/profile-home.js';
import {validateWorkInputCommand,validateWorkInputResult,type WorkInputCommand,type WorkInputResult} from '../contracts/desktop-control/work-input.js';
import type {WorkProjection} from '../contracts/desktop-control/index.js';
/** Bounded, metadata-only ownership; disconnect cancels the native window's claims. */
export class WorkInputClaims {
 #entries=new Map<string,()=>void>();
 async run(input:{homeDir:string;profileId:string;version:string},work:WorkProjection,command:WorkInputCommand,signal:AbortSignal){
  if(signal.aborted)throw new Error('Protected channel closed.');
  if(command.action==='claim'&&this.#entries.size>=32)throw new Error('Protected request limit.');
  const result=await workInput(input,work,command,signal);
  if(command.action==='claim'&&result.request){
   const cancelCommand={action:'cancel' as const,holder:command.holder,requestId:command.requestId};
   const key=command.holder+':'+command.requestId;
   this.#entries.get(key)?.();
   const forget=()=>{clearTimeout(timer);signal.removeEventListener('abort',cancel);this.#entries.delete(key);};
   const cancel=()=>{forget();void workInput(input,work,cancelCommand,AbortSignal.timeout(2000)).catch(()=>{});};
   const timer=setTimeout(forget,Math.max(0,Date.parse(result.request.expiresAt)-Date.now()));timer.unref();
   this.#entries.set(key,forget);signal.addEventListener('abort',cancel,{once:true});if(signal.aborted){cancel();throw new Error('Protected channel closed.');}
  }else if(command.action==='deliver'||command.action==='cancel')this.#entries.get(command.holder+':'+command.requestId)?.();
  return result;
 }
}
/** Only called from the private inherited credential descriptor. */
export async function workInput(input:{homeDir:string;profileId:string;version:string},work:WorkProjection,command:WorkInputCommand,signal:AbortSignal):Promise<WorkInputResult>{
 validateWorkInputCommand(command);
 try{
  const session=await browserOwner(input,work,signal);
  const result=await callPrivateControl({directory:resolveProfileStateHome(input).gatewayStatePath,profileId:input.profileId,version:input.version,requireTargetGeneration:true,signal,request:{method:'secure.input',sessionId:session.id,targetId:session.executionTarget!.targetId,targetGeneration:session.executionTarget!.targetGeneration,operationId:randomUUID(),workInput:command}});
  validateWorkInputResult(result);return result;
 }finally{if(command.action==='deliver')command.value='';}
}
