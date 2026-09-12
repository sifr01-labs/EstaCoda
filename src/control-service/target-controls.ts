import {randomUUID} from 'node:crypto';
import {ControlProtocolError,type TargetReference,type TargetCreationReview,type TargetInspection,type TargetOperation} from '../contracts/desktop-control/index.js';
import {ManagedWorktrees,type WorktreeCreationReview} from '../workspaces/managed-worktrees.js';
import {targetBinding} from '../workspaces/execution-target.js';
import {inspectCoreTarget} from './work-targets.js';
/** Bridge-local review tokens disappear on disconnect. Only core writes targets. */
export class TargetControls {
 private closed=false;
 private readonly drafts=new Map<string,{review:WorktreeCreationReview;expiresAt:number}>();
 constructor(readonly input:{homeDir:string;profileId:string}){}
 dispose(){this.closed=true;this.drafts.clear();}
 private async use<T>(run:(store:ManagedWorktrees)=>Promise<T>|T):Promise<T>{const store=new ManagedWorktrees(this.input);try{return await run(store);}finally{store.close();}}
 async list(signal:AbortSignal,cursor?:string){return this.use(async store=>{const records=store.listTargets(101,cursor);const items=[];for(const target of records.slice(0,100)){signal.throwIfAborted();items.push(await inspectCoreTarget(this.input,{targetId:target.id,targetGeneration:target.generation},signal));}return{items,truncated:records.length>100,...(records.length>100?{nextCursor:records[99]!.id}:{})};});}
 async inspect(reference:TargetReference,signal?:AbortSignal):Promise<TargetInspection>{return this.use(async store=>{
  const details=await inspectCoreTarget(this.input,reference,signal);const target=store.getTarget(reference.targetId)!;
  let dirty:boolean|null=null;if(target.kind==='git-worktree'&&target.cleanup==='retained'){try{dirty=await store.dirty(reference,signal);}catch{/* Unknown is not clean. */}}
  signal?.throwIfAborted();return {...details,dirty,borrowers:store.borrowers(target.id),branch:target.kind==='git-worktree'?target.creation.branch:null,cleanup:target.kind==='git-worktree'?target.cleanup:null};
 });}
 async review(source:TargetReference,signal?:AbortSignal):Promise<TargetCreationReview>{
  for(const[id,draft]of this.drafts)if(draft.expiresAt<=Date.now())this.drafts.delete(id);
  if(this.drafts.size>=16)throw new ControlProtocolError('-32009');
  return this.use(async store=>{
    const target=store.getTarget(source.targetId);if(!target||target.generation!==source.targetGeneration)throw new ControlProtocolError('-32003');
    const review=await store.review(targetBinding(target),signal);if(this.closed)throw new ControlProtocolError('-32003');const reviewId=randomUUID(),expiresAt=Date.now()+300_000;this.drafts.set(reviewId,{review,expiresAt});
    return {reviewId,operationId:review.operationId,source,sourceRoot:review.source.workspace.canonicalPath,destination:review.destination,branch:review.branch,baseCommit:review.baseCommit,expiresAt};
  });
 }
 cancel(reviewId:string){return{cancelled:this.drafts.delete(reviewId)};}
 async create(input:{reviewId:string;source:TargetReference;trustNewPath:true},signal:AbortSignal):Promise<TargetOperation>{
  const draft=this.drafts.get(input.reviewId);
  if(!draft||draft.expiresAt<=Date.now()||draft.review.source.targetId!==input.source.targetId||draft.review.source.targetGeneration!==input.source.targetGeneration||input.trustNewPath!==true)throw new ControlProtocolError('-32003');
  signal.throwIfAborted();this.drafts.delete(input.reviewId);
  return this.use(async store=>{try{await store.create(draft.review,true,signal);}catch{/* Inspect the canonical receipt; no retry after uncertain effects. */}return store.inspectOperation(draft.review.operationId);});
 }
 async execute(input:{operationId:string;action:'archive'|'cleanup';target:TargetReference;confirmed:true},signal:AbortSignal){signal.throwIfAborted();if(input.confirmed!==true)throw new ControlProtocolError('-32602');return this.use(store=>store.executeLifecycle(input.operationId,input.action,input.target,signal));}
 async operation(operationId:string){return this.use(store=>store.inspectOperation(operationId));}
}
