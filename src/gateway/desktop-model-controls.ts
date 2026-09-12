import {randomUUID} from 'node:crypto';
import type {PrivateControlRequest} from '../contracts/control-protocol.js';
import {isTerminalTaskStatus} from '../contracts/task.js';
import type {SQLiteSessionDB} from '../session/sqlite-session-db.js';
import {SessionExecutionOwnership} from '../session/execution-ownership.js';
import type {TaskStore} from '../tasks/task-store.js';
import {resolveModelSwitchRequest,type ModelSwitchContext} from '../providers/model-switch-resolver.js';

/** Called at a shared Session queue boundary. Never edits an active runtime or profile defaults. */
export async function desktopModelControl(input:{request:PrivateControlRequest;profileId:string;sessionDb:SQLiteSessionDB;tasks:TaskStore;context:ModelSwitchContext;invalidate(sessionId:string):Promise<void>}) {
  const {request,sessionDb,tasks,profileId}=input;
  if(!['model','task.model'].includes(request.method))throw new Error('Unsupported model control.');
  const session=await sessionDb.getSessionForProfile(request.sessionId,profileId);
  if(!session || session.executionTarget?.targetId!==request.targetId || session.executionTarget.targetGeneration!==request.targetGeneration)throw new Error('Stale Session binding.');
  const resolution=request.selection?await resolveModelSwitchRequest({modelInput:`${request.selection.providerId}/${request.selection.modelId}`,source:'desktop'},input.context):undefined;
  if(resolution && (!resolution.ok || !input.context.config.providers?.[resolution.route.provider]?.enableNetwork))throw new Error('Model route is not runnable.');
  const override=resolution?.ok?resolution.override:undefined;
  if(request.method==='task.model'){
    tasks.atomicWrite(store=>{
      const task=request.taskId?store.getTask(request.taskId):null;
      if(!task || task.originSessionId!==session.id || task.executionTarget?.targetId!==request.targetId || task.executionTarget.targetGeneration!==request.targetGeneration || isTerminalTaskStatus(task.status))throw new Error('Task model control binding is unavailable.');
      const previous=store.listEvents(task.id,{kinds:['model-override-changed'],order:'desc',limit:1})[0];
      const timestamp=new Date(Math.max(Date.now(),previous?Date.parse(previous.timestamp)+1:0)).toISOString();
      store.appendEvent({id:randomUUID(),profileId,taskId:task.id,kind:'model-override-changed',timestamp,data:{selection:override?{providerId:override.route.provider,modelId:override.route.id}:null}});
    });
    return {effective:'next_attempt'};
  }
  if(session.endedAt)throw new Error('Session has ended.');
  // Retire idle cached ownership first. Borrowed/foreign ownership remains held and claim fails closed.
  await input.invalidate(session.id);
  const ownership=new SessionExecutionOwnership(sessionDb.db);
  const claim=ownership.claim({sessionId:session.id,profileId,targetId:request.targetId});
  try {
    const current=await sessionDb.getSessionForProfile(session.id,profileId);
    if(current?.executionTarget?.targetGeneration!==request.targetGeneration)throw new Error('Stale Session generation.');
    if(override)await sessionDb.setSessionModelOverride(session.id,override);
    else await sessionDb.clearSessionModelOverride(session.id);
    ownership.advance(claim,'control');
  } finally {ownership.release(claim);}
  return {effective:'next_turn'};
}
