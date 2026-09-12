import {randomUUID} from 'node:crypto';
import {ControlProtocolError,type SettingsSection,type SettingsPage,type SettingChange,type SettingsReview,type SettingsBinding} from '../contracts/desktop-control/index.js';
import {PUBLIC_SETTINGS,settingField,settingPath,settingValue} from '../setup/public-settings.js';
import {captureProfileApplySnapshot,type ProfileApplySnapshot} from '../setup/review/profile-apply.js';
import {CredentialCandidates} from './credential-candidates.js';
type Draft={snapshot:ProfileApplySnapshot;review:SettingsReview;windowId:string;generation:number;timer:ReturnType<typeof setTimeout>;signal:AbortSignal;expires:number;cleanup:()=>void};
/** Profile identity is supplied by the bridge; drafts are bound to the private candidate window lifetime. */
export class PublicSettings {
 readonly drafts=new Map<string,Draft>();
 #closed=false;
 constructor(readonly input:{homeDir:string;profileId:string},readonly candidates:CredentialCandidates){}
 async read(section:SettingsSection):Promise<SettingsPage>{
  const snapshot=await captureProfileApplySnapshot(this.input),config=JSON.parse(snapshot.files['config.json']??'{}');
  const all=PUBLIC_SETTINGS.filter(field=>field.section===section),fields=all.slice(0,100);
  const values=fields.filter(f=>!f.path.includes('*')&&!f.path.includes('#')&&f.kind!=='secret').map(field=>({fieldId:field.id,selectors:[],value:settingValue(config,field.path)}));
  return {fields:structuredClone(fields),values,truncated:all.length>100};
 }
 async review(params:{windowId:string;generation:number;changes:SettingChange[]}):Promise<SettingsReview>{
  if(this.#closed)throw new ControlProtocolError('-32003');
  const signal=this.candidates.windowSignal(params.windowId,params.generation);if(this.drafts.size>=32)throw new ControlProtocolError('-32009');
  if(!params.changes.length||params.changes.length>32||new Set(params.changes.map(c=>JSON.stringify([c.fieldId,c.selectors]))).size!==params.changes.length)throw new ControlProtocolError('-32602');
  params.changes.forEach(settingField);
  const snapshot=await captureProfileApplySnapshot(this.input),config=JSON.parse(snapshot.files['config.json']??'{}');signal.throwIfAborted();if(this.#closed||this.drafts.size>=32)throw new ControlProtocolError('-32009');
  const changes=structuredClone(params.changes),draftId=randomUUID();
  const review={draftId,changes,previous:changes.map(c=>({...c,value:settingValue(config,settingPath(settingField(c),c.selectors))})),expiresInMs:300000};
  const cleanup=()=>{clearTimeout(timer);signal.removeEventListener('abort',cleanup);this.drafts.delete(draftId);};
  const timer=setTimeout(cleanup,300000);timer.unref();
  this.drafts.set(draftId,{snapshot,review,windowId:params.windowId,generation:params.generation,timer,signal,expires:performance.now()+300000,cleanup});
  signal.addEventListener('abort',cleanup,{once:true});return structuredClone(review);
 }
 require(params:SettingsBinding):Draft {const draft=this.drafts.get(params.draftId);if(this.#closed||!draft||performance.now()>=draft.expires||draft.windowId!==params.windowId||draft.generation!==params.generation||draft.signal.aborted)throw new ControlProtocolError('-32003');return draft;}
 cancel(params:SettingsBinding){const draft=this.require(params);draft.cleanup();return {cancelled:true};}
 dispose(){this.#closed=true;for(const draft of this.drafts.values())draft.cleanup();}
}
