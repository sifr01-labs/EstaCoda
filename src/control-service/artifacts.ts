import {lstat,realpath} from 'node:fs/promises';
import {join,relative} from 'node:path';
import {SQLiteSessionDB} from '../session/sqlite-session-db.js';
import {SQLiteTaskStore} from '../tasks/sqlite-task-store.js';
import {TaskResultService} from '../tasks/task-result-service.js';
import {resolveGlobalStateHome,resolveProfileStateHome} from '../config/profile-home.js';
import {ArtifactStore,parseRegistration,retainedArtifactMetadata} from '../artifacts/artifact-store.js';
import {sessionArtifactLinks,taskArtifactLinks} from '../artifacts/artifact-ownership.js';
import type {ArtifactProjection,ArtifactPreview,ArtifactReference} from '../contracts/desktop-control/artifacts.js';
import {safeText} from './work-projections.js';
type Input={homeDir:string;profileId:string};
export async function artifactDatabase(input:Input):Promise<SQLiteSessionDB>{
 const path=resolveGlobalStateHome(input).sessionsSqlitePath,info=await lstat(path);
 if(!info.isFile()||info.isSymbolicLink())throw new Error('Artifact database unavailable.');
 return new SQLiteSessionDB({path,readonly:true});
}
async function resolveArtifact(input:Input,db:SQLiteSessionDB,reference:ArtifactReference):Promise<{artifact:ArtifactProjection;preview:()=>Promise<{text:string|null;truncated:boolean}>}>{
 const tasks=new SQLiteTaskStore({db:db.db,profileId:input.profileId}),paths=resolveProfileStateHome(input);
 if(reference.source==='session'){
  const session=await db.getSessionForProfile(reference.ownerId,input.profileId);if(!session)throw new Error('Artifact unavailable.');
  const row=db.db.query<{data:string|null}>(`select case when length(event_json)<=16384 then json_extract(event_json,'$.artifact') else null end as data from session_events where session_id=? and json_valid(event_json) and json_extract(event_json,'$.kind')='session-artifact-registered' and json_extract(event_json,'$.artifact.id')=? order by rowid desc limit 1`).get(session.id,reference.artifactId);
  const registration=row?.data?parseRegistration(JSON.parse(row.data)):undefined;
  if(!registration||registration.sessionId!==session.id||registration.profileId!==input.profileId)throw new Error('Artifact unavailable.');
  const attemptRow=db.db.query<{id:string}>('select id from task_attempts where profile_id=? and worker_session_id=? order by created_at desc limit 1').get(input.profileId,session.id);
  const attempt=attemptRow?tasks.getAttempt(attemptRow.id):null,task=attempt?tasks.getTask(attempt.taskId):null;
  const links=sessionArtifactLinks(input.profileId,session,task??undefined,attempt??undefined),metadata=retainedArtifactMetadata(registration);
  return {artifact:{reference,displayName:metadata.displayName,mimeType:metadata.mimeType,bytes:metadata.bytes,sha256:metadata.sha256,createdAt:metadata.createdAt,retention:'retained',sourceOrigin:metadata.sourceOrigin,workIds:links.workIds,target:metadata.provenance?.target??(session.executionTarget?{targetId:session.executionTarget.targetId,targetGeneration:session.executionTarget.targetGeneration}:null)},
   preview:async()=>{await assertProfileContentRoot(input,join(paths.profileRoot,'artifacts'));return new ArtifactStore({storageRoot:join(paths.profileRoot,'artifacts')}).previewRegistration(registration,{sessionId:session.id,profileId:input.profileId});}};
 }
 const task=tasks.getTask(reference.ownerId),result=tasks.getResult(reference.artifactId);
 if(!task||!result||result.taskId!==task.id)throw new Error('Result unavailable.');
 const attempt=result.attemptId?tasks.getAttempt(result.attemptId):null,links=taskArtifactLinks(input.profileId,task,result,attempt??undefined);
 // Source navigation must not open a session from a different profile.
 const session=await db.getSessionForProfile(task.originSessionId,input.profileId);
 const workIds=links.workIds.filter(id=>!id.startsWith('session:')||session!==null);
 return {artifact:{reference,displayName:safeText(result.displaySummary??'Task result',160),mimeType:result.mimeType??'application/octet-stream',bytes:result.byteLength,sha256:result.contentHash.replace(/^sha256:/u,''),createdAt:result.createdAt,retention:result.status==='pruned'?'pruned':result.expiresAt&&Date.parse(result.expiresAt)<=Date.now()?'expired':'retained',sourceOrigin:null,workIds,target:task.executionTarget?{targetId:task.executionTarget.targetId,targetGeneration:task.executionTarget.targetGeneration}:null},
  preview:async()=>{await assertProfileContentRoot(input,paths.taskResultsPath);if(!session)throw new Error('Source session unavailable.');const value=await new TaskResultService({store:tasks,profileId:input.profileId,contentRoot:paths.taskResultsPath}).preview({taskId:task.id,resultId:result.id,sessionId:session.id});return{...value,text:value.text===null?null:safeText(value.text,16384)};}};
}
export async function listArtifacts(input:Input,params:{cursor?:string},signal:AbortSignal):Promise<{items:ArtifactProjection[];nextCursor:string|null}>{
 // A bounded keyset, not a scan of all transcripts. Cursors carry no authority.
 const [source='session',value='0']=params.cursor?.split(':')??[];
 if(!['session','task'].includes(source)||!/^\d{1,16}$/.test(value)||!Number.isSafeInteger(Number(value)))throw new Error('Invalid artifact cursor.');
 let db:SQLiteSessionDB;try{db=await artifactDatabase(input);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return{items:[],nextCursor:null};throw error;}
 try{
  const rows=source==='session'?db.db.query<{row:number;owner:string;id:string}>(`select e.rowid as row,e.session_id as owner,json_extract(e.event_json,'$.artifact.id') as id from session_events e join sessions s on s.id=e.session_id where s.profile_id=? and e.rowid>? and json_valid(e.event_json) and json_extract(e.event_json,'$.kind')='session-artifact-registered' order by e.rowid limit 33`).all(input.profileId,Number(value)):
   db.db.query<{row:number;owner:string;id:string}>('select rowid as row,task_id as owner,id from task_results where profile_id=? and rowid>? order by rowid limit 33').all(input.profileId,Number(value));
  const items:ArtifactProjection[]=[];
  for(const row of rows.slice(0,32)){signal.throwIfAborted();if(typeof row.id!=='string'||row.id.length>256)continue;try{items.push((await resolveArtifact(input,db,{source:source as 'session'|'task',ownerId:row.owner,artifactId:row.id})).artifact);}catch{/* Invalid persisted registration never becomes a display object. */}}
  return{items,nextCursor:rows.length>32?`${source}:${rows[31]!.row}`:source==='session'?'task:0':null};
 }finally{db.close();}
}
export async function inspectArtifact(input:Input,reference:ArtifactReference,open:boolean,signal:AbortSignal):Promise<ArtifactPreview>{
 const db=await artifactDatabase(input);
 try{signal.throwIfAborted();const {artifact,preview}=await resolveArtifact(input,db,reference);
  if(!open)return{artifact,integrity:'unavailable',text:null,truncated:false,reason:'Content has not been checked.'};
  try{const result=await preview();signal.throwIfAborted();return{artifact,integrity:'verified',text:result.text,truncated:result.truncated,reason:null};}
  catch{signal.throwIfAborted();return{artifact,integrity:'unavailable',text:null,truncated:false,reason:'Content is missing, expired, pruned, unsupported, or failed its integrity check.'};}
 }finally{db.close();}
}

