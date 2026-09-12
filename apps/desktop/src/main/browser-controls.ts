import {randomUUID} from 'node:crypto';
import type {BrowserViewReference,HumanBrowserLease,HumanBrowserInput,HumanBrowserFrame,HumanBrowserCommand,BrowserWorkspaceAction,BrowserWorkspaceState} from '@estacoda/control-protocol';
import type {DesktopConnection} from './connection.js';
type Entry={id:string;holder:string;workId:string;browserId:string;lease:HumanBrowserLease;sequence:number;generation:number;busy:boolean;renewing:boolean;timer:ReturnType<typeof setInterval>};
/** Main holds the lease and sequence; the renderer gets only an ephemeral local handle. */
export class DesktopBrowserControls{
 #entry?:Entry;#opening=false;#epoch=0;#closed=false;
 readonly #invalidate=()=>{this.#epoch++;if(this.#entry)clearInterval(this.#entry.timer);this.#entry=undefined;};
 constructor(readonly connection:DesktopConnection,readonly confirm:(url:string)=>Promise<boolean>,readonly collect?:(entry:{origin:string;kind:'password'|'one-time-code'},deliver:(value:string)=>Promise<void>)=>Promise<boolean>,readonly deliverSecret?:(params:{workId:string;command:Extract<HumanBrowserCommand,{action:'signin-deliver'}>})=>Promise<void>){connection.on('invalidate',this.#invalidate);}
 #assert(epoch:number){if(this.#closed||epoch!==this.#epoch||this.connection.state.status!=='ready')throw new Error('Browser connection changed.');}
 async open(workId:string,reference?:BrowserViewReference):Promise<{id:string}>{
  if(this.#opening||this.#entry)throw new Error('Browser control is already open.');this.#opening=true;const epoch=this.#epoch,generation=this.connection.state.generation;
  try{this.#assert(epoch);
   // Verify the selected observation through inspection before presenting native consent.
   let browserId=reference?.browserId??randomUUID(),url='New local browser session';
   if(reference){
    const views=await this.connection.inspectionRequest('browser.list',{workId});this.#assert(epoch);
    const view=views.items.find(item=>item.reference.browserId===reference.browserId&&item.reference.sessionId===reference.sessionId&&item.reference.target.targetId===reference.target.targetId&&item.reference.target.targetGeneration===reference.target.targetGeneration);
    if(view?.state!=='recorded')throw new Error('Browser unavailable.');url=view.url??'Browser';
   }else{
    const state=await this.inventory(workId);this.#assert(epoch);if(!state.supported)throw new Error('Browser workspace unavailable.');
    browserId=state.sessions[0]?.id??browserId;url=state.sessions[0]?.tabs[0]?.url??url;
   }
   if(!await this.confirm(url))throw new Error('Browser takeover cancelled.');this.#assert(epoch);
   const holder=randomUUID(),result=await this.connection.browserRequest({workId,command:{action:'acquire',holder,browserId}});this.#assert(epoch);
   if(!result.lease)throw new Error('Browser control unavailable.');
   const entry:Entry={id:randomUUID(),holder,workId,browserId,lease:result.lease,sequence:0,generation,busy:false,renewing:false,timer:setInterval(()=>void this.#renew(),2000)};this.#entry=entry;return{id:entry.id};
  }finally{this.#opening=false;}
 }
 async inventory(workId:string):Promise<BrowserWorkspaceState>{
  const epoch=this.#epoch;this.#assert(epoch);
  const result=await this.connection.browserRequest({workId,command:{action:'inventory',holder:randomUUID(),browserId:'inventory'}});
  this.#assert(epoch);if(!result.workspace)throw new Error('Browser inventory unavailable.');return result.workspace;
 }
 async workspace(id:string,operation:BrowserWorkspaceAction):Promise<BrowserWorkspaceState>{
  const entry=this.#active(id);if(entry.busy)throw new Error('Browser input is settling.');entry.busy=true;
  try{
   const result=await this.connection.browserRequest({workId:entry.workId,command:{action:'workspace',holder:entry.holder,browserId:entry.browserId,lease:entry.lease,sequence:++entry.sequence,operation}});
   this.#active(id);if(this.#entry!==entry||!result.workspace)throw new Error('Browser workspace unavailable.');
   if(result.workspace.selectedSessionId)entry.browserId=result.workspace.selectedSessionId;
   return result.workspace;
  }catch(error){if(this.#entry===entry)this.#invalidate();throw error;}finally{entry.busy=false;}
 }
 #active(id:string){const entry=this.#entry;if(!entry||entry.id!==id||entry.generation!==this.connection.state.generation||this.connection.state.status!=='ready')throw new Error('Browser handle expired. Reacquire control; the agent remains paused.');return entry;}
 async #renew(){const entry=this.#entry;if(!entry||entry.renewing)return;entry.renewing=true;try{await this.connection.browserRequest({workId:entry.workId,command:{action:'renew',holder:entry.holder,browserId:entry.browserId,lease:entry.lease}});}catch{if(this.#entry===entry)this.#invalidate();}finally{entry.renewing=false;}}
 async frame(id:string,input?:HumanBrowserInput):Promise<HumanBrowserFrame>{
  const entry=this.#active(id);if(entry.busy)throw new Error('Browser input is settling.');entry.busy=true;
  try{const base={holder:entry.holder,browserId:entry.browserId,lease:entry.lease,sequence:++entry.sequence};const command:HumanBrowserCommand=input?{...base,action:'input',input}:{...base,action:'observe'};
   const result=await this.connection.browserRequest({workId:entry.workId,command});if(this.#entry!==entry||!result.frame)throw new Error('Browser observation unavailable.');this.#active(id);return result.frame;
  }catch(error){if(this.#entry===entry)this.#invalidate();throw error;}finally{entry.busy=false;}
 }
 async signIn(id:string,frameId:string,submitRef:string,kind:'password'|'one-time-code'):Promise<{submitted:boolean}>{
  const entry=this.#active(id);if(entry.busy||!this.collect||!this.deliverSecret)throw new Error('Protected entry unavailable.');entry.busy=true;
  const base=()=>({holder:entry.holder,browserId:entry.browserId,lease:entry.lease,sequence:++entry.sequence});
  try{
   const prepared=await this.connection.browserRequest({workId:entry.workId,command:{...base(),action:'signin-prepare',frameId,submitRef,kind}});
   this.#active(id);if(this.#entry!==entry||!prepared.entry)throw new Error('Protected entry unavailable.');
   const submitted=await this.collect({origin:prepared.entry.origin,kind},async value=>{
    try{this.#active(id);await this.deliverSecret!({workId:entry.workId,command:{...base(),action:'signin-deliver',entryId:prepared.entry!.id,value}});this.#active(id);}finally{value='';}
   });
   this.#active(id);await this.connection.browserRequest({workId:entry.workId,command:{...base(),action:'signin-cancel'}});
   this.#active(id);return {submitted};
  }catch{if(this.#entry===entry)this.#invalidate();throw new Error('Protected entry failed. Reacquire control to inspect the browser.');}finally{entry.busy=false;}
 }
 async release(id:string){const entry=this.#active(id);if(entry.busy)throw new Error('Browser input is settling.');entry.busy=true;
  try{await this.connection.browserRequest({workId:entry.workId,command:{action:'release',holder:entry.holder,browserId:entry.browserId,lease:entry.lease}});this.#active(id);this.#invalidate();}
  finally{entry.busy=false;}
 }
 abandon(id:string){if(this.#entry?.id===id)this.#invalidate();}
 detach(){this.#invalidate();}
 dispose(){this.#closed=true;this.#invalidate();this.connection.off('invalidate',this.#invalidate);}
}
