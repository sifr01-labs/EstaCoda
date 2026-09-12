import {randomUUID} from 'node:crypto';
import type{CandidateRoute,ModelRouteDraft,ModelApplyReceipt}from'@estacoda/control-protocol';
import type{DesktopConnection}from'./connection.js';
import type{CredentialPipeClient,CredentialScope}from'./credential-pipe-client.js';
import type{CredentialWindow}from'./credential-window.js';
type Setup={id:string;scope:CredentialScope;route:CandidateRoute;candidateId?:string;draft?:ModelRouteDraft;profileId:string;generation:number;applying:boolean};
/** Main owns setup identity. The ordinary renderer never selects a credential scope or sees a key. */
export class DesktopModelSetup {
 #setup:Setup|undefined;readonly #windowId=randomUUID();#generation=0;#lastApply=new Map<string,string>();
 constructor(readonly connection:DesktopConnection,readonly credentials:CredentialWindow,readonly pipe:()=>CredentialPipeClient|undefined){connection.on('invalidate',()=>{this.credentials.close();this.#setup=undefined;});}
 async begin(route:CandidateRoute){if(this.#setup?.applying)throw new Error('Apply is settling.');const cancelled=await this.cancel();if(!cancelled.cancelled)throw new Error('Reconcile the previous Apply first.');await this.connection.modelRequest('models.validateRoute',{route});const setup:Setup={id:randomUUID(),scope:{windowId:this.#windowId,generation:++this.#generation,purpose:'provider',providerId:route.providerId,authMethod:route.authMethod==='oauth'?'oauth':'api_key',endpoint:route.endpoint},route:structuredClone(route),profileId:this.connection.state.profileId,generation:this.connection.state.generation,applying:false};this.#setup=setup;return {setupId:setup.id};}
 async stage(setupId:string):Promise<{staged:boolean}>{
  const setup=this.require(setupId),pipe=this.pipe();if(!pipe || setup.route.authMethod!=='api_key' || setup.candidateId)throw new Error('Credential entry unavailable.');
  await new Promise<void>((resolve,reject)=>this.credentials.open(pipe,setup.scope,candidateId=>{try{this.require(setupId);setup.candidateId=candidateId;resolve();}catch{reject(new Error('Setup changed.'));}},()=>{reject(new Error('Credential entry cancelled.'));}));this.require(setupId);return {staged:true};
 }
 async verify(setupId:string){const setup=this.require(setupId);try{return await this.connection.modelRequest('models.verifyCandidate',{...this.params(setup),spendApproved:true});}catch(error){throw error;}finally{this.require(setupId);}}
 async review(setupId:string){const setup=this.require(setupId);setup.draft=await this.connection.modelRequest('models.reviewPrimary',this.params(setup));this.require(setupId);return setup.draft;}
 async apply(setupId:string):Promise<ModelApplyReceipt>{const setup=this.require(setupId);if(!setup.draft || setup.applying)throw new Error('Review required.');setup.applying=true;this.#lastApply.set(setup.profileId,setup.draft.draftId);try{const result=await this.connection.modelRequest('models.applyDraft',{draftId:setup.draft.draftId,windowId:setup.scope.windowId,generation:setup.scope.generation});if(result.state==='applied'){await this.pipe()?.closeWindow(setup.scope.windowId,setup.scope.generation);if(this.#setup===setup)this.#setup=undefined;}return result;}finally{setup.applying=false;}}
 async inspect(){const operationId=this.#lastApply.get(this.connection.state.profileId);return operationId?this.connection.modelRequest('models.inspectApply',{operationId}):null;}
 async cancel(setupId?:string):Promise<{cancelled:boolean}>{const setup=this.#setup;if(!setup)return {cancelled:true};if(setupId && setup.id!==setupId)throw new Error('Setup changed.');
  this.credentials.close();let cancelled=true;
  if(setup.draft){const result=await this.connection.modelRequest('models.cancelDraft',{draftId:setup.draft.draftId,windowId:setup.scope.windowId,generation:setup.scope.generation});cancelled=result.cancelled;}
  await this.pipe()?.closeWindow(setup.scope.windowId,setup.scope.generation);if(this.#setup===setup)this.#setup=undefined;return {cancelled};
 }
 private params(setup:Setup){return {windowId:setup.scope.windowId,generation:setup.scope.generation,route:setup.route,...(setup.candidateId?{candidateId:setup.candidateId}:{})};}
 private require(id:string){const setup=this.#setup;if(!setup || setup.id!==id || setup.profileId!==this.connection.state.profileId || setup.generation!==this.connection.state.generation)throw new Error('Setup changed.');return setup;}
}
