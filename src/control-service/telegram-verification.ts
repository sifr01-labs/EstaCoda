import {rememberTelegramVerification} from './telegram-verification-state.js';
import {performance} from 'node:perf_hooks';
import {captureProfileApplySnapshot} from '../setup/review/profile-apply.js';
import {readEnvSecretValue} from '../config/env-secret-store.js';
import {ControlProtocolError,type TelegramVerification,type TelegramVerify} from '../contracts/desktop-control/index.js';
import {CredentialCandidates,type CandidateScope} from './credential-candidates.js';
export const telegramScope=(binding:{windowId:string;generation:number}):CandidateScope=>({...binding,purpose:'telegram',providerId:'telegram',authMethod:'api_key',endpoint:'https://api.telegram.org'});
/** Telegram requires the token in its URL. Never propagate fetch errors, URLs or raw response bodies. */
export async function telegramRequest(token:string,method:'getMe'|'setMyCommands'|'sendMessage',body:Record<string,unknown>,signal:AbortSignal,fetcher:typeof fetch=fetch):Promise<{ok:boolean;invalidCredential:boolean;result:unknown}>{
 if(!/^\d{5,20}:[A-Za-z0-9_-]{20,200}$/.test(token))return{ok:false,invalidCredential:true,result:null};
 const response=await fetcher(`https://api.telegram.org/bot${token}/${method}`,{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal});
 if(response.status===401||response.status===404){await response.body?.cancel();return{ok:false,invalidCredential:true,result:null};}
 const reader=response.body?.getReader();if(!reader)return{ok:false,invalidCredential:false,result:null};
 let size=0;const chunks:Uint8Array[]=[];
 try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>65536)throw new Error('Response limit');chunks.push(next.value);}}
 finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 const parsed=JSON.parse(Buffer.concat(chunks).toString('utf8'));
 return{ok:response.ok&&parsed?.ok===true,invalidCredential:false,result:parsed?.result};
}
export class TelegramVerifier {
 readonly #verified=new Set<string>();readonly #watched=new Set<string>();#inflight=0;readonly #abort=new AbortController();
 constructor(readonly input:{homeDir:string;profileId:string},readonly candidates:CredentialCandidates,readonly fetcher:typeof fetch=fetch){}
 verified(params:TelegramVerify):boolean{if(!params.candidateId)return false;this.candidates.read(params.candidateId,telegramScope({windowId:params.windowId,generation:params.generation}));return this.#verified.has(params.candidateId);}
 async verify(params:TelegramVerify,signal:AbortSignal):Promise<TelegramVerification>{
  if(this.#inflight>=4||this.#abort.signal.aborted)throw new ControlProtocolError('-32009');
  const scope=telegramScope({windowId:params.windowId,generation:params.generation});
  const lifetime=this.candidates.windowSignal(params.windowId,params.generation);
  const combined=AbortSignal.any([signal,lifetime,this.#abort.signal,AbortSignal.timeout(8000),...(params.candidateId?[this.candidates.signal(params.candidateId,scope)]:[])]);
  if(params.candidateId)this.#verified.delete(params.candidateId);
  this.#inflight++;const started=performance.now();
  const failed=(reason:TelegramVerification['reason']):TelegramVerification=>({state:'failed',reason,verifiedAt:null,botUsername:null,latencyMs:Math.round(performance.now()-started)});
  try{
   let token:string|undefined,savedEnv:string|undefined,savedReference:string|undefined;
   if(params.candidateId)token=this.candidates.read(params.candidateId,scope);
   else{const snapshot=await captureProfileApplySnapshot(this.input),config=JSON.parse(snapshot.files['config.json']??'{}'),key=config.channels?.telegram?.botTokenEnv;token=typeof key==='string'?readEnvSecretValue(snapshot.files['.env']??'',key):undefined;savedEnv=snapshot.files['.env']??undefined;savedReference=key;}
   if(!token)return failed('credential_missing');
   const response=await telegramRequest(token,'getMe',{},combined,this.fetcher);combined.throwIfAborted();
   const bot=response.result as {is_bot?:boolean;username?:string};
   if(!response.ok)return failed(response.invalidCredential?'invalid_credential':'unavailable');
   if(bot?.is_bot!==true||typeof bot.username!=='string'||!/^\w{1,64}$/.test(bot.username))return failed('invalid_response');
   if(params.candidateId){const id=params.candidateId;this.candidates.read(id,scope);this.#verified.add(id);if(!this.#watched.has(id)){this.#watched.add(id);this.candidates.signal(id,scope).addEventListener('abort',()=>{this.#verified.delete(id);this.#watched.delete(id);},{once:true});}}
   const verifiedAt=Date.now();if(savedEnv!==undefined&&savedReference)await rememberTelegramVerification(this.input,savedEnv,savedReference,verifiedAt);
   return{state:'passed',reason:'none',verifiedAt,botUsername:bot.username,latencyMs:Math.round(performance.now()-started)};
  }catch{return failed(combined.aborted?'cancelled':'unavailable');}finally{this.#inflight--;}
 }
 dispose(){this.#abort.abort();this.#verified.clear();this.#watched.clear();}
}
