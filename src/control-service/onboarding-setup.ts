import {randomUUID} from 'node:crypto';
import {ControlProtocolError,type OnboardingReview,type ModelDraftBinding,type SettingsBinding,type SettingChange} from '../contracts/desktop-control/index.js';
import {applyProfilePlan,captureProfileApplySnapshot,recoverProfileApply} from '../setup/review/profile-apply.js';
import {composeProfilePlans,type PreparedProfilePart} from '../setup/review/compose-profile-plans.js';
import {publicSettingsPlan} from '../setup/review/public-settings-plan.js';
import {settingField} from '../setup/public-settings.js';
import {detectOnboarding} from './onboarding-detection.js';
import type {ModelSetup} from './model-setup.js';import type {PublicSettings} from './public-settings.js';import type {OnboardingWorkspace} from './onboarding-workspace.js';
type ReviewInput={model:ModelDraftBinding;optional?:SettingsBinding;preferences:SettingChange[];workspaceReviewId:string};
export class OnboardingSetup{
 readonly reviews=new Map<string,{input:ReviewInput;projection:OnboardingReview;expires:number}>();
 constructor(readonly input:{homeDir:string;profileId:string},readonly models:ModelSetup,readonly settings:PublicSettings,readonly workspaces:OnboardingWorkspace){}
 async review(params:ReviewInput):Promise<OnboardingReview>{
  if((await detectOnboarding(this.input)).mode!=='first-run')throw new ControlProtocolError('-32003');
  if(params.preferences.length!==4||new Set(params.preferences.map(c=>c.fieldId)).size!==4||params.preferences.some(c=>!['ui.language','ui.flavor','security.approvalMode','skills.autonomy'].includes(c.fieldId)||c.selectors.length||c.value===null))throw new ControlProtocolError('-32602');params.preferences.forEach(c=>settingField(c));
  const model=this.models.reviewed(params.model),optional=params.optional?this.settings.require(params.optional):undefined,workspace=this.workspaces.reviews.get(params.workspaceReviewId);
  if(!workspace||workspace.expires<Date.now()||optional&&(optional.changes.some(c=>!['channels','voice','browser'].includes(settingField(c).section))||JSON.stringify(optional.snapshot.files)!==JSON.stringify(model.snapshot.files)))throw new ControlProtocolError('-32003');
  if(JSON.stringify((await captureProfileApplySnapshot(this.input)).files)!==JSON.stringify(model.snapshot.files))throw new ControlProtocolError('-32007');
  for(const [id,r]of this.reviews)if(r.expires<Date.now())this.reviews.delete(id);if(this.reviews.size>=16)throw new ControlProtocolError('-32009');
  const projection={reviewId:randomUUID(),route:model.projection,changes:[...params.preferences,...(optional?.review.changes??[])],workspace:workspace.projection};
  this.reviews.set(projection.reviewId,{input:structuredClone(params),projection,expires:Date.now()+300000});return structuredClone(projection);
 }
 async apply(reviewId:string,signal:AbortSignal){
  const r=this.reviews.get(reviewId);if(!r||r.expires<Date.now())throw new ControlProtocolError('-32003');
  // A second first-run check protects an existing installation changed since review.
  if((await detectOnboarding(this.input)).mode!=='first-run')throw new ControlProtocolError('-32003');
  await this.workspaces.validate(r.input.workspaceReviewId);
  const parts:PreparedProfilePart[]=[];let committed=false;
  try{
   parts.push(this.models.prepareApply(r.input.model,signal));if(r.input.optional)parts.push(this.settings.prepareApply(r.input.optional,signal));
   const plans=[...parts.map(p=>p.plan),publicSettingsPlan(r.input.preferences)];
   const receipt=await applyProfilePlan({...this.input,operationId:reviewId,snapshot:parts[0]!.snapshot,plan:composeProfilePlans(plans),secrets:parts.flatMap(p=>p.secrets),oauth:parts.flatMap(p=>p.oauth),signal:AbortSignal.any(parts.map(p=>p.signal))});
   committed=receipt.state==='applied'||receipt.state==='uncertain';return receipt;
  }finally{await Promise.all(parts.map(p=>p.finish(committed)));this.reviews.delete(reviewId);}
 }
 async recover(){await recoverProfileApply(this.input);return this.settings.inspect();}
 dispose(){this.reviews.clear();}
}
