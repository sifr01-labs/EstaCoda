import {WorkOperationReferences} from './work-operation-references.js';
import {randomUUID} from 'node:crypto';
import {type MethodContracts,type TargetReference,type OperationReceipt} from '@estacoda/control-protocol';
import type {DesktopConnection} from './connection.js';
import {WorkAttachments,type AttachmentScope} from './work-attachments.js';
import type {WorkAction,WorkSubmission} from '../shared/desktop-api.js';
type Inspection=MethodContracts['operations.inspect']['params'];
/** Main owns operation IDs and reference-only recovery; execution belongs to the supervisor. */
export class DesktopWorkControls {
 readonly references:WorkOperationReferences;readonly attachments=new WorkAttachments();#busy=new Set<string>();
 constructor(readonly connection:DesktopConnection,readonly directory:string,readonly chooseFiles:()=>Promise<string[]>){this.references=new WorkOperationReferences(connection,directory);connection.on('invalidate',()=>this.attachments.clear());}
 private fence(){const{profileId,generation}=this.connection.state;return()=>{if(this.connection.state.status!=='ready'||profileId!==this.connection.state.profileId||generation!==this.connection.state.generation)throw new Error('Desktop context changed.');};}

 async inspectDecision(itemId:string){const record=this.references.records()['approval:'+itemId];return record?this.connection.workRequest('operations.inspect',record):null;}
 async decide(itemId:string,decision:'approved'|'denied'):Promise<OperationReceipt>{
  const check=this.fence(),key=this.connection.state.profileId+':approval:'+itemId;
  if(this.#busy.has(key))throw new Error('Decision is settling.');this.#busy.add(key);
  try{
   const item=await this.connection.workRequest('inbox.get',{itemId});check();const approval=item.approval;
   if(item.profileId!==this.connection.state.profileId||item.kind!=='approval'||!item.workId||!approval||approval.scope!=='once'||!approval.decisions.includes(decision)||!item.actions?.some(action=>action.id===(decision==='approved'?'approve_once':'reject')&&action.enabled))throw new Error('Approval no longer available.');
   const work=await this.connection.getWork(item.workId);check();if(work.profileId!==item.profileId||work.target?.targetId!==approval.target.targetId||work.target.targetGeneration!==approval.target.targetGeneration)throw new Error('Approval target changed.');
   const previous=this.references.records()['approval:'+itemId];if(previous)return this.connection.workRequest('operations.inspect',previous);
   await this.references.makeRoom(check);check();
   const operationId=Date.now()+':'+randomUUID(),binding={operationId,sessionId:approval.sessionId,target:approval.target};
   this.references.save('approval:'+itemId,{...binding,method:'approvals.resolve'});
   return this.connection.workRequest('approvals.resolve',{...binding,approvalId:approval.id,decision});
  }finally{this.#busy.delete(key);}
 }
 async act(input:WorkAction):Promise<OperationReceipt>{
  const check=this.fence(),key=this.connection.state.profileId+':'+input.workId;
  if(this.#busy.has(key))throw new Error('Work control is settling.');this.#busy.add(key);
  try{
   await this.references.makeRoom(check);check();
   const work=await this.connection.getWork(input.workId);check();
   const action=work.actions?.find(action=>action.id===input.action&&action.stepId===input.stepId);
   if(work.profileId!==this.connection.state.profileId||!work.target||!work.modelBinding||!action?.enabled||!['session','task'].includes(work.kind)||input.action.startsWith('tasks.')!==(work.kind==='task'))throw new Error('Work action is unavailable.');
   const operationId=Date.now()+':'+randomUUID(),binding={operationId,sessionId:work.modelBinding.sessionId,target:{targetId:work.target.targetId,targetGeneration:work.target.targetGeneration},...(work.kind==='task'?{taskId:work.canonicalId}:{})};
   const previous=this.references.records()[work.id];
   if(previous&&!['sessions.cancelTurn','tasks.cancel','tasks.pause'].includes(input.action)&&(await this.connection.workRequest('operations.inspect',previous)).state!=='completed')throw new Error('Reconcile the previous operation first.');
   check();this.references.save(work.id,{...binding,method:input.action});
   return input.action==='tasks.guide'?this.connection.workRequest(input.action,{...binding,taskId:work.canonicalId,guidance:input.guidance!}):input.action==='tasks.retry'?this.connection.workRequest(input.action,{...binding,taskId:work.canonicalId,...(input.stepId?{stepId:input.stepId}:{})}):input.action.startsWith('tasks.')?this.connection.workRequest(input.action as 'tasks.pause'|'tasks.resume'|'tasks.cancel',{...binding,taskId:work.canonicalId}):this.connection.workRequest(input.action as 'sessions.resume'|'sessions.cancelTurn',binding);
  }finally{this.#busy.delete(key);}
 }
 async inspect(workId:string){const check=this.fence();await this.connection.getWork(workId);check();const record=this.references.records()[workId];return record?this.connection.workRequest('operations.inspect',record):null;}
 private async available(target:TargetReference){const page=await this.connection.workRequest('work.targets',{target});if(!page.items.some(item=>item.targetId===target.targetId&&item.targetGeneration===target.targetGeneration))throw new Error('Select an available trusted target.');}
 private scope(input:Pick<WorkSubmission,'draftId'|'target'>):AttachmentScope{return{profileId:this.connection.state.profileId,generation:this.connection.state.generation,target:input.target,draftId:input.draftId};}
 async attach(input:Pick<WorkSubmission,'draftId'|'target'>){const check=this.fence();await this.available(input.target);check();const scope=this.scope(input);const paths=await this.chooseFiles();check();return this.attachments.stage(paths,scope,check,path=>this.connection.inspectionRequest('media.stage',{path,target:scope.target}));}
 async submit(input:WorkSubmission):Promise<{workId:string;receipt:OperationReceipt}>{
  const check=this.fence(),key=this.connection.state.profileId+':'+(input.workId??input.draftId);
  if(this.#busy.has(key))throw new Error('Work is already submitting.');this.#busy.add(key);
  try{
   await this.references.makeRoom(check);check();
   await this.available(input.target);check();
   let sessionId:string,prepared:Inspection|undefined;
   if(input.workId){const work=await this.connection.getWork(input.workId);check();if(work.kind!=='session'||work.profileId!==this.connection.state.profileId||work.target?.targetId!==input.target.targetId||work.target.targetGeneration!==input.target.targetGeneration||!work.actions?.some(action=>action.id==='sessions.send'&&action.enabled))throw new Error('This Work cannot accept a prompt.');sessionId=work.canonicalId;const prior=this.references.records()[input.workId];if(prior&&(await this.connection.workRequest('operations.inspect',prior)).state!=='completed')throw new Error('Reconcile the previous operation before sending.');check();}
   else {
    const previous=this.references.records()[input.draftId];
    if(previous){
     if(previous.target.targetId!==input.target.targetId||previous.target.targetGeneration!==input.target.targetGeneration)throw new Error('Preparation target changed. Start a new draft.');
     const receipt=await this.connection.workRequest('operations.inspect',previous);check();
     if(!['sessions.start','sessions.setModel'].includes(previous.method))return{workId:previous.taskId?'task:'+previous.taskId:'session:'+previous.sessionId,receipt};
     if(receipt.state!=='completed')throw new Error('Preparation is not confirmed. Inspect Work before sending again.');
     prepared=previous;sessionId=previous.sessionId;
    }else sessionId=randomUUID();
   }
   const mediaIds=this.attachments.mediaIds(this.scope(input),input.attachmentIds);
   if(input.kind==='task'&&mediaIds.length)throw new Error('Use a Conversation for media attachments');
   const text=this.attachments.compose(this.scope(input),input.attachmentIds,input.text);
   if(input.kind==='task'&&(input.workId||text.length>4000||!input.limits))throw new Error('New Task objectives and attachments must fit 4,000 characters with reviewed limits.');
   const workId='session:'+sessionId,binding={sessionId,target:input.target};
   const settle=async(method:'sessions.start'|'sessions.setModel',selection?:WorkSubmission['selection'])=>{
    const operationId=Date.now()+':'+randomUUID();this.references.save(workId,{...binding,method,operationId});if(!input.workId)this.references.save(input.draftId,{...binding,method,operationId});
    let receipt=method==='sessions.start'?await this.connection.workRequest(method,{...binding,operationId}):await this.connection.workRequest(method,{...binding,operationId,selection:selection??null});
    for(let i=0;i<20&&['accepted','dispatched'].includes(receipt.state);i++){await new Promise(resolve=>setTimeout(resolve,100));check();receipt=await this.connection.workRequest('operations.inspect',{...binding,operationId,method});}check();if(receipt.state!=='completed')throw new Error('Preparation is not confirmed. Inspect Work before sending again.');
   };
   if(!input.workId){if(!prepared)await settle('sessions.start');if(input.kind!=='task'&&(input.selection||prepared?.method==='sessions.setModel'))await settle('sessions.setModel',input.selection);}
   if(input.kind==='task'){
    check();const taskId='task_'+randomUUID(),operationId=Date.now()+':'+randomUUID(),taskWorkId='task:'+taskId,record={...binding,operationId,taskId,method:'tasks.create' as const};
    this.references.save(taskWorkId,record);this.references.save(input.draftId,record);
    const receipt=await this.connection.workRequest('tasks.create',{...binding,operationId,taskId,objective:text,limits:input.limits!,selection:input.selection??null});check();this.attachments.remove(input.attachmentIds);return{workId:taskWorkId,receipt};
   }
   check();const operationId=Date.now()+':'+randomUUID();this.references.save(workId,{...binding,operationId,method:'sessions.send'});if(!input.workId)this.references.save(input.draftId,{...binding,operationId,method:'sessions.send'});
   const receipt=await this.connection.workRequest('sessions.send',{...binding,operationId,text,...(mediaIds.length?{mediaIds}:{})});check();this.attachments.remove(input.attachmentIds);return{workId,receipt};
  }finally{this.#busy.delete(key);}
 }
}
