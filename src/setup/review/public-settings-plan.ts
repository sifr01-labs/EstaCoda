import {buildSetupReviewManifest} from '../setup-review-manifest.js';
import {planSetupApply} from '../setup-apply-plan.js';
import type {SetupDraftBundle} from '../setup-drafts.js';
import type {SettingChange} from '../../contracts/desktop-control/index.js';
/** Plans are built by the profile-bound owner after review, not supplied by renderer callers. */
export function publicSettingsPlan(changes:SettingChange[],envVars:string[]=[]){
 const bundle:SetupDraftBundle={kind:'setup-draft-bundle',sourceKind:'setup-module-session',sourceId:'public-settings',blockers:[],warnings:[],safeToApplyLater:true,metadata:{draftCount:1,requiresReviewCount:1,readOnlyCount:0},drafts:[{
  id:'public-settings',kind:'optional-capability',source:{kind:'setup-module',moduleId:'public-settings',actionId:'review'},riskSurface:'security-policy',preserveUnrelatedConfig:true,requiresReview:true,readOnly:false,blockers:[],warnings:[],
  target:{kind:'config-scope',scope:['publicSettings'],preserveUnrelatedConfig:true},
  review:{copyKey:'setupDrafts.review',summaryKey:'setupDrafts.publicSettings.summary',redacted:true,values:{changes:JSON.stringify(changes),envVars}},
  applyIntent:{kind:'dry-run-apply-intent',dryRunOnly:true,writesConfig:false,writesTrustStore:false,effect:'config-patch'}
 }]};
 const planned=planSetupApply({kind:'approved-review-result',manifest:buildSetupReviewManifest([bundle])});if(planned.kind!=='apply-plan-ready')throw new Error('Settings need review');return planned.applyPlan;
}
