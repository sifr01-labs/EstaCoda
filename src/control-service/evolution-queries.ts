import {join,dirname} from 'node:path';import {createHash} from 'node:crypto';import {lstat,readdir} from 'node:fs/promises';
import {resolveGlobalStateHome} from '../config/profile-home.js';
import {SkillEvolutionStore,type SkillPatchProposal} from '../skills/skill-evolution.js';
import {SkillProposalService} from '../skills/skill-proposal-service.js';
import {ChangeManifestStore} from '../skills/change-manifest-store.js';
import {SQLiteSessionDB} from '../session/sqlite-session-db.js';
import {ControlProtocolError,isControlId,type LibraryProposal,type LibraryProposalDetail} from '../contracts/desktop-control/index.js';
import {LibraryQueries,boundedLibraryPage} from './library-queries.js';import {readProfileFile} from './profile-attention.js';import {safeText} from './work-projections.js';
export class EvolutionQueries extends LibraryQueries{
 async open(){
  const root=join(this.paths.skillsPath,'.evolution');
  for(const name of ['proposed-patches.jsonl','observations.jsonl','learning-candidates.jsonl','experiments.jsonl','eval-runs.jsonl','promotions.jsonl','manifests/manifests.jsonl']){
   const raw=await readProfileFile(this.paths.profileRoot,join(root,name));const rows=raw?.split('\n').filter(s=>s.trim())??[];if(rows.length>1000)throw new ControlProtocolError('-32009');for(const row of rows){const value=JSON.parse(row);if(!value||typeof value!=='object'||!isControlId(value.id))throw new ControlProtocolError('-32003');}
  }
  await readProfileFile(this.paths.profileRoot,join(this.paths.skillsPath,'.usage.json'));
  const registry=await this.registry(),store=new SkillEvolutionStore({usagePath:join(this.paths.skillsPath,'.usage.json'),evolutionRoot:root}),manifests=new ChangeManifestStore({root:join(root,'manifests')});
  const evalHash=createHash('sha256');
  for(const skill of registry.listLoaded()){
   const dir=join(dirname(skill.sourcePath),'evals');let stat;try{stat=await lstat(dir);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')continue;throw e;}if(stat.isSymbolicLink()||!stat.isDirectory())throw new ControlProtocolError('-32003');
   const files=await readdir(dir,{withFileTypes:true});if(files.length>100)throw new ControlProtocolError('-32009');let size=0;
   for(const file of files){if(file.isSymbolicLink())throw new ControlProtocolError('-32003');if(file.isFile()&&/\.jsonl?$/.test(file.name)){const raw=await readProfileFile(skill.sourceKind==='bundled'?this.bundledRoot:this.paths.profileRoot,join(dir,file.name));size+=raw?.length??0;if(size>1048576)throw new ControlProtocolError('-32009');evalHash.update(skill.name+file.name+(raw??''));}}
  }
  return{registry,store,manifests,evalFingerprint:evalHash.digest('hex'),service:new SkillProposalService({registry,localSkillsRoot:this.paths.skillsPath,skillEvolutionStore:store,changeManifestStore:manifests})};
 }
 proposal(p:SkillPatchProposal):LibraryProposal{return{id:p.id,skillName:safeText(p.skillName,240),status:p.status,approval:safeText(p.approvalState??'pending',80),reason:safeText(p.reason),risk:safeText(p.riskClass??'unknown',80),changeKind:safeText(p.changeKind??'skill_patch',80)};}
 async list(offset=0){const {store}=await this.open(),rows=await store.listProposals();return boundedLibraryPage(rows.map(p=>this.proposal(p)),offset);}
 async sourceWork(sessionId:string|undefined):Promise<string|null>{
  if(!sessionId||!isControlId(sessionId))return null;const path=resolveGlobalStateHome(this.input).sessionsSqlitePath;let db:SQLiteSessionDB|undefined;
  try{const parent=await lstat(dirname(path));if(!parent.isDirectory()||parent.isSymbolicLink())return null;const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink())return null;db=new SQLiteSessionDB({path,readonly:true});return await db.getSessionForProfile(sessionId,this.input.profileId)?`session:${sessionId}`:null;}catch{return null;}finally{db?.close();}
 }
 async snapshotAvailable(path:string|undefined){if(!path)return false;try{return (await readProfileFile(join(this.paths.skillsPath,'.snapshots'),join(path,'SKILL.md')))!==undefined;}catch{return false;}}
 async details(id:string):Promise<LibraryProposalDetail>{
  const {store,service,manifests}=await this.open(),p=await store.findProposal(id);if(!p)throw new ControlProtocolError('-32004');const d=await service.reviewProposalDetails(p),manifest=p.changeManifestId?await manifests.find(p.changeManifestId):undefined,promotions=await store.listPromotions({proposalId:id});
  const evidence=boundedLibraryPage(await Promise.all(d.linkedEvidence.slice(0,50).map(async e=>({id:e.id,summary:safeText(e.lesson??e.candidateImprovement??e.type),sourceWorkId:await this.sourceWork(e.sessionId)}))));
  return{proposal:{...this.proposal(p),risk:d.review.riskLevel},diff:safeText(d.review.diffSummary,8192),gate:{status:(d.review.evalResult?.status??'not-run') as 'passed'|'failed'|'not-run',score:d.review.evalResult?.score??null,threshold:d.review.evalResult?.threshold??null,failures:(d.review.evalResult?.failures??[]).slice(0,20).map(s=>safeText(s,512))},evidence:evidence.items,evalRuns:d.evalRuns.slice(-20).map(e=>({id:e.id,label:safeText(e.evalId,240),passed:e.passed})),manifest:manifest?{id:manifest.id,status:manifest.status,target:manifest.target,commands:[manifest.evalCommand,...manifest.constraintGates].filter(Boolean).slice(0,16).map(s=>safeText(s,240))}:null,promotions:await Promise.all(promotions.slice(-20).map(async p=>({id:p.id,appliedAt:p.appliedAt,snapshotAvailable:await this.snapshotAvailable(p.snapshotPath)}))),rollbackAvailable:!!await service.reviewProposalRollback(id),truncated:evidence.nextOffset!==null||d.linkedEvidence.length>50||d.evalRuns.length>20||promotions.length>20};
 }
}
