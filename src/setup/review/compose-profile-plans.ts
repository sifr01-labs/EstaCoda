import type {SetupApplyPlan,SetupDeferredSecretWrite,SetupDeferredOAuthWrite} from '../setup-apply-plan.js';
import type {ProfileApplySnapshot} from './profile-apply.js';
export type PreparedProfilePart={snapshot:ProfileApplySnapshot;plan:SetupApplyPlan;secrets:SetupDeferredSecretWrite[];oauth:SetupDeferredOAuthWrite[];signal:AbortSignal;finish:(committed:boolean)=>Promise<void>};
/** Only private core owners produce parts; this type is never serialized over Desktop IPC. */
export function composeProfilePlans(parts:SetupApplyPlan[]):SetupApplyPlan{
 const operations=parts.flatMap((p,index)=>p.operations.map(o=>({...o,id:`part-${index}:${o.id}`})));
 return {...parts[0]!,operations,manifestSourceBundleIds:parts.flatMap(p=>p.manifestSourceBundleIds),metadata:{operationCount:operations.length,configOperationCount:operations.filter(o=>o.kind==='config-patch').length,credentialOperationCount:operations.filter(o=>o.kind==='credential-reference').length,trustOperationCount:0}};
}
