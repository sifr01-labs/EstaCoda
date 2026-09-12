import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {it,expect,vi} from 'vitest';
import {SQLiteSessionDB} from '../session/sqlite-session-db.js';
import {SQLiteTaskStore} from '../tasks/sqlite-task-store.js';
import {TaskOperatorService} from '../tasks/task-operator-service.js';
import {ensureRuntimeSession} from '../session/session-workspace-ownership.js';
import {SessionExecutionOwnership} from '../session/execution-ownership.js';
import {loadRuntimeConfig} from '../config/runtime-config.js';
import {desktopModelControl} from './desktop-model-controls.js';
import {taskModelOverride} from '../tasks/task-model-override.js';
import {ControlReceipts,createControlOperationId} from './control-receipts.js';
it('sets and clears only the bound Session or Task and refuses foreign execution ownership',async()=>{
 const root=await mkdtemp('/tmp/ec-model-controls-');const db=new SQLiteSessionDB({path:join(root,'sessions.sqlite')});
 try{
  const profile=join(root,'.estacoda/profiles/p');await mkdir(profile,{recursive:true});
  const config={model:{provider:'local',id:'a'},providers:{local:{baseUrl:'http://localhost:11434/v1',authMethod:'none',apiMode:'openai_chat_completions',enableNetwork:true,models:['a','b']}}};
  await writeFile(join(profile,'config.json'),JSON.stringify(config));
  await ensureRuntimeSession({sessionDb:db,sessionId:'s',profileId:'p',workspaceRoot:root,homeDir:root,durable:true});
  const target=(await db.getSession('s'))!.executionTarget!;
  const loaded=await loadRuntimeConfig({homeDir:root,profileId:'p',workspaceRoot:root,configurationInspection:true});
  const tasks=new SQLiteTaskStore({db:db.db,profileId:'p'});
  const request={method:'model' as const,sessionId:'s',targetId:target.targetId,targetGeneration:target.targetGeneration,operationId:createControlOperationId(),selection:{providerId:'local',modelId:'b'}};
  const input={request,profileId:'p',sessionDb:db,tasks,context:{config:loaded.config,providerRegistry:loaded.providerRegistry,homeDir:root,profileId:'p'},invalidate:vi.fn(async()=>{})};
  const owners=new SessionExecutionOwnership(db.db),claim=owners.claim({sessionId:'s',profileId:'p',targetId:target.targetId});
  await expect(desktopModelControl(input)).rejects.toThrow('busy');expect(await db.getSessionModelOverride('s')).toBeUndefined();owners.release(claim);
  await expect(desktopModelControl(input)).resolves.toEqual({effective:'next_turn'});expect((await db.getSessionModelOverride('s'))?.route.id).toBe('b');
  await expect(desktopModelControl({...input,request:{...request,targetGeneration:99}})).rejects.toThrow('Stale');
  await expect(desktopModelControl({...input,profileId:'other'})).rejects.toThrow('Stale');
  const receipts=new ControlReceipts(db.db,'p','owner');receipts.accept(request);expect(()=>receipts.accept({...request,selection:null})).toThrow('different input');
  await desktopModelControl({...input,request:{...request,selection:null}});expect(await db.getSessionModelOverride('s')).toBeUndefined();
  const taskId=new TaskOperatorService({store:tasks}).begin({objective:'Work',workspace:target.workspace,creatorSessionId:'s'}).taskId;
  await db.endSession('s','done');
  await expect(desktopModelControl({...input,request:{...request,method:'task.model',taskId}})).resolves.toEqual({effective:'next_attempt'});
  expect(taskModelOverride(tasks,taskId)).toEqual({provider:'local',model:'b'});
  await desktopModelControl({...input,request:{...request,method:'task.model',taskId,selection:null}});expect(taskModelOverride(tasks,taskId)).toBeUndefined();
  expect(loaded.config.model).toEqual(config.model);
 }finally{db.close();await rm(root,{recursive:true,force:true});}
});
