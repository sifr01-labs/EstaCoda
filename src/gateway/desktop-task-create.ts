import {randomUUID} from 'node:crypto';
import type {PrivateControlRequest} from '../contracts/control-protocol.js';
import type {SessionRecord} from '../contracts/session.js';
import type {TaskStore} from '../tasks/task-store.js';
import type {SpendingLimit} from '../contracts/budget.js';
import {TaskOperatorService} from '../tasks/task-operator-service.js';
import {resolveModelSwitchRequest,type ModelSwitchContext} from '../providers/model-switch-resolver.js';
/** Called only inside the authenticated supervisor after target/trust validation. */
export async function desktopCreateTask(input:{store:TaskStore;request:PrivateControlRequest;session:SessionRecord;context:ModelSwitchContext;spendingLimit?:SpendingLimit}){
 const{store,request,session}=input;
 if(request.method!=='task.create'||!request.taskId||!request.objective||!request.limits||session.profileId!==store.profileId||session.id!==request.sessionId||session.executionTarget?.targetId!==request.targetId||session.executionTarget.targetGeneration!==request.targetGeneration)throw new Error('Task creation binding changed.');
 const selected=request.selection?await resolveModelSwitchRequest({modelInput:request.selection.providerId+'/'+request.selection.modelId,source:'desktop'},input.context):undefined;
 if(selected&&(!selected.ok||!input.context.config.providers?.[selected.route.provider]?.enableNetwork))throw new Error('Task model is not runnable.');
 return store.atomicWrite((store)=>{
 const existing=store.getTaskByCreationKey(request.operationId);
 const task=new TaskOperatorService({store,defaultTaskSpendingLimit:input.spendingLimit}).begin({taskId:request.taskId,creationKey:request.operationId,objective:request.objective!,workspace:session.executionTarget!.workspace,creatorSessionId:session.id,executionPreference:'background',executionLimits:request.limits});
 if(!existing&&selected?.ok)store.appendEvent({id:randomUUID(),profileId:store.profileId,taskId:task.taskId,kind:'model-override-changed',timestamp:new Date().toISOString(),data:{selection:{providerId:selected.route.provider,modelId:selected.route.id}}});
 return{taskId:task.taskId};
 });
}
