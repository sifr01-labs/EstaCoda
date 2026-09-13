import {stat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {WorkspaceRegistry,resolveWorkspaceDirectory,normalizeWorkspaceAlias} from '../workspaces/workspace-registry.js';
import {WorkspaceTrustStore} from '../security/workspace-trust-store.js';
import {ControlProtocolError,type OnboardingWorkspaceReview} from '../contracts/desktop-control/index.js';
import {ConnectionOperations} from './connection-operations.js';
async function directoryIdentity(path:string){const s=await stat(path);return JSON.stringify([s.dev,s.ino]);}
/** Registration and trust have separate owners. Review is inert; apply is an explicit resumable operation. */
export class OnboardingWorkspace {
 readonly reviews=new Map<string,{projection:OnboardingWorkspaceReview;identity:string;directory:string;expires:number}>();
 readonly operations:ConnectionOperations;
 constructor(readonly input:{homeDir:string;profileId:string}){this.operations=new ConnectionOperations(input);}
 async review(params:{path:string;alias:string;trust:boolean}){
  for(const [id,r] of this.reviews)if(r.expires<Date.now())this.reviews.delete(id);
  if(this.reviews.size>=16)throw new ControlProtocolError('-32009');
  const identity=await resolveWorkspaceDirectory(params.path),alias=normalizeWorkspaceAlias(params.alias);
  const projection={reviewId:randomUUID(),path:identity.canonicalPath,alias,trust:params.trust};
  this.reviews.set(projection.reviewId,{projection,identity:identity.identityHash,directory:await directoryIdentity(identity.canonicalPath),expires:Date.now()+300000});return projection;
 }
 cancel(reviewId:string){return {cancelled:this.reviews.delete(reviewId)};}
 async apply(params:{reviewId:string;operationId:string;confirmed:true}){
  const r=this.reviews.get(params.reviewId);if(!r||r.expires<Date.now()||params.confirmed!==true)throw new ControlProtocolError('-32003');
  if((await resolveWorkspaceDirectory(r.projection.path)).identityHash!==r.identity||await directoryIdentity(r.projection.path)!==r.directory)throw new ControlProtocolError('-32003');
  return this.operations.execute(params.operationId,'onboarding.workspace',async()=>{
   if((await resolveWorkspaceDirectory(r.projection.path)).identityHash!==r.identity||await directoryIdentity(r.projection.path)!==r.directory)return false;
   const registry=new WorkspaceRegistry(this.input);
   try{
    const existing=registry.get(r.projection.alias);
    if(existing&&existing.identity.identityHash!==r.identity)return false;
    const workspace=existing??await registry.add(r.projection.alias,r.projection.path);
    if((await registry.resolve(workspace.id)).identity.identityHash!==r.identity)return false;
    if(r.projection.trust)await new WorkspaceTrustStore(this.input).grant(r.projection.path);
    this.reviews.delete(params.reviewId);return true;
   }finally{registry.close();}
  });
 }
 dispose(){this.reviews.clear();}
}