async function assertProfileContentRoot(input:Input,path:string):Promise<void>{
 const state=resolveGlobalStateHome(input).stateRoot;
 if(await realpath(path)!==join(await realpath(state),relative(state,path)))throw new Error('Profile content root changed.');
}

/** Output links remain separate from execution verification. */
export async function workArtifactReferences(input:Input,work:import('../contracts/desktop-control/index.js').WorkProjection,signal:AbortSignal):Promise<{references:ArtifactReference[];truncated:boolean}>{
 if(work.profileId!==input.profileId)throw new Error('Artifact profile unavailable.');
 const db=await artifactDatabase(input);
 try{
  const tasks=new SQLiteTaskStore({db:db.db,profileId:input.profileId});
  let references:ArtifactReference[]=[];
  if(work.kind==='session'){
   if(!await db.getSessionForProfile(work.canonicalId,input.profileId))throw new Error('Source unavailable.');
   const rows=db.db.query<{id:string}>("select json_extract(event_json,'$.artifact.id') as id from session_events where session_id=? and json_valid(event_json) and json_extract(event_json,'$.kind')='session-artifact-registered' order by rowid desc limit 17").all(work.canonicalId);
   references=rows.map(row=>({source:'session',ownerId:work.canonicalId,artifactId:row.id}));
  }else{
   const attempt=work.kind==='task_attempt'?tasks.getAttempt(work.canonicalId):null;
   const task=tasks.getTask(attempt?.taskId??work.canonicalId);if(!task)throw new Error('Source unavailable.');
   const rows=db.db.query<{id:string}>('select id from task_results where profile_id=? and task_id=?'+(attempt?' and attempt_id=?':'')+' order by created_at desc,id limit 17').all(input.profileId,task.id,...(attempt?[attempt.id]:[]));
   references=rows.map(row=>({source:'task',ownerId:task.id,artifactId:row.id}));
  }
  const selected:ArtifactReference[]=[];
  for(const reference of references.slice(0,16)){signal.throwIfAborted();try{await resolveArtifact(input,db,reference);selected.push(reference);}catch{/* Invalid ownership never becomes a link. */}}
  return{references:selected,truncated:references.length>16};
 }finally{db.close();}
}
