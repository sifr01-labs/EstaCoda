import {mkdtemp,rm,access,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {expect,it} from 'vitest';
import {resolveGlobalStateHome,resolveProfileStateHome} from '../config/profile-home.js';
import {SQLiteSessionDB} from '../session/sqlite-session-db.js';
import {ensureRuntimeSession} from '../session/session-workspace-ownership.js';
import {ControlReceipts,createControlOperationId} from '../gateway/control-receipts.js';
import {sessionControl} from './session-controls.js';
it('reads completed receipts with the host stopped and preserves exact profile, target and uncertain-state fences',async()=>{
 const homeDir=await mkdtemp('/tmp/ec-cold-receipts-');
 await mkdir(resolveGlobalStateHome({homeDir}).stateRoot,{recursive:true});
 const db=new SQLiteSessionDB({path:resolveGlobalStateHome({homeDir}).sessionsSqlitePath});
 try {
  await ensureRuntimeSession({sessionDb:db,sessionId:'chat',profileId:'p',workspaceRoot:homeDir,homeDir,durable:true});
  const target=(await db.getSession('chat'))!.executionTarget!;
  const control={method:'send' as const,sessionId:'chat',targetId:target.targetId,targetGeneration:target.targetGeneration,operationId:createControlOperationId(),text:'Hello'};
  const receipts=new ControlReceipts(db.db,'p','previous-host');receipts.accept(control);receipts.transition(control,'dispatched');receipts.transition(control,'completed');
  const request={jsonrpc:'2.0' as const,id:'r',method:'operations.inspect' as const,params:{sessionId:'chat',target:{targetId:target.targetId,targetGeneration:target.targetGeneration},operationId:control.operationId,method:'sessions.send' as const}};
  const input={homeDir,profileId:'p',version:'test'},signal=new AbortController().signal;
  expect(await sessionControl(input,request,signal)).toMatchObject({state:'completed',operationId:control.operationId});
  await expect(access(join(resolveProfileStateHome(input).gatewayStatePath,'control.json'))).rejects.toThrow();
  for(const change of [{sessionId:'other'},{target:{...request.params.target,targetGeneration:99}}])await expect(sessionControl(input,{...request,params:{...request.params,...change}},signal)).rejects.toThrow();
  await expect(sessionControl({...input,profileId:'other'},request,signal)).rejects.toThrow();
  expect(await sessionControl(input,{...request,params:{...request.params,taskId:'forged'}},signal)).toMatchObject({state:'unknown'});
  const pending={...control,operationId:createControlOperationId()};receipts.accept(pending);receipts.transition(pending,'dispatched');
  expect(await sessionControl(input,{...request,params:{...request.params,operationId:pending.operationId}},signal)).toMatchObject({state:'dispatched'});
  receipts.transition(pending,'uncertain');expect(await sessionControl(input,{...request,params:{...request.params,operationId:pending.operationId}},signal)).toMatchObject({state:'uncertain'});
 }finally{db.close();await rm(homeDir,{recursive:true,force:true});}
});
