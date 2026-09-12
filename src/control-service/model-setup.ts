import {captureModelCatalog} from './model-catalog.js';
import {randomUUID} from 'node:crypto';
import {candidateRouteBinding, ControlProtocolError, type MethodContracts, type ModelDraftBinding, type ModelRouteDraft, type ModelApplyReceipt} from '../contracts/desktop-control/index.js';
import {getProviderMetadata} from '../providers/provider-metadata.js';
import {loadRuntimeConfig} from '../config/runtime-config.js';
import {primaryRoutePlan} from '../setup/review/model-route-plan.js';
import {captureProfileApplySnapshot,applyProfilePlan,inspectProfileApply,type ProfileApplySnapshot} from '../setup/review/profile-apply.js';
import {CredentialCandidates,type CandidateScope} from './credential-candidates.js';
import {validateCandidateRequest} from './candidate-verification.js';
type Draft={expires:number;params:MethodContracts['models.reviewPrimary']['params'];projection:ModelRouteDraft;snapshot:ProfileApplySnapshot;credentialEnv?:string;scope:CandidateScope;abort:AbortController;timer:ReturnType<typeof setTimeout>;applying:boolean;consumed:boolean};

/** One selected-profile setup owner. Renderer input cannot select storage paths or arbitrary plan operations. */
export class ModelSetup {
  readonly #drafts=new Map<string,Draft>();
  #closed=false;
  constructor(readonly input:{homeDir:string;profileId:string},readonly candidates:CredentialCandidates,readonly changed:()=>void|Promise<void>){}
  async review(params:MethodContracts['models.reviewPrimary']['params']):Promise<ModelRouteDraft>{
    for(const [id,draft] of this.#drafts){if(this.#drafts.size<32)break;if(draft.consumed)this.#drafts.delete(id);}
    if(this.#closed || this.#drafts.size>=32)throw new ControlProtocolError('-32009');
    validateCandidateRequest({...params,spendApproved:true});
    const scope:CandidateScope={windowId:params.windowId,generation:params.generation,purpose:'provider',providerId:params.route.providerId,authMethod:params.route.authMethod==='oauth'?'oauth':'api_key',endpoint:params.route.endpoint};
    if(params.candidateId){this.candidates.bindRoute(params.candidateId,scope,candidateRouteBinding(params.route));this.candidates.read(params.candidateId,scope);}
    await loadRuntimeConfig({...this.input,workspaceRoot:this.input.homeDir,configurationInspection:true});
    const snapshot=await captureProfileApplySnapshot(this.input);
    if(params.candidateId)this.candidates.read(params.candidateId,scope);
    if(this.#closed || this.#drafts.size>=32)throw new ControlProtocolError('-32003');
    const draftId=randomUUID(),projection:ModelRouteDraft={draftId,route:structuredClone(params.route),expiresInMs:300000,credentialState:params.candidateId?'staged':'not_required',role:'primary'};
    const credentialEnv=params.route.authMethod==='api_key'?`${getProviderMetadata(params.route.providerId).defaultApiKeyEnv ?? 'PROVIDER_API_KEY'}_${draftId.replaceAll('-','').toUpperCase()}`:undefined;
    const timer=setTimeout(()=>this.cancel({draftId,windowId:params.windowId,generation:params.generation}),300000);timer.unref();
    this.#drafts.set(draftId,{expires:performance.now()+300000,params:structuredClone(params),projection,snapshot,credentialEnv,scope,abort:new AbortController(),timer,applying:false,consumed:false});
    return projection;
  }
  async apply(binding:ModelDraftBinding,signal:AbortSignal):Promise<ModelApplyReceipt>{
    const draft=this.require(binding);
    if(draft.applying || draft.consumed)return this.inspect(binding.draftId);
    const {params}=draft,route=params.route;
    const combined=AbortSignal.any([signal,draft.abort.signal,...(params.candidateId?[this.candidates.signal(params.candidateId,draft.scope)]:[])]);
    combined.throwIfAborted();
    const value=params.candidateId?this.candidates.read(params.candidateId,draft.scope):undefined;
    const env=draft.credentialEnv;
    if(route.authMethod==='api_key' && !env)throw new ControlProtocolError('-32602');
    const plan=primaryRoutePlan({provider:route.providerId,model:route.modelId,baseUrl:route.endpoint,apiMode:route.apiMode,
      authMethod:route.authMethod==='oauth'?'oauth_device_pkce':route.authMethod,enableNetwork:true},env);
    draft.applying=true;
    try{
      const receipt=await applyProfilePlan({...this.input,operationId:binding.draftId,snapshot:draft.snapshot,plan,signal:combined,
        secrets:value&&env?[{envVarName:env,value}]:[],
        oauth:route.authMethod==='oauth'&&value?[{providerId:route.providerId,authMethod:'oauth_device_pkce',tokenRecord:JSON.parse(value)}]:[]});
      draft.consumed=true;draft.snapshot={files:{'.env':null,'auth.json':null,'config.json':null}};await this.changed();return {...receipt,state:receipt.state,verification:receipt.state==='applied'?await this.verifySaved():'not_tested'};
    }finally{draft.applying=false;clearTimeout(draft.timer);if(!draft.consumed)this.#drafts.delete(binding.draftId);if(params.candidateId){try{this.candidates.discard(params.candidateId,draft.scope);}catch{/* Already invalidated. */}}}
  }
  cancel(binding:ModelDraftBinding):{cancelled:boolean}{
    const draft=this.#drafts.get(binding.draftId);if(!draft)return {cancelled:true};this.require(binding);
    draft.abort.abort();clearTimeout(draft.timer);
    if(!draft.applying){this.#drafts.delete(binding.draftId);if(draft.params.candidateId){try{this.candidates.discard(draft.params.candidateId,draft.scope);}catch{}}}
    return {cancelled:!draft.consumed&&!draft.applying};
  }
  async inspect(operationId:string):Promise<ModelApplyReceipt>{const receipt=await inspectProfileApply(this.input,operationId);return {...receipt,state:receipt.state,verification:receipt.state==='applied'?await this.verifySaved():'not_tested'};}
  private async verifySaved():Promise<ModelApplyReceipt['verification']>{try {const catalog=await captureModelCatalog(this.input);return catalog.models.some(model=>model.role==='primary'&&model.runnable)?'configured':'repair_required';}catch{return 'repair_required';}}
  dispose(){for(const draft of this.#drafts.values()){draft.abort.abort();clearTimeout(draft.timer);}this.#drafts.clear();this.#closed=true;}
  private require(binding:ModelDraftBinding):Draft{const draft=this.#drafts.get(binding.draftId);if(this.#closed||!draft||(!draft.consumed && performance.now()>=draft.expires)||draft.params.windowId!==binding.windowId||draft.params.generation!==binding.generation)throw new ControlProtocolError('-32003');return draft;}
}
