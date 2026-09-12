import {randomUUID} from 'node:crypto';
import type {BrowserViewReference,HumanBrowserLease,HumanBrowserInput,HumanBrowserFrame,HumanBrowserCommand} from '@estacoda/control-protocol';
import type {DesktopConnection} from './connection.js';
type Entry={id:string;holder:string;workId:string;browserId:string;lease:HumanBrowserLease;sequence:number;generation:number;busy:boolean;renewing:boolean;timer:ReturnType<typeof setInterval>};
/** Main holds the lease and sequence; the renderer gets only an ephemeral local handle. */
export class DesktopBrowserControls{
 #entry?:Entry;#opening=false;#epoch=0;#closed=false;
 readonly #invalidate=()=>{this.#epoch++;if(this.#entry)clearInterval(this.#entry.timer);this.#entry=undefined;};
 constructor(readonly connection:DesktopConnection,readonly confirm:(url:string)=>Promise<boolean>){connection.on('invalidate',this.#invalidate);}
 #assert(epoch:number){if(this.#closed||epoch!==this.#epoch||this.connection.state.status!=='ready')throw new Error('Browser connection changed.');}
 async open(workId:string,reference:BrowserViewReference):Promise<{id:string}>{
  if(this.#opening||this.#entry)throw new Error('Browser control is already open.');this.#opening=true;const epoch=this.#epoch,generation=this.connection.state.generation;
  try{this.#assert(epoch);
   // Verify the selected observation through inspection before presenting native consent.
   const views=await this.connection.inspectionRequest('browser.list',{workId});this.#assert(epoch);
   const view=views.items.find(item=>item.reference.browserId===reference.browserId&&item.reference.sessionId===reference.sessionId&&item.reference.target.targetId===reference.target.targetId&&item.reference.target.targetGeneration===reference.target.targetGeneration);
   if(view?.state!=='recorded'||!await this.confirm(view.url??'Browser'))throw new Error('Browser takeover cancelled or unavailable.');this.#assert(epoch);
   const holder=randomUUID(),result=await this.connection.browserRequest({workId,command:{action:'acquire',holder,browserId:reference.browserId}});this.#assert(epoch);
   if(!result.lease)throw new Error('Browser control unavailable.');
   const entry:Entry={id:randomUUID(),holder,workId,browserId:reference.browserId,lease:result.lease,sequence:0,generation,busy:false,renewing:false,timer:setInterval(()=>void this.#renew(),2000)};this.#entry=entry;return{id:entry.id};
  }finally{this.#opening=false;}
 }
 #active(id:string){const entry=this.#entry;if(!entry||entry.id!==id||entry.generation!==this.connection.state.generation||this.connection.state.status!=='ready')throw new Error('Browser handle expired. Reacquire control; the agent remains paused.');return entry;}
 async #renew(){const entry=this.#entry;if(!entry||entry.renewing)return;entry.renewing=true;try{await this.connection.browserRequest({workId:entry.workId,command:{action:'renew',holder:entry.holder,browserId:entry.browserId,lease:entry.lease}});}catch{if(this.#entry===entry)this.#invalidate();}finally{entry.renewing=false;}}
 async frame(id:string,input?:HumanBrowserInput):Promise<HumanBrowserFrame>{
  const entry=this.#active(id);if(entry.busy)throw new Error('Browser input is settling.');entry.busy=true;
  try{const base={holder:entry.holder,browserId:entry.browserId,lease:entry.lease,sequence:++entry.sequence};const command:HumanBrowserCommand=input?{...base,action:'input',input}:{...base,action:'observe'};
   const result=await this.connection.browserRequest({workId:entry.workId,command});if(this.#entry!==entry||!result.frame)throw new Error('Browser observation unavailable.');this.#active(id);return result.frame;
  }catch(error){if(this.#entry===entry)this.#invalidate();throw error;}finally{entry.busy=false;}
 }
 async release(id:string){const entry=this.#active(id);if(entry.busy)throw new Error('Browser input is settling.');entry.busy=true;
  try{await this.connection.browserRequest({workId:entry.workId,command:{action:'release',holder:entry.holder,browserId:entry.browserId,lease:entry.lease}});this.#active(id);this.#invalidate();}
  finally{entry.busy=false;}
 }
 abandon(id:string){if(this.#entry?.id===id)this.#invalidate();}
 detach(){this.#invalidate();}
 dispose(){this.#closed=true;this.#invalidate();this.connection.off('invalidate',this.#invalidate);}
}
