import {resolveGlobalStateHome} from '../config/profile-home.js';
import {SQLiteSessionDB} from '../session/sqlite-session-db.js';
import {SQLiteTaskStore} from '../tasks/sqlite-task-store.js';
import {taskModelOverride} from '../tasks/task-model-override.js';
import {ControlProtocolError,type MethodContracts} from '../contracts/desktop-control/index.js';
export async function workModel(input:{homeDir:string;profileId:string},params:MethodContracts['models.workOverride']['params']):Promise<MethodContracts['models.workOverride']['result']>{
 const db=new SQLiteSessionDB({path:resolveGlobalStateHome(input).sessionsSqlitePath});
 try{
  const session=await db.getSessionForProfile(params.sessionId,input.profileId);
  if(session?.executionTarget?.targetId!==params.target.targetId || session.executionTarget.targetGeneration!==params.target.targetGeneration)throw new ControlProtocolError('-32003');
  if(params.taskId){
   const store=new SQLiteTaskStore({db:db.db,profileId:input.profileId}),task=store.getTask(params.taskId);
   if(task?.originSessionId!==session.id || task.executionTarget?.targetId!==params.target.targetId || task.executionTarget.targetGeneration!==params.target.targetGeneration)throw new ControlProtocolError('-32003');
   const selection=taskModelOverride(store,task.id);return {selection:selection?{providerId:selection.provider,modelId:selection.model}:null,effective:'next_attempt'};
  }
  const override=await db.getSessionModelOverride(session.id);return {selection:override?{providerId:override.route.provider,modelId:override.route.id}:null,effective:'next_turn'};
 }finally{db.close();}
}
