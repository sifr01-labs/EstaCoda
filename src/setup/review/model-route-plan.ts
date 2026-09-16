import {buildSetupReviewManifest} from '../setup-review-manifest.js';
import {planSetupApply} from '../setup-apply-plan.js';
import type {SetupDraft, SetupDraftBundle, SetupDraftReviewMetadata} from '../setup-drafts.js';

/** Fixed setup-module drafts; callers provide reviewed values, never arbitrary operations or file targets. */
export function primaryRoutePlan(values: SetupDraftReviewMetadata['values'], credentialEnv?:string, role:'provider'|'primary'|'fallback'|'fallback_order'|'auxiliary'|'auxiliary_mode'='primary') {
  const source={kind:'setup-module' as const,moduleId:'model-route',actionId:role};
  const base={source,preserveUnrelatedConfig:true as const,requiresReview:true,readOnly:false,blockers:[],warnings:[]};
  const intent={kind:'dry-run-apply-intent' as const,dryRunOnly:true as const,writesConfig:false as const,writesTrustStore:false as const};
  const drafts:SetupDraft[]=[{...base,id:'model-route',kind:(role==='primary'||role==='provider')?'provider-model-route':role.startsWith('auxiliary')?'auxiliary-model-route':'fallback-model-route',riskSurface:'provider-selection',
    target:{kind:'config-scope',scope:(role==='primary'||role==='provider')?(role==='provider'?['provider.route']:['model.provider','model.id','provider.route']):role.startsWith('auxiliary')?['auxiliaryModels.*']:['model.fallbacks'],preserveUnrelatedConfig:true},
    review:{copyKey:'setupDrafts.review',summaryKey:(role==='primary'||role==='provider')?'setupDrafts.providerModelRoute.summary':role==='fallback'?'setupDrafts.fallbackModelRoute.add.summary':role==='fallback_order'?'setupDrafts.fallbackModelRoutes.order.summary':role==='auxiliary'?'setupDrafts.auxiliaryModelRoute.summary':'setupDrafts.auxiliaryMode.summary',redacted:true,values:{...values,...(role==='provider'?{providerOnly:true}:{})}},
    applyIntent:{...intent,effect:'config-patch'}}];
  if(credentialEnv || values.authMethod==='oauth_device_pkce')drafts.push({...base,id:'model-credential',kind:'credential-reference',riskSurface:'credential-reference',
    target:{kind:'config-scope',scope:['provider.route'],preserveUnrelatedConfig:true},
    review:{copyKey:'setupDrafts.review',summaryKey:'setupDrafts.credentialReference.summary',redacted:true,values:{provider:values.provider,model:values.model,routeCredentialOnly:role!=='primary',
      ...(credentialEnv ? {envVars:[credentialEnv]} : {credentialSurface:'oauth',authMethod:'oauth_device_pkce',oauthCredentialStatus:'ready'})}},
    applyIntent:{...intent,effect:'credential-reference'}});
  const bundle:SetupDraftBundle={kind:'setup-draft-bundle',sourceKind:'setup-module-session',sourceId:'model-route',drafts,blockers:[],warnings:[],safeToApplyLater:true,
    metadata:{draftCount:drafts.length,requiresReviewCount:drafts.length,readOnlyCount:0}};
  const planned=planSetupApply({kind:'approved-review-result',manifest:buildSetupReviewManifest([bundle])});
  if(planned.kind!=='apply-plan-ready')throw new Error('Model route needs review');
  return planned.applyPlan;
}
