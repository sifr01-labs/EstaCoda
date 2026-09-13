import {join} from 'node:path';import {lstat} from 'node:fs/promises';
import {resolveGlobalStateHome} from '../config/profile-home.js';
import {SkillEvolutionStore,type SkillPatchProposal} from '../skills/skill-evolution.js';
import {SkillProposalService} from '../skills/skill-proposal-service.js';
import {ChangeManifestStore} from '../skills/change-manifest-store.js';
import {SQLiteSessionDB} from '../session/sqlite-session-db.js';
import {ControlProtocolError,isControlId,type LibraryProposal,type LibraryProposalDetail} from '../contracts/desktop-control/index.js';
import {LibraryQueries} from './library-queries.js';import {readProfileFile} from './profile-attention.js';import {safeText} from './work-projections.js';
export class EvolutionQueries extends LibraryQueries{
 async open(){
  const root=join(this.paths.skillsPath,'.evolution');
  for(const name of ['proposed-patches.jsonl','observations.jsonl','learning-candidates.jsonl','experiments.jsonl','eval-runs.jsonl','promotions.jsonl','manifests/manifests.jsonl']){
   const raw=await readProfileFile(this.paths.profileRoot,join(root,name));const rows=raw?.split('\n').filter(s=>s.trim())??[];if(rows.length>1000)throw new ControlProtocolError('-32009');for(const row of rows){const value=JSON.parse(row);if(!value||typeof value!=='object'||!isControlId(value.id))throw new ControlProtocolError('-32003');}
  }
  const registry=await this.registry(),store=new SkillEvolutionStore({usagePath:join(this.paths.skillsPath,'.usage.json'),evolutionRoot:root}),manifests=new ChangeManifestStore({root:join(root,'manifests')});
  return{registry,store,manifests,service:new SkillProposalService({registry,localSkillsRoot:this.paths.skillsPath,skillEvolutionStore:store,changeManifestStore:manifests})};
 }
 proposal(p:SkillPatchProposal):LibraryProposal{return{id:p.id,skillName:safeText(p.skillName,240),status:p.status,approval:safeText(p.approvalState??'pending',80),reason:safeText(p.reason),risk:safeText(p.riskClass??'unknown',80),changeKind:safeText(p.changeKind??'skill_patch',80)};}
 async list(offset=0){const {store}=await this.open(),rows=await store.listProposals();return{items:rows.slice(offset,offset+50).map(p=>this.proposal(p)),nextOffset:offset+50<rows.length?offset+50:null};}
 async sourceWork(sessionId:string|undefined):Promise<string|null>{
  if(!sessionId||!isControlId(sessionId))return null;const path=resolveGlobalStateHome(this.input).sessionsSqlitePath;let db:SQLiteSessionDB|undefined;
  try{const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink())return null;db=new SQLiteSessionDB({path,readonly:true});return await db.getSessionForProfile(sessionId,this.input.profileId)?`session:${sessionId}`:null;}catch{return null;}finally{db?.close();}
 }
 async details(id:string):Promise<LibraryProposalDetail>{
  const {store,service,manifests}=await this.open(),p=await store.findProposal(id);if(!p)throw new ControlProtocolError('-32004');const d=await service.reviewProposalDetails(p),manifest=p.changeManifestId?await manifests.find(p.changeManifestId):undefined,promotions=await store.listPromotions({proposalId:id});
  return{proposal:{...this.proposal(p),risk:d.review.riskLevel},diff:safeText(d.review.diffSummary,8192),gate:{status:(d.review.evalResult?.status??'not-run') as 'passed'|'failed'|'not-run',score:d.review.evalResult?.score??null,threshold:d.review.evalResult?.threshold??null,failures:(d.review.evalResult?.failures??[]).slice(0,20).map(s=>safeText(s,512))},evidence:await Promise.all(d.linkedEvidence.slice(0,50).map(async e=>({id:e.id,summary:safeText(e.lesson??e.candidateImprovement??e.type),sourceWorkId:await this.sourceWork(e.sessionId)}))),evalRuns:d.evalRuns.slice(-20).map(e=>({id:e.id,label:safeText(e.evalId,240),passed:e.passed})),manifest:manifest?{id:manifest.id,status:manifest.status,target:manifest.target,commands:[manifest.evalCommand,...manifest.constraintGates].filter(Boolean).slice(0,16).map(s=>safeText(s,240))}:null,promotions:promotions.slice(-20).map(p=>({id:p.id,appliedAt:p.appliedAt,snapshotAvailable:!!p.snapshotPath})),truncated:d.linkedEvidence.length>50||d.evalRuns.length>20||promotions.length>20};
 }
}
