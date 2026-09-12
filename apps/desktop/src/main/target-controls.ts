import {randomUUID,createHash} from 'node:crypto';
import {constants,openSync,closeSync,fstatSync,readFileSync,writeFileSync,mkdirSync,renameSync} from 'node:fs';
import {join} from 'node:path';
import type {TargetReference,TargetCreationReview,TargetOperation} from '@estacoda/control-protocol';
import type {DesktopConnection} from './connection.js';
/** Only opaque references persist in Main. Paths and Git operations stay in core. */
export class DesktopTargetControls {
 private drafts=new Map<string,{review:TargetCreationReview;profileId:string;generation:number}>();
 private busy=false;
 constructor(readonly connection:DesktopConnection,readonly directory:string){connection.on('state',()=>{for(const[id,draft]of this.drafts)if(draft.profileId!==connection.state.profileId||draft.generation!==connection.state.generation)this.drafts.delete(id);});}
 private file(){return join(this.directory,'target-operation-'+createHash('sha256').update(this.connection.state.profileId).digest('hex')+'.json');}
 private save(operationId:string){mkdirSync(this.directory,{recursive:true,mode:0o700});const path=join(this.directory,'target-'+randomUUID()+'.tmp');writeFileSync(path,JSON.stringify({operationId}),{flag:'wx',mode:0o600});renameSync(path,this.file());}
 async operation():Promise<TargetOperation|null>{let fd:number|undefined;let operationId:string;try{fd=openSync(this.file(),constants.O_RDONLY|constants.O_NOFOLLOW);const stat=fstatSync(fd);if(!stat.isFile()||stat.size>1024)throw new Error('Invalid target receipt reference');const value=JSON.parse(readFileSync(fd,'utf8'));if(!/^[a-f0-9-]{36}$/.test(value.operationId))throw new Error('Invalid target receipt reference');operationId=value.operationId;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}finally{if(fd!==undefined)closeSync(fd);}return this.connection.targetRequest('targets.inspectOperation',{operationId});}
 async review(source:TargetReference){
  for(const[id,draft]of this.drafts)if(draft.review.expiresAt<=Date.now())this.drafts.delete(id);
  if(this.drafts.size>=16)throw new Error('Close an existing review first');
  const profileId=this.connection.state.profileId,generation=this.connection.state.generation;
  const review=await this.connection.targetRequest('targets.reviewCreate',{source});
  this.drafts.set(review.reviewId,{review,profileId,generation});return review;
 }
 async cancel(reviewId:string){this.drafts.delete(reviewId);return this.connection.targetRequest('targets.cancelReview',{reviewId});}
 async create(reviewId:string,trustNewPath:true){
  if(this.busy||trustNewPath!==true)throw new Error('Target operation unavailable');
  const draft=this.drafts.get(reviewId);
  if(!draft||draft.profileId!==this.connection.state.profileId||draft.generation!==this.connection.state.generation||draft.review.expiresAt<=Date.now())throw new Error('Review expired');
  this.busy=true;
  try{this.save(draft.review.operationId);this.drafts.delete(reviewId);return await this.connection.targetRequest('targets.create',{reviewId,source:draft.review.source,trustNewPath});}finally{this.busy=false;}
 }
 async execute(action:'archive'|'cleanup',target:TargetReference,confirmed:true){
  if(this.busy||confirmed!==true)throw new Error('Target operation unavailable');this.busy=true;
  try{const operationId=randomUUID();this.save(operationId);return await this.connection.targetRequest('targets.execute',{operationId,action,target,confirmed});}finally{this.busy=false;}
 }
}
