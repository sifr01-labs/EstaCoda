import type {ActivityProjection} from '@estacoda/control-protocol';
export type ToolRecord = Extract<ActivityProjection,{kind:'tool'}>;
export type ActivityRun = {id:string;user?:Extract<ActivityProjection,{kind:'message'}>;items:ActivityProjection[]};
export type ToolAction = {id:string;records:ToolRecord[]};
/** Preserve source order. A user message or new work after an outcome starts a fresh run. */
export function activityRuns(items:readonly ActivityProjection[]):ActivityRun[]{
 const runs:ActivityRun[]=[];let current:ActivityRun|undefined,settled=false;
 for(const item of items){
  const user=item.kind==='message'&&item.role==='user';
  if(!current||user||(settled&&['tool','plan','assistant_delta','model','routing'].includes(item.kind))){current={id:item.id,items:[],...(user?{user:item}: {})};runs.push(current);settled=false;}
  if(!user)current.items.push(item);
  if(item.kind==='result')settled=true;
 }
 return runs;
}
/** Identity is the only authority for pairing. Legacy records remain separate events. */
export function toolActions(items:readonly ActivityProjection[]):ToolAction[]{
 const actions:ToolAction[]=[];const calls=new Map<string,ToolAction>();
 for(const item of items){if(item.kind!=='tool')continue;
  const key=item.callId?JSON.stringify([item.profileId,item.workId,item.name,item.callId]):undefined;
  const existing=key?calls.get(key):undefined;
  if(existing)existing.records.push(item);
  else{const action={id:item.id,records:[item]};actions.push(action);if(key)calls.set(key,action);}
 }
 return actions;
}
export function runContent(run:ActivityRun){
 const operational=run.items.some(item=>['tool','plan','artifact'].includes(item.kind)||item.kind==='message'&&item.phase==='progress');
 const messages=run.items.filter((item):item is Extract<ActivityProjection,{kind:'message'}>=>item.kind==='message');
 // Old peers have no phase marker. Keep their latest prose visible and all earlier prose inspectable.
 const responses=operational?messages.filter(item=>item.phase==='response'||item.phase===undefined&&item===messages.at(-1)):messages;
 const latestProgress=messages.filter(item=>item.phase==='progress').at(-1);
 const plans=run.items.filter((item):item is Extract<ActivityProjection,{kind:'plan'}>=>item.kind==='plan');
 const outcome=run.items.filter((item):item is Extract<ActivityProjection,{kind:'result'}>=>item.kind==='result').at(-1);
 const artifacts=run.items.filter((item):item is Extract<ActivityProjection,{kind:'artifact'}>=>item.kind==='artifact');
 const seen=new Set<string>();const outputs=artifacts.filter(item=>{const key=JSON.stringify(item.reference);if(seen.has(key))return false;seen.add(key);return true;});
 return {operational,responses,latestProgress,plans,outcome,outputs,actions:toolActions(run.items)};
}

/** One notice per fallback route per user request; replay is deterministic. */
export function fallbackNotices(items:readonly ActivityProjection[]){
 const notices=new Map<string,Extract<ActivityProjection,{kind:'model'}>>();
 for(const item of items){
  if(item.kind!=='model'||!item.executionModel.fallback)continue;
  const key=JSON.stringify([item.executionModel.providerId,item.executionModel.modelId]);
  const previous=notices.get(key);
  if(previous?.executionModel.state==='responded'&&item.executionModel.state==='attempting')continue;
  notices.set(key,{...item,id:previous?.id??item.id});
 }
 return [...notices.values()];
}
