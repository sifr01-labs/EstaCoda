import {readEnvSecretValue}from'../config/env-secret-store.js';
import {resolveRuntimeCredential}from'../providers/runtime-credential-resolver.js';
import type {CandidateVerifier}from'./candidate-verification.js';
import {createModelSelectionCatalog} from '../providers/model-selection-catalog.js';
import type{ConfiguredRouteReview}from'../contracts/desktop-control/index.js';
import {oauthCandidate} from './oauth-candidate.js';
import {captureCredentialPresence} from './route-health.js';
import {AUXILIARY_SLOTS,type AuxiliarySlot,type AuxiliaryList,type AuxiliaryModeParams} from '../contracts/desktop-control/index.js';
import {resolveAuxiliaryModelRoute} from '../providers/auxiliary-model-resolver.js';
import type {SetupApplyPlan} from '../setup/setup-apply-plan.js';
import type {CandidateRoute,FallbackList,FallbackOrderParams} from '../contracts/desktop-control/index.js';
import {captureModelCatalog} from './model-catalog.js';
import {randomUUID} from 'node:crypto';
import {candidateRouteBinding, ControlProtocolError, type MethodContracts, type ModelDraftBinding, type ModelRouteDraft, type ModelApplyReceipt} from '../contracts/desktop-control/index.js';
import {getProviderMetadata} from '../providers/provider-metadata.js';
import {loadRuntimeConfig} from '../config/runtime-config.js';
import {primaryRoutePlan} from '../setup/review/model-route-plan.js';
import {captureProfileApplySnapshot,applyProfilePlan,inspectProfileApply,type ProfileApplySnapshot} from '../setup/review/profile-apply.js';
import {CredentialCandidates,type CandidateScope} from './credential-candidates.js';
import {validateCandidateRequest} from './candidate-verification.js';
type Draft={expires:number;params:{windowId:string;generation:number;candidateId?:string;route?:CandidateRoute};plan:SetupApplyPlan;projection:ModelRouteDraft;snapshot:ProfileApplySnapshot;credentialEnv?:string;scope?:CandidateScope;abort:AbortController;timer:ReturnType<typeof setTimeout>;applying:boolean;consumed:boolean};

