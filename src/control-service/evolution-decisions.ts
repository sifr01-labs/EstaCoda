import {createHash,randomUUID} from 'node:crypto';
import {ControlProtocolError,type EvolutionAction,type EvolutionReview,type TargetReference} from '../contracts/desktop-control/index.js';
import {withProfileWriteLock} from '../config/profile-write-lock.js';
import {canTransition} from '../evolution/candidate-lifecycle.js';
import {isAllowedGateCommand,normalizeGateCommand} from '../evolution/constraint-gate-runner.js';
import {EvolutionQueries} from './evolution-queries.js';
import {ConnectionOperations} from './connection-operations.js';
import {availableWorkTargets} from './work-targets.js';
import {ExecutionTargetStore} from '../workspaces/execution-target.js';
import {withInspection} from './inspection-lease.js';
import {evolutionGates} from './evolution-gates.js';
import {safeText} from './work-projections.js';
type Input={proposalId:string;action:EvolutionAction;target?:TargetReference};
export class EvolutionDecisions extends EvolutionQueries{
 readonly operations=new ConnectionOperations(this.input);
 readonly reviews=new Map<string,{input:Input;fingerprint:string;projection:EvolutionReview;expires:number}>();
 readonly controller=new AbortController();
 async fingerprint(id:string){const {store,registry,manifests,evalFingerprint,service}=await this.open(),p=await store.findProposal(id);if(!p)throw new ControlProtocolError('-32004');const skill=registry.get(p.skillName),manifest=p.changeManifestId?await manifests.find(p.changeManifestId):null;return createHash('sha256').update(JSON.stringify({p,skill,manifest,evalFingerprint,rollback:await service.reviewProposalRollback(id),usage:await store.getUsage(p.skillName),observations:await store.listObservations({ids:p.evidence.observations}),evals:await store.listEvalRuns({skillName:p.skillName})})).digest('hex');}
 async review(input:Input):Promise<EvolutionReview>{
  const before=await this.fingerprint(input.proposalId);const detail=await this.details(input.proposalId),{store,service}=await this.open(),p=(await store.findProposal(input.proposalId))!;
  const commands=detail.manifest?.commands??[],diff=input.action==='rollback'?(await service.reviewProposalRollback(p.id))?.before??'':JSON.stringify(p.patch??detail.diff,null,2);let reason:EvolutionReview['reason']='ready',workspace:string|null=null;
  if(input.action==='rollback'?!detail.rollbackAvailable:p.status!=='proposed')reason='stale';
  else if(input.action!=='reject'&&(diff.length>8192||commands.length>4))reason='review_too_large';
  else if(input.action==='promote'&&(!p.patch||p.changeKind!=='skill_patch'))reason='unsupported';
  else if(input.action==='promote'&&p.approvalState!=='approved')reason='approval_required';
  else if(!['reject','rollback'].includes(input.action)&&detail.gate.status==='failed')reason='gates_failed';
  else if(detail.manifest&&!canTransition(detail.manifest.status as Parameters<typeof canTransition>[0],input.action).ok)reason='stale';
  if(['test','promote','rollback'].includes(input.action)&&commands.length){
   if(commands.some(c=>!isAllowedGateCommand(c)))reason='unsupported';
   else if(!input.target)reason='workspace_required';
   else try{const targets=await availableWorkTargets(this.input,this.controller.signal,{target:input.target});if(!targets.items.length)throw new Error();const targetsStore=new ExecutionTargetStore({...this.input,readonly:true});try{workspace=targetsStore.getTarget(input.target.targetId)!.workspace.canonicalPath;}finally{targetsStore.close();}}catch{reason='workspace_required';}
  }
  for(const [id,r]of this.reviews)if(r.expires<Date.now())this.reviews.delete(id);if(this.reviews.size>=16)throw new ControlProtocolError('-32009');
  const projection={reviewId:randomUUID(),proposalId:p.id,action:input.action,diff:safeText(diff,8192),commands:commands.map(normalizeGateCommand),workspace,allowed:reason==='ready',reason};
  if(before!==await this.fingerprint(p.id))throw new ControlProtocolError('-32004');
  this.reviews.set(projection.reviewId,{input:structuredClone(input),fingerprint:before,projection,expires:Date.now()+300000});return projection;
 }
 cancel(id:string){this.reviews.delete(id);return{cancelled:true};}
 async execute(params:{reviewId:string;operationId:string;confirmed:true},caller:AbortSignal){
  const r=this.reviews.get(params.reviewId);if(!r||!r.projection.allowed||r.expires<Date.now()||params.confirmed!==true)throw new ControlProtocolError('-32003');
  const signal=AbortSignal.any([caller,this.controller.signal]);signal.throwIfAborted();
  if(await this.fingerprint(r.input.proposalId)!==r.fingerprint)throw new ControlProtocolError('-32004');
  return this.operations.execute(params.operationId,`evolution:${r.input.action}:${r.fingerprint.slice(0,48)}`,async()=>{
   const gates=r.projection.commands;
   if(['test','promote','rollback'].includes(r.input.action)&&gates.length){if(!r.input.target)return false;const passed=await withInspection(this.input,r.input.target,signal,(lease)=>evolutionGates(lease,gates,signal));if(!passed)return false;}
   return withProfileWriteLock(this.paths.profileRoot,async()=>{
    signal.throwIfAborted();if(await this.fingerprint(r.input.proposalId)!==r.fingerprint)return false;
    const {store,service,manifests}=await this.open(),p=(await store.findProposal(r.input.proposalId))!;
    if(r.input.action==='rollback')return service.rollbackProposal(p.id);
    if(r.input.action==='reject')return !!await service.rejectProposal(p.id);
    if(r.input.action==='test'){if(p.changeManifestId)await manifests.updateStatus(p.changeManifestId,'testing');return true;}
    if(r.input.action==='approve'){const approved=await service.approveProposal(p.id,'desktop-operator');if(approved&&p.changeManifestId)await manifests.updateStatus(p.changeManifestId,'approved');return !!approved;}
    // The existing owner checks trust, mutation policy, proposed content and evals, then snapshots.
    return (await service.promoteProposal(p.id)).ok;
   });
  },()=>{this.reviews.delete(params.reviewId);});
 }
 dispose(){this.controller.abort();this.reviews.clear();}
}
