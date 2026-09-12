import {randomUUID,createHash} from 'node:crypto';
import {constants,openSync,closeSync,fstatSync,readFileSync,writeFileSync,mkdirSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import {validateControlRequest,CONTROL_METHODS,CONTROL_EVENTS,type MethodContracts,type TargetReference,type OperationReceipt} from '@estacoda/control-protocol';
import type {DesktopConnection} from './connection.js';
import {WorkAttachments,type AttachmentScope} from './work-attachments.js';
import type {WorkSubmission} from '../shared/desktop-api.js';
type Inspection=MethodContracts['operations.inspect']['params'];
/** Main owns operation IDs and reference-only recovery; execution belongs to the supervisor. */
export class DesktopWorkControls {
 readonly attachments=new WorkAttachments();#busy=new Set<string>();
 constructor(readonly connection:DesktopConnection,readonly directory:string,readonly chooseFiles:()=>Promise<string[]>){connection.on('invalidate',()=>this.attachments.clear());}
 private fence(){const{profileId,generation}=this.connection.state;return()=>{if(this.connection.state.status!=='ready'||profileId!==this.connection.state.profileId||generation!==this.connection.state.generation)throw new Error('Desktop context changed.');};}
 private file(){return join(this.directory,'work-operations-'+createHash('sha256').update(this.connection.state.profileId).digest('hex')+'.json');}
 private records():Record<string,Inspection>{let fd:number|undefined;try{fd=openSync(this.file(),constants.O_RDONLY|constants.O_NOFOLLOW);if(!fstatSync(fd).isFile()||fstatSync(fd).size>131072)throw new Error('Invalid recovery state');const records:unknown=JSON.parse(readFileSync(fd,'utf8'));if(!records||typeof records!=='object'||Array.isArray(records)||Object.keys(records).length>100)throw new Error('Invalid recovery state');for(const value of Object.values(records))validateControlRequest({jsonrpc:'2.0',id:'inspect',method:'operations.inspect',params:value},{profileId:this.connection.state.profileId,instanceId:'main',capabilities:{methods:[...CONTROL_METHODS],events:[...CONTROL_EVENTS]}});return records as Record<string,Inspection>;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return{};throw error;}finally{if(fd!==undefined)closeSync(fd);}}
 private save(workId:string,record:Inspection){const records=this.records();if(!records[workId]&&Object.keys(records).length>=100)throw new Error('Work operation inspection limit reached.');records[workId]=record;mkdirSync(this.directory,{recursive:true,mode:0o700});const temporary=join(this.directory,'work-operation-'+randomUUID()+'.tmp');writeFileSync(temporary,JSON.stringify(records),{flag:'wx',mode:0o600});renameSync(temporary,this.file());}
 async inspect(workId:string){const check=this.fence();await this.connection.getWork(workId);check();const record=this.records()[workId];return record?this.connection.workRequest('operations.inspect',record):null;}
 private async available(target:TargetReference){const page=await this.connection.workRequest('work.targets',{});if(!page.items.some(item=>item.targetId===target.targetId&&item.targetGeneration===target.targetGeneration))throw new Error('Select an available trusted target.');}
 private scope(input:Pick<WorkSubmission,'draftId'|'target'>):AttachmentScope{return{profileId:this.connection.state.profileId,generation:this.connection.state.generation,target:input.target,draftId:input.draftId};}
 async attach(input:Pick<WorkSubmission,'draftId'|'target'>){const check=this.fence();await this.available(input.target);check();const scope=this.scope(input);const paths=await this.chooseFiles();check();return this.attachments.stage(paths,scope,check);}
 async submit(input:WorkSubmission):Promise<{workId:string;receipt:OperationReceipt}>{
  const check=this.fence(),key=this.connection.state.profileId+':'+(input.workId??input.draftId);
  if(this.#busy.has(key))throw new Error('Work is already submitting.');this.#busy.add(key);
  try{
   await this.available(input.target);check();
   let sessionId:string;
   if(input.workId){const work=await this.connection.getWork(input.workId);check();if(work.kind!=='session'||work.profileId!==this.connection.state.profileId||work.target?.targetId!==input.target.targetId||work.target.targetGeneration!==input.target.targetGeneration||!work.actions?.some(action=>action.id==='sessions.send'&&action.enabled))throw new Error('This Work cannot accept a prompt.');sessionId=work.canonicalId;const prior=this.records()[input.workId];if(prior&&(await this.connection.workRequest('operations.inspect',prior)).state!=='completed')throw new Error('Reconcile the previous operation before sending.');check();}
   else {const previous=this.records()[input.draftId];if(previous){const receipt=await this.connection.workRequest('operations.inspect',previous);check();return{workId:'session:'+previous.sessionId,receipt};}sessionId=randomUUID();}
   const text=this.attachments.compose(this.scope(input),input.attachmentIds,input.text);
   const workId='session:'+sessionId,binding={sessionId,target:input.target};
   const settle=async(method:'sessions.start'|'sessions.setModel',selection?:WorkSubmission['selection'])=>{
    const operationId=Date.now()+':'+randomUUID();this.save(workId,{...binding,method,operationId});if(!input.workId)this.save(input.draftId,{...binding,method,operationId});
    let receipt=method==='sessions.start'?await this.connection.workRequest(method,{...binding,operationId}):await this.connection.workRequest(method,{...binding,operationId,selection:selection??null});
    for(let i=0;i<20&&['accepted','dispatched'].includes(receipt.state);i++){await new Promise(resolve=>setTimeout(resolve,100));check();receipt=await this.connection.workRequest('operations.inspect',{...binding,operationId,method});}check();if(receipt.state!=='completed')throw new Error('Preparation is not confirmed. Inspect Work before sending again.');
   };
   if(!input.workId){await settle('sessions.start');if(input.selection)await settle('sessions.setModel',input.selection);}
   check();const operationId=Date.now()+':'+randomUUID();this.save(workId,{...binding,operationId,method:'sessions.send'});if(!input.workId)this.save(input.draftId,{...binding,operationId,method:'sessions.send'});
   const receipt=await this.connection.workRequest('sessions.send',{...binding,operationId,text});check();this.attachments.remove(input.attachmentIds);return{workId,receipt};
  }finally{this.#busy.delete(key);}
 }
}
