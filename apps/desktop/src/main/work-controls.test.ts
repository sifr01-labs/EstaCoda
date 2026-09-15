import {EventEmitter} from 'node:events';
import {mkdtempSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {it,expect,vi} from 'vitest';
import {WorkAttachments} from './work-attachments.js';
import {DesktopWorkControls} from './work-controls.js';
const target={targetId:'target',targetGeneration:1};
it('reads actual bounded UTF-8 contents and refuses symlinks, binary, stale scopes, and invalidated handles',async()=>{
 const directory=mkdtempSync('/tmp/ec-attachments-'),store=new WorkAttachments(),scope={profileId:'p',generation:1,target,draftId:'draft'};
 try{const path=join(directory,'notes.md');writeFileSync(path,'مرحبا billing');const [file]=await store.stage([path],scope,()=>{});expect(store.compose(scope,[file!.id],'Review')).toContain('مرحبا billing');expect(()=>store.compose({...scope,profileId:'q'},[file!.id],'Review')).toThrow('another target');symlinkSync(path,join(directory,'link.md'));await expect(store.stage([join(directory,'link.md')],scope,()=>{})).rejects.toThrow();writeFileSync(path,Buffer.from([0xff,0]));await expect(store.stage([path],scope,()=>{})).rejects.toThrow('UTF-8');writeFileSync(path,'a'.repeat(8193));await expect(store.stage([path],scope,()=>{})).rejects.toThrow('8 KB');store.clear();expect(()=>store.compose(scope,[file!.id],'Review')).toThrow('expired');}finally{rmSync(directory,{recursive:true,force:true});}
});
it('submits actual attachment contents once and retains a recovery pointer across Main restart',async()=>{
 const directory=mkdtempSync('/tmp/ec-work-main-');const path=join(directory,'notes.txt');writeFileSync(path,'actual attached evidence');
 const connection=Object.assign(new EventEmitter(),{state:{profileId:'p',generation:1,status:'ready'},getWork:vi.fn(async(id:string)=>({id,profileId:'p',canonicalId:id.slice(8),kind:'session',target,actions:[{id:'sessions.send',enabled:true}]})),workRequest:vi.fn(async(method:string,params:any)=>method==='work.targets'?{items:[target],truncated:false}:{...params,profileId:'p',method:method==='operations.inspect'?params.method:method,state:'completed',cancellation:'not_requested'})});
 try{const main=new DesktopWorkControls(connection as any,directory,async()=>[path]);const [file]=await main.attach({draftId:'draft',target});expect(connection.workRequest).toHaveBeenCalledWith('work.targets',{target});const input={draftId:'draft',target,text:'Review',attachmentIds:[file!.id]};const result=await main.submit(input);const sent=connection.workRequest.mock.calls.find(call=>call[0]==='sessions.send')!;expect(sent[1].text).toContain('actual attached evidence');const restarted=new DesktopWorkControls(connection as any,directory,async()=>[]);expect(await restarted.submit(input)).toMatchObject({workId:result.workId});expect(connection.workRequest.mock.calls.filter(call=>call[0]==='sessions.send')).toHaveLength(1);expect(await restarted.inspect(result.workId)).toMatchObject({state:'completed',method:'sessions.send'});}finally{rmSync(directory,{recursive:true,force:true});}
});

it('revalidates canonical action capabilities and fences a profile switch before dispatch',async()=>{
 const directory=mkdtempSync('/tmp/ec-action-main-');let enabled=false,swap=false;
 const connection=Object.assign(new EventEmitter(),{state:{profileId:'p',generation:1,status:'ready'},getWork:async()=>{if(swap)connection.state.profileId='q';return{id:'task:t',profileId:'p',canonicalId:'t',kind:'task',target,modelBinding:{sessionId:'origin',taskId:'t'},actions:[{id:'tasks.pause',enabled}]};},workRequest:vi.fn(async(method:string,params:any)=>({...params,method,profileId:'p',state:'accepted',cancellation:'not_requested'}))});
 try{const main=new DesktopWorkControls(connection as any,directory,async()=>[]);await expect(main.act({workId:'task:t',action:'tasks.pause'})).rejects.toThrow('unavailable');expect(connection.workRequest).not.toHaveBeenCalled();enabled=true;expect(await main.act({workId:'task:t',action:'tasks.pause'})).toMatchObject({taskId:'t',sessionId:'origin'});swap=true;await expect(main.act({workId:'task:t',action:'tasks.pause'})).rejects.toThrow('context');expect(connection.workRequest).toHaveBeenCalledTimes(1);}finally{rmSync(directory,{recursive:true,force:true});}
});

it('resolves only canonical approve-once requests and inspects rather than repeats a decision',async()=>{
 const directory=mkdtempSync('/tmp/ec-approval-main-');let stale=false;
 const connection=Object.assign(new EventEmitter(),{state:{profileId:'p',generation:1,status:'ready'},getWork:async()=>({profileId:'p',target:stale?{...target,targetGeneration:2}:target}),workRequest:vi.fn(async(method:string,params:any)=>method==='inbox.get'?{id:'attention',profileId:'p',workId:'session:s',kind:'approval',actions:[{id:'approve_once',enabled:true},{id:'reject',enabled:true}],approval:{id:'canonical-approval',sessionId:'s',target,scope:'once',decisions:['approved','denied']}}:{...params,method:method==='operations.inspect'?params.method:method,profileId:'p',state:'completed',cancellation:'not_requested'})});
 try{const main=new DesktopWorkControls(connection as any,directory,async()=>[]);stale=true;await expect(main.decide('attention','approved')).rejects.toThrow('target');expect(connection.workRequest.mock.calls.some(call=>call[0]==='approvals.resolve')).toBe(false);stale=false;await main.decide('attention','approved');await main.decide('attention','denied');const decisions=connection.workRequest.mock.calls.filter(call=>call[0]==='approvals.resolve');expect(decisions).toHaveLength(1);expect(decisions[0]![1]).toMatchObject({approvalId:'canonical-approval',sessionId:'s',target,decision:'approved'});expect(await new DesktopWorkControls(connection as any,directory,async()=>[]).inspectDecision('attention')).toMatchObject({state:'completed'});}finally{rmSync(directory,{recursive:true,force:true});}
});


it('bounds concurrent attachment staging and expires content without accepting stale handles',async()=>{
 const directory=mkdtempSync('/tmp/ec-attachment-bound-'),store=new WorkAttachments(),scope={profileId:'p',generation:1,target,draftId:'draft'};
 try{const file=join(directory,'a.txt');writeFileSync(file,'bounded evidence');const staged=await Promise.allSettled(Array.from({length:17},()=>store.stage([file,file,file,file],scope,()=>{})));
 const accepted=staged.flatMap(result=>result.status==='fulfilled'?result.value:[]);expect(accepted).toHaveLength(64);expect(staged.filter(result=>result.status==='rejected')).toHaveLength(1);
 const now=Date.now();vi.spyOn(Date,'now').mockReturnValue(now+16*60_000);expect(()=>store.compose(scope,[accepted[0]!.id],'Review')).toThrow('expired');
 }finally{vi.restoreAllMocks();rmSync(directory,{recursive:true,force:true});}
});

it('continues delayed Task preparation after Main restart without recreating the Session or Task',async()=>{
 const directory=mkdtempSync('/tmp/ec-preparation-');let settled=false;
 const connection=Object.assign(new EventEmitter(),{state:{profileId:'p',generation:1,status:'ready'},workRequest:vi.fn(async(method:string,params:any)=>{
  if(method==='work.targets')return{items:[target,{...target,targetGeneration:2}],truncated:false};
  if(method==='sessions.start')throw new Error('Reply lost');
  return{...params,profileId:'p',method:method==='operations.inspect'?params.method:method,state:settled?'completed':'accepted',cancellation:'not_requested'};
 })});
 const input={draftId:'draft',kind:'task' as const,target,text:'Inspect safely',attachmentIds:[],limits:{maxProviderCalls:3,maxTotalTokens:8000,maxWallClockMs:60000}};
 try{
  await expect(new DesktopWorkControls(connection as any,directory,async()=>[]).submit(input)).rejects.toThrow('Reply lost');
  const restarted=new DesktopWorkControls(connection as any,directory,async()=>[]);
  await expect(restarted.submit(input)).rejects.toThrow('Preparation');
  await expect(restarted.submit({...input,target:{...target,targetGeneration:2}})).rejects.toThrow('target changed');
  settled=true;await expect(restarted.submit({...input,inspectOnly:true})).rejects.toThrow('wasn’t sent');expect(connection.workRequest.mock.calls.filter(call=>call[0]==='tasks.create')).toHaveLength(0);const result=await restarted.submit(input);expect(result.workId).toMatch(/^task:/);expect(result.receipt.method).toBe('tasks.create');
  expect(await restarted.submit(input)).toMatchObject({workId:result.workId});
  expect(connection.workRequest.mock.calls.filter(call=>call[0]==='sessions.start')).toHaveLength(1);
  expect(connection.workRequest.mock.calls.filter(call=>call[0]==='tasks.create')).toHaveLength(1);
 }finally{rmSync(directory,{recursive:true,force:true});}
});

it('reconciles a lost send acknowledgment by submission identity without repeating execution',async()=>{
 const directory=mkdtempSync('/tmp/ec-send-recovery-');
 const connection=Object.assign(new EventEmitter(),{state:{profileId:'p',generation:1,status:'ready'},getWork:async(id:string)=>({id,profileId:'p',canonicalId:'s',kind:'session',target,actions:[{id:'sessions.send',enabled:true}]}),workRequest:vi.fn(async(method:string,params:any)=>{
  if(method==='work.targets')return{items:[target],truncated:false};if(method==='sessions.send')throw new Error('Connection lost');
  return{...params,profileId:'p',method:params.method,state:'dispatched',cancellation:'not_requested'};
 })});
 const input={draftId:'d',workId:'session:s',target,text:'Continue',attachmentIds:[],securityMode:'open' as const};
 try{const controls=new DesktopWorkControls(connection as any,directory,async()=>[]);expect(await controls.submit(input)).toMatchObject({receipt:{state:'dispatched'}});expect(await controls.submit({...input,inspectOnly:true})).toMatchObject({receipt:{state:'dispatched'}});expect(await controls.submit(input)).toMatchObject({receipt:{state:'dispatched'}});expect(connection.workRequest.mock.calls.filter(call=>call[0]==='sessions.send')).toHaveLength(1);
 await expect(controls.submit({...input,draftId:'missing',inspectOnly:true})).rejects.toThrow('wasn’t sent');expect(connection.workRequest.mock.calls.filter(call=>call[0]==='sessions.send')).toHaveLength(1);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
it('permits explicit interruption of an acknowledged send but refuses uncertain prior execution',async()=>{
 const directory=mkdtempSync('/tmp/ec-send-interrupt-');let state='dispatched';
 const connection=Object.assign(new EventEmitter(),{state:{profileId:'p',generation:1,status:'ready'},getWork:async(id:string)=>({id,profileId:'p',canonicalId:'s',kind:'session',target,actions:[{id:'sessions.send',enabled:true}]}),workRequest:vi.fn(async(method:string,params:any)=>method==='work.targets'?{items:[target],truncated:false}:{...params,profileId:'p',method:method==='operations.inspect'?params.method:method,state,cancellation:'not_requested'})});
 const input={draftId:'first',workId:'session:s',target,text:'First',attachmentIds:[]};
 try{const controls=new DesktopWorkControls(connection as any,directory,async()=>[]);await controls.submit(input);await expect(controls.submit({...input,draftId:'next'})).rejects.toThrow('Reconcile');await controls.submit({...input,draftId:'steer',interrupt:true});expect(connection.workRequest.mock.calls.filter(c=>c[0]==='sessions.send')).toHaveLength(2);state='uncertain';await expect(controls.submit({...input,draftId:'unsafe',interrupt:true})).rejects.toThrow('Reconcile');}finally{rmSync(directory,{recursive:true,force:true});}
});
