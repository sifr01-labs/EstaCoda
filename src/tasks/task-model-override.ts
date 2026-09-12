import type {TaskStore} from './task-store.js';
/** An explicit operator choice applies only to future child construction for this Task. */
export function taskModelOverride(store:TaskStore,taskId:string):{provider:string;model:string}|undefined {
  const event=store.listEvents(taskId,{kinds:['model-override-changed'],order:'desc',limit:1})[0];
  const selection=event?.data.selection;
  if(selection===undefined || selection===null)return undefined;
  if(typeof selection!=='object' || !('providerId' in selection) || !('modelId' in selection) || typeof selection.providerId!=='string' || typeof selection.modelId!=='string')throw new Error('Invalid Task model override.');
  return {provider:selection.providerId,model:selection.modelId};
}
