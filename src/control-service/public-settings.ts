import {runtimeSettingsMetadata} from './runtime-settings-metadata.js';
import {mediaSettingsMetadata} from './media-settings-metadata.js';
import {webSettingsMetadata} from './web-settings-metadata.js';
import type {PreparedProfilePart} from '../setup/review/compose-profile-plans.js';
import {envContentHasSecret} from '../config/env-secret-store.js';
import {publicSettingsPlan} from '../setup/review/public-settings-plan.js';
import {applyProfilePlan,inspectProfileApply,latestProfileApplyOperation} from '../setup/review/profile-apply.js';
import {loadRuntimeConfig} from '../config/runtime-config.js';
import type {CandidateScope} from './credential-candidates.js';
import {randomUUID} from 'node:crypto';
import {ControlProtocolError,type SettingsSection,type SettingsPage,type SettingChange,type SettingsReview,type SettingsBinding} from '../contracts/desktop-control/index.js';
import {PUBLIC_SETTINGS,settingField,settingPath,settingValue,settingSecretState} from '../setup/public-settings.js';
import {captureProfileApplySnapshot,type ProfileApplySnapshot} from '../setup/review/profile-apply.js';
import {CredentialCandidates} from './credential-candidates.js';
type Draft={snapshot:ProfileApplySnapshot;review:SettingsReview;windowId:string;generation:number;timer:ReturnType<typeof setTimeout>;signal:AbortSignal;expires:number;cleanup:()=>void;changes:SettingChange[];applying:boolean;abort:AbortController};
/** Profile identity is supplied by the bridge; drafts are bound to the private candidate window lifetime. */
export class PublicSettings {
 readonly drafts=new Map<string,Draft>();
 #closed=false;
 constructor(readonly input:{homeDir:string;profileId:string},readonly candidates:CredentialCandidates,readonly changed:()=>void|Promise<void>=()=>{}){}
 async read(section:SettingsSection,offset=0):Promise<SettingsPage>{
  const snapshot=await captureProfileApplySnapshot(this.input),config=JSON.parse(snapshot.files['config.json']??'{}');
  // The effective private-site policy has security precedence over the legacy browser alias.
  const all=PUBLIC_SETTINGS.filter(field=>field.section===section||section==='browser'&&field.id==='security.allowPrivateUrls'),fields=all.slice(offset,offset+20);
  const values=fields.filter(f=>!f.path.includes('*')&&!f.path.includes('#')&&f.kind!=='secret').map(field=>({fieldId:field.id,selectors:[],value:settingValue(config,field.path)}));
  while(Buffer.byteLength(JSON.stringify({fields,values}))>44000&&fields.length>1){const removed=fields.pop()!;const i=values.findIndex(v=>v.fieldId===removed.id);if(i>=0)values.splice(i,1);}
  const runtime=section==='runtime'?runtimeSettingsMetadata(config,fields,snapshot.files['.env']??''):undefined;
  const media=section==='vision'||section==='voice'?await mediaSettingsMetadata(this.input,fields,snapshot.files['.env']??'',offset===0).catch(()=>undefined):undefined;
  const web=section==='browser'?await webSettingsMetadata(this.input,fields,snapshot.files['.env']??'',offset===0).catch(()=>undefined):undefined;
  while(Buffer.byteLength(JSON.stringify({fields,values,media,web,runtime}))>44000&&fields.length>1){const removed=fields.pop()!;const i=values.findIndex(v=>v.fieldId===removed.id);if(i>=0)values.splice(i,1);for(const metadata of [media,web,runtime])if(metadata){metadata.effective=metadata.effective.filter(v=>v.fieldId!==removed.id);metadata.defaults=metadata.defaults.filter(v=>v.fieldId!==removed.id);}}
  const next=offset+fields.length;return {...(runtime?{runtime}:{}),...(media?{media}:{}),...(web?{web}:{}),fields:structuredClone(fields),values,truncated:all.length>next,...(all.length>next?{nextOffset:next}:{})};
 }
 async value(params:{fieldId:string;selectors:string[]}){const change={...params,value:null},field=settingField(change);const snapshot=await captureProfileApplySnapshot(this.input);const value=field.envName?(envContentHasSecret(snapshot.files['.env']??'',field.envName)?'configured':null):field.kind==='secret'?settingSecretState(JSON.parse(snapshot.files['config.json']??'{}'),settingPath(field,params.selectors)):settingValue(JSON.parse(snapshot.files['config.json']??'{}'),settingPath(field,params.selectors));return {...params,value:field.kind==='secret'?(value===null?null:'configured'):value};}
 async review(params:{windowId:string;generation:number;changes:SettingChange[]}):Promise<SettingsReview>{
  if(this.#closed)throw new ControlProtocolError('-32003');
  const signal=this.candidates.windowSignal(params.windowId,params.generation);if(this.drafts.size>=32)throw new ControlProtocolError('-32009');
  if(!params.changes.length||params.changes.length>32||new Set(params.changes.map(c=>JSON.stringify([c.fieldId,c.selectors]))).size!==params.changes.length)throw new ControlProtocolError('-32602');
  params.changes.forEach(change=>{const field=settingField(change);if(field.kind==='secret'&&change.value!==null){const scope=this.scope(params,field.id);this.candidates.bindRoute(String(change.value),scope,JSON.stringify([field.id,change.selectors]));this.candidates.read(String(change.value),scope);}});
  const snapshot=await captureProfileApplySnapshot(this.input),config=JSON.parse(snapshot.files['config.json']??'{}');signal.throwIfAborted();if(this.#closed||this.drafts.size>=32)throw new ControlProtocolError('-32009');
  const changes=structuredClone(params.changes),draftId=randomUUID();
  const review={draftId,changes:changes.map(c=>settingField(c).kind==='secret'?{...c,value:c.value===null?null:'staged'}:c),previous:changes.map(c=>({...c,value:settingField(c).envName?(envContentHasSecret(snapshot.files['.env']??'',settingField(c).envName!)?'configured':null):settingField(c).kind==='secret'?settingSecretState(config,settingPath(settingField(c),c.selectors)):settingValue(config,settingPath(settingField(c),c.selectors))})),expiresInMs:300000};
  if(Buffer.byteLength(JSON.stringify(review))>48000)throw new ControlProtocolError('-32009');
  const abort=new AbortController();const cleanup=()=>{abort.abort();clearTimeout(timer);signal.removeEventListener('abort',cleanup);if(!this.drafts.get(draftId)?.applying){this.drafts.delete(draftId);for(const change of changes)if(settingField(change).kind==='secret'&&change.value!==null){try{this.candidates.discard(String(change.value),this.scope(params,change.fieldId));}catch{}}}};
  const timer=setTimeout(cleanup,300000);timer.unref();
  this.drafts.set(draftId,{snapshot,review,windowId:params.windowId,generation:params.generation,timer,signal,expires:performance.now()+300000,cleanup,changes,applying:false,abort});
  signal.addEventListener('abort',cleanup,{once:true});return structuredClone(review);
 }
 require(params:SettingsBinding):Draft {const draft=this.drafts.get(params.draftId);if(this.#closed||!draft||performance.now()>=draft.expires||draft.windowId!==params.windowId||draft.generation!==params.generation||draft.signal.aborted)throw new ControlProtocolError('-32003');return draft;}
 scope(params:{windowId:string;generation:number},fieldId:string):CandidateScope{return {windowId:params.windowId,generation:params.generation,purpose:'settings',providerId:fieldId,authMethod:'api_key',endpoint:'https://settings.estacoda.invalid'};}
 prepareApply(params:SettingsBinding,signal:AbortSignal):PreparedProfilePart{
  const draft=this.require(params);if(draft.applying)throw new ControlProtocolError('-32007');
  const secrets:Array<{envVarName:string;value:string}>=[],signals=[signal,draft.signal,draft.abort.signal];
  const changes=draft.changes.map(change=>{const field=settingField(change);if(field.envName&&change.value===null){secrets.push({envVarName:field.envName,value:''});return change;}if(field.kind!=='secret'||change.value===null)return change;const scope=this.scope(params,change.fieldId),candidateId=String(change.value),envVarName=field.envName??'ESTACODA_CREDENTIAL_'+randomUUID().replaceAll('-','').toUpperCase();signals.push(this.candidates.signal(candidateId,scope));secrets.push({envVarName,value:this.candidates.read(candidateId,scope)});return {...change,value:envVarName};});
  const combined=AbortSignal.any(signals);combined.throwIfAborted();const plan=publicSettingsPlan(changes,secrets.map(s=>s.envVarName));draft.applying=true;
  return {snapshot:draft.snapshot,plan,secrets,oauth:[],signal:combined,finish:async committed=>{draft.applying=false;if(committed||draft.abort.signal.aborted){draft.cleanup();if(committed)await this.changed();}}};
 }
 async apply(params:SettingsBinding,signal:AbortSignal){
  const part=this.prepareApply(params,signal);let committed=false;
  try{const receipt=await applyProfilePlan({...this.input,operationId:params.draftId,...part});committed=receipt.state==='applied'||receipt.state==='uncertain';return receipt;}finally{await part.finish(committed);}
 }
 async inspect(operationId?:string){const id=operationId??await latestProfileApplyOperation(this.input);return id?inspectProfileApply(this.input,id):{operationId:'none',state:'unknown' as const};}
 async verify(){try{await loadRuntimeConfig({...this.input,workspaceRoot:this.input.homeDir,configurationInspection:true});return {state:'configured' as const};}catch{return {state:'repair_required' as const};}}
 cancel(params:SettingsBinding){const draft=this.require(params);draft.abort.abort();if(draft.applying)return {cancelled:false};draft.cleanup();return {cancelled:true};}
 dispose(){this.#closed=true;for(const draft of this.drafts.values())draft.cleanup();}
}
