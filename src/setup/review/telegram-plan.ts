import {buildSetupReviewManifest} from '../setup-review-manifest.js';
import {planSetupApply} from '../setup-apply-plan.js';
import type {SetupDraftBundle} from '../setup-drafts.js';
import type {TelegramSettings} from '../../contracts/desktop-control/telegram.js';
export function telegramPlan(settings:TelegramSettings,botTokenEnv:string){
 const source={kind:'setup-module' as const,moduleId:'telegram',actionId:'desktop-review'};
 const bundle:SetupDraftBundle={kind:'setup-draft-bundle',sourceKind:'setup-module-session',sourceId:'telegram',blockers:[],warnings:[],safeToApplyLater:true,metadata:{draftCount:1,requiresReviewCount:1,readOnlyCount:0},drafts:[{
  id:'telegram',kind:'optional-capability',source,riskSurface:'optional-capability',preserveUnrelatedConfig:true,requiresReview:true,readOnly:false,blockers:[],warnings:[],
  target:{kind:'config-scope',scope:['channels'],preserveUnrelatedConfig:true},
  review:{copyKey:'setupDrafts.review',summaryKey:'setupModules.telegram.draft',redacted:true,values:{...settings,botTokenEnv,desktop:true}},
  applyIntent:{kind:'dry-run-apply-intent',dryRunOnly:true,writesConfig:false,writesTrustStore:false,effect:'config-patch'}
 }]};
 const result=planSetupApply({kind:'approved-review-result',manifest:buildSetupReviewManifest([bundle])});
 if(result.kind!=='apply-plan-ready')throw new Error('Telegram setup needs review');return result.applyPlan;
}
