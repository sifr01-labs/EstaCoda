import {randomUUID} from 'node:crypto';
import type {WorkInputRequest} from '@estacoda/control-protocol';
import type {DesktopConnection} from './connection.js';
import type {CredentialPipeClient} from './credential-pipe-client.js';
type Collect=(request:WorkInputRequest,deliver:(value:string)=>Promise<void>)=>Promise<boolean>;
/** Renderer may request a protected window, never supply a value or choose its destination. */
export class DesktopWorkInput {
 #busy=false;#epoch=0;#holder=randomUUID();
 constructor(readonly connection:DesktopConnection,readonly pipe:()=>CredentialPipeClient|undefined,readonly collect:Collect,readonly closeWindow:()=>void){connection.on('invalidate',this.invalidate);}
 invalidate=()=>{this.#epoch++;this.#holder=randomUUID();this.closeWindow();};
 async pending(workId:string){const epoch=this.#epoch,pipe=this.pipe();if(!pipe||this.connection.state.status!=='ready')throw new Error('Secure input unavailable.');const result=await pipe.workInput(workId,{action:'pending',holder:this.#holder});if(epoch!==this.#epoch)throw new Error('Secure input disconnected.');return result.request;}
 async open(workId:string,requestId:string){
  if(this.#busy)throw new Error('Secure entry already open.');this.#busy=true;
  const epoch=this.#epoch,holder=this.#holder,pipe=this.pipe();if(!pipe){this.#busy=false;throw new Error('Secure input unavailable.');}
  let current:string|undefined=requestId;
  const check=()=>{if(epoch!==this.#epoch||pipe!==this.pipe()||this.connection.state.status!=='ready')throw new Error('Secure input disconnected.');};
  try{
   check();let request=(await pipe.workInput(workId,{action:'claim',holder,requestId})).request;if(!request)throw new Error('Secure request expired.');
   while(request){check();const entry=request;current=entry.id;
    const remaining=Date.parse(entry.expiresAt)-Date.now();if(remaining<=0)throw new Error('Secure request expired.');
    const timer=setTimeout(this.closeWindow,remaining);timer.unref();
    let accepted:boolean;
    try{accepted=await this.collect(entry,async value=>{try{check();await pipe.workInput(workId,{action:'deliver',holder,requestId:entry.id,value});check();}finally{value='';}});}finally{clearTimeout(timer);}
    if(!accepted){await pipe.workInput(workId,{action:'cancel',holder,requestId:entry.id}).catch(()=>{});return;}
    current=undefined;check();if(entry.position>=entry.total)return;
    let next:WorkInputRequest|null=null;const until=Date.now()+5000;
    while(!next&&Date.now()<until){check();next=(await pipe.workInput(workId,{action:'pending',holder})).request;if(!next)await new Promise(resolve=>setTimeout(resolve,100));}
    if(!next||next.origin!==entry.origin||next.position!==entry.position+1||next.total!==entry.total)throw new Error('Secure input changed.');
    request=(await pipe.workInput(workId,{action:'claim',holder,requestId:next.id})).request;current=request?.id;
   }
  }finally{if(current)await pipe.workInput(workId,{action:'cancel',holder,requestId:current}).catch(()=>{});this.#busy=false;}
 }
 dispose(){this.invalidate();this.connection.off('invalidate',this.invalidate);}
}
