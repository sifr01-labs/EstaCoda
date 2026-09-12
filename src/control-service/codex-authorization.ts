import {randomUUID} from 'node:crypto';
import {runCodexOAuthFlow,type FetchLike} from '../providers/oauth/codex-oauth.js';
import {buildCodexOAuthTokenRecord,CODEX_DEFAULT_BASE_URL} from '../providers/oauth/codex-setup.js';
import {ControlProtocolError,type OAuthStatus,type OAuthBinding} from '../contracts/desktop-control/index.js';
import {CredentialCandidates,type CandidateScope} from './credential-candidates.js';
import {verificationFetch} from './verification-fetch.js';
const paths=new Set(['/api/accounts/deviceauth/usercode','/api/accounts/deviceauth/token','/oauth/token']);
function oauthFetch(signal:AbortSignal):FetchLike {
 return async(url,init)=>{
  const target=new URL(url);if(target.origin!=='https://auth.openai.com'||!paths.has(target.pathname)||target.search||target.hash||target.username||target.password)throw new Error('Invalid authorization endpoint');
  const requestSignal=AbortSignal.any([signal,AbortSignal.timeout(15000)]);
  const base=target.origin+target.pathname.slice(0,target.pathname.lastIndexOf('/'));
  return verificationFetch(base,false,requestSignal)(url,init);
 };
}
type Entry={scope:CandidateScope;status:OAuthStatus;abort:AbortController;timer:ReturnType<typeof setTimeout>};
/** Fixed-provider, memory-only OAuth. No callback URL, token, or arbitrary endpoint enters ordinary RPC. */
export class CodexAuthorization {
 readonly #entries=new Map<string,Entry>();#closed=false;
 constructor(readonly candidates:CredentialCandidates,readonly fetchFactory=oauthFetch){}
 start(params:{windowId:string;generation:number}):OAuthStatus {
  if(this.#closed || this.#entries.size>=8)throw new ControlProtocolError('-32009');
  const window=this.candidates.windowSignal(params.windowId,params.generation);
  for(const [id,entry] of this.#entries)if(entry.scope.windowId===params.windowId)this.cancel({...params,authorizationId:id});
  const scope:CandidateScope={...params,purpose:'provider',providerId:'codex',authMethod:'oauth',endpoint:CODEX_DEFAULT_BASE_URL};
  const id=randomUUID(),abort=new AbortController();
  const status:OAuthStatus={authorizationId:id,state:'starting',verificationUrl:null,userCode:null,candidateId:null};
  const timer=setTimeout(()=>{abort.abort();this.#entries.delete(id);},900000);timer.unref();
  const entry:Entry={scope,status,abort,timer};this.#entries.set(id,entry);
  const signal=AbortSignal.any([window,abort.signal]);
  const cancel=()=>{clearTimeout(timer);if(entry.status.candidateId){try{this.candidates.discard(entry.status.candidateId,scope);}catch{}}this.#entries.delete(id);};
  signal.addEventListener('abort',cancel,{once:true});
  void runCodexOAuthFlow({signal,fetchLike:this.fetchFactory(signal),onDeviceCode:notice=>{
   if(signal.aborted || this.#entries.get(id)!==entry)return;
   if(notice.verificationUri!=='https://auth.openai.com/codex/device'||!/^[-A-Z0-9]{1,32}$/i.test(notice.userCode)){abort.abort();return;}
   entry.status={...status,state:'pending',verificationUrl:notice.verificationUri,userCode:notice.userCode};
  }}).then(result=>{
   if(signal.aborted || this.#entries.get(id)!==entry)return;
   if(result.kind==='success'){
    const candidateId=this.candidates.stage(scope,JSON.stringify(buildCodexOAuthTokenRecord(result.tokens)));
    entry.status={...status,state:'authorized',candidateId};
   }else entry.status={...status,state:result.kind==='timeout'?'expired':result.kind==='cancelled'?'cancelled':'failed'};
  }).catch(()=>{if(this.#entries.get(id)===entry)entry.status={...status,state:'failed'};});
  return {...status};
 }
 status(binding:OAuthBinding):OAuthStatus {const entry=this.require(binding);if(entry.status.candidateId){try{this.candidates.read(entry.status.candidateId,entry.scope);}catch{entry.status={...entry.status,state:'expired',candidateId:null};}}return {...entry.status};}
 cancel(binding:OAuthBinding):{cancelled:boolean}{const entry=this.#entries.get(binding.authorizationId);if(!entry)return {cancelled:true};this.require(binding);entry.abort.abort();return {cancelled:true};}
 dispose(){this.#closed=true;for(const entry of this.#entries.values())entry.abort.abort();this.#entries.clear();}
 private require(binding:OAuthBinding){const entry=this.#entries.get(binding.authorizationId);if(this.#closed||!entry||entry.scope.windowId!==binding.windowId||entry.scope.generation!==binding.generation)throw new ControlProtocolError('-32003');return entry;}
}
