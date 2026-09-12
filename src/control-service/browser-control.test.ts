import {it,expect} from 'vitest';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {SQLiteSessionDB} from '../session/sqlite-session-db.js';
import {ExecutionTargetStore,targetBinding} from '../workspaces/execution-target.js';
import {WorkspaceTrustStore} from '../security/workspace-trust-store.js';
import {resolveGlobalStateHome,resolveProfileStateHome} from '../config/profile-home.js';
import {startPrivateControl} from '../gateway/private-control.js';
import {SharedSessionHost} from '../gateway/shared-session-host.js';
import {ControlReceipts} from '../gateway/control-receipts.js';
import {BrowserControlOwner} from '../browser/control-lease.js';
import {sessionWork} from './work-projections.js';
import {browserControl} from './browser-control.js';
it('forwards through the authenticated existing owner without persisting input or starting a runtime',async()=>{
 const homeDir=await mkdtemp('/tmp/ec-take-'),input={homeDir,profileId:'p',version:'test'},root=join(homeDir,'repo');await mkdir(root);
 const path=resolveGlobalStateHome(input).sessionsSqlitePath;await mkdir(dirname(path),{recursive:true});const db=new SQLiteSessionDB({path}),targets=new ExecutionTargetStore(input);let server:Awaited<ReturnType<typeof startPrivateControl>>|undefined;
 try{
  const target=await targets.acquireLocal(root);await new WorkspaceTrustStore(input).grant(root);const session=await db.createSession({id:'s',profileId:'p',executionTarget:targetBinding(target)}),work=sessionWork(session,[],false),owner=new BrowserControlOwner();
  const host=new SharedSessionHost({profileId:'p',sessionDb:db,receipts:new ControlReceipts(db.db,'p','instance'),validateTarget:async()=>{},acquire:async()=>{throw new Error('Must not create a runtime');},channelApproval:async()=>{},browserControl:async request=>{
   const command=request.browserControl!;if(command.action==='acquire')return{lease:owner.acquire(command.holder),state:'human',frame:null};if(command.action==='workspace')return owner.human(command.holder,command.lease,command.sequence,async()=>({lease:command.lease,state:'human',frame:null,workspace:{supported:true,reason:null,truncated:false,sessions:[]}}));if(command.action==='release'){owner.release(command.holder,command.lease);return{lease:null,state:'agent',frame:null};}throw new Error('Unexpected request');
  }});
  const directory=resolveProfileStateHome(input).gatewayStatePath;await mkdir(directory,{recursive:true,mode:0o700});server=await startPrivateControl({directory,profileId:'p',instanceId:'instance',version:'test',targetGeneration:true,handle:request=>host.handle(request)});
  const base={holder:'window',browserId:'b'},result=await browserControl(input,work,{...base,action:'acquire'},new AbortController().signal);expect(result.state).toBe('human');await expect(owner.agent(async()=>1)).rejects.toThrow('paused');
  await expect(browserControl(input,work,{...base,holder:'competitor',action:'acquire'},new AbortController().signal)).rejects.toThrow();
  const workspaceCommand={...base,lease:result.lease!,sequence:1,action:'workspace' as const,operation:{kind:'list' as const}};
  expect((await browserControl(input,work,workspaceCommand,new AbortController().signal)).workspace?.sessions).toEqual([]);
  await expect(browserControl(input,work,workspaceCommand,new AbortController().signal)).rejects.toThrow();
  const changed=sessionWork({...session,executionTarget:{...session.executionTarget!,targetGeneration:session.executionTarget!.targetGeneration+1}},[],false);
  await expect(browserControl(input,changed,{...workspaceCommand,sequence:2},new AbortController().signal)).rejects.toThrow();
  expect((await browserControl(input,work,{...base,action:'release',lease:result.lease!},new AbortController().signal)).state).toBe('agent');
  expect(db.db.query<{count:number}>('select count(*) as count from session_control_receipts').get()!.count).toBe(0);
  await expect(browserControl({...input,profileId:'other'},work,{...base,action:'acquire'},new AbortController().signal)).rejects.toThrow();
 }finally{await server?.close();targets.close();db.close();await rm(homeDir,{recursive:true,force:true});}
});