/** One selected-profile setup owner. Renderer input cannot select storage paths or arbitrary plan operations. */
export class ModelSetup {
  readonly #drafts=new Map<string,Draft>();
  #closed=false;
  #fallbackListing:{projection:FallbackList;snapshot:ProfileApplySnapshot}|undefined;
  constructor(readonly input:{homeDir:string;profileId:string},readonly candidates:CredentialCandidates,readonly changed:()=>void|Promise<void>){}
  async review(params:MethodContracts['models.reviewPrimary']['params'],role:'primary'|'fallback'|'auxiliary'='primary',auxiliary?:{slot:AuxiliarySlot;fallbackToMain:boolean},existing?:{snapshot:ProfileApplySnapshot;credentialEnv?:string}):Promise<ModelRouteDraft>{
    for(const [id,draft] of this.#drafts){if(this.#drafts.size<32)break;if(draft.consumed)this.#drafts.delete(id);}
    if(this.#closed || this.#drafts.size>=32)throw new ControlProtocolError('-32009');
    if(role==='auxiliary' && params.route.maxTokens!==undefined)throw new ControlProtocolError('-32602');
    if(role==='auxiliary' && (!auxiliary || !AUXILIARY_SLOTS.includes(auxiliary.slot)))throw new ControlProtocolError('-32602');
    validateCandidateRequest({...params,...(existing&&params.route.authMethod!=='none'?{candidateId:'configured'}:{}),spendApproved:true});
    const scope:CandidateScope={windowId:params.windowId,generation:params.generation,purpose:'provider',providerId:params.route.providerId,authMethod:params.route.authMethod==='oauth'?'oauth':'api_key',endpoint:params.route.endpoint};
    if(params.candidateId){this.candidates.bindRoute(params.candidateId,scope,candidateRouteBinding(params.route));this.candidates.read(params.candidateId,scope);}
    const snapshot=await captureProfileApplySnapshot(this.input);
    if(existing && JSON.stringify(snapshot.files)!==JSON.stringify(existing.snapshot.files))throw new ControlProtocolError('-32007');
    const loaded=await loadRuntimeConfig({...this.input,workspaceRoot:this.input.homeDir,configurationInspection:true});
    if(role==='fallback'||role==='auxiliary'){
      const identity=(provider:string,id:string,endpoint?:string)=>JSON.stringify([provider,id,new URL(endpoint ?? getProviderMetadata(provider).defaultBaseUrl ?? 'http://invalid').href.replace(/\/$/,'')]);
      const key=identity(params.route.providerId,params.route.modelId,params.route.endpoint);
      if(role==='fallback' && ([loaded.primaryModelRoute,...loaded.modelFallbackRoutes].some(route=>identity(route.provider,route.id,route.baseUrl)===key) || loaded.modelFallbackRoutes.length>=32))throw new ControlProtocolError('-32602');
      const provider=loaded.config.providers?.[params.route.providerId];
      const metadata=getProviderMetadata(params.route.providerId);
      if(provider && Boolean(provider.enableNetwork)!==(params.route.enableNetwork??true))throw new ControlProtocolError('-32602');
      if(provider && ((provider.authMethod ?? metadata.defaultAuthMethod)!==(params.route.authMethod==='oauth'?'oauth_device_pkce':params.route.authMethod) || (provider.apiMode ?? metadata.apiMode)!==params.route.apiMode))throw new ControlProtocolError('-32602');
    }
    if(JSON.stringify(snapshot.files)!==JSON.stringify((await captureProfileApplySnapshot(this.input)).files))throw new ControlProtocolError('-32007');
    if(params.candidateId)this.candidates.read(params.candidateId,scope);
    if(this.#closed || this.#drafts.size>=32)throw new ControlProtocolError('-32003');
    const draftId=randomUUID(),projection:ModelRouteDraft={draftId,route:structuredClone(params.route),expiresInMs:300000,credentialState:params.candidateId?'staged':existing&&params.route.authMethod!=='none'?'existing':'not_required',role,...(auxiliary?{slot:auxiliary.slot}:{})};
    const credentialEnv=existing?existing.credentialEnv:params.route.authMethod==='api_key'?`${getProviderMetadata(params.route.providerId).defaultApiKeyEnv ?? 'PROVIDER_API_KEY'}_${draftId.replaceAll('-','').toUpperCase()}`:undefined;
    const route=params.route;
    const plan=primaryRoutePlan({provider:route.providerId,model:route.modelId,baseUrl:route.endpoint,apiMode:route.apiMode,authMethod:route.authMethod==='oauth'?'oauth_device_pkce':route.authMethod,enableNetwork:route.enableNetwork??true,...(route.contextWindowTokens!==undefined?{contextWindowTokens:route.contextWindowTokens}:{}),...(route.maxTokens!==undefined?{maxTokens:route.maxTokens}:{}),...(auxiliary?{auxiliaryTask:auxiliary.slot,fallbackToMain:auxiliary.fallbackToMain}:{})},credentialEnv,role);
    const timer=setTimeout(()=>this.cancel({draftId,windowId:params.windowId,generation:params.generation}),300000);timer.unref();
    this.#drafts.set(draftId,{expires:performance.now()+300000,params:structuredClone(params),projection,snapshot,credentialEnv,scope,plan,abort:new AbortController(),timer,applying:false,consumed:false});
    return projection;
  }
  async verifyDraft(params:MethodContracts['models.verifyDraft']['params'],signal:AbortSignal,verifier:CandidateVerifier){
    const draft=this.require(params),route=draft.params.route;
    if(!route||draft.applying||draft.consumed||draft.projection.credentialState==='staged'||!params.spendApproved)throw new ControlProtocolError('-32602');
    if(JSON.stringify(draft.snapshot.files)!==JSON.stringify((await captureProfileApplySnapshot(this.input)).files))throw new ControlProtocolError('-32007');
    const scope:CandidateScope={windowId:params.windowId,generation:params.generation,purpose:'provider',providerId:route.providerId,authMethod:route.authMethod==='oauth'?'oauth':'api_key',endpoint:route.endpoint};
    let value:string|undefined;
    if(route.authMethod==='api_key'){
      const key=draft.credentialEnv;if(!key)throw new ControlProtocolError('-32602');
      const resolution=await resolveRuntimeCredential({providerId:route.providerId,route:{apiKeyEnv:key,authMethod:'api_key'},readOnly:true,environment:{[key]:readEnvSecretValue(draft.snapshot.files['.env']??'',key)??process.env[key]}});
      if(resolution.credential?.kind!=='bearer')throw new ControlProtocolError('-32602');value=resolution.credential.value;
    }else if(route.authMethod==='oauth'){
      const record=JSON.parse(draft.snapshot.files['auth.json']??'{}').providers?.[route.providerId];if(!record)throw new ControlProtocolError('-32602');value=JSON.stringify(oauthCandidate(JSON.stringify(record),route.providerId));
    }
    const candidateId=value?this.candidates.stage(scope,value):undefined;
    try{return await verifier.verify({windowId:params.windowId,generation:params.generation,route:{...route,allowPrivateEndpoint:params.allowPrivateEndpoint},...(candidateId?{candidateId}:{}),spendApproved:true},AbortSignal.any([signal,draft.abort.signal]));}
    finally{if(candidateId)try{this.candidates.discard(candidateId,scope);}catch{}}
  }
  async reviewConfigured(params:ConfiguredRouteReview):Promise<ModelRouteDraft>{
    if(params.role==='auxiliary'?!params.slot||!AUXILIARY_SLOTS.includes(params.slot):params.slot!==undefined||params.fallbackToMain!==undefined)throw new ControlProtocolError('-32602');
    const snapshot=await captureProfileApplySnapshot(this.input);
    const loaded=await loadRuntimeConfig({...this.input,workspaceRoot:this.input.homeDir,configurationInspection:true});
    const presence=await captureCredentialPresence(loaded);
    const catalog=await createModelSelectionCatalog({...this.input,config:loaded.config,providerRegistry:loaded.providerRegistry,allowNetwork:false,credentialReady:async(provider,apiKeyEnv)=>['present','not_required'].includes(presence(provider,{apiKeyEnv}))});
    const rows=(await catalog.listModels({configuredOnly:true,executableOnly:true,provider:params.providerId})).filter(row=>row.id===params.modelId&&!row.catalogOnly&&row.lifecycle!=='retired');
    if(rows.length!==1)throw new ControlProtocolError('-32602');
    const row=rows[0]!,provider=loaded.config.providers?.[params.providerId],metadata=getProviderMetadata(params.providerId);
    if(!provider?.enableNetwork)throw new ControlProtocolError('-32602');
    const endpoint=row.baseUrl??provider.baseUrl??metadata.defaultBaseUrl;if(!endpoint)throw new ControlProtocolError('-32602');
    const fallback=loaded.modelFallbackRoutes.find(route=>route.provider===params.providerId&&route.id===params.modelId&&(route.baseUrl??metadata.defaultBaseUrl)===endpoint);
    const authMethod=provider.authMethod??metadata.defaultAuthMethod,credentialEnv=fallback?.apiKeyEnv??provider.apiKeyEnv??metadata.defaultApiKeyEnv;
    if(!['present','not_required'].includes(presence(params.providerId,{apiKeyEnv:credentialEnv,authMethod})))throw new ControlProtocolError('-32602');
    const route:CandidateRoute={providerId:params.providerId,modelId:params.modelId,endpoint,authMethod:authMethod==='none'?'none':authMethod==='api_key'?'api_key':'oauth',apiMode:(provider.apiMode??metadata.apiMode) as CandidateRoute['apiMode'],allowPrivateEndpoint:true,enableNetwork:true,...(fallback?.contextWindowTokens?{contextWindowTokens:fallback.contextWindowTokens}:{}),...(params.role!=='auxiliary'&&fallback?.maxTokens?{maxTokens:fallback.maxTokens}:{})};
    return this.review({windowId:params.windowId,generation:params.generation,route},params.role,params.role==='auxiliary'?{slot:params.slot!,fallbackToMain:params.fallbackToMain===true}:undefined,{snapshot,credentialEnv:route.authMethod==='api_key'?credentialEnv:undefined});
  }
  async auxiliary():Promise<AuxiliaryList>{
    const loaded=await loadRuntimeConfig({...this.input,workspaceRoot:this.input.homeDir,configurationInspection:true});
    const providerModels=await loaded.providerRegistry.listModels();
    const presence=await captureCredentialPresence(loaded);
    const items:AuxiliaryList['items']=AUXILIARY_SLOTS.map(slot=>{
      const resolved=resolveAuxiliaryModelRoute(slot,loaded.auxiliaryModels,{mainRoute:loaded.primaryModelRoute,providerRegistry:loaded.providerRegistry,providerModels});
      const credentialState=resolved.route?presence(resolved.route.provider,resolved.route):'not_required';
      const adapter=resolved.route?loaded.providerRegistry.get(resolved.route.provider):undefined;
      const runnable=Boolean(adapter && adapter.executable!==false && resolved.route && loaded.config.providers?.[resolved.route.provider]?.enableNetwork && ['present','not_required'].includes(credentialState));
      return {slot,credentialState,runnable,mode:resolved.source==='disabled'?'disabled':resolved.source==='main'?'main':resolved.source.startsWith('auto')?'auto':'dedicated',providerId:resolved.route?.provider??null,modelId:resolved.route?.id??null,fallbackToMain:resolved.fallbackToMain};
    });
    if(this.#closed)throw new ControlProtocolError('-32003');return {items};
  }
  async reviewAuxiliaryMode(params:AuxiliaryModeParams):Promise<ModelRouteDraft>{
    for(const [id,draft] of this.#drafts){if(this.#drafts.size<32)break;if(draft.consumed)this.#drafts.delete(id);}
    if(this.#closed||this.#drafts.size>=32||!AUXILIARY_SLOTS.includes(params.slot)||!['main','auto','disabled'].includes(params.mode))throw new ControlProtocolError('-32602');
    const snapshot=await captureProfileApplySnapshot(this.input);
    if(this.#closed)throw new ControlProtocolError('-32003');
    const draftId=randomUUID(),projection:ModelRouteDraft={draftId,expiresInMs:300000,credentialState:'not_required',role:'auxiliary_mode',slot:params.slot};
    const plan=primaryRoutePlan({auxiliaryTask:params.slot,mode:params.mode,fallbackToMain:params.fallbackToMain},undefined,'auxiliary_mode');
    const timer=setTimeout(()=>this.cancel({draftId,windowId:params.windowId,generation:params.generation}),300000);timer.unref();
    this.#drafts.set(draftId,{expires:performance.now()+300000,params:{windowId:params.windowId,generation:params.generation},projection,plan,snapshot,abort:new AbortController(),timer,applying:false,consumed:false});
    return projection;
  }
  async fallbacks():Promise<FallbackList>{
    const snapshot=await captureProfileApplySnapshot(this.input);
    const loaded=await loadRuntimeConfig({...this.input,workspaceRoot:this.input.homeDir,configurationInspection:true});
    if(JSON.stringify(snapshot.files)!==JSON.stringify((await captureProfileApplySnapshot(this.input)).files) || loaded.modelFallbackRoutes.length !== (loaded.config.model?.fallbacks?.length ?? 0) || loaded.modelFallbackRoutes.length>32)throw new ControlProtocolError('-32007');
    const projection:FallbackList={revision:randomUUID(),items:loaded.modelFallbackRoutes.slice(0,32).map((route,index)=>({index,providerId:route.provider,modelId:route.id}))};
    if(this.#closed)throw new ControlProtocolError('-32003');
    this.#fallbackListing={projection,snapshot};return projection;
  }
  async reviewFallbackOrder(params:FallbackOrderParams):Promise<ModelRouteDraft>{
    for(const [id,draft] of this.#drafts){if(this.#drafts.size<32)break;if(draft.consumed)this.#drafts.delete(id);}
    const listing=this.#fallbackListing;
    if(this.#closed||this.#drafts.size>=32||!listing||listing.projection.revision!==params.revision||new Set(params.order).size!==params.order.length||params.order.some(i=>!Number.isInteger(i)||i<0||i>=listing.projection.items.length))throw new ControlProtocolError('-32007');
    const current=await captureProfileApplySnapshot(this.input);
    if(this.#closed || JSON.stringify(current.files)!==JSON.stringify(listing.snapshot.files))throw new ControlProtocolError('-32007');
    const draftId=randomUUID(),projection:ModelRouteDraft={draftId,expiresInMs:300000,credentialState:'not_required',role:'fallback_order'};
    const plan=primaryRoutePlan({indices:params.order.map(String)},undefined,'fallback_order');
    const timer=setTimeout(()=>this.cancel({draftId,windowId:params.windowId,generation:params.generation}),300000);timer.unref();
    this.#drafts.set(draftId,{expires:performance.now()+300000,params:{windowId:params.windowId,generation:params.generation},projection,plan,snapshot:current,abort:new AbortController(),timer,applying:false,consumed:false});
    return projection;
  }
  async apply(binding:ModelDraftBinding,signal:AbortSignal):Promise<ModelApplyReceipt>{
    const draft=this.require(binding);
    if(draft.applying || draft.consumed)return this.inspect(binding.draftId);
    const {params}=draft,route=params.route;
    const combined=AbortSignal.any([signal,draft.abort.signal,...(params.candidateId?[this.candidates.signal(params.candidateId,draft.scope!)]:[])]);
    combined.throwIfAborted();
    const value=params.candidateId?this.candidates.read(params.candidateId,draft.scope!):undefined;
    const env=draft.credentialEnv;
    if(route?.authMethod==='api_key' && !env)throw new ControlProtocolError('-32602');
    const plan=draft.plan;
    draft.applying=true;
    try{
      const receipt=await applyProfilePlan({...this.input,operationId:binding.draftId,snapshot:draft.snapshot,plan,signal:combined,
        secrets:value&&env?[{envVarName:env,value}]:[],
        oauth:route?.authMethod==='oauth'&&value?[{providerId:route.providerId,authMethod:'oauth_device_pkce',tokenRecord:oauthCandidate(value,route.providerId)}]:[]});
      draft.consumed=true;draft.snapshot={files:{'.env':null,'auth.json':null,'config.json':null}};await this.changed();return {...receipt,state:receipt.state,verification:receipt.state==='applied'?await this.verifySaved():'not_tested'};
    }finally{draft.applying=false;clearTimeout(draft.timer);if(!draft.consumed)this.#drafts.delete(binding.draftId);if(params.candidateId){try{this.candidates.discard(params.candidateId,draft.scope!);}catch{/* Already invalidated. */}}}
  }
  cancel(binding:ModelDraftBinding):{cancelled:boolean}{
    const draft=this.#drafts.get(binding.draftId);if(!draft)return {cancelled:true};this.require(binding);
    draft.abort.abort();clearTimeout(draft.timer);
    if(!draft.applying){this.#drafts.delete(binding.draftId);if(draft.params.candidateId){try{this.candidates.discard(draft.params.candidateId,draft.scope!);}catch{}}}
    return {cancelled:!draft.consumed&&!draft.applying};
  }
  async inspect(operationId:string):Promise<ModelApplyReceipt>{const receipt=await inspectProfileApply(this.input,operationId);return {...receipt,state:receipt.state,verification:receipt.state==='applied'?await this.verifySaved():'not_tested'};}
  private async verifySaved():Promise<ModelApplyReceipt['verification']>{try {const catalog=await captureModelCatalog(this.input);return catalog.models.some(model=>model.role==='primary'&&model.runnable)?'configured':'repair_required';}catch{return 'repair_required';}}
  dispose(){for(const draft of this.#drafts.values()){draft.abort.abort();clearTimeout(draft.timer);}this.#drafts.clear();this.#fallbackListing=undefined;this.#closed=true;}
  private require(binding:ModelDraftBinding):Draft{const draft=this.#drafts.get(binding.draftId);if(this.#closed||!draft||(!draft.consumed && performance.now()>=draft.expires)||draft.params.windowId!==binding.windowId||draft.params.generation!==binding.generation)throw new ControlProtocolError('-32003');return draft;}
}
