import {lstat} from 'node:fs/promises';
import {resolveGlobalStateHome} from '../config/profile-home.js';
import {SQLiteSessionDB} from '../session/sqlite-session-db.js';
import {SQLiteTaskStore} from '../tasks/sqlite-task-store.js';
import {selectProviderUsageEntries} from '../tasks/sqlite-provider-usage.js';
import {loadSessionCostUsage} from '../session/session-cost-usage.js';
import {reconstructSessionContextWindowUsage} from '../session/session-context-window-usage.js';
import {usageCostSummaryFromEntries} from '../providers/provider-usage-projection.js';
import type {TaskStore} from '../tasks/task-store.js';
import type {ProviderUsageQuery} from '../contracts/provider-usage.js';
import type {MethodContracts,WorkProjection} from '../contracts/desktop-control/index.js';
/** Bounded read over the canonical ledger; no pricing calculation or second accounting store. */
export async function workUsage(input:{homeDir:string;profileId:string},work:WorkProjection,signal:AbortSignal):Promise<MethodContracts['work.usage']['result']>{
 if(work.profileId!==input.profileId||!['session','task','task_attempt'].includes(work.kind))throw new Error('Usage unavailable.');
 const path=resolveGlobalStateHome(input).sessionsSqlitePath,info=await lstat(path);if(!info.isFile()||info.isSymbolicLink())throw new Error('Usage unavailable.');
 const db=new SQLiteSessionDB({path,readonly:true});
 try{
  db.db.exec('begin');let remaining=4096,truncated=false,activeTasks=false;
  const store=new SQLiteTaskStore({db:db.db,profileId:input.profileId});
  const read=(query:ProviderUsageQuery)=>{signal.throwIfAborted();const entries=selectProviderUsageEntries(db.db,input.profileId,query,remaining+1);if(entries.length>remaining)truncated=true;const selected=entries.slice(0,remaining);remaining-=selected.length;return selected;};
  const boundedSession={getSession:db.getSession.bind(db),listProviderUsageEntries:async(profile:string,query?:ProviderUsageQuery)=>{if(profile!==input.profileId)throw new Error('Usage profile changed.');return read(query??{});}};
  const boundedTasks={listProviderUsageEntries:read,listTasks:(query:Parameters<TaskStore['listTasks']>[0])=>{const rows=store.listTasks({...query,limit:129});if(rows.length>128)truncated=true;if(rows.some(task=>!['completed','partial','failed','cancelled'].includes(task.status)))activeTasks=true;return rows.slice(0,128);}};
  let usage;let context:null|{usedTokens:number;totalTokens:number;provider:string;model:string}=null;
  if(work.kind==='session'){
   usage=await loadSessionCostUsage({sessionDb:boundedSession,taskStore:boundedTasks,profileId:input.profileId,sessionId:work.canonicalId});
   const row=db.db.query<{value:string|null}>("select case when length(event_json)<=4096 then event_json else null end as value from session_events where session_id=? and json_valid(event_json) and json_extract(event_json,'$.kind') in ('context-window-usage','context-window-usage-invalidated','session-history-compressed') order by rowid desc limit 1").get(work.canonicalId);
   if(row?.value){const value=reconstructSessionContextWindowUsage([JSON.parse(row.value)]);if(value)context={usedTokens:value.usedTokens,totalTokens:value.totalTokens,provider:value.provider.slice(0,240),model:value.model.slice(0,240)};}
  }else if(work.kind==='task'){
   const task=store.getTask(work.canonicalId);if(!task)throw new Error('Task unavailable.');usage=usageCostSummaryFromEntries(read(task.rootTaskId===task.id?{rootTaskId:task.id}:{taskId:task.id}));
  }else usage=usageCostSummaryFromEntries(read({attemptId:work.canonicalId}));
  signal.throwIfAborted();if(!usage)throw new Error('Usage unavailable.');
  const result={scope:work.kind==='task_attempt'?'attempt' as const:work.kind as 'session'|'task',reportedTokens:usage.providerCalls?usage.totalTokens:null,providerCalls:usage.providerCalls,
   cost:usage.estimatedCostUsd!==undefined&&usage.providerCalls?{amount:usage.estimatedCostUsd,currency:'USD' as const}:null,
   usageComplete:usage.usageComplete&&!truncated,pricingComplete:usage.costComplete&&!truncated,context,truncated,
   provisional:activeTasks||!['completed','partial','failed','cancelled'].includes(work.status)};
  db.db.exec('commit');return result;
 }finally{db.close();}
}
