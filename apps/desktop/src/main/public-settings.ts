import type {DesktopConnectionControls} from './connection-controls.js';
import {randomUUID} from 'node:crypto';
import type {SettingChange,SettingField,SettingsSection,SettingsReview} from '@estacoda/control-protocol';
import type {DesktopConnection} from './connection.js';
import type {CredentialWindow} from './credential-window.js';
import type {CredentialPipeClient,CredentialScope} from './credential-pipe-client.js';
type Setup={id:string;windowId:string;generation:number;profileId:string;connectionGeneration:number;draft?:SettingsReview;candidates:Map<string,string>;applying:boolean};
export class DesktopPublicSettings {
 #setup?:Setup;#counter=0;#busy=false;readonly #windowId=randomUUID();readonly #fields=new Map<string,SettingField>();
 constructor(readonly connection:DesktopConnection,readonly credentials:CredentialWindow,readonly pipe:()=>CredentialPipeClient|undefined,readonly operations?:DesktopConnectionControls){connection.on('invalidate',()=>{this.credentials.close();this.#setup=undefined;this.#fields.clear();});}
 async read(section:SettingsSection,offset?:number){const page=await this.connection.settingsRequest('settings.read',{section,...(offset===undefined?{}:{offset})});for(const f of page.fields)this.#fields.set(f.id,f);return page;}
 async dependencies(){return this.connection.settingsRequest('settings.dependencies',{});}
 async install(capabilityId:string,groups:string[]){if(!this.operations)throw new Error('Dependency operations unavailable.');return this.operations.perform('dependency.install',operationId=>this.connection.settingsRequest('settings.installDependency',{operationId,capabilityId,groups,downloadApproved:true}));}
 async inspectDependency(){return this.operations?this.operations.inspect():null;}
 async value(fieldId:string,selectors:string[]){return this.connection.settingsRequest('settings.value',{fieldId,selectors});}
 begin(){if(this.#setup)throw new Error('Finish the current review first.');const setup:Setup={id:randomUUID(),windowId:this.#windowId,generation:++this.#counter,profileId:this.connection.state.profileId,connectionGeneration:this.connection.state.generation,candidates:new Map(),applying:false};this.#setup=setup;return {setupId:setup.id};}
 require(id:string){const s=this.#setup;if(!s||s.id!==id||s.profileId!==this.connection.state.profileId||s.connectionGeneration!==this.connection.state.generation)throw new Error('Settings context changed.');return s;}
 async stage(id:string,fieldId:string,selectors:string[]){const s=this.require(id),pipe=this.pipe(),field=this.#fields.get(fieldId);if(!pipe||!field||field.kind!=='secret'||s.draft||s.applying||this.#busy)throw new Error('Credential entry unavailable.');this.#busy=true;
 try{const scope:CredentialScope={windowId:s.windowId,generation:s.generation,purpose:'settings',providerId:fieldId,authMethod:'api_key',endpoint:'https://settings.estacoda.invalid'};
 const candidate=await new Promise<string>((resolve,reject)=>this.credentials.open(pipe,scope,resolve,()=>reject(new Error('Credential entry cancelled.'))));this.require(id);s.candidates.set(JSON.stringify([fieldId,selectors]),candidate);return {staged:true};}finally{this.#busy=false;}}
 async review(id:string,changes:SettingChange[]){const s=this.require(id);if(this.#busy||s.applying||s.draft)throw new Error('Finish the current review first.');this.#busy=true;try{
 const bound=changes.map(c=>{const field=this.#fields.get(c.fieldId);if(!field)throw new Error('Refresh settings first.');if(field.kind!=='secret'||c.value===null)return c;const candidate=s.candidates.get(JSON.stringify([c.fieldId,c.selectors]));if(c.value!=='staged'||!candidate)throw new Error('Use protected credential entry.');return {...c,value:candidate};});
 s.draft=await this.connection.settingsRequest('settings.review',{windowId:s.windowId,generation:s.generation,changes:bound});this.require(id);return s.draft;
 }finally{this.#busy=false;}}
 async apply(id:string){const s=this.require(id);if(!s.draft||s.applying||this.#busy)throw new Error('Review required.');s.applying=true;try{const receipt=await this.connection.settingsRequest('settings.apply',{draftId:s.draft.draftId,windowId:s.windowId,generation:s.generation});this.require(id);if(receipt.state==='applied'){await this.pipe()?.closeWindow(s.windowId,s.generation);this.#setup=undefined;}return receipt;}finally{s.applying=false;}}
 async cancel(id:string){const s=this.require(id);this.credentials.close();if(s.draft){const result=await this.connection.settingsRequest('settings.cancel',{draftId:s.draft.draftId,windowId:s.windowId,generation:s.generation});if(!result.cancelled)return result;}await this.pipe()?.closeWindow(s.windowId,s.generation);if(this.#setup===s)this.#setup=undefined;return {cancelled:true};}
 async inspect(){const s=this.#setup;const receipt=await this.connection.settingsRequest('settings.inspect',s?.draft?{operationId:s.draft.draftId}:{});if(s?.draft?.draftId===receipt.operationId&&receipt.state==='applied'){await this.pipe()?.closeWindow(s.windowId,s.generation);if(this.#setup===s)this.#setup=undefined;}return receipt;}
 async verify(){return this.connection.settingsRequest('settings.verify',{});}
}
