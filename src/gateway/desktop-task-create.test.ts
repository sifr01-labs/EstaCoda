import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {it,expect} from 'vitest';
import {SQLiteSessionDB} from '../session/sqlite-session-db.js';
import {SQLiteTaskStore} from '../tasks/sqlite-task-store.js';
import {ensureRuntimeSession} from '../session/session-workspace-ownership.js';
import {desktopCreateTask} from './desktop-task-create.js';
import {ControlReceipts,createControlOperationId} from './control-receipts.js';
it('creates an idempotent background Task with narrowed limits, inherited target and core operator authority',async()=>{
 const homeDir=await mkdtemp('/tmp/ec-desktop-task-'),db=new SQLiteSessionDB({path:join(homeDir,'sessions.sqlite')});
 try{await ensureRuntimeSession({sessionDb:db,sessionId:'s',profileId:'p',workspaceRoot:homeDir,homeDir,durable:true});const session=(await db.getSession('s'))!,target=session.executionTarget!,store=new SQLiteTaskStore({db:db.db,profileId:'p'});
 const request={method:'task.create' as const,sessionId:'s',taskId:'task_desktop',operationId:createControlOperationId(),targetId:target.targetId,targetGeneration:target.targetGeneration,selection:null,objective:'Inspect safely',limits:{maxProviderCalls:4,maxTotalTokens:8000,maxWallClockMs:60000}};
 const receipts=new ControlReceipts(db.db,'p','owner');receipts.accept(request);expect(()=>receipts.accept({...request,limits:{...request.limits,maxProviderCalls:5}})).toThrow('different input');
 const input={store,request,session,context:{} as any,spendingLimit:{maxEstimatedCostUsd:2,warningThresholdPercent:80}};
 expect(await desktopCreateTask(input)).toEqual({taskId:'task_desktop'});expect(await desktopCreateTask(input)).toEqual({taskId:'task_desktop'});
 const task=store.getTask('task_desktop')!;expect(task.executionPreference).toBe('background');expect(task.executionTarget).toEqual(target);expect(task.executionLimits.maxProviderCalls).toBe(4);expect(task.spendingLimit?.maxEstimatedCostUsd).toBe(2);expect(task.authorityPolicy.blockedTools).toContain('terminal.run');expect(store.listTasks({limit:100})).toHaveLength(1);
 await expect(desktopCreateTask({...input,request:{...request,operationId:createControlOperationId(),taskId:'second',limits:{...request.limits,maxProviderCalls:46}}})).rejects.toThrow('narrow');expect(store.getTask('second')).toBeNull();
 await expect(desktopCreateTask({...input,request:{...request,targetGeneration:9}})).rejects.toThrow('binding');
 }finally{db.close();await rm(homeDir,{recursive:true,force:true});}
});
