import {TelegramVerifier,telegramScope} from './telegram-verification.js';
export {telegramScope} from './telegram-verification.js';
import {randomUUID} from 'node:crypto';
import {loadRuntimeConfig} from '../config/runtime-config.js';
import {readEnvSecretValue} from '../config/env-secret-store.js';
import {telegramPlan} from '../setup/review/telegram-plan.js';
import {applyProfilePlan,captureProfileApplySnapshot,inspectProfileApply,latestProfileApplyOperation,type ProfileApplySnapshot} from '../setup/review/profile-apply.js';
import {ControlProtocolError,validateTelegramSettings,type TelegramSettings,type TelegramReview,type TelegramDraft,type ModelDraftBinding,type ModelApplyReceipt} from '../contracts/desktop-control/index.js';
import {CredentialCandidates} from './credential-candidates.js';
type Draft={params:TelegramReview;projection:TelegramDraft;snapshot:ProfileApplySnapshot;env:string;abort:AbortController;timer:ReturnType<typeof setTimeout>;applying:boolean;consumed:boolean};

/** Reviewed profile transaction; no setup action starts a gateway or sends a message. */
export class TelegramSetup {
 readonly #drafts=new Map<string,Draft>();#closed=false;
 constructor(readonly input:{homeDir:string;profileId:string},readonly candidates:CredentialCandidates,readonly changed:()=>void|Promise<void>,readonly verifier:TelegramVerifier){}
 async settings():Promise<TelegramSettings>{
  const loaded=await loadRuntimeConfig({...this.input,workspaceRoot:this.input.homeDir,configurationInspection:true}),config=loaded.config.channels?.telegram;
  return{enabled:config?.enabled===true,authorization:config?.pairing?.code?'pairing':'allowlist',allowedUserIds:config?.allowedUserIds??[],allowedChatIds:config?.allowedChatIds??[],secureInputMode:config?.secureInputMode??'protected-handoff',directDmAcknowledged:false,streaming:config?.streaming?.enabled!==false,pollTimeoutSeconds:config?.pollTimeoutSeconds??25};
 }
 async review(params:TelegramReview):Promise<TelegramDraft>{
  validateTelegramSettings(params.settings);const signal=this.candidates.windowSignal(params.windowId,params.generation);
  for(const[id,draft]of this.#drafts)if(draft.consumed)this.#drafts.delete(id);
  if(this.#closed||this.#drafts.size>=32)throw new ControlProtocolError('-32009');
  const snapshot=await captureProfileApplySnapshot(this.input),config=JSON.parse(snapshot.files['config.json']??'{}');
  const draftId=randomUUID(),env=params.candidateId?'ESTACODA_TELEGRAM_BOT_TOKEN_'+draftId.replaceAll('-','').toUpperCase():config.channels?.telegram?.botTokenEnv??'ESTACODA_TELEGRAM_BOT_TOKEN';
  if(params.candidateId)this.candidates.bindRoute(params.candidateId,telegramScope({windowId:params.windowId,generation:params.generation}),JSON.stringify(params.settings));
  const existing=Boolean(readEnvSecretValue(snapshot.files['.env']??'',env)?.trim());
  if(params.settings.enabled&&!params.candidateId&&!existing)throw new ControlProtocolError('-32602');
  signal.throwIfAborted();if(this.#closed)throw new ControlProtocolError('-32003');
  const projection:TelegramDraft={draftId,expiresInMs:300000,settings:structuredClone(params.settings),credentialState:params.candidateId?'staged':existing?'existing':'missing'};
  const binding={draftId,windowId:params.windowId,generation:params.generation};
  const timer=setTimeout(()=>{try{this.cancel(binding);}catch{}},300000);timer.unref();
  this.#drafts.set(draftId,{params:structuredClone(params),projection,snapshot,env,abort:new AbortController(),timer,applying:false,consumed:false});
  signal.addEventListener('abort',()=>{try{this.cancel(binding);}catch{}},{once:true});return projection;
 }
 private require(binding:ModelDraftBinding){const draft=this.#drafts.get(binding.draftId);if(this.#closed||!draft||draft.params.windowId!==binding.windowId||draft.params.generation!==binding.generation)throw new ControlProtocolError('-32003');return draft;}
 async apply(binding:ModelDraftBinding,signal:AbortSignal):Promise<ModelApplyReceipt>{
  const draft=this.require(binding);if(draft.applying||draft.consumed)return this.inspect(binding.draftId);
  const scope=telegramScope({windowId:binding.windowId,generation:binding.generation}),candidate=draft.params.candidateId;
  const combined=AbortSignal.any([signal,draft.abort.signal,this.candidates.windowSignal(binding.windowId,binding.generation),...(candidate?[this.candidates.signal(candidate,scope)]:[])]);
  combined.throwIfAborted();if(candidate&&draft.params.settings.enabled&&!this.verifier.verified({windowId:binding.windowId,generation:binding.generation,candidateId:candidate}))throw new ControlProtocolError('-32602');const token=candidate?this.candidates.read(candidate,scope):undefined;draft.applying=true;
  try{
   const receipt=await applyProfilePlan({...this.input,operationId:binding.draftId,snapshot:draft.snapshot,plan:telegramPlan(draft.params.settings,draft.env),secrets:token?[{envVarName:draft.env,value:token}]:[],signal:combined});
   draft.consumed=true;draft.snapshot={files:{'.env':null,'auth.json':null,'config.json':null}};await this.changed();return{...receipt,verification:receipt.state==='applied'?await this.verifySaved():'not_tested'};
  }finally{draft.applying=false;clearTimeout(draft.timer);if(!draft.consumed)this.#drafts.delete(binding.draftId);if(candidate)try{this.candidates.discard(candidate,scope);}catch{}}
 }
 async inspect(operationId?:string):Promise<ModelApplyReceipt>{const receipt=await inspectProfileApply(this.input,operationId??await latestProfileApplyOperation(this.input)??'none');return{...receipt,verification:receipt.state==='applied'?await this.verifySaved():'not_tested'};}
 private async verifySaved():Promise<ModelApplyReceipt['verification']>{
  try{const settings=await this.settings();validateTelegramSettings({...settings,directDmAcknowledged:true});const snapshot=await captureProfileApplySnapshot(this.input),config=JSON.parse(snapshot.files['config.json']??'{}');return !settings.enabled||Boolean(readEnvSecretValue(snapshot.files['.env']??'',config.channels?.telegram?.botTokenEnv)?.trim())?'configured':'repair_required';}catch{return 'repair_required';}
 }
 cancel(binding:ModelDraftBinding){const draft=this.#drafts.get(binding.draftId);if(!draft)return{cancelled:true};this.require(binding);draft.abort.abort();clearTimeout(draft.timer);if(!draft.applying){this.#drafts.delete(binding.draftId);if(draft.params.candidateId)try{this.candidates.discard(draft.params.candidateId,telegramScope({windowId:binding.windowId,generation:binding.generation}));}catch{}}return{cancelled:!draft.applying&&!draft.consumed};}
 dispose(){this.#closed=true;for(const draft of this.#drafts.values()){draft.abort.abort();clearTimeout(draft.timer);}this.#drafts.clear();}
}
