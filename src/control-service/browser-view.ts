import type {BrowserViewState,WorkProjection} from '../contracts/desktop-control/index.js';
import {artifactDatabase,workArtifactReferences} from './artifacts.js';
import {SQLiteTaskStore} from '../tasks/sqlite-task-store.js';
import {ExecutionTargetStore} from '../workspaces/execution-target.js';
import {WorkspaceTrustStore} from '../security/workspace-trust-store.js';
import {loadRuntimeConfig} from '../config/runtime-config.js';
import {isSafeUrl,scanUrlForSecrets,redactUrlForMetadata} from '../browser/url-safety.js';
import {checkWebsiteAccess,loadWebsiteBlocklist} from '../browser/website-policy.js';
import {safeText} from './work-projections.js';
type Input={homeDir:string;profileId:string};
async function safeUrl(url:string,allowPrivateUrls:boolean,signal:AbortSignal):Promise<boolean>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 const abort=()=>cancel?.(false);let cancel:((value:boolean)=>void)|undefined;
 try{return await Promise.race([isSafeUrl(url,{allowPrivateUrls}),new Promise<boolean>(resolve=>{cancel=resolve;timer=setTimeout(()=>resolve(false),1500);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)resolve(false);})]);}
 finally{clearTimeout(timer);signal.removeEventListener('abort',abort);}
}
function credentialFree(url:string):boolean{try{const value=new URL(url);return ['http:','https:'].includes(value.protocol)&&!value.username&&!value.password;}catch{return false;}}
const token=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/u.test(value)&&safeText(value,160)===value;
export async function browserOwner(input:Input,work:WorkProjection,signal:AbortSignal){
 if(work.profileId!==input.profileId)throw new Error('Browser profile unavailable.');
 const db=await artifactDatabase(input);
 try{
  const tasks=new SQLiteTaskStore({db:db.db,profileId:input.profileId});
  const owner=work.kind==='session'?work.canonicalId:work.kind==='task_attempt'?tasks.getAttempt(work.canonicalId)?.workerSessionId:undefined;
  const session=owner?await db.getSessionForProfile(owner,input.profileId):null;
  if(!session?.executionTarget)throw new Error('Browser owner unavailable.');
  const store=new ExecutionTargetStore(input);
  try{await store.validate(session.executionTarget,session.executionTarget.workspace.canonicalPath,signal);
   if(!await new WorkspaceTrustStore(input).isTrusted(session.executionTarget.workspace.canonicalPath))throw new Error('Workspace trust required.');
  }finally{store.close();}
  return session;
 }finally{db.close();}
}
/** No backend construction, navigation, session allocation or CDP access. */
export async function listBrowserViews(input:Input,work:WorkProjection,signal:AbortSignal):Promise<{items:BrowserViewState[];truncated:boolean}>{
 const session=await browserOwner(input,work,signal),db=await artifactDatabase(input);
 try{
  const config=await loadRuntimeConfig({...input,workspaceRoot:input.homeDir,configurationInspection:true});
  const policy=loadWebsiteBlocklist(config.security.websiteBlocklist??{});
  const rows=db.db.query<{id:number;created_at:string;data:string|null}>(`select rowid as id,created_at,case when length(event_json)<=65536 then event_json else null end as data from session_events where session_id=? and json_valid(event_json) and json_extract(event_json,'$.kind')='tool-result' and json_extract(event_json,'$.tool') like 'browser.%' order by rowid desc limit 65`).all(session.id);
  const pending:Promise<BrowserViewState>[]=[],seen=new Set<string>();
  for(const row of rows.slice(0,64)){
   signal.throwIfAborted();if(!row.data)continue;
   const event=JSON.parse(row.data),snapshot=event.result?.metadata?.snapshot;
   if(!snapshot||!token(snapshot.sessionId)||seen.has(snapshot.sessionId))continue;
   seen.add(snapshot.sessionId);if(pending.length===8)break;
   pending.push((async():Promise<BrowserViewState>=>{
   const rawUrl=typeof snapshot.url==='string'&&snapshot.url.length<=4096?snapshot.url:null;
   const allowed=event.result?.ok===true&&snapshot.sensitiveInputActive!==true&&rawUrl!==null&&
    credentialFree(rawUrl)&&scanUrlForSecrets(rawUrl)===undefined&&await safeUrl(rawUrl,config.security.allowPrivateUrls===true,signal)&&checkWebsiteAccess(rawUrl,policy)?.allowed!==false;
   signal.throwIfAborted();
   return {reference:{sessionId:session.id,browserId:snapshot.sessionId,eventId:row.id,target:{targetId:session.executionTarget!.targetId,targetGeneration:session.executionTarget!.targetGeneration}},
    url:allowed?redactUrlForMetadata(rawUrl!).slice(0,2048):null,title:allowed&&typeof snapshot.title==='string'?safeText(snapshot.title,160):null,
    observedAt:row.created_at,readiness:allowed&&['loading','interactive','complete'].includes(snapshot.readiness)?snapshot.readiness:'unknown',state:allowed?'recorded':'blocked',lastAction:safeText(event.tool,160),artifacts:[]};
   })());
  }
  // Bound DNS policy checks concurrently so eight unavailable hosts cannot exhaust the IPC deadline.
  const items=await Promise.all(pending);
  const outputs=await workArtifactReferences(input,work,signal);for(const item of items)if(item.state==='recorded')item.artifacts=outputs.references;
  const current=await browserOwner(input,work,signal);
  if(JSON.stringify(current.executionTarget)!==JSON.stringify(session.executionTarget))throw new Error('Browser target changed.');
  return{items,truncated:rows.length>64||rows.some(row=>!row.data)||seen.size>8};
 }finally{db.close();}
}
