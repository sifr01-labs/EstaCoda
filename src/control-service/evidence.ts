import type {WorkProjection} from '../contracts/desktop-control/index.js';
import type {EvidenceReport} from '../contracts/desktop-control/evidence.js';
import {projectExecutionEvidence} from '../evidence/execution-evidence.js';
import {artifactDatabase,workArtifactReferences} from './artifacts.js';
import type {SQLiteSessionDB} from '../session/sqlite-session-db.js';
import {SQLiteTaskStore} from '../tasks/sqlite-task-store.js';
type Input={homeDir:string;profileId:string};
async function sessionEvidence(input:Input,db:SQLiteSessionDB,id:string,workId:string,signal:AbortSignal):Promise<EvidenceReport>{
 const session=await db.getSessionForProfile(id,input.profileId);if(!session)throw new Error('Evidence unavailable.');
 const saved=session.metadata?.latestUserTurn as {id?:unknown}|undefined;
 const message=db.db.query<{id:string}>("select id from messages where session_id=? and role='user' order by rowid desc limit 1").get(id);
 const turnId=typeof saved?.id==='string'?saved.id:message?.id??null;
 const outcome=db.db.query<{row:number;status:string;completionFloor:string}>(`select rowid as row,json_extract(event_json,'$.status') as status,json_extract(event_json,'$.completionFloor') as completionFloor from session_events where session_id=? and json_valid(event_json) and json_extract(event_json,'$.kind')='execution-final-outcome-recorded' and json_extract(event_json,'$.turnMessageId')=? order by rowid desc limit 1`).get(id,turnId);
 const rows=db.db.query<{data:string|null}>(`select case when length(event_json)<=4096 then event_json else null end as data from session_events where session_id=? and rowid<=? and json_valid(event_json) and json_extract(event_json,'$.kind')='execution-evidence-recorded' and json_extract(event_json,'$.visibleTurnId')=? order by rowid desc limit 1025`).all(id,outcome?.row??Number.MAX_SAFE_INTEGER,turnId);
 signal.throwIfAborted();return projectExecutionEvidence({workId,turnId,outcome:outcome??null,events:rows.slice(0,1024).reverse().flatMap(row=>row.data?[JSON.parse(row.data)]:[]),truncated:rows.length>1024||rows.some(row=>!row.data)});
}
async function deriveWorkEvidence(input:Input,work:WorkProjection,signal:AbortSignal):Promise<EvidenceReport>{
 if(work.profileId!==input.profileId)throw new Error('Evidence profile unavailable.');
 const db=await artifactDatabase(input);
 try{
  db.db.exec('begin');
  if(work.kind==='session')return await sessionEvidence(input,db,work.canonicalId,work.id,signal);
  const store=new SQLiteTaskStore({db:db.db,profileId:input.profileId});
  if(work.kind==='task_attempt'){
   const attempt=store.getAttempt(work.canonicalId);if(!attempt)throw new Error('Attempt unavailable.');
   const report=attempt.workerSessionId?await sessionEvidence(input,db,attempt.workerSessionId,work.id,signal):projectExecutionEvidence({workId:work.id,turnId:null,outcome:null,events:[],truncated:false});
   if(attempt.status!=='completed'){report.state=attempt.status==='failed'?'failed':'unverified';report.completion=attempt.status==='failed'?'failed':'unconfirmed';report.summary='The owning attempt has not established successful completion.';report.limitations.push('This attempt has not completed successfully.');}
   return report;
  }
  if(work.kind!=='task')throw new Error('Evidence unavailable.');
  const task=store.getTask(work.canonicalId);if(!task)throw new Error('Task unavailable.');
  const rows=db.db.query<{id:string;step_id:string}>('select id,step_id from task_attempts where profile_id=? and task_id=? and plan_revision_id=? order by attempt_number desc, created_at desc limit 129').all(input.profileId,task.id,task.activePlanRevisionId??'');
  const steps=new Set<string>(),reports:EvidenceReport[]=[];
  for(const row of rows.slice(0,128)){signal.throwIfAborted();if(steps.has(row.step_id))continue;steps.add(row.step_id);const attempt=store.getAttempt(row.id)!;
   if(attempt.status!=='completed'||!attempt.workerSessionId){reports.push(projectExecutionEvidence({workId:work.id,turnId:null,outcome:null,events:[],truncated:false}));continue;}
   reports.push(await sessionEvidence(input,db,attempt.workerSessionId,`attempt:${attempt.id}`,signal));
  }
  // Task settlement and the latest attempt of every step both matter. Result text alone is not a verifier.
  const planSteps=task.activePlanRevisionId?store.listSteps(task.id,task.activePlanRevisionId):[];
  const completePlan=planSteps.length>0&&planSteps.every(step=>step.status==='completed'&&steps.has(step.id));
  const facts=reports.flatMap(report=>report.facts),truncated=rows.length>128||facts.length>64||reports.some(report=>report.truncated);
  const state=task.status==='failed'?'failed':task.status==='completed'&&completePlan&&reports.length>0&&reports.every(report=>report.state==='verified')&&!truncated?'verified':task.status==='partial'?'partial':'unverified';
  return{workId:work.id,state,artifacts:[],completion:task.status==='completed'?'completed':task.status==='failed'?'failed':task.status==='partial'?'partial':task.status==='cancelled'?'cancelled':'unconfirmed',summary:state==='verified'?'The completed Task has verified latest-attempt evidence.':'Task Results and completion do not by themselves establish verified effects.',facts:facts.slice(0,64),truncated,limitations:[...new Set(reports.flatMap(report=>report.limitations))].slice(0,8).concat(state==='verified'?[]:['Inspect the latest attempts and retained Results before relying on Task effects.'])};
 }finally{db.close();}
}

export async function workEvidence(input:Input,work:WorkProjection,signal:AbortSignal):Promise<EvidenceReport>{
 const report=await deriveWorkEvidence(input,work,signal);
 const outputs=await workArtifactReferences(input,work,signal);
 report.artifacts=outputs.references;
 if(outputs.truncated)report.limitations.push('Only the first 16 retained output references are shown.');
 return report;
}
