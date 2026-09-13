import {reviewSettingsPack,executeSettingsPack} from './settings-packs.js';
import {randomUUID} from 'node:crypto';
import {normalizeProfileId,readActiveProfile,writeActiveProfile} from '../config/profile-home.js';
import {ensureProfileSkeleton,profileExists} from '../cli/profile-state.js';
import {WorkspaceRegistry,normalizeWorkspaceAlias,resolveWorkspaceDirectory} from '../workspaces/workspace-registry.js';
import {WorkspaceTrustStore} from '../security/workspace-trust-store.js';
import {ConnectionOperations} from './connection-operations.js';
import {ControlProtocolError,type SettingsAction,type SettingsActionReview,type SettingsWorkspace} from '../contracts/desktop-control/index.js';
/** Reviews bind the selected profile and directory identity. Registration never grants trust. */
export class SettingsActions {
 readonly operations:ConnectionOperations;
 readonly reviews=new Map<string,{review:SettingsActionReview;baseline:string}>();
 constructor(readonly input:{homeDir:string;profileId:string}){this.operations=new ConnectionOperations(input);}
 async workspaces(){
  const registry=new WorkspaceRegistry(this.input),trust=new WorkspaceTrustStore(this.input);
  try{const all=registry.list(),items:SettingsWorkspace[]=[];for(const w of all.slice(0,100))items.push({id:w.id,alias:w.alias,path:w.identity.canonicalPath,revision:w.locationRevision,trusted:await trust.isTrusted(w.identity.canonicalPath).catch(()=>false)});return {items,truncated:all.length>100};}finally{registry.close();}
 }
 private async state(action:SettingsAction):Promise<{baseline:string;facts:string[]}>{
  if(action.action.startsWith('pack.'))return reviewSettingsPack(this.input,action);
  if(action.action.startsWith('profile.')){
   const id=normalizeProfileId(action.subject);if(id!==action.subject)throw new ControlProtocolError('-32602');
   const exists=await profileExists({...this.input,profileId:id});
   if(action.action==='profile.default'?!exists:exists)throw new ControlProtocolError('-32003');
   if(action.action==='profile.copy'&&action.value.split(',').some(x=>!['user','memory','soul'].includes(x)))throw new ControlProtocolError('-32602');
   if(action.action!=='profile.copy'&&action.value!=='')throw new ControlProtocolError('-32602');
   return {baseline:JSON.stringify([exists,readActiveProfile(this.input).profileId]),facts:[this.input.profileId,id,...(action.action==='profile.copy'?[action.value]:[])]};
  }
  const registry=new WorkspaceRegistry(this.input);
  try{
   const w=action.action==='workspace.add'?undefined:await registry.resolve(action.subject);
   if(action.action==='workspace.add'){normalizeWorkspaceAlias(action.subject);if(registry.get(action.subject))throw new ControlProtocolError('-32003');}
   if(action.action==='workspace.rename')normalizeWorkspaceAlias(action.value);
   if(['workspace.remove','workspace.trust','workspace.revoke'].includes(action.action)&&action.value!=='')throw new ControlProtocolError('-32602');
   const destination=['workspace.add','workspace.move'].includes(action.action)?await resolveWorkspaceDirectory(action.value):undefined;
   const grants=['workspace.trust','workspace.revoke'].includes(action.action)?await new WorkspaceTrustStore(this.input).list():[];
   return {baseline:JSON.stringify([w??null,destination??null,grants]),facts:[this.input.profileId,...(w?[w.alias,w.identity.canonicalPath]:[action.subject]),...(destination?[destination.canonicalPath]:[]),...(action.action==='workspace.rename'?[action.value]:[])]};
  }finally{registry.close();}
 }
 async review(action:SettingsAction){
  for(const [id,item] of this.reviews)if(item.review.expiresAt<=Date.now())this.reviews.delete(id);
  if(this.reviews.size>=16)throw new ControlProtocolError('-32009');
  const {baseline,facts}=await this.state(action),review={reviewId:randomUUID(),action:structuredClone(action),facts,expiresAt:Date.now()+300000};this.reviews.set(review.reviewId,{review,baseline});return review;
 }
 cancel(reviewId:string){return {cancelled:this.reviews.delete(reviewId)};}
 async execute(input:{reviewId:string;operationId:string;confirmed:true}){
  const record=this.reviews.get(input.reviewId);if(!record||record.review.expiresAt<=Date.now()||input.confirmed!==true)throw new ControlProtocolError('-32003');
  const a=record.review.action;
  if((await this.state(a)).baseline!==record.baseline)throw new ControlProtocolError('-32003');
  this.reviews.delete(input.reviewId);
  return this.operations.execute(input.operationId,a.action,async()=>{
   if((await this.state(a)).baseline!==record.baseline)return false;
   if(a.action.startsWith('pack.'))return executeSettingsPack(this.input,a,record.baseline);
   if(a.action==='profile.default'){writeActiveProfile(a.subject,this.input);return true;}
   if(a.action==='profile.create'||a.action==='profile.copy'){await ensureProfileSkeleton({...this.input,profileId:a.subject,sourceProfileId:this.input.profileId,blank:a.action==='profile.create',copyFiles:a.action==='profile.copy'?a.value.split(',') as ('user'|'memory'|'soul')[]:[],failIfExists:true});return true;}
   const registry=new WorkspaceRegistry(this.input);
   try{
    if(a.action==='workspace.add')await registry.add(a.subject,a.value);
    else {const w=await registry.resolve(a.subject);
     if(a.action==='workspace.rename')registry.rename(w.id,a.value);
     else if(a.action==='workspace.move')await registry.move(w.id,a.value,w.locationRevision);
     else if(a.action==='workspace.remove')registry.remove(w.id);
     else if(a.action==='workspace.trust')await new WorkspaceTrustStore(this.input).grant(w.identity.canonicalPath);
     else if(a.action==='workspace.revoke')return new WorkspaceTrustStore(this.input).revoke(w.identity.canonicalPath);
    }return true;
   }finally{registry.close();}
  });
 }
}
