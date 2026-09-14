import {randomUUID} from 'node:crypto';
import type {SecureInputCollector,SecureInputCollectionResult} from '../contracts/secure-input.js';
import {validateWorkInputCommand,type WorkInputCommand,type WorkInputRequest,type WorkInputResult} from '../contracts/desktop-control/work-input.js';
export type InputBinding={sessionId:string;targetId:string;targetGeneration:number};
type Entry={binding:InputBinding;request:WorkInputRequest;holder?:string;finish:(value:SecureInputCollectionResult)=>void};
/** In-memory rendezvous only. The runtime coordinator still verifies and delivers every destination. */
export class DesktopSecureInput {
 #pending=new Map<string,Entry>();
 constructor(readonly profileId:string){}
 collector(binding:InputBinding):SecureInputCollector{return (snapshot,signal,context)=>{
  if(signal.aborted||snapshot.scope.profileId!==this.profileId||snapshot.scope.sessionId!==binding.sessionId||snapshot.request.destination.type!=='browser-field'||this.#pending.size>=32)return Promise.resolve({status:'cancelled'});
  const destination=snapshot.request.destination,origin=new URL(destination.expectedOrigin).origin;
  if(!['http:','https:'].includes(new URL(origin).protocol))return Promise.resolve({status:'cancelled'});
  const id=randomUUID(),expires=Math.min(Date.parse(snapshot.expiresAt),Date.now()+120000);
  if(!Number.isFinite(expires)||expires<=Date.now())return Promise.resolve({status:'cancelled'});
  return new Promise(resolve=>{
   let done=false;const cancel=()=>finish({status:'cancelled'});
   const timer=setTimeout(cancel,expires-Date.now());timer.unref();
   const finish=(result:SecureInputCollectionResult)=>{if(done){if(result.status==='provided')result.value.fill(0);return;}done=true;clearTimeout(timer);signal.removeEventListener('abort',cancel);this.#pending.delete(id);resolve(result);};
   this.#pending.set(id,{binding:{...binding},request:{id,origin,kind:snapshot.request.kind,position:context.group?.index??1,total:context.group?.total??1,expiresAt:new Date(expires).toISOString()},finish});
   signal.addEventListener('abort',cancel,{once:true});if(signal.aborted)cancel();
  });
 };}
 handle(binding:InputBinding,command:WorkInputCommand):WorkInputResult{
  validateWorkInputCommand(command);
  const matches=(entry:Entry)=>entry.binding.sessionId===binding.sessionId&&entry.binding.targetId===binding.targetId&&entry.binding.targetGeneration===binding.targetGeneration;
  if(command.action==='pending'){const entry=[...this.#pending.values()].find(e=>matches(e)&&(!e.holder||e.holder===command.holder));return{request:entry?{...entry.request}:null};}
  const entry=this.#pending.get(command.requestId);
  if(!entry||!matches(entry)||entry.holder&&entry.holder!==command.holder||Date.parse(entry.request.expiresAt)<=Date.now())throw new Error('Protected request expired or owned elsewhere.');
  if(command.action==='claim'){entry.holder=command.holder;return{request:{...entry.request}};}
  if(entry.holder!==command.holder)throw new Error('Protected request not claimed.');
  if(command.action==='cancel')entry.finish({status:'cancelled'});
  else if(command.action==='deliver'){const value=Buffer.from(command.value,'utf8');command.value='';entry.finish({status:'provided',value});}
  return{request:null};
 }
 close(){for(const entry of this.#pending.values())entry.finish({status:'cancelled'});}
}
